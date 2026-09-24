'use strict';

// +================================================================+
// |  Test Harness -- shared describe/test runner for tests/*.js    |
// |                                                                |
// |  Every test file calls createSuite() for its own counters and  |
// |  exports the suite; run.js awaits suite.done() so async tests  |
// |  (test.async, or a test that returns a promise) are counted    |
// |  only after they settle.                                       |
// |                                                                |
// |  CRUMB_TEST_QUIET=1 prints only failures and the summary.      |
// +================================================================+

const fs = require('fs');
const path = require('path');
const os = require('os');

const QUIET = process.env.CRUMB_TEST_QUIET === '1';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

// -- Suite --------------------------------------------------------

function createSuite() {
  let passed = 0;
  let failed = 0;
  let currentDescribe = '';
  const pending = [];
  const failures = [];

  function describe(name, fn) {
    currentDescribe = name;
    if (!QUIET) console.log(`\n  ${name}`);
    fn();
  }

  function pass(name) {
    passed++;
    if (!QUIET) console.log(`    ${GREEN}✓${RESET} ${name}`);
  }

  function fail(name, err, describeName) {
    failed++;
    const message = err && err.message ? err.message : String(err);
    const label = QUIET && describeName ? `${describeName} > ${name}` : name;
    failures.push({ describe: describeName, name, message });
    console.log(`    ${RED}✗${RESET} ${label}`);
    console.log(`      ${message}`);
  }

  // Synchronous by default. A test that returns a promise is tracked and
  // settled in done(); a throw inside a promise counts as a failure instead
  // of an uncaught exception.
  function test(name, fn) {
    const describeName = currentDescribe;
    let result;
    try {
      result = fn();
    } catch (e) {
      fail(name, e, describeName);
      return;
    }
    if (result && typeof result.then === 'function') {
      pending.push(result.then(
        () => pass(name),
        (e) => fail(name, e, describeName),
      ));
      return;
    }
    pass(name);
  }

  // Explicit async form: fn may be async or return a promise.
  test.async = function (name, fn) {
    test(name, () => Promise.resolve().then(fn));
  };

  async function done() {
    await Promise.all(pending);
    return { passed, failed, failures };
  }

  return {
    describe,
    test,
    done,
    passed: () => passed,
    failed: () => failed,
    failures: () => failures,
  };
}

// -- Isolation helpers ------------------------------------------------

// Fresh temp home for one subprocess run. shared.js resolves every state
// path from HOME/USERPROFILE and CODE_CRUMB_STATE, so overriding those in
// the child env keeps its writes inside tmp.
function makeTempEnv(sessionId) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-test-'));
  const stateFile = path.join(tmp, '.code-crumb-state');
  const sessionsDir = path.join(tmp, '.code-crumb-sessions');
  const statsFile = path.join(tmp, '.code-crumb-stats.json');
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    CODE_CRUMB_STATE: stateFile,
    CLAUDE_SESSION_ID: sessionId || 'test-session',
  };
  return { tmp, stateFile, sessionsDir, statsFile, env };
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

function readJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

module.exports = { createSuite, makeTempEnv, cleanup, readJSON };
