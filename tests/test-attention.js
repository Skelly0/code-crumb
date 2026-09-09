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

module.exports = suite;
