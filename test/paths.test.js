'use strict';
/**
 * Where the app keeps its own data.
 *
 * The app was called AI Session Manager before it was called Claude Session
 * Manager. An install from then has its backups, its audit log and its
 * settings under the old directory name, and a rename that quietly starts
 * writing somewhere else leaves all of it behind under a name nothing looks
 * for any more -- which is the exact failure this app exists to prevent.
 */
const fs = require('fs');
const path = require('path');
const H = require('./helpers');

function savedEnv() {
  return {
    home: process.env.AISM_HOME_OVERRIDE,
    data: process.env.AISM_DATA_OVERRIDE,
    appdata: process.env.APPDATA,
    roots: process.env.AISM_CLAUDE_DESKTOP_ROOTS,
    cc: process.env.CLAUDE_CONFIG_DIR,
    xdgC: process.env.XDG_CONFIG_HOME,
    xdgD: process.env.XDG_DATA_HOME,
  };
}
function restoreEnv(prev) {
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('AISM_HOME_OVERRIDE', prev.home);
  set('AISM_DATA_OVERRIDE', prev.data);
  set('APPDATA', prev.appdata);
  set('AISM_CLAUDE_DESKTOP_ROOTS', prev.roots);
  set('CLAUDE_CONFIG_DIR', prev.cc);
  set('XDG_CONFIG_HOME', prev.xdgC);
  set('XDG_DATA_HOME', prev.xdgD);
}

/** An isolated data location, with the override cleared so the real rule runs. */
function isolate(base) {
  process.env.AISM_HOME_OVERRIDE = base;
  process.env.APPDATA = path.join(base, 'AppData', 'Roaming');
  process.env.XDG_DATA_HOME = path.join(base, '.local', 'share');
  delete process.env.AISM_DATA_OVERRIDE;
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  return appDataParent(base);
}

/**
 * Where this platform puts application data, inside the fixture.
 *
 * `appDataDir` is deliberately different on each OS, so a test that asserts
 * the Windows location everywhere is testing the fixture rather than the
 * rule. This mirrors the same three branches.
 */
function appDataParent(base) {
  if (process.platform === 'win32') return path.join(base, 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(base, 'Library', 'Application Support');
  return path.join(base, '.local', 'share');
}

const paths = () => require('../src/core/paths');

describe('app storage: the rename must not strand anyone', () => {
  const dirs = [];
  afterAll(() => { for (const d of dirs) H.rmrf(d); });

  it('uses the new name on a machine that has never run the old app', () => {
    const prev = savedEnv();
    const base = H.tmpDir('paths-new'); dirs.push(base);
    const parent = isolate(base);

    assert.equal(paths().appDataDir(), path.join(parent, 'claude-session-manager'));
    restoreEnv(prev);
  });

  it('keeps using the old directory when one is already there', () => {
    const prev = savedEnv();
    const base = H.tmpDir('paths-legacy'); dirs.push(base);
    const parent = isolate(base);
    const legacy = path.join(parent, 'ai-session-manager');
    fs.mkdirSync(path.join(legacy, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(legacy, 'settings.json'), '{"layout":{"sidebarWidth":300}}');

    assert.equal(paths().appDataDir(), legacy, 'a rename must not orphan an existing install');
    // And everything hanging off it follows, rather than half the app reading
    // one directory and half the other.
    assert.equal(path.dirname(paths().settingsPath()), legacy);
    assert.equal(path.dirname(paths().backupsDir()), legacy);
    assert.equal(path.dirname(paths().auditLogPath()), legacy);
    restoreEnv(prev);
  });

  it('prefers the new directory once one exists, so a move can be finished', () => {
    const prev = savedEnv();
    const base = H.tmpDir('paths-both'); dirs.push(base);
    const parent = isolate(base);
    fs.mkdirSync(path.join(parent, 'ai-session-manager'), { recursive: true });
    fs.mkdirSync(path.join(parent, 'claude-session-manager'), { recursive: true });

    assert.equal(paths().appDataDir(), path.join(parent, 'claude-session-manager'));
    restoreEnv(prev);
  });

  it('never writes inside a tool\'s own tree', () => {
    const prev = savedEnv();
    const base = H.tmpDir('paths-outside'); dirs.push(base);
    isolate(base);
    const dir = paths().appDataDir();

    assert.notOk(/[\\/]\.claude([\\/]|$)/.test(dir), dir);
    assert.notOk(/claude-code-sessions/.test(dir), dir);
    restoreEnv(prev);
  });
});

/**
 * The same code has to find Claude on a machine that is not this one.
 *
 * Every location is derived from the home directory and the platform, so it
 * can be exercised by pointing both somewhere else -- which is worth doing,
 * because a Windows-only developer cannot otherwise tell whether the macOS
 * branch was ever right.
 */
describe("app storage: finding Claude on every platform", () => {
  const dirs = [];
  afterAll(() => { for (const d of dirs) H.rmrf(d); });

  const asPlatform = (name, fn) => {
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: name, configurable: true });
    try { return fn(); } finally { Object.defineProperty(process, "platform", real); }
  };

  /**
   * The resolver realpaths every root it returns. On a Windows CI runner
   * os.tmpdir() is the 8.3 short form (C:\Users\RUNNER~1\...), so comparing
   * a raw fixture path against a resolved one fails over path spelling
   * rather than over anything the code did.
   */
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };

  /** Create <base>/<rel>/claude-code-sessions so the root is a real one. */
  const plant = (base, rel) => {
    const dir = path.join(base, ...rel);
    fs.mkdirSync(path.join(dir, "claude-code-sessions"), { recursive: true });
    return real(dir);
  };

  it("finds a normal macOS install", () => {
    const prev = savedEnv();
    const base = H.tmpDir("mac-plain"); dirs.push(base);
    process.env.AISM_HOME_OVERRIDE = base;
    delete process.env.AISM_CLAUDE_DESKTOP_ROOTS;
    const want = plant(base, ["Library", "Application Support", "Claude"]);

    const found = asPlatform("darwin", () => paths().claudeDesktopRoots());
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(real(found[0].root), want);
    assert.equal(found[0].kind, "installer");
    restoreEnv(prev);
  });

  it("finds a sandboxed macOS install, where Application Support is redirected", () => {
    const prev = savedEnv();
    const base = H.tmpDir("mac-container"); dirs.push(base);
    process.env.AISM_HOME_OVERRIDE = base;
    delete process.env.AISM_CLAUDE_DESKTOP_ROOTS;
    const want = plant(base, ["Library", "Containers", "com.anthropic.claude", "Data",
      "Library", "Application Support", "Claude"]);

    const found = asPlatform("darwin", () => paths().claudeDesktopRoots());
    assert.equal(found.length, 1, JSON.stringify(found));
    assert.equal(real(found[0].root), want);
    assert.equal(found[0].kind, "container");
    restoreEnv(prev);
  });

  it("finds Linux installs, including Flatpak and Snap", () => {
    const prev = savedEnv();
    const base = H.tmpDir("linux"); dirs.push(base);
    process.env.AISM_HOME_OVERRIDE = base;
    delete process.env.AISM_CLAUDE_DESKTOP_ROOTS;
    delete process.env.XDG_CONFIG_HOME;
    const plain = plant(base, [".config", "Claude"]);
    const flat = plant(base, [".var", "app", "com.anthropic.Claude", "config", "Claude"]);
    const snap = plant(base, ["snap", "claude", "current", ".config", "Claude"]);

    const found = asPlatform("linux", () => paths().claudeDesktopRoots());
    const roots = found.map((f) => real(f.root));
    for (const want of [plain, flat, snap]) assert.ok(roots.includes(want), want + " not in " + roots.join(", "));
    restoreEnv(prev);
  });

  it("keeps its own data where each platform puts application data", () => {
    const prev = savedEnv();
    const base = H.tmpDir("appdata-platforms"); dirs.push(base);
    process.env.AISM_HOME_OVERRIDE = base;
    delete process.env.AISM_DATA_OVERRIDE;
    delete process.env.XDG_DATA_HOME;

    // appDataDir does not realpath, so these compare raw to raw.
    const mac = asPlatform("darwin", () => paths().appDataDir());
    assert.equal(mac, path.join(base, "Library", "Application Support", "claude-session-manager"));
    const linux = asPlatform("linux", () => paths().appDataDir());
    assert.equal(linux, path.join(base, ".local", "share", "claude-session-manager"));
    restoreEnv(prev);
  });

  it("reads Claude Code from the same place on every platform", () => {
    const prev = savedEnv();
    const base = H.tmpDir("cc-roots"); dirs.push(base);
    process.env.AISM_HOME_OVERRIDE = base;
    delete process.env.CLAUDE_CONFIG_DIR;

    for (const p of ["darwin", "linux", "win32"]) {
      const roots = asPlatform(p, () => paths().claudeCodeRoots());
      assert.equal(roots[0].root, path.join(base, ".claude"), p);
    }
    restoreEnv(prev);
  });

  it("lets an unusual install be pointed at, on any platform", () => {
    const prev = savedEnv();
    const base = H.tmpDir("override"); dirs.push(base);
    process.env.AISM_HOME_OVERRIDE = base;
    const odd = plant(base, ["somewhere", "else", "Claude"]);
    process.env.AISM_CLAUDE_DESKTOP_ROOTS = odd;

    const found = asPlatform("darwin", () => paths().claudeDesktopRoots());
    assert.equal(real(found[0].root), real(odd));
    assert.equal(found[0].kind, "override");
    restoreEnv(prev);
  });
});

/**
 * Claude Code's own rule for turning a working directory into a folder name.
 *
 * Getting this wrong does not throw. It writes a session into a directory
 * Claude Code never reads, where it sits on disk and never appears in the
 * app -- so the rule is pinned here against the two things that can confirm
 * it: folders that exist on a real machine, and the implementation inside the
 * shipped `claude` binary.
 */
describe("app storage: the project folder rule", () => {
  /** The binary's own implementation, transcribed, as an independent check. */
  const theirs = (p) => {
    const hash = (t) => {
      let e = 0;
      for (let r = 0; r < t.length; r++) e = ((e << 5) - e + t.charCodeAt(r)) | 0;
      return Math.abs(e).toString(36);
    };
    const n = p.replace(/[^a-zA-Z0-9]/g, "-");
    return n.length <= 200 ? n : n.slice(0, 200) + "-" + hash(p);
  };

  const B = String.fromCharCode(92);

  it("turns every character that is not a letter or a digit into a dash", () => {
    const enc = paths().encodeClaudeProjectDir;
    assert.equal(enc("F:" + B + "0. Mobile apps"), "F--0--Mobile-apps");
    assert.equal(enc("F:" + B + "1. Rimon Labs" + B + "2. vidvers"), "F--1--Rimon-Labs-2--vidvers");
  });

  it("does not collapse runs, which is the mistake that looks right", () => {
    // `F-1.-Rimon-Labs` is what a collapsing, dot-preserving encoder gives.
    // It matched 0 of 60 real folders.
    const enc = paths().encodeClaudeProjectDir;
    assert.notEqual(enc("F:" + B + "1. Rimon Labs"), "F-1.-Rimon-Labs");
    assert.equal(enc("F:" + B + "1. Rimon Labs"), "F--1--Rimon-Labs");
  });

  it("uses the same rule for a POSIX path", () => {
    assert.equal(paths().encodeClaudeProjectDir("/Users/me/my-app"), "-Users-me-my-app");
  });

  it("shortens a long path the way Claude Code does, hashing the ORIGINAL", () => {
    // The hash is of the path as given, not of the encoded form. Hashing the
    // encoded form gives a name that is the right shape and the wrong folder.
    const enc = paths().encodeClaudeProjectDir;
    const deep = "/Users/rimon/Library/CloudStorage/GoogleDrive-someone@example.com/My Drive/"
      + "work/clients/acme corporation/2026/platform rewrite/services/ingestion pipeline/"
      + "packages/core-domain-model/src/interfaces/persistence/adapters";
    const got = enc(deep);
    assert.greater(deep.length, 200);
    assert.equal(got, theirs(deep));
    assert.equal(got.slice(0, 200), deep.replace(/[^A-Za-z0-9]/g, "-").slice(0, 200));
    assert.notEqual(got, deep.replace(/[^A-Za-z0-9]/g, "-"), "a long name must be shortened");
  });

  it("agrees with the binary across shapes, short and long", () => {
    const enc = paths().encodeClaudeProjectDir;
    const cases = [
      "F:" + B + "1. Rimon Labs",
      "/Users/me/my-app",
      "/" + "a".repeat(260),
      "C:" + B + "Users" + B + "me" + B + "src" + B + "a-b_c.d",
      "/home/me/" + "deep/".repeat(60) + "end",
    ];
    for (const c of cases) assert.equal(enc(c), theirs(c), c.slice(0, 60));
  });

  it("gives the same answer whatever platform is running", () => {
    // The folder name travels inside a bundle, so it cannot depend on who is
    // reading it.
    const enc = paths().encodeClaudeProjectDir;
    const real = Object.getOwnPropertyDescriptor(process, "platform");
    const per = {};
    for (const os of ["win32", "darwin", "linux"]) {
      Object.defineProperty(process, "platform", { value: os, configurable: true });
      per[os] = enc("F:" + B + "1. Rimon Labs" + B + "app");
    }
    Object.defineProperty(process, "platform", real);
    assert.equal(new Set(Object.values(per)).size, 1, JSON.stringify(per));
  });
});
