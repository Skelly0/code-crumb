'use strict';

// +================================================================+
// |  Attention-following main face                                 |
// |                                                                |
// |  The center face follows the session the user most recently    |
// |  prompted. These tests pin the pure policy, the list ordering, |
// |  the age formatter, and the hook fields that feed them.        |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSuite, makeTempEnv, cleanup, readJSON } = require('./_harness');
const suite = createSuite();
const { describe, test } = suite;

const { pickMainSession } = require('../renderer');

const S = (id, over = {}) => ({
  id, parentSession: null, isTeammate: false, stopped: false, stale: false,
  attentionAt: 0, lastUpdate: 0, ...over,
});

describe('renderer -- pickMainSession', () => {
  test('first pick: highest attention wins', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 10 }), S('b', { attentionAt: 20 })], currentId: null, pinnedId: null });
    assert.strictEqual(r.mainId, 'b');
    assert.strictEqual(r.pinnedId, null);
  });

  test('first pick with no attention stamps: newest write wins', () => {
    const r = pickMainSession({ sessions: [S('a', { lastUpdate: 5 }), S('b', { lastUpdate: 9 })], currentId: null, pinnedId: null });
    assert.strictEqual(r.mainId, 'b');
  });

  test('a newer prompt elsewhere moves the center', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 10 }), S('b', { attentionAt: 30 })], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'b');
  });

  test('a tie keeps the current main', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 10, lastUpdate: 1 }), S('b', { attentionAt: 10, lastUpdate: 99 })], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'a');
  });

  test('a live pin wins over a newer prompt', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 10 }), S('b', { attentionAt: 30 })], currentId: 'a', pinnedId: 'a' });
    assert.strictEqual(r.mainId, 'a');
    assert.strictEqual(r.pinnedId, 'a');
  });

  test('a pinned child (promoted agent) stays main while live', () => {
    const r = pickMainSession({ sessions: [S('p', { attentionAt: 50 }), S('p-agent-1', { parentSession: 'p' })], currentId: 'p-agent-1', pinnedId: 'p-agent-1' });
    assert.strictEqual(r.mainId, 'p-agent-1');
  });

  test('a stopped pin is released and the policy moves on', () => {
    const r = pickMainSession({ sessions: [S('p', { attentionAt: 50 }), S('p-agent-1', { parentSession: 'p', stopped: true })], currentId: 'p-agent-1', pinnedId: 'p-agent-1' });
    assert.strictEqual(r.mainId, 'p');
    assert.strictEqual(r.pinnedId, null);
  });

  test('a stale pin is released too', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 1, stale: true }), S('b', { attentionAt: 0 })], currentId: 'a', pinnedId: 'a' });
    assert.strictEqual(r.mainId, 'b');
    assert.strictEqual(r.pinnedId, null);
  });

  test('a pin for a session that vanished is released', () => {
    const r = pickMainSession({ sessions: [S('b')], currentId: 'gone', pinnedId: 'gone' });
    assert.strictEqual(r.mainId, 'b');
    assert.strictEqual(r.pinnedId, null);
  });

  test('children and teammates are never chosen unpinned', () => {
    const r = pickMainSession({ sessions: [S('p-agent-1', { parentSession: 'p', attentionAt: 99 }), S('mate', { isTeammate: true, attentionAt: 99 })], currentId: null, pinnedId: null });
    assert.strictEqual(r.mainId, null);
  });

  test('stopped and stale sessions are never chosen', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 99, stopped: true }), S('b', { attentionAt: 98, stale: true })], currentId: null, pinnedId: null });
    assert.strictEqual(r.mainId, null);
  });

  test('no live candidate keeps the current main', () => {
    const r = pickMainSession({ sessions: [S('a', { stopped: true })], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'a');
  });

  test('a current main that went stale loses to a live one', () => {
    const r = pickMainSession({ sessions: [S('a', { attentionAt: 99, stale: true }), S('b', { attentionAt: 1 })], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'b');
  });

  test('a current main missing from the set keeps its seat when nothing is live', () => {
    const r = pickMainSession({ sessions: [], currentId: 'a', pinnedId: null });
    assert.strictEqual(r.mainId, 'a');
  });
});

// -- update-state.js: the fields the policy reads ------------------------

const NODE = process.execPath;
const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');

function runUpdateState(event, inputObj, env) {
  try {
    execFileSync(NODE, [UPDATE_STATE, event], {
      input: typeof inputObj === 'string' ? inputObj : JSON.stringify(inputObj),
      env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status !== 0 && e.status !== null) throw e;
  }
}

const sessionFile = (dir, id) => path.join(dir, `${id}.json`);

describe('update-state -- attention fields', () => {
  test('SessionStart writes a session file with isSessionStart and lastPromptAt', () => {
    const t = makeTempEnv('att-1');
    try {
      const before = Date.now();
      runUpdateState('SessionStart', { session_id: 'att-1', source: 'startup' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-1'));
      assert.strictEqual(s.isSessionStart, true);
      assert.strictEqual(s.state, 'idle');
      assert.ok(s.lastPromptAt >= before, 'lastPromptAt stamped');
      assert.ok(!s.stopped);
    } finally { cleanup(t.tmp); }
  });

  test('SessionStart from compaction does not stamp lastPromptAt', () => {
    const t = makeTempEnv('att-2');
    try {
      runUpdateState('SessionStart', { session_id: 'att-2', source: 'compact' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-2'));
      assert.strictEqual(s.lastPromptAt, undefined);
    } finally { cleanup(t.tmp); }
  });

  test('a compaction restart preserves the session lastPromptAt exactly', () => {
    // A compact SessionStart is the same live session: it must not demote the
    // window the user is working in from "addressed at T" to "never addressed".
    const t = makeTempEnv('att-2b');
    try {
      runUpdateState('UserPromptSubmit', { session_id: 'att-2b', prompt: 'hi' }, t.env);
      const first = readJSON(sessionFile(t.sessionsDir, 'att-2b')).lastPromptAt;
      assert.ok(first > 0);
      const spin = Date.now() + 3; while (Date.now() < spin) { /* 3ms */ }
      runUpdateState('SessionStart', { session_id: 'att-2b', source: 'compact' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-2b'));
      assert.strictEqual(s.lastPromptAt, first, 'carried through the compaction');
      assert.strictEqual(s.isSessionStart, true);
    } finally { cleanup(t.tmp); }
  });

  test('a real new session re-stamps lastPromptAt over the old one', () => {
    const t = makeTempEnv('att-2c');
    try {
      runUpdateState('UserPromptSubmit', { session_id: 'att-2c', prompt: 'hi' }, t.env);
      const first = readJSON(sessionFile(t.sessionsDir, 'att-2c')).lastPromptAt;
      const spin = Date.now() + 3; while (Date.now() < spin) { /* 3ms */ }
      runUpdateState('SessionStart', { session_id: 'att-2c', source: 'startup' }, t.env);
      const second = readJSON(sessionFile(t.sessionsDir, 'att-2c')).lastPromptAt;
      assert.ok(second > first, 'startup is a fresh session, not a continuation');
    } finally { cleanup(t.tmp); }
  });

  test('UserPromptSubmit stamps lastPromptAt and a later tool event preserves it', () => {
    const t = makeTempEnv('att-3');
    try {
      runUpdateState('UserPromptSubmit', { session_id: 'att-3', prompt: 'hi' }, t.env);
      const first = readJSON(sessionFile(t.sessionsDir, 'att-3')).lastPromptAt;
      assert.ok(first > 0);
      runUpdateState('PreToolUse', { session_id: 'att-3', tool_name: 'Read', tool_input: { file_path: 'a.js' } }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-3'));
      assert.strictEqual(s.state, 'reading');
      assert.strictEqual(s.lastPromptAt, first, 'sticky across later writes');
    } finally { cleanup(t.tmp); }
  });

  test('a second UserPromptSubmit moves lastPromptAt forward', () => {
    const t = makeTempEnv('att-4');
    try {
      runUpdateState('UserPromptSubmit', { session_id: 'att-4', prompt: 'a' }, t.env);
      const first = readJSON(sessionFile(t.sessionsDir, 'att-4')).lastPromptAt;
      const spin = Date.now() + 3; while (Date.now() < spin) { /* 3ms */ }
      runUpdateState('UserPromptSubmit', { session_id: 'att-4', prompt: 'b' }, t.env);
      const second = readJSON(sessionFile(t.sessionsDir, 'att-4')).lastPromptAt;
      assert.ok(second > first);
    } finally { cleanup(t.tmp); }
  });

  test('Stop writes idle / between turns with turnEnded and no stopped', () => {
    const t = makeTempEnv('att-5');
    try {
      runUpdateState('PreToolUse', { session_id: 'att-5', tool_name: 'Bash', tool_input: { command: 'ls' } }, t.env);
      runUpdateState('Stop', { session_id: 'att-5' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-5'));
      assert.strictEqual(s.state, 'idle');
      assert.strictEqual(s.detail, 'between turns');
      assert.strictEqual(s.turnEnded, true);
      assert.ok(!s.stopped, 'a turn end is not a session end');
    } finally { cleanup(t.tmp); }
  });

  test('a late PostToolUse after Stop still reads as a finished turn; the next PreToolUse does not', () => {
    // The global-owner guard already re-stamps `stopped` on a late PostToolUse
    // when this session owns the global file; the session-file guard added
    // here covers the parallel window that does not. Either way the turn
    // must still read as ended, and a new turn must clear both.
    const t = makeTempEnv('att-6');
    try {
      runUpdateState('Stop', { session_id: 'att-6' }, t.env);
      runUpdateState('PostToolUse', { session_id: 'att-6', tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_response: { stdout: 'ok' } }, t.env);
      const late = readJSON(sessionFile(t.sessionsDir, 'att-6'));
      assert.ok(late.stopped || late.turnEnded, 'still ended after a late PostToolUse');
      runUpdateState('PreToolUse', { session_id: 'att-6', tool_name: 'Read', tool_input: { file_path: 'b.js' } }, t.env);
      const fresh = readJSON(sessionFile(t.sessionsDir, 'att-6'));
      assert.ok(!fresh.stopped && !fresh.turnEnded, 'a new turn clears both');
    } finally { cleanup(t.tmp); }
  });

  test('a parallel window (not the global owner) keeps turnEnded through a late PostToolUse', () => {
    const t = makeTempEnv('att-6b');
    try {
      // Another session owns the global file and is fresh.
      const { writeJsonAtomic } = require('../shared');
      writeJsonAtomic(t.stateFile, { state: 'coding', detail: '', timestamp: Date.now(), sessionId: 'owner' });
      runUpdateState('Stop', { session_id: 'att-6b' }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'att-6b')).turnEnded, true);
      runUpdateState('PostToolUse', { session_id: 'att-6b', tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_response: { stdout: 'ok' } }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'att-6b')).turnEnded, true, 'session-file guard carries it');
    } finally { cleanup(t.tmp); }
  });

  test('an agent Stop does not stamp turnEnded on the agent orbital', () => {
    const t = makeTempEnv('att-7');
    try {
      runUpdateState('Stop', { session_id: 'att-7', agent_id: 'ag1', agent_type: 'Explore' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-7-agent-ag1'));
      assert.strictEqual(s.turnEnded, undefined);
      assert.strictEqual(s.state, 'responding');
    } finally { cleanup(t.tmp); }
  });

  test('fallback (empty stdin): SessionStart and UserPromptSubmit stamp lastPromptAt, Stop stamps turnEnded', () => {
    const t = makeTempEnv('att-8');
    try {
      runUpdateState('SessionStart', '', t.env);
      assert.ok(readJSON(sessionFile(t.sessionsDir, 'att-8')).lastPromptAt > 0);
      runUpdateState('UserPromptSubmit', '', t.env);
      assert.ok(readJSON(sessionFile(t.sessionsDir, 'att-8')).lastPromptAt > 0);
      runUpdateState('Stop', '', t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-8'));
      assert.strictEqual(s.turnEnded, true);
      assert.strictEqual(s.state, 'idle');
    } finally { cleanup(t.tmp); }
  });
});

// -- adapters: attention for non-Claude editors ---------------------------

const OPENCODE_ADAPTER = path.join(__dirname, '..', 'adapters', 'opencode-adapter.js');
const CODEX_WRAPPER = path.join(__dirname, '..', 'adapters', 'codex-wrapper.js');

// The wrapper guards main() behind require.main, so requiring it spawns
// nothing. test.js redirected HOME before loading this file, so shared.js has
// already fixed SESSIONS_DIR inside the runner's throwaway home.
const wrapper = require('../adapters/codex-wrapper');
const { SESSIONS_DIR, safeFilename } = require('../shared');

function runAdapter(script, payload, env) {
  try {
    execFileSync(NODE, [script], {
      input: JSON.stringify(payload), env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status !== 0 && e.status !== null) throw e;
  }
}

// A stand-in `codex` on PATH that replays a JSONL fixture through the real
// wrapper spawn path (the pattern lives in test-adapters.js; copied, not
// imported). writeSync flushes each line rather than leaving it in a pipe.
const FAKE_SRC = [
  "'use strict';",
  "const fs = require('fs');",
  "const text = fs.readFileSync(process.env.CODEX_FAKE_FIXTURE, 'utf8');",
  "for (const line of text.split('\\n')) {",
  "  if (line.trim()) fs.writeSync(1, line + '\\n');",
  "}",
  '',
].join('\n');

function runFakeCodex(events) {
  const base = makeTempEnv('codex-thread');
  const binDir = path.join(base.tmp, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const fixture = path.join(base.tmp, 'fixture.jsonl');
  fs.writeFileSync(fixture, events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(binDir, 'codex-fake.js'), FAKE_SRC, 'utf8');

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
    execFileSync(NODE, [CODEX_WRAPPER, 'a prompt'], {
      env, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status !== 0 && e.status !== null) throw e;
  }
  return base;
}

describe('adapters -- lastPromptAt', () => {
  test('the first event of a session stamps lastPromptAt and a tool event preserves it', () => {
    const t = makeTempEnv();
    try {
      runAdapter(OPENCODE_ADAPTER, { type: 'session.created', sessionId: 'ses_a' }, t.env);
      const first = readJSON(sessionFile(t.sessionsDir, 'ses_a')).lastPromptAt;
      assert.ok(first > 0, 'stamped on session start');
      runAdapter(OPENCODE_ADAPTER, { type: 'tool.execute.before', sessionId: 'ses_a', tool: 'read', toolInput: { filePath: 'a.js' } }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'ses_a')).lastPromptAt, first, 'sticky');
    } finally { cleanup(t.tmp); }
  });

  test('the first event after a turn end is a new turn and re-stamps', () => {
    const t = makeTempEnv();
    try {
      runAdapter(OPENCODE_ADAPTER, { type: 'session.created', sessionId: 'ses_b' }, t.env);
      const first = readJSON(sessionFile(t.sessionsDir, 'ses_b')).lastPromptAt;
      runAdapter(OPENCODE_ADAPTER, { type: 'session.idle', sessionId: 'ses_b' }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'ses_b')).stopped, true, 'turn end still marks the file stopped');
      const spin = Date.now() + 3; while (Date.now() < spin) { /* 3ms */ }
      runAdapter(OPENCODE_ADAPTER, { type: 'tool.execute.before', sessionId: 'ses_b', tool: 'read', toolInput: { filePath: 'a.js' } }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'ses_b'));
      assert.ok(s.lastPromptAt > first, 'new turn = new attention');
      assert.ok(!s.stopped);
    } finally { cleanup(t.tmp); }
  });

  test('a turn end does not itself stamp attention', () => {
    const t = makeTempEnv();
    try {
      runAdapter(OPENCODE_ADAPTER, { type: 'session.created', sessionId: 'ses_c' }, t.env);
      const first = readJSON(sessionFile(t.sessionsDir, 'ses_c')).lastPromptAt;
      const spin = Date.now() + 3; while (Date.now() < spin) { /* 3ms */ }
      runAdapter(OPENCODE_ADAPTER, { type: 'session.idle', sessionId: 'ses_c' }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'ses_c')).lastPromptAt, first);
    } finally { cleanup(t.tmp); }
  });

  test('a live session file with no stamp self-heals on the next event', () => {
    // Reachable two ways: an `error` can be the first event a session writes,
    // and an upgrade can land mid-turn over a pre-feature file. Neither should
    // leave the window unaddressable for the rest of the turn.
    const t = makeTempEnv();
    try {
      const { writeJsonAtomic } = require('../shared');
      fs.mkdirSync(t.sessionsDir, { recursive: true });
      writeJsonAtomic(sessionFile(t.sessionsDir, 'ses_d'), {
        session_id: 'ses_d', state: 'coding', detail: '', timestamp: Date.now(), stopped: false,
      });
      runAdapter(OPENCODE_ADAPTER, { type: 'tool.execute.before', sessionId: 'ses_d', tool: 'read', toolInput: { filePath: 'a.js' } }, t.env);
      assert.ok(readJSON(sessionFile(t.sessionsDir, 'ses_d')).lastPromptAt > 0, 'healed, not blind for the turn');
    } finally { cleanup(t.tmp); }
  });

  // In-process on purpose: telling a carried stamp from a re-stamped one needs
  // the session file read after each single event, which one subprocess run --
  // which only ever leaves its final file behind -- cannot give deterministically.
  test('codex-wrapper: a turn start re-stamps, the rest of the turn carries it', () => {
    // A unique thread id per run: the wrapper is a module, so its lastPromptAt
    // and sessionId are shared with any other in-process user of it.
    const threadId = `att-wrap-${Date.now()}`;
    const file = path.join(SESSIONS_DIR, safeFilename(`codex-${threadId}`) + '.json');
    const spin = () => { const until = Date.now() + 3; while (Date.now() < until) { /* 3ms */ } };

    wrapper.handleEvent({ type: 'thread.started', thread_id: threadId });
    assert.ok(fs.existsSync(file), 'thread.started writes the session file');
    const a = readJSON(file).lastPromptAt;
    assert.ok(a > 0, 'thread.started stamps');

    spin();
    wrapper.handleEvent({ type: 'turn.started' });
    const b = readJSON(file).lastPromptAt;
    assert.ok(b > a, 'a turn start is a new prompt, so it re-stamps');

    spin();
    wrapper.handleEvent({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } });
    const mid = readJSON(file);
    assert.strictEqual(mid.lastPromptAt, b, 'a tool call carries the stamp, never re-stamps');
    assert.ok(mid.timestamp > b, 'and the write itself is later than the stamp it carries');

    wrapper.handleEvent({ type: 'turn.completed', usage: {} });
    const last = readJSON(file);
    assert.strictEqual(last.lastPromptAt, b, 'still the turn stamp when the turn ends');
    assert.strictEqual(last.stopped, true);
  });

  test('codex-wrapper carries the stamp through a real spawned run', () => {
    // End to end over the real spawn path. The final file is the
    // codex.on('close') commit rather than the turn.completed one (both mark
    // it stopped), so this pins the stamp's survival to the end of the process.
    const t = runFakeCodex([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'turn.completed' },
    ]);
    try {
      const s = readJSON(sessionFile(t.sessionsDir, 'codex-t1'));
      assert.ok(s.lastPromptAt > 0, 'stamped');
      assert.ok(s.lastPromptAt <= s.timestamp, 'never later than the write carrying it');
      assert.strictEqual(s.stopped, true, 'the run ended stopped');
    } finally { cleanup(t.tmp); }
  });
});

// -- grid.js: ordering, age, main-in-faces ---------------------------------

const { MiniFace, OrbitalSystem, orderSessionList, formatAge } = require('../grid');
const { writeJsonAtomic } = require('../shared');

function mf(id, over = {}) {
  const f = new MiniFace(id);
  Object.assign(f, over);
  return f;
}

describe('grid -- formatAge', () => {
  test('seconds under a minute', () => { assert.strictEqual(formatAge(3200), '3s'); });
  test('minutes under an hour', () => { assert.strictEqual(formatAge(125000), '2m'); });
  test('hours beyond', () => { assert.strictEqual(formatAge(3700000), '1h'); });
  test('negative or NaN reads as 0s', () => { assert.strictEqual(formatAge(-5), '0s'); assert.strictEqual(formatAge(NaN), '0s'); });
});

describe('grid -- orderSessionList', () => {
  const main = { sessionId: 'M', isMain: true, label: 'main' };

  test('main first, its children under it, then other top-levels by attention with their children, orphans last', () => {
    const faces = [
      mf('B', { lastPromptAt: 20, firstSeen: 5 }),
      mf('M-agent-2', { parentSession: 'M', firstSeen: 9 }),
      mf('A', { lastPromptAt: 30, firstSeen: 6 }),
      mf('M-agent-1', { parentSession: 'M', firstSeen: 3 }),
      mf('A-agent-1', { parentSession: 'A', firstSeen: 7 }),
      mf('lost-agent', { parentSession: 'ghost', firstSeen: 1 }),
    ];
    const out = orderSessionList(main, faces);
    assert.deepStrictEqual(out.map(e => e.face.sessionId),
      ['M', 'M-agent-1', 'M-agent-2', 'A', 'A-agent-1', 'B', 'lost-agent']);
    assert.deepStrictEqual(out.map(e => e.depth), [0, 1, 1, 0, 1, 0, 0]);
  });

  test('equal attention breaks on firstSeen', () => {
    const out = orderSessionList(main, [mf('B', { firstSeen: 9 }), mf('A', { firstSeen: 2 })]);
    assert.deepStrictEqual(out.map(e => e.face.sessionId), ['M', 'A', 'B']);
  });

  test('no main: top-levels only', () => {
    const out = orderSessionList(null, [mf('A', { lastPromptAt: 1 })]);
    assert.deepStrictEqual(out.map(e => e.face.sessionId), ['A']);
  });

  test('teammates without a parent are ordered as top-level entries', () => {
    const out = orderSessionList(main, [mf('mate', { isTeammate: true, teammateName: 'reviewer' }), mf('A', { lastPromptAt: 5 })]);
    assert.deepStrictEqual(out.map(e => e.face.sessionId), ['M', 'A', 'mate']);
  });
});

describe('grid -- the main session is loaded but kept off the ring', () => {
  test('loadSessions(mainId) keeps the main in faces, getSortedFaces excludes it, liveChildCount still counts', () => {
    const t = makeTempEnv();
    try {
      const dir = t.sessionsDir;
      fs.mkdirSync(dir, { recursive: true });
      const now = Date.now();
      writeJsonAtomic(path.join(dir, 'M.json'), { session_id: 'M', state: 'coding', timestamp: now, lastPromptAt: now, toolCalls: 7, filesEdited: 2 });
      writeJsonAtomic(path.join(dir, 'M-agent-1.json'), { session_id: 'M-agent-1', state: 'reading', timestamp: now, parentSession: 'M' });
      writeJsonAtomic(path.join(dir, 'B.json'), { session_id: 'B', state: 'idle', timestamp: now });
      const orb = new OrbitalSystem();
      orb._sessionsDir = dir; // OrbitalSystem reads this._sessionsDir || SESSIONS_DIR
      orb.loadSessions('M');
      assert.ok(orb.faces.has('M'), 'main is loaded');
      assert.strictEqual(orb.faces.get('M').lastPromptAt, now);
      assert.strictEqual(orb.faces.get('M').toolCalls, 7);
      assert.strictEqual(orb.faces.get('M').filesEdited, 2);
      assert.deepStrictEqual(orb.getSortedFaces().map(f => f.sessionId).sort(), ['B', 'M-agent-1']);
      assert.strictEqual(orb.liveChildCount(), 1);
    } finally { cleanup(t.tmp); }
  });

  test('loadSessions(null) loads everything and excludes nothing', () => {
    const t = makeTempEnv();
    try {
      const dir = t.sessionsDir;
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(path.join(dir, 'A.json'), { session_id: 'A', state: 'idle', timestamp: Date.now() });
      const orb = new OrbitalSystem();
      orb._sessionsDir = dir;
      orb.loadSessions(null);
      assert.deepStrictEqual(orb.getSortedFaces().map(f => f.sessionId), ['A']);
      assert.strictEqual(orb.mainSessionId, null);
    } finally { cleanup(t.tmp); }
  });

  test('changing the main re-sorts the ring', () => {
    const t = makeTempEnv();
    try {
      const dir = t.sessionsDir;
      fs.mkdirSync(dir, { recursive: true });
      writeJsonAtomic(path.join(dir, 'A.json'), { session_id: 'A', state: 'idle', timestamp: Date.now() });
      writeJsonAtomic(path.join(dir, 'B.json'), { session_id: 'B', state: 'idle', timestamp: Date.now() });
      const orb = new OrbitalSystem();
      orb._sessionsDir = dir;
      orb.loadSessions('A');
      assert.deepStrictEqual(orb.getSortedFaces().map(f => f.sessionId), ['B']);
      orb.setMainSession('B');
      assert.deepStrictEqual(orb.getSortedFaces().map(f => f.sessionId), ['A']);
    } finally { cleanup(t.tmp); }
  });
});

// -- grid.js: the list itself ------------------------------------------------

const { renderSessionList, MIN_SESSION_LIST_ROWS } = require('../grid');
const { PALETTES } = require('../themes');
const THEMES = PALETTES[0].themes;
// The list is absolute-positioned: rows are separated by cursor moves, not
// newlines. Split on those first, then strip the colour codes.
const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
const listRows = (raw) => raw.split(/\x1b\[\d+;\d+H/).map(strip).filter(r => r.trim());
const TREE = String.fromCharCode(0x2514);   // └
const PARENT = String.fromCharCode(0x21b3); // ↳
const PIN = String.fromCharCode(0x229b);    // ⊛
const STAR = String.fromCharCode(0x2605);   // ★

describe('grid -- renderSessionList tree and info row', () => {
  const now = Date.now();
  const main = { sessionId: 'M', isMain: true, isPinned: false, label: 'claude', state: 'coding', detail: 'edit a.js', editor: 'claude', toolCalls: 12, filesEdited: 3, lastUpdate: now - 3000 };

  test('a child row carries the tree marker and names its parent on the info row', () => {
    const child = mf('M-agent-1', { parentSession: 'M', agentType: 'Explore', label: 'explore', state: 'reading', lastUpdate: now - 65000 });
    const out = strip(renderSessionList(80, 40, orderSessionList(main, [child]), THEMES, main, 'M'));
    assert.ok(out.includes(TREE), 'tree marker on the child');
    assert.ok(out.includes('Explore'), 'agent type on the info row');
    assert.ok(out.includes('1m'), 'age on the info row');
    assert.ok(out.includes(PARENT + ' claude'), 'parent label on the info row');
  });

  test('the main row shows tools, files and age', () => {
    const out = strip(renderSessionList(80, 40, [], THEMES, main, 'M'));
    assert.ok(/12 tools/.test(out));
    assert.ok(/3 files/.test(out));
    assert.ok(/\b3s\b/.test(out));
  });

  test('a teammate row shows its team and parent', () => {
    const mate = mf('mate', { parentSession: 'M', isTeammate: true, teamName: 'core', teammateName: 'reviewer', label: 'reviewer', lastUpdate: now });
    const out = strip(renderSessionList(80, 40, orderSessionList(main, [mate]), THEMES, main, 'M'));
    assert.ok(out.includes('core'));
    assert.ok(out.includes(PARENT + ' claude'));
  });

  test('selection by id highlights that row', () => {
    const other = mf('B', { label: 'other', state: 'idle', lastUpdate: now });
    const rows = listRows(renderSessionList(80, 40, orderSessionList(main, [other]), THEMES, main, 'B'));
    const marker = String.fromCharCode(0x25b8);
    const lines = rows.filter(l => l.includes(marker));
    assert.strictEqual(lines.length, 1);
    assert.ok(lines[0].includes('other'));
  });

  test('footer says pin on the unpinned main row and unpin on the pinned one', () => {
    const outA = strip(renderSessionList(80, 40, [], THEMES, main, 'M'));
    assert.ok(/\u23ce pin\b/.test(outA) && !/pin\+promote/.test(outA));
    const outB = strip(renderSessionList(80, 40, [], THEMES, { ...main, isPinned: true }, 'M'));
    assert.ok(/\u23ce unpin/.test(outB));
    assert.ok(outB.includes(PIN));
  });

  test('footer says pin+promote on any other row', () => {
    const other = mf('B', { label: 'other', state: 'idle', lastUpdate: now });
    const out = strip(renderSessionList(80, 40, orderSessionList(main, [other]), THEMES, main, 'B'));
    assert.ok(/pin\+promote/.test(out));
  });

  test('draws nothing below MIN_SESSION_LIST_ROWS and never overruns above it', () => {
    assert.strictEqual(renderSessionList(80, MIN_SESSION_LIST_ROWS - 1, [], THEMES, main, 'M'), '');
    const many = Array.from({ length: 9 }, (_, i) => mf(`s${i}`, { label: `s${i}`, state: 'idle', lastUpdate: now }));
    for (const rows of [MIN_SESSION_LIST_ROWS, 15, 20, 24]) {
      const out = renderSessionList(80, rows, orderSessionList(main, many), THEMES, main, 's8');
      const positions = [...out.matchAll(/\x1b\[(\d+);\d+H/g)].map(m => Number(m[1]));
      assert.ok(Math.max(...positions) <= rows, `rows=${rows}: bottom border at ${Math.max(...positions)}`);
      assert.ok(Math.min(...positions) >= 1);
    }
  });

  test('every row stays exactly boxW wide with the info row present', () => {
    const child = mf('M-agent-1', { parentSession: 'M', agentType: 'general-purpose', label: 'a very long', state: 'reading', lastUpdate: now });
    const rows = listRows(renderSessionList(80, 40, orderSessionList(main, [child]), THEMES, main, 'M'));
    const widths = new Set(rows.map(r => r.length));
    assert.strictEqual(widths.size, 1, `row widths differ: ${[...widths].join(',')}`);
  });

  test('plain face arrays and numeric selection still work (legacy callers)', () => {
    const other = mf('B', { label: 'other', state: 'idle', lastUpdate: now });
    const out = strip(renderSessionList(80, 40, [other], THEMES, main, 1));
    assert.ok(out.includes('other'));
    assert.ok(out.includes(STAR));
  });
});

module.exports = suite;
