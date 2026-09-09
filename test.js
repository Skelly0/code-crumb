#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite                                         |
// |  Zero-dependency tests using Node.js built-in assert           |
// |                                                                |
// |  Run: node test.js [--quiet] [filter...]  or  npm test         |
// |    --quiet / -q   print only failures and the summary          |
// |    filter         run only files whose name contains it        |
// |                   (node test.js grid face)                     |
// +================================================================+

const fs = require('fs');
const path = require('path');
const os = require('os');

// -- Isolation -----------------------------------------------------
// shared.js derives every state path from USERPROFILE/HOME (and
// CODE_CRUMB_STATE) when it is first required, and subprocess tests
// inherit process.env, so redirecting here -- before any test file
// loads -- keeps the whole run out of the real home directory. A
// running renderer never sees test writes, and the suite cannot
// clobber the user's stats or prefs.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-test-home-'));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.CODE_CRUMB_STATE = path.join(fakeHome, '.code-crumb-state');
process.on('exit', () => {
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
});

// -- CLI -----------------------------------------------------------
const args = process.argv.slice(2);
const quiet = args.includes('--quiet') || args.includes('-q');
const filters = args.filter(a => !a.startsWith('-'));
if (quiet) process.env.CRUMB_TEST_QUIET = '1';

const testModules = [
  './tests/test-shared.js',
  './tests/test-state-machine.js',
  './tests/test-themes.js',
  './tests/test-animations.js',
  './tests/test-particles.js',
  './tests/test-face.js',
  './tests/test-grid.js',
  './tests/test-accessories.js',
  './tests/test-teams.js',
  './tests/test-launch.js',
  './tests/test-adapters.js',
  './tests/test-transition.js',
  './tests/test-emotions.js',
  './tests/test-platform.js',
  './tests/test-subagents.js',
  './tests/test-attention.js',
];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

async function main() {
  const selected = testModules.filter(m =>
    filters.length === 0 || filters.some(f => path.basename(m).includes(f)));

  console.log('\n  Code Crumb Test Suite');
  console.log('  ' + '='.repeat(40));

  if (selected.length === 0) {
    console.log(`  No test files match: ${filters.join(', ')}\n`);
    process.exit(2);
  }

  const suiteStart = Date.now();
  const perFile = [];
  let totalPassed = 0;
  let totalFailed = 0;

  for (const modulePath of selected) {
    const name = path.basename(modulePath);
    const t0 = Date.now();
    let result;
    try {
      const mod = require(modulePath);
      result = typeof mod.done === 'function'
        ? await mod.done()
        : { passed: mod.passed(), failed: mod.failed(), failures: [] };
    } catch (e) {
      // A syntax error or top-level throw in one file must not take the
      // rest of the suite down with it.
      console.log(`\n    ${RED}✗${RESET} ${name} failed to load`);
      console.log(`      ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e}`);
      result = { passed: 0, failed: 1, failures: [{ name: `${name} (load)`, message: String(e && e.message) }] };
    }
    totalPassed += result.passed;
    totalFailed += result.failed;
    perFile.push({ name, passed: result.passed, failed: result.failed, ms: Date.now() - t0 });
  }

  console.log(`\n  ${'='.repeat(40)}`);
  for (const r of perFile) {
    const failedStr = r.failed ? `${RED}${r.failed} failed${RESET}, ` : '';
    console.log(`  ${r.name.padEnd(24)} ${failedStr}${r.passed} passed ${DIM}(${r.ms}ms)${RESET}`);
  }
  console.log(`  ${'-'.repeat(40)}`);
  const seconds = ((Date.now() - suiteStart) / 1000).toFixed(2);
  if (totalFailed === 0) {
    console.log(`  ${GREEN}All ${totalPassed} tests passed${RESET} in ${seconds}s`);
  } else {
    console.log(`  ${RED}${totalFailed} failed${RESET}, ${totalPassed} passed in ${seconds}s`);
  }
  console.log(`  ${'='.repeat(40)}\n`);

  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
