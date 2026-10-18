'use strict';

// +================================================================+
// |  Tests for the payload recorder and the golden replays         |
// |                                                                |
// |  lib/recorder.js: shape-mode anonymisation (ids, enums, text,  |
// |  commands, paths, hostile input), the record file, and the     |
// |  three hook points (update-state.js, the stdin adapters,       |
// |  codex-wrapper.js).                                            |
// |                                                                |
// |  tests/fixtures/replay/*.jsonl: recordings (the recorder's     |
// |  own format) replayed through the REAL update-state.js and     |
// |  adapters in a throwaway home; after every step the session    |
// |  files and the global file are projected and compared with     |
// |  <name>.golden.json. Replays run with the recorder on, and     |
// |  must record their own fixture again: that is the end-to-end   |
// |  test of the hook points.                                      |
// |                                                                |
// |  An intended behaviour change rewrites the goldens:            |
// |    CRUMB_UPDATE_GOLDEN=1 node tests/run.js replay              |
// |  then review the golden diff like any other change.            |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;
const { makeTempEnv, cleanup, readJSON, runUpdateState, runFakeCodex } = require('./_harness');
const recorder = require('../lib/recorder');
const { toFixture, parseRecording, sequentialIds } = require('./fixtures/replay/import-recording');
const sm = require('../lib/state-machine');

const NODE = process.execPath;
const FIXTURES = path.join(__dirname, 'fixtures', 'replay');
const ADAPTERS = {
  opencode: path.join(__dirname, '..', 'adapters', 'opencode-adapter.js'),
  openclaw: path.join(__dirname, '..', 'adapters', 'openclaw-adapter.js'),
};
const UPDATE_GOLDEN = process.env.CRUMB_UPDATE_GOLDEN === '1';
const REGENERATE = 'CRUMB_UPDATE_GOLDEN=1 node tests/run.js replay';

// -- Replay engine ---------------------------------------------------------

// The records of one fixture, with their line numbers (headers skipped).
function readFixture(file) {
  const steps = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let rec;
    try { rec = JSON.parse(line); } catch (e) {
      throw new Error(`${path.basename(file)}:${i + 1} is not JSON: ${e.message}`);
    }
    if (rec.kind !== 'header') steps.push({ rec, line: i + 1 });
  });
  return steps;
}

// The fallback session id is `<editor>-<ppid>`, and the hook's parent is
// this process: normalised, a golden does not depend on the pid.
const PPID_RE = new RegExp(`-${process.pid}$`);
const norm = (s) => (typeof s === 'string' ? s.replace(PPID_RE, '-PPID') : s);

// What a golden pins of one session file. Times are volatile: lastPromptAt
// becomes its rank among the distinct stamps this file has carried (1 = the
// first stamp, 2 = re-stamped), which keeps "stamped / kept / moved".
function project(data, stamps) {
  if (!data || typeof data !== 'object') return { unreadable: true };
  const out = { state: data.state, detail: data.detail };
  for (const k of ['stopped', 'turnEnded', 'turnOver', 'answered', 'synthetic']) if (data[k]) out[k] = true;
  if (data.waitingOn) out.waiting = true;
  if (typeof data.waitConfirmed === 'boolean') out.waitConfirmed = data.waitConfirmed;
  if (data.lastPromptAt) {
    if (!stamps.includes(data.lastPromptAt)) stamps.push(data.lastPromptAt);
    out.prompt = stamps.indexOf(data.lastPromptAt) + 1;
  }
  for (const k of ['parentSession', 'editor', 'model', 'turnError']) if (data[k]) out[k] = norm(data[k]);
  return out;
}

function snapshot(t, stampsByFile) {
  const sessions = {};
  let names = [];
  try { names = fs.readdirSync(t.sessionsDir).filter(f => f.endsWith('.json')).sort(); } catch {}
  for (const f of names) {
    const id = norm(f.slice(0, -'.json'.length));
    if (!stampsByFile.has(id)) stampsByFile.set(id, []);
    let data = null;
    try { data = readJSON(path.join(t.sessionsDir, f)); } catch {}
    sessions[id] = project(data, stampsByFile.get(id));
  }
  let global = null;
  try {
    const g = readJSON(t.stateFile);
    global = { state: g.state, detail: g.detail, sessionId: norm(g.sessionId) || null };
    if (g.stopped) global.stopped = true;
  } catch {}
  let streak = null;
  try { streak = readJSON(t.statsFile).streak; } catch {}
  return { sessions, global, streak };
}

function runAdapter(file, input, env) {
  try {
    execFileSync(NODE, [file], { input, env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    // process.exit(0) can surface as an error; only a real failure counts.
    if (e.status === null && e.signal) throw new Error(`${path.basename(file)} was killed (${e.signal})`);
    if (e.status !== 0 && e.status !== null) throw e;
  }
}

// What the hook points must reproduce of a record: who sent it, under which
// event and argv, and the pattern of ids it named (renumbered, so a
// hand-written fixture's `sess-A` and a recording's `s-0a1b...` compare).
function skeletons(records) {
  const ids = sequentialIds();
  return records.map(rec => {
    const seen = [];
    recorder.mapIds(rec.payload, (kind, id) => { seen.push(ids(kind, id)); return id; });
    // A wrapper run's last argument is its prompt, which runFakeCodex supplies.
    const argv = !Array.isArray(rec.argv) ? null : rec.source === 'codex-exec' ? rec.argv.slice(0, -1) : rec.argv;
    return { source: rec.source, editor: rec.editor, event: rec.event, argv,
      truncated: !!rec.truncated, unparsed: !!rec.unparsed, ids: seen };
  });
}

// The recording a replay made, as fixture records.
function recordedBack(file) {
  return parseRecording(toFixture(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')).records;
}

// Every step of a fixture, replayed and projected. A codex-exec fixture is
// one wrapper run (the stream cannot be paused between events), projected
// once at its end; it may not mix with other sources.
//
// With `record` (the default) the replay runs with CODE_CRUMB_RECORD=1, and
// what the hooks recorded must be the fixture's own records again: one per
// payload, in order, from the right hook point, with the same ids. That is
// the end-to-end test of all three hook points. Without it, nothing may be
// recorded at all.
const RECORD_ENV = { CODE_CRUMB_RECORD: '1', CODE_CRUMB_RECORD_FILE: 'replay.jsonl' };
function replay(steps, { record = true } = {}) {
  const stampsByFile = new Map();
  const sources = new Set(steps.map(s => s.rec.source));
  const checkRecording = (home) => {
    const file = path.join(home, RECORD_ENV.CODE_CRUMB_RECORD_FILE);
    if (!record) {
      assert.ok(!fs.existsSync(file) && !fs.existsSync(path.join(home, '.code-crumb-record')),
        'a hook recorded with the recorder off');
      return;
    }
    assert.deepStrictEqual(skeletons(recordedBack(file)), skeletons(steps.map(s => s.rec)),
      'the replay\'s own recording is not the fixture again');
  };
  if (sources.has('codex-exec')) {
    assert.strictEqual(sources.size, 1, 'a codex-exec fixture replays as one wrapper run, so it holds codex-exec records only');
    const events = steps.map(s => recorder.expandPlaceholders(s.rec.payload));
    const argv = (steps.find(s => Array.isArray(s.rec.argv)) || { rec: { argv: ['x'] } }).rec.argv;
    // runFakeCodex copies process.env, and appends the prompt to the flags.
    const saved = {};
    for (const k of Object.keys(RECORD_ENV)) { saved[k] = process.env[k]; if (record) process.env[k] = RECORD_ENV[k]; }
    let t;
    try {
      t = runFakeCodex(events, null, argv.slice(0, -1));
    } finally {
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
    try {
      checkRecording(t.tmp);
      return [{ step: steps.length, event: 'codex exec (whole run)', ...snapshot(t, stampsByFile) }];
    } finally { cleanup(t.tmp); }
  }
  const t = makeTempEnv('replay');
  const env = { ...t.env, ...(record ? RECORD_ENV : {}) };
  // Claude Code exports CLAUDE_CODE_SESSION_ID to tools, never this one.
  delete env.CLAUDE_SESSION_ID;
  try {
    const out = [];
    steps.forEach(({ rec, line }, i) => {
      const input = recorder.replayInput(rec);
      if (/-hook$/.test(rec.source)) {
        const argv = Array.isArray(rec.argv) ? rec.argv.map(String) : [rec.event];
        const tagged = argv.some(a => a === '--editor' || a.startsWith('--editor='));
        const hookEnv = (tagged || !rec.editor || rec.editor === 'claude') ? env : { ...env, CODE_CRUMB_EDITOR: rec.editor };
        runUpdateState(null, input, hookEnv, { args: argv });
      } else if (ADAPTERS[rec.source]) {
        runAdapter(ADAPTERS[rec.source], input, env);
      } else {
        throw new Error(`line ${line}: no replay for source "${rec.source}"`);
      }
      out.push({ step: i + 1, event: rec.event, ...snapshot(t, stampsByFile) });
    });
    checkRecording(t.tmp);
    return out;
  } finally { cleanup(t.tmp); }
}

// "path: expected X, got Y" for every difference between two projections.
function diffValue(e, a, at, out) {
  if (e && a && typeof e === 'object' && typeof a === 'object') {
    for (const k of new Set([...Object.keys(e), ...Object.keys(a)])) {
      if (!(k in a)) out.push(`${at}${k}: expected ${JSON.stringify(e[k])}, got (absent)`);
      else if (!(k in e)) out.push(`${at}${k}: expected (absent), got ${JSON.stringify(a[k])}`);
      else diffValue(e[k], a[k], `${at}${k}.`, out);
    }
    return out;
  }
  if (JSON.stringify(e) !== JSON.stringify(a)) {
    out.push(`${at.slice(0, -1)}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
  }
  return out;
}

function diffSteps(expected, actual, steps, name) {
  const lines = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
    const e = expected[i];
    const a = actual[i];
    const where = steps[i] ? `${name}:${steps[i].line}` : name;
    const head = `  step ${i + 1} ${(a || e).event} (${where})`;
    if (!e) { lines.push(`${head}: not in the golden`); continue; }
    if (!a) { lines.push(`${head}: in the golden, but not replayed`); continue; }
    const d = diffValue({ sessions: e.sessions, global: e.global, streak: e.streak },
      { sessions: a.sessions, global: a.global, streak: a.streak }, '', []);
    if (d.length) lines.push(head, ...d.map(x => `      ${x}`));
  }
  return lines;
}

// -- Golden replays --------------------------------------------------------

const fixtureNames = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.jsonl')).sort();

describe('replay -- golden fixtures', () => {
  test('every fixture opens with a v1 header and every golden has its fixture', () => {
    assert.ok(fixtureNames.length >= 6, `seed corpus: ${fixtureNames.join(', ')}`);
    for (const f of fixtureNames) {
      const first = JSON.parse(fs.readFileSync(path.join(FIXTURES, f), 'utf8').split('\n')[0]);
      assert.strictEqual(first.v, 1, f);
      assert.strictEqual(first.kind, 'header', `${f}: the first line is a header record`);
      assert.strictEqual(typeof first.synthetic, 'boolean', `${f}: says whether it was recorded or hand-built`);
    }
    const goldens = fs.readdirSync(FIXTURES).filter(f => f.endsWith('.golden.json'));
    for (const g of goldens) {
      assert.ok(fixtureNames.includes(g.replace(/\.golden\.json$/, '.jsonl')), `${g} has no fixture`);
    }
  });

  // A placeholder expands to filler that the anonymiser turns back into the
  // same placeholder, so re-recording a replay is stable. A fixture whose
  // text was edited by hand (real output lines, to pin a classification)
  // says `"edited": true` in its header and is exempt.
  test('every fixture is a fixed point of expand-then-anonymise', () => {
    for (const f of fixtureNames) {
      const text = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
      if (JSON.parse(text.split('\n')[0]).edited) continue;
      const ids = sequentialIds();
      for (const { rec, line } of readFixture(path.join(FIXTURES, f))) {
        if (rec.truncated) continue;   // a marker holds ids only
        const back = rec.unparsed ? recorder.freeText(recorder.expandText(rec.payload))
          : recorder.anonymise(recorder.expandPlaceholders(rec.payload), { pseudonym: ids });
        assert.deepStrictEqual(back, recorder.mapIds(rec.payload, ids), `${f}:${line}`);
      }
    }
  });

  for (const f of fixtureNames) {
    const name = f.replace(/\.jsonl$/, '');
    test(`${name} replays to its golden`, () => {
      const steps = readFixture(path.join(FIXTURES, f));
      const actual = replay(steps);
      const goldenPath = path.join(FIXTURES, `${name}.golden.json`);
      if (UPDATE_GOLDEN) {
        const golden = { fixture: f, regenerate: REGENERATE, steps: actual };
        fs.writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n', 'utf8');
        return;
      }
      assert.ok(fs.existsSync(goldenPath), `${name} has no golden yet: ${REGENERATE}`);
      const lines = diffSteps(readJSON(goldenPath).steps, actual, steps, f);
      assert.ok(lines.length === 0, `${f} no longer replays to its golden:\n${lines.join('\n')}\n`
        + `  If the change is intended: ${REGENERATE}, and review the golden's diff.`);
    });
  }
});

// -- The anonymiser ----------------------------------------------------------

// A pseudonymiser with a fixed key, as one recording directory has.
const pseudonym = recorder.makePseudonymiser('0'.repeat(64));
const anon = (v) => recorder.anonymise(v, { pseudonym });

describe('replay -- shape-mode anonymisation', () => {
  test('ids become pseudonyms that keep equality, across keys too', () => {
    const out = anon({
      session_id: 'sess-uuid-1', agent_id: 'agent-9', tool_use_id: 'toolu_01AbC',
      nested: [{ session_id: 'sess-uuid-1' }, { session_id: 'sess-uuid-2' }],
      thread_id: 'sess-uuid-1', parentSession: 'sess-uuid-2',
    });
    assert.match(out.session_id, /^s-[0-9a-f]{12}$/);
    assert.match(out.agent_id, /^a-[0-9a-f]{12}$/);
    assert.match(out.tool_use_id, /^t-[0-9a-f]{12}$/);
    assert.strictEqual(out.nested[0].session_id, out.session_id, 'the same id, the same pseudonym');
    assert.notStrictEqual(out.nested[1].session_id, out.session_id, 'another id, another pseudonym');
    assert.strictEqual(out.thread_id, out.session_id, 'a codex thread_id is the hooks\' session_id');
    assert.strictEqual(out.parentSession, out.nested[1].session_id);
    assert.ok(!JSON.stringify(out).includes('sess-uuid'), 'no raw id survives');
  });

  test('pseudonyms are keyed: another recording directory, other pseudonyms', () => {
    const other = recorder.makePseudonymiser('f'.repeat(64));
    assert.strictEqual(pseudonym('s', 'x1'), pseudonym('s', 'x1'));
    assert.notStrictEqual(other('s', 'x1'), pseudonym('s', 'x1'));
  });

  test('enum-like values are kept verbatim', () => {
    const p = {
      hook_event_name: 'Notification', notification_type: 'permission_prompt', source: 'compact',
      reason: 'prompt_input_exit', trigger: 'auto', permission_mode: 'acceptEdits', agent_type: 'general-purpose',
      tool_name: 'MultiEdit', model: 'claude-opus-4-5[1m]', to_model: 'openai/gpt-5', type: 'tool.execute.after',
      status: 'async_launched', error: 'rate_limit', errorName: 'MessageAbortedError', name: 'ContextOverflowError',
      is_interrupt: true, stop_hook_active: false, exitCode: -1073741819, exit: 2, seq: 4,
    };
    assert.deepStrictEqual(anon(p), p);
  });

  test('free text becomes a placeholder that keeps its length class and line count', () => {
    const out = anon({
      prompt: 'Fix the login bug in the Acme portal for Alice',
      tool_input: { description: 'Run tests', content: 'line one\nline two\nline three\n' },
      tool_response: { stdout: 'x'.repeat(123456), stderr: '' },
      message: 'Claude needs your permission to use Bash',
    });
    assert.strictEqual(out.prompt, '<text len~46 lines=1>');
    assert.strictEqual(out.tool_input.content, '<text len~29 lines=3 eol>');
    assert.strictEqual(out.tool_response.stdout, '<text len~120000 lines=1>', 'two significant digits');
    assert.strictEqual(out.tool_response.stderr, '', 'empty stays empty: a background launch is "empty output"');
    assert.ok(!/Acme|Alice|permission to use/.test(JSON.stringify(out)));
  });

  test('an enum key holding free text, and a `name` that is not an error class, are text', () => {
    const out = anon({ type: 'a whole sentence here', name: 'Alice Smith', status: '/home/alice/x' });
    assert.strictEqual(out.type, '<text len~21 lines=1>');
    assert.strictEqual(out.name, '<text len~11 lines=1>');
    assert.strictEqual(out.status, '<text len~13 lines=1>');
  });

  test('an exit-status line and the messages the code compares against survive', () => {
    const out = anon({
      error: 'Exit code 127\n/bin/bash: acmectl: command not found',
      stdout: 'building acme\nExit code 2\n',
      a: 'Tool execution aborted',
      b: 'The user dismissed this question',
    });
    assert.strictEqual(out.error, 'Exit code 127\n<text len~37 lines=1>');
    assert.strictEqual(out.stdout, '<text len~13 lines=1>\nExit code 2\n');
    assert.strictEqual(out.a, 'Tool execution aborted');
    assert.strictEqual(out.b, 'The user dismissed this question');
    // The predicate rule still reads the exit status of a grep that found nothing.
    const r = sm.classifyToolResult('Bash', { command: 'grep -q acme x.js' }, { stdout: '', stderr: anon({ e: 'Exit code 1' }).e }, true);
    assert.strictEqual(r.state, 'satisfied');
  });

  test('commands keep their structure, so they classify as before', () => {
    const cmds = [
      'npm test', 'yarn jest src/acme.test.ts', 'pnpm --filter web build', 'pytest -x tests/test_acme.py',
      'cargo build --release', 'go test ./...', 'make test-unit', 'make deploy-acme',
      'git commit -m "build the acme widget"', 'git push origin feature/acme', 'git status && npm install',
      'npm i -D jest', 'pip install pytest', 'git add a.test.js', 'node --test test/', 'tsc --noEmit',
      'nx run acme-app:test', 'bazel test //acme/...', './gradlew unitTest -x lint', 'mvn -pl core test',
      'python3 train.py --epochs 3', 'rm -rf dist', 'grep -rn "secretThing" src | sort | head -20',
      "sed -n '1,120p' lib/acme.js", 'sed -i.bak s/a/b/ x.txt', "bash -lc 'npm run build'",
      'pwsh -Command "npm test"', 'cmd /c "yarn install"', 'cd acme && git pull --rebase', 'which acmectl',
      'deno test --allow-read', 'corepack yarn install', 'npx cypress run', 'phpunit --filter AcmeTest',
    ];
    for (const c of cmds) {
      const shaped = recorder.shapeText(c);
      assert.ok(!/acme|secretThing/i.test(shaped), `${c} -> ${shaped}`);
      assert.strictEqual(sm.toolToState('Bash', { command: shaped }).state, sm.toolToState('Bash', { command: c }).state,
        `${c} -> ${shaped}`);
    }
  });

  test('what survives of a command: words in VOCAB, flags, quoting, operators, short numbers', () => {
    assert.strictEqual(recorder.shapeText('git commit -m "fix acme login" && git push origin main'),
      'git commit -m "x x login" && git push origin main');
    // Codex quotes through shlex: the quoting shape is exactly what is unverified.
    assert.strictEqual(recorder.shapeText(`bash -lc 'echo '"'"'it'"'"'s done'`), `bash -lc 'echo '"'"'x'"'"'s done'`);
    assert.strictEqual(recorder.shapeText('sed -Ei "s/acme/x/" src/a.js | head -40 2>&1'),
      'sed -Ei "s/x/x/" src/a.js | head -40 2>&1');
    assert.strictEqual(recorder.shapeText('mysql -pS3cretPw -u root'), 'mysql -x -u root', 'a value glued to a flag');
    assert.strictEqual(recorder.shapeText('echo $HOME ${ACME_TOKEN}'), 'echo $HOME ${x_x}');
    assert.strictEqual(recorder.shapeText("cat <<'EOF' > notes.txt\nsecret plans\nEOF"), "cat <<'EOF' > x.txt\nx x\nEOF");
    // An address is no command shape: its four short numbers each survived.
    assert.strictEqual(recorder.shapeText('ssh deploy@10.0.0.12 -p 2222'), 'ssh deploy@x.x.x.x -p 2222');
    assert.strictEqual(recorder.shapeText('curl http://192.168.1.20:8080/api'), 'curl http://x.x.x.x:8080/api');
  });

  test('paths keep separators, extensions and common directory names', () => {
    const out = anon({
      file_path: '/home/alice/acme/src/login.test.ts',
      cwd: 'C:\\Users\\alice\\acme',
      transcript_path: '/home/alice/.claude/projects/-home-alice-acme/3f2a9c1e-77b0-4c2d-9e1a-0a1b2c3d4e5f.jsonl',
      changes: [{ path: '/srv/acme/README.md', kind: 'update' }],
    });
    assert.strictEqual(out.file_path, '/home/x/x/src/login.test.ts');
    assert.strictEqual(out.cwd, 'C:\\Users\\x\\x');
    assert.strictEqual(out.transcript_path, '/home/x/.claude/projects/-home-x-x/x-x-x-x-x.jsonl', 'no fragment of the id');
    assert.deepStrictEqual(out.changes, [{ path: '/x/x/README.md', kind: 'update' }]);
  });

  test('an MCP tool keeps its verb, not its server\'s words', () => {
    const name = 'mcp__acme-billing__get_customer_invoice';
    const out = anon({ tool_name: name }).tool_name;
    assert.ok(out.startsWith('mcp__') && !/acme|customer|invoice/.test(out), out);
    assert.strictEqual(sm.toolToState(out, {}).state, sm.toolToState(name, {}).state);
  });

  test('numbers: small integers survive, anything else is 0; enum numbers always survive', () => {
    const out = anon({ duration_ms: 8123, numLines: 12, offset: -3, epoch: 1760000000000, amount: 12.5, exit_code: 70000000 });
    assert.deepStrictEqual(out, { duration_ms: 8123, numLines: 12, offset: -3, epoch: 0, amount: 0, exit_code: 70000000 });
  });

  test('nested arrays and objects: edits[], todos, a structuredPatch keeps its +/- markers', () => {
    const p = {
      tool_input: { edits: [{ old_string: 'a\nb', new_string: 'c', replace_all: false }],
        todos: [{ id: '1', content: 'Ship it', status: 'in_progress', activeForm: 'Shipping it' }] },
      tool_response: { structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 1, lines: [' keep', '-gone', '+new'] }] },
    };
    const out = anon(p);
    assert.deepStrictEqual(out.tool_input.edits, [{ old_string: '<text len~3 lines=2>', new_string: '<text len~1 lines=1>', replace_all: false }]);
    assert.strictEqual(out.tool_input.todos[0].status, 'in_progress');
    assert.match(out.tool_input.todos[0].id, /^i-/);
    assert.deepStrictEqual(out.tool_response.structuredPatch[0].lines, [' x', '-x', '+x']);
    assert.deepStrictEqual(sm.diffFromPatch(out.tool_response.structuredPatch), sm.diffFromPatch(p.tool_response.structuredPatch));
  });

  test('a placeholder expands to filler with the same lines, so diff counts replay', () => {
    const texts = ['', 'one', 'a\nb\n', 'a\n\n\nb', '\n', 'x'.repeat(5000) + '\n' + 'y'.repeat(10),
      'Exit code 1\n', 'Exit code 1\n\n', 'out\nExit code 2\n', 'Exit code 1\nboom\nExit code 1'];
    for (const s of texts) {
      const back = recorder.expandText(recorder.freeText(s));
      assert.strictEqual(recorder.lineCount(back), recorder.lineCount(s), JSON.stringify(s));
      assert.strictEqual(back.endsWith('\n'), s.endsWith('\n'), JSON.stringify(s));
      assert.ok(Math.abs(back.length - s.length) <= Math.max(2, s.length * 0.05), `${back.length} vs ${s.length}`);
    }
    const input = { old_string: 'a\nb\nc', new_string: 'a\nb\nc\nd\ne' };
    const replayed = recorder.expandPlaceholders(anon(input));
    assert.deepStrictEqual(sm.diffFromInput(replayed), sm.diffFromInput(input));
  });

  test('keys: field names survive, a key that is data does not, __proto__ stays an own key', () => {
    const p = JSON.parse('{"tool_response":{"/home/alice/acme.txt":1,"alice@acme.com":"x","__proto__":{"polluted":true},"constructor":"y"}}');
    const out = anon(p);
    const keys = Object.keys(out.tool_response);
    assert.deepStrictEqual(keys, ['<key 0>', '<key 1>', '__proto__', 'constructor']);
    assert.strictEqual(Object.getPrototypeOf(out.tool_response), Object.prototype, 'no prototype was set');
    assert.strictEqual({}.polluted, undefined);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(out)).tool_response.__proto__, { polluted: true });
  });

  test('hostile input never throws: huge strings, deep nesting, cycles, non-JSON values', () => {
    assert.strictEqual(anon({ stdout: 'line\n'.repeat(1000000) }).stdout, '<text len~5000000 lines=1000000 eol>');
    let deep = { leaf: 'secret' };
    for (let i = 0; i < 10000; i++) deep = { d: [deep] };
    assert.doesNotThrow(() => JSON.stringify(anon(deep)));
    assert.ok(!JSON.stringify(anon(deep)).includes('secret'));
    const cyc = { a: 1 };
    cyc.self = cyc;
    assert.doesNotThrow(() => JSON.stringify(anon(cyc)));
    assert.deepStrictEqual(anon({ f: () => 1, u: undefined, s: Symbol('x') }), { f: null, u: null, s: null });
    assert.doesNotThrow(() => recorder.shapeText('\u0000\uffff\ud800-'.repeat(1000)));
    assert.strictEqual(anon(null), null);
    assert.strictEqual(anon('top-level text'), '<text len~14 lines=1>');
  });

  // Growth, not a flat budget (see Testing in CLAUDE.md): n against 8n, best
  // of three, the sizes interleaved. Linear code measures ~x8, quadratic x64.
  test('the shape rule and the anonymiser are linear', () => {
    const unit = 'git commit -m "Fix ACMEServer login" && AAAAAAAAAAAAa /home/alice/x.test.ts 2>&1 | ';
    const time = (n) => {
      const cmd = unit.repeat(n);
      const payload = { tool_input: { command: cmd }, tool_response: { stdout: 'line\n'.repeat(n * 20) } };
      const t0 = process.hrtime.bigint();
      recorder.shapeText(cmd);
      anon(payload);
      return Number(process.hrtime.bigint() - t0);
    };
    let small = Infinity;
    let large = Infinity;
    for (let i = 0; i < 3; i++) {
      small = Math.min(small, time(200));
      large = Math.min(large, time(1600));
    }
    assert.ok(large / small < 20, `x${(large / small).toFixed(1)} for 8x the input`);
  });

  test('anonymisation is deterministic, so a permission prompt still matches its tool call', () => {
    const call = { tool_name: 'Bash', tool_input: { command: 'git push origin main', description: 'Push the fix' } };
    assert.deepStrictEqual(anon(call), anon(JSON.parse(JSON.stringify(call))));
  });
});

// -- Records and the record file ---------------------------------------------

// The recorder reads its settings from process.env at call time; each test
// sets them in this (isolated) process and restores them.
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function readRecords(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

describe('replay -- the record file', () => {
  test('recordMode: unset and off-ish values are off, `full` is full, anything else is shape', () => {
    const cases = [[undefined, ''], ['', ''], ['0', ''], ['off', ''], ['false', ''], ['no', ''],
      ['1', 'shape'], ['shape', 'shape'], ['true', 'shape'], ['yes-please', 'shape'], ['full', 'full'], [' FULL ', 'full']];
    for (const [v, want] of cases) assert.strictEqual(recorder.recordMode({ CODE_CRUMB_RECORD: v }), want, String(v));
  });

  test('disabled: record() writes nothing at all', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-rec-off-'));
    try {
      withEnv({ HOME: home, USERPROFILE: home, CODE_CRUMB_RECORD: undefined }, () => {
        assert.strictEqual(recorder.record({ source: 'claude-hook', payload: { session_id: 'x' } }), false);
      });
      withEnv({ HOME: home, USERPROFILE: home, CODE_CRUMB_RECORD: '0' }, () => {
        assert.strictEqual(recorder.record({ source: 'claude-hook', payload: { session_id: 'x' } }), false);
      });
      assert.deepStrictEqual(fs.readdirSync(home), []);
    } finally { cleanup(home); }
  });

  test('shape mode: a dated file under HOME, header first, private modes, a key beside it', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-rec-on-'));
    try {
      withEnv({ HOME: home, USERPROFILE: home, CODE_CRUMB_RECORD: '1', CODE_CRUMB_RECORD_FILE: undefined }, () => {
        assert.ok(recorder.record({ source: 'claude-hook', editor: 'claude', argv: ['Stop'], raw: '{"session_id":"abc","hook_event_name":"Stop"}' }));
        assert.ok(recorder.record({ source: 'opencode', editor: 'opencode', payload: { type: 'session.idle', sessionId: 'abc' } }));
      });
      const dir = path.join(home, '.code-crumb-record');
      const files = fs.readdirSync(dir).sort();
      assert.strictEqual(files.length, 2, files.join(','));
      assert.match(files[0], /^\.code-crumb-record\.key$/);
      assert.match(files[1], /^\d{4}-\d{2}-\d{2}\.jsonl$/);
      const recs = readRecords(path.join(dir, files[1]));
      assert.strictEqual(recs.length, 3);
      assert.deepStrictEqual([recs[0].kind, recs[0].v, recs[0].mode], ['header', 1, 'shape']);
      assert.ok(recs[0].codeCrumb, 'the header names the version that recorded');
      assert.deepStrictEqual([recs[1].source, recs[1].event, recs[1].argv], ['claude-hook', 'Stop', ['Stop']]);
      assert.strictEqual(recs[1].payload.session_id, recs[2].payload.sessionId, 'one id, one pseudonym, across processes');
      assert.match(recs[1].payload.session_id, /^s-[0-9a-f]{12}$/);
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
        assert.strictEqual(fs.statSync(path.join(dir, files[1])).mode & 0o777, 0o600);
        assert.strictEqual(fs.statSync(path.join(dir, files[0])).mode & 0o777, 0o600);
      }
    } finally { cleanup(home); }
  });

  test('full mode keeps the raw payload; CODE_CRUMB_RECORD_FILE is taken from HOME', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-rec-full-'));
    try {
      const payload = { session_id: 'raw-id', prompt: 'my secret prompt' };
      withEnv({ HOME: home, USERPROFILE: home, CODE_CRUMB_RECORD: 'full', CODE_CRUMB_RECORD_FILE: 'bugs/one.jsonl' }, () => {
        assert.ok(recorder.record({ source: 'claude-hook', editor: 'claude', raw: JSON.stringify(payload) }));
      });
      const recs = readRecords(path.join(home, 'bugs', 'one.jsonl'));
      assert.strictEqual(recs[1].mode, 'full');
      assert.deepStrictEqual(recs[1].payload, payload);
      assert.ok(!fs.existsSync(path.join(home, 'bugs', '.code-crumb-record.key')), 'full mode needs no key');
    } finally { cleanup(home); }
  });

  test('a day\'s file stops growing at its cap', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-rec-cap-'));
    try {
      const file = path.join(home, 'cap.jsonl');
      fs.writeFileSync(file, '');
      fs.truncateSync(file, recorder.MAX_FILE_BYTES);   // sparse: cheap
      withEnv({ HOME: home, USERPROFILE: home, CODE_CRUMB_RECORD: '1', CODE_CRUMB_RECORD_FILE: file }, () => {
        assert.strictEqual(recorder.record({ source: 'opencode', payload: { type: 'session.idle' } }), false);
      });
      assert.strictEqual(fs.statSync(file).size, recorder.MAX_FILE_BYTES);
    } finally { cleanup(home); }
  });

  test('an unusable location costs the hook nothing: record() returns false, never throws', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-rec-bad-'));
    try {
      const blocker = path.join(home, 'blocker');
      fs.writeFileSync(blocker, 'a file where a directory should be');
      withEnv({ HOME: home, USERPROFILE: home, CODE_CRUMB_RECORD: '1', CODE_CRUMB_RECORD_FILE: path.join(blocker, 'x.jsonl') }, () => {
        assert.strictEqual(recorder.record({ source: 'opencode', payload: { type: 'session.idle' } }), false);
      });
    } finally { cleanup(home); }
  });

  test('a payload over 1 MB is a marker of its ids, never its body', () => {
    const body = JSON.stringify({ session_id: 'big-1', hook_event_name: 'PostToolUse', tool_name: 'Read',
      tool_input: { file_path: 'a' }, tool_response: { type: 'note', stdout: 'secret '.repeat(200000) }, tool_use_id: 'toolu_tail' });
    const rec = recorder.buildRecord({ source: 'claude-hook', editor: 'claude', raw: body.slice(0, recorder.MAX_INPUT),
      tail: body.slice(-4096), truncated: true }, 'shape', pseudonym, 1);
    assert.strictEqual(rec.truncated, true);
    assert.deepStrictEqual(Object.keys(rec.payload).sort(), ['hook_event_name', 'session_id', 'tool_name', 'tool_use_id']);
    assert.strictEqual(rec.payload.tool_use_id, pseudonym('t', 'toolu_tail'), 'tool_use_id from the tail');
    assert.ok(!JSON.stringify(rec).includes('secret'));
    // ...and replays as a payload over the cap, its tool_use_id after the body.
    const text = recorder.replayInput(rec);
    assert.ok(text.length > recorder.MAX_INPUT);
    assert.ok(text.lastIndexOf('"tool_use_id"') > text.indexOf('"tool_response"'));
  });

  test('stdin that is not JSON is recorded as text (shape) or kept (full)', () => {
    const shaped = recorder.buildRecord({ source: 'claude-hook', raw: 'not json at all' }, 'shape', pseudonym, 1);
    assert.deepStrictEqual([shaped.unparsed, shaped.payload], [true, '<text len~15 lines=1>']);
    const empty = recorder.buildRecord({ source: 'claude-hook', raw: '' }, 'shape', pseudonym, 1);
    assert.deepStrictEqual([empty.unparsed, empty.payload, recorder.replayInput(empty)], [true, '', '']);
    assert.strictEqual(recorder.buildRecord({ source: 'x', raw: 'not json' }, 'full', null, 1).payload, 'not json');
  });
});

// -- The hook points, end to end ---------------------------------------------

describe('replay -- recording through the real hooks and adapters', () => {
  // A live run recorded in shape mode, imported, and replayed: the replay
  // must reach every state and flag the live run reached. Details may differ
  // (a file's name is `x` in the replay) but not the +N -M of an edit.
  test('a recorded Claude Code turn imports and replays to the same states and flags', () => {
    const live = makeTempEnv('rt-live');
    const env = { ...live.env, CODE_CRUMB_RECORD: '1' };
    delete env.CLAUDE_SESSION_ID;
    const S = 'f00dcafe-1234-4abc-8def-0123456789ab';
    const edit = { file_path: '/home/alice/acme/app.js', old_string: 'a\nb', new_string: 'a\nb\nc\nd' };
    const events = [
      ['PostToolUse', { session_id: S, tool_name: 'Edit', tool_input: edit, tool_use_id: 'toolu_rt1',
        tool_response: { filePath: edit.file_path, oldString: edit.old_string, newString: edit.new_string } }],
      ['Stop', { session_id: S, stop_hook_active: false, last_assistant_message: 'Added c and d to the Acme app.' }],
    ];
    try {
      const liveStamps = new Map();
      const liveSteps = events.map(([ev, p]) => {
        runUpdateState(ev, { ...p, hook_event_name: ev }, env);
        return snapshot(live, liveStamps);
      });
      const recDir = path.join(live.tmp, '.code-crumb-record');
      const recFile = fs.readdirSync(recDir).find(f => f.endsWith('.jsonl'));
      const text = fs.readFileSync(path.join(recDir, recFile), 'utf8');
      assert.ok(!/alice|acme|f00dcafe|toolu_rt1/i.test(text), 'nothing private reached the recording');
      const { records } = parseRecording(text);
      assert.deepStrictEqual(records.map(r => [r.source, r.event, r.argv[0]]),
        events.map(([ev]) => ['claude-hook', ev, ev]));

      const fixtureFile = path.join(live.tmp, 'rt.jsonl');
      fs.writeFileSync(fixtureFile, toFixture(text));
      // With the recorder off this time: a hook must then record nothing.
      const replayed = replay(readFixture(fixtureFile), { record: false });
      const flags = (snap) => Object.values(snap.sessions).map(({ detail, ...rest }) => rest);
      const diffs = (snap) => Object.values(snap.sessions).map(s => (String(s.detail).match(/[+-]\d+/g) || []).join(' '));
      replayed.forEach((step, i) => {
        assert.deepStrictEqual(flags(step), flags(liveSteps[i]), `step ${i + 1} (${events[i][0]})`);
        assert.deepStrictEqual(diffs(step), diffs(liveSteps[i]), `step ${i + 1}: the edit's +N -M`);
        assert.strictEqual(step.global.state, liveSteps[i].global.state);
      });
    } finally { cleanup(live.tmp); }
  });

  test('a stdin adapter records each element of a batch', () => {
    const t = makeTempEnv('rec-batch');
    const env = { ...t.env, CODE_CRUMB_RECORD: '1' };
    delete env.CLAUDE_SESSION_ID;
    try {
      runAdapter(ADAPTERS.opencode, JSON.stringify([
        { type: 'tool.execute.before', sessionId: 'ses_b', callID: 'c1', tool: 'read', toolInput: { filePath: '/home/alice/a.js' }, seq: 1, pluginId: 'p' },
        { type: 'session.idle', sessionId: 'ses_b', seq: 2, pluginId: 'p' },
      ]), env);
      const dir = path.join(t.tmp, '.code-crumb-record');
      const recs = readRecords(path.join(dir, fs.readdirSync(dir).find(f => f.endsWith('.jsonl')))).filter(r => r.kind !== 'header');
      assert.deepStrictEqual(recs.map(r => [r.source, r.event]), [['opencode', 'tool.execute.before'], ['opencode', 'session.idle']]);
      assert.strictEqual(recs[0].payload.toolInput.filePath, '/home/x/a.js');
      assert.strictEqual(recs[0].payload.sessionId, recs[1].payload.sessionId);
      assert.strictEqual(readJSON(path.join(t.sessionsDir, 'ses_b.json')).state, 'happy', 'and the batch was applied');
    } finally { cleanup(t.tmp); }
  });
});

// -- The importer ------------------------------------------------------------

describe('replay -- turning a recording into a fixture', () => {
  test('shape pseudonyms are renumbered in order of first appearance; times become relative', () => {
    const s = pseudonym('s', 'sess-A');
    const recs = [
      { v: 1, kind: 'header', mode: 'shape', platform: 'linux', node: 'v22', codeCrumb: '9.9.9' },
      { v: 1, at: 1000, source: 'claude-hook', editor: 'claude', event: 'SubagentStart', mode: 'shape',
        payload: { session_id: s, agent_id: pseudonym('a', 'ag-1') } },
      { v: 1, at: 1500, source: 'codex-exec', editor: 'codex', event: 'thread.started', mode: 'shape',
        payload: { thread_id: pseudonym('s', 'sess-A'), id: pseudonym('i', 'sess-A') } },
    ];
    const out = toFixture(recs.map(r => JSON.stringify(r)).join('\n')).trim().split('\n').map(l => JSON.parse(l));
    assert.deepStrictEqual(out[0].recorded, { mode: 'shape', platform: 'linux', node: 'v22', codeCrumb: '9.9.9' });
    assert.strictEqual(out[0].synthetic, false);
    assert.deepStrictEqual(out[1].payload, { session_id: 's1', agent_id: 'a1' });
    assert.deepStrictEqual([out[1].at, out[2].at], [0, 500]);
    assert.deepStrictEqual(out[2].payload, { thread_id: 's1', id: 's1' }, 'one id under two keys stays one');
  });

  test('a full recording is anonymised on import; --session and --from/--to pick records', () => {
    const recs = [
      { v: 1, at: 5, source: 'claude-hook', editor: 'claude', event: 'UserPromptSubmit', mode: 'full', argv: ['UserPromptSubmit'],
        payload: { session_id: 'real-A', prompt: 'private words', cwd: '/home/alice/acme' } },
      { v: 1, at: 6, source: 'claude-hook', editor: 'claude', event: 'Stop', mode: 'full', payload: { session_id: 'real-B' } },
      { v: 1, at: 7, source: 'codex-exec', editor: 'codex', event: 'turn.started', mode: 'full', payload: { type: 'turn.started' } },
      { v: 1, at: 8, source: 'claude-hook', editor: 'claude', event: 'Stop', mode: 'full', payload: { session_id: 'real-A' } },
    ];
    const text = recs.map(r => JSON.stringify(r)).join('\n');
    const out = toFixture(text, { session: 'real-A' }).trim().split('\n').map(l => JSON.parse(l));
    assert.deepStrictEqual(out.slice(1).map(r => r.event), ['UserPromptSubmit', 'turn.started', 'Stop'],
      'the session\'s records and those naming none');
    assert.ok(!/real-|private|alice|acme/.test(JSON.stringify(out)));
    assert.deepStrictEqual(out[1].payload, { session_id: 's1', prompt: '<text len~13 lines=1>', cwd: '/home/x/x' });
    assert.ok(out.slice(1).every(r => r.mode === 'shape'));
    const sliced = toFixture(text, { from: 2, to: 3 }).trim().split('\n').map(l => JSON.parse(l));
    assert.deepStrictEqual(sliced.slice(1).map(r => r.at), [0, 1]);
  });
});

module.exports = suite;
