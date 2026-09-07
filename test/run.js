'use strict';
/**
 * Minimal test runner.
 *
 * No framework: this project ships as an Electron app and a test dependency
 * that has to be installed before you can verify data-safety behaviour is a
 * dependency in the wrong place.
 */
const fs = require('fs');
const path = require('path');

const state = { suites: [], current: null, only: null };

function describe(name, fn) {
  const suite = { name, tests: [], before: null, after: null };
  state.suites.push(suite);
  state.current = suite;
  fn();
  state.current = null;
}

function it(name, fn) {
  if (!state.current) throw new Error('it() outside describe()');
  state.current.tests.push({ name, fn });
}

function beforeAll(fn) { if (state.current) state.current.before = fn; }
function afterAll(fn) { if (state.current) state.current.after = fn; }

class AssertionError extends Error {}

const assert = {
  ok(v, msg) { if (!v) throw new AssertionError(msg || `expected truthy, got ${JSON.stringify(v)}`); },
  notOk(v, msg) { if (v) throw new AssertionError(msg || `expected falsy, got ${JSON.stringify(v)}`); },
  equal(a, b, msg) {
    if (a !== b) throw new AssertionError(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  },
  notEqual(a, b, msg) {
    if (a === b) throw new AssertionError(msg || `expected value to differ from ${JSON.stringify(b)}`);
  },
  deepEqual(a, b, msg) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa !== sb) throw new AssertionError(msg || `expected ${sb}, got ${sa}`);
  },
  greater(a, b, msg) { if (!(a > b)) throw new AssertionError(msg || `expected ${a} > ${b}`); },
  atLeast(a, b, msg) { if (!(a >= b)) throw new AssertionError(msg || `expected ${a} >= ${b}`); },
  atMost(a, b, msg) { if (!(a <= b)) throw new AssertionError(msg || `expected ${a} <= ${b}`); },
  includes(hay, needle, msg) {
    if (!String(hay).includes(needle)) throw new AssertionError(msg || `expected "${String(hay).slice(0, 160)}" to include "${needle}"`);
  },
  async throws(fn, matcher, msg) {
    let threw = null;
    try { await fn(); } catch (err) { threw = err; }
    if (!threw) throw new AssertionError(msg || 'expected the call to throw, but it resolved');
    if (matcher) {
      const hay = `${threw.code || ''} ${threw.message}`;
      if (!hay.includes(matcher)) {
        throw new AssertionError(msg || `expected error matching "${matcher}", got "${threw.message}"`);
      }
    }
    return threw;
  },
};

async function main() {
  const dir = __dirname;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();
  const filter = process.argv[2] || null;

  global.describe = describe;
  global.it = it;
  global.beforeAll = beforeAll;
  global.afterAll = afterAll;
  global.assert = assert;

  for (const f of files) require(path.join(dir, f));

  let pass = 0, fail = 0, skipped = 0;
  const failures = [];
  const t0 = Date.now();

  for (const suite of state.suites) {
    if (filter && !suite.name.toLowerCase().includes(filter.toLowerCase())) {
      skipped += suite.tests.length;
      continue;
    }
    process.stdout.write(`\n${suite.name}\n`);
    let ctx = {};
    if (suite.before) {
      try { ctx = (await suite.before()) || {}; }
      catch (err) {
        console.log(`  ! suite setup failed: ${err.message}`);
        fail += suite.tests.length;
        failures.push({ suite: suite.name, test: '(setup)', err });
        continue;
      }
    }
    for (const t of suite.tests) {
      const start = Date.now();
      try {
        await t.fn(ctx);
        const ms = Date.now() - start;
        process.stdout.write(`  ✓ ${t.name}${ms > 400 ? ` (${ms}ms)` : ''}\n`);
        pass++;
      } catch (err) {
        process.stdout.write(`  ✗ ${t.name}\n      ${err.message}\n`);
        fail++;
        failures.push({ suite: suite.name, test: t.name, err });
      }
    }
    if (suite.after) { try { await suite.after(ctx); } catch { /* teardown noise is not a failure */ } }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`\n${'-'.repeat(60)}\n`);
  process.stdout.write(`${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''} in ${secs}s\n`);

  if (failures.length) {
    process.stdout.write('\nFailures:\n');
    for (const f of failures) {
      process.stdout.write(`  ${f.suite} > ${f.test}\n    ${f.err.stack?.split('\n').slice(0, 3).join('\n    ')}\n`);
    }
  }
  process.exit(fail ? 1 : 0);
}

main().catch((err) => { console.error('runner crashed:', err); process.exit(1); });
