#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - Platform and hook robustness            |
// |                                                                  |
// |  Cross-platform launching (quoting, .cmd shims, spaces in       |
// |  paths), atomic state writes, spawn locking, stats-file          |
// |  resilience, setup.js safety (never clobber settings.json),      |
// |  adapter parity with update-state.js, and the small renderer    |
// |  edge cases (resize, tiny terminals, stale caches).              |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;
const { makeTempEnv, cleanup, readJSON } = require('./_harness');

const ROOT = path.join(__dirname, '..');
const shared = require('../shared');
const sm = require('../state-machine');
const launch = require('../launch');
const themes = require('../themes');
const { ClaudeFace } = require('../face');
const grid = require('../grid');
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
  test('quoteArg escapes embedded double quotes', () => {
    assert.strictEqual(shared.quoteArg('say "hi"'), '"say \\"hi\\""');
  });
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
  test('codex-wrapper no longer blanks the subagent cwd or imports unused path', () => {
    const src = read('adapters/codex-wrapper.js');
    assert.ok(!src.includes("cwd: ''"), "subExtra must not set cwd: ''");
    assert.ok(!src.includes("require('path')"), 'unused path import');
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
    assert.strictEqual(setup.HOOK_EVENTS.length, 21);
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
      assert.strictEqual(Object.keys(s.hooks).length, 21);
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
      assert.strictEqual(r.removed, 21);
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

module.exports = suite;
