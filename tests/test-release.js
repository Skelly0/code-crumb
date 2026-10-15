'use strict';

// +================================================================+
// |  Code Crumb Test Suite - release, packaging and the runner     |
// |  What a release ships: every local file the entry points can   |
// |  reach is in package.json "files", the two plugin.json copies  |
// |  match, hooks/hooks.json registers exactly HOOK_EVENTS, every  |
// |  npm script names a real file, and the versions agree. Then    |
// |  the runner's own contract (the direct-run guard, one HOME per |
// |  file in parallel) and `node setup.js doctor`.                 |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;

const { cleanup } = require('./_harness');
const setup = require('../setup');
const { TEST_MODULES } = require('./run');

const REPO = path.join(__dirname, '..');
const RUN_JS = path.join(__dirname, 'run.js');
const NODE = process.execPath;
// The doctor's markers, spelled by code point (escapes stay out of literals).
const TICK = String.fromCharCode(0x2713);
const DOT = String.fromCharCode(0x00b7);

const readJson = rel => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const toPosix = p => p.split(path.sep).join('/');
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

// -- Packaging helpers -------------------------------------------------

// Relative specifiers of every require / import / import() / export-from.
const SPECIFIER_RES = [
  /\brequire\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
  /\bimport\s+(?:[^'";]*?\s+from\s+)?(['"])(\.{1,2}\/[^'"]+)\1/g,
  /\bimport\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g,
  /\bexport\s+[^'";]*?\s+from\s+(['"])(\.{1,2}\/[^'"]+)\1/g,
];
// Files started by path rather than required -- the renderer a hook opens,
// the adapter the OpenCode plugin spawns, the scripts setup.js prints:
// path.join/resolve(__dirname, 'a', 'b.js') and the ESM spelling of the
// same, path.dirname(fileURLToPath(import.meta.url)).
const BY_PATH_RE = /path\.(?:join|resolve)\(\s*(?:__dirname|path\.dirname\(fileURLToPath\(import\.meta\.url\)\))\s*((?:,\s*'[^']*'\s*)+)\)/g;

function resolveLocal(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const p of [base, base + '.js', base + '.mjs', base + '.cjs', base + '.json', path.join(base, 'index.js')]) {
    if (isFile(p)) return p;
  }
  return null;
}

// Walk the local graph from `entries` (repo-relative). Returns the reached
// files (repo-relative, forward slashes) and any require/import that names
// a file that is not there.
function walkGraph(entries) {
  const seen = new Set();
  const unresolved = [];
  const queue = entries.map(e => path.join(REPO, e));
  while (queue.length) {
    const file = queue.shift();
    const rel = toPosix(path.relative(REPO, file));
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.(c|m)?js$/.test(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const re of SPECIFIER_RES) {
      for (const m of src.matchAll(re)) {
        const hit = resolveLocal(file, m[2]);
        if (hit) queue.push(hit);
        else unresolved.push(`${rel}: ${m[2]}`);
      }
    }
    for (const m of src.matchAll(BY_PATH_RE)) {
      const segs = [...m[1].matchAll(/'([^']*)'/g)].map(s => s[1]);
      const hit = path.resolve(path.dirname(file), ...segs);
      if (isFile(hit)) queue.push(hit);
    }
  }
  return { files: [...seen].sort(), unresolved };
}

// npm's "files" semantics, as far as this package uses them: an entry
// names a file, or a directory (with or without a trailing slash) whose
// whole tree ships; `*` / `**` globs for good measure. package.json,
// README, LICENSE and the main/bin files ship whatever "files" says.
function coveredByFiles(rel, pkg) {
  const always = new Set(['package.json', toPosix(pkg.main || '').replace(/^\.\//, '')]);
  for (const b of Object.values(typeof pkg.bin === 'string' ? { x: pkg.bin } : pkg.bin || {})) {
    always.add(toPosix(b).replace(/^\.\//, ''));
  }
  if (always.has(rel) || /^(README|LICEN[CS]E)(\.|$)/i.test(rel)) return true;
  return (pkg.files || []).some(entry => {
    const e = toPosix(entry).replace(/^\.\//, '').replace(/\/+$/, '');
    if (e.includes('*')) {
      const re = new RegExp('^' + e.split('**').map(part =>
        part.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '(/.*)?$');
      return re.test(rel);
    }
    return rel === e || rel.startsWith(e + '/');
  });
}

const ENTRY_POINTS = ['renderer.js', 'update-state.js', 'launch.js', 'setup.js']
  .concat(fs.readdirSync(path.join(REPO, 'adapters'))
    .filter(f => /\.(js|mjs)$/.test(f))
    .map(f => 'adapters/' + f));

// -- Packaging ---------------------------------------------------------

describe('release -- the npm package ships everything it runs', () => {
  const pkg = readJson('package.json');
  const graph = walkGraph(ENTRY_POINTS);

  test('the walker reaches lib/ and the files started by path', () => {
    for (const f of ['lib/shared.js', 'lib/face.js', 'lib/grid.js', 'lib/state-machine.js',
      'adapters/opencode-adapter.js', 'adapters/base-adapter.js', 'package.json']) {
      assert.ok(graph.files.includes(f), `${f} not reached; got ${graph.files.join(', ')}`);
    }
  });

  test('every require/import in the graph resolves', () => {
    assert.deepStrictEqual(graph.unresolved, []);
  });

  test('every reached file is covered by package.json "files"', () => {
    assert.deepStrictEqual(graph.files.filter(f => !coveredByFiles(f, pkg)), []);
  });

  test('the coverage check fails when a shipped directory is dropped', () => {
    const without = { ...pkg, files: pkg.files.filter(f => !/^lib\/?$/.test(f)) };
    const uncovered = graph.files.filter(f => !coveredByFiles(f, without));
    assert.ok(uncovered.includes('lib/shared.js'), `got ${uncovered.join(', ')}`);
  });

  test('coveredByFiles follows npm: directories, files, globs, always-packed', () => {
    const p = { main: 'renderer.js', bin: { x: './launch.js' }, files: ['lib/', 'hooks', 'setup.js', 'adapters/*.js'] };
    assert.ok(coveredByFiles('lib/a/b.js', p));
    assert.ok(coveredByFiles('hooks/hooks.json', p));
    assert.ok(!coveredByFiles('libx.js', p));
    assert.ok(coveredByFiles('setup.js', p));
    assert.ok(!coveredByFiles('setup.json', p));
    assert.ok(coveredByFiles('adapters/x.js', p));
    assert.ok(!coveredByFiles('adapters/x.mjs', p));
    assert.ok(coveredByFiles('package.json', p));
    assert.ok(coveredByFiles('renderer.js', p));
    assert.ok(coveredByFiles('launch.js', p));
    assert.ok(coveredByFiles('README.md', p));
  });

  test('the demos and tests stay out of the tarball', () => {
    for (const f of ['demo/single.js', 'tests/run.js', 'images/sleeping.png', 'CLAUDE.md']) {
      assert.ok(!coveredByFiles(f, pkg), `${f} would ship`);
    }
  });

  test('every "files" entry exists', () => {
    for (const entry of pkg.files) {
      assert.ok(fs.existsSync(path.join(REPO, entry)), `"files" names ${entry}, which is missing`);
    }
  });

  test('main and bin exist; bin is a node script', () => {
    assert.ok(isFile(path.join(REPO, pkg.main)), pkg.main);
    for (const bin of Object.values(pkg.bin)) {
      const src = fs.readFileSync(path.join(REPO, bin), 'utf8');
      assert.ok(src.startsWith('#!/usr/bin/env node'), `${bin} has no node shebang`);
    }
  });

  test('every npm script that runs node names a file that exists', () => {
    let checked = 0;
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      for (const segment of cmd.split(/&&|\|\||;/)) {
        const tokens = segment.trim().split(/\s+/);
        if (tokens[0] !== 'node') continue;
        const file = tokens.slice(1).find(t => !t.startsWith('-'));
        assert.ok(file && isFile(path.join(REPO, file)), `script "${name}" runs ${file}, which is missing`);
        checked++;
      }
    }
    const nodeScripts = Object.values(pkg.scripts).filter(c => /(^|\s)node\s/.test(c)).length;
    assert.ok(checked >= nodeScripts && nodeScripts > 0, `${checked} checked of ${nodeScripts}`);
  });

  test('npm run doctor runs the read-only diagnostic', () => {
    assert.strictEqual(pkg.scripts.doctor, 'node setup.js doctor');
  });
});

describe('release -- the Claude Code plugin', () => {
  test('the two plugin.json copies are byte-identical', () => {
    // The plugin cache reads the root copy, the marketplace the other.
    const a = fs.readFileSync(path.join(REPO, 'plugin.json'));
    const b = fs.readFileSync(path.join(REPO, '.claude-plugin', 'plugin.json'));
    assert.ok(a.equals(b), 'plugin.json and .claude-plugin/plugin.json differ');
  });

  test('package.json, both plugin.json copies and the marketplace agree on the version', () => {
    // Claude Code keeps a cached plugin while this string is unchanged, so a
    // release that forgets one copy never reaches plugin users.
    const version = readJson('package.json').version;
    assert.ok(/^\d+\.\d+\.\d+$/.test(version), version);
    assert.strictEqual(readJson('plugin.json').version, version);
    assert.strictEqual(readJson('.claude-plugin/plugin.json').version, version);
    for (const p of readJson('.claude-plugin/marketplace.json').plugins || []) {
      if (p.version !== undefined) assert.strictEqual(p.version, version, `marketplace entry ${p.name}`);
    }
  });

  test('plugin.json points at hooks/hooks.json', () => {
    const manifest = readJson('plugin.json');
    assert.strictEqual(manifest.hooks, './hooks/hooks.json');
    assert.ok(isFile(path.join(REPO, 'hooks', 'hooks.json')));
  });

  test('hooks/hooks.json registers exactly setup.js HOOK_EVENTS', () => {
    const events = Object.keys(readJson('hooks/hooks.json').hooks);
    assert.strictEqual(new Set(setup.HOOK_EVENTS).size, setup.HOOK_EVENTS.length, 'HOOK_EVENTS has a duplicate');
    assert.deepStrictEqual(events.slice().sort(), setup.HOOK_EVENTS.slice().sort());
  });

  test('each plugin hook is one command running update-state.js from the plugin root', () => {
    const hooks = readJson('hooks/hooks.json').hooks;
    const prefix = 'node "${CLAUDE_PLUGIN_ROOT}/update-state.js" ';
    for (const event of setup.HOOK_EVENTS) {
      const commands = (hooks[event] || []).flatMap(g => g.hooks || []);
      assert.strictEqual(commands.length, 1, `${event}: ${commands.length} commands (each one fires)`);
      assert.strictEqual(commands[0].type, 'command', event);
      const cmd = commands[0].command;
      assert.ok(cmd.startsWith(prefix), `${event}: ${cmd}`);
      assert.strictEqual(cmd.trim().split(/\s+/).pop(), event, `${event}: ${cmd}`);
    }
  });
});

// -- The runner ----------------------------------------------------------

describe('release -- test files are only run through tests/run.js', () => {
  const testFiles = fs.readdirSync(__dirname).filter(f => /^test-.*\.js$/.test(f));

  test('no test file carries a shebang (they are not meant to be executed)', () => {
    const withShebang = testFiles.filter(f => fs.readFileSync(path.join(__dirname, f), 'utf8').startsWith('#!'));
    assert.deepStrictEqual(withShebang, []);
  });

  test('every tests/test-*.js is registered in run.js', () => {
    const registered = TEST_MODULES.map(m => path.basename(m));
    assert.deepStrictEqual(testFiles.filter(f => !registered.includes(f)), []);
    assert.deepStrictEqual(registered.filter(f => !testFiles.includes(f)), []);
  });

  // A home of its own, so even a guard that failed to fire could not
  // reach the real ~/.code-crumb* files.
  function directRun(markerFor) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-direct-'));
    const env = { ...process.env, HOME: tmp, USERPROFILE: tmp, CODE_CRUMB_STATE: path.join(tmp, '.code-crumb-state') };
    delete env.CRUMB_TEST_HOME;
    delete env.CRUMB_TEST_QUIET; // so a run that slipped through would print ticks
    if (markerFor) env.CRUMB_TEST_HOME = markerFor(tmp);
    try {
      return spawnSync(NODE, [path.join(__dirname, 'test-shared.js')], { env, encoding: 'utf8', timeout: 30000 });
    } finally {
      cleanup(tmp);
    }
  }

  test('a test file run directly refuses to start, and says how to run it', () => {
    const r = directRun(null);
    assert.strictEqual(r.status, 1, `status ${r.status}; stdout: ${r.stdout}`);
    assert.ok(r.stderr.includes('node tests/run.js shared'), r.stderr);
    assert.ok(!r.stdout.includes(TICK), 'tests ran anyway');
  });

  test('a marker that does not name the current HOME is refused too', () => {
    const r = directRun(tmp => path.join(tmp, 'elsewhere'));
    assert.strictEqual(r.status, 1, `status ${r.status}`);
    assert.ok(!r.stdout.includes(TICK), 'tests ran anyway');
  });
});

describe('release -- the parallel runner', () => {
  // Throwaway test files, run through tests/run.js's CRUMB_TEST_FILES seam.
  const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-runner-'));
  const out = path.join(fx, 'out');
  fs.mkdirSync(out);
  const HARNESS = JSON.stringify(path.join(__dirname, '_harness.js'));
  const OUT = JSON.stringify(out);
  const fixture = (name, body) => {
    const file = path.join(fx, name);
    fs.writeFileSync(file, [
      "'use strict';",
      "const fs = require('fs');",
      "const path = require('path');",
      `const suite = require(${HARNESS}).createSuite();`,
      'const { test } = suite;',
      body,
      'module.exports = suite;',
      '',
    ].join('\n'));
    return file;
  };
  const recordHome = tag =>
    `fs.writeFileSync(path.join(${OUT}, '${tag}.home'), JSON.stringify({ home: process.env.HOME, isolated: process.env.CRUMB_TEST_HOME === process.env.HOME }));`;
  const readHome = tag => JSON.parse(fs.readFileSync(path.join(out, `${tag}.home`), 'utf8'));

  // pass-a finishes last (it waits), yet must still print first.
  const passA = fixture('pass-a.js', [
    `test('alpha one', () => { ${recordHome('a')} });`,
    "test.async('alpha two', () => new Promise(r => setTimeout(r, 400)));",
  ].join('\n'));
  const passB = fixture('pass-b.js', `test('beta one', () => { ${recordHome('b')} });`);
  const failing = fixture('fail.js', [
    "test('gamma passes', () => {});",
    "test('gamma expected failure', () => { throw new Error('this failure is the fixture'); });",
  ].join('\n'));
  const broken = fixture('broken.js', "throw new Error('broken at load');");
  const crash = fixture('crash.js',
    "test.async('dies mid-test', () => new Promise(() => setTimeout(() => { throw new Error('async crash'); }, 20)));");

  function runner(args, files) {
    const env = { ...process.env, CRUMB_TEST_FILES: files.join(path.delimiter) };
    delete env.CRUMB_TEST_QUIET;
    for (const f of fs.readdirSync(out)) fs.unlinkSync(path.join(out, f));
    const r = spawnSync(NODE, [RUN_JS, ...args], { env, encoding: 'utf8', timeout: 60000 });
    // Colour stripped, so the assertions read plainly.
    r.text = (r.stdout || '').replace(/\x1b\[[0-9;]*m/g, '');
    return r;
  }
  const summaryLine = (text, name) => text.split('\n').find(l => l.trim().startsWith(name + ' ')) || '';

  test('parallel: stable order, every failure kind counted, exit 1', () => {
    const r = runner(['--jobs=3'], [passA, crash, failing, broken, passB]);
    assert.strictEqual(r.status, 1, r.text);
    const names = ['pass-a.js', 'crash.js', 'fail.js', 'broken.js', 'pass-b.js'];
    const at = names.map(n => r.text.indexOf('  ' + n + ' '));
    assert.ok(at.every((p, i) => p > 0 && (i === 0 || p > at[i - 1])), `summary out of order:\n${r.text}`);
    assert.match(summaryLine(r.text, 'pass-a.js'), / 2 passed /);
    assert.match(summaryLine(r.text, 'pass-b.js'), / 1 passed /);
    assert.match(summaryLine(r.text, 'fail.js'), /1 failed, 1 passed/);
    assert.match(summaryLine(r.text, 'broken.js'), /1 failed, 0 passed/);
    assert.match(summaryLine(r.text, 'crash.js'), /1 failed, 0 passed .*before reporting/);
    assert.ok(r.text.includes('broken.js failed to load'), r.text);
    assert.ok(r.text.includes('3 failed, 4 passed'), r.text);
    // Output is per file and in list order, whichever finished first.
    assert.ok(r.text.indexOf('alpha one') < r.text.indexOf('beta one'), r.text);
    assert.ok(r.text.indexOf('beta one') > r.text.indexOf('gamma expected failure'), r.text);
  });

  test('parallel: every file gets a throwaway HOME of its own, removed afterwards', () => {
    runner(['--jobs=2'], [passA, passB]);
    const a = readHome('a');
    const b = readHome('b');
    assert.ok(a.isolated && b.isolated, 'marker does not name HOME');
    assert.notStrictEqual(a.home, b.home);
    for (const h of [a.home, b.home]) {
      assert.notStrictEqual(h, process.env.HOME);
      assert.ok(path.resolve(h).startsWith(path.resolve(os.tmpdir())), h);
      assert.ok(!fs.existsSync(h), `${h} was left behind`);
    }
  });

  test('--serial runs in one process (one HOME) with the same counts', () => {
    const r = runner(['--serial'], [passA, failing, broken, passB]);
    assert.strictEqual(r.status, 1, r.text);
    assert.ok(r.text.includes('2 failed, 4 passed'), r.text);
    assert.strictEqual(readHome('a').home, readHome('b').home);
  });

  test('--quiet prints failures only; an all-green run exits 0', () => {
    const q = runner(['--quiet'], [passB, failing]);
    assert.strictEqual(q.status, 1);
    assert.ok(!q.text.includes('beta one'), q.text);
    assert.ok(q.text.includes('gamma expected failure'), q.text);
    const green = runner(['--jobs=2'], [passA, passB]);
    assert.strictEqual(green.status, 0, green.text);
    assert.ok(green.text.includes('All 3 tests passed'), green.text);
  });

  test('a filter that matches nothing exits 2', () => {
    const r = runner(['no-such-file-anywhere'], [passA]);
    assert.strictEqual(r.status, 2, r.text);
  });

  test('cleanup', () => cleanup(fx));
});

// -- setup.js doctor -------------------------------------------------------

describe('release -- setup.js doctor', () => {
  const homes = [];
  function mkHome() {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-doctor-'));
    homes.push(h);
    return h;
  }
  function put(home, rel, data, ageMs = 0) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    if (ageMs) {
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(p, t, t);
    }
    return p;
  }
  // node on PATH, nothing else from the real environment.
  const baseEnv = () => ({ PATH: path.dirname(NODE), PATHEXT: process.env.PATHEXT || '' });
  // Above Linux's pid_max ceiling (2^22) and not a multiple of 4, so no
  // process anywhere has it: a PID file naming it is a dead renderer's.
  const DEAD_PID = String(2 ** 31 - 1);

  function doctor(home, { env = {}, nodeVersion } = {}) {
    const lines = [];
    const r = setup.doctor({ home, env: { ...baseEnv(), ...env }, log: l => lines.push(l), nodeVersion });
    const text = lines.join('\n');
    return { problems: r.problems, text, bad: lines.filter(l => l.startsWith('  ! ')) };
  }

  // The real update-state.js, renderer "alive" (this process's pid), a
  // fresh session file, autolaunch on: nothing to report.
  function healthyHome() {
    const home = mkHome();
    put(home, '.claude/settings.json', { hooks: setup.buildFaceHooks(setup.DEFAULT_HOOK_PATH) });
    put(home, '.code-crumb.pid', String(process.pid));
    put(home, '.code-crumb-prefs.json', { autolaunch: true });
    put(home, '.code-crumb-sessions/s1.json', { state: 'idle' });
    return home;
  }

  test('a healthy setup reports no problems', () => {
    const r = doctor(healthyHome());
    assert.strictEqual(r.problems, 0, r.text);
    assert.ok(r.text.includes(`${TICK} renderer running (pid ${process.pid}`), r.text);
    assert.ok(r.text.includes(`manual hooks for all ${setup.HOOK_EVENTS.length} events`), r.text);
    assert.ok(r.text.includes(`${TICK} autolaunch on`), r.text);
    assert.ok(/last hook \ds ago \(s1\.json\)/.test(r.text), r.text);
    assert.ok(r.text.includes(`${DOT} Codex: not set up`), r.text);
  });

  test('an empty home: no renderer, no integration, no hook ever', () => {
    const r = doctor(mkHome());
    assert.strictEqual(r.problems, 3, r.text);
    assert.ok(r.text.includes('! renderer is not running'), r.text);
    assert.ok(r.text.includes('renderer.js'), 'the fix names the renderer');
    assert.ok(r.text.includes('! no editor integration found'), r.text);
    assert.ok(r.text.includes('! no hook has written anything yet'), r.text);
  });

  test('a manual install missing an event names it and suggests npm run setup', () => {
    // A pre-1.2 install has no PostModelSwitch; any event added later is
    // missing from an older install the same way.
    for (const event of ['PostModelSwitch', setup.HOOK_EVENTS[setup.HOOK_EVENTS.length - 1]]) {
      const home = healthyHome();
      const hooks = setup.buildFaceHooks(setup.DEFAULT_HOOK_PATH);
      delete hooks[event];
      put(home, '.claude/settings.json', { hooks });
      const r = doctor(home);
      assert.strictEqual(r.problems, 1, r.text);
      assert.ok(r.bad[0].includes(`miss 1 of ${setup.HOOK_EVENTS.length} events: ${event}`), r.text);
      assert.ok(r.text.includes('npm run setup'), r.text);
    }
  });

  test('hooks pointing at a moved clone are reported, with the path', () => {
    const home = healthyHome();
    const gone = toPosix(path.join(home, 'old-clone', 'update-state.js'));
    put(home, '.claude/settings.json', { hooks: setup.buildFaceHooks(gone) });
    const r = doctor(home);
    assert.strictEqual(r.problems, 1, r.text);
    assert.ok(r.bad[0].includes(gone) && r.bad[0].includes('does not exist'), r.text);
  });

  test('an event registered twice is reported', () => {
    const home = healthyHome();
    const hooks = setup.buildFaceHooks(setup.DEFAULT_HOOK_PATH);
    hooks.Stop = hooks.Stop.concat(hooks.Stop);
    put(home, '.claude/settings.json', { hooks });
    const r = doctor(home);
    assert.strictEqual(r.problems, 1, r.text);
    assert.ok(r.bad[0].includes('register Stop more than once'), r.text);
  });

  function pluginHome(version, { manual = false } = {}) {
    const home = healthyHome();
    const dir = path.join(home, '.claude', 'plugins', 'cache', 'code-crumb', 'code-crumb', version);
    put(dir, 'update-state.js', '');
    put(dir, 'renderer.js', '');
    put(home, '.claude/plugins/installed_plugins.json', {
      version: 2,
      plugins: { 'code-crumb@code-crumb': [{ scope: 'user', installPath: dir, version }] },
    });
    const settings = { enabledPlugins: { 'code-crumb@code-crumb': true } };
    if (manual) settings.hooks = setup.buildFaceHooks(setup.DEFAULT_HOOK_PATH);
    put(home, '.claude/settings.json', settings);
    return { home, dir };
  }

  test('the plugin alone is fine, and its renderer path is printed', () => {
    const { home, dir } = pluginHome(readJson('package.json').version);
    const r = doctor(home);
    assert.strictEqual(r.problems, 0, r.text);
    assert.ok(r.text.includes(`${TICK} Claude Code: plugin code-crumb@code-crumb`), r.text);
    assert.ok(r.text.includes(`node "${toPosix(path.join(dir, 'renderer.js'))}"`), r.text);
  });

  test('the plugin AND the manual hooks: every event fires twice', () => {
    const { home } = pluginHome(readJson('package.json').version, { manual: true });
    const r = doctor(home);
    assert.strictEqual(r.problems, 1, r.text);
    assert.ok(r.bad[0].includes('the plugin AND the manual hooks'), r.text);
    assert.ok(r.text.includes('node setup.js uninstall'), r.text);
  });

  test('a plugin older than this copy says how to update it', () => {
    const { home } = pluginHome('1.0.0');
    const r = doctor(home);
    assert.strictEqual(r.problems, 1, r.text);
    assert.ok(r.bad[0].includes('the plugin is still v1.0.0'), r.text);
    assert.ok(r.text.includes('claude plugin update code-crumb@code-crumb'), r.text);
  });

  test('CLAUDE_CONFIG_DIR and CODEX_HOME are honoured', () => {
    const home = healthyHome();
    fs.unlinkSync(path.join(home, '.claude', 'settings.json'));
    const alt = path.join(home, 'alt-claude');
    put(alt, 'settings.json', { hooks: setup.buildFaceHooks(setup.DEFAULT_HOOK_PATH) });
    const codexHome = path.join(home, 'alt-codex');
    put(codexHome, 'hooks.json', setup.buildCodexHooks(REPO));
    const r = doctor(home, { env: { CLAUDE_CONFIG_DIR: alt, CODEX_HOME: codexHome } });
    assert.strictEqual(r.problems, 0, r.text);
    assert.ok(r.text.includes(`${TICK} Codex: ${setup.CODEX_HOOK_EVENTS.length} hooks in ${path.join(codexHome, 'hooks.json')}`), r.text);
  });

  test('Codex hooks without --editor codex, or missing an event, are reported', () => {
    const home = healthyHome();
    const legacy = setup.buildCodexHooks(REPO);
    for (const groups of Object.values(legacy.hooks)) {
      groups[0].hooks[0].command = groups[0].hooks[0].command.replace(' --editor codex', '');
    }
    delete legacy.hooks.Interrupt;
    put(home, '.codex/hooks.json', legacy);
    const r = doctor(home);
    assert.strictEqual(r.problems, 2, r.text);
    assert.ok(r.bad.some(l => l.includes('no --editor codex tag')), r.text);
    assert.ok(r.bad.some(l => l.includes('Codex hooks miss Interrupt')), r.text);
    assert.ok(r.text.includes('npm run setup:codex'), r.text);
  });

  test('a codex-notify line alongside the hooks is reported; notify alone is not', () => {
    const notify = `# Code Crumb integration\nnotify = ["node", "${toPosix(path.join(REPO, 'adapters', 'codex-notify.js'))}"]\n`;
    const both = healthyHome();
    put(both, '.codex/hooks.json', setup.buildCodexHooks(REPO));
    put(both, '.codex/config.toml', notify);
    const r = doctor(both);
    assert.strictEqual(r.problems, 1, r.text);
    assert.ok(r.bad[0].includes('codex-notify line'), r.text);
    const alone = healthyHome();
    put(alone, '.codex/config.toml', notify);
    const a = doctor(alone);
    assert.strictEqual(a.problems, 0, a.text);
    assert.ok(a.text.includes('legacy notify channel only'), a.text);
  });

  test('autolaunch held off by the quit flag is reported while the renderer is down', () => {
    const home = healthyHome();
    fs.unlinkSync(path.join(home, '.code-crumb.pid'));
    put(home, '.code-crumb-quit', String(Date.now()));
    const r = doctor(home);
    assert.strictEqual(r.problems, 2, r.text); // renderer down + the flag
    assert.ok(r.bad.some(l => l.includes('quit flag')), r.text);
    // The renderer up: the flag is irrelevant.
    const up = healthyHome();
    put(up, '.code-crumb-quit', String(Date.now()));
    assert.strictEqual(doctor(up).problems, 0);
    // No flag: autolaunch will open it, so a stopped renderer is fine.
    const auto = healthyHome();
    fs.unlinkSync(path.join(auto, '.code-crumb.pid'));
    const a = doctor(auto);
    assert.strictEqual(a.problems, 0, a.text);
    assert.ok(a.text.includes('autolaunch opens it on the next hook'), a.text);
  });

  test('a stale PID file reads as a stopped renderer, with its age', () => {
    const home = healthyHome();
    put(home, '.code-crumb-prefs.json', { autolaunch: false });
    put(home, '.code-crumb.pid', DEAD_PID, 3 * 3600e3);
    const r = doctor(home);
    assert.strictEqual(r.problems, 1, r.text);
    assert.ok(r.bad[0].includes('renderer is not running') && r.bad[0].includes('3h ago'), r.text);
  });

  test('no hook in hours: are the hooks firing?', () => {
    const home = healthyHome();
    put(home, '.code-crumb-sessions/s1.json', {}, 2 * 3600e3);
    const r = doctor(home);
    assert.strictEqual(r.problems, 1, r.text);
    assert.ok(r.bad[0].includes('no hook has written in 2h -- are the hooks firing?'), r.text);
    // The global state file counts as a hook write too.
    put(home, '.code-crumb-state', {});
    assert.strictEqual(doctor(home).problems, 0);
  });

  test('old node, and node missing from PATH', () => {
    const old = doctor(healthyHome(), { nodeVersion: '16.20.2' });
    assert.strictEqual(old.problems, 1, old.text);
    assert.ok(old.bad[0].includes('node v16.20.2 is too old'), old.text);
    const noNode = doctor(healthyHome(), { env: { PATH: mkHome() } });
    assert.strictEqual(noNode.problems, 1, noNode.text);
    assert.ok(noNode.bad[0].includes('node is not on PATH'), noNode.text);
  });

  test('garbage everywhere: no throw, and the broken files are named', () => {
    const home = mkHome();
    put(home, '.claude/settings.json', '{ not json');
    put(home, '.claude/plugins/installed_plugins.json', '42');
    put(home, '.codex/hooks.json', '[1, 2');
    put(home, '.codex/config.toml', Buffer.from([0, 255, 254, 10]).toString('latin1'));
    put(home, '.config/opencode/opencode.json', '"a string"');
    put(home, '.code-crumb-prefs.json', 'null');
    put(home, '.code-crumb.pid', 'garbage');
    put(home, '.code-crumb-sessions/bad.json', '\u0000\u0001');
    fs.mkdirSync(path.join(home, '.code-crumb-sessions', 'dir.json'));
    fs.mkdirSync(path.join(home, '.code-crumb-quit'));
    let r;
    assert.doesNotThrow(() => { r = doctor(home); });
    assert.ok(r.problems >= 3, r.text);
    assert.ok(r.bad.some(l => l.includes('settings.json is not valid JSON')), r.text);
    assert.ok(r.bad.some(l => l.includes('hooks.json is not valid JSON')), r.text);
    assert.ok(r.bad.some(l => l.includes('.code-crumb-prefs.json is not a JSON object')), r.text);
    assert.ok(!r.text.includes('could not check'), r.text);
  });

  // The CLI: real exit codes, and nothing in the home is touched.
  function snapshot(dir) {
    const out = {};
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        const st = fs.statSync(p);
        out[path.relative(dir, p)] = e.isDirectory() ? 'dir' : `${st.size}:${st.mtimeMs}`;
        if (e.isDirectory()) walk(p);
      }
    };
    walk(dir);
    return out;
  }
  function cli(home) {
    const env = { ...process.env, HOME: home, USERPROFILE: home,
      CODE_CRUMB_STATE: path.join(home, '.code-crumb-state'), CODEX_HOME: path.join(home, '.codex') };
    delete env.CLAUDE_CONFIG_DIR;
    for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
    env.PATH = path.dirname(NODE) + path.delimiter + (process.env.PATH || '');
    return spawnSync(NODE, [path.join(REPO, 'setup.js'), 'doctor'], { env, encoding: 'utf8', timeout: 30000 });
  }

  test('node setup.js doctor exits 0 when healthy, 1 on a problem, and writes nothing', () => {
    const healthy = healthyHome();
    put(healthy, '.codex/hooks.json', setup.buildCodexHooks(REPO));
    const before = snapshot(healthy);
    const ok = cli(healthy);
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    assert.ok(ok.stdout.includes('No problems found.'), ok.stdout);
    assert.deepStrictEqual(snapshot(healthy), before);

    const messy = mkHome();
    put(messy, '.claude/settings.json', { hooks: setup.buildFaceHooks('/nowhere/update-state.js'), enabledPlugins: { 'code-crumb@code-crumb': true } });
    put(messy, '.code-crumb-prefs.json', { autolaunch: true });
    put(messy, '.code-crumb-quit', '1');
    put(messy, '.code-crumb.pid', DEAD_PID, 3600e3);
    put(messy, '.code-crumb-sessions/old.json', {}, 5 * 3600e3);
    const was = snapshot(messy);
    const bad = cli(messy);
    assert.strictEqual(bad.status, 1, bad.stdout + bad.stderr);
    assert.ok(/\d+ problems? found\./.test(bad.stdout), bad.stdout);
    assert.strictEqual(bad.stderr, '');
    assert.deepStrictEqual(snapshot(messy), was);
  });

  test('cleanup', () => { for (const h of homes) cleanup(h); });
});

// -- Review round 5 (docs-pass bugs): setup and doctor agree ---------------
// doctor kept its own idea of where each editor's config lives, and setup
// another: doctor read ~/.config/opencode/opencode.json as strict JSON
// (setup follows OPENCODE_CONFIG_DIR / XDG_CONFIG_HOME and reads JSONC),
// honoured CLAUDE_CONFIG_DIR where setup did not (so setup's hooks landed
// where Claude Code never reads them, and doctor called them missing), and
// matched a codex-notify line with a one-line regex (setup's own scan finds a
// `notify = [` array spread over lines, and a regex over the whole line read
// a comment as ours).

describe('release -- Review round 5 (docs-pass bugs): setup and doctor agree', () => {
  const homes = [];
  function mkHome() {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-agree-'));
    homes.push(h);
    // The renderer "alive" and a fresh hook write: only the checks under test can complain.
    put(h, '.code-crumb.pid', String(process.pid));
    put(h, '.code-crumb-prefs.json', { autolaunch: false });
    put(h, '.code-crumb-sessions/s1.json', { state: 'idle' });
    return h;
  }
  function put(home, rel, data) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
    return p;
  }
  function doctor(home, env = {}) {
    const lines = [];
    const r = setup.doctor({ home, env: { PATH: path.dirname(NODE), PATHEXT: process.env.PATHEXT || '', ...env },
      log: l => lines.push(l) });
    return { problems: r.problems, text: lines.join('\n'), bad: lines.filter(l => l.startsWith('  ! ')) };
  }
  const PLUGIN = setup.DEFAULT_OPENCODE_PLUGIN;
  const NOTIFY_JS = toPosix(path.join(REPO, 'adapters', 'codex-notify.js'));

  test('doctor reads the OpenCode config setup writes: OPENCODE_CONFIG_DIR, XDG_CONFIG_HOME, JSONC', () => {
    const cases = [
      ['OPENCODE_CONFIG_DIR', (h) => ({ OPENCODE_CONFIG_DIR: path.join(h, 'oc') }), 'oc/opencode.json'],
      ['XDG_CONFIG_HOME', (h) => ({ XDG_CONFIG_HOME: path.join(h, 'xdg') }), 'xdg/opencode/opencode.json'],
      ['opencode.jsonc', () => ({}), '.config/opencode/opencode.jsonc'],
    ];
    for (const [label, envOf, rel] of cases) {
      const home = mkHome();
      const env = envOf(home);
      const file = put(home, rel, rel.endsWith('.jsonc')
        ? `{\n  // OpenCode's own docs write comments\n  "plugin": [${JSON.stringify(PLUGIN)}],\n}\n`
        : { plugin: [PLUGIN] });
      assert.strictEqual(path.resolve(setup.opencodeConfigPath(env, home)), path.resolve(file), `${label}: setup's file`);
      const r = doctor(home, env);
      assert.ok(r.text.includes(`${TICK} OpenCode: plugin registered in ${file}`), `${label}\n${r.text}`);
      assert.strictEqual(r.problems, 0, `${label}\n${r.text}`);
    }
  });

  test('doctor sees exactly what setup.js opencode --install wrote', () => {
    const home = mkHome();
    const env = { XDG_CONFIG_HOME: path.join(home, 'xdg') };
    const configPath = setup.opencodeConfigPath(env, home);
    put(home, 'xdg/opencode/opencode.jsonc', '{ /* keep me */ "theme": "dark" }\n');
    const jsonc = setup.opencodeConfigPath(env, home);
    assert.ok(jsonc.endsWith('opencode.jsonc') && jsonc !== configPath, 'an existing .jsonc is the file');
    assert.strictEqual(setup.setupOpenCode({ configPath: jsonc, install: true, log: () => {}, quiet: true }).ok, true);
    assert.ok(fs.readFileSync(jsonc, 'utf8').includes('/* keep me */'), 'comments kept');
    const r = doctor(home, env);
    assert.ok(r.text.includes(`${TICK} OpenCode: plugin registered in ${jsonc}`), r.text);
  });

  test('setup, uninstall and doctor all follow CLAUDE_CONFIG_DIR, .bak included', () => {
    const home = mkHome();
    const alt = path.join(home, 'alt-claude');
    put(alt, 'settings.json', { env: { KEEP: '1' } });
    const env = { ...process.env, HOME: home, USERPROFILE: home,
      CODE_CRUMB_STATE: path.join(home, '.code-crumb-state'), CLAUDE_CONFIG_DIR: alt };
    const run = (...args) => spawnSync(NODE, [path.join(REPO, 'setup.js'), ...args], { env, encoding: 'utf8', timeout: 30000 });
    const s = run('claude');
    assert.strictEqual(s.status, 0, s.stdout + s.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(alt, 'settings.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(settings.hooks).sort(), [...setup.HOOK_EVENTS].sort());
    assert.strictEqual(settings.env.KEEP, '1');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(alt, 'settings.json.bak'), 'utf8')), { env: { KEEP: '1' } });
    assert.ok(!fs.existsSync(path.join(home, '.claude')), 'nothing under ~/.claude');
    const r = doctor(home, { CLAUDE_CONFIG_DIR: alt });
    assert.ok(r.text.includes(`manual hooks for all ${setup.HOOK_EVENTS.length} events in ${path.join(alt, 'settings.json')}`), r.text);
    assert.strictEqual(r.problems, 0, r.text);
    const u = run('uninstall');
    assert.strictEqual(u.status, 0, u.stdout + u.stderr);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(alt, 'settings.json'), 'utf8')), { env: { KEEP: '1' } });
    assert.strictEqual(setup.claudeSettingsPath({ CLAUDE_CONFIG_DIR: alt }, home), path.join(alt, 'settings.json'));
    assert.strictEqual(setup.claudeSettingsPath({}, home), path.join(home, '.claude', 'settings.json'));
  });

  test('doctor reports a multi-line Code Crumb notify array, as setup would remove it', () => {
    const home = mkHome();
    put(home, '.claude/settings.json', { hooks: setup.buildFaceHooks(setup.DEFAULT_HOOK_PATH) });
    put(home, '.codex/hooks.json', setup.buildCodexHooks(REPO));
    const config = put(home, '.codex/config.toml',
      `model = "gpt-5"\n# Code Crumb integration\nnotify = [\n  "node",\n  "${NOTIFY_JS}",\n]\n\n[features]\nx = 1\n`);
    const r = doctor(home);
    assert.strictEqual(r.problems, 1, r.text);
    assert.ok(r.bad[0].includes('codex-notify line'), r.text);
    assert.strictEqual(setup.removeCodexNotify({ configPath: config, log: () => {}, quiet: true }).removed, 1);
    assert.strictEqual(doctor(home).problems, 0, 'and once setup removed it, doctor is satisfied');
  });

  test('a foreign notify line is never flagged, nor removed -- a comment naming us included', () => {
    for (const line of [
      'notify = [ "C:\\\\Users\\\\me\\\\AppData\\\\Local\\\\OpenAI\\\\Codex\\\\bin\\\\codex-computer-use.exe", "turn-ended" ]',
      'notify = ["python3", "/home/me/notify.py"]  # replaced codex-notify.js',
      'notify = [\n  "python3",  # was codex-notify.js\n  "/home/me/notify.py",\n]',
    ]) {
      const home = mkHome();
      put(home, '.claude/settings.json', { hooks: setup.buildFaceHooks(setup.DEFAULT_HOOK_PATH) });
      put(home, '.codex/hooks.json', setup.buildCodexHooks(REPO));
      const text = `${line}\n[features]\nx = 1\n`;
      const config = put(home, '.codex/config.toml', text);
      const r = doctor(home);
      assert.strictEqual(r.problems, 0, `${line}\n${r.text}`);
      assert.strictEqual(setup.removeCodexNotify({ configPath: config, log: () => {}, quiet: true }).removed, 0, line);
      assert.strictEqual(fs.readFileSync(config, 'utf8'), text, line);
    }
  });

  // The CI gate fails a push on trailing whitespace in these files, so the
  // editor config must trim them all -- it exempted Markdown.
  test('.editorconfig trims trailing whitespace in every file type the CI gate checks', () => {
    const gate = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'test.yml'), 'utf8')
      .split('\n').find(l => l.includes('git grep') && l.includes('[[:space:]]+$'));
    assert.ok(gate, 'the whitespace gate');
    const exts = [...gate.matchAll(/'\*\.(\w+)'/g)].map(m => m[1]);
    assert.ok(exts.includes('md') && exts.includes('js'), exts.join(','));
    const trim = {};
    let section = null;
    const sections = [];
    for (const raw of fs.readFileSync(path.join(REPO, '.editorconfig'), 'utf8').split(/\r?\n/)) {
      const l = raw.trim();
      const head = /^\[(.+)\]$/.exec(l);
      if (head) { section = head[1]; continue; }
      const kv = /^trim_trailing_whitespace\s*=\s*(\w+)$/.exec(l);
      if (kv && section) sections.push([section, kv[1] === 'true']);
    }
    // Later sections win, as in EditorConfig: '*' or '*.ext' or '*.{a,b}'.
    const matches = (glob, ext) => glob === '*' || glob === `*.${ext}`
      || new RegExp(`^\\*\\.\\{(?:[^}]*,)?${ext}(?:,[^}]*)?\\}$`).test(glob);
    for (const ext of exts) {
      trim[ext] = false;
      for (const [glob, on] of sections) if (matches(glob, ext)) trim[ext] = on;
      assert.strictEqual(trim[ext], true, `*.${ext} is not trimmed, but the gate checks it`);
    }
  });

  test('cleanup', () => { for (const h of homes) cleanup(h); });
});

module.exports = suite;
