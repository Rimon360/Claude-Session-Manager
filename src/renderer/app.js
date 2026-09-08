'use strict';
/**
 * Renderer. UI only -- no filesystem, no Node. Everything goes through the
 * `window.api` bridge exposed by preload.js.
 *
 * A rule this file follows throughout: any action that could write is a two
 * step flow. Step one asks main for a plan and renders it; step two sends the
 * plan's token back. There is no code path that writes without rendering a
 * preview first, and no setting that skips it.
 */

const state = {
  scan: null,
  sessions: [],          // flattened across tools
  selected: new Set(),   // uids
  focusedUid: null,
  filterTool: null,      // tool root, or null for all
  search: '',
  onlyWarnings: false,
  sort: { key: 'updated', dir: 'desc' },
  layout: { sidebarWidth: 216, detailWidth: 320, columnWidths: null },
  groupBy: 'none',                 // 'none' | 'project'
  collapsedGroups: new Set(),
  resizingColumn: null,            // key of the column being dragged, if any

  // Claude Desktop accounts, and which one's history the table is showing.
  // `activeAccountUuid` is null for the normal on-disk session list.
  accounts: [],
  activeAccountUuid: null,
  accountRows: [],
  accountNote: null,
  comparing: false,        // the account-comparison view is showing
  compareRows: [],
  compareOnlyDiffs: false, // in Compare: hide sessions every account has
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------- utilities */

function fmtBytes(n) {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 ** 2) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 ** 3) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return (n / 1024 ** 3).toFixed(2) + ' GB';
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3600_000) + 'h ago';
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + 'd ago';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** All renderer-side text insertion goes through textContent, never innerHTML. */
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

/**
 * Split an error from the bridge into its code and human-readable text.
 *
 * contextBridge keeps only `message` and `stack` on a thrown Error, so
 * preload.js encodes the code as a `[CODE] ` prefix. Everything user-facing
 * shows `message`; anything that needs to branch uses `code`.
 */
function apiError(err) {
  const raw = String(err?.message ?? err ?? 'Unknown error');
  const m = /^\[([A-Z0-9_]+)\]\s*([\s\S]*)$/.exec(raw);
  return m ? { code: m[1], message: m[2] } : { code: null, message: raw };
}

function toast(title, message, kind = 'ok', ms = 5200) {
  const t = el('div', 'toast ' + kind);
  t.append(el('div', 't', title));
  if (message) t.append(el('div', 'm', message));
  $('toastStack').append(t);
  setTimeout(() => t.remove(), ms);
}

function shortId(id) { return String(id || '').slice(0, 8); }

/** A readable name for an account uuid found in a transcript. */
function accountLabel(uuid) {
  if (!uuid) return null;
  for (const t of state.scan?.tools ?? []) {
    if (t.accountId?.accountUuid === uuid) return t.accountId.label + ' (signed in)';
  }
  return uuid.slice(0, 8);
}

/** Only one tool is supported; kept as a function so labels stay in one place. */
function toolLabel() { return 'Claude Code'; }

/* --------------------------------------------------------------- modal */

let modalState = { onClose: null };

function openModal(title, buildBody, buildFoot) {
  $('modalTitle').textContent = title;
  const body = $('modalBody');
  const foot = $('modalFoot');
  body.replaceChildren();
  foot.replaceChildren();
  buildBody(body);
  if (buildFoot) buildFoot(foot);
  $('modalBackdrop').hidden = false;
}

function closeModal() {
  $('modalBackdrop').hidden = true;
  $('modalBody').replaceChildren();
  $('modalFoot').replaceChildren();
  if (modalState.onClose) { const f = modalState.onClose; modalState.onClose = null; f(); }
}

$('modalClose').addEventListener('click', closeModal);
$('modalBackdrop').addEventListener('click', (e) => { if (e.target === $('modalBackdrop')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modalBackdrop').hidden) closeModal(); });

/* --------------------------------------------------------------- scan */

async function refresh() {
  $('scanSummary').textContent = 'Scanning…';
  showScanProgress(0, 1);
  try {
    const scan = await window.api.scan();
    state.scan = scan;
    state.sessions = scan.tools.flatMap((t) =>
      t.sessions.map((s) => ({ ...s, toolRoot: t.root, accountLabel: t.accountId?.label ?? null }))
    );
    state.accounts = scan.accounts ?? [];

    // A sub-view owns what is on screen and its own summary line, so refresh
    // hands back to it rather than painting the session table over the top.
    if (state.comparing) {
      await showComparison();
      return;
    }
    if (state.activeAccountUuid) {
      // Its rows came from the index, which the rescan just re-read.
      await showAccountHistory(state.activeAccountUuid, { silent: true });
      return;
    }

    renderTools();
    renderTable();
    const damagedNote = scan.totals.damaged ? ` · ${scan.totals.damaged} flagged` : '';
    $('scanSummary').textContent = `${scan.totals.sessions} sessions · ${fmtBytes(scan.totals.bytes)}${damagedNote}`;
    $('scanSummary').title = "Read from the transcript files on disk, not from any tool's own index.";
  } catch (err) {
    $('scanSummary').textContent = 'Scan failed.';
    toast('Scan failed', apiError(err).message, 'err', 9000);
  } finally {
    hideScanProgress();
  }
}

/* ------------------------------------------------------------- resizing */

const PANE_DEFAULTS = { sidebarWidth: 216, detailWidth: 320 };
const PANE_LIMITS = {
  sidebarWidth: { min: 150, max: 480 },
  detailWidth: { min: 220, max: 640 },
};
/** The centre column never gets squeezed below this while dragging. */
const CONTENT_MIN = 360;

/** Total width of both dividers, read from the DOM so the CSS stays the source of truth. */
function dividersWidth() {
  return [...document.querySelectorAll('.pane-resizer')]
    .reduce((a, d) => a + d.getBoundingClientRect().width, 0);
}

/** Persist without blocking the drag; the last write wins. */
let savePending = null;
function saveLayoutSoon() {
  clearTimeout(savePending);
  savePending = setTimeout(() => {
    window.api.patchSettings({ layout: state.layout }).catch(() => {});
  }, 300);
}

function applyPaneWidths() {
  const l = document.querySelector('.layout');
  l.style.setProperty('--sidebar-w', state.layout.sidebarWidth + 'px');
  l.style.setProperty('--detail-w', state.layout.detailWidth + 'px');
}

function initPaneResizers() {
  // `bar`, not `el` -- `el` is the element-builder helper used everywhere else
  // in this file, and shadowing it here would be a trap for the next edit.
  const setup = (bar, key, sign) => {
    bar.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = state.layout[key];
      const layoutW = document.querySelector('.layout').clientWidth;
      bar.setPointerCapture(e.pointerId);
      bar.classList.add('dragging');
      document.body.classList.add('resizing');

      const move = (ev) => {
        const raw = startW + (ev.clientX - startX) * sign;
        const { min, max } = PANE_LIMITS[key];
        // Also stop the middle column being crushed by either divider.
        const other = key === 'sidebarWidth' ? state.layout.detailWidth : state.layout.sidebarWidth;
        const roomCap = layoutW - other - dividersWidth() - CONTENT_MIN;
        state.layout[key] = Math.round(Math.max(min, Math.min(max, Math.min(raw, roomCap))));
        applyPaneWidths();
        // Narrowing a pane widens the table's container, so the columns have
        // to follow it live rather than only once the drag ends.
        applyColumnWidths();
      };
      const up = (ev) => {
        bar.releasePointerCapture(ev.pointerId);
        bar.classList.remove('dragging');
        document.body.classList.remove('resizing');
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        saveLayoutSoon();
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });

    bar.addEventListener('dblclick', () => {
      state.layout[key] = PANE_DEFAULTS[key];
      applyPaneWidths();
      applyColumnWidths();
      saveLayoutSoon();
    });
  };

  // The detail divider grows the panel as you drag LEFT, hence the -1.
  setup($('resizeSidebar'), 'sidebarWidth', 1);
  setup($('resizeDetail'), 'detailWidth', -1);
}

/* ------------------------------------------------------- column resizing */

/** The narrowest a drag or an auto-fit may leave any column. */
const COLUMN_MIN = 46;

/**
 * What each column needs, and what it gives up first.
 *
 * `min` is the narrowest the column is still worth showing at: below it a
 * size reads "22…" and a state badge is clipped in half, which is worse than
 * not showing the column at all. `drop` orders what goes when the pane cannot
 * hold everything -- the columns without one are the list itself and always
 * stay. `want` is the share of a comfortable pane and mirrors the percentages
 * in the stylesheet.
 */
// The metadata minimums are measured, not guessed: the widest rendered cell
// over 126 real sessions, plus the cell padding. A model column at 74px shows
// every row as "claude-…", and a state column at 58px cuts its own badge in
// half -- present but useless, which is the outcome dropping the column is
// there to avoid. Project and Session are truncatable by nature, so theirs is
// simply the narrowest that still reads as a path and a title.
const COLUMN_FIT = {
  check:   { min: 33,  want: 4,  drop: null, grow: false },
  project: { min: 104, want: 31, drop: null, grow: true },
  title:   { min: 118, want: 23, drop: null, grow: true },
  size:    { min: 72,  want: 8,  drop: 1,    grow: true },
  model:   { min: 112, want: 12, drop: 2,    grow: true },
  state:   { min: 98,  want: 10, drop: 3,    grow: true },
  updated: { min: 70,  want: 12, drop: 4,    grow: true },
};
const FALLBACK_FIT = { min: 60, want: 10, drop: null, grow: true };
const fitOf = (key) => COLUMN_FIT[key] || FALLBACK_FIT;

/**
 * Freeze the columns at exactly the widths currently on screen.
 *
 * The table is laid out from shares until the first drag. Resizing one column
 * while the rest are shares makes the others reflow to absorb the change,
 * which is not how a spreadsheet behaves. Converting all of them to pixels
 * once means a drag moves exactly the column that was grabbed.
 *
 * `force` re-reads them even when widths are already stored, which is what a
 * drag needs: the rendered width includes any fitting applied to fill the
 * pane, so starting from the stored value would make the column jump before
 * it moved.
 */
function pinColumnWidths(force) {
  if (state.layout.columnWidths && !force) return;
  const widths = { ...(state.layout.columnWidths || {}) };
  for (const th of document.querySelectorAll('table.sessions thead th')) {
    const key = th.dataset.sort || 'check';
    const w = Math.round(th.getBoundingClientRect().width);
    // A column currently dropped for want of room measures zero. Pinning that
    // would keep it at nothing once the window is wide enough for it again.
    if (w > 0) widths[key] = w;
    else if (widths[key] == null) widths[key] = fitOf(key).min;
  }
  state.layout.columnWidths = widths;
}

/**
 * Fit the columns to the pane, whatever size the pane is.
 *
 * Two things used to put a horizontal scrollbar under a list that had no
 * business scrolling. The table carried a hard `min-width`, so a narrow window
 * pushed it sideways and took the project column off the left edge -- the one
 * column the list exists to show. And pinned pixel widths only ever scaled up
 * to fill new space, never down to give it back.
 *
 * So: shrink as well as stretch, and when even that would leave columns too
 * narrow to read, give up the least useful column instead of squeezing them
 * all into mush. Sideways scrolling is left for the one case it is honest --
 * when what must be shown genuinely does not fit.
 */
function applyColumnWidths() {
  const table = document.querySelector('table.sessions');
  const wrap = table && table.closest('.table-wrap');
  if (!table || !wrap) return;
  const available = wrap.clientWidth;
  // Nothing to measure against yet: first paint, or a minimised window.
  if (available <= 0) return;

  const ths = [...table.querySelectorAll('thead th')];
  const keys = ths.map((th) => th.dataset.sort || 'check');
  const stored = state.layout.columnWidths;

  // A drag has to move exactly the column under the cursor and leave its
  // neighbours where they are, even when that pushes the table past the pane.
  // Refitting mid-drag would drag every column at once.
  if (state.resizingColumn && stored) {
    let total = 0;
    ths.forEach((th, i) => {
      const px = stored[keys[i]];
      if (!px) return;
      th.style.width = px + 'px';
      total += px;
    });
    table.style.width = total + 'px';
    table.style.minWidth = total + 'px';
    return;
  }

  // What each column is asking for: where the user dragged it, or its share.
  const want = {};
  for (const k of keys) want[k] = (stored && stored[k]) ? stored[k] : fitOf(k).want;

  // Give up the least useful column, then the next, until what is left can be
  // shown at a width worth reading.
  const hidden = new Set();
  const sumMin = () => keys.reduce((n, k) => (hidden.has(k) ? n : n + fitOf(k).min), 0);
  const order = keys.filter((k) => fitOf(k).drop).sort((x, y) => fitOf(x).drop - fitOf(y).drop);
  for (const k of order) {
    if (sumMin() <= available) break;
    hidden.add(k);
  }
  for (const k of Object.keys(COLUMN_FIT)) {
    table.classList.toggle('hide-' + k, hidden.has(k));
  }

  // Every visible column starts at its minimum; whatever is left over is
  // shared out by what each was asking for. That way the total lands exactly
  // on the pane width and no column is below the width it needs.
  const visible = keys.filter((k) => !hidden.has(k));
  const widths = {};
  let floor = 0;
  for (const k of visible) { widths[k] = fitOf(k).min; floor += widths[k]; }

  const leftover = available - floor;
  if (leftover > 0) {
    const growers = visible.filter((k) => fitOf(k).grow);
    const totalWant = growers.reduce((n, k) => n + want[k], 0) || 1;
    let given = 0;
    growers.forEach((k, i) => {
      // The last one takes the rounding remainder, so the row ends flush.
      const share = i === growers.length - 1
        ? leftover - given
        : Math.round(leftover * (want[k] / totalWant));
      widths[k] += share;
      given += share;
    });
  }

  let total = 0;
  ths.forEach((th, i) => {
    const k = keys[i];
    if (hidden.has(k)) { th.style.width = ''; return; }
    th.style.width = widths[k] + 'px';
    total += widths[k];
  });
  // Below this the columns that must be shown do not fit at their minimums.
  // Nothing left to give up, so the pane scrolls -- honestly, this time.
  table.style.width = total + 'px';
  table.style.minWidth = total + 'px';
}
function initColumnResizers() {
  for (const th of document.querySelectorAll('table.sessions thead th')) {
    if (th.querySelector('.col-grip')) continue;
    const key = th.dataset.sort || 'check';
    const grip = el('div', 'col-grip');
    grip.title = 'Drag to resize · double-click to auto-fit';

    grip.addEventListener('pointerdown', (e) => {
      // Never let a resize register as a sort click.
      e.preventDefault();
      e.stopPropagation();
      // Start from what is on screen, stretch included, so nothing jumps.
      pinColumnWidths(true);
      state.resizingColumn = key;
      const startX = e.clientX;
      const startW = state.layout.columnWidths[key];
      grip.setPointerCapture(e.pointerId);
      grip.classList.add('dragging');
      document.body.classList.add('resizing');

      const move = (ev) => {
        state.layout.columnWidths[key] = Math.max(COLUMN_MIN, Math.round(startW + (ev.clientX - startX)));
        applyColumnWidths();
      };
      const up = (ev) => {
        grip.releasePointerCapture(ev.pointerId);
        grip.classList.remove('dragging');
        document.body.classList.remove('resizing');
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        state.resizingColumn = null;
        // Re-fill the pane now that exact-pixel dragging is over.
        applyColumnWidths();
        saveLayoutSoon();
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
    });

    // Double-click the grip to size the column to its widest visible cell.
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      autoFitColumn(th, key);
    });

    // A click that lands on the grip must not sort either.
    grip.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });

    th.append(grip);
  }
}

/** Widen (or narrow) a column to fit the widest cell currently rendered. */
function autoFitColumn(th, key) {
  pinColumnWidths();
  const index = [...th.parentElement.children].indexOf(th);
  const probe = el('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit;';
  document.body.append(probe);

  let widest = 0;
  const measure = (text, extraPx) => {
    probe.textContent = text || '';
    widest = Math.max(widest, probe.getBoundingClientRect().width + (extraPx || 0));
  };
  measure(th.textContent.trim(), 26);           // header + sort arrow
  for (const row of document.querySelectorAll('#sessionsBody tr:not(.group-row)')) {
    const cell = row.children[index];
    if (!cell) continue;
    // Stacked cells (title over id) need the wider of the two lines.
    const lines = cell.children.length ? [...cell.children].map((c) => c.textContent) : [cell.textContent];
    for (const line of lines) measure(line, 22);
  }
  probe.remove();

  state.layout.columnWidths[key] = Math.max(fitOf(key).min, Math.min(640, Math.round(widest)));
  applyColumnWidths();
  saveLayoutSoon();
}

function resetLayout() {
  state.layout = { ...PANE_DEFAULTS, columnWidths: null };
  applyPaneWidths();
  applyColumnWidths();
  saveLayoutSoon();
  toast('Layout reset', 'Panes and columns back to their defaults', 'ok', 3000);
}

/* ---------------------------------------------------------- title bar */

/**
 * macOS draws its own traffic lights over the title bar, so the app must not
 * draw a second set of window buttons and must keep its own content clear of
 * the ones that are there. Marked on <html> so the stylesheet can do it in
 * one place rather than every element asking.
 */
function markPlatform() {
  const p = (window.api && window.api.platform) || 'win32';
  document.documentElement.classList.toggle('is-mac', p === 'darwin');
  document.documentElement.classList.toggle('is-linux', p === 'linux');
}

async function initTitleBar() {
  const send = (action) => window.api.windowAction(action).catch(() => {});
  $('winMin').addEventListener('click', () => send('minimize'));
  $('winMax').addEventListener('click', () => send('maximize'));
  $('winClose').addEventListener('click', () => send('close'));
  // Double-clicking the bar toggles maximize, as a native title bar does.
  $('titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tb-btn')) send('maximize');
  });

  const paint = ({ maximized }) => {
    $('winMax').querySelector('.ico-max').hidden = !!maximized;
    $('winMax').querySelector('.ico-restore').hidden = !maximized;
    $('winMax').title = maximized ? 'Restore' : 'Maximize';
  };
  window.api.onWindowState(paint);
  try { paint(await window.api.windowQuery()); } catch { /* pre-ready is fine */ }
}

/* ----------------------------------------------------------- updates */

let updateState = null;

/**
 * The indicator earns its place only when there is something to act on.
 * "Up to date" is not news, so it stays hidden unless the user opened the
 * dialog themselves.
 */
function paintUpdate(s) {
  updateState = s;
  const btn = $('updateBtn');
  const show = { available: 'Update', downloading: null, downloaded: 'Restart', error: null }[s.state];

  if (s.state === 'downloading') {
    btn.hidden = false;
    btn.textContent = `Downloading ${s.percent}%`;
    btn.className = 'btn btn-update';
    btn.title = 'Downloading the update in the background';
  } else if (s.state === 'downloaded') {
    btn.hidden = false;
    btn.textContent = 'Restart';
    btn.className = 'btn btn-update is-ready';
    btn.title = `Version ${s.version} is ready to install`;
  } else if (s.state === 'available') {
    btn.hidden = false;
    btn.textContent = `Update ${s.version}`;
    btn.className = 'btn btn-update';
    btn.title = 'A new version is available';
  } else {
    btn.hidden = true;
  }
  void show;
}

function updateLine(s) {
  switch (s.state) {
    case 'checking': return 'Checking…';
    case 'available': return `Version ${s.version} is available. You are on ${s.currentVersion}.`;
    case 'downloading': return `Downloading ${s.version} — ${s.percent}%`;
    case 'downloaded': return `Version ${s.version} is ready. Restart to install.`;
    case 'up-to-date': return `You are on the latest version (${s.currentVersion}).`;
    case 'disabled': return s.reason || 'Updates are unavailable.';
    case 'error': return s.error || 'Update check failed.';
    default: return `Version ${s.currentVersion}.`;
  }
}

async function openUpdateDialog() {
  let s = updateState || (await window.api.updateState());
  const render = (body, foot) => {
    body.replaceChildren();
    foot.replaceChildren();

    body.append(el('div', 'warn-box info', updateLine(s)));

    if (s.state === 'downloading') {
      const bar = el('div', 'update-bar');
      const fill = el('i');
      fill.style.width = (s.percent || 0) + '%';
      bar.append(fill);
      body.append(bar);
    }
    if (s.releaseNotes && (s.state === 'available' || s.state === 'downloaded')) {
      body.append(el('div', 'update-notes', s.releaseNotes));
    }
    if (s.busy && s.state === 'downloaded') {
      body.append(el('div', 'warn-box warn',
        'An operation is still running. Installing waits until it finishes so nothing is left half applied.'));
    }

    // Preferences.
    const opts = el('div');
    const mk = (label, key, checked, title) => {
      const row = el('label', 'opt-row');
      const cb = el('input'); cb.type = 'checkbox'; cb.checked = checked;
      if (title) row.title = title;
      cb.addEventListener('change', async () => {
        s = await window.api.updateSettings({ [key]: cb.checked });
        render(body, foot);
      });
      row.append(cb, document.createTextNode(label));
      return row;
    };
    opts.append(mk('Check on launch', 'checkOnLaunch', s.settings.checkOnLaunch,
      'The only network request this app makes. Turn it off to stay fully offline.'));
    opts.append(mk('Download automatically', 'autoDownload', s.settings.autoDownload,
      'Installing still always needs an explicit click.'));

    const ch = el('label', 'opt-row');
    ch.append(document.createTextNode('Channel'));
    const sel = el('select');
    for (const [v, t] of [['latest', 'Stable'], ['beta', 'Beta']]) {
      const o = el('option', null, t); o.value = v; if (s.settings.channel === v) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', async () => { s = await window.api.updateSettings({ channel: sel.value }); render(body, foot); });
    ch.append(sel);
    opts.append(ch);
    body.append(opts);

    if (s.lastCheckedAt) body.append(el('div', 'paths-line', 'Last checked ' + fmtDate(s.lastCheckedAt)));

    // Actions.
    const close = el('button', 'btn', 'Close');
    close.addEventListener('click', closeModal);

    if (s.state === 'available') {
      const skip = el('button', 'btn', 'Skip');
      skip.addEventListener('click', async () => { s = await window.api.updateSkip(s.version); render(body, foot); });
      const dl = el('button', 'btn btn-primary', 'Download');
      dl.addEventListener('click', async () => { dl.disabled = true; s = await window.api.updateDownload(); render(body, foot); });
      foot.append(close, skip, dl);
    } else if (s.state === 'downloaded') {
      const install = el('button', 'btn btn-primary', 'Restart & install');
      install.disabled = !!s.busy;
      install.addEventListener('click', async () => {
        try { await window.api.updateInstall(); }
        catch (err) { toast('Cannot restart yet', apiError(err).message, 'warn', 8000); }
      });
      foot.append(close, install);
    } else if (s.state === 'downloading') {
      foot.append(close);
    } else {
      const chk = el('button', 'btn btn-primary', 'Check now');
      chk.disabled = !s.supported;
      chk.addEventListener('click', async () => {
        chk.disabled = true; chk.textContent = 'Checking…';
        s = await window.api.updateCheck();
        render(body, foot);
      });
      foot.append(close, chk);
    }
  };

  openModal('Updates', (body) => render(body, $('modalFoot')), () => {});
  // Keep the open dialog live while a download runs.
  updateDialogRefresh = (next) => { s = next; if (!$('modalBackdrop').hidden) render($('modalBody'), $('modalFoot')); };
}

let updateDialogRefresh = null;

function renderTools() {
  const list = $('toolList');
  list.replaceChildren();

  // With one source, an "All" card and the source card showed the same list.
  // The slot is worth more as the comparison between accounts.
  const cmp = el('div', 'tool-card' + (state.comparing ? ' active' : ''));
  cmp.append(el('div', 'name', 'Compare'));
  cmp.append(el('div', 'meta', state.accounts.length > 1
    ? `${state.accounts.length} accounts side by side`
    : 'needs two accounts'));
  cmp.title = state.accounts.length > 1
    ? 'Show which sessions each account lists, and which are only in one'
    : 'Only one Claude Desktop account was found on this machine.';
  cmp.addEventListener('click', () => showComparison());
  list.append(cmp);

  for (const t of state.scan.tools) {
    // A detected root with nothing in it is noise; keep the UI to real data.
    if (!t.hasSessions && t.sessionCount === 0) continue;

    const isActive = state.filterTool === t.root && !state.activeAccountUuid;
    const card = el('div', 'tool-card' + (isActive ? ' active' : ''));
    const name = el('div', 'name');
    name.append(document.createTextNode(t.displayName));
    // With two accounts there is nothing worth collapsing; the caret only put
    // a click in front of the thing people came for.
    const showsAccounts = t.tool === 'claude-code' && state.accounts.length > 0;
    card.append(name);

    card.append(el('div', 'meta', `${t.sessionCount} · ${fmtBytes(t.bytes)}`));
    if (showsAccounts && state.accounts.length > 1) {
      const b = el('div', 'meta');
      b.append(el('span', 'badge badge-info', `${state.accounts.length} accounts`));
      card.append(b);
    }
    // The account and the folder live in the tooltip rather than on the card.
    card.title = [t.accountId?.label, t.root].filter(Boolean).join('\n');
    if (t.damaged > 0) {
      const b = el('div', 'meta');
      b.append(el('span', 'badge badge-err', `${t.damaged} flagged`));
      card.append(b);
    }
    card.addEventListener('click', () => {
      state.filterTool = t.root;
      clearAccountView();
      renderTools(); renderTable();
    });
    card.classList.toggle('active', isActive && !state.comparing);
    list.append(card);

    if (showsAccounts) {
      // A branch of its own, so the trunk can stop at the last account
      // instead of running on down the sidebar.
      const branch = el('div', 'account-tree');
      for (const a of state.accounts) branch.append(accountCard(a));
      list.append(branch);
    }
  }
}

/**
 * One Claude Desktop account in the sidebar.
 *
 * The count shown is what the account's index lists, which is deliberately not
 * the number of transcripts on disk -- the two disagree, and pretending
 * otherwise is what makes an index look authoritative.
 */
function accountCard(a) {
  const card = el('div', 'account-card' + (state.activeAccountUuid === a.accountUuid ? ' active' : ''));

  const name = el('div', 'name');
  name.append(document.createTextNode(a.label));
  card.append(name);

  card.append(el('div', 'meta', `${a.sessionCount} in history`));

  if (a.isCurrent) {
    const b = el('div', 'meta');
    b.append(el('span', 'badge badge-ok', 'signed in'));
    card.append(b);
  } else if (a.isCliCurrent) {
    // Claude Desktop and the Claude Code CLI sign in separately. When they
    // hold different accounts, saying only "signed in" about one of them
    // would be the same mistake as reading the wrong file in the first place.
    const b = el('div', 'meta');
    b.append(el('span', 'badge badge-info', 'Claude Code'));
    card.append(b);
  } else if (!a.named) {
    // Say plainly why it has no name, rather than showing a bare uuid.
    const b = el('div', 'meta');
    b.append(el('span', 'badge badge-info', 'not signed in'));
    card.append(b);
  }
  if (a.ambiguous) {
    const b = el('div', 'meta');
    b.append(el('span', 'badge badge-warn', 'folder unclear'));
    card.append(b);
  }

  card.title = [
    a.email || a.label,
    a.organizationName ? 'Org: ' + a.organizationName : null,
    a.isCurrent ? 'Signed in to Claude Desktop.' : null,
    a.isCliCurrent && !a.isCurrent ? 'Signed in to the Claude Code CLI, not to Claude Desktop.' : null,
    'Account ' + a.accountUuid,
    a.historyOrgUuid ? 'History folder: ' + a.historyOrgUuid : 'History folder: unresolved',
    a.reason,
  ].filter(Boolean).join('\n');

  card.addEventListener('click', () => showAccountHistory(a.accountUuid));
  return card;
}

/** Back to the on-disk session list. */
function clearAccountView() {
  state.activeAccountUuid = null;
  state.accountRows = [];
  state.accountNote = null;
  state.comparing = false;
  state.compareRows = [];
  paintFilterBar();
  $('compareWrap').hidden = true;
  document.querySelector('.table-wrap').hidden = false;
  state.selected.clear();
  updateSelectionUi();
}

/**
 * Show one account's history: the entries Claude Desktop's index holds, not
 * the transcripts on disk.
 *
 * Each entry is joined back to a real session by `cliSessionId` where one
 * exists, so those rows stay selectable and exportable. An entry whose
 * transcript is not on disk is still listed -- it is part of that account's
 * history -- but marked, and never selectable, because there is nothing to
 * act on.
 */
async function showAccountHistory(accountUuid, options = {}) {
  const { silent = false } = options;
  try {
    const { account, entries } = await window.api.accountHistory(accountUuid);

    const byCliId = new Map();
    for (const s of state.sessions) if (s.sessionId) byCliId.set(s.sessionId, s);

    state.accountRows = entries.map((e) => {
      const real = e.cliSessionId ? byCliId.get(e.cliSessionId) : null;
      // A real session keeps its uid, so selection, export and verify work.
      if (real) {
        return { ...real, title: e.title || real.title, indexPath: e.indexPath, fromIndex: true, hasTranscript: true };
      }
      return {
        uid: 'index:' + e.desktopSessionId,
        sessionId: e.cliSessionId || e.desktopSessionId,
        sourceTool: 'claude-code',
        filePath: null,
        projectPath: e.projectPath,
        projectDir: null,
        model: e.model,
        // Claude Desktop's own record for this session. It is the only file
        // behind an index-only row, and it is what Show file reveals.
        indexPath: e.indexPath,
        title: e.title,
        gitBranch: e.branch,
        createdAt: e.createdAt,
        updatedAt: e.lastActivityAt,
        sizeBytes: null,
        integrity: 'no-transcript',
        warnings: [{ level: 'warn', code: 'no-transcript', message: 'Listed in this history, but the transcript is not on disk.' }],
        fromIndex: true,
        hasTranscript: false,
      };
    });

    state.activeAccountUuid = accountUuid;
    state.accountNote = account;
    state.comparing = false;
    paintFilterBar();
    $('compareWrap').hidden = true;
    document.querySelector('.table-wrap').hidden = false;
    state.selected.clear();
    state.filterTool = null;
    renderTools();
    renderTable();

    const missing = state.accountRows.filter((r) => !r.hasTranscript).length;
    $('scanSummary').textContent =
      `${account.label} · ${state.accountRows.length} in history` + (missing ? ` · ${missing} without a transcript` : '');
    $('scanSummary').title =
      `Claude Desktop's index for this account.\nFolder: ${account.historyOrgUuid}\n${account.reason}`;
  } catch (err) {
    const e = apiError(err);
    if (!silent) {
      // The one failure worth spelling out: we could not tell which folder
      // holds this account's history, so nothing is shown rather than a list
      // built from the wrong folder.
      toast(
        e.code === 'HISTORY_ORG_UNRESOLVED' ? 'Cannot identify the history folder' : 'Could not read that account',
        e.message, 'warn', 11000);
    }
    clearAccountView();
    renderTools();
    renderTable();
  }
}

/**
 * Show the filters that mean something for the view being shown.
 *
 * Flagged and Group are about transcripts on disk and do nothing to a
 * comparison of index records; leaving them clickable but inert is worse than
 * hiding them.
 */
function paintFilterBar() {
  $('onlyWarningsWrap').hidden = state.comparing;
  $('groupToggleWrap').hidden = state.comparing;
  $('notSyncedWrap').hidden = !state.comparing;
  if (state.comparing) {
    $('collapseAllBtn').hidden = true;
    $('notSyncedOnly').checked = state.compareOnlyDiffs;
  }
}

/**
 * Compare what each account lists.
 *
 * One row per session, one column per account. The point of the view is the
 * disagreement -- a session only one account has -- so that is what the status
 * column names, and sessions every account already lists are marked plainly
 * rather than left ambiguous.
 */
async function showComparison() {
  if (state.accounts.length < 2) {
    toast('Nothing to compare', 'Only one Claude Desktop account was found on this machine.', 'info', 6000);
    return;
  }
  $('scanSummary').textContent = 'Reading each account…';
  try {
    const per = [];
    for (const a of state.accounts) {
      const { entries } = await window.api.accountHistory(a.accountUuid);
      per.push({ account: a, entries });
    }

    // Union by the transcript id, which is what identifies a session across
    // accounts; the record id is only Desktop's own handle for it.
    const byKey = new Map();
    for (const { account, entries } of per) {
      for (const e of entries) {
        const key = e.cliSessionId || 'record:' + e.desktopSessionId;
        if (!byKey.has(key)) {
          byKey.set(key, {
            key, cliSessionId: e.cliSessionId, title: e.title,
            projectPath: e.projectPath, lastActivityAt: e.lastActivityAt,
            inAccounts: new Set(),
          });
        }
        const row = byKey.get(key);
        row.inAccounts.add(account.accountUuid);
        // Show the most recent activity anyone recorded for it.
        if ((Date.parse(e.lastActivityAt || '') || 0) > (Date.parse(row.lastActivityAt || '') || 0)) {
          row.lastActivityAt = e.lastActivityAt;
        }
        if (!row.title && e.title) row.title = e.title;
      }
    }

    state.compareRows = [...byKey.values()];
    state.comparing = true;
    state.activeAccountUuid = null;
    state.accountRows = [];
    state.selected.clear();
    updateSelectionUi();
    paintFilterBar();
    renderTools();
    renderComparison();

    paintCompareSummary();
  } catch (err) {
    const e = apiError(err);
    toast(e.code === 'HISTORY_ORG_UNRESOLVED' ? 'Cannot identify a history folder' : 'Could not compare the accounts',
      e.message, 'warn', 11000);
    clearAccountView();
    renderTools();
    renderTable();
  }
}

/** The count line under the title bar, following whatever filter is on. */
function paintCompareSummary() {
  const total = state.compareRows.length;
  const unsynced = state.compareRows.filter((r) => r.inAccounts.size < state.accounts.length).length;
  $('scanSummary').textContent = state.compareOnlyDiffs
    ? `${unsynced} not synced · of ${total} across ${state.accounts.length} accounts`
    : `${total} sessions across ${state.accounts.length} accounts · ${unsynced} not synced`;
  $('scanSummary').title = "From each account's Claude Desktop history.";
}

function renderComparison() {
  document.querySelector('.table-wrap').hidden = true;
  $('compareWrap').hidden = false;

  const head = $('compareHead');
  head.replaceChildren();
  const th = (cls, text, title) => {
    const n = el('th', cls, text);
    if (title) n.title = title;
    head.append(n);
    return n;
  };
  th('col-title', 'Session');
  th('col-project', 'Project');
  th('col-updated', 'Last active');
  for (const a of state.accounts) th('col-acct', a.label, a.accountUuid);
  th('col-state', 'Status');

  const q = state.search.trim().toLowerCase();
  const rows = state.compareRows
    .filter((r) => !state.compareOnlyDiffs || r.inAccounts.size < state.accounts.length)
    .filter((r) => !q || [r.title, r.projectPath, r.cliSessionId]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q)))
    // Differences first: they are the reason to open this view.
    .sort((a, b) =>
      (a.inAccounts.size - b.inAccounts.size) ||
      String(b.lastActivityAt || '').localeCompare(String(a.lastActivityAt || '')));

  const body = $('compareBody');
  body.replaceChildren();
  for (const r of rows) {
    const tr = el('tr');
    const complete = r.inAccounts.size === state.accounts.length;
    if (!complete) tr.classList.add('differs');

    const tdTitle = el('td', 'col-title');
    const t = el('div', 'truncate', r.title || r.cliSessionId || '—');
    t.title = r.title || '';
    tdTitle.append(t);
    if (r.cliSessionId) tdTitle.append(el('div', 'mono faint', r.cliSessionId));
    tr.append(tdTitle);

    const tdProj = el('td', 'col-project');
    const pd = el('div', 'truncate', r.projectPath || '—');
    pd.title = r.projectPath || '';
    tdProj.append(pd);
    tr.append(tdProj);

    tr.append(el('td', 'col-updated', fmtDate(r.lastActivityAt)));

    for (const a of state.accounts) {
      const has = r.inAccounts.has(a.accountUuid);
      const td = el('td', 'col-acct' + (has ? '' : ' missing'), has ? '✓' : '—');
      td.title = has ? `${a.label} lists this session` : `${a.label} does not list it`;
      tr.append(td);
    }

    const tdState = el('td', 'col-state');
    const cell = el('div', 'state-cell');
    tdState.append(cell);
    if (complete) {
      cell.append(el('span', 'badge badge-ok', 'in all'));
    } else {
      const missing = state.accounts.filter((a) => !r.inAccounts.has(a.accountUuid));
      // The account names are long and the cell also carries the fix button,
      // so the badge stays short and the tooltip does the naming.
      const badge = el('span', 'badge badge-warn', 'missing');
      badge.title = 'Not listed by ' + missing.map((a) => a.label).join(', ');
      cell.append(badge);
      // The row already says it is missing somewhere; this is the fix for it.
      const go = el('button', 'btn btn-small', 'Sync');
      go.title = `Copy this session into ${missing.map((a) => a.label).join(', ')}`;
      go.disabled = !r.cliSessionId;
      if (!r.cliSessionId) {
        go.title = 'This record has no transcript id, so it cannot be matched across accounts.';
      }
      go.addEventListener('click', (e) => {
        e.stopPropagation();
        syncOneSession(r, go);
      });
      cell.append(go);
    }
    tr.append(tdState);
    body.append(tr);
  }

  paintCompareSummary();

  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', null,
      state.compareOnlyDiffs && !q
        ? 'Every session is listed by all accounts.'
        : 'Nothing matches that filter.');
    td.colSpan = 4 + state.accounts.length;
    tr.append(td);
    body.append(tr);
  }
}

/**
 * Give every account one session, from the comparison.
 *
 * The same plan the whole-account sync builds, narrowed to a single session,
 * so it carries the same preview and the same refusals -- a session the target
 * deleted is still left out here.
 */
async function syncOneSession(row, button) {
  if (!row.cliSessionId) return;
  const label = button ? button.textContent : null;
  if (button) { button.disabled = true; button.textContent = '…'; }
  try {
    // Pointed at one session, so a deletion in the target is not a refusal --
    // it is something to state clearly and let the person decide.
    const plan = await window.api.planAccountSyncAll(null, [row.cliSessionId], true);
    if (!plan.summary.copy) {
      toast('Nothing to copy', 'Every account already lists this session.', 'info', 8000);
      if (button) { button.disabled = false; button.textContent = label; }
      return;
    }
    openIndexPlanModal(row.title || 'Sync this session', plan, async () => {
      await refresh();
      await showComparison();
    });
  } catch (err) {
    toast('Could not plan the copy', apiError(err).message, 'warn', 10000);
  } finally {
    if (button && button.isConnected) { button.disabled = false; button.textContent = label; }
  }
}

/* --------------------------------------------------------------- table */

function visibleSessions() {
  const q = state.search.trim().toLowerCase();
  // With an account selected the table shows that account's index history
  // instead of the on-disk list; the tool filter does not apply to it.
  const source = state.activeAccountUuid ? state.accountRows : state.sessions;
  const rows = source.filter((s) => {
    if (!state.activeAccountUuid && state.filterTool && s.toolRoot !== state.filterTool) return false;
    if (state.onlyWarnings && !(s.warnings && s.warnings.length)) return false;
    if (!q) return true;
    return [s.sessionId, s.projectPath, s.model, s.title, s.projectDir]
      .filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });
  return sortSessions(rows);
}

/**
 * The visible rows that can actually be acted on.
 *
 * An account's history can list a session whose transcript is gone. It is
 * shown, because it is part of that history, but selecting it would offer an
 * export or a verify with no file behind it.
 */
function selectableSessions() {
  return visibleSessions().filter((s) => s.hasTranscript !== false);
}

/** The folder a session belongs to, and how it is shown as a group heading. */
function groupKey(s) {
  return s.projectPath || s.projectDir || '(no project)';
}
function groupLabel(key) {
  if (key === '(no project)') return key;
  // Show the folder name prominently and keep the full path as the tooltip.
  const parts = String(key).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : key;
}

/** How healthy a session looks, worst first when sorting descending. */
const INTEGRITY_RANK = { ok: 0, truncated: 1, empty: 2, damaged: 3, unreadable: 4 };

const SORTERS = {
  project: (s) => (s.projectPath || s.projectDir || '').toLowerCase(),
  title: (s) => (s.title || '').toLowerCase(),
  model: (s) => (s.model || '').toLowerCase(),
  size: (s) => s.sizeBytes || 0,
  updated: (s) => Date.parse(s.updatedAt || '') || 0,
  state: (s) => INTEGRITY_RANK[s.integrity] ?? 9,
};

function sortSessions(rows) {
  const { key, dir } = state.sort;
  const pick = SORTERS[key] || SORTERS.updated;
  const mul = dir === 'asc' ? 1 : -1;

  return rows.slice().sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);

    // Rows with no value for the sorted column sink to the bottom in both
    // directions -- an empty title is not "first alphabetically", it is absent.
    const aEmpty = va === '' || va === null || va === undefined;
    const bEmpty = vb === '' || vb === null || vb === undefined;
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;

    let c;
    if (typeof va === 'number' && typeof vb === 'number') c = va - vb;
    else c = String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' });

    // Stable, predictable tiebreak so equal values do not shuffle between renders.
    if (c === 0) return String(a.uid).localeCompare(String(b.uid));
    return c * mul;
  });
}

/** Sorted rows bucketed by folder, groups ordered by the same sort. */
function groupSessions(rows) {
  const groups = new Map();
  for (const s of rows) {
    const k = groupKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  // When sorting by a session-level column, order groups by their best row so
  // the grouping does not fight the chosen sort.
  const pick = SORTERS[state.sort.key] || SORTERS.updated;
  const mul = state.sort.dir === 'asc' ? 1 : -1;
  return [...groups.entries()].sort((a, b) => {
    if (state.sort.key === 'project') {
      return String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true, sensitivity: 'base' }) * mul;
    }
    const va = pick(a[1][0]);
    const vb = pick(b[1][0]);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mul;
    return String(va).localeCompare(String(vb)) * mul;
  });
}

function renderTable() {
  const body = $('sessionsBody');
  body.replaceChildren();
  const rows = visibleSessions();

  $('emptyState').hidden = rows.length > 0;
  paintSortHeaders();

  if (state.groupBy === 'project') {
    const groups = groupSessions(rows);
    for (const [key, items] of groups) {
      body.append(buildGroupRow(key, items));
      if (state.collapsedGroups.has(key)) continue;
      for (const s of items) body.append(buildRow(s));
    }
    paintCollapseAll(groups.map(([key]) => key));
  } else {
    for (const s of rows) body.append(buildRow(s));
    $('collapseAllBtn').hidden = true;
  }
  updateSelectionUi();
  // A render can add or remove the vertical scrollbar, which changes how
  // much width the columns have to share.
  applyColumnWidths();
}

/** A collapsible heading for one project folder. */
function buildGroupRow(key, items) {
  const tr = el('tr', 'group-row');
  const collapsed = state.collapsedGroups.has(key);
  if (!collapsed) tr.classList.add('open');
  tr.dataset.group = key;

  const td = el('td');
  td.colSpan = 7;
  const wrap = el('div', 'g-wrap');
  wrap.append(el('span', 'g-caret'));

  const name = el('span', 'g-name', groupLabel(key));
  name.title = key;
  wrap.append(name);

  const bytes = items.reduce((a, s) => a + (s.sizeBytes || 0), 0);
  const flagged = items.filter((s) => (s.warnings || []).length).length;
  wrap.append(el('span', 'g-meta', `${items.length} · ${fmtBytes(bytes)}${flagged ? ` · ${flagged} flagged` : ''}`));

  // Selecting a whole folder is the main reason to group in the first place.
  const sel = el('button', 'btn btn-small', 'Select');
  sel.title = 'Select every session in this folder';
  sel.addEventListener('click', (e) => {
    e.stopPropagation();
    const allSelected = items.every((s) => state.selected.has(s.uid));
    for (const s of items) {
      if (allSelected) state.selected.delete(s.uid); else state.selected.add(s.uid);
    }
    renderTable();
  });
  wrap.append(el('span', 'spacer'));
  wrap.append(sel);

  td.append(wrap);
  tr.append(td);
  tr.addEventListener('click', () => {
    if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
    else state.collapsedGroups.add(key);
    renderTable();
  });
  return tr;
}

function buildRow(s) {
  {
    const tr = el('tr');
    tr.dataset.uid = s.uid;
    if (state.selected.has(s.uid)) tr.classList.add('selected');
    if (state.focusedUid === s.uid) tr.classList.add('focused');
    // A history entry whose transcript is gone: shown, but there is no file
    // to select, open or act on.
    const actable = s.hasTranscript !== false;
    if (!actable) tr.classList.add('ghost');

    const tdCheck = el('td', 'col-check');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(s.uid);
    cb.disabled = !actable;
    if (!actable) cb.title = 'No transcript on disk, so there is nothing to act on.';
    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!actable) { cb.checked = false; return; }
      toggleSelect(s.uid, cb.checked);
    });
    tdCheck.append(cb);
    tr.append(tdCheck);

    const proj = s.projectPath || s.projectDir || '—';
    const tdProj = el('td', 'col-project');
    const projDiv = el('div', 'truncate', proj);
    projDiv.title = proj;
    tdProj.append(projDiv);
    tr.append(tdProj);

    const tdTitle = el('td', 'col-title');
    if (s.title) {
      const titleDiv = el('div', 'truncate', s.title);
      titleDiv.title = s.title;
      tdTitle.append(titleDiv);
    }
    // No placeholder when a session has no title -- the id below identifies it,
    // and 160 repetitions of "(untitled)" is noise, not information.
    const idDiv = el('div', 'mono faint', s.sessionId);
    idDiv.title = s.sessionId;
    tdTitle.append(idDiv);
    tr.append(tdTitle);

    tr.append(el('td', 'col-model dim', s.model || '—'));
    tr.append(el('td', 'col-size', fmtBytes(s.sizeBytes)));
    tr.append(el('td', 'col-updated', fmtDate(s.updatedAt)));

    const tdState = el('td', 'col-state');
    tdState.append(integrityBadge(s));
    if (s.subAgentCount > 0) tdState.append(el('span', 'badge badge-info', `${s.subAgentCount} sub`));
    tr.append(tdState);

    tr.addEventListener('click', () => selectDetail(s.uid));
    return tr;
  }
}

/**
 * Show the collapse/expand-all control only while grouping, and label it for
 * what the next click will do.
 */
function paintCollapseAll(keys) {
  const btn = $('collapseAllBtn');
  btn.hidden = keys.length === 0;
  if (btn.hidden) return;
  const anyOpen = keys.some((k) => !state.collapsedGroups.has(k));
  $('collapseAllLabel').textContent = anyOpen ? 'Collapse' : 'Expand';
  btn.classList.toggle('all-collapsed', !anyOpen);
  btn.title = anyOpen
    ? `Collapse all ${keys.length} folders`
    : `Expand all ${keys.length} folders`;
}

function toggleAllGroups() {
  const keys = groupSessions(visibleSessions()).map(([key]) => key);
  const anyOpen = keys.some((k) => !state.collapsedGroups.has(k));
  if (anyOpen) for (const k of keys) state.collapsedGroups.add(k);
  else state.collapsedGroups.clear();
  renderTable();
}

/** Reflect the active sort in the header row. */
function paintSortHeaders() {
  for (const th of document.querySelectorAll('table.sessions thead th.sortable')) {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.sort.key) {
      th.classList.add(state.sort.dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
    th.title = th.dataset.sort === state.sort.key
      ? `Sorted by ${th.textContent.trim().toLowerCase()} — click to reverse`
      : `Sort by ${th.textContent.trim().toLowerCase()}`;
  }
}

function setSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sort.key = key;
    // Sizes and dates are most useful largest/newest first; text reads better A→Z.
    state.sort.dir = (key === 'size' || key === 'updated' || key === 'state') ? 'desc' : 'asc';
  }
  renderTable();
}

function integrityBadge(s) {
  if (s.integrity === 'ok') {
    const b = el('span', 'badge badge-ok', s.integrityScan === 'deep' ? 'verified' : 'ok');
    b.title = s.integrityScan === 'deep'
      ? 'Whole file streamed and parsed cleanly.'
      : 'Header check only. Run Deep-verify to stream the whole file.';
    return b;
  }
  const map = {
    damaged: ['badge-err', 'damaged'],
    unreadable: ['badge-err', 'unreadable'],
    truncated: ['badge-warn', 'truncated'],
    empty: ['badge-err', 'empty'],
    // Not a corrupt file -- an index entry with no file behind it at all.
    'no-transcript': ['badge-warn', 'no transcript'],
  };
  const [cls, label] = map[s.integrity] || ['badge-info', s.integrity || 'unknown'];
  const b = el('span', 'badge ' + cls, label);
  if (s.integrity === 'no-transcript') {
    b.title = 'Listed in this account history, but no transcript for it is on disk.';
  }
  return b;
}

function toggleSelect(uid, on) {
  if (on) state.selected.add(uid); else state.selected.delete(uid);
  const tr = document.querySelector(`tr[data-uid="${CSS.escape(uid)}"]`);
  if (tr) tr.classList.toggle('selected', on);
  updateSelectionUi();
}

function updateSelectionUi() {
  const n = state.selected.size;
  const sel = [...state.selected].map((u) => state.sessions.find((s) => s.uid === u)).filter(Boolean);
  const bytes = sel.reduce((a, s) => a + (s.sizeBytes || 0), 0);
  $('selectionInfo').textContent = n ? `${n} · ${fmtBytes(bytes)}` : '';
  $('selectionInfo').hidden = n === 0;
  for (const id of ['exportBtn', 'migrateBtn', 'verifyBtn']) $(id).disabled = n === 0;
  // Removing from an account only means anything while one is being shown.
  // The actions below apply to whichever account is open, so the heading says
  // which one -- otherwise Remove and Scan & Repair are unlabelled verbs.
  const heading = $('actionsHeading');
  const active = state.activeAccountUuid
    ? state.accounts.find((a) => a.accountUuid === state.activeAccountUuid)
    : null;
  heading.replaceChildren(document.createTextNode('Actions'));
  if (active) {
    heading.append(el('span', 'heading-for', active.label));
    heading.title = active.label;
  } else {
    heading.removeAttribute('title');
  }

  $('repairBtn').hidden = !state.activeAccountUuid;
  const unlink = $('unlinkBtn');
  unlink.hidden = !state.activeAccountUuid;
  unlink.disabled = n === 0;
  if (state.activeAccountUuid) {
    const acct = state.accounts.find((a) => a.accountUuid === state.activeAccountUuid);
    unlink.textContent = 'Remove';
    unlink.title = acct
      ? `Remove the selected sessions from ${acct.label}'s history. The transcripts on disk are not touched.`
      : 'Remove the selected sessions from this account.';
  }
}

/* -------------------------------------------------------------- detail */

/**
 * Every file behind a session, each with its own reveal button.
 *
 * A session usually has two kinds: the transcript on disk, and Claude
 * Desktop's record of it -- one record per account that lists it, so a session
 * shared by two accounts has two. Whichever exist are shown; a row with only
 * one still gets that one.
 */
function filesSection(s) {
  const sec = el('div', 'detail-section');
  sec.append(el('h4', null, 'Files'));

  const entry = (label, filePath, note) => {
    const folder = filePath.replace(/[\\/][^\\/]*$/, '');
    const row = el('div', 'file-row');
    // Label, then path, then the actions on their own line. Side by side they
    // overflow the detail pane the moment an account email is in the label.
    row.append(el('div', 'file-label', label));
    const actions = el('div', 'file-actions');

    // Always offered, not just after a failure: revealing can fail for
    // reasons this app cannot fix, and a path you can paste always works.
    const copy = el('button', 'btn btn-small', 'Copy folder');
    copy.title = folder;
    copy.addEventListener('click', async () => {
      try {
        await window.api.copyText(folder);
        const was = copy.textContent;
        copy.textContent = 'Copied';
        setTimeout(() => { if (copy.isConnected) copy.textContent = was; }, 1400);
      } catch (err) { toast('Could not copy', apiError(err).message, 'err'); }
    });
    actions.append(copy);

    const btn = el('button', 'btn btn-small', 'Show file');
    btn.title = filePath;
    btn.addEventListener('click', async () => {
      try { await window.api.reveal(filePath); }
      catch (err) {
        toast('Could not open the folder',
          apiError(err).message + ' Use Copy folder and paste it into Explorer.', 'err', 9000);
      }
    });
    actions.append(btn);

    // Selectable, so the full file path can be taken by hand as well.
    row.append(el('div', 'mono faint selectable', filePath));
    row.append(actions);
    if (note) row.append(el('div', 'why', note));
    sec.append(row);
  };

  if (s.filePath) entry('Transcript', s.filePath);

  // One record per account listing it. Named by account so two records for the
  // same session are told apart.
  const records = s.indexRecords && s.indexRecords.length
    ? s.indexRecords
    : (s.indexPath ? [{ indexPath: s.indexPath, accountUuid: state.activeAccountUuid }] : []);
  for (const r of records) {
    if (!r.indexPath) continue;
    const who = accountLabel(r.accountUuid);
    entry(who ? `History record · ${who}` : 'History record', r.indexPath,
      s.filePath ? null : 'Claude Desktop’s record for this session, not a transcript.');
  }

  if (!s.filePath && !records.length) {
    sec.append(el('div', 'why', 'No file on disk for this entry.'));
  }
  return sec;
}

async function selectDetail(uid) {
  state.focusedUid = uid;
  document.querySelectorAll('tr.focused').forEach((n) => n.classList.remove('focused'));
  const tr = document.querySelector(`tr[data-uid="${CSS.escape(uid)}"]`);
  if (tr) tr.classList.add('focused');

  // An account history row may not exist in the on-disk list at all.
  const s = (state.activeAccountUuid ? state.accountRows : state.sessions).find((x) => x.uid === uid)
    || state.sessions.find((x) => x.uid === uid);
  if (!s) return;

  const panel = $('detailBody');
  $('detailEmpty').hidden = true;
  panel.hidden = false;
  panel.replaceChildren();
  panel.append(el('h3', null, s.title || s.sessionId));

  for (const w of s.warnings || []) {
    panel.append(el('div', 'warn-box ' + (w.level === 'error' ? 'error' : w.level === 'warn' ? 'warn' : 'info'), w.message));
  }

  // Nothing on disk to open: show what the index knows and stop, rather than
  // asking the main process for a file that is not there.
  if (s.hasTranscript === false) {
    const facts = el('div', 'detail-rows');
    for (const [k, v] of [
      ['Session id', s.sessionId],
      ['Project', s.projectPath || '—'],
      ['Branch', s.gitBranch || '—'],
      ['Model', s.model || '—'],
      ['Created', fmtDate(s.createdAt)],
      ['Last active', fmtDate(s.updatedAt)],
    ]) {
      const row = el('div', 'detail-row');
      row.append(el('dt', null, k));
      row.append(el('dd', null, String(v)));
      facts.append(row);
    }
    panel.append(facts);

    // No transcript, but there is still a file: Claude Desktop's own record.
    panel.append(filesSection(s));

    const note = el('div', 'detail-section faint',
      'This entry comes from Claude Desktop’s index for the account. There is no transcript for it under this installation, so it cannot be opened, verified or exported.');
    panel.append(note);
    return;
  }

  const facts = el('div', 'detail-section');
  const rows = [
    ['Tool', toolLabel(s.sourceTool)],
    ['Session id', s.sessionId],
    ['Project', s.projectPath || s.projectDir || '—'],
    ['Model', s.model || '—'],
    ['Size', fmtBytes(s.sizeBytes)],
    ['Updated', s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '—'],
    ['Integrity', `${s.integrity} (${s.integrityScan === 'deep' ? 'full file' : 'header only'})`],
    ['Sub-agents', s.subAgentCount ? String(s.subAgentCount) : '—'],
    ['Owner', s.ownerAccountUuid ? accountLabel(s.ownerAccountUuid) : 'not recorded'],
  ];
  for (const [k, v] of rows) {
    const r = el('div', 'detail-row');
    r.append(el('dt', null, k));
    r.append(el('dd', null, v));
    facts.append(r);
  }
  panel.append(facts);

  panel.append(filesSection(s));

  const loading = el('div', 'detail-section faint', 'Loading transcript…');
  panel.append(loading);

  try {
    const full = await window.api.loadSession(uid, { messageLimit: 60 });
    loading.remove();

    const sum = el('div', 'detail-section');
    sum.append(el('h4', null, 'Content'));
    const c = full.summary.roleCounts;
    const sr = [
      ['Messages', String(full.totalMessages)],
      ['User', String(c.user)],
      ['Assistant', String(c.assistant)],
      ['Tool', String(c.tool)],
      ['Content hash', full.contentHash.slice(7, 23) + '…'],
    ];
    for (const [k, v] of sr) {
      const r = el('div', 'detail-row');
      r.append(el('dt', null, k));
      r.append(el('dd', 'mono', v));
      sum.append(r);
    }
    panel.append(sum);

    if (full.meta?.parseNotes?.length) {
      for (const note of full.meta.parseNotes) panel.append(el('div', 'warn-box warn', note));
    }

    const prev = el('div', 'detail-section');
    prev.append(el('h4', null, `Transcript preview (${Math.min(full.messages.length, 60)} of ${full.totalMessages})`));
    const box = el('div', 'msg-preview');
    for (const m of full.messages) {
      const mm = el('div', 'msg');
      const who = el('div', 'who ' + m.role, m.role + (m.toolName ? ` · ${m.toolName}` : '') + (m.type === 'thinking' ? ' · thinking' : ''));
      mm.append(who);
      if (m.text) mm.append(el('div', 'body', m.text.slice(0, 600)));
      box.append(mm);
    }
    prev.append(box);
    panel.append(prev);
  } catch (err) {
    loading.remove();
    panel.append(el('div', 'warn-box error', 'Could not load transcript: ' + apiError(err).message));
  }
}

/* ---------------------------------------------------------- plan render */

function planStats(summary) {
  const wrap = el('div', 'plan-summary');
  const defs = [
    ['write', 'To write', 'ok'],
    ['copy', 'To copy', 'ok'],
    ['skipIdentical', 'Already present', ''],
    ['alreadyEverywhere', 'In sync', ''],
    ['conflict', 'Conflicts', 'warn'],
    ['blocked', 'Blocked', 'err'],
  ];
  for (const [key, label, kind] of defs) {
    if (summary[key] === undefined) continue;
    const s = el('div', 'stat ' + kind);
    s.append(el('div', 'n', String(summary[key])));
    s.append(el('div', 'l', label));
    wrap.append(s);
  }
  return wrap;
}

/**
 * Render one plan action, including a resolution picker for conflicts.
 * `resolutions` is mutated in place as the user chooses.
 */
function actionRow(action, resolutions, keyFn) {
  const row = el('div', 'action-row');
  const head = el('div', 'head');
  const title = el('div', 'title', (action.title || action.sessionId));
  head.append(title);

  const kindBadge = {
    write: ['badge-ok', 'will write'],
    copy: ['badge-ok', 'will copy'],
    'skip-identical': ['badge-info', 'already present'],
    'already-everywhere': ['badge-info', 'in sync'],
    conflict: ['badge-warn', 'conflict'],
    blocked: ['badge-err', 'blocked'],
  }[action.kind] || ['badge-info', action.kind];
  head.append(el('span', 'badge ' + kindBadge[0], kindBadge[1]));
  row.append(head);

  if (action.reason) row.append(el('div', 'why', action.reason));

  if (action.destPath) row.append(el('div', 'paths-line', '→ ' + action.destPath));
  if (action.sourcePath) row.append(el('div', 'paths-line', '← ' + action.sourcePath));

  if (action.lossy?.length) {
    const ul = el('ul', 'lossy-list');
    for (const l of action.lossy) ul.append(el('li', null, `${l.field}: ${l.detail}`));
    row.append(el('div', 'why', 'Will not survive the conversion:'));
    row.append(ul);
  }

  if (action.kind === 'conflict') {
    if (action.diff) row.append(diffView(action.diff, action.comparison));

    const rec = action.recommendation;
    if (rec) {
      const r = el('div', 'why');
      r.append(el('span', 'rec-tag', 'Recommended: '));
      r.append(document.createTextNode(`${rec.resolution} — ${rec.reason}`));
      row.append(r);
    }

    const key = keyFn(action);
    const opts = [
      ['skip', 'Skip'],
      ['keep-both', 'Keep both'],
      ['keep-newer', 'Keep newer'],
      ['keep-incoming', 'Replace'],
      ['keep-existing', 'Keep existing'],
    ];
    const box = el('div', 'resolution');
    for (const [value, label] of opts) {
      const lab = el('label');
      const input = el('input');
      input.type = 'radio';
      input.name = 'res-' + key;
      input.value = value;
      if ((rec && rec.resolution === value) || (!rec && value === 'skip')) {
        input.checked = true;
        resolutions[key] = value;
        lab.classList.add('picked');
      }
      input.addEventListener('change', () => {
        resolutions[key] = value;
        box.querySelectorAll('label').forEach((l) => l.classList.remove('picked'));
        lab.classList.add('picked');
      });
      lab.append(input);
      lab.append(document.createTextNode(label));
      box.append(lab);
    }
    row.append(box);
  }

  return row;
}

function diffView(diff, cmp) {
  const wrap = el('div');
  const head = el('div', 'why',
    `Diverges at message ${diff.divergeIndex}. Local has ${cmp?.aLength ?? '?'} messages, incoming has ${cmp?.bLength ?? '?'}.`);
  wrap.append(head);

  if (diff.sharedContext?.length) {
    const shared = el('div', 'diff-shared');
    shared.append(el('h5', null, 'Last shared messages'));
    for (const m of diff.sharedContext) shared.append(miniMsg(m));
    wrap.append(shared);
  }

  const grid = el('div', 'diff-grid');
  const a = el('div', 'diff-col');
  a.append(el('h5', null, `On disk (${diff.aUpdatedAt ? fmtDate(diff.aUpdatedAt) : 'unknown date'})`));
  for (const m of diff.aNext || []) a.append(miniMsg(m));
  if (!diff.aNext?.length) a.append(el('div', 'faint', '(ends here)'));

  const b = el('div', 'diff-col');
  b.append(el('h5', null, `Incoming (${diff.bUpdatedAt ? fmtDate(diff.bUpdatedAt) : 'unknown date'})`));
  for (const m of diff.bNext || []) b.append(miniMsg(m));
  if (!diff.bNext?.length) b.append(el('div', 'faint', '(ends here)'));

  grid.append(a, b);
  wrap.append(grid);
  return wrap;
}

function miniMsg(m) {
  const d = el('div', 'msg');
  d.append(el('div', 'who ' + m.role, `#${m.index} ${m.role}${m.toolName ? ' · ' + m.toolName : ''}`));
  if (m.text) d.append(el('div', 'body', m.text.slice(0, 260)));
  return d;
}

/* -------------------------------------------------------------- actions */

function selectedUids() { return [...state.selected]; }

$('exportBtn').addEventListener('click', async () => {
  const uids = selectedUids();
  try {
    toast('Exporting', `${uids.length} session(s)`, 'ok', 2500);
    const res = await window.api.exportBundle(uids, {});
    if (res.canceled) return;
    toast('Export complete',
      `${res.sessionCount} session(s) → ${fmtBytes(res.bytes)}\n${res.path}`, 'ok', 9000);
    if (res.warnings?.length) {
      openModal('Export finished with warnings', (body) => {
        for (const w of res.warnings) body.append(el('div', 'warn-box ' + (w.level === 'error' ? 'error' : 'warn'), w.message));
      }, (foot) => {
        const b = el('button', 'btn', 'Close');
        b.addEventListener('click', closeModal);
        foot.append(b);
      });
    }
  } catch (err) {
    toast('Export failed', apiError(err).message, 'err', 9000);
  }
});

$('importBtn').addEventListener('click', async () => {
  try {
    const picked = await window.api.pickBundle();
    if (picked.canceled) return;
    await runImportFlow(picked.path);
  } catch (err) {
    toast('Import failed', apiError(err).message, 'err', 9000);
  }
});

async function runImportFlow(zipPath) {
  toast('Reading bundle', 'Comparing against what is already on disk…', 'ok', 3500);
  const plan = await window.api.planImport(zipPath, {});
  const resolutions = {};

  openModal('Import preview — nothing has been written yet', (body) => {
    body.append(el('div', 'warn-box info',
      'Dry run — nothing written yet. Anything left on Skip is untouched; replaced files are backed up.'));
    body.append(planStats(plan.summary));
    for (const a of plan.actions) body.append(actionRow(a, resolutions, (x) => x.sessionId));
  }, (foot) => {
    const cancel = el('button', 'btn', 'Cancel');
    cancel.addEventListener('click', closeModal);
    const apply = el('button', 'btn btn-primary', 'Apply plan');
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      apply.textContent = 'Applying…';
      try {
        const res = await window.api.executeImport(plan.token, resolutions);
        closeModal();
        showResults('Import results', res.results);
        await refresh();
      } catch (err) {
        apply.disabled = false;
        apply.textContent = 'Apply plan';
        toast('Import failed', apiError(err).message, 'err', 9000);
      }
    });
    foot.append(cancel, apply);
  });
}




/* ------------------------------------------- account history: migrate/sync */

/**
 * Render a previewed index-sync plan.
 *
 * The preview is the safety mechanism, so it leads with what will change and
 * states every reason something will not, rather than only listing successes.
 */
function renderIndexPlan(body, plan) {
  const s = plan.summary;

  if (plan.note) body.append(el('div', 'warn-box info', plan.note));

  const copiesAll = plan.actions.filter((a) => a.kind === 'copy');
  // Restoring clears the target's deletion marker, so the usual "nothing is
  // deleted" promise does not hold and must not be printed.
  const restores = copiesAll.filter((a) => a.wasTombstoned);

  const counts = el('div', 'warn-box ' + (s.copy ? 'info' : 'ok'),
    s.copy
      ? `${s.copy} record${s.copy === 1 ? '' : 's'} will be added${s.targets > 1 ? ` across ${s.targets} accounts` : ''}.` +
        (restores.length ? '' : ' Nothing is deleted or replaced.')
      : 'Nothing to add. Every account already lists these sessions.');
  body.append(counts);

  const tally = el('div', 'why', [
    `${s.copy} to add`,
    `${s.alreadyPresent} already there`,
    s.tombstoned ? `${s.tombstoned} deleted by the target` : null,
    s.blocked ? `${s.blocked} blocked` : null,
  ].filter(Boolean).join(' · '));
  body.append(tally);

  const copies = copiesAll;

  // A copy that undoes a deletion is not the same as a copy into an account
  // that simply never had it, and the preview must not blur the two.
  if (restores.length) {
    body.append(el('div', 'warn-box warn',
      restores.length === 1
        ? `${restores[0].targetAccount.label} had deleted this session. Adding it back undoes that deletion.`
        : `${restores.length} of these were deleted by the account receiving them. Adding them back undoes those deletions.`));
  }

  if (copies.length) {
    const list = el('div', 'plan-list');
    for (const a of copies) {
      const row = el('div', 'plan-row');
      row.append(el('div', 'truncate', a.title || a.cliSessionId || a.desktopSessionId));
      row.append(el('div', 'why',
        `${a.sourceAccount ? a.sourceAccount.label + ' → ' : ''}${a.targetAccount.label}` +
        (a.wasTombstoned ? ' · was deleted there' : '') +
        (a.projectPath ? ' · ' + a.projectPath : '')));
      row.title = a.destPath;
      list.append(row);
    }
    body.append(list);
  }

  // Every reason something is being left out, said once with its count.
  const reasons = new Map();
  for (const a of plan.actions) {
    if (a.kind === 'copy' || !a.reason) continue;   // copies speak for themselves
    if (a.kind === 'already-present' && copies.length) continue;  // already in the tally
    reasons.set(a.reason, (reasons.get(a.reason) || 0) + 1);
  }
  for (const [reason, n] of reasons) {
    body.append(el('div', 'warn-box ' + (/deleted|blocked|Cannot/.test(reason) ? 'warn' : 'info'),
      n > 1 ? `${n} × ${reason}` : reason));
  }
}

/** Apply a previewed plan and report what actually happened. */
async function applyIndexPlan(plan, onDone) {
  try {
    const res = await window.api.executeAccountSync(plan.token);
    const w = res.summary.written;
    closeModal();
    toast(w ? 'History updated' : 'Nothing to change',
      w
        ? `${w} record${w === 1 ? '' : 's'} added.` +
          (res.summary.failed ? ` ${res.summary.failed} failed.` : '') +
          ' Restart Claude Desktop to see them.'
        : 'Every account already had these sessions.',
      res.summary.failed ? 'warn' : 'ok', 9000);
    if (onDone) await onDone();
  } catch (err) {
    toast('Nothing was written', apiError(err).message, 'err', 11000);
  }
}

/** Preview screen shared by Migrate and Sync accounts. */
function openIndexPlanModal(title, plan, onDone) {
  openModal(title, (body) => renderIndexPlan(body, plan), (foot) => {
    const cancel = el('button', 'btn', 'Cancel');
    cancel.addEventListener('click', closeModal);
    foot.append(cancel);
    if (plan.summary.copy > 0) {
      const apply = el('button', 'btn btn-primary', `Add ${plan.summary.copy} record${plan.summary.copy === 1 ? '' : 's'}`);
      apply.addEventListener('click', () => applyIndexPlan(plan, onDone || refresh));
      foot.append(apply);
    }
  });
}

/**
 * Sync accounts: give every account the union of every account's history.
 *
 * Additive only -- an account keeps everything it already has.
 */
$('syncBtn').addEventListener('click', async () => {
  if (!state.accounts.length) {
    toast('No accounts found', 'No Claude Desktop account folders were found on this machine.', 'warn');
    return;
  }
  openModal('Sync accounts', (body) => body.append(el('div', 'why', 'Reading each account’s history…')));
  try {
    const plan = await window.api.planAccountSyncAll(null);
    openIndexPlanModal('Sync accounts', plan);
  } catch (err) {
    closeModal();
    toast('Could not read the accounts', apiError(err).message, 'err', 11000);
  }
});

/**
 * Migrate: copy the selected sessions' history records into one account.
 *
 * The account is chosen first, then previewed -- the preview cannot be skipped,
 * because it is the only place the target and the count are confirmed.
 */
$('migrateBtn').addEventListener('click', async () => {
  const uids = new Set(selectedUids());
  const rows = (state.activeAccountUuid ? state.accountRows : state.sessions).filter((x) => uids.has(x.uid));
  const cliSessionIds = [...new Set(rows.map((r) => r.sessionId).filter(Boolean))];

  if (!cliSessionIds.length) {
    toast('Nothing selected', 'Select the sessions you want to migrate first.', 'warn');
    return;
  }
  if (!state.accounts.length) {
    toast('No accounts found', 'No Claude Desktop account folders were found on this machine.', 'warn');
    return;
  }

  openModal(`Migrate ${cliSessionIds.length} session${cliSessionIds.length === 1 ? '' : 's'}`, (body) => {
    body.append(el('div', 'warn-box info',
      'Choose the account to add these sessions to. Nothing is removed from any account, and you will see exactly what changes before anything is written.'));

    for (const a of state.accounts) {
      const row = el('div', 'action-row');
      const head = el('div', 'head');
      head.append(el('div', 'title', a.label));
      if (a.isCurrent) head.append(el('span', 'badge badge-ok', 'signed in'));
      if (a.ambiguous) head.append(el('span', 'badge badge-warn', 'folder unclear'));

      const go = el('button', 'btn btn-small btn-primary', 'Migrate');
      go.disabled = !!a.ambiguous;
      go.title = a.ambiguous
        ? a.reason
        : `Add the selected sessions to ${a.label}`;
      go.addEventListener('click', async () => {
        go.disabled = true;
        go.textContent = 'Checking…';
        try {
          const plan = await window.api.planAccountMigrate(cliSessionIds, a.accountUuid);
          openIndexPlanModal(`Migrate to ${a.label}`, plan);
        } catch (err) {
          const e = apiError(err);
          toast(e.code === 'HISTORY_ORG_UNRESOLVED' ? 'Cannot identify the history folder' : 'Could not plan the migration',
            e.message, 'warn', 11000);
          go.disabled = false;
          go.textContent = 'Migrate';
        }
      });
      head.append(go);
      row.append(head);
      row.append(el('div', 'why', `${a.sessionCount} in history`));
      if (a.ambiguous) row.append(el('div', 'warn-box warn', a.reason));
      body.append(row);
    }
  }, (foot) => {
    const b = el('button', 'btn', 'Cancel');
    b.addEventListener('click', closeModal);
    foot.append(b);
  });
});

/**
 * Remove the selected sessions from the account currently being shown.
 *
 * Unlinks rather than deletes: the record that puts the session in this
 * account's sidebar goes, the transcript on disk stays. Previewed first, and
 * every removed record is backed up before it goes.
 */
/**
 * Find and relink index records that lost their transcript id.
 *
 * The dialog IS the preview: every row states which transcript would be
 * written into which record and why, so Fix has nothing hidden behind it. A
 * record with no confident match is listed with its reason and no button --
 * pointing it at the wrong conversation would look fixed, which is worse than
 * leaving it broken.
 */
$('repairBtn').addEventListener('click', async () => {
  const accountUuid = state.activeAccountUuid;
  if (!accountUuid) return;
  openModal('Checking', (body) => body.append(el('div', 'why', 'Reading transcripts…')));
  try {
    const scan = await window.api.scanBrokenRecords(accountUuid);
    renderRepairDialog(scan, accountUuid);
  } catch (err) {
    closeModal();
    toast('Could not check', apiError(err).message, 'err', 9000);
  }
});

/**
 * The broken records for one account.
 *
 * Deliberately terse: one line per entry. Everything that would explain a row
 * -- why it matched, which file, where it lives -- is in the tooltip, so the
 * list stays scannable when there are dozens.
 */
function renderRepairDialog(scan, accountUuid) {
  const fixable = scan.broken.filter((b) => b.best);

  // Only what can actually be acted on. An entry with no transcript to link
  // to is a row you cannot use; the count is still reported so nothing is
  // quietly dropped.
  const hidden = scan.broken.length - fixable.length;

  openModal('Scan & Repair', (body) => {
    if (!scan.broken.length) {
      body.append(el('div', 'warn-box ok', 'Every entry is linked to its transcript.'));
      return;
    }
    if (!fixable.length) {
      body.append(el('div', 'warn-box info',
        `Nothing can be relinked. ${hidden} entr${hidden === 1 ? 'y has' : 'ies have'} no transcript on disk.`));
      return;
    }
    body.append(el('div', 'why',
      `${fixable.length} can be relinked` + (hidden ? ` · ${hidden} with no match` : '')));

    const list = el('div', 'plan-list');
    for (const b of fixable) {
      const row = el('div', 'plan-row repair-row');

      const line = el('div', 'file-head');
      const name = el('div', 'truncate', b.title || '(untitled)');
      name.title = [b.title, b.cwd, b.reason].filter(Boolean).join('\n');
      line.append(name);

      const right = el('div', 'file-actions');
      const many = b.confidence !== 'strong';
      const badge = el('span', 'badge ' + (many ? 'badge-warn' : 'badge-ok'),
        many ? `${b.candidates.length} found` : 'match');
      badge.title = b.reason;
      right.append(badge);

      const fix = el('button', 'btn btn-small btn-primary', 'Fix');
      fix.title = b.best.filePath;
      fix.addEventListener('click', () => applyRepair([b.indexPath], accountUuid, fix));
      right.append(fix);
      line.append(right);
      row.append(line);

      const f = el('div', 'mono faint truncate', b.best.sessionId);
      f.title = b.best.filePath;
      row.append(f);
      list.append(row);
    }
    body.append(list);
  }, (foot) => {
    const close = el('button', 'btn', 'Close');
    close.addEventListener('click', closeModal);
    foot.append(close);
    if (fixable.length) {
      const all = el('button', 'btn btn-primary', `Fix all ${fixable.length}`);
      all.title = `Relink ${fixable.length} entr${fixable.length === 1 ? 'y' : 'ies'}`;
      all.addEventListener('click', () => applyRepair(fixable.map((b) => b.indexPath), accountUuid, all));
      foot.append(all);
    }
  });
}

/** Plan and apply, then re-check so the list reflects what is left. */
async function applyRepair(indexPaths, accountUuid, button) {
  const label = button ? button.textContent : null;
  if (button) { button.disabled = true; button.textContent = '…'; }
  try {
    const plan = await window.api.planRecordRepair(indexPaths, accountUuid);
    if (!plan.summary.repair) {
      toast('Nothing to write', 'Those entries no longer have a match.', 'warn', 7000);
    } else {
      const res = await window.api.executeRecordRepair(plan.token);
      const n = res.summary.repaired;
      toast(n ? 'Relinked' : 'Nothing was written',
        n ? `${n} relinked. Restart Claude Desktop to see them.` : 'The records changed since the check.',
        res.summary.failed ? 'warn' : 'ok', 8000);
    }
    closeModal();
    await refresh();
    if (state.activeAccountUuid) await showAccountHistory(state.activeAccountUuid, { silent: true });
    const again = await window.api.scanBrokenRecords(accountUuid);
    if (again.broken.some((b) => b.best)) renderRepairDialog(again, accountUuid);
  } catch (err) {
    toast('Nothing was written', apiError(err).message, 'err', 10000);
    if (button) { button.disabled = false; button.textContent = label; }
  }
}

$('unlinkBtn').addEventListener('click', async () => {
  const accountUuid = state.activeAccountUuid;
  if (!accountUuid) return;
  const acct = state.accounts.find((a) => a.accountUuid === accountUuid);
  const uids = new Set(selectedUids());
  const cliSessionIds = [...new Set(
    state.accountRows.filter((r) => uids.has(r.uid)).map((r) => r.sessionId).filter(Boolean))];

  if (!cliSessionIds.length) {
    toast('Nothing selected', 'Select the sessions you want removed from this account.', 'warn');
    return;
  }

  try {
    const plan = await window.api.planAccountUnlink(cliSessionIds, accountUuid);
    const n = plan.summary.remove;
    openModal(`Remove from ${acct ? acct.label : 'this account'}`, (body) => {
      body.append(el('div', 'warn-box ' + (n ? 'warn' : 'ok'),
        n
          ? `${n} session${n === 1 ? '' : 's'} will stop appearing in this account. The transcript files on disk are not touched, and every removed record is backed up first.`
          : 'Nothing to remove. This account does not list the selected sessions.'));

      const removals = plan.actions.filter((a) => a.kind === 'remove');
      if (removals.length) {
        const list = el('div', 'plan-list');
        for (const a of removals) {
          const row = el('div', 'plan-row');
          row.append(el('div', 'truncate', a.title || a.cliSessionId));
          row.append(el('div', 'why', a.alsoIn && a.alsoIn.length
            ? 'Still listed by ' + a.alsoIn.join(', ')
            : 'This is the only account listing it — after this, no account will.'));
          list.append(row);
        }
        body.append(list);
        if (removals.some((a) => !a.alsoIn || !a.alsoIn.length)) {
          body.append(el('div', 'warn-box warn',
            'Some of these are listed by no other account. Their transcripts stay on disk, but no account will show them.'));
        }
      }
      const misses = plan.actions.filter((a) => a.kind === 'not-present').length;
      if (misses) body.append(el('div', 'why', `${misses} were not listed by this account anyway.`));
    }, (foot) => {
      const cancel = el('button', 'btn', 'Cancel');
      cancel.addEventListener('click', closeModal);
      foot.append(cancel);
      if (n > 0) {
        const go = el('button', 'btn btn-danger', `Remove ${n}`);
        go.addEventListener('click', async () => {
          try {
            const res = await window.api.executeAccountSync(plan.token);
            closeModal();
            toast('Removed from the account',
              `${res.summary.removed} record${res.summary.removed === 1 ? '' : 's'} removed. Backups kept.` +
              ' Restart Claude Desktop to see the change.',
              res.summary.failed ? 'warn' : 'ok', 9000);
            await refresh();
            if (state.activeAccountUuid) await showAccountHistory(state.activeAccountUuid, { silent: true });
          } catch (err) {
            toast('Nothing was removed', apiError(err).message, 'err', 11000);
          }
        });
        foot.append(go);
      }
    });
  } catch (err) {
    const e = apiError(err);
    toast(e.code === 'HISTORY_ORG_UNRESOLVED' ? 'Cannot identify the history folder' : 'Could not plan the removal',
      e.message, 'warn', 11000);
  }
});

$('verifyBtn').addEventListener('click', async () => {
  const uids = selectedUids();
  openModal('Deep verification', (body) => {
    body.append(el('div', 'warn-box info',
      'Streaming each file end to end. List badges are a header-only check; this one gates writes.'));
    const out = el('div');
    body.append(out);
    (async () => {
      let bad = 0;
      for (const uid of uids) {
        const s = state.sessions.find((x) => x.uid === uid);
        const line = el('div', 'action-row');
        line.append(el('div', 'title', s?.title || s?.sessionId || uid));
        out.append(line);
        try {
          const v = await window.api.verifySession(uid);
          const head = el('div', 'head');
          const badge = v.integrity === 'ok'
            ? el('span', 'badge badge-ok', 'clean')
            : el('span', 'badge ' + (v.integrity === 'truncated' ? 'badge-warn' : 'badge-err'), v.integrity);
          head.append(el('div', 'title', ''), badge);
          line.append(head);
          line.append(el('div', 'why',
            `${v.parsedRows} rows parsed of ${v.totalLines} lines · ${fmtBytes(v.sizeBytes)} · ${v.errorCount} unparseable`));
          if (v.errorCount) {
            bad++;
            for (const e of v.errors.slice(0, 3)) {
              line.append(el('div', 'paths-line', `line ${e.line} (byte ${e.offset}): ${e.message}`));
            }
          }
          // Reflect the deeper result back into the list.
          if (s) { s.integrity = v.integrity; s.integrityScan = 'deep'; s.warnings = v.warnings; }
        } catch (err) {
          line.append(el('div', 'warn-box error', apiError(err).message));
        }
      }
      renderTable();
      out.append(el('div', 'why', bad ? `${bad} file(s) have unparseable content.` : 'All selected files parsed cleanly.'));
    })();
  }, (foot) => {
    const b = el('button', 'btn', 'Close');
    b.addEventListener('click', closeModal);
    foot.append(b);
  });
});

$('auditBtn').addEventListener('click', async () => {
  try {
    const entries = await window.api.readAudit(300);
    openModal('Audit log', (body) => {
      body.append(el('div', 'warn-box info', 'Every write, newest first, with where the replaced bytes went.'));
      if (!entries.length) body.append(el('p', 'faint', 'No actions recorded yet.'));
      for (const e of entries) {
        const d = el('div', 'audit-entry');
        d.append(el('div', 'when', e.at || '—'));
        const parts = [e.action, e.sessionId ? shortId(e.sessionId) : null, e.outcome].filter(Boolean).join(' · ');
        d.append(el('div', null, parts));
        if (e.destPath) d.append(el('div', 'paths-line', '→ ' + e.destPath));
        if (e.backupPath) d.append(el('div', 'paths-line', 'backup: ' + e.backupPath));
        if (e.error) d.append(el('div', 'why', 'error: ' + e.error));
        body.append(d);
      }
    }, (foot) => {
      const b = el('button', 'btn', 'Close');
      b.addEventListener('click', closeModal);
      foot.append(b);
    });
  } catch (err) {
    toast('Could not read audit log', apiError(err).message, 'err');
  }
});

function showResults(title, results) {
  openModal(title, (body) => {
    const counts = {};
    for (const r of results) counts[r.applied] = (counts[r.applied] || 0) + 1;
    const wrap = el('div', 'plan-summary');
    for (const [k, v] of Object.entries(counts)) {
      const s = el('div', 'stat ' + (k === 'failed' ? 'err' : k.startsWith('skipped') ? '' : 'ok'));
      s.append(el('div', 'n', String(v)));
      s.append(el('div', 'l', k.replace(/-/g, ' ')));
      wrap.append(s);
    }
    body.append(wrap);
    for (const r of results) {
      const row = el('div', 'action-row');
      const head = el('div', 'head');
      head.append(el('div', 'title', shortId(r.sessionId)));
      head.append(el('span', 'badge ' + (r.applied === 'failed' ? 'badge-err' : 'badge-info'), r.applied));
      row.append(head);
      if (r.destPath) row.append(el('div', 'paths-line', '→ ' + r.destPath));
      if (r.backupPath) row.append(el('div', 'paths-line', 'previous version backed up: ' + r.backupPath));
      if (r.error) row.append(el('div', 'why', r.error));
      if (r.lossy?.length) {
        const ul = el('ul', 'lossy-list');
        for (const l of r.lossy) ul.append(el('li', null, `${l.field}: ${l.detail}`));
        row.append(ul);
      }
      body.append(row);
    }
  }, (foot) => {
    const b = el('button', 'btn btn-primary', 'Done');
    b.addEventListener('click', closeModal);
    foot.append(b);
  });
}

/* --------------------------------------------------------------- wiring */

$('refreshBtn').addEventListener('click', refresh);
$('searchInput').addEventListener('input', (e) => {
  state.search = e.target.value;
  if (state.comparing) renderComparison(); else renderTable();
});
$('onlyWarnings').addEventListener('change', (e) => { state.onlyWarnings = e.target.checked; renderTable(); });
$('groupToggle').addEventListener('change', (e) => {
  state.groupBy = e.target.checked ? 'project' : 'none';
  renderTable();
});
$('collapseAllBtn').addEventListener('click', toggleAllGroups);
$('notSyncedOnly').addEventListener('change', (e) => {
  state.compareOnlyDiffs = e.target.checked;
  if (state.comparing) renderComparison();
});

// Sorting is driven from the header cells. The resize grips inside them stop
// their own clicks, so a drag never registers as a sort.
for (const th of document.querySelectorAll('table.sessions thead th.sortable')) {
  th.addEventListener('click', () => setSort(th.dataset.sort));
}

$('selectAllBtn').addEventListener('click', () => {
  for (const s of selectableSessions()) state.selected.add(s.uid);
  renderTable();
});
$('clearSelBtn').addEventListener('click', () => { state.selected.clear(); renderTable(); });
$('headCheck').addEventListener('change', (e) => {
  if (e.target.checked) for (const s of selectableSessions()) state.selected.add(s.uid);
  else state.selected.clear();
  renderTable();
});

$('resetLayout').addEventListener('click', resetLayout);

/**
 * Support the project.
 *
 * Deliberately a quiet link in the footer rather than a banner: this asks for
 * something, and anything that asks should be easy to ignore. Every link is
 * shown in full and can be copied, because opening a browser can fail and a
 * link you cannot read is one you cannot trust.
 */
$('supportBtn').addEventListener('click', async () => {
  let links;
  try { links = await window.api.support(); }
  catch (err) { toast('Could not load the links', apiError(err).message, 'err'); return; }

  // Straight to the funding page: one click, no dialog in the way.
  if (links.sponsorUrl) {
    try {
      await window.api.openExternal(links.sponsorUrl);
      return;
    } catch (err) {
      // A button that appears to do nothing is worse than a dialog, so fall
      // back to showing the link where it can be read and copied.
      toast('Could not open your browser',
        apiError(err).message + ' The link is below.', 'warn', 8000);
    }
  }

  openSupportDialog(links);
});

/**
 * The links, shown rather than opened.
 *
 * Reached when the browser could not be launched, and it is also where the
 * repository and issue tracker live -- worth having, but not worth putting in
 * front of someone who clicked a donate button.
 */
function openSupportDialog(links) {
  openModal('Support this project', (body) => {
    body.append(el('div', 'warn-box info',
      'Claude Code Recovery is free and open source. If it has saved you some history, a contribution helps keep it maintained.'));

    const linkRow = (label, url, note) => {
      if (!url) return;
      const row = el('div', 'file-row');
      row.append(el('div', 'file-label', label));
      row.append(el('div', 'mono faint selectable', url));
      if (note) row.append(el('div', 'why', note));

      const actions = el('div', 'file-actions');
      const copy = el('button', 'btn btn-small', 'Copy link');
      copy.addEventListener('click', async () => {
        try {
          await window.api.copyText(url);
          const was = copy.textContent;
          copy.textContent = 'Copied';
          setTimeout(() => { if (copy.isConnected) copy.textContent = was; }, 1400);
        } catch (err) { toast('Could not copy', apiError(err).message, 'err'); }
      });
      actions.append(copy);

      const open = el('button', 'btn btn-small btn-primary', 'Open');
      open.addEventListener('click', async () => {
        try { await window.api.openExternal(url); }
        catch (err) {
          toast('Could not open the link',
            apiError(err).message + ' Use Copy link and paste it into your browser.', 'err', 9000);
        }
      });
      actions.append(open);
      row.append(actions);
      body.append(row);
    };

    linkRow(links.sponsorLabel || 'Sponsor', links.sponsorUrl,
      'Opens in your browser. Nothing is loaded into this app.');
    linkRow('Source code', links.repoUrl, 'Stars and pull requests help as much as money.');
    linkRow('Report a problem', links.issuesUrl);

    body.append(el('div', 'why',
      `Version ${links.version}${links.license ? ' · ' + links.license + ' licensed' : ''}. ` +
      'Nothing is sent anywhere: opening a link hands it to your browser and nothing else.'));
  }, (foot) => {
    const b = el('button', 'btn', 'Close');
    b.addEventListener('click', closeModal);
    foot.append(b);
  });
}

$('revealBackups').addEventListener('click', async () => {
  try {
    const p = await window.api.appPaths();
    await window.api.reveal(p.backupsDir);
  } catch (err) {
    toast('No backups yet', apiError(err).message, 'warn');
  }
});

/**
 * Scan progress.
 *
 * The first scan of a large installation takes a second or two, and a static
 * "Scanning…" with nothing moving reads as a hang.
 */
function showScanProgress(done, total) {
  const bar = $('scanBar');
  bar.hidden = false;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  bar.firstElementChild.style.width = pct + '%';
}
function hideScanProgress() {
  const bar = $('scanBar');
  bar.hidden = true;
  bar.firstElementChild.style.width = '0%';
}

window.api.onProgress('progress:scan', (p) => {
  $('scanSummary').textContent = `Reading sessions · ${p.done} of ${p.total}`;
  showScanProgress(p.done, p.total);
});
window.api.onProgress('progress:export', (p) => {
  $('scanSummary').textContent = `Exporting ${p.done}/${p.total}`;
});
window.api.onProgress('progress:sync', (p) => {
  $('scanSummary').textContent = `Reading ${p.done}/${p.total}`;
});

$('updateBtn').addEventListener('click', openUpdateDialog);

window.api.onProgress('update:state', (s) => {
  paintUpdate(s);
  if (updateDialogRefresh) updateDialogRefresh(s);
});

/**
 * Restore the saved layout before the first paint, so the panes and columns do
 * not visibly jump from defaults to the user's sizes.
 */
async function initLayout() {
  try {
    const saved = await window.api.getSettings();
    if (saved && saved.layout) {
      state.layout = {
        sidebarWidth: saved.layout.sidebarWidth ?? PANE_DEFAULTS.sidebarWidth,
        detailWidth: saved.layout.detailWidth ?? PANE_DEFAULTS.detailWidth,
        columnWidths: saved.layout.columnWidths ?? null,
      };
    }
  } catch { /* defaults are fine */ }
  applyPaneWidths();
  applyColumnWidths();
}

/**
 * Keep the columns filling the pane as anything around them changes size.
 *
 * Coalesced on a timer rather than an animation frame. requestAnimationFrame
 * does not run while the window is occluded or minimised, so a resize that
 * happens off-screen would never be applied and the table would come back
 * still sized for the old window.
 */
let columnFitTimer = null;
function scheduleColumnFit() {
  if (columnFitTimer) return;
  columnFitTimer = setTimeout(() => {
    columnFitTimer = null;
    applyColumnWidths();
  }, 32);
}
window.addEventListener('resize', scheduleColumnFit);

// The window is only one of the things that changes the width the columns
// have. Dragging either pane divider, opening the detail panel and a
// scrollbar appearing all resize the container without resizing the window.
if (typeof ResizeObserver === 'function') {
  const wrap = document.querySelector('.table-wrap');
  if (wrap) new ResizeObserver(scheduleColumnFit).observe(wrap);
}

/**
 * Who made it, in the corner where the other quiet links live.
 *
 * Filled from the app's own metadata rather than written into the markup:
 * a fork changes one field in package.json and stops advertising someone
 * else. Hidden entirely when there is no maker to name.
 */
async function initVendor() {
  const btn = $('vendorLink');
  if (!btn) return;
  let links;
  try { links = await window.api.support(); } catch { return; }
  if (!links || !links.vendorName || !links.vendorUrl) return;

  btn.textContent = links.vendorName.replace(/\s+LLC$/, '');
  btn.title = `${links.vendorName} — ${links.vendorUrl}`;
  btn.hidden = false;
  btn.addEventListener('click', async () => {
    try { await window.api.openExternal(links.vendorUrl); }
    catch (err) { toast('Could not open the link', apiError(err).message, 'err'); }
  });
}

markPlatform();
initPaneResizers();
initColumnResizers();
initTitleBar();
initVendor();
initLayout().then(refresh);
window.api.updateState().then(paintUpdate).catch(() => {});
