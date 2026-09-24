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
const { execFileSync } = require('child_process');

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

// -- Subprocess runners -----------------------------------------------

const NODE = process.execPath;
const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');
const CODEX_WRAPPER = path.join(__dirname, '..', 'adapters', 'codex-wrapper.js');

// Run update-state.js as one hook against `env` (usually a makeTempEnv env).
// An object `input` is JSON-encoded; a string goes to stdin as-is, which is
// the only way into the catch path ('' and 'not json' are not JSON). `args`
// follow the event on the command line, or are the whole argv when `event`
// is null (to test the payload's own hook_event_name).
//
// update-state.js ends with process.exit(0), which execFileSync can still
// surface as an error on some platforms, so by default only a real non-zero
// status fails. `strict` rethrows every error, with the hook's stderr.
function runUpdateState(event, input, env, { args = [], strict = false } = {}) {
  const argv = [UPDATE_STATE, ...(event ? [event] : []), ...args];
  try {
    execFileSync(NODE, argv, {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      env,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (strict) {
      const stderr = e.stderr ? e.stderr.toString() : '';
      throw new Error(`update-state.js ${argv.slice(1).join(' ')} failed: ${stderr || e.message}`);
    }
    if (e.status !== 0 && e.status !== null) throw e;
  }
}

// A stand-in `codex` on PATH that replays `events` (ThreadEvent objects) as
// JSONL through the wrapper's real spawn path. On Windows the fake is a .cmd
// shim, which only starts if the wrapper passes shell:true (Node refuses to
// spawn .cmd otherwise), so this also covers the Windows spawn fix. writeSync
// flushes each line rather than leaving it in a pipe buffer. Returns the
// makeTempEnv result; the caller cleans up `tmp`.
const FAKE_CODEX_SRC = [
  "'use strict';",
  "const fs = require('fs');",
  "const text = fs.readFileSync(process.env.CODEX_FAKE_FIXTURE, 'utf8');",
  "for (const line of text.split('\\n')) {",
  "  if (line.trim()) fs.writeSync(1, line + '\\n');",
  "}",
  '',
].join('\n');

function runFakeCodex(events, seedStats, args = []) {
  const base = makeTempEnv('codex-thread');
  const binDir = path.join(base.tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  if (seedStats) fs.writeFileSync(base.statsFile, JSON.stringify(seedStats), 'utf8');

  const fixture = path.join(base.tmp, 'fixture.jsonl');
  fs.writeFileSync(fixture, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(binDir, 'codex-fake.js'), FAKE_CODEX_SRC, 'utf8');

  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'codex.cmd'), '@node "%~dp0codex-fake.js" %*\r\n', 'utf8');
  } else {
    const sh = path.join(binDir, 'codex');
    fs.writeFileSync(sh, '#!/bin/sh\nexec node "$(dirname "$0")/codex-fake.js" "$@"\n', 'utf8');
    fs.chmodSync(sh, 0o755);
  }

  const env = { ...base.env, CODEX_FAKE_FIXTURE: fixture };
  // Windows env keys are case-insensitive; a stray Path AND PATH confuses the child.
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  env.PATH = binDir + path.delimiter + (process.env.PATH || '');
  delete env.CLAUDE_SESSION_ID; // the codex thread id owns the session identity

  try {
    execFileSync(NODE, [CODEX_WRAPPER, ...args, 'a prompt'], {
      env, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status !== 0 && e.status !== null) throw e;
  }
  return base;
}

module.exports = {
  createSuite, makeTempEnv, cleanup, readJSON,
  runUpdateState, runFakeCodex, UPDATE_STATE,
};
