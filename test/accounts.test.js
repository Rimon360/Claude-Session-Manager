'use strict';
/**
 * Which account is signed in.
 *
 * Claude Desktop and the Claude Code CLI sign in separately and keep separate
 * config files. Reading only `~/.claude.json` -- the CLI's -- meant that after
 * switching account in Claude Desktop the app kept labelling the account the
 * user had just left as the signed-in one, and left the account they had
 * actually switched to showing as a bare uuid.
 *
 * These tests pin the two apart: the answer comes from Claude Desktop's own
 * record, the CLI's account is reported as its own separate fact, and neither
 * is inferred from the other.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

const OLD_ACCT = '87aa75af-1111-2222-3333-444444444444';
const NEW_ACCT = '9bf6f8c4-1111-2222-3333-444444444444';
const OLD_ORG = 'aaaaaaaa-1111-2222-3333-444444444444';
const NEW_ORG = 'bbbbbbbb-1111-2222-3333-444444444444';

function savedEnv() {
  return {
    home: process.env.AISM_HOME_OVERRIDE,
    data: process.env.AISM_DATA_OVERRIDE,
    appdata: process.env.APPDATA,
    localappdata: process.env.LOCALAPPDATA,
    roots: process.env.AISM_CLAUDE_DESKTOP_ROOTS,
  };
}
function restoreEnv(prev) {
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('AISM_HOME_OVERRIDE', prev.home);
  set('AISM_DATA_OVERRIDE', prev.data);
  set('APPDATA', prev.appdata);
  set('LOCALAPPDATA', prev.localappdata);
  set('AISM_CLAUDE_DESKTOP_ROOTS', prev.roots);
}
function isolate(base) {
  process.env.AISM_HOME_OVERRIDE = base;
  process.env.AISM_DATA_OVERRIDE = path.join(base, 'appdata');
  process.env.APPDATA = path.join(base, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(base, 'AppData', 'Local');
  delete process.env.AISM_CLAUDE_DESKTOP_ROOTS;
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
  return desktopRoot(base);
}

const desktopRoot = (base) => path.join(base, 'AppData', 'Roaming', 'Claude');
const write = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body, null, 1));
  return file;
};

/** `~/.claude.json` -- the Claude Code CLI's idea of who is signed in. */
function cliConfig(base, accountUuid, org, email) {
  return write(path.join(base, '.claude.json'), {
    machineID: 'm1',
    oauthAccount: {
      accountUuid, organizationUuid: org, emailAddress: email,
      displayName: email.split('@')[0], organizationName: email + "'s Organization",
      organizationType: 'claude_max',
    },
  });
}

/** Claude Desktop's own record of the account it is using. */
function desktopCurrent(root, accountUuid, options = {}) {
  const { via = 'cowork' } = options;
  if (via === 'cowork') return write(path.join(root, 'cowork-enabled-cli-ops.json'), { ownerAccountId: accountUuid });
  return write(path.join(root, 'config.json'), [
    '{',
    '\t"locale": "en-US",',
    '\t"oauth:tokenCache": "<opaque>",',
    `\t"lastKnownAccountUuid": "${accountUuid}",`,
    '\t"windowSizeWasSignedIn": true',
    '}',
  ].join('\n'));
}

/** The Claude Code config Claude Desktop writes inside an agent-mode sandbox. */
function sandboxConfig(root, folderAcct, folderOrg, identity) {
  return write(
    path.join(root, 'local-agent-mode-sessions', folderAcct, folderOrg, 'local_s1', '.claude', '.claude.json'),
    {
      machineID: 'm1',
      oauthAccount: {
        accountUuid: identity.accountUuid ?? folderAcct,
        organizationUuid: identity.organizationUuid ?? folderOrg,
        emailAddress: identity.email,
        displayName: identity.displayName ?? null,
        organizationName: identity.email + "'s Organization",
        organizationType: 'claude_max',
      },
    },
  );
}

/** `claude-code-sessions/<account>/<org>/` holding N index records. */
function orgFolder(root, accountUuid, org, count) {
  const dir = path.join(root, 'claude-code-sessions', accountUuid, org);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    write(path.join(dir, `local_s${org.slice(0, 4)}${i}.json`), {
      sessionId: `local_s${org.slice(0, 4)}${i}`,
      cliSessionId: `cli-${org.slice(0, 4)}-${i}`,
      title: `Session ${i}`, cwd: 'F:\\demo', originCwd: 'F:\\demo',
      createdAt: 1785307143603, lastActivityAt: 1785307720266,
    });
  }
  return dir;
}

const accountsMod = () => require('../src/core/accounts');

describe('accounts: who is signed in', () => {
  const dirs = [];
  afterAll(() => { for (const d of dirs) H.rmrf(d); });

  it('asks Claude Desktop, not the Claude Code CLI', () => {
    const prev = savedEnv();
    const base = H.tmpDir('who-desktop'); dirs.push(base);
    const root = isolate(base);
    cliConfig(base, OLD_ACCT, OLD_ORG, 'old@example.com');
    desktopCurrent(root, NEW_ACCT);
    const accounts = accountsMod();

    assert.equal(accounts.readSignedInAccount().accountUuid, OLD_ACCT, 'the CLI still names the old one');
    const desktop = accounts.readDesktopAccount([{ root }]);
    assert.equal(desktop.accountUuid, NEW_ACCT, 'and Desktop names the one actually in use');
    assert.equal(desktop.source, 'cowork-enabled-cli-ops.json');
    restoreEnv(prev);
  });

  it('falls back to the line in Claude Desktop\'s config', () => {
    const prev = savedEnv();
    const base = H.tmpDir('who-config'); dirs.push(base);
    const root = isolate(base);
    desktopCurrent(root, NEW_ACCT, { via: 'config' });
    const accounts = accountsMod();

    const desktop = accounts.readDesktopAccount([{ root }]);
    assert.equal(desktop.accountUuid, NEW_ACCT);
    assert.equal(desktop.source, 'config.json');
    restoreEnv(prev);
  });

  it('never parses that config, because it holds the token cache', () => {
    // The account id is taken a line at a time. Proving that means handing it a
    // file no JSON parser would accept and still getting the id back -- if the
    // implementation ever reaches for JSON.parse, this fails.
    const prev = savedEnv();
    const base = H.tmpDir('who-nojson'); dirs.push(base);
    const root = isolate(base);
    const file = write(path.join(root, 'config.json'), [
      '{',
      '\t"oauth:tokenCache": "truncated mid-value',
      `\t"lastKnownAccountUuid": "${NEW_ACCT}",`,
    ].join('\n'));
    const accounts = accountsMod();

    let parsed = true;
    try { JSON.parse(fs.readFileSync(file, 'utf8')); } catch { parsed = false; }
    assert.equal(parsed, false, 'the fixture must actually be unparseable, or it proves nothing');
    assert.equal(accounts.readDesktopAccount([{ root }]).accountUuid, NEW_ACCT);
    restoreEnv(prev);
  });

  it('says nothing when Claude Desktop has recorded nothing', () => {
    const prev = savedEnv();
    const base = H.tmpDir('who-silent'); dirs.push(base);
    const root = isolate(base);
    fs.mkdirSync(root, { recursive: true });
    const accounts = accountsMod();

    assert.equal(accounts.readDesktopAccount([{ root }]), null, 'silence, not a guess');
    // And with nothing said, the CLI's answer is the only one there is.
    cliConfig(base, OLD_ACCT, OLD_ORG, 'old@example.com');
    const who = accounts.describeAccount(OLD_ACCT, { currentAccountUuid: null });
    assert.equal(who.isCurrent, true);
    restoreEnv(prev);
  });

  it('marks the account Desktop switched to, not the one the CLI still holds', async () => {
    // The reported bug, end to end.
    const prev = savedEnv();
    const base = H.tmpDir('who-switch'); dirs.push(base);
    const root = isolate(base);
    orgFolder(root, OLD_ACCT, OLD_ORG, 3);
    orgFolder(root, NEW_ACCT, NEW_ORG, 3);
    cliConfig(base, OLD_ACCT, OLD_ORG, 'old@example.com');
    sandboxConfig(root, NEW_ACCT, NEW_ORG, { email: 'new@example.com', displayName: 'New' });
    desktopCurrent(root, NEW_ACCT);
    const discovery = require('../src/core/discovery');

    const list = await discovery.listDesktopAccounts([]);
    const byId = Object.fromEntries(list.map((a) => [a.accountUuid, a]));

    assert.equal(byId[NEW_ACCT].isCurrent, true, 'the account Desktop is using is the signed-in one');
    assert.equal(byId[OLD_ACCT].isCurrent, false, 'the one the CLI still names is not');
    assert.equal(byId[OLD_ACCT].isCliCurrent, true, 'but that fact is still reported, separately');
    assert.equal(byId[NEW_ACCT].isCliCurrent, false);
    assert.equal(list[0].accountUuid, NEW_ACCT, 'and it sorts first');
    restoreEnv(prev);
  });

  it('names an account that was never signed in to the CLI', async () => {
    const prev = savedEnv();
    const base = H.tmpDir('who-name'); dirs.push(base);
    const root = isolate(base);
    orgFolder(root, NEW_ACCT, NEW_ORG, 2);
    sandboxConfig(root, NEW_ACCT, NEW_ORG, { email: 'new@example.com', displayName: 'New' });
    desktopCurrent(root, NEW_ACCT);
    const discovery = require('../src/core/discovery');

    const list = await discovery.listDesktopAccounts([]);
    assert.equal(list[0].label, 'new@example.com', 'a bare uuid was never the only option');
    assert.equal(list[0].named, true);
    restoreEnv(prev);
  });

  it('ignores a config that disagrees with the folder it sits in', () => {
    // The path already states whose sandbox this is. A config inside it
    // claiming to be a different account is not evidence about either.
    const prev = savedEnv();
    const base = H.tmpDir('who-spoof'); dirs.push(base);
    const root = isolate(base);
    sandboxConfig(root, NEW_ACCT, NEW_ORG, { accountUuid: OLD_ACCT, email: 'wrong@example.com' });
    const accounts = accountsMod();

    const found = accounts.harvestDesktopIdentities([{ root }]);
    assert.equal(found.size, 0, 'neither account is named from a file that contradicts itself');
    restoreEnv(prev);
  });

  it('remembers a harvested name after the folder it came from is gone', () => {
    const prev = savedEnv();
    const base = H.tmpDir('who-remember'); dirs.push(base);
    const root = isolate(base);
    const file = sandboxConfig(root, NEW_ACCT, NEW_ORG, { email: 'new@example.com', displayName: 'New' });
    const accounts = accountsMod();

    accounts.learnIdentities(accounts.harvestDesktopIdentities([{ root }]));
    H.rmrf(path.join(root, 'local-agent-mode-sessions'));
    assert.equal(fs.existsSync(file), false, 'the sandbox is really gone');

    assert.equal(accounts.describeAccount(NEW_ACCT).label, 'new@example.com');
    assert.equal(accounts.describeAccount(NEW_ACCT).labelSource, 'learned');
    restoreEnv(prev);
  });

  it('never replaces a name it already has with a nameless record', () => {
    const prev = savedEnv();
    const base = H.tmpDir('who-downgrade'); dirs.push(base);
    isolate(base);
    const accounts = accountsMod();

    accounts.learnIdentities(new Map([[NEW_ACCT, { email: 'new@example.com', displayName: 'New' }]]));
    accounts.learnIdentities(new Map([[NEW_ACCT, { email: null, displayName: null }]]));
    assert.equal(accounts.describeAccount(NEW_ACCT).label, 'new@example.com');
    restoreEnv(prev);
  });

  it('resolves the history folder from the account\'s own config', () => {
    // Two folders under one account, both holding entries: nothing in the
    // folders themselves separates them, and the account is not the signed-in
    // one, so without its config this must refuse.
    const desktop = require('../src/core/parsers/claude-desktop');
    const cand = (org) => ({
      accountUuid: NEW_ACCT, organizationUuid: org, dir: '/fake/' + org,
      sessionCount: 4, deletedCount: 0, createdMs: null, accountCreatedMs: null,
    });
    const candidates = [cand(OLD_ORG), cand(NEW_ORG)];

    const blind = desktop.pickHistoryOrg(NEW_ACCT, candidates, {});
    assert.equal(blind.ambiguous, true, 'with no evidence it must refuse');

    const told = desktop.pickHistoryOrg(NEW_ACCT, candidates, {
      declaredOrgs: new Map([[NEW_ACCT, NEW_ORG]]),
    });
    assert.equal(told.ambiguous, false);
    assert.equal(told.organizationUuid, NEW_ORG);
    assert.equal(told.confidence, 'account-config');
  });
});
