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

  test('SessionStart from compaction does not stamp lastPromptAt over a live file', () => {
    const t = makeTempEnv('att-2');
    try {
      // A predecessor file exists (this is the same live session restarting),
      // so the compaction carries whatever it holds -- here, nothing.
      runUpdateState('PreToolUse', { session_id: 'att-2', tool_name: 'Read', tool_input: { file_path: 'a.js' } }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'att-2')).lastPromptAt, undefined);
      runUpdateState('SessionStart', { session_id: 'att-2', source: 'compact' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-2'));
      assert.strictEqual(s.lastPromptAt, undefined, 'compaction is not the user addressing the window');
    } finally { cleanup(t.tmp); }
  });

  test('a compact SessionStart with no predecessor file stamps lastPromptAt', () => {
    // The one case where a compaction must stamp: there is no file left to
    // carry from (the renderer's stale purge got it, or the file never
    // existed). Not stamping leaves the window at attention 0 -- permanently
    // ineligible for the center -- and only a fresh user prompt could fix it.
    const t = makeTempEnv('att-2d');
    try {
      const before = Date.now();
      assert.ok(!fs.existsSync(sessionFile(t.sessionsDir, 'att-2d')), 'no predecessor');
      runUpdateState('SessionStart', { session_id: 'att-2d', source: 'compact' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'att-2d'));
      assert.ok(s.lastPromptAt >= before, `stamped fresh, got ${s.lastPromptAt}`);
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

  test('a late PostToolUse after Stop carries turnEnded, never stopped, even for the global owner', () => {
    // This session DOES own the global state file, so the owner guard fires --
    // and its `stopped` re-stamp is scoped to the global write. On the session
    // file `stopped` means SESSION ENDED: leaking it here retired a live
    // window in the orbital loader, so the policy dropped the attended session
    // (auto-releasing a pin) and ignored its next 10s of writes. The owner
    // case is now exactly the parallel-window case: turnEnded, no stopped.
    const t = makeTempEnv('att-6');
    try {
      runUpdateState('Stop', { session_id: 'att-6' }, t.env);
      assert.strictEqual(readJSON(t.stateFile).stopped, true, 'Stop released global ownership');
      runUpdateState('PostToolUse', { session_id: 'att-6', tool_name: 'Read', tool_input: { file_path: 'a.js' }, tool_response: { stdout: 'ok' } }, t.env);
      const late = readJSON(sessionFile(t.sessionsDir, 'att-6'));
      assert.strictEqual(late.turnEnded, true, 'still a finished turn after a late PostToolUse');
      assert.ok(!late.stopped, 'but NOT a finished session -- the orbital stays live');
      assert.strictEqual(readJSON(t.stateFile).stopped, true,
        'the global file keeps its stopped flag: ownership is not resurrected');
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
      const ended = readJSON(sessionFile(t.sessionsDir, 'ses_b'));
      assert.strictEqual(ended.turnEnded, true, 'turn end marks the file turnEnded');
      assert.ok(!ended.stopped, 'a turn end must not retire the session (stopped is for session_end)');
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
    const file = path.join(SESSIONS_DIR, safeFilename(threadId) + '.json');
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
    assert.strictEqual(last.turnEnded, true, 'a turn end writes turnEnded to the session file');
    assert.strictEqual(last.stopped, false, 'stopped is reserved for the close handler');
  });

  test('codex-wrapper carries the stamp through a real spawned run', () => {
    // End to end over the real spawn path. The final file is the
    // codex.on('close') commit rather than the turn.completed one (only the
    // close marks it stopped), so this pins the stamp's survival to the end of
    // the process.
    const t = runFakeCodex([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'turn.completed' },
    ]);
    try {
      const s = readJSON(sessionFile(t.sessionsDir, 't1'));
      assert.ok(s.lastPromptAt > 0, 'stamped');
      assert.ok(s.lastPromptAt <= s.timestamp, 'never later than the write carrying it');
      assert.strictEqual(s.stopped, true, 'the run ended stopped');
    } finally { cleanup(t.tmp); }
  });
});

// -- grid.js: ordering, age, main-in-faces ---------------------------------

const { MiniFace, OrbitalSystem, orderSessionList, listNavigableIds, formatAge } = require('../grid');
const { writeJsonAtomic, STATE_FILE } = require('../shared');

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

describe('grid -- listNavigableIds', () => {
  test('a stopped entry is drawn but never selectable', () => {
    // A finished session lingers on the list for ~10s so the user sees it end.
    // Landing on it would be a dead key: pinning a stopped session is undone
    // by the policy on the same tick.
    const main = { sessionId: 'M', isMain: true, label: 'main' };
    const entries = orderSessionList(main, [
      mf('A', { lastPromptAt: 30 }),
      mf('gone', { lastPromptAt: 20, stopped: true }),
    ]);
    assert.deepStrictEqual(entries.map(e => e.face.sessionId), ['M', 'A', 'gone'],
      'sanity: the stopped row is still rendered');
    assert.deepStrictEqual(listNavigableIds(entries), ['M', 'A']);
  });

  test('the main row stays navigable even when it reads as stopped', () => {
    // Between turns the main row's `stopped` is the folded turnEnded, and
    // Enter on it must still pin/unpin.
    const main = { sessionId: 'M', isMain: true, stopped: true, label: 'main' };
    const entries = orderSessionList(main, [mf('A', { lastPromptAt: 1 })]);
    assert.deepStrictEqual(listNavigableIds(entries), ['M', 'A']);
  });

  test('empty and malformed input degrade to an empty list', () => {
    assert.deepStrictEqual(listNavigableIds([]), []);
    assert.deepStrictEqual(listNavigableIds(null), []);
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

  test('a cold load does not declare a top-level session dead for showing a reward face', () => {
    // The face is built from the file and judged in the SAME pass, before any
    // tick() has moved a completion state on. Applying the 10s completion cut
    // to a top-level session therefore killed a live window whose last write
    // happened to be `proud` -- and on win32, with no pid, it never came back
    // as a candidate for the center. Children keep the short cut: an agent
    // that reported `happy` and went quiet really is finished.
    const t = makeTempEnv();
    try {
      const dir = t.sessionsDir;
      fs.mkdirSync(dir, { recursive: true });
      const now = Date.now();
      const old = new Date(now - 15000);
      const seed = (name, obj) => {
        const fp = path.join(dir, name);
        writeJsonAtomic(fp, obj);
        fs.utimesSync(fp, old, old);
      };
      seed('A.json', { session_id: 'A', state: 'proud', timestamp: now - 15000, lastPromptAt: now - 15000 });
      seed('P-agent-1.json', { session_id: 'P-agent-1', parentSession: 'P', state: 'happy', timestamp: now - 15000 });
      const orb = new OrbitalSystem();
      orb._sessionsDir = dir;
      orb.loadSessions(null);
      assert.ok(orb.faces.has('A'), 'the top-level reward face survives the load');
      assert.ok(!orb.faces.get('A').isStale(), 'and is not stale -- ORPHAN_TIMEOUT applies, not the 10s cut');
      assert.ok(!orb.faces.has('P-agent-1'), 'the finished child is dropped on the 10s cut');
    } finally { cleanup(t.tmp); }
  });

  test('the purge never unlinks the main session file, however stale', () => {
    // On win32 there is no pid, so the main's face goes stale at
    // ORPHAN_TIMEOUT (90s) and stops protecting its file 30s before the
    // STALE_MS purge fires -- deleting the very file the renderer reads.
    const t = makeTempEnv();
    try {
      const dir = t.sessionsDir;
      fs.mkdirSync(dir, { recursive: true });
      const now = Date.now();
      const old = new Date(now - 130000);
      const seed = (name, obj) => {
        const fp = path.join(dir, name);
        writeJsonAtomic(fp, obj);
        fs.utimesSync(fp, old, old);
        return fp;
      };
      const mainFp = seed('M.json', { session_id: 'M', state: 'coding', timestamp: now - 130000, lastPromptAt: now - 130000 });
      const otherFp = seed('B.json', { session_id: 'B', state: 'coding', timestamp: now - 130000 });
      const orb = new OrbitalSystem();
      orb._sessionsDir = dir;
      orb.loadSessions('M');   // no faces yet: nothing else protects either file
      assert.ok(fs.existsSync(mainFp), 'the center keeps its file');
      assert.ok(!fs.existsSync(otherFp), 'an unrelated stale top-level file is still purged');
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
  // lastUpdate sits in the MIDDLE of the "3s" bucket, not on its edge: the age
  // is computed from a second Date.now() inside the renderer, so 3000 exactly
  // would read as 4s after a 1s stall and as 2s under any backward clock
  // jitter. 3500 tolerates +-500ms either way.
  const main = { sessionId: 'M', isMain: true, isPinned: false, label: 'claude', state: 'coding', detail: 'edit a.js', editor: 'claude', toolCalls: 12, filesEdited: 3, lastUpdate: now - 3500 };

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

// -- renderer.js: following the session file ---------------------------------

const rendererMod = require('../renderer');
const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

describe('renderer -- readState follows a session file', () => {
  test('readState(path) reads the given file and folds turnEnded into stopped', () => {
    const t = makeTempEnv();
    try {
      const fp = path.join(t.tmp, 's.json');
      writeJsonAtomic(fp, { session_id: 'x', sessionId: 'x', state: 'idle', detail: 'between turns', timestamp: 5, turnEnded: true, lastPromptAt: 4 });
      const s = rendererMod.readState(fp);
      assert.strictEqual(s.state, 'idle');
      assert.strictEqual(s.stopped, true, 'turnEnded reads as stopped for the main face');
      assert.strictEqual(s.lastPromptAt, 4);
      assert.strictEqual(s.sessionId, 'x');
    } finally { cleanup(t.tmp); }
  });

  test('readState() with no argument still reads the global file (tmux mode)', () => {
    // Behavioural, not a grep: tmux mode calls readState() bare and must keep
    // getting ~/.code-crumb-state. The runner has already pointed STATE_FILE
    // into its throwaway home, so writing it here is safe.
    const t = makeTempEnv();
    try {
      writeJsonAtomic(STATE_FILE, { state: 'coding', detail: 'x', timestamp: 7, sessionId: 'g' });
      assert.strictEqual(rendererMod.readState().state, 'coding');
      assert.strictEqual(rendererMod.readState().sessionId, 'g');

      const other = path.join(t.tmp, 'other.json');
      writeJsonAtomic(other, { session_id: 'o', state: 'searching', detail: 'y', timestamp: 8 });
      assert.strictEqual(rendererMod.readState(other).state, 'searching',
        'an explicit path wins over the global file');
      assert.strictEqual(rendererMod.readState().state, 'coding',
        'and does not disturb the bare call');
    } finally {
      try { fs.unlinkSync(STATE_FILE); } catch {}
      cleanup(t.tmp);
    }
  });
});

describe('renderer -- source invariants of the session-file main', () => {
  test('checkState stats the main session file, not the global state file', () => {
    assert.ok(rendererSrc.includes('const fp = mainSessionFile();'));
    assert.ok(!rendererSrc.includes('fs.statSync(STATE_FILE)'), 'the unified renderer no longer reads the global file');
  });

  test('the swap guard is hoisted to the top of checkState, before anything touches the face', () => {
    // It used to sit inside the mtime branch, so on a tick where the old
    // main's file was unchanged and this was not a forced read, the rescue
    // block, the fresh-read block and idleCascade all still ran against the
    // session that was leaving -- and the rescue's minDisplayUntil buffered
    // the promoted face's own state for up to 3s after it materialized.
    const start = rendererSrc.indexOf('function checkState()');
    assert.ok(start > 0);
    // The head ends at the main try block -- matched on `try {` + newline so
    // the one-line `try { applyMainPolicy(); } catch {}` does not end it.
    const head = rendererSrc.slice(start, rendererSrc.indexOf('    try {\n', start));
    assert.ok(head.includes('try { applyMainPolicy(); } catch {}'),
      'the policy runs first, and its own throw does not kill the render loop');
    assert.ok(head.includes('if (swapTransition.active) return;'),
      'and the transition guard immediately after it, before the try block');
    // Exactly one guard site inside checkState: the old inner one is gone.
    // (applyMainPolicy has its own, which is a different question.)
    const body = rendererSrc.slice(start, rendererSrc.indexOf('\n  }\n', start));
    const guards = body.match(/if \(swapTransition\.active\) return;/g) || [];
    assert.strictEqual(guards.length, 1, 'checkState guards the transition once, at the top');
  });

  test('a materialized face shows its own session at once (forceState, not setState)', () => {
    const start = rendererSrc.indexOf('function _executeSwap()');
    const body = rendererSrc.slice(start, rendererSrc.indexOf('\n  }\n', start));
    assert.ok(body.includes("face.forceState(newData.state || 'idle', newData.detail || '')"),
      'a leftover minDisplayUntil from the old session must not buffer the new one');
    assert.ok(!body.includes('face.setState('), 'setState would queue behind the old min display');
    assert.ok(body.includes('face.setStats(newData);'));
  });

  test('a fresh turnEnded write is shown as responding before the reward cascade', () => {
    assert.ok(rendererSrc.includes("stateData.state === 'idle' && stateData.stopped && isNewerWrite(ts, lastAppliedTimestamp, now)"));
  });

  test('promotion resolves by session id and pins; the policy does the swap', () => {
    assert.ok(rendererSrc.includes('pinnedSessionId = face.sessionListPromote'));
    assert.ok(!rendererSrc.includes('face.sessionListPromote - 1'));
  });

  test('every path that changes the main session goes through adoptMain', () => {
    assert.ok(rendererSrc.includes('function adoptMain(newId)'));
    assert.ok(rendererSrc.includes('mainSessionId = newId;'));
    // The old direct assignments are gone.
    assert.ok(!rendererSrc.includes('mainSessionId = stateData.sessionId'));
    assert.ok(!rendererSrc.includes('mainSessionId = incomingId'));
    // Only the declaration and adoptMain assign it.
    const assigns = (rendererSrc.match(/(?<![.\w])mainSessionId = /g) || []).length;
    assert.strictEqual(assigns, 2, 'let-declaration plus adoptMain');
  });

  test('_executeSwap no longer writes a synthetic old-main file nor unlinks the promoted one', () => {
    const start = rendererSrc.indexOf('function _executeSwap()');
    const body = rendererSrc.slice(start, rendererSrc.indexOf('\n  }\n', start));
    assert.ok(!body.includes('writeFileSync'));
    assert.ok(!body.includes('unlinkSync'));
  });

  test('the old 120s lastMainUpdate adoption guard is gone', () => {
    assert.ok(!rendererSrc.includes('lastMainUpdate'));
  });

  // The main row is synthesized rather than read from a MiniFace, so every
  // display field has to be copied explicitly -- `model` was missed once,
  // leaving the main row the only one in the list with no model segment.
  test('the synthesized main row carries model', () => {
    const block = rendererSrc.slice(rendererSrc.indexOf('const mainInfo = mainSessionId'));
    const obj = block.slice(0, block.indexOf('} : null'));
    assert.ok(/model:\s*face\.model/.test(obj), 'mainInfo should copy face.model');
  });
});

// -- Main-session model identity -----------------------------------------
//
// SessionStart is the one payload Claude Code stamps with a model, and
// PostModelSwitch is the only documented way to follow a /model change.
// Both are free: no file is read. The Stop tail-read exists only to cover a
// SessionStart that omitted the field.

describe('update-state -- main session model', () => {
  // A main transcript whose newest assistant line names `modelId`.
  function writeMainTranscript(tmp, sid, modelId) {
    const dir = path.join(tmp, 'projects', 'proj');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'user', message: { role: 'user' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: modelId } }),
    ].join('\n') + '\n');
    return f;
  }

  test('SessionStart stamps the model straight from the payload', () => {
    const t = makeTempEnv('mdl-1');
    try {
      runUpdateState('SessionStart', {
        session_id: 'mdl-1', source: 'startup', model: 'claude-sonnet-5',
      }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'mdl-1')).model, 'Sonnet');
    } finally { cleanup(t.tmp); }
  });

  test('the model survives later tool events (sticky)', () => {
    const t = makeTempEnv('mdl-2');
    try {
      runUpdateState('SessionStart', {
        session_id: 'mdl-2', source: 'startup', model: 'claude-opus-5',
      }, t.env);
      runUpdateState('PreToolUse', {
        session_id: 'mdl-2', tool_name: 'Edit', tool_input: { file_path: 'a.js' },
      }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'mdl-2')).model, 'Opus');
    } finally { cleanup(t.tmp); }
  });

  test('PostModelSwitch follows a /model change via to_model', () => {
    const t = makeTempEnv('mdl-3');
    try {
      runUpdateState('SessionStart', {
        session_id: 'mdl-3', source: 'startup', model: 'claude-opus-5',
      }, t.env);
      runUpdateState('PostModelSwitch', {
        session_id: 'mdl-3', from_model: 'claude-opus-5',
        to_model: 'claude-haiku-4-5-20251001', requested_model: 'haiku', source: 'command',
      }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'mdl-3'));
      assert.strictEqual(s.model, 'Haiku', 'a switch overrides the sticky value');
      assert.strictEqual(s.detail, 'now Haiku', 'and the face says so');
    } finally { cleanup(t.tmp); }
  });

  test('a SessionStart with no model leaves the field absent', () => {
    const t = makeTempEnv('mdl-4');
    try {
      runUpdateState('SessionStart', { session_id: 'mdl-4', source: 'startup' }, t.env);
      assert.ok(!readJSON(sessionFile(t.sessionsDir, 'mdl-4')).model);
    } finally { cleanup(t.tmp); }
  });

  test('Stop reads the transcript tail when SessionStart gave no model', () => {
    const t = makeTempEnv('mdl-5');
    try {
      const tp = writeMainTranscript(t.tmp, 'mdl-5', 'claude-fable-5-1');
      runUpdateState('SessionStart', { session_id: 'mdl-5', source: 'startup' }, t.env);
      runUpdateState('Stop', { session_id: 'mdl-5', transcript_path: tp }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'mdl-5')).model, 'Fable');
    } finally { cleanup(t.tmp); }
  });

  // Not gated on "already known": an install predating the PostModelSwitch
  // hook never sees a switch event, so a gate would pin the first model it
  // ever saw and keep showing it confidently after a /model.
  test('Stop re-reads the tail so a stale model self-heals', () => {
    const t = makeTempEnv('mdl-6');
    try {
      const tp = writeMainTranscript(t.tmp, 'mdl-6', 'claude-haiku-4-5-20251001');
      runUpdateState('SessionStart', {
        session_id: 'mdl-6', source: 'startup', model: 'claude-opus-5',
      }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'mdl-6')).model, 'Opus');
      runUpdateState('Stop', { session_id: 'mdl-6', transcript_path: tp }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'mdl-6')).model, 'Haiku',
        'the turn that just ended is the truth, even without PostModelSwitch');
    } finally { cleanup(t.tmp); }
  });

  test("a parallel window's SessionStart parks the owner's agents instead of wiping them", () => {
    const t = makeTempEnv('owner-lc');
    try {
      runUpdateState('SessionStart', { session_id: 'owner-lc', source: 'startup' }, t.env);
      runUpdateState('SubagentStart', {
        session_id: 'owner-lc', subagent_id: 'sub-1', agent_type: 'Explore',
      }, t.env);
      assert.strictEqual(readJSON(t.statsFile).session.activeSubagents.length, 1, 'owner is conducting');

      // A lifecycle event skips the foreign-session classifier and takes the
      // stats session -- that is allowed; losing the owner's agents is not.
      runUpdateState('SessionStart', { session_id: 'other-lc', source: 'startup' }, t.env);
      let stats = readJSON(t.statsFile);
      assert.strictEqual(stats.session.id, 'other-lc');
      assert.strictEqual(stats.sessionCounters['owner-lc'].activeSubagents.length, 1,
        "the owner's agent waits on its own counter entry");

      // The owner's next event takes ownership back, agents and all.
      runUpdateState('PreToolUse', { session_id: 'owner-lc', tool_name: 'Read', tool_input: { file_path: 'a.js' } }, t.env);
      stats = readJSON(t.statsFile);
      assert.strictEqual(stats.session.id, 'owner-lc');
      assert.strictEqual(stats.session.activeSubagents.length, 1, 'restored');
      assert.ok(!stats.sessionCounters['owner-lc'].activeSubagents, 'and no longer parked');

      // ...so its SubagentStop still has something to match.
      runUpdateState('SubagentStop', { session_id: 'owner-lc', subagent_id: 'sub-1', agent_type: 'Explore' }, t.env);
      assert.strictEqual(readJSON(t.statsFile).session.activeSubagents.length, 0, 'retired by match');
    } finally { cleanup(t.tmp); }
  });

  test('a /model in a parallel window leaves a conducting owner intact', () => {
    const t = makeTempEnv('owner-pm');
    try {
      // The other window exists first, so it lands in the topLevelSessions
      // registry (a SessionStart legitimately takes the stats session; that is
      // not the behaviour under test here).
      runUpdateState('SessionStart', { session_id: 'other-pm', source: 'startup' }, t.env);
      // Owner starts, spawns an agent, and is conducting.
      runUpdateState('SessionStart', { session_id: 'owner-pm', source: 'startup' }, t.env);
      runUpdateState('SubagentStart', {
        session_id: 'owner-pm', subagent_id: 'sub-1', agent_type: 'Explore',
      }, t.env);
      const before = readJSON(t.statsFile).session.activeSubagents.length;
      assert.ok(before > 0, 'owner is conducting');

      // Now the other window runs /model. This is the event under test.
      runUpdateState('PostModelSwitch', {
        session_id: 'other-pm', to_model: 'claude-haiku-4-5-20251001', source: 'command',
      }, t.env);

      const stats = readJSON(t.statsFile);
      assert.strictEqual(stats.session.id, 'owner-pm',
        'the parallel window must not steal the stats session');
      assert.strictEqual(stats.session.activeSubagents.length, before,
        'and must not wipe the owner-s activeSubagents');
    } finally { cleanup(t.tmp); }
  });

  test('Stop with no transcript at all is harmless', () => {
    const t = makeTempEnv('mdl-7');
    try {
      runUpdateState('SessionStart', { session_id: 'mdl-7', source: 'startup' }, t.env);
      runUpdateState('Stop', { session_id: 'mdl-7', transcript_path: '/nope/missing.jsonl' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'mdl-7'));
      assert.ok(!s.model, 'no model');
      assert.strictEqual(s.turnEnded, true, 'and the turn still ended normally');
    } finally { cleanup(t.tmp); }
  });

  test('the global state file carries the model for tmux readers', () => {
    const t = makeTempEnv('mdl-8');
    try {
      runUpdateState('SessionStart', {
        session_id: 'mdl-8', source: 'startup', model: 'claude-opus-5',
      }, t.env);
      runUpdateState('PreToolUse', {
        session_id: 'mdl-8', tool_name: 'Read', tool_input: {},
      }, t.env);
      assert.strictEqual(readJSON(t.stateFile).model, 'Opus',
        'the owner guard carries it across writes that do not re-acquire it');
    } finally { cleanup(t.tmp); }
  });

  test('empty stdin on PostModelSwitch still writes a sane face', () => {
    const t = makeTempEnv('mdl-9');
    try {
      runUpdateState('PostModelSwitch', '', t.env);
      const s = readJSON(t.stateFile);
      assert.strictEqual(s.state, 'thinking');
      assert.strictEqual(s.detail, 'model switched');
    } finally { cleanup(t.tmp); }
  });
});

// -- Review fixes (Sep 2026) ----------------------------------------------

describe('review fixes -- hooks', () => {
  // Claude Code writes `"model":"<synthetic>"` on entries no model produced
  // (usage-limit notices, "No response requested."), often as the newest line.
  test('the transcript reader skips <synthetic> and finds the real model', () => {
    const t = makeTempEnv('fix-syn');
    try {
      const dir = path.join(t.tmp, 'projects', 'proj');
      fs.mkdirSync(dir, { recursive: true });
      const tp = path.join(dir, 'fix-syn.jsonl');
      fs.writeFileSync(tp, [
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5' } }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: '<synthetic>' } }),
      ].join('\n') + '\n');
      runUpdateState('SessionStart', { session_id: 'fix-syn', source: 'startup' }, t.env);
      runUpdateState('Stop', { session_id: 'fix-syn', transcript_path: tp }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'fix-syn')).model, 'Opus');
    } finally { cleanup(t.tmp); }
  });

  // TaskUpdate fires TaskCompleted in solo sessions too (no team check in
  // Claude Code), so it must not tag the session a teammate.
  test('a solo TaskCompleted keeps the session a top-level candidate', () => {
    const t = makeTempEnv('fix-task');
    try {
      runUpdateState('SessionStart', { session_id: 'fix-task', source: 'startup', model: 'claude-opus-5' }, t.env);
      const before = readJSON(sessionFile(t.sessionsDir, 'fix-task'));
      runUpdateState('TaskCompleted', { session_id: 'fix-task', task_subject: 'write tests' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'fix-task'));
      assert.ok(!s.isTeammate, 'a solo session is not a teammate');
      assert.strictEqual(s.lastPromptAt, before.lastPromptAt, 'attention survives');
      assert.strictEqual(s.model, 'Opus', 'the model survives');
      assert.strictEqual(s.detail, 'write tests');
    } finally { cleanup(t.tmp); }
  });

  test('a teammate TaskCompleted still writes the team fields', () => {
    const t = makeTempEnv('fix-team');
    try {
      runUpdateState('TaskCompleted', {
        session_id: 'fix-team', task_subject: 'x', team_name: 'blue', teammate_name: 'ana',
      }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'fix-team'));
      assert.strictEqual(s.isTeammate, true);
      assert.strictEqual(s.teamName, 'blue');
    } finally { cleanup(t.tmp); }
  });

  test('SubagentStop carries the agent model onto the retired file', () => {
    const t = makeTempEnv('fix-ss');
    try {
      runUpdateState('SessionStart', { session_id: 'fix-ss', source: 'startup' }, t.env);
      runUpdateState('SubagentStart', { session_id: 'fix-ss', agent_id: 'a1', agent_type: 'Explore' }, t.env);
      const f = sessionFile(t.sessionsDir, 'fix-ss-agent-a1');
      const cur = readJSON(f);
      fs.writeFileSync(f, JSON.stringify({ ...cur, model: 'Haiku' }));
      runUpdateState('SubagentStop', { session_id: 'fix-ss', agent_id: 'a1', agent_type: 'Explore' }, t.env);
      const s = readJSON(f);
      assert.strictEqual(s.stopped, true);
      assert.strictEqual(s.model, 'Haiku');
    } finally { cleanup(t.tmp); }
  });

  // A parallel window's lifecycle event resets stats.session and empties
  // activeSubagents; the agent's file name is deterministic, so retire it anyway.
  test('SubagentStop retires an agent file that activeSubagents lost track of', () => {
    const t = makeTempEnv('fix-orph');
    try {
      fs.mkdirSync(t.sessionsDir, { recursive: true });
      const f = sessionFile(t.sessionsDir, 'fix-orph-agent-a9');
      const old = Date.now() - 5000;
      fs.writeFileSync(f, JSON.stringify({
        session_id: 'fix-orph-agent-a9', state: 'error', detail: 'boom', timestamp: old,
        stopped: false, parentSession: 'fix-orph', agentType: 'Plan', model: 'Opus',
      }));
      runUpdateState('SubagentStop', { session_id: 'fix-orph', agent_id: 'a9', agent_type: 'Plan' }, t.env);
      const s = readJSON(f);
      assert.strictEqual(s.stopped, true);
      assert.strictEqual(s.state, 'happy');
      assert.ok(s.timestamp > old, 'a fresh timestamp, or the renderer ignores it');
      assert.strictEqual(s.parentSession, 'fix-orph');
      assert.strictEqual(s.model, 'Opus');
    } finally { cleanup(t.tmp); }
  });
});

describe('review fixes -- adapters', () => {
  test('an adapter session_end still marks the session file stopped', () => {
    const t = makeTempEnv();
    try {
      runAdapter(OPENCODE_ADAPTER, { type: 'session.created', sessionId: 'ses_end' }, t.env);
      runAdapter(OPENCODE_ADAPTER, { type: 'session_end', sessionId: 'ses_end' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'ses_end'));
      assert.strictEqual(s.stopped, true);
      assert.ok(!s.turnEnded);
    } finally { cleanup(t.tmp); }
  });

  test('an adapter turn end keeps stopped on the global file for tmux', () => {
    const t = makeTempEnv();
    try {
      runAdapter(OPENCODE_ADAPTER, { type: 'session.created', sessionId: 'ses_tmux' }, t.env);
      runAdapter(OPENCODE_ADAPTER, { type: 'session.idle', sessionId: 'ses_tmux' }, t.env);
      assert.strictEqual(readJSON(t.stateFile).stopped, true);
    } finally { cleanup(t.tmp); }
  });

  test('an adapter carries the model forward from its own session file', () => {
    const t = makeTempEnv();
    try {
      runAdapter(OPENCODE_ADAPTER, { type: 'session.created', sessionId: 'ses_mdl' }, t.env);
      const f = sessionFile(t.sessionsDir, 'ses_mdl');
      fs.writeFileSync(f, JSON.stringify({ ...readJSON(f), model: 'gpt-5' }));
      // Another session owns the global file, so guardedWriteState cannot help.
      fs.writeFileSync(t.stateFile, JSON.stringify({
        sessionId: 'someone-else', state: 'coding', timestamp: Date.now(), stopped: false,
      }));
      runAdapter(OPENCODE_ADAPTER, { type: 'tool.execute.before', sessionId: 'ses_mdl', tool: 'read', toolInput: { filePath: 'a.js' } }, t.env);
      assert.strictEqual(readJSON(f).model, 'gpt-5');
    } finally { cleanup(t.tmp); }
  });
});

describe('review fixes -- renderer and face', () => {
  test('a swap resets the git context and seeds the write clock', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const adopt = src.slice(src.indexOf('function adoptMain('), src.indexOf('function adoptMain(') + 1500);
    assert.ok(/face\.cwd = null;/.test(adopt) && /face\.gitBranch = null;/.test(adopt),
      'adoptMain must clear the outgoing branch/cwd');
    const swap = src.slice(src.indexOf('function _executeSwap('), src.indexOf('function _executeSwap(') + 1500);
    assert.ok(/lastNewWriteAt = ts;/.test(swap), 'the waiting bound needs a real write clock after a swap');
  });

  test('the status line never runs past the right edge', () => {
    const { ClaudeFace } = require('../face');
    const origCols = process.stdout.columns, origRows = process.stdout.rows;
    try {
      for (const cols of [38, 40, 50, 60]) {
        process.stdout.columns = cols; process.stdout.rows = 40;
        const face = new ClaudeFace();
        face.model = 'gpt-5.1-codex-max-preview-long';
        face.setState('subagent', 'x');
        face.state = 'subagent';
        face.subagentCount = 3;
        const out = face.render();
        // Find the segment drawn at the status row and measure its end column.
        const re = /\x1b\[(\d+);(\d+)H([^\x1b]*(?:\x1b\[[0-9;]*m[^\x1b]*)*)/g;
        let m, found = false;
        while ((m = re.exec(out))) {
          const text = m[3].replace(/\x1b\[[0-9;]*m/g, '');
          if (text.includes(' is ')) {
            found = true;
            const end = Number(m[2]) + text.length - 1;
            assert.ok(end <= cols, `status ends at ${end} in a ${cols}-col terminal`);
          }
        }
        assert.ok(found, 'status line drawn');
      }
    } finally {
      process.stdout.columns = origCols; process.stdout.rows = origRows;
    }
  });
});

// -- Review round 2 (Sep 2026) ----------------------------------------------

describe('review round 2 -- session counters', () => {
  test('a compaction keeps the session: counters, clock and running agents survive', () => {
    const t = makeTempEnv('r2-cmp');
    try {
      runUpdateState('SessionStart', { session_id: 'r2-cmp', source: 'startup' }, t.env);
      runUpdateState('PreToolUse', { session_id: 'r2-cmp', tool_name: 'Edit', tool_input: { file_path: 'a.js' } }, t.env);
      runUpdateState('PreToolUse', { session_id: 'r2-cmp', tool_name: 'Read', tool_input: { file_path: 'b.js' } }, t.env);
      runUpdateState('SubagentStart', { session_id: 'r2-cmp', agent_id: 'a1', agent_type: 'Explore' }, t.env);
      const before = readJSON(t.statsFile).session;
      runUpdateState('SessionStart', { session_id: 'r2-cmp', source: 'compact' }, t.env);
      const after = readJSON(t.statsFile).session;
      assert.strictEqual(after.toolCalls, 2);
      assert.deepStrictEqual(after.filesEdited, ['a.js']);
      assert.strictEqual(after.start, before.start, 'same session clock');
      assert.strictEqual(after.activeSubagents.length, 1, 'the running agent is still tracked');
      const s = readJSON(sessionFile(t.sessionsDir, 'r2-cmp'));
      assert.strictEqual(s.toolCalls, 2);
      assert.strictEqual(s.sessionStart, before.start);
      // ...so its SubagentStop still finds it.
      runUpdateState('SubagentStop', { session_id: 'r2-cmp', agent_id: 'a1', agent_type: 'Explore' }, t.env);
      assert.strictEqual(readJSON(t.statsFile).session.activeSubagents.length, 0);
    } finally { cleanup(t.tmp); }
  });

  test('a non-compact SessionStart still starts the counters afresh', () => {
    const t = makeTempEnv('r2-new');
    try {
      runUpdateState('SessionStart', { session_id: 'r2-new', source: 'startup' }, t.env);
      runUpdateState('PreToolUse', { session_id: 'r2-new', tool_name: 'Read', tool_input: { file_path: 'b.js' } }, t.env);
      runUpdateState('SessionStart', { session_id: 'r2-new', source: 'clear' }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'r2-new')).toolCalls, 0);
    } finally { cleanup(t.tmp); }
  });

  test('two windows alternating hooks each report their own counters', () => {
    const t = makeTempEnv('r2-A');
    try {
      runUpdateState('SessionStart', { session_id: 'r2-A', source: 'startup' }, t.env);
      runUpdateState('SessionStart', { session_id: 'r2-B', source: 'startup' }, t.env);
      const startA = readJSON(sessionFile(t.sessionsDir, 'r2-A')).sessionStart;
      for (let i = 0; i < 3; i++) {
        runUpdateState('PreToolUse', { session_id: 'r2-A', tool_name: 'Edit', tool_input: { file_path: 'a.js' } }, t.env);
        runUpdateState('PreToolUse', { session_id: 'r2-B', tool_name: 'Bash', tool_input: { command: 'ls' } }, t.env);
      }
      const a = readJSON(sessionFile(t.sessionsDir, 'r2-A'));
      const b = readJSON(sessionFile(t.sessionsDir, 'r2-B'));
      assert.strictEqual(a.toolCalls, 3, `A counts its own calls, got ${a.toolCalls}`);
      assert.strictEqual(a.filesEdited, 1);
      assert.strictEqual(a.sessionStart, startA, 'a switch is not a new session');
      assert.strictEqual(b.toolCalls, 3);
      assert.strictEqual(b.filesEdited, 0);
      assert.strictEqual(readJSON(t.statsFile).daily.sessionCount, 2,
        'two sessions, however often they alternate');
    } finally { cleanup(t.tmp); }
  });

  test("a parallel window beside a conducting owner reports its own counts, not the owner's", () => {
    const t = makeTempEnv('r2-own');
    try {
      runUpdateState('SessionStart', { session_id: 'r2-own', source: 'startup' }, t.env);
      runUpdateState('SessionStart', { session_id: 'r2-par', source: 'startup' }, t.env);
      runUpdateState('SessionStart', { session_id: 'r2-own', source: 'resume' }, t.env);
      for (let i = 0; i < 4; i++) {
        runUpdateState('PreToolUse', { session_id: 'r2-own', tool_name: 'Read', tool_input: { file_path: 'o.js' } }, t.env);
      }
      runUpdateState('SubagentStart', { session_id: 'r2-own', agent_id: 'a1', agent_type: 'Explore' }, t.env);
      runUpdateState('PreToolUse', { session_id: 'r2-par', tool_name: 'Read', tool_input: { file_path: 'p.js' } }, t.env);
      const p = readJSON(sessionFile(t.sessionsDir, 'r2-par'));
      assert.strictEqual(p.toolCalls, 1, `got ${p.toolCalls}`);
      assert.strictEqual(readJSON(t.statsFile).session.toolCalls, 4, "the owner's count is untouched");
    } finally { cleanup(t.tmp); }
  });
});

describe('review round 2 -- StopFailure ends the turn', () => {
  test('the session file carries turnEnded (not stopped) and the global file stopped', () => {
    const t = makeTempEnv('r2-sf');
    try {
      runUpdateState('SessionStart', { session_id: 'r2-sf', source: 'startup' }, t.env);
      runUpdateState('PreToolUse', { session_id: 'r2-sf', tool_name: 'Read', tool_input: { file_path: 'a.js' } }, t.env);
      runUpdateState('StopFailure', { session_id: 'r2-sf', error: 'rate_limit' }, t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'r2-sf'));
      assert.strictEqual(s.state, 'error');
      assert.strictEqual(s.detail, 'rate limited!');
      assert.strictEqual(s.turnEnded, true);
      assert.ok(!s.stopped, 'a failed turn is not a finished session');
      assert.strictEqual(readJSON(t.stateFile).stopped, true);
      assert.strictEqual(readJSON(t.statsFile).streak, 0);
    } finally { cleanup(t.tmp); }
  });

  test('empty-stdin StopFailure takes the same contract', () => {
    const t = makeTempEnv('r2-sf2');
    try {
      runUpdateState('StopFailure', '', t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'r2-sf2'));
      assert.strictEqual(s.state, 'error');
      assert.strictEqual(s.turnEnded, true);
      assert.ok(!s.stopped);
    } finally { cleanup(t.tmp); }
  });
});

describe('review round 2 -- degraded payloads keep their session', () => {
  const huge = 'x'.repeat(1100000);

  test('a >1 MB payload writes its own session file and leaves a foreign owner alone', () => {
    const t = makeTempEnv('r2-env');
    try {
      const { writeJsonAtomic } = require('../shared');
      const owner = { state: 'coding', detail: 'x', timestamp: Date.now(), sessionId: 'r2-owner' };
      writeJsonAtomic(t.stateFile, owner);
      runUpdateState('UserPromptSubmit', { session_id: 'r2-big', prompt: 'hi' }, t.env);
      const stamp = readJSON(sessionFile(t.sessionsDir, 'r2-big')).lastPromptAt;
      writeJsonAtomic(t.stateFile, { ...owner, timestamp: Date.now() });
      runUpdateState('PostToolUse', JSON.stringify({
        session_id: 'r2-big', hook_event_name: 'PostToolUse', tool_name: 'Bash',
        tool_input: { command: 'cat big' }, tool_response: { stdout: huge },
      }), t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'r2-big'));
      assert.strictEqual(s.sessionId, 'r2-big');
      assert.ok(s.timestamp >= stamp);
      assert.strictEqual(s.lastPromptAt, stamp, 'sticky attention survives the degraded write');
      assert.strictEqual(readJSON(t.stateFile).sessionId, 'r2-owner', 'the global owner is not clobbered');
    } finally { cleanup(t.tmp); }
  });

  test('a >1 MB agent payload lands on the agent orbital, never the global file', () => {
    const t = makeTempEnv('r2-bigA');
    try {
      runUpdateState('SessionStart', { session_id: 'r2-bigA', source: 'startup' }, t.env);
      const globalBefore = fs.readFileSync(t.stateFile, 'utf8');
      runUpdateState('PostToolUse', JSON.stringify({
        session_id: 'r2-bigA', agent_id: 'ag7', agent_type: 'Explore', hook_event_name: 'PostToolUse',
        tool_name: 'Read', tool_input: { file_path: 'x' }, tool_response: { stdout: huge },
      }), t.env);
      const s = readJSON(sessionFile(t.sessionsDir, 'r2-bigA-agent-ag7'));
      assert.strictEqual(s.parentSession, 'r2-bigA');
      assert.strictEqual(s.agentType, 'Explore');
      assert.strictEqual(fs.readFileSync(t.stateFile, 'utf8'), globalBefore);
    } finally { cleanup(t.tmp); }
  });

  test('non-string payload fields never throw into a phantom <editor>-<ppid> session', () => {
    const t = makeTempEnv('unused');
    try {
      const env = { ...t.env };
      delete env.CLAUDE_SESSION_ID;
      runUpdateState('Elicitation', { session_id: 'r2-mal', mcp_server_name: 42 }, env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'r2-mal')).detail, '42: needs input');
      runUpdateState('TaskCompleted', { session_id: 'r2-mal', task_subject: 7 }, env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'r2-mal')).detail, '7');
      runUpdateState('InstructionsLoaded', { session_id: 'r2-mal', file_path: ['a', 'b'] }, env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'r2-mal')).detail, 'loading instructions');
      runUpdateState('ConfigChange', { session_id: 'r2-mal', file_path: { p: 1 } }, env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'r2-mal')).detail, 'config updated');
      const files = fs.readdirSync(t.sessionsDir).filter(f => f.endsWith('.json'));
      assert.deepStrictEqual(files, ['r2-mal.json'], `no phantom orbital, got ${files.join(', ')}`);
    } finally { cleanup(t.tmp); }
  });
});

// -- Third review pass (Sep 2026) --------------------------------------------
// Each block below was reproduced against the pre-fix sources first.

describe('renderer -- third review pass', () => {
  const { needsRescue } = rendererMod;

  test('conducting after the parent\'s Stop is not rescued while agents run', () => {
    const face = { state: 'subagent' };
    assert.strictEqual(needsRescue(face, true, false, 2), false,
      'rescuing it looped responding -> done! -> conducting every ~12s');
    assert.strictEqual(needsRescue(face, true, false, 0), true, 'no live agents: rescue as before');
    assert.strictEqual(needsRescue(face, false, true, 2), true, 'a dead editor is still rescued');
    assert.strictEqual(needsRescue({ state: 'coding' }, true, false, 2), true, 'only the conducting face is exempt');
  });

  test('readState hands the face text only, on one line', () => {
    const t = makeTempEnv();
    try {
      const fp = path.join(t.tmp, 'obj.json');
      writeJsonAtomic(fp, { state: 'error', detail: { code: 500 }, workDetail: 'a\nb', timestamp: 5 });
      const s = rendererMod.readState(fp);
      assert.strictEqual(s.detail, '');
      assert.strictEqual(s.workDetail, 'a b');
    } finally { cleanup(t.tmp); }
  });

  test('source: a turn end never cuts a reward or an error short', () => {
    const i = rendererSrc.indexOf('if (stateData.stopped && Date.now() < face.minDisplayUntil');
    assert.ok(i > 0);
    const cond = rendererSrc.slice(i, rendererSrc.indexOf('{', i));
    assert.ok(cond.includes('!COMPLETION_STATES.has(face.state)'));
    assert.ok(cond.includes("face.state !== 'error'"));
  });

  test('source: the rescue passes the live child count', () => {
    assert.ok(rendererSrc.includes('needsRescue(face, lastStopped, editorDead, minimal ? 0 : orbital.liveChildCount())'));
  });

  test('source: a recorded startup write still hands over its counters', () => {
    const i = rendererSrc.indexOf("if (gate === 'record') {");
    const body = rendererSrc.slice(i, rendererSrc.indexOf('return;', i));
    assert.ok(body.includes('face.setStats(stateData)'),
      'the main row read "0 tools · 0 files" after a boot');
  });

  test('source: the main row\'s dot reads the real SessionEnd flag, not a turn end', () => {
    assert.ok(rendererSrc.includes('stopped: lastSessionEnded || !!(mainFace && mainFace.stopped),'));
    assert.ok(rendererSrc.includes('sessionEnded: !!data.stopped,'), 'from the file\'s own SessionEnd flag, never the folded turn end');
    assert.ok(!rendererSrc.includes('stopped: lastStopped,'));
  });
});

// -- Round 3: cross-writer contract --------------------------------------------
// Each reproduced against the pre-fix sources with real update-state.js runs.

describe('round 3 -- cross-writer contract', () => {
  // Codex puts a required `model` on every hook payload and has no
  // PostModelSwitch; its rollout has no message.model for the Stop tail-read.
  test('a codex session follows its model from any payload', () => {
    const t = makeTempEnv('cx-mdl');
    const env = { ...t.env, CODE_CRUMB_EDITOR: 'codex' };
    try {
      runUpdateState('SessionStart', { session_id: 'cx-mdl', source: 'startup', model: 'gpt-5.1-codex' }, env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'cx-mdl')).model, 'gpt-5.1-codex');
      runUpdateState('UserPromptSubmit', { session_id: 'cx-mdl', prompt: 'x', model: 'gpt-5.1-codex-mini' }, env);
      runUpdateState('PreToolUse', {
        session_id: 'cx-mdl', tool_name: 'Bash', tool_input: { command: 'ls' }, model: 'gpt-5.1-codex-mini',
      }, env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'cx-mdl')).model, 'gpt-5.1-codex-mini',
        'the session file follows the switch');
      assert.strictEqual(readJSON(t.stateFile).model, 'gpt-5.1-codex-mini', 'and so does the global file');
      runUpdateState('PostToolUse', {
        session_id: 'cx-mdl', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' },
      }, env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'cx-mdl')).model, 'gpt-5.1-codex-mini',
        'a payload without one keeps the sticky value');
    } finally { cleanup(t.tmp); }
  });

  // Codex runs Interrupt, not Stop, when the user presses Esc: nothing closed
  // the turn and the face held "running command · still running" for 10 min.
  test('a codex Interrupt ends the turn without breaking the streak', () => {
    const t = makeTempEnv('cx-int');
    const env = { ...t.env, CODE_CRUMB_EDITOR: 'codex' };
    try {
      runUpdateState('SessionStart', { session_id: 'cx-int', source: 'startup' }, env);
      runUpdateState('UserPromptSubmit', { session_id: 'cx-int', prompt: 'x' }, env);
      runUpdateState('PreToolUse', { session_id: 'cx-int', tool_name: 'Bash', tool_input: { command: 'npm run dev' } }, env);
      const streakBefore = readJSON(t.statsFile).streak;
      runUpdateState('Interrupt', { session_id: 'cx-int', turn_id: 't1', model: 'gpt-5.1-codex' }, env);
      const s = readJSON(sessionFile(t.sessionsDir, 'cx-int'));
      assert.strictEqual(s.state, 'error');
      assert.strictEqual(s.detail, 'interrupted');
      assert.strictEqual(s.turnEnded, true, 'the session file says the turn is over');
      assert.ok(!s.stopped, 'but the session is not');
      assert.strictEqual(readJSON(t.stateFile).stopped, true, 'the global file is released');
      assert.strictEqual(readJSON(t.statsFile).streak, streakBefore, 'an Esc is not a failure');
      runUpdateState('Interrupt', '', env);   // the empty-stdin path agrees
      const f = readJSON(sessionFile(t.sessionsDir, 'cx-int'));
      assert.strictEqual(f.detail, 'interrupted');
      assert.strictEqual(f.turnEnded, true);
    } finally { cleanup(t.tmp); }
  });

  // Events that can land BETWEEN turns used to reopen the finished turn (45s
  // of thinking, nothing to close it), and an echo carrying `turnEnded` on a
  // work face was rescued into a second responding -> done!. A face the
  // rescue would replace now carries the end as `turnOver`.
  function endedTurn(id, env) {
    runUpdateState('SessionStart', { session_id: id, source: 'startup' }, env);
    runUpdateState('UserPromptSubmit', { session_id: id, prompt: 'x' }, env);
    runUpdateState('Stop', { session_id: id }, env);
  }
  const turnFlags = (f) => ({ turnEnded: !!f.turnEnded, turnOver: !!f.turnOver, stopped: !!f.stopped });

  test('/compact between turns keeps the turn over, and PostCompact closes it', () => {
    const t = makeTempEnv('amb-1');
    try {
      endedTurn('amb-1', t.env);
      runUpdateState('PreCompact', { session_id: 'amb-1', trigger: 'manual' }, t.env);
      let f = readJSON(sessionFile(t.sessionsDir, 'amb-1'));
      assert.strictEqual(f.state, 'thinking');
      assert.deepStrictEqual(turnFlags(f), { turnEnded: false, turnOver: true, stopped: false });
      assert.strictEqual(readJSON(t.stateFile).stopped, true, 'tmux still sees a finished turn');
      runUpdateState('SessionStart', { session_id: 'amb-1', source: 'compact' }, t.env);
      assert.deepStrictEqual(turnFlags(readJSON(sessionFile(t.sessionsDir, 'amb-1'))),
        { turnEnded: false, turnOver: true, stopped: false });
      runUpdateState('PostCompact', { session_id: 'amb-1', trigger: 'manual' }, t.env);
      f = readJSON(sessionFile(t.sessionsDir, 'amb-1'));
      assert.strictEqual(f.state, 'satisfied');
      assert.deepStrictEqual(turnFlags(f), { turnEnded: true, turnOver: false, stopped: false });
    } finally { cleanup(t.tmp); }
  });

  test('a subagent auto-compaction and a /model after Stop do not reopen the turn', () => {
    const t = makeTempEnv('amb-2');
    try {
      endedTurn('amb-2', t.env);
      // Claude Code sends an agent's PreCompact with the parent's id and no agent_id.
      runUpdateState('PreCompact', { session_id: 'amb-2', trigger: 'auto' }, t.env);
      assert.strictEqual(readJSON(sessionFile(t.sessionsDir, 'amb-2')).turnOver, true);
      runUpdateState('PostModelSwitch', { session_id: 'amb-2', to_model: 'claude-opus-5', source: 'command' }, t.env);
      const f = readJSON(sessionFile(t.sessionsDir, 'amb-2'));
      assert.strictEqual(f.detail, 'now Opus');
      assert.deepStrictEqual(turnFlags(f), { turnEnded: false, turnOver: true, stopped: false });
    } finally { cleanup(t.tmp); }
  });

  test('a mid-turn compaction is still live work', () => {
    const t = makeTempEnv('amb-3');
    try {
      runUpdateState('SessionStart', { session_id: 'amb-3', source: 'startup' }, t.env);
      runUpdateState('UserPromptSubmit', { session_id: 'amb-3', prompt: 'x' }, t.env);
      runUpdateState('PreCompact', { session_id: 'amb-3', trigger: 'auto' }, t.env);
      assert.deepStrictEqual(turnFlags(readJSON(sessionFile(t.sessionsDir, 'amb-3'))),
        { turnEnded: false, turnOver: false, stopped: false });
    } finally { cleanup(t.tmp); }
  });

  test('an echo on a work face carries turnOver; on a reward or error, turnEnded', () => {
    const t = makeTempEnv('amb-4');
    try {
      endedTurn('amb-4', t.env);
      runUpdateState('ConfigChange', { session_id: 'amb-4', source: 'user_settings', file_path: '/x/settings.json' }, t.env);
      let f = readJSON(sessionFile(t.sessionsDir, 'amb-4'));
      assert.strictEqual(f.state, 'reading');
      assert.deepStrictEqual(turnFlags(f), { turnEnded: false, turnOver: true, stopped: false },
        'a reading face with turnEnded was rescued into responding -> done!');
      runUpdateState('PostToolUse', {
        session_id: 'amb-4', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' },
      }, t.env);
      f = readJSON(sessionFile(t.sessionsDir, 'amb-4'));
      assert.strictEqual(f.state, 'relieved');
      assert.deepStrictEqual(turnFlags(f), { turnEnded: true, turnOver: false, stopped: false });
      runUpdateState('ConfigChange', '', t.env);   // the empty-stdin path agrees
      assert.deepStrictEqual(turnFlags(readJSON(sessionFile(t.sessionsDir, 'amb-4'))),
        { turnEnded: false, turnOver: true, stopped: false });
    } finally { cleanup(t.tmp); }
  });

  test('the renderer reads turnOver as not active, never as a turn end to rescue', () => {
    const { readState } = require('../renderer');
    const t = makeTempEnv('amb-5');
    try {
      const f = path.join(t.tmp, 'x.json');
      fs.writeFileSync(f, JSON.stringify({ state: 'thinking', turnOver: true, timestamp: 1 }));
      const r = readState(f);
      assert.strictEqual(r.turnOver, true);
      assert.strictEqual(r.stopped, false, 'not folded into stopped, so never rescued');
      fs.writeFileSync(f, JSON.stringify({ state: 'happy', turnEnded: true, turnOver: true, timestamp: 1 }));
      assert.strictEqual(readState(f).turnOver, false, 'a real turn end wins');
    } finally { cleanup(t.tmp); }
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.ok(/const sessionActive = !lastStopped && !lastTurnOver && !editorDead;/.test(src));
    assert.ok(/&& !stateData\.stopped\s*\n\s*&& stateData\.workSince > prevAppliedTs\s*\n\s*&& !ACTIVE_WORK_STATES\.has\(face\.state\)/.test(src),
      'a finished turn never re-injects its tool, and an applied Pre is never replayed');
  });

  // One write stamped in the future (a clock stepping back) froze the face:
  // nothing afterwards was "newer" until the wall clock caught up.
  test('a write from the future does not freeze the face', () => {
    const { isNewerWrite, noteNewWrite } = require('../renderer');
    const now = 1_000_000_000_000;
    assert.strictEqual(isNewerWrite(now + 5, now, now), true, 'newer is newer');
    assert.strictEqual(isNewerWrite(now - 5, now, now), false, 'an out-of-order older write is not');
    const future = now + 3600000;
    assert.strictEqual(isNewerWrite(future, future, now), false, 're-reading the same write is not new');
    assert.strictEqual(isNewerWrite(now + 1000, future, now), true, 'after a future write, a real one is new');
    assert.strictEqual(isNewerWrite(0, future, now), false, 'an unstamped file never is');
    assert.strictEqual(isNewerWrite(now + 30000, now + 40000, now), false, 'small skew keeps the ordering');
    assert.strictEqual(noteNewWrite(now + 1000, future, now, 7), now, 'and the write clock moves');
  });

  // The Post carries the Pre's timestamp so the renderer injects the work
  // state only when it never applied that write.
  test('a PostToolUse names its PreToolUse write by timestamp', () => {
    const t = makeTempEnv('ws-1');
    try {
      runUpdateState('UserPromptSubmit', { session_id: 'ws-1', prompt: 'x' }, t.env);
      runUpdateState('PreToolUse', { session_id: 'ws-1', tool_name: 'Bash', tool_input: { command: 'npm test' } }, t.env);
      const pre = readJSON(sessionFile(t.sessionsDir, 'ws-1'));
      runUpdateState('PostToolUse', { session_id: 'ws-1', tool_name: 'Bash', tool_input: { command: 'npm test' },
        tool_response: { stdout: '3 passed' } }, t.env);
      const post = readJSON(sessionFile(t.sessionsDir, 'ws-1'));
      assert.strictEqual(post.workState, 'testing');
      assert.strictEqual(post.workSince, pre.timestamp);
      // A Task finishing after its SubagentStop: the file holds the reward,
      // not the Pre, so there is nothing to name (and nothing to replay).
      runUpdateState('PostToolUse', { session_id: 'ws-1', tool_name: 'Bash', tool_input: { command: 'npm test' },
        tool_response: { stdout: '3 passed' } }, t.env);
      assert.ok(!readJSON(sessionFile(t.sessionsDir, 'ws-1')).workSince, 'no Pre in the file, no workSince');
    } finally { cleanup(t.tmp); }
  });

  test('the global file keeps the model when ownership comes back', () => {
    const t = makeTempEnv('gm-a');
    try {
      runUpdateState('SessionStart', { session_id: 'gm-a', source: 'startup', model: 'claude-sonnet-5' }, t.env);
      assert.strictEqual(readJSON(t.stateFile).model, 'Sonnet');
      runUpdateState('SessionStart', { session_id: 'gm-b', source: 'startup' }, t.env);   // takes the global file
      runUpdateState('SessionEnd', { session_id: 'gm-b' }, t.env);                        // and releases it
      runUpdateState('PreToolUse', { session_id: 'gm-a', tool_name: 'Read', tool_input: { file_path: 'a.js' } }, t.env);
      const g = readJSON(t.stateFile);
      assert.strictEqual(g.sessionId, 'gm-a');
      assert.strictEqual(g.model, 'Sonnet', 'tmux mode shows the model again');
    } finally { cleanup(t.tmp); }
  });

  test('setup registers the codex Interrupt and PostCompact hooks, and uninstall finds them', () => {
    const setup = require('../setup');
    const built = setup.buildCodexHooks(path.join(__dirname, '..'));
    const t = makeTempEnv('cx-setup');
    try {
      const hooksPath = path.join(t.tmp, 'hooks.json');
      const only = { hooks: { Interrupt: built.hooks.Interrupt, PostCompact: built.hooks.PostCompact } };
      assert.ok(only.hooks.Interrupt && only.hooks.PostCompact, 'both are registered');
      fs.writeFileSync(hooksPath, JSON.stringify(only));
      const r = setup.uninstallCodex({ hooksPath, log: () => {} });
      assert.strictEqual(r.removed, 2, 'an Interrupt command is recognised as ours');
    } finally { cleanup(t.tmp); }
  });
});

module.exports = suite;
