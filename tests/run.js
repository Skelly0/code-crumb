#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite                                         |
// |  Zero-dependency tests using Node.js built-in assert           |
// |                                                                |
// |  Run: node tests/run.js [options] [filter...]  or  npm test    |
// |    --quiet / -q   print only failures and the summary          |
// |    --serial       every file in this one process, one by one   |
// |    --jobs=N       files run at once (default: min(4, cpus))    |
// |    filter         run only files whose name contains it        |
// |                   (node tests/run.js grid face)                |
// |                                                                |
// |  By default each file runs in a child process of its own,      |
// |  with its own throwaway HOME, up to --jobs at a time. A        |
// |  file's output is held back and printed in the order of the    |
// |  list below, so a run reads the same whatever finishes first.  |
// |  A single selected file runs in-process (live output).         |
// |                                                                |
// |  This is the only supported way in: a test file run directly   |
// |  refuses to start (createSuite in _harness.js checks the       |
// |  CRUMB_TEST_HOME marker set below).                            |
// +================================================================+

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');

const TEST_MODULES = [
  './test-shared.js',
  './test-state-machine.js',
  './test-themes.js',
  './test-animations.js',
  './test-particles.js',
  './test-face.js',
  './test-grid.js',
  './test-accessories.js',
  './test-teams.js',
  './test-launch.js',
  './test-adapters.js',
  './test-transition.js',
  './test-emotions.js',
  './test-platform.js',
  './test-subagents.js',
  './test-attention.js',
  './test-release.js',
];

// The subprocess-heavy files, slowest first (serial times on win32, Oct
// 2026: adapters ~11.5s, attention ~8.7s, then ~3s each). Starting them
// first keeps the longest file off the tail of a parallel run. This only
// changes when a file STARTS -- never the order its output is printed in.
const SLOW_FIRST = [
  'test-adapters.js',
  'test-attention.js',
  'test-subagents.js',
  'test-platform.js',
  'test-state-machine.js',
];

// A file that has not finished in this long is killed and counted as
// failed, so a hung test cannot hang CI. The slowest file takes ~12s.
const FILE_TIMEOUT_MS = 5 * 60 * 1000;
// After a child's stdio closes, how long to wait for its IPC channel too.
const IPC_GRACE_MS = 2000;

// _harness.js refuses to build a suite unless this names the current HOME.
const ISOLATION_MARKER = 'CRUMB_TEST_HOME';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// -- Isolation -----------------------------------------------------
// shared.js derives every state path from USERPROFILE/HOME (and
// CODE_CRUMB_STATE) when it is first required, and subprocess tests
// inherit process.env, so redirecting here -- before any test file
// loads -- keeps the whole run out of the real home directory. A
// running renderer never sees test writes, and the suite cannot
// clobber the user's stats or prefs. The editors' own config-dir
// variables (CODEX_HOME, CLAUDE_CONFIG_DIR, and OpenCode's
// XDG_CONFIG_HOME / OPENCODE_CONFIG_DIR / OPENCODE_CONFIG, which setup.js
// and doctor follow) would point a test straight back at the user's real
// editor config, so they go too (the defaults then resolve inside the
// fake home).
// Every process of a parallel run calls this, so each file gets a
// home of its own.
function isolate() {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-test-home-'));
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
  process.env.CODE_CRUMB_STATE = path.join(fakeHome, '.code-crumb-state');
  for (const k of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG']) {
    delete process.env[k];
  }
  process.env[ISOLATION_MARKER] = fakeHome;
  process.on('exit', () => {
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });
  return fakeHome;
}

// -- CLI -----------------------------------------------------------

function defaultJobs() {
  const cpus = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (os.cpus() || []).length;
  return Math.max(1, Math.min(4, cpus || 1));
}

function parseArgs(argv) {
  const opts = { quiet: false, serial: false, jobs: defaultJobs(), child: null, filters: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quiet' || a === '-q') opts.quiet = true;
    else if (a === '--serial') opts.serial = true;
    else if (a.startsWith('--jobs=')) {
      const n = parseInt(a.slice('--jobs='.length), 10);
      if (Number.isInteger(n) && n > 0) opts.jobs = n;
    } else if (a === '--child') opts.child = argv[++i] || null; // internal
    else if (!a.startsWith('-')) opts.filters.push(a);
  }
  return opts;
}

// The registered files, or -- for the runner's own tests in
// test-release.js -- an explicit list of absolute paths in
// CRUMB_TEST_FILES (path.delimiter-separated).
function testFiles() {
  const override = process.env.CRUMB_TEST_FILES;
  if (override) return override.split(path.delimiter).filter(Boolean);
  return TEST_MODULES.map(m => path.join(__dirname, m));
}

// -- Running one file ------------------------------------------------

// Load one test file in this process and wait for its async tests.
async function runFile(file) {
  const name = path.basename(file);
  const t0 = Date.now();
  let result;
  try {
    const mod = require(file);
    result = typeof mod.done === 'function'
      ? await mod.done()
      : { passed: mod.passed(), failed: mod.failed() };
  } catch (e) {
    // A syntax error or top-level throw in one file must not take the
    // rest of the suite down with it.
    console.log(`\n    ${RED}\u2717${RESET} ${name} failed to load`);
    console.log(`      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`);
    result = { passed: 0, failed: 1 };
  }
  return { name, passed: result.passed, failed: result.failed, ms: Date.now() - t0, note: '' };
}

// Resolves once everything written so far has left the process -- stdout
// to a pipe is asynchronous on some platforms, and process.exit() would
// otherwise drop the tail of a child's output.
function drain(stream) {
  return new Promise(resolve => {
    try { stream.write('', () => resolve()); } catch { resolve(); }
  });
}

// Child mode: run one file, hand the counts back over IPC, exit.
async function runChild(file) {
  const r = await runFile(file);
  await drain(process.stdout);
  await drain(process.stderr);
  const code = r.failed ? 1 : 0;
  try {
    process.send({ type: 'result', result: r }, () => process.exit(code));
  } catch {
    process.exit(code);
  }
}

// -- Parallel runner -------------------------------------------------
// Each file runs as `run.js --child <file>` (which isolates itself again),
// up to `jobs` at a time, slowest first. Output -- stdout and stderr
// merged, in arrival order -- is buffered per file and written out in
// list order as soon as every file before it has finished.
function runParallel(files, { quiet, jobs }) {
  const slots = files.map(file => ({
    file, name: path.basename(file), chunks: [], result: null, done: false,
  }));
  const rank = s => {
    const i = SLOW_FIRST.indexOf(s.name);
    return i === -1 ? SLOW_FIRST.length : i;
  };
  const queue = slots.slice().sort((a, b) => rank(a) - rank(b));

  return new Promise(resolve => {
    let next = 0;
    let running = 0;
    let printed = 0;

    function flushInOrder() {
      while (printed < slots.length && slots[printed].done) {
        const s = slots[printed++];
        if (s.chunks.length) process.stdout.write(Buffer.concat(s.chunks));
      }
      if (printed === slots.length) resolve(slots.map(s => s.result));
    }

    function start(slot) {
      running++;
      const t0 = Date.now();
      const args = ['--child', slot.file].concat(quiet ? ['--quiet'] : []);
      let child;
      let finished = false;
      const finish = (code, signal, err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const ms = Date.now() - t0;
        let r = slot.result;
        if (!r) {
          // No counts came back: the file crashed the process (an uncaught
          // throw in a timer, process.exit) or never started.
          const why = err ? `could not start: ${err.message}`
            : slot.timedOut ? `timed out after ${FILE_TIMEOUT_MS / 1000}s`
            : `exited with ${signal ? 'signal ' + signal : 'code ' + code} before reporting`;
          slot.chunks.push(Buffer.from(`\n    ${RED}\u2717${RESET} ${slot.name} ${why}\n`));
          r = { name: slot.name, passed: 0, failed: 1, ms, note: why };
        } else if (code !== 0 && !r.failed) {
          // Reported a clean run, then died anyway.
          const why = `exited with ${signal ? 'signal ' + signal : 'code ' + code} after reporting`;
          slot.chunks.push(Buffer.from(`\n    ${RED}\u2717${RESET} ${slot.name} ${why}\n`));
          r = { ...r, failed: 1, note: why };
        }
        slot.result = r;
        slot.done = true;
        running--;
        flushInOrder();
        launch();
      };
      const timer = setTimeout(() => {
        slot.timedOut = true;
        try { child.kill(); } catch {}
      }, FILE_TIMEOUT_MS);
      try {
        child = fork(__filename, args, { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      } catch (e) {
        finish(null, null, e);
        return;
      }
      child.stdout.on('data', c => slot.chunks.push(c));
      child.stderr.on('data', c => slot.chunks.push(c));
      child.on('message', m => {
        if (m && m.type === 'result' && m.result) slot.result = m.result;
      });
      child.on('error', e => finish(null, null, e));
      // 'close', not 'exit': it waits for the child's stdio to end, so
      // every byte the file printed is in chunks before it is written. The
      // counts travel on the IPC channel, which closes on its own schedule,
      // so the slot is settled only once both are done ('disconnect' is
      // emitted after the last message); the grace timer is a backstop.
      let closed = null;
      child.on('disconnect', () => { if (closed) finish(...closed); });
      child.on('close', (code, signal) => {
        closed = [code, signal, null];
        if (!child.connected) finish(code, signal, null);
        else setTimeout(() => finish(code, signal, null), IPC_GRACE_MS);
      });
    }

    function launch() {
      while (running < jobs && next < queue.length) start(queue[next++]);
    }

    launch();
  });
}

// -- Main ------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  isolate();
  if (opts.quiet) process.env.CRUMB_TEST_QUIET = '1';

  if (opts.child) {
    await runChild(path.resolve(opts.child));
    return;
  }

  const selected = testFiles().filter(f =>
    opts.filters.length === 0 || opts.filters.some(x => path.basename(f).includes(x)));

  console.log('\n  Code Crumb Test Suite');
  console.log('  ' + '='.repeat(40));

  if (selected.length === 0) {
    console.log(`  No test files match: ${opts.filters.join(', ')}\n`);
    process.exit(2);
  }

  const suiteStart = Date.now();
  let perFile;
  if (opts.serial || selected.length === 1) {
    perFile = [];
    for (const file of selected) perFile.push(await runFile(file));
  } else {
    perFile = await runParallel(selected, opts);
  }

  let totalPassed = 0;
  let totalFailed = 0;
  console.log(`\n  ${'='.repeat(40)}`);
  for (const r of perFile) {
    totalPassed += r.passed;
    totalFailed += r.failed;
    const failedStr = r.failed ? `${RED}${r.failed} failed${RESET}, ` : '';
    const note = r.note ? ` ${RED}${r.note}${RESET}` : '';
    console.log(`  ${r.name.padEnd(24)} ${failedStr}${r.passed} passed ${DIM}(${r.ms}ms)${RESET}${note}`);
  }
  console.log(`  ${'-'.repeat(40)}`);
  const seconds = ((Date.now() - suiteStart) / 1000).toFixed(2);
  if (totalFailed === 0) {
    console.log(`  ${GREEN}All ${totalPassed} tests passed${RESET} in ${seconds}s`);
  } else {
    console.log(`  ${RED}${totalFailed} failed${RESET}, ${totalPassed} passed in ${seconds}s`);
  }
  console.log(`  ${'='.repeat(40)}\n`);

  await drain(process.stdout);
  process.exit(totalFailed > 0 ? 1 : 0);
}

// Exported before main() starts: test-release.js requires this file while
// it is still the running entry point (a cycle), and must see the list.
module.exports = { TEST_MODULES, ISOLATION_MARKER, parseArgs };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
