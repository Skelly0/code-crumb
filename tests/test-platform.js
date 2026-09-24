#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - Platform and hook robustness          |
// |                                                                |
// |  Cross-platform launching (quoting, .cmd shims, spaces in      |
// |  paths), atomic state writes, spawn locking, stats-file        |
// |  resilience, setup.js safety (never clobber settings.json),    |
// |  adapter parity with update-state.js, and the small renderer   |
// |  edge cases (resize, tiny terminals, stale caches).            |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { Readable } = require('stream');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;
const { makeTempEnv, cleanup, readJSON } = require('./_harness');

const ROOT = path.join(__dirname, '..');
const shared = require('../lib/shared');
const sm = require('../lib/state-machine');
const launch = require('../launch');
const themes = require('../lib/themes');
const { ClaudeFace } = require('../lib/face');
const grid = require('../lib/grid');
const base = require('../adapters/base-adapter');

// Requiring setup.js must be side-effect free (CLI lives behind require.main).
const settingsBeforeSetupRequire = fs.existsSync(path.join(process.env.HOME, '.claude', 'settings.json'));
const setup = require('../setup');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// -- Quoting and renderer commands -----------------------------------------

describe('platform -- shell quoting helpers', () => {
  test('quoteArg leaves plain args alone', () => {
    assert.strictEqual(shared.quoteArg('plain'), 'plain');
  });
  test('quoteArg wraps args with spaces in double quotes', () => {
    assert.strictEqual(shared.quoteArg('has space'), '"has space"');
  });
  // Updated: this used to pin \" -- which cmd.exe does not honour, so an odd
  // number of embedded quotes dropped the rest of the argument out of quotes.
  test('quoteArg doubles embedded double quotes (cmd.exe and UCRT both read "" as one quote)', () => {
    assert.strictEqual(shared.quoteArg('say "hi"'), '"say ""hi"""');
    assert.strictEqual(shared.quoteArg('a"b & whoami'), '"a""b & whoami"');
  });
  test('quoteArg quotes every cmd metacharacter, not just whitespace', () => {
    for (const ch of ['&', '|', '<', '>', '^', '(', ')', '!', ',', ';', '=']) {
      const arg = `fix${ch}whoami`;
      assert.strictEqual(shared.quoteArg(arg), `"${arg}"`, `${ch} must force quoting`);
    }
    assert.strictEqual(shared.quoteArg('fix&whoami'), '"fix&whoami"');
  });
  test('quoteArg moves % outside the quotes as ^% so cmd cannot expand %VAR%', () => {
    assert.strictEqual(shared.quoteArg('%PATH%'), '""^%"PATH"^%""');
    assert.strictEqual(shared.quoteArg('50% off'), '"50"^%" off"');
  });
  test('quoteArg doubles backslashes that precede a quote or the closing quote', () => {
    assert.strictEqual(shared.quoteArg('C:\\dir with space\\'), '"C:\\dir with space\\\\"');
    assert.strictEqual(shared.quoteArg('q\\"x'), '"q\\\\""x"');
    assert.strictEqual(shared.quoteArg('C:\\x y\\r.js'), '"C:\\x y\\r.js"', 'interior backslashes stay single');
  });
  test('quoteArg flattens line breaks (cmd ends the command at one) and keeps empty/plain args', () => {
    assert.strictEqual(shared.quoteArg('a\r\nb\nc'), '"a b c"');
    assert.strictEqual(shared.quoteArg(''), '""');
    assert.strictEqual(shared.quoteArg('C:\\plain\\path.js'), 'C:\\plain\\path.js');
    assert.strictEqual(shared.quoteArg('--minimal'), '--minimal');
  });
  if (process.platform === 'win32') {
    // End to end: the args must survive cmd.exe and node's own argv parser.
    test('win32: quoteArg round-trips hostile args through shell:true unharmed', () => {
      const dir = tmpDir('crumb-quote-');
      try {
        const echo = path.join(dir, 'argv.js');
        fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));', 'utf8');
        const hostile = ['fix&whoami', 'a"b & echo PWNED', 'say "hi"', 'x|y', '%PATH%', '50% off',
          'hat^caret', '(p)', 'C:\\dir with space\\', 'q\\"x', ''];
        const { spawnSync } = require('child_process');
        const r = spawnSync('node', [shared.quoteArg(echo), ...hostile.map(shared.quoteArg)],
          { shell: true, encoding: 'utf8' });
        assert.deepStrictEqual(JSON.parse(r.stdout), hostile);
      } finally { cleanup(dir); }
    });
  }
  test('shQuote single-quotes for POSIX shells and escapes embedded quotes', () => {
    assert.strictEqual(shared.shQuote('/p q/r.js'), "'/p q/r.js'");
    assert.strictEqual(shared.shQuote("it's"), "'it'\\''s'");
  });
});

describe('platform -- buildRendererCommands lives in shared.js and quotes paths', () => {
  const spaced = ['C:\\Users\\me\\Claude Code Face\\renderer.js'];
  const posixSpaced = ['/Users/me/Claude Code Face/renderer.js'];
  const title = 'Code Crumb';

  test('launch.js re-exports the shared implementation', () => {
    assert.strictEqual(launch.buildRendererCommands, shared.buildRendererCommands);
  });
  test('win32 wt (shell:true) quotes the title and a path with spaces', () => {
    const cmds = shared.buildRendererCommands('win32', spaced, title);
    assert.strictEqual(cmds.wt.opts.shell, true);
    assert.ok(cmds.wt.args.includes('"Code Crumb"'), 'title must be quoted for the shell');
    assert.ok(cmds.wt.args.includes(`"${spaced[0]}"`), 'renderer path must be quoted for the shell');
  });
  test('win32 cmd fallback passes one verbatim command line with everything quoted', () => {
    const cmds = shared.buildRendererCommands('win32', spaced, title);
    assert.strictEqual(cmds.cmd.cmd, 'cmd');
    assert.strictEqual(cmds.cmd.args[0], '/c');
    assert.strictEqual(cmds.cmd.args[1], `start "Code Crumb" node "${spaced[0]}"`);
    assert.strictEqual(cmds.cmd.opts.windowsVerbatimArguments, true);
    assert.ok(!cmds.cmd.opts.shell, 'verbatim args, not shell');
  });
  test('win32 wt and cmd quote a metacharacter-bearing path (was left bare: & ran a command)', () => {
    const risky = ['C:\\R&D\\renderer.js', '--minimal'];
    const cmds = shared.buildRendererCommands('win32', risky, title);
    assert.ok(cmds.wt.args.includes('"C:\\R&D\\renderer.js"'), cmds.wt.args.join(' '));
    assert.ok(cmds.wt.args.includes('--minimal'), 'plain flags stay bare');
    assert.strictEqual(cmds.cmd.args[1], 'start "Code Crumb" node "C:\\R&D\\renderer.js" --minimal');
  });
  test('win32 wt escapes ; as \\; (wt splits subcommands on ; even inside quotes)', () => {
    const cmds = shared.buildRendererCommands('win32', ['C:\\a;b\\renderer.js'], 'Crumb;Face');
    assert.ok(cmds.wt.args.includes('"C:\\a\\;b\\renderer.js"'), cmds.wt.args.join(' '));
    assert.ok(cmds.wt.args.includes('"Crumb\\;Face"'), 'the title too');
    // The cmd fallback has no subcommand syntax: its ; stays inside quotes.
    assert.strictEqual(cmds.cmd.args[1], 'start "Crumb;Face" node "C:\\a;b\\renderer.js"');
  });
  test('win32 cmd fallback keeps a %-bearing path out of cmd\'s variable expansion', () => {
    const cmds = shared.buildRendererCommands('win32', ['C:\\100%\\renderer.js'], title);
    assert.strictEqual(cmds.cmd.args[1], 'start "Code Crumb" node "C:\\100"^%"\\renderer.js"');
  });
  test('darwin and xfce4 (POSIX shQuote) are unchanged by the cmd.exe rules', () => {
    const odd = ['/tmp/a&b "c" 50%/renderer.js'];
    const mac = shared.buildRendererCommands('darwin', odd, title).osascript.args[1];
    assert.ok(mac.includes(`node '/tmp/a&b \\"c\\" 50%/renderer.js'; exit`), mac);
    const xf = shared.buildRendererCommands('linux', odd, title)['xfce4-terminal'].args;
    assert.ok(xf.includes(`node '${odd[0]}'`), xf.join(' '));
  });
  test('darwin single-quotes the renderer path inside the AppleScript', () => {
    const cmds = shared.buildRendererCommands('darwin', posixSpaced, title);
    const script = cmds.osascript.args[1];
    assert.ok(script.includes(`node '${posixSpaced[0]}'; exit`), script);
  });
  test('linux xfce4-terminal -e string quotes the path; other terminals pass args separately', () => {
    const cmds = shared.buildRendererCommands('linux', posixSpaced, title);
    assert.ok(cmds['xfce4-terminal'].args.includes(`node '${posixSpaced[0]}'`));
    assert.ok(cmds.xterm.args.includes(posixSpaced[0]));
    assert.ok(cmds['gnome-terminal'].args.includes(posixSpaced[0]));
  });
});

describe('platform -- buildEditorSpawn (editor .cmd shims on Windows)', () => {
  test('win32 claude goes through a shell with quoted args', () => {
    const s = launch.buildEditorSpawn('win32', 'claude', ['-p', 'fix the bug']);
    assert.strictEqual(s.opts.shell, true);
    assert.deepStrictEqual(s.args, ['-p', '"fix the bug"']);
    assert.strictEqual(s.opts.stdio, 'inherit');
  });
  test('win32 claude: a prompt carrying cmd metacharacters is quoted, never run', () => {
    const s = launch.buildEditorSpawn('win32', 'claude', ['-p', 'fix&whoami', 'say "hi" & more', '100%']);
    assert.deepStrictEqual(s.args, ['-p', '"fix&whoami"', '"say ""hi"" & more"', '"100"^%""']);
  });
  test('win32 node (codex wrapper) needs no shell and keeps args verbatim', () => {
    const s = launch.buildEditorSpawn('win32', 'node', ['C:\\x y\\codex-wrapper.js', 'hello world']);
    assert.ok(!s.opts.shell);
    assert.deepStrictEqual(s.args, ['C:\\x y\\codex-wrapper.js', 'hello world']);
  });
  test('posix never uses a shell', () => {
    const s = launch.buildEditorSpawn('linux', 'claude', ['-p', 'fix the bug']);
    assert.ok(!s.opts.shell);
    assert.deepStrictEqual(s.args, ['-p', 'fix the bug']);
  });
});

// -- Atomic writes and spawn lock -------------------------------------------

describe('platform -- writeJsonAtomic', () => {
  test('writes parseable JSON and leaves no temp file behind', () => {
    const dir = tmpDir('crumb-atomic-');
    try {
      const file = path.join(dir, 'state.json');
      assert.strictEqual(shared.writeJsonAtomic(file, { a: 1 }), true);
      assert.deepStrictEqual(readJSON(file), { a: 1 });
      assert.deepStrictEqual(fs.readdirSync(dir), ['state.json']);
    } finally { cleanup(dir); }
  });
  test('replaces an existing file', () => {
    const dir = tmpDir('crumb-atomic-');
    try {
      const file = path.join(dir, 'state.json');
      shared.writeJsonAtomic(file, { a: 1 });
      shared.writeJsonAtomic(file, { a: 2 });
      assert.deepStrictEqual(readJSON(file), { a: 2 });
      assert.deepStrictEqual(fs.readdirSync(dir), ['state.json']);
    } finally { cleanup(dir); }
  });
  test('accepts a pre-serialized string', () => {
    const dir = tmpDir('crumb-atomic-');
    try {
      const file = path.join(dir, 's.json');
      shared.writeJsonAtomic(file, '{"x":true}');
      assert.deepStrictEqual(readJSON(file), { x: true });
    } finally { cleanup(dir); }
  });
  test('returns false instead of throwing when the directory does not exist', () => {
    assert.strictEqual(shared.writeJsonAtomic(path.join(os.tmpdir(), 'no-such-dir-crumb', 'x.json'), {}), false);
  });
});

describe('platform -- acquireSpawnLock', () => {
  test('first caller wins, second within the window loses, stale lock is retaken', () => {
    const dir = tmpDir('crumb-lock-');
    try {
      const lock = path.join(dir, 'spawn.lock');
      assert.strictEqual(shared.acquireSpawnLock(lock, 5000), true);
      assert.strictEqual(shared.acquireSpawnLock(lock, 5000), false);
      const old = new Date(Date.now() - 10000);
      fs.utimesSync(lock, old, old);
      assert.strictEqual(shared.acquireSpawnLock(lock, 5000), true);
    } finally { cleanup(dir); }
  });
  test('an unwritable lock location does not block spawning', () => {
    assert.strictEqual(shared.acquireSpawnLock(path.join(os.tmpdir(), 'no-such-dir-crumb', 'spawn.lock'), 5000), true);
  });
});

describe('shared.js -- acquireFileLock / withStatsLock', () => {
  test('sleepSync blocks the thread for roughly the requested time', () => {
    const t0 = Date.now();
    shared.sleepSync(15);
    assert.ok(Date.now() - t0 >= 10, 'sleepSync(15) must block at least 10ms');
  });

  test('acquire returns a release function; the lock file holds this owner\'s token', () => {
    const dir = tmpDir('crumb-flock-');
    try {
      const lock = path.join(dir, 'stats.lock');
      const release = shared.acquireFileLock(lock);
      assert.strictEqual(typeof release, 'function');
      assert.ok(fs.existsSync(lock), 'lock file exists while held');
      const token = fs.readFileSync(lock, 'utf8');
      assert.ok(token.startsWith(process.pid + '.'), `token should start with the pid, got ${token}`);
      release();
      assert.ok(!fs.existsSync(lock), 'release removes the lock file');
    } finally { cleanup(dir); }
  });

  test('a second acquire while held gives up after waitMs and returns null', () => {
    const dir = tmpDir('crumb-flock-');
    try {
      const lock = path.join(dir, 'stats.lock');
      const held = shared.acquireFileLock(lock);
      const t0 = Date.now();
      const second = shared.acquireFileLock(lock, { waitMs: 20 });
      const elapsed = Date.now() - t0;
      assert.strictEqual(second, null, 'contended acquire returns null');
      assert.ok(elapsed >= 20, `should wait at least waitMs, waited ${elapsed}ms`);
      // Generous upper bound on purpose: it is scheduler latency, not the
      // lock, that sets the real number. It still catches a waitMs that is
      // ignored entirely or a wait that never ends.
      assert.ok(elapsed < 1000, `should not wait far past waitMs, waited ${elapsed}ms`);
      held();
    } finally { cleanup(dir); }
  });

  test('a lock older than staleMs belongs to a crashed hook and is taken over', () => {
    const dir = tmpDir('crumb-flock-');
    try {
      const lock = path.join(dir, 'stats.lock');
      shared.acquireFileLock(lock);
      const old = new Date(Date.now() - 10000);
      fs.utimesSync(lock, old, old);
      const taken = shared.acquireFileLock(lock, { waitMs: 20, staleMs: 2000 });
      assert.strictEqual(typeof taken, 'function', 'stale lock is taken over');
      taken();
    } finally { cleanup(dir); }
  });

  // The race: two waiters both stat the same stale lock; the faster one takes
  // it over first. The slower one must then see a live lock and wait, not
  // overwrite it (the old non-exclusive write gave both a release).
  test('a waiter that saw the stale lock after someone else took it over does not also take it', () => {
    const dir = tmpDir('crumb-flock-');
    const realStat = fs.statSync;
    try {
      const lock = path.join(dir, 'stats.lock');
      fs.writeFileSync(lock, 'crashed-owner', 'utf8');
      const old = new Date(Date.now() - 10000);
      fs.utimesSync(lock, old, old);
      let raced = false;
      fs.statSync = function (p, ...rest) {
        const st = realStat.call(fs, p, ...rest);
        if (!raced && p === lock) {
          raced = true;
          // The faster waiter: remove the stale lock and create its own.
          fs.unlinkSync(lock);
          fs.writeFileSync(lock, 'faster-waiter', { flag: 'wx' });
        }
        return st;                                   // we still saw it as stale
      };
      const slow = shared.acquireFileLock(lock, { waitMs: 30, staleMs: 2000 });
      fs.statSync = realStat;
      assert.ok(raced, 'the race was staged');
      assert.strictEqual(slow, null, 'the slower waiter must not also hold the lock');
      assert.strictEqual(fs.readFileSync(lock, 'utf8'), 'faster-waiter', 'the live lock is left intact');
      assert.deepStrictEqual(fs.readdirSync(dir), ['stats.lock'], 'no aside file left behind');
    } finally { fs.statSync = realStat; cleanup(dir); }
  });

  test('stale takeover goes through the exclusive create and leaves no aside file', () => {
    const dir = tmpDir('crumb-flock-');
    try {
      const lock = path.join(dir, 'stats.lock');
      fs.writeFileSync(lock, 'crashed-owner', 'utf8');
      const old = new Date(Date.now() - 10000);
      fs.utimesSync(lock, old, old);
      const a = shared.acquireFileLock(lock, { waitMs: 20, staleMs: 2000 });
      const b = shared.acquireFileLock(lock, { waitMs: 20, staleMs: 2000 });
      assert.strictEqual(typeof a, 'function', 'the first waiter takes the stale lock');
      assert.strictEqual(b, null, 'the second waiter sees a live lock');
      assert.deepStrictEqual(fs.readdirSync(dir), ['stats.lock']);
      a();
      assert.deepStrictEqual(fs.readdirSync(dir), []);
    } finally { cleanup(dir); }
  });

  test('the crashed owner\'s late release does not free the new owner\'s lock', () => {
    const dir = tmpDir('crumb-flock-');
    try {
      const lock = path.join(dir, 'stats.lock');
      const releaseA = shared.acquireFileLock(lock);
      const tokenA = fs.readFileSync(lock, 'utf8');
      const old = new Date(Date.now() - 10000);
      fs.utimesSync(lock, old, old);
      const releaseB = shared.acquireFileLock(lock, { waitMs: 20, staleMs: 2000 });
      const tokenB = fs.readFileSync(lock, 'utf8');
      assert.notStrictEqual(tokenB, tokenA, 'takeover writes a new token');
      releaseA();
      assert.ok(fs.existsSync(lock), 'A must not unlink a lock it no longer owns');
      assert.strictEqual(fs.readFileSync(lock, 'utf8'), tokenB);
      releaseB();
      assert.ok(!fs.existsSync(lock));
    } finally { cleanup(dir); }
  });

  test('an unusable lock location behaves as acquired (the lock is a courtesy)', () => {
    const release = shared.acquireFileLock(path.join(os.tmpdir(), 'no-such-dir-crumb', 'stats.lock'), { waitMs: 20 });
    assert.strictEqual(typeof release, 'function', 'fs errors must not stop the hook doing its work');
    release();
  });

  test('withStatsLock returns the callback value and releases the lock', () => {
    try { fs.unlinkSync(shared.STATS_LOCK_FILE); } catch {}
    const v = shared.withStatsLock(() => {
      assert.ok(fs.existsSync(shared.STATS_LOCK_FILE), 'lock is held during the callback');
      return 42;
    });
    assert.strictEqual(v, 42);
    assert.ok(!fs.existsSync(shared.STATS_LOCK_FILE), 'lock released after return');
  });

  test('withStatsLock releases the lock when the callback throws, and rethrows', () => {
    try { fs.unlinkSync(shared.STATS_LOCK_FILE); } catch {}
    assert.throws(() => shared.withStatsLock(() => { throw new Error('boom'); }), /boom/);
    assert.ok(!fs.existsSync(shared.STATS_LOCK_FILE), 'lock released after a throw');
  });

  test('the stats lock lives next to the stats file', () => {
    assert.strictEqual(shared.STATS_LOCK_FILE, path.join(shared.HOME, '.code-crumb-stats.lock'));
    assert.strictEqual(shared.LOCK_WAIT_MS, 150);
    assert.strictEqual(shared.LOCK_STALE_MS, 2000);
    assert.strictEqual(shared.LOCK_SPIN_MS, 2);
  });
});

describe('shared.js -- a delete-pending lock (win32 EPERM) is held, not free', () => {
  test('an EPERM create waits and retries instead of proceeding unlocked', () => {
    const { tmp } = makeTempEnv('lock-eperm');
    const lockFile = path.join(tmp, 'eperm.lock');
    const real = fs.writeFileSync;
    let failures = 2;
    fs.writeFileSync = function (file, data, opts) {
      if (file === lockFile && opts && opts.flag === 'wx' && failures > 0) {
        failures--;
        const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM';
        throw e;
      }
      return real.apply(this, arguments);
    };
    try {
      const release = shared.acquireFileLock(lockFile, { waitMs: 1000, spinMs: 1 });
      assert.strictEqual(failures, 0, 'both EPERMs were retried');
      assert.ok(fs.existsSync(lockFile), 'the lock was really taken (a no-op release used to be returned)');
      release();
      assert.ok(!fs.existsSync(lockFile), 'and really released');
    } finally { fs.writeFileSync = real; cleanup(tmp); }
  });
});

// Six processes, twenty increments each: without serialization the read-modify-write
// races and the total lands short of 120.
describe('shared.js -- the stats lock serializes parallel read-modify-write', () => {
  test.async('6 workers x 20 increments all land', async () => {
    const { tmp, statsFile, env } = makeTempEnv('lock-worker');
    try {
      const worker = path.join(tmp, 'worker.js');
      fs.writeFileSync(worker, [
        "'use strict';",
        "const fs = require('fs');",
        'const shared = require(process.argv[2]);',
        'for (let i = 0; i < 20; i++) {',
        '  const release = shared.acquireFileLock(shared.STATS_LOCK_FILE, { waitMs: 5000 });',
        '  let s = {};',
        "  try { s = JSON.parse(fs.readFileSync(shared.STATS_FILE, 'utf8')); } catch {}",
        '  s.n = (s.n || 0) + 1;',
        '  shared.writeJsonAtomic(shared.STATS_FILE, s);',
        '  if (release) release();',
        '}',
      ].join('\n'), 'utf8');
      fs.writeFileSync(statsFile, JSON.stringify({ n: 0 }), 'utf8');

      const sharedPath = path.join(ROOT, 'lib', 'shared.js');
      await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [worker, sharedPath], { env, stdio: 'ignore' });
        child.on('error', reject);
        child.on('exit', resolve);
      })));

      assert.strictEqual(readJSON(statsFile).n, 120, 'every increment must survive');
    } finally { cleanup(tmp); }
  });
});

// -- Stats resilience ------------------------------------------------------

describe('platform -- normalizeStats fills any missing shape', () => {
  test('empty object gets every default', () => {
    const s = sm.normalizeStats({});
    assert.strictEqual(s.session.id, '');
    assert.deepStrictEqual(s.session.filesEdited, []);
    assert.strictEqual(s.records.longestSession, 0);
    assert.deepStrictEqual(s.frequentFiles, {});
    assert.deepStrictEqual(s.topLevelSessions, {});
  });
  test('null / array / string fall back to defaults', () => {
    assert.strictEqual(sm.normalizeStats(null).streak, 0);
    assert.strictEqual(sm.normalizeStats([]).session.id, '');
    assert.strictEqual(sm.normalizeStats('x').session.id, '');
  });
  test('keeps existing values and fills only the holes', () => {
    const s = sm.normalizeStats({ streak: 7, session: { id: 'abc' }, records: { mostSubagents: 3 } });
    assert.strictEqual(s.streak, 7);
    assert.strictEqual(s.session.id, 'abc');
    assert.strictEqual(s.session.toolCalls, 0);
    assert.strictEqual(s.records.mostSubagents, 3);
    assert.strictEqual(s.records.longestSession, 0);
  });
  test('repairs a non-array filesEdited', () => {
    assert.deepStrictEqual(sm.normalizeStats({ session: { filesEdited: 'nope' } }).session.filesEdited, []);
  });
  test('base-adapter readStats survives a {} stats file', () => {
    fs.writeFileSync(shared.STATS_FILE, '{}', 'utf8');
    try {
      const stats = base.readStats();
      assert.strictEqual(stats.session.id, '');
      assert.doesNotThrow(() => base.initSession(stats, 'sess-1'));
      assert.strictEqual(stats.session.id, 'sess-1');
    } finally { try { fs.unlinkSync(shared.STATS_FILE); } catch {} }
  });
});

// -- Palette index ----------------------------------------------------------

describe('platform -- normalizePaletteIndex', () => {
  test('wraps negatives into range (corrupt prefs used to break the t key)', () => {
    assert.strictEqual(themes.normalizePaletteIndex(-3, 6), 3);
    assert.strictEqual(themes.normalizePaletteIndex(-1, 6), 5);
  });
  test('wraps overflow and keeps in-range values', () => {
    assert.strictEqual(themes.normalizePaletteIndex(7, 6), 1);
    assert.strictEqual(themes.normalizePaletteIndex(2, 6), 2);
  });
  test('non-integers fall back to 0', () => {
    assert.strictEqual(themes.normalizePaletteIndex('x', 6), 0);
    assert.strictEqual(themes.normalizePaletteIndex(NaN, 6), 0);
    assert.strictEqual(themes.normalizePaletteIndex(1.5, 6), 0);
  });
});

// -- base-adapter parity with update-state.js --------------------------------

describe('platform -- base-adapter pid field matches update-state.js policy', () => {
  test('pidField omits pid on win32 and uses ppid elsewhere', () => {
    const f = base.pidField();
    if (process.platform === 'win32') assert.deepStrictEqual(f, {});
    else assert.deepStrictEqual(f, { pid: process.ppid });
  });
  test('writeSessionState follows pidField', () => {
    base.writeSessionState('pid-policy-1', 'thinking', '', false, { sessionId: 'pid-policy-1' });
    const f = path.join(shared.SESSIONS_DIR, shared.safeFilename('pid-policy-1') + '.json');
    try {
      const st = readJSON(f);
      if (process.platform === 'win32') assert.strictEqual(st.pid, undefined);
      else assert.strictEqual(st.pid, process.ppid);
    } finally { try { fs.unlinkSync(f); } catch {} }
  });
});

describe('platform -- processStdinEvent separates parse errors from handler errors', () => {
  function run(input, handler) {
    return new Promise((resolve) => {
      const stream = new Readable({ read() {} });
      const calls = { fallback: 0, exit: null };
      base.processStdinEvent(handler, () => { calls.fallback++; }, {
        stream,
        exit: (code) => { calls.exit = code; resolve(calls); },
      });
      stream.push(input);
      stream.push(null);
    });
  }
  test.async('malformed JSON calls the fallback', async () => {
    const calls = await run('not json', () => {});
    assert.strictEqual(calls.fallback, 1);
    assert.strictEqual(calls.exit, 0);
  });
  test.async('a throwing handler is swallowed and does NOT trigger the parse fallback', async () => {
    let handled = 0;
    const calls = await run('{"ok":true}', () => { handled++; throw new Error('handler bug'); });
    assert.strictEqual(handled, 1);
    assert.strictEqual(calls.fallback, 0, 'handler bugs must not masquerade as unparseable stdin');
    assert.strictEqual(calls.exit, 0);
  });
});

describe('platform -- adapter source hygiene', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  test('codex-wrapper does not blank the cwd and imports nothing it does not use', () => {
    const src = read('adapters/codex-wrapper.js');
    assert.ok(!src.includes("cwd: ''"), "session writes must not set cwd: ''");
    // path came back with the file_change item type (basename of a saved file)
    if (src.includes("require('path')")) {
      assert.ok(/\bpath\.\w+\(/.test(src), 'path is imported, so it must be used');
    }
    if (src.includes("require('fs')")) {
      assert.ok(/\bfs\.\w+\(/.test(src), 'fs is imported, so it must be used');
    }
  });
  test('engmux-adapter does not hardcode python and caps captured stdout', () => {
    const src = read('adapters/engmux-adapter.js');
    assert.ok(!src.includes("spawn('python',"), 'python must be configurable (python3 default on posix)');
    assert.ok(/python3/.test(src));
    assert.ok(/MAX_OUTPUT|MAX_INPUT/.test(src), 'stdout accumulation must be capped');
  });
});

describe('platform -- codex-notify reports stats like the other adapters', () => {
  test('turn completion writes toolCalls/sessionStart into the state file', () => {
    const { tmp, stateFile, env } = makeTempEnv('notify-stats');
    try {
      execFileSync(process.execPath, [
        path.join(ROOT, 'adapters', 'codex-notify.js'),
        JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'notify-stats', 'last-assistant-message': 'done' }),
      ], { env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
      const st = readJSON(stateFile);
      assert.strictEqual(st.state, 'happy');
      assert.strictEqual(typeof st.toolCalls, 'number');
      assert.strictEqual(typeof st.sessionStart, 'number');
      assert.strictEqual(typeof st.dailySessions, 'number');
    } finally { cleanup(tmp); }
  });
});

// -- update-state.js robustness ----------------------------------------------

const UPDATE_STATE = path.join(ROOT, 'update-state.js');
function runHook(event, input, env) {
  execFileSync(process.execPath, [UPDATE_STATE, event], {
    input, env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('platform -- update-state.js catch path does not hijack another session\'s orbital', () => {
  test('empty stdin from a non-owner writes its own session file, not the owner\'s', () => {
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('caller-B');
    try {
      fs.mkdirSync(sessionsDir, { recursive: true });
      const ownerFile = path.join(sessionsDir, 'owner-A.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        state: 'coding', detail: 'editing x.js', timestamp: Date.now(), sessionId: 'owner-A',
      }), 'utf8');
      fs.writeFileSync(ownerFile, JSON.stringify({
        session_id: 'owner-A', state: 'coding', detail: 'editing x.js', timestamp: Date.now(),
      }), 'utf8');

      runHook('Notification', '', env);   // empty stdin -> JSON.parse throws -> catch path

      const owner = readJSON(ownerFile);
      assert.strictEqual(owner.state, 'coding', 'owner orbital must be untouched');
      assert.strictEqual(readJSON(stateFile).sessionId, 'owner-A', 'global owner must be untouched');
      const mine = readJSON(path.join(sessionsDir, 'caller-B.json'));
      assert.strictEqual(mine.state, 'waiting');
      assert.strictEqual(mine.session_id, 'caller-B');
    } finally { cleanup(tmp); }
  });
});

describe('platform -- update-state.js survives a degenerate stats file', () => {
  test('{} stats file: hook still writes state and repairs stats', () => {
    const { tmp, stateFile, statsFile, env } = makeTempEnv('stats-empty');
    try {
      fs.writeFileSync(statsFile, '{}', 'utf8');
      runHook('PreToolUse', JSON.stringify({ session_id: 'stats-empty', tool_name: 'Read', tool_input: { file_path: '/a/b.js' } }), env);
      assert.strictEqual(readJSON(stateFile).state, 'reading');
      const stats = readJSON(statsFile);
      assert.strictEqual(stats.session.id, 'stats-empty');
      assert.strictEqual(stats.session.toolCalls, 1);
    } finally { cleanup(tmp); }
  });
});

describe('platform -- update-state.js autolaunch uses the shared helpers', () => {
  const src = fs.readFileSync(UPDATE_STATE, 'utf8');
  test('takes the spawn lock before launching a renderer', () => {
    assert.ok(src.includes('acquireSpawnLock('));
  });
  test('builds terminal commands through shared buildRendererCommands', () => {
    assert.ok(src.includes('buildRendererCommands('));
    assert.ok(!src.includes("spawn('cmd', ['/c', 'start'"), 'no hand-rolled cmd /c start');
  });
  test('reads prefs through loadPrefs', () => {
    assert.ok(src.includes('loadPrefs()'));
    assert.ok(!src.includes('JSON.parse(fs.readFileSync(PREFS_FILE'));
  });
  test('state, session and stats writes are atomic', () => {
    const count = (src.match(/writeJsonAtomic\(/g) || []).length;
    assert.ok(count >= 3, `expected writeJsonAtomic in writeState/writeSessionState/writeStats, found ${count}`);
  });
});

// -- Renderer edge cases -----------------------------------------------------

describe('platform -- renderer.js source-level fixes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
  test('resize handler forces a redraw (prevFrame reset)', () => {
    const i = src.indexOf("process.stdout.on('resize'");
    assert.ok(i > 0);
    assert.ok(src.slice(i, i + 800).includes('prevFrame = null'), 'resize must reset prevFrame or the cleared screen stays blank');
  });
  test('prefs palette index is normalized', () => {
    assert.ok(src.includes('normalizePaletteIndex(prefs.paletteIndex'));
  });
  test('cleanup closes the file watchers and clears the session debounce timer', () => {
    const i = src.indexOf('function cleanup() {');
    const body = src.slice(i, i + 900);
    assert.ok(body.includes('stateWatcher'), 'cleanup should close stateWatcher');
    assert.ok(body.includes('sessionWatcher'), 'cleanup should close sessionWatcher');
    assert.ok(body.includes('clearTimeout(sessionWatchTimer)'));
  });
});

describe('platform -- face.js small terminals', () => {
  function withSize(cols, rows, fn) {
    const dc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    const dr = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true, writable: true });
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true, writable: true });
    try { return fn(); } finally {
      if (dc) Object.defineProperty(process.stdout, 'columns', dc); else delete process.stdout.columns;
      if (dr) Object.defineProperty(process.stdout, 'rows', dr); else delete process.stdout.rows;
    }
  }
  function maxCursorRow(out) {
    let max = 0;
    const re = /\x1b\[(\d+);(\d+)H/g;
    let m;
    while ((m = re.exec(out)) !== null) max = Math.max(max, parseInt(m[1], 10));
    return max;
  }
  test('too-small terminal clears lastPos so orbitals are not drawn over the resize message', () => {
    const f = new ClaudeFace();
    withSize(100, 40, () => f.render());
    assert.ok(f.lastPos, 'sanity: normal render sets lastPos');
    withSize(30, 10, () => f.render());
    assert.strictEqual(f.lastPos, null);
  });
  test('at the documented minimum (38x20) nothing is drawn below the last row', () => {
    const f = new ClaudeFace();
    f.showStats = true;
    const now = Date.now();
    // A real history so the timeline bar and sparkline actually render.
    f.timeline = [
      { state: 'idle', at: now - 90000 }, { state: 'reading', at: now - 70000 },
      { state: 'coding', at: now - 50000 }, { state: 'proud', at: now - 30000 },
      { state: 'testing', at: now - 10000 },
    ];
    f._timelineDirty = true;
    f.setState('coding', 'editing x.js');
    f.setStats({ toolCalls: 12, streak: 5, sessionStart: now - 60000 });
    const out = withSize(38, 20, () => f.render());
    assert.ok(maxCursorRow(out) <= 20, `cursor moved to row ${maxCursorRow(out)} on a 20-row terminal`);
  });
});

describe('platform -- grid.js caches', () => {
  test('_buildGroups is keyed on the visible set, not only on session reloads', () => {
    const sys = new grid.OrbitalSystem();
    const a = new grid.MiniFace('a'); const b = new grid.MiniFace('b'); const c = new grid.MiniFace('c');
    for (const m of [a, b, c]) { m.firstSeen = 1; sys.faces.set(m.sessionId, m); }
    const g3 = sys._buildGroups([a, b, c]);
    assert.strictEqual(g3.reduce((n, g) => n + g.members.length, 0), 3);
    const g2 = sys._buildGroups([a, b]);
    assert.strictEqual(g2.reduce((n, g) => n + g.members.length, 0), 2, 'shrinking the visible set must rebuild groups');
    const g3b = sys._buildGroups([a, b, c]);
    assert.strictEqual(g3b.reduce((n, g) => n + g.members.length, 0), 3);
  });
  test('_sweepPidCache evicts entries older than 3x TTL', () => {
    const now = Date.now();
    grid._pidStartCache.set(987654321, { value: 12345, resolvedAt: now - 4 * grid.PID_CACHE_TTL_MS });
    grid._pidStartCache.set(987654322, { value: 12345, resolvedAt: now - 1000 });
    grid._pidStartCache.set(987654323, { value: 'pending', resolvedAt: now - 4 * grid.PID_CACHE_TTL_MS });
    grid._sweepPidCache(now);
    assert.strictEqual(grid._pidStartCache.has(987654321), false, 'old resolved entry evicted');
    assert.strictEqual(grid._pidStartCache.has(987654322), true, 'fresh entry kept');
    assert.strictEqual(grid._pidStartCache.has(987654323), true, 'pending entries are never evicted');
    grid._pidStartCache.delete(987654322);
    grid._pidStartCache.delete(987654323);
  });
});

// -- setup.js ------------------------------------------------------------------

describe('platform -- setup.js is a module first, a CLI second', () => {
  test('requiring setup.js does not touch settings.json', () => {
    assert.strictEqual(settingsBeforeSetupRequire, false, 'precondition: no settings file in the test home');
    assert.strictEqual(fs.existsSync(path.join(process.env.HOME, '.claude', 'settings.json')), false);
  });
  test('exports the pieces tests and other tools need', () => {
    for (const k of ['setupClaude', 'uninstallClaude', 'buildFaceHooks', 'HOOK_EVENTS', 'enableAutolaunch']) {
      assert.strictEqual(typeof setup[k], k === 'HOOK_EVENTS' ? 'object' : 'function', k);
    }
    assert.ok(setup.HOOK_EVENTS.includes('UserPromptSubmit'));
    assert.strictEqual(setup.HOOK_EVENTS.length, 22);
  });
});

describe('platform -- setupClaude never clobbers settings.json', () => {
  const HOOK = '/repo/update-state.js';
  const quiet = { log: () => {} };
  function env() {
    const dir = tmpDir('crumb-setup-');
    return { dir, settingsPath: path.join(dir, '.claude', 'settings.json') };
  }

  test('fresh install writes every hook event', () => {
    const { dir, settingsPath } = env();
    try {
      const r = setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      assert.strictEqual(r.ok, true);
      const s = readJSON(settingsPath);
      assert.strictEqual(Object.keys(s.hooks).length, 22);
      assert.ok(s.hooks.UserPromptSubmit[0].hooks[0].command.includes(HOOK));
    } finally { cleanup(dir); }
  });

  test('merges into existing settings without touching unrelated keys or other hooks', () => {
    const { dir, settingsPath } = env();
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Bash(npm test)'] },
        env: { FOO: 'bar' },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-tool.js' }] }] },
      }), 'utf8');
      setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      const s = readJSON(settingsPath);
      assert.deepStrictEqual(s.permissions, { allow: ['Bash(npm test)'] });
      assert.deepStrictEqual(s.env, { FOO: 'bar' });
      assert.strictEqual(s.hooks.PreToolUse.length, 2);
      assert.strictEqual(s.hooks.PreToolUse[0].hooks[0].command, 'node other-tool.js');
    } finally { cleanup(dir); }
  });

  test('a corrupt settings.json aborts: nothing written, no backup made', () => {
    const { dir, settingsPath } = env();
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{ "permissions": { "allow": [ "trailing comma", ] } }', 'utf8');
      const before = fs.readFileSync(settingsPath, 'utf8');
      const r = setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), before, 'file must be byte-identical');
      assert.strictEqual(fs.existsSync(settingsPath + '.bak'), false);
    } finally { cleanup(dir); }
  });

  test('a settings.json that is not an object is treated as corrupt', () => {
    const { dir, settingsPath } = env();
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '[1,2,3]', 'utf8');
      const r = setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '[1,2,3]');
    } finally { cleanup(dir); }
  });

  test('re-running is idempotent', () => {
    const { dir, settingsPath } = env();
    try {
      setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      const r = setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      assert.strictEqual(r.modified, false);
      const s = readJSON(settingsPath);
      assert.strictEqual(s.hooks.PreToolUse.length, 1);
    } finally { cleanup(dir); }
  });

  test('a moved repo replaces the stale hook path instead of reporting "already installed"', () => {
    const { dir, settingsPath } = env();
    try {
      setup.setupClaude({ settingsPath, hookPath: '/old/place/update-state.js', ...quiet });
      const r = setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      assert.strictEqual(r.modified, true);
      assert.ok(r.replaced > 0);
      const s = readJSON(settingsPath);
      assert.strictEqual(s.hooks.PreToolUse.length, 1);
      assert.ok(s.hooks.PreToolUse[0].hooks[0].command.includes(HOOK));
      assert.ok(!JSON.stringify(s).includes('/old/place/'));
    } finally { cleanup(dir); }
  });

  test('a backup of the previous file is written before modifying', () => {
    const { dir, settingsPath } = env();
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const original = JSON.stringify({ permissions: { allow: [] } });
      fs.writeFileSync(settingsPath, original, 'utf8');
      setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      assert.strictEqual(fs.readFileSync(settingsPath + '.bak', 'utf8'), original);
    } finally { cleanup(dir); }
  });

  test('uninstallClaude removes only Code Crumb hooks and drops empty event arrays', () => {
    const { dir, settingsPath } = env();
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['x'] },
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-tool.js' }] }] },
      }), 'utf8');
      setup.setupClaude({ settingsPath, hookPath: '/somewhere/else/update-state.js', ...quiet });
      const r = setup.uninstallClaude({ settingsPath, ...quiet });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.removed, 22);
      const s = readJSON(settingsPath);
      assert.deepStrictEqual(Object.keys(s.hooks), ['PreToolUse']);
      assert.strictEqual(s.hooks.PreToolUse.length, 1);
      assert.strictEqual(s.hooks.PreToolUse[0].hooks[0].command, 'node other-tool.js');
      assert.deepStrictEqual(s.permissions, { allow: ['x'] });
    } finally { cleanup(dir); }
  });

  test('uninstallClaude on a corrupt file aborts without writing', () => {
    const { dir, settingsPath } = env();
    try {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, '{oops', 'utf8');
      const r = setup.uninstallClaude({ settingsPath, ...quiet });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readFileSync(settingsPath, 'utf8'), '{oops');
    } finally { cleanup(dir); }
  });
});

// -- Codex native hooks --------------------------------------------------
// Codex 0.146 has a stable hooks system with Claude-Code-shaped payloads, so
// the integration is hooks-first: setup writes ~/.codex/hooks.json (never the
// real one in tests) and the hook itself is told which editor it serves.

describe('platform -- setupCodex installs codex native hooks', () => {
  const quiet = { log: () => {} };
  const REPO = '/repo';
  function env() {
    const dir = tmpDir('crumb-codex-');
    return { dir, hooksPath: path.join(dir, '.codex', 'hooks.json') };
  }

  test('exports the codex installer pieces', () => {
    for (const k of ['setupCodex', 'uninstallCodex', 'buildCodexHooks']) {
      assert.strictEqual(typeof setup[k], 'function', k);
    }
    assert.ok(Array.isArray(setup.CODEX_HOOK_EVENTS));
  });

  test('CODEX_HOOK_EVENTS is exactly what codex 0.146 supports', () => {
    assert.deepStrictEqual(setup.CODEX_HOOK_EVENTS, [
      'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact',
      'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop',
      'UserPromptSubmit', 'Stop',
    ]);
    assert.ok(!setup.CODEX_HOOK_EVENTS.includes('Notification'),
      'codex has no Notification hook');
    assert.ok(!setup.CODEX_HOOK_EVENTS.includes('PostToolUseFailure'),
      'codex has no PostToolUseFailure hook');
  });

  test('buildCodexHooks tags every command with --editor codex', () => {
    const built = setup.buildCodexHooks(REPO);
    assert.deepStrictEqual(Object.keys(built.hooks), setup.CODEX_HOOK_EVENTS);
    for (const event of setup.CODEX_HOOK_EVENTS) {
      const cmd = built.hooks[event][0].hooks[0].command;
      assert.ok(cmd.includes('--editor codex'), `${event}: ${cmd}`);
      assert.ok(cmd.endsWith(` ${event}`), `${event}: ${cmd}`);
      assert.ok(cmd.includes('/repo/update-state.js'), `${event}: ${cmd}`);
      assert.strictEqual(built.hooks[event][0].hooks[0].timeout, 5);
    }
  });

  test('fresh install writes every codex hook event and nothing else', () => {
    const { dir, hooksPath } = env();
    try {
      const r = setup.setupCodex({ hooksPath, repoRoot: REPO, ...quiet });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.modified, true);
      const f = readJSON(hooksPath);
      assert.deepStrictEqual(Object.keys(f.hooks), setup.CODEX_HOOK_EVENTS);
      assert.ok(f.hooks.PreToolUse[0].hooks[0].command.includes('--editor codex'));
    } finally { cleanup(dir); }
  });

  test('re-running is idempotent and byte-identical', () => {
    const { dir, hooksPath } = env();
    try {
      setup.setupCodex({ hooksPath, repoRoot: REPO, ...quiet });
      const first = fs.readFileSync(hooksPath, 'utf8');
      const r = setup.setupCodex({ hooksPath, repoRoot: REPO, ...quiet });
      assert.strictEqual(r.modified, false);
      assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), first);
    } finally { cleanup(dir); }
  });

  test('an existing user hook survives the merge', () => {
    const { dir, hooksPath } = env();
    try {
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-tool.js' }] }] },
      }), 'utf8');
      setup.setupCodex({ hooksPath, repoRoot: REPO, ...quiet });
      const f = readJSON(hooksPath);
      assert.strictEqual(f.hooks.PreToolUse.length, 2);
      assert.strictEqual(f.hooks.PreToolUse[0].hooks[0].command, 'node other-tool.js');
    } finally { cleanup(dir); }
  });

  test('a stale hook path (the old hooks.json on this machine) is repaired', () => {
    const { dir, hooksPath } = env();
    try {
      setup.setupCodex({ hooksPath, repoRoot: '/old/place', ...quiet });
      const r = setup.setupCodex({ hooksPath, repoRoot: REPO, ...quiet });
      assert.ok(r.replaced > 0);
      const f = readJSON(hooksPath);
      assert.strictEqual(f.hooks.PreToolUse.length, 1);
      assert.ok(!JSON.stringify(f).includes('/old/place/'));
    } finally { cleanup(dir); }
  });

  test('a corrupt hooks.json aborts without touching the file', () => {
    const { dir, hooksPath } = env();
    try {
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, '{ "hooks": { ] }', 'utf8');
      const r = setup.setupCodex({ hooksPath, repoRoot: REPO, ...quiet });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readFileSync(hooksPath, 'utf8'), '{ "hooks": { ] }');
      assert.strictEqual(fs.existsSync(hooksPath + '.bak'), false);
    } finally { cleanup(dir); }
  });

  test('uninstallCodex removes only Code Crumb entries', () => {
    const { dir, hooksPath } = env();
    try {
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node other-tool.js' }] }] },
      }), 'utf8');
      setup.setupCodex({ hooksPath, repoRoot: REPO, ...quiet });
      const r = setup.uninstallCodex({ hooksPath, ...quiet });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.removed, setup.CODEX_HOOK_EVENTS.length);
      const f = readJSON(hooksPath);
      assert.deepStrictEqual(Object.keys(f.hooks), ['PreToolUse']);
      assert.strictEqual(f.hooks.PreToolUse[0].hooks[0].command, 'node other-tool.js');
    } finally { cleanup(dir); }
  });

  test('uninstallCodex on a missing file is a no-op, not an error', () => {
    const { dir, hooksPath } = env();
    try {
      const r = setup.uninstallCodex({ hooksPath, ...quiet });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.removed, 0);
      assert.strictEqual(fs.existsSync(hooksPath), false);
    } finally { cleanup(dir); }
  });
});

describe('platform -- update-state.js --editor flag', () => {
  const UPDATE_STATE = path.join(ROOT, 'update-state.js');

  function runHook(args, payload, extraEnv) {
    const base = makeTempEnv('flag-test');
    delete base.env.CLAUDE_SESSION_ID;
    const env = { ...base.env, ...(extraEnv || {}) };
    try {
      execFileSync(process.execPath, [UPDATE_STATE, ...args], {
        input: JSON.stringify(payload), env, timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    return base;
  }

  test('--editor codex stamps the editor, the model name and the session prefix', () => {
    const { tmp, stateFile } = runHook(['--editor', 'codex', 'PreToolUse'],
      { tool_name: 'Read', tool_input: { file_path: 'a.js' } });
    const state = readJSON(stateFile);
    assert.strictEqual(state.editor, 'codex');
    assert.strictEqual(state.modelName, 'codex');
    assert.ok(/^codex-/.test(state.sessionId), state.sessionId);
    assert.strictEqual(state.state, 'reading');
    cleanup(tmp);
  });

  test('--editor=codex works too', () => {
    const { tmp, stateFile } = runHook(['--editor=codex', 'PreToolUse'],
      { tool_name: 'Read', tool_input: { file_path: 'a.js' } });
    assert.strictEqual(readJSON(stateFile).editor, 'codex');
    cleanup(tmp);
  });

  test('CODE_CRUMB_EDITOR beats the flag', () => {
    const { tmp, stateFile } = runHook(['--editor', 'codex', 'PreToolUse'],
      { tool_name: 'Read', tool_input: { file_path: 'a.js' } },
      { CODE_CRUMB_EDITOR: 'opencode' });
    const state = readJSON(stateFile);
    assert.strictEqual(state.editor, 'opencode');
    assert.strictEqual(state.modelName, 'opencode');
    cleanup(tmp);
  });

  test('CODE_CRUMB_MODEL still beats the editor-derived model name', () => {
    const { tmp, stateFile } = runHook(['--editor', 'codex', 'PreToolUse'],
      { tool_name: 'Read', tool_input: { file_path: 'a.js' } },
      { CODE_CRUMB_MODEL: 'gpt-5.6' });
    const state = readJSON(stateFile);
    assert.strictEqual(state.editor, 'codex');
    assert.strictEqual(state.modelName, 'gpt-5.6');
    cleanup(tmp);
  });

  test('with no event positional the payload hook_event_name is honoured', () => {
    const { tmp, stateFile } = runHook(['--editor', 'codex'],
      { hook_event_name: 'Stop', session_id: 'codex-hen' });
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'responding');
    assert.strictEqual(state.stopped, true);
    cleanup(tmp);
  });

  test('the plain claude invocation is unchanged', () => {
    const { tmp, stateFile } = runHook(['PreToolUse'],
      { tool_name: 'Read', tool_input: { file_path: 'a.js' } });
    const state = readJSON(stateFile);
    assert.strictEqual(state.editor, 'claude');
    assert.strictEqual(state.modelName, 'claude');
    assert.strictEqual(state.state, 'reading');
    cleanup(tmp);
  });
});

// -- setup.js: OpenCode ---------------------------------------------------------
// OpenCode's config key is "plugin" (singular). The old setup printed a
// snippet telling people to write "plugins", which OpenCode ignores.

describe('platform -- setupOpenCode writes a real OpenCode config', () => {
  const PLUGIN = '/repo/adapters/opencode-plugin.mjs';
  const quiet = { log: () => {} };
  function env() {
    const dir = tmpDir('crumb-opencode-');
    return { dir, configPath: path.join(dir, '.config', 'opencode', 'opencode.json') };
  }

  test('exports the installer and the uninstaller', () => {
    assert.strictEqual(typeof setup.setupOpenCode, 'function');
    assert.strictEqual(typeof setup.uninstallOpenCode, 'function');
  });

  test('without --install it only prints: no config file is created', () => {
    const { dir, configPath } = env();
    try {
      const r = setup.setupOpenCode({ configPath, pluginPath: PLUGIN, ...quiet });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.modified, false);
      assert.strictEqual(fs.existsSync(configPath), false);
    } finally { cleanup(dir); }
  });

  test('install creates the config with the plugin key (never "plugins")', () => {
    const { dir, configPath } = env();
    try {
      const r = setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.modified, true);
      assert.strictEqual(r.added, 1);
      const c = readJSON(configPath);
      assert.deepStrictEqual(c.plugin, [PLUGIN]);
      assert.strictEqual(c.plugins, undefined, 'OpenCode reads "plugin", not "plugins"');
      assert.strictEqual(c.$schema, 'https://opencode.ai/config.json');
    } finally { cleanup(dir); }
  });

  test('install merges into an existing config without touching other keys', () => {
    const { dir, configPath } = env();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'anthropic/claude-sonnet-4',
        plugin: ['./plugins/other.js'],
      }), 'utf8');
      setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      const c = readJSON(configPath);
      assert.strictEqual(c.model, 'anthropic/claude-sonnet-4');
      assert.deepStrictEqual(c.plugin, ['./plugins/other.js', PLUGIN]);
    } finally { cleanup(dir); }
  });

  test('re-running install is idempotent', () => {
    const { dir, configPath } = env();
    try {
      setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      const r = setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      assert.strictEqual(r.modified, false);
      assert.deepStrictEqual(readJSON(configPath).plugin, [PLUGIN]);
    } finally { cleanup(dir); }
  });

  test('a moved repo replaces the stale plugin entry instead of adding a second one', () => {
    const { dir, configPath } = env();
    try {
      setup.setupOpenCode({ configPath, pluginPath: '/old/place/adapters/opencode-plugin.mjs', install: true, ...quiet });
      const r = setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      assert.strictEqual(r.replaced, 1);
      assert.deepStrictEqual(readJSON(configPath).plugin, [PLUGIN]);
    } finally { cleanup(dir); }
  });

  test('a [path, options] tuple entry is recognised as ours', () => {
    const { dir, configPath } = env();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ plugin: [[PLUGIN, { verbose: true }]] }), 'utf8');
      const r = setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      assert.strictEqual(r.modified, false);
      assert.deepStrictEqual(readJSON(configPath).plugin, [[PLUGIN, { verbose: true }]]);
    } finally { cleanup(dir); }
  });

  test('a corrupt opencode.json aborts: nothing written, no backup made', () => {
    const { dir, configPath } = env();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{ "plugin": [ "x", ] }', 'utf8');
      const before = fs.readFileSync(configPath, 'utf8');
      const r = setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), before, 'file must be byte-identical');
      assert.strictEqual(fs.existsSync(configPath + '.bak'), false);
    } finally { cleanup(dir); }
  });

  test('a config that is not an object is treated as corrupt', () => {
    const { dir, configPath } = env();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '"nope"', 'utf8');
      const r = setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), '"nope"');
    } finally { cleanup(dir); }
  });

  test('a backup of the previous config is written before modifying', () => {
    const { dir, configPath } = env();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const original = JSON.stringify({ model: 'x' });
      fs.writeFileSync(configPath, original, 'utf8');
      setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      assert.strictEqual(fs.readFileSync(configPath + '.bak', 'utf8'), original);
    } finally { cleanup(dir); }
  });

  test('uninstallOpenCode removes only our entry and drops an empty plugin array', () => {
    const { dir, configPath } = env();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify({ model: 'x', plugin: ['./plugins/other.js'] }), 'utf8');
      setup.setupOpenCode({ configPath, pluginPath: PLUGIN, install: true, ...quiet });
      const r = setup.uninstallOpenCode({ configPath, ...quiet });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.removed, 1);
      const c = readJSON(configPath);
      assert.deepStrictEqual(c.plugin, ['./plugins/other.js']);
      assert.strictEqual(c.model, 'x');

      // Removing the last entry drops the key entirely.
      fs.writeFileSync(configPath, JSON.stringify({ plugin: [PLUGIN] }), 'utf8');
      const r2 = setup.uninstallOpenCode({ configPath, ...quiet });
      assert.strictEqual(r2.removed, 1);
      assert.strictEqual(readJSON(configPath).plugin, undefined);
    } finally { cleanup(dir); }
  });

  test('uninstallOpenCode on a config without our entry changes nothing', () => {
    const { dir, configPath } = env();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      const original = JSON.stringify({ plugin: ['./plugins/other.js'] });
      fs.writeFileSync(configPath, original, 'utf8');
      const r = setup.uninstallOpenCode({ configPath, ...quiet });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.removed, 0);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    } finally { cleanup(dir); }
  });

  test('uninstallOpenCode on a corrupt file aborts without writing', () => {
    const { dir, configPath } = env();
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, '{oops', 'utf8');
      const r = setup.uninstallOpenCode({ configPath, ...quiet });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), '{oops');
    } finally { cleanup(dir); }
  });

  test('the printed instructions no longer carry the broken inline snippet', () => {
    const src = fs.readFileSync(path.join(ROOT, 'setup.js'), 'utf8');
    assert.ok(!src.includes('"plugins"'), 'the "plugins" key does not exist in OpenCode');
    assert.ok(!src.includes('lastMessageContent'), 'the hand-written snippet is replaced by the shipped plugin');
    assert.ok(src.includes('opencode-plugin.mjs'));
  });
});

// -- Third review pass (Sep 2026) --------------------------------------------
// Each block below was reproduced against the pre-fix sources first.

describe('platform -- third review pass: setup keeps the user\'s own hooks', () => {
  const quiet = { log: () => {} };
  const HOOK = '/repo/update-state.js';
  function env() {
    const dir = tmpDir('crumb-setup3-');
    return { dir, settingsPath: path.join(dir, '.claude', 'settings.json') };
  }
  function seed(settingsPath, obj) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(obj), 'utf8');
  }
  const shared = (ours) => ({ hooks: { PreToolUse: [{ matcher: '', hooks: [
    { type: 'command', command: '~/bin/audit-log.sh' },
    { type: 'command', command: `node "${ours}" PreToolUse` },
  ] }] } });

  test('uninstall removes our command from a shared matcher group, not the group', () => {
    const { dir, settingsPath } = env();
    try {
      seed(settingsPath, shared('/old/code-crumb/update-state.js'));
      const r = setup.uninstallClaude({ settingsPath, ...quiet });
      assert.strictEqual(r.removed, 1);
      const s = readJSON(settingsPath);
      assert.deepStrictEqual(s.hooks.PreToolUse, [{ matcher: '', hooks: [{ type: 'command', command: '~/bin/audit-log.sh' }] }]);
    } finally { cleanup(dir); }
  });

  test('a moved-repo repair keeps the co-located user hook', () => {
    const { dir, settingsPath } = env();
    try {
      seed(settingsPath, shared('/old/code-crumb/update-state.js'));
      setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      const cmds = readJSON(settingsPath).hooks.PreToolUse.flatMap(e => e.hooks.map(h => h.command));
      assert.ok(cmds.includes('~/bin/audit-log.sh'));
      assert.ok(cmds.some(c => c.includes(HOOK)));
      assert.ok(!cmds.some(c => c.includes('/old/code-crumb/')));
    } finally { cleanup(dir); }
  });

  test('an unrelated script named update-state.js is not ours', () => {
    const { dir, settingsPath } = env();
    try {
      const theirs = { matcher: 'Bash', hooks: [
        { type: 'command', command: 'node ~/dotfiles/tmux/update-state.js' },
        { type: 'command', command: 'node ~/.tmux/update-state.js busy' },   // one word, not an event
      ] };
      seed(settingsPath, { hooks: { PreToolUse: [theirs] } });
      setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
      assert.deepStrictEqual(readJSON(settingsPath).hooks.PreToolUse[0], theirs);
      const r = setup.uninstallClaude({ settingsPath, ...quiet });
      assert.strictEqual(r.removed, 22);
      assert.deepStrictEqual(readJSON(settingsPath).hooks.PreToolUse, [theirs]);
    } finally { cleanup(dir); }
  });

  test('the codex installer and uninstaller follow the same rule', () => {
    const dir = tmpDir('crumb-codex3-');
    const hooksPath = path.join(dir, '.codex', 'hooks.json');
    try {
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({ hooks: {
        // Notification is pruned (codex does not fire it) -- the user's hook stays.
        Notification: [{ matcher: '', hooks: [
          { type: 'command', command: 'notify-send hi' },
          { type: 'command', command: 'node "/old/update-state.js" --editor codex Notification' },
        ] }],
      } }), 'utf8');
      const r = setup.setupCodex({ hooksPath, repoRoot: '/repo', ...quiet });
      assert.strictEqual(r.pruned, 1);
      assert.deepStrictEqual(readJSON(hooksPath).hooks.Notification,
        [{ matcher: '', hooks: [{ type: 'command', command: 'notify-send hi' }] }]);
      setup.uninstallCodex({ hooksPath, ...quiet });
      assert.deepStrictEqual(Object.keys(readJSON(hooksPath).hooks), ['Notification']);
    } finally { cleanup(dir); }
  });

  if (process.platform !== 'win32') {
    test('a read-only settings file does not freeze the backup', () => {
      const { dir, settingsPath } = env();
      try {
        seed(settingsPath, { v: 1 });
        fs.chmodSync(settingsPath, 0o444);
        setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
        fs.chmodSync(settingsPath, 0o644);
        fs.writeFileSync(settingsPath, JSON.stringify({ v: 2, hooks: readJSON(settingsPath).hooks }));
        fs.chmodSync(settingsPath, 0o444);
        setup.uninstallClaude({ settingsPath, ...quiet });
        assert.strictEqual(readJSON(settingsPath + '.bak').v, 2, 'the second run refreshed the backup');
        assert.strictEqual(fs.statSync(settingsPath + '.bak').mode & 0o777, 0o600);
      } finally { cleanup(dir); }
    });

    test('the backup is no more readable than the settings file', () => {
      const { dir, settingsPath } = env();
      try {
        seed(settingsPath, { env: { ANTHROPIC_API_KEY: 'secret' } });
        fs.chmodSync(settingsPath, 0o600);
        fs.writeFileSync(settingsPath + '.bak', 'old', { mode: 0o644 });
        fs.chmodSync(settingsPath + '.bak', 0o644);   // a leftover from an earlier run
        setup.setupClaude({ settingsPath, hookPath: HOOK, ...quiet });
        assert.strictEqual(fs.statSync(settingsPath + '.bak').mode & 0o777, 0o600);
        assert.ok(fs.readFileSync(settingsPath + '.bak', 'utf8').includes('secret'));
      } finally { cleanup(dir); }
    });
  }
});

describe('platform -- third review pass: setup CLI', () => {
  const SETUP = path.join(ROOT, 'setup.js');
  function run(args) {
    const dir = tmpDir('crumb-cli-');
    const env = { ...process.env, HOME: dir, USERPROFILE: dir };
    let status = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [SETUP, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).toString();
    } catch (e) { status = e.status; out = String(e.stdout || ''); }
    return { dir, status, out };
  }

  test('--help prints usage and installs nothing', () => {
    const r = run(['--help']);
    try {
      assert.strictEqual(r.status, 0);
      assert.ok(r.out.includes('Usage:'));
      assert.strictEqual(fs.existsSync(path.join(r.dir, '.claude', 'settings.json')), false);
    } finally { cleanup(r.dir); }
  });

  test('`codex --uninstall` refuses instead of installing the codex hooks', () => {
    const r = run(['codex', '--uninstall']);
    try {
      assert.strictEqual(r.status, 1);
      assert.strictEqual(fs.existsSync(path.join(r.dir, '.codex', 'hooks.json')), false);
    } finally { cleanup(r.dir); }
  });

  test('an unknown option is an error, not a silent Claude install', () => {
    const r = run(['--bogus']);
    try {
      assert.strictEqual(r.status, 1);
      assert.ok(r.out.includes('Unknown option'));
      assert.strictEqual(fs.existsSync(path.join(r.dir, '.claude', 'settings.json')), false);
    } finally { cleanup(r.dir); }
  });

  test('the plugin hint points an npm install (no .claude-plugin/) at GitHub', () => {
    const dir = tmpDir('crumb-hint-');
    const local = `marketplace add "${path.resolve(dir).replace(/\\/g, '/')}"`;
    try {
      const lines = [];
      setup.printClaudeUsage('/x/settings.json', (l) => lines.push(l), dir);
      const out = lines.join('\n');
      assert.ok(!out.includes(local), 'this folder is no marketplace');
      assert.ok(out.includes('marketplace add Skelly0/code-crumb'));
      assert.ok(out.includes('ONE of the two'), 'the double-install warning stays');
      fs.mkdirSync(path.join(dir, '.claude-plugin'));
      fs.writeFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), '{}');
      const again = [];
      setup.printClaudeUsage('/x/settings.json', (l) => again.push(l), dir);
      assert.ok(again.join('\n').includes(local), 'a clone still points at itself');
    } finally { cleanup(dir); }
  });

  test('enabling autolaunch clears the renderer\'s quit flag', () => {
    const dir = tmpDir('crumb-quit-');
    try {
      const flag = path.join(dir, '.code-crumb-quit');
      fs.writeFileSync(flag, '1');
      setup.enableAutolaunch(() => {}, flag);
      assert.strictEqual(fs.existsSync(flag), false);
    } finally { cleanup(dir); }
  });
});

describe('platform -- third review pass: shared helpers', () => {
  test('quoteArg doubles backslashes that end up before a quote at a % splice', () => {
    assert.strictEqual(shared.quoteArg('a\\%b'), '"a\\\\"^%"b"');
    assert.strictEqual(shared.quoteArg('C:\\temp\\%USERNAME%\\log'),
      '"C:\\temp\\\\"^%"USERNAME"^%"\\log"');
    assert.strictEqual(shared.quoteArg('50% off'), '"50"^%" off"', 'unchanged without a backslash');
  });

  test('detailText drops C0 and C1 controls (U+009B alone is a CSI)', () => {
    assert.strictEqual(shared.detailText('edit \u009b1;1Hpwned\u009b2K.js'), 'edit 1;1Hpwned2K.js');
    assert.strictEqual(shared.detailText('a\u001b[31mb'), 'a[31mb');
    assert.strictEqual(shared.detailText('line\nnext'), 'line next');
    assert.strictEqual(shared.detailText('caf\u00e9'), 'caf\u00e9', 'printable non-ASCII stays');
    assert.strictEqual(shared.detailText({ a: 1 }), '');
  });

  test('getGitBranch resolves a submodule\'s relative gitdir from its own folder', () => {
    const dir = tmpDir('crumb-gitsub-');
    try {
      const sup = path.join(dir, 'super');
      fs.mkdirSync(path.join(sup, '.git', 'modules', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(sup, '.git', 'HEAD'), 'ref: refs/heads/supermain\n');
      fs.writeFileSync(path.join(sup, '.git', 'modules', 'lib', 'HEAD'), 'ref: refs/heads/feature-x\n');
      fs.mkdirSync(path.join(sup, 'lib', 'src'), { recursive: true });
      fs.writeFileSync(path.join(sup, 'lib', '.git'), 'gitdir: ../.git/modules/lib\n');
      assert.strictEqual(shared.getGitBranch(path.join(sup, 'lib', 'src')), 'feature-x');
      assert.strictEqual(shared.getGitBranch(path.join(sup, 'lib')), 'feature-x');
    } finally { cleanup(dir); }
  });

  test('a prefs file holding null reads as {} and is repaired by the next save', () => {
    let before = null;
    try { before = fs.readFileSync(shared.PREFS_FILE, 'utf8'); } catch {}
    try {
      fs.writeFileSync(shared.PREFS_FILE, 'null');
      assert.deepStrictEqual(shared.loadPrefs(), {});
      shared.savePrefs({ showStats: true });
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(shared.PREFS_FILE, 'utf8')), { showStats: true });
      fs.writeFileSync(shared.PREFS_FILE, '[1,2]');
      assert.deepStrictEqual(shared.loadPrefs(), {});
    } finally {
      if (before === null) { try { fs.unlinkSync(shared.PREFS_FILE); } catch {} }
      else fs.writeFileSync(shared.PREFS_FILE, before);
    }
  });

  describe('platform -- third review pass: the stale spawn-lock takeover is exclusive', () => {
    function staleLock(dir) {
      const lock = path.join(dir, 'spawn.lock');
      fs.writeFileSync(lock, '1');
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(lock, old, old);
      return lock;
    }
    test('a takeover in progress (fresh claim) makes the others back off', () => {
      const dir = tmpDir('crumb-claim-');
      try {
        const lock = staleLock(dir);
        fs.writeFileSync(lock + '.claim', '2');
        assert.strictEqual(shared.acquireSpawnLock(lock, 5000), false);
      } finally { cleanup(dir); }
    });
    test('the winner leaves no claim behind', () => {
      const dir = tmpDir('crumb-claim-');
      try {
        const lock = staleLock(dir);
        assert.strictEqual(shared.acquireSpawnLock(lock, 5000), true);
        assert.strictEqual(fs.existsSync(lock + '.claim'), false);
        assert.strictEqual(shared.acquireSpawnLock(lock, 5000), false, 'the lock is fresh again');
      } finally { cleanup(dir); }
    });
    test('a claim left by a crashed hook is cleared, and the next hook takes over', () => {
      const dir = tmpDir('crumb-claim-');
      try {
        const lock = staleLock(dir);
        fs.writeFileSync(lock + '.claim', '2');
        const old = new Date(Date.now() - 60000);
        fs.utimesSync(lock + '.claim', old, old);
        assert.strictEqual(shared.acquireSpawnLock(lock, 5000), false);
        assert.strictEqual(fs.existsSync(lock + '.claim'), false);
        assert.strictEqual(shared.acquireSpawnLock(lock, 5000), true);
      } finally { cleanup(dir); }
    });
    test.async('8 hooks racing for one stale lock: exactly one wins', async () => {
      const dir = tmpDir('crumb-claim-');
      try {
        for (let trial = 0; trial < 5; trial++) {
          const lock = staleLock(dir);
          const at = Date.now() + 400;
          const worker = `const s=require(${JSON.stringify(path.join(ROOT, 'lib', 'shared.js'))});` +
            `while(Date.now()<${at}){}process.stdout.write(s.acquireSpawnLock(${JSON.stringify(lock)},5000)?'1':'0')`;
          const outs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
            const c = spawn(process.execPath, ['-e', worker], { stdio: ['ignore', 'pipe', 'ignore'] });
            let o = '';
            c.stdout.on('data', d => { o += d; });
            c.on('close', () => resolve(o));
          })));
          assert.strictEqual(outs.filter(o => o === '1').length, 1, `trial ${trial}: ${outs.join('')}`);
          fs.unlinkSync(lock);
        }
      } finally { cleanup(dir); }
    });
  });
});

describe('platform -- third review pass: launchers', () => {
  test('source: launch.js reports a signal-killed editor as 128+N, not 0', () => {
    const src = fs.readFileSync(path.join(ROOT, 'launch.js'), 'utf8');
    assert.ok(/child\.on\('exit', \(code, signal\) =>/.test(src));
    assert.ok(src.includes('128 + n'));
  });

  if (process.platform !== 'win32') {
    test('code-crumb.sh finds launch.js through a symlink on PATH (the README install)', () => {
      const dir = tmpDir('crumb-link-');
      try {
        fs.mkdirSync(path.join(dir, 'bin'));
        fs.symlinkSync(path.join(ROOT, 'code-crumb.sh'), path.join(dir, 'bin', 'code-crumb'));
        fs.mkdirSync(path.join(dir, 'bin2'));
        fs.symlinkSync('../bin/code-crumb', path.join(dir, 'bin2', 'cc'));  // relative, chained
        const version = require('../package.json').version;
        for (const link of [path.join(dir, 'bin', 'code-crumb'), path.join(dir, 'bin2', 'cc')]) {
          const out = execFileSync(link, ['--version'], { timeout: 10000 }).toString().trim();
          assert.strictEqual(out, version);
        }
      } finally { cleanup(dir); }
    });
  }
});

module.exports = suite;
