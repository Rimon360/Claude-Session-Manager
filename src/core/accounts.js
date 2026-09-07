'use strict';
/**
 * Who each account uuid actually is.
 *
 * Claude Desktop names its session folders by account uuid and nothing else,
 * so on disk an account is a 36-character hex string. Three sources can put a
 * human name to one, in descending order of authority:
 *
 *   1. the signed-in account       `~/.claude.json` -> `oauthAccount`
 *   2. a name we learned earlier   cached the last time that account was
 *                                  signed in on this machine
 *   3. a name the user typed       an explicit override, which always wins
 *                                  over 1 and 2 for display
 *
 * Only identity fields are ever read -- email, display name, organization
 * name. Tokens and credentials are not touched, which is also why an account
 * that has never been signed in while this app was installed stays anonymous
 * until it is: its email exists only inside Claude Desktop's oauth token
 * cache, and that is not ours to open.
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const settings = require('./settings');

/** Claude Desktop's own record of which account it is using. */
const COWORK_OPS_FILE = 'cowork-enabled-cli-ops.json';
const DESKTOP_CONFIG_FILE = 'config.json';
const DESKTOP_ACCOUNT_KEY = 'lastKnownAccountUuid';
const DESKTOP_ACCOUNT_RE = /"lastKnownAccountUuid"\s*:\s*"([0-9a-fA-F-]{36})"/;
/** Where Claude Desktop keeps a Claude Code config per agent-mode session. */
const AGENT_MODE_DIR = 'local-agent-mode-sessions';
/** A config bigger than this is not one worth parsing for six identity fields. */
const MAX_CONFIG_BYTES = 32 * 1024 * 1024;

/**
 * Identity of the account signed in to the Claude Code CLI.
 *
 * This is NOT necessarily the account Claude Desktop is using. The two sign
 * in separately, and switching account in Desktop leaves this file untouched.
 * `readDesktopAccount` answers "who is signed in" for the Desktop history
 * this app actually works on.
 *
 * `<root>/.claude.json` is machine-level state (machineID, userID, migration
 * flags) while `~/.claude.json` carries `oauthAccount`. Both exist, so the
 * first file holding *any* id is not good enough -- only a file with a real
 * `oauthAccount` answers this question.
 */
function readSignedInAccount(homeDir) {
  const home = homeDir || paths.home();
  const file = path.join(home, '.claude.json');
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const a = j && j.oauthAccount;
  if (!a || !a.accountUuid) return null;
  return {
    accountUuid: a.accountUuid,
    organizationUuid: a.organizationUuid ?? null,
    email: a.emailAddress ?? null,
    displayName: a.displayName ?? a.fullName ?? null,
    organizationName: a.organizationName ?? null,
    organizationType: a.organizationType ?? null,
    organizationRole: a.organizationRole ?? null,
    source: file,
  };
}

/**
 * The account Claude Desktop itself is using.
 *
 * Asking the CLI config alone was the bug: sign out of one account in Claude
 * Desktop and into another and `~/.claude.json` still names the first one, so
 * the app went on labelling the account the user had just left as the signed-in
 * one.
 *
 * Claude Desktop records the answer in its own root, in two places:
 *
 *   1. `cowork-enabled-cli-ops.json`  one field, `ownerAccountId`, and nothing
 *                                     else in the file -- preferred because
 *                                     there is nothing else in it to read past.
 *   2. `config.json`                  the same id, as `lastKnownAccountUuid`.
 *
 * The second file also holds Claude Desktop's oauth token cache. It is read a
 * line at a time and only the line naming the account is parsed; no token value
 * is ever decoded, stored or logged. Credentials are not this app's business,
 * and an account id is not a credential.
 */
function readDesktopAccount(roots) {
  for (const entry of roots || []) {
    const root = typeof entry === 'string' ? entry : entry && entry.root;
    if (!root) continue;

    // Single-purpose file first.
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, COWORK_OPS_FILE), 'utf8'));
      if (j && isUuid(j.ownerAccountId)) {
        return { accountUuid: j.ownerAccountId, root, source: COWORK_OPS_FILE };
      }
    } catch { /* absent on installs that have never used agent mode */ }

    const hit = readLastKnownAccount(path.join(root, DESKTOP_CONFIG_FILE));
    if (hit) return { accountUuid: hit, root, source: DESKTOP_CONFIG_FILE };
  }
  return null;
}

/**
 * Pull one field out of Claude Desktop's config without reading the rest.
 *
 * Deliberately line-oriented rather than `JSON.parse`: the file holds a token
 * cache, and there is no reason for this app to have ever parsed it.
 */
function readLastKnownAccount(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (line.indexOf(DESKTOP_ACCOUNT_KEY) < 0) continue;
    const m = line.match(DESKTOP_ACCOUNT_RE);
    if (m) return m[1];
  }
  return null;
}

/**
 * Names for accounts never signed in to the CLI on this machine.
 *
 * Claude Desktop writes a full Claude Code config inside each agent-mode
 * sandbox, at `local-agent-mode-sessions/<account>/<org>/<session>/.claude/`,
 * and that config carries the same `oauthAccount` block `~/.claude.json` does.
 * It is an ordinary config file, not credential storage.
 *
 * The folder it sits in already states which account it belongs to, so a
 * config that disagrees with its own path is a reason to ignore the file
 * rather than to trust it.
 *
 * Best effort by design: an install that has never used agent mode yields
 * nothing, and the account stays anonymous until it is signed in.
 */
function harvestDesktopIdentities(roots, options = {}) {
  const { limit = 200 } = options;
  const found = new Map();
  let looked = 0;

  for (const entry of roots || []) {
    const root = typeof entry === 'string' ? entry : entry && entry.root;
    if (!root) continue;
    const base = path.join(root, AGENT_MODE_DIR);

    for (const accountUuid of readdirSafe(base)) {
      if (!isUuid(accountUuid) || found.has(accountUuid)) continue;
      const accountDir = path.join(base, accountUuid);

      outer:
      for (const orgUuid of readdirSafe(accountDir)) {
        if (!isUuid(orgUuid)) continue;
        for (const session of readdirSafe(path.join(accountDir, orgUuid))) {
          if (looked++ >= limit) break outer;
          const file = path.join(accountDir, orgUuid, session, '.claude', '.claude.json');
          const id = readIdentityFile(file);
          if (!id || id.accountUuid !== accountUuid) continue;
          found.set(accountUuid, id);
          break outer;
        }
      }
    }
  }
  return found;
}

/** Identity fields only, from a Claude Code config wherever it lives. */
function readIdentityFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  // These carry a `projects` map that grows without bound; a config far larger
  // than any real one is not worth parsing to read six fields.
  if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const a = j && j.oauthAccount;
  if (!a || !isUuid(a.accountUuid)) return null;
  return {
    accountUuid: a.accountUuid,
    organizationUuid: a.organizationUuid ?? null,
    email: a.emailAddress ?? null,
    displayName: a.displayName ?? a.fullName ?? null,
    organizationName: a.organizationName ?? null,
    organizationType: a.organizationType ?? null,
    source: file,
  };
}

/**
 * Persist harvested names, so they survive the sandbox folder they came from
 * being cleaned up.
 *
 * Never downgrades: a stored record that already has a name is not replaced by
 * one that does not.
 */
function learnIdentities(identities) {
  if (!identities || !identities.size) return 0;
  const current = settings.load();
  const known = { ...(current.accounts?.known ?? {}) };
  let written = 0;

  for (const [uuid, id] of identities) {
    const had = known[uuid];
    if (had && (had.email || had.displayName) && !(id.email || id.displayName)) continue;
    known[uuid] = {
      email: id.email,
      displayName: id.displayName,
      organizationUuid: id.organizationUuid,
      organizationName: id.organizationName,
      organizationType: id.organizationType,
      learnedAt: new Date().toISOString(),
    };
    written++;
  }
  if (written) settings.save({ accounts: { known } });
  return written;
}

function isUuid(v) { return typeof v === 'string' && /^[0-9a-fA-F-]{36}$/.test(v); }

function readdirSafe(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
/**
 * Remember the signed-in account so it can still be named after the user
 * switches away from it.
 *
 * This is the only way a second account ever gets a name without opening
 * credential storage: sign into it once and it is known from then on.
 */
function learnSignedInAccount(homeDir) {
  const acct = readSignedInAccount(homeDir);
  if (!acct) return null;
  const current = settings.load();
  const known = { ...(current.accounts?.known ?? {}) };
  known[acct.accountUuid] = {
    email: acct.email,
    displayName: acct.displayName,
    organizationUuid: acct.organizationUuid,
    organizationName: acct.organizationName,
    organizationType: acct.organizationType,
    learnedAt: new Date().toISOString(),
  };
  settings.save({ accounts: { known } });
  return acct;
}

/** A user-chosen name for an account, or null to clear it. */
function setAccountLabel(accountUuid, label) {
  if (!accountUuid) throw new Error('an account uuid is required');
  const current = settings.load();
  const custom = { ...(current.accounts?.custom ?? {}) };
  const trimmed = typeof label === 'string' ? label.trim() : '';
  if (trimmed) custom[accountUuid] = trimmed.slice(0, 80);
  else delete custom[accountUuid];
  settings.save({ accounts: { custom } });
  return custom[accountUuid] ?? null;
}

/**
 * Everything known about one account uuid, with a display name resolved from
 * the best available source and a note saying which source that was.
 */
function describeAccount(accountUuid, options = {}) {
  const {
    signedIn = readSignedInAccount(),
    saved = settings.load(),
    // Who Claude Desktop is using. Null means nothing said it, in which case
    // the CLI's answer is the only one there is.
    currentAccountUuid = null,
  } = options;
  const custom = saved.accounts?.custom?.[accountUuid] ?? null;
  const known = saved.accounts?.known?.[accountUuid] ?? null;
  const isCliCurrent = !!signedIn && signedIn.accountUuid === accountUuid;
  const isCurrent = currentAccountUuid ? currentAccountUuid === accountUuid : isCliCurrent;
  // The live CLI config is fresher than anything cached, but only about the
  // account it actually names.
  const identity = isCliCurrent ? signedIn : known;

  let label, labelSource;
  if (custom) { label = custom; labelSource = 'custom'; }
  else if (identity && (identity.email || identity.displayName)) {
    label = identity.email || identity.displayName;
    labelSource = isCliCurrent ? 'signed-in' : 'learned';
  } else { label = shortUuid(accountUuid); labelSource = 'uuid'; }

  return {
    accountUuid,
    label,
    labelSource,
    isCurrent,
    // Signed in to the Claude Code CLI, which can be a different account.
    isCliCurrent,
    email: identity?.email ?? null,
    displayName: identity?.displayName ?? null,
    organizationName: identity?.organizationName ?? null,
    organizationType: identity?.organizationType ?? null,
    // Only the signed-in config states this authoritatively; a learned record
    // is a snapshot of what was true when we saw it.
    organizationUuid: identity?.organizationUuid ?? null,
    named: labelSource !== 'uuid',
  };
}

function shortUuid(uuid) { return String(uuid || '').slice(0, 8); }

/**
 * Account -> organization pairs taken from transcripts already scanned.
 *
 * Free: discovery's shallow pass reads the head and tail of every session and
 * keeps the owner ids it finds there, so this is pure bookkeeping over data
 * already in memory.
 */
function collectOwnerPairs(sessions) {
  const pairs = new Map();
  for (const s of sessions || []) {
    if (!s || !s.ownerAccountUuid || !s.ownerOrganizationUuid) continue;
    if (!pairs.has(s.ownerAccountUuid)) pairs.set(s.ownerAccountUuid, s.ownerOrganizationUuid);
  }
  return pairs;
}

/**
 * Look harder for the organization of accounts the shallow pass missed.
 *
 * Owner rows sit wherever the session was bridged, which is often neither the
 * head nor the tail. This streams whole files, but only for accounts still
 * unresolved, and stops the moment every one of them has an answer -- so on a
 * machine where the cheap pass already worked it reads nothing at all.
 */
async function deepFindOwnerPairs(files, wanted, options = {}) {
  const { onProgress, signal } = options;
  const want = new Set(wanted || []);
  const found = new Map();
  if (!want.size) return found;

  let done = 0;
  for (const file of files || []) {
    if (!want.size) break;
    if (signal && signal.aborted) break;
    const hit = await scanFileForOwnerPair(file);
    done++;
    if (onProgress) onProgress({ done, total: files.length, remaining: want.size });
    if (!hit || !hit.accountUuid || !hit.organizationUuid) continue;
    if (!want.has(hit.accountUuid)) continue;
    found.set(hit.accountUuid, hit.organizationUuid);
    want.delete(hit.accountUuid);
  }
  return found;
}

/** Stream one transcript looking only for an owner row. */
function scanFileForOwnerPair(filePath) {
  return new Promise((resolve) => {
    let stream;
    try { stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 }); }
    catch { resolve(null); return; }

    let buffer = '';
    let result = null;
    const finish = () => { try { stream.destroy(); } catch { /* already closed */ } resolve(result); };

    stream.on('data', (chunk) => {
      buffer += chunk;
      // Cheap text test before any JSON work.
      if (buffer.indexOf('ownerAccountUuid') >= 0) {
        for (const line of buffer.split('\n')) {
          if (line.indexOf('ownerAccountUuid') < 0) continue;
          let o;
          try { o = JSON.parse(line); } catch { continue; } // a split line completes next chunk
          if (o && o.ownerAccountUuid) {
            result = { accountUuid: o.ownerAccountUuid, organizationUuid: o.ownerOrganizationUuid ?? null };
            finish();
            return;
          }
        }
      }
      // Keep only the tail, so memory stays bounded on huge files.
      const nl = buffer.lastIndexOf('\n');
      if (nl >= 0) buffer = buffer.slice(nl + 1);
      if (buffer.length > 4 * 1024 * 1024) buffer = '';
    });
    stream.on('error', () => resolve(result));
    stream.on('end', () => resolve(result));
  });
}

module.exports = {
  readSignedInAccount,
  readDesktopAccount,
  harvestDesktopIdentities,
  readIdentityFile,
  learnIdentities,
  learnSignedInAccount,
  setAccountLabel,
  describeAccount,
  collectOwnerPairs,
  deepFindOwnerPairs,
  scanFileForOwnerPair,
  shortUuid,
};
