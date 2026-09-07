# AI Session Manager

An Electron desktop app that discovers, backs up, exports, imports, merges and
syncs local Claude Code session files, by reading the raw transcript files on
disk.

It never treats a tool's own session index as the source of truth. On the
machine this was built against, Claude Desktop's index named sessions whose
transcripts were gone and missed transcripts that were present. Indexes are read
only for account attribution and display titles.

```bash
npm install
npm start          # launch the app
npm test           # run the test suite
```

---

## Design rules

These are enforced in code, not just documented.

| Rule | Where |
|---|---|
| Sessions are found by walking the filesystem, never by reading a tool index | `core/discovery.js` |
| No line is ever silently skipped — every parse failure is reported with line number and byte offset | `core/jsonl.js` |
| Nothing is overwritten without an explicit per-session choice | `core/safety.js` |
| Every overwrite backs up the previous bytes first | `core/safety.js` |
| Writes are atomic (temp file → fsync → rename) | `core/safety.js` |
| Every write is preceded by a dry run that cannot be skipped | plan tokens, `core/safety.js` |
| A damaged source is never used as input to a write | `assertUsableSource`, `core/safety.js` |
| Nothing is loaded whole into memory | streaming throughout |

**The dry run cannot be disabled.** Planning returns a single-use token;
executing requires handing it back. There is no "don't ask again" setting,
because the gate is structural rather than a confirmation dialog. A consumed
token is rejected on replay — state on disk may have changed since the preview.

---

## Format findings

Everything below was verified against a real installation (121 Claude Code
sessions, 1.16 GB total). Each one would cause silent data loss if handled the
obvious way.

### Claude Code — split turns are pervasive

Claude Code 2.1+ spreads one assistant turn across several JSONL rows that all
share a `message.id`, each carrying different content blocks.

In one 1.9 MB session: **152 rows shared an id with an earlier row**. Deduping
by `message.id` alone would have kept 91 of 243 content blocks and silently
dropped 152 — 62% of that file's assistant content.

The deduper keys on `(message id + content-block fingerprint)`, so genuine
repeats collapse and distinct blocks all survive. The window is bounded to the
64 most recent message ids; on a multi-gigabyte transcript an unbounded set is
itself a memory leak, and falling out of the window only means a duplicate is
kept rather than collapsed — the safe direction.

The observed row-type vocabulary is much wider than usually documented:
`user`, `assistant`, `attachment`, `queue-operation`, `last-prompt`,
`custom-title`, `ai-title`, `mode`, `bridge-session`, `atis-latch`, `system`,
`file-history-snapshot`, `permission-mode`, `cost-state`. Anything unmodelled is
preserved verbatim in `meta.rawRows`.

Sub-agents live at
`projects/<project>/<session-uuid>/subagents/workflows/<wf-id>/agent-*.jsonl`
— not as flat `agent-*.jsonl` files beside the transcript. There were 5,367 of
them on the reference machine; they are attached to their parent rather than
listed as sessions.

### Session ids are not unique

A session id identifies a conversation, not a file. Resuming or forking a
session can leave the same id in two files on disk. This broke two separate
things, both found by testing against real data rather than by reading the
format:

1. Comparison. Treating id → session as one-to-one made a re-import of an
   untouched session look like a divergence against its sibling. Candidate
   lookup is now one-to-many.
2. **Restoring the wrong bytes.** `executeImport` indexed the bundle manifest by
   session id, so two records sharing an id collapsed into one and a session was
   written with its sibling's content — silent corruption of a file the user
   asked us to restore. Records are now resolved by manifest position, and the
   write is refused outright if the record at that position does not carry the
   session id the plan was built for. Covered by a regression test that fails
   against the old lookup.

Session identity in the UI is therefore keyed by a hash of the **file path**,
not the session id.

### Records broken across physical lines

Real transcripts contain records split in two by an unescaped newline inside a
string value, so one logical record spans two physical lines and neither half is
valid JSON. Both halves are **reported, not reassembled** — guessing a record
boundary is how a "repair" silently invents content. Every undamaged row in the
same file is still recovered.

---

## Universal Session Schema

Every parser produces it; every exporter consumes it, so adding a tool stays
linear rather than quadratic. See `src/core/uss.js`.

The **content hash** is what makes dedupe work. It covers the ordered sequence
of role, type, text, tool name, tool input and tool output — and deliberately
excludes message ids, parent ids, timestamps, absolute paths, account ids and
all `meta`. Those legitimately differ between two copies of the same
conversation on different machines; if they fed the hash, "I already have this"
could never fire. Line endings and trailing whitespace are normalized so a
transcript written on Windows matches the same conversation written on macOS.

---

## Bundle format

A bundle is a ZIP containing:

```
manifest.json                        schema version, timestamp, one entry per session
raw/<tool>/<original relative path>  untouched copies of the original files
normalized/<tool>__<id>.json         the Universal Session Schema version
```

Both copies are needed and do different jobs:

- **`raw/`** is what goes back into the tool it came from — byte for byte. A
  same-tool round trip is lossless *by construction*, not by the correctness of
  an exporter. Extracted bytes are checked against the manifest's SHA-256 and
  re-parsed for integrity before they are allowed to replace anything.
- **`normalized/`** is what cross-tool conversion reads, where some loss is
  unavoidable and is reported explicitly.

ZIP handling is a custom streaming ZIP64 implementation (`core/zipstream.js`)
rather than `adm-zip`, which builds archives in memory and would exhaust the
heap on exactly the large sessions a backup tool most needs to protect.
Archiving a 122 MB file peaks at 45 MB RSS.

---

## Syncing accounts

Sync combines the session history of several accounts of the same tool. It
matches by content hash, copies only what is missing, and **never deletes**.

You choose which accounts take part, so "combine A and B but leave C alone" is
a supported operation — C is not read from, written to, or listed as a
destination. Any account you leave out is named explicitly in the preview, and
an account you ask for but that cannot be found stops the plan rather than
being quietly skipped.

Anything that diverges between accounts is surfaced as a conflict for you to
resolve, never merged automatically.

Two things worth knowing about how tools store accounts:

### Claude Desktop's per-account index

The authoritative list of accounts is **not** in `~/.claude` at all. Claude
Desktop keeps one:

```
<Claude data>/claude-code-sessions/<accountUuid>/<organizationUuid>/
  local_<id>.json     session metadata; `cliSessionId` joins to the transcript
  deleted_<id>        tombstone holding an epoch-ms deletion time
```

Two traps found by reading a real Store install:

- **The Store build is MSIX-packaged**, which redirects Roaming AppData to
  `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude`. Looking only
  at `%APPDATA%\Claude` finds nothing. Worse, both paths resolve to the *same
  physical directory*, so reading both double-counts everything — roots are
  de-duplicated by real path.
- **A session can be listed under more than one account.** On the reference
  machine 94 of 97 indexed sessions appear under *both* accounts, byte-
  identical. Taking the first match would hand almost every session to
  whichever directory was read first. A session is therefore claimed by a
  *set* of accounts, and a single owner is recorded only when exactly one
  account claims it.

The index is read for attribution and titles, never as the authority on what
exists. On the same machine it names 129 distinct sessions: 97 are on disk and
**32 are not**. Those 32 are surfaced as `missingTranscripts` — history the
desktop app remembers and the filesystem does not.

Counting them needs the same care as attribution: every account that knows a
session gets its own index row, so counting rows rather than sessions reported
64 where there are 32.

- **One `~/.claude` folder can hold several accounts' sessions.** Switching
  login does not move or partition history — everything lands in the same tree.
  The config file's `oauthAccount` names only who is signed in *now*, so
  counting config folders reports one account when there may be several.
- **Ownership is recorded inside the transcripts**, on `bridge-session` rows
  (`ownerAccountUuid` / `ownerOrganizationUuid`), for sessions that were bridged
  to Claude Desktop or claude.ai. That is the only reliable way to tell which
  account a session belongs to, so the app reads it from the files. On the
  reference machine this surfaced **two accounts and two organizations** in a
  single folder where config-only detection saw one.
- **Attribution is partial by nature.** A session without one of those rows is
  not "unowned" — it simply never recorded an owner. On the reference machine
  12 of 121 sessions carried ownership. The listing pass reads each file's head
  and tail and finds most; a deep pass streams every file (2.2s over 1.2GB) and
  finds the rest.
- Sessions that carry no owner can be moved between accounts freely: there is
  nothing in them that has to be rewritten.

For accounts that live on different machines, use Export → move the bundle →
Import. Import skips anything already present, so running it repeatedly is safe
and every machine converges on the union.

---

## Import decisions

For each session in a bundle:

1. **Byte-identical** to what is on disk (SHA-256 match) → skip, no write.
2. **Same content hash** as any existing session → skip, no write. Matching is
   by content, so a conversation filed under a different id is still recognized.
3. **Not present** → write.
4. **Present and different** → conflict. Never resolved automatically.

Conflicts are classified precisely, which is what lets the app offer a safe
default instead of asking you to eyeball two transcripts:

| Relationship | Meaning | Default |
|---|---|---|
| `identical` | same content hash | skip |
| `prefix` | one strictly continues the other | take the longer — provably loses nothing |
| `diverged` | shared prefix, then both sides have unique content | **keep both** — the only choice that loses nothing |
| `unrelated` | same id, no shared history | keep both — almost certainly an id collision |

Choosing "replace" always backs up the previous bytes first and records the
backup path in the audit log at
`%APPDATA%/ai-session-manager/audit.log.jsonl`.

---

## Testing

```bash
npm test                                    # 147 tests
node --expose-gc test/run.js large          # memory assertions need --expose-gc
AISM_TEST_HUGE_MB=1600 node --expose-gc test/run.js large   # 1.6 GB run
```

The suite covers what the brief calls out as non-negotiable:

- **Corruption**: empty, whitespace-only, mid-line truncation, interior
  malformed lines, records split by unescaped newlines, 900-line shredded
  files, CRLF, BOM, missing files. Every test asserts both that damage is
  *reported* and that undamaged rows are still *recovered*. One test proves
  `parsed + errors + blanks == total lines`, so nothing can vanish unaccounted.
- **Merge**: divergence at the first message, mid-conversation, and at the last
  message; prefix in both directions; empty sides; id collisions.
- **Import collisions**: identical content, near-duplicate diverging content,
  and colliding ids over unrelated conversations — each asserting the file on
  disk is byte-unchanged when no resolution is chosen.
- **Id collisions**: two sessions sharing a session id must each restore their
  own bytes — the regression test for the corruption bug above.
- **Large sessions**: verified at **1.6 GB, 10/10 passing**. Metadata listing
  stays under 2.5 s, full-file streaming keeps RSS bounded, export completes in
  ~23 s, and the restored file is byte-identical to the original.

### Verified large-session numbers (1.6 GB fixture)

| Operation | Result |
|---|---|
| Metadata scan | < 2.5 s (head/tail only, never reads the file) |
| Full integrity stream | 4.5 s, RSS bounded |
| Incremental hash | 13 s, no message array built |
| Export to bundle | 23 s |
| Restore from bundle | 21 s, byte-identical |
| Corrupt-file scan | 5.8 s, damage reported |

---

## Known limitations

Stated plainly rather than discovered later:

- **Only Claude Code is supported.** Codex CLI and Antigravity support, and the
  cross-tool conversion built on top of them, were removed from this build. The
  reader, bundle format and USS remain tool-agnostic, so another parser can be
  added without reshaping anything else.
- **Sessions above ~256 MB cannot be diffed message-by-message.** V8 caps a
  single string near 512 MB, so the normalized copy cannot be parsed. Such
  sessions still export, restore byte-for-byte, and compare by content hash —
  the app says so explicitly and recommends keep-both rather than guessing.
- **List-view integrity is a header-only check** and is labelled "ok" rather
  than "verified". Corruption at line 348 of a 3 MB file will not show there.
  *Deep-verify* streams the whole file, and only that result gates a write.
- **Session titles** come from `customTitle` / `aiTitle` rows, with a user-set
  title outranking a generated one and the most recent winning. Sessions that
  never got one show only their id.
- **Claude Code project-directory decoding is ambiguous** (the separator is also
  a legal path character), so the decoded path is display-only; the encoded
  original is used for all filesystem operations.
- **Cursor is not supported.** It is a VS Code fork that stores chats in a
  SQLite database (`state.vscdb`) rather than JSONL, so it needs a different
  reader. It was not built because no Cursor installation was available to read:
  every real bug in this project was found by inspecting actual files, and a
  parser written blind against an undocumented binary format is exactly the kind
  of guess this app refuses to make with someone's only copy of their history.

---

## Not in this build

Per the brief: no billing, licensing, subscription or account system; no
credential/auth handling of any kind (only session transcript files are ever
touched); no obfuscation; no real-time live sync. Phase 2 cloud backup is
**not** started — Phase 1 should be validated with real users first.

The app makes **no network calls at all.** Cross-device migration is export +
import with a file you move yourself.

---

## Layout

### End-to-end checks

Two harnesses beyond the unit suite, both run against the real installation:

- **Electron E2E** (37 checks) — boots the real main process, preload and
  renderer; verifies the security posture, the custom title bar and its window
  controls, scrolling, the detail panel, deep verification, the experimental
  gate, and the IPC guards.
- **Data-safety E2E** (36 checks) — copies real sessions into a sandbox, then
  exercises export → import → re-import → divergence → keep-both → replace →
  multi-account sync, asserting byte-identical restores, that dry runs
  write nothing, that unresolved conflicts leave files untouched, and that the
  real installation is never modified.

---

## Updates

The app checks GitHub Releases for a newer version. That is its only network
call, and it is one switch away from off.

Nothing installs itself:

- A release is **downloaded** only when you ask (auto-download is off by
  default and can be turned on).
- Installing **always** needs an explicit click.
- Restarting to install is **refused while an export, import, sync or
  conversion is running** — individual writes are atomic, so a hard restart
  could not corrupt a file, but it could leave a multi-session import half
  applied with no chance to read the result.
- Uninstalling does **not** delete your backups or audit log.

`autoDownload` and `autoInstallOnAppQuit` are both pinned off on the underlying
updater, and a test asserts they stay that way.

### Cutting a release

The updater only sees published, non-draft releases.

```bash
npm version patch      # bumps package.json and tags
git push --follow-tags # CI builds all three platforms and drafts the release
```

`.github/workflows/release.yml` runs the test suite first and refuses to
publish if it fails. Publish target is set in `package.json` under
`build.publish` — change `owner`/`repo` if you move it.

Windows builds are unsigned, so the first install shows a SmartScreen warning.
Auto-update itself still works (electron-updater verifies a SHA512 from the
release metadata); signing only removes the warning.

---

## Interface

The window is frameless with a title bar drawn by the renderer, so the chrome
matches the app rather than the OS; resizing, snapping and double-click-to-
maximize still behave natively. Scrollbars are themed to the same palette.

The three panes are **resizable** — drag either divider (a hairline that only
lights up on hover, with a grab zone wider than the line), double-click to reset
one. The centre column is never crushed below a usable width no matter how far
you drag.

Table columns resize **like a spreadsheet**: drag the right edge of any header,
double-click that edge to auto-fit the column to its widest visible cell. The
first drag pins every column to pixels, so afterwards a drag moves exactly the
column you grabbed instead of reflowing its neighbours; wide layouts scroll
horizontally rather than squashing. Pane and column sizes persist across
restarts, and *Reset layout* in the sidebar restores the proportional defaults.

The column header stays **pinned** while the list scrolls, in every mode —
grouped, ungrouped, and with resized columns scrolled sideways.

The session list can be **sorted** by any column (click the header, click again
to reverse) and **grouped by project folder**, with collapsible groups, a
collapse/expand-all control, and a per-folder select-all. Sorting is natural rather than lexicographic, so
`9. Qunario` comes before `10. Ruhan Farms`, and sessions missing the sorted
value sink to the bottom rather than sorting as if empty were first.

Text is kept deliberately sparse — labels are single words, paths and account
details live in tooltips, and a session with no title shows just its id rather
than a repeated placeholder.

---

## Layout

```
src/main/main.js            Electron main; all filesystem and crypto work
src/main/preload.js         contextBridge — the only renderer capability surface
src/renderer/               UI only (contextIsolation on, nodeIntegration off, CSP set)
src/main/updater.js         GitHub Releases updates; never installs unasked
src/core/
  settings.js               persisted preferences (atomic writes)
  paths.js                  where each tool keeps data, per platform
  jsonl.js                  streaming reader + corruption classification
  uss.js                    Universal Session Schema, hashing, validation
  discovery.js              tool/account/session discovery, deep verification
  parsers/                  native format → USS  (claude-code)
                            plus claude-desktop: the per-account session index
  exporters/                USS → native format  (claude-code)
  zipstream.js              streaming ZIP64 writer/reader
  bundle.js                 export, import planning, execution
  merge.js                  divergence detection and resolution
  sync.js                   multi-account sync, cross-device migration
  safety.js                 atomic writes, backups, plan tokens
  audit.js                  append-only audit log
test/                       125 tests
```
#   C l a u d e - S e s s i o n - M a n a g e r  
 