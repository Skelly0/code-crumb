'use strict';

// +================================================================+
// |  Subagent attribution tests (agent_id routing)                 |
// |                                                                |
// |  Claude Code fires a subagent's hooks with the PARENT's        |
// |  session_id plus agent_id/agent_type. Without reading those,   |
// |  every subagent's activity landed on the main face and the     |
// |  orbitals were mislabelled, mis-retired and dropped early.     |
// |  These tests pin the routing, the labels, the retirement       |
// |  matching, the ageing net and the renderer-side staleness.     |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { createSuite, makeTempEnv, cleanup, readJSON } = require('./_harness');
const suite = createSuite();
const { describe, test } = suite;

const {
  subagentSessionId, subagentLabel,
} = require('../state-machine');
const { writeJsonAtomic } = require('../shared');
const {
  MiniFace, OrbitalSystem, CHILD_ORPHAN_TIMEOUT, ORPHAN_TIMEOUT, STALE_MS,
} = require('../grid');
const {
  idleCascade, SLEEP_TIMEOUT, THINKING_TIMEOUT, WAIT_HOLD_STALE_MS,
} = require('../renderer');
const { ClaudeFace } = require('../face');

// The detail-line separator face.js uses, built without a literal glyph.
const DETAIL_SEP = ' ' + String.fromCharCode(0x00b7) + ' ';

// Horizontal ellipsis, built without a literal glyph so this file stays ASCII.
const ELLIPSIS = String.fromCharCode(0x2026);

const NODE = process.execPath;
const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');

// Run the hook as a subprocess against an isolated temp home. update-state.js
// calls process.exit(0), which execFileSync can still surface as an error on
// some platforms -- only a real non-zero status is a failure.
function runUpdateState(event, inputObj, env) {
  try {
    execFileSync(NODE, [UPDATE_STATE, event], {
      input: JSON.stringify(inputObj),
      env,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status !== 0 && e.status !== null) throw e;
  }
}

function sessionFile(sessionsDir, id) {
  return path.join(sessionsDir, `${id}.json`);
}

// -- subagentLabel / subagentSessionId --------------------------------

describe('state-machine -- subagentLabel', () => {
  test('collapses whitespace and takes the first non-empty line', () => {
    assert.strictEqual(subagentLabel({ invocation_prompt: '  Line   one \n second' }), 'Line one');
  });

  test('skips leading blank lines', () => {
    assert.strictEqual(subagentLabel({ invocation_prompt: '\n\n   \nreal work here' }), 'real work here');
  });

  test('truncates a long first line to 39 chars plus an ellipsis', () => {
    const long = 'x'.repeat(60);
    const out = subagentLabel({ invocation_prompt: long });
    assert.strictEqual(out.length, 40);
    assert.strictEqual(out.slice(0, 39), 'x'.repeat(39));
    assert.strictEqual(out.slice(39), ELLIPSIS);
  });

  test('a 40-char first line is kept whole', () => {
    const exact = 'y'.repeat(40);
    assert.strictEqual(subagentLabel({ invocation_prompt: exact }), exact);
  });

  test('falls back to agent_type when there is no prompt', () => {
    assert.strictEqual(subagentLabel({ agent_type: 'Plan' }), 'Plan');
  });

  test('falls back to "subagent" with nothing to go on', () => {
    assert.strictEqual(subagentLabel({}), 'subagent');
  });

  test('description wins over invocation_prompt', () => {
    assert.strictEqual(subagentLabel({ description: 'X', invocation_prompt: 'Y' }), 'X');
  });

  test('non-string prompt does not throw', () => {
    assert.strictEqual(subagentLabel({ invocation_prompt: { a: 1 }, agent_type: 'Explore' }), 'Explore');
  });

  test('handles a missing payload', () => {
    assert.strictEqual(subagentLabel(undefined), 'subagent');
  });
});

describe('state-machine -- subagentSessionId', () => {
  test('joins parent session and agent id', () => {
    assert.strictEqual(subagentSessionId('p', 'a1'), 'p-agent-a1');
  });

  test('is stable for the same pair', () => {
    assert.strictEqual(subagentSessionId('sess-9', 'agt-2'), subagentSessionId('sess-9', 'agt-2'));
  });
});

// -- update-state.js agent routing ------------------------------------

describe('update-state -- SubagentStart with agent_id', () => {
  test('creates a per-agent orbital keyed by parent + agent id', () => {
    const { tmp, stateFile, sessionsDir, statsFile, env } = makeTempEnv('p');

    runUpdateState('SubagentStart', {
      session_id: 'p', hook_event_name: 'SubagentStart', cwd: process.cwd(),
      agent_id: 'a1', agent_type: 'Explore',
      invocation_prompt: 'Find all callers of foo\n\nThen report.',
    }, env);

    const orbital = readJSON(sessionFile(sessionsDir, 'p-agent-a1'));
    assert.strictEqual(orbital.state, 'spawning');
    assert.strictEqual(orbital.parentSession, 'p');
    assert.strictEqual(orbital.taskDescription, 'Find all callers of foo');
    assert.strictEqual(orbital.modelName, 'Explore');
    assert.strictEqual(orbital.agentType, 'Explore');

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.activeSubagents.length, 1);
    assert.strictEqual(stats.session.activeSubagents[0].id, 'p-agent-a1');
    assert.strictEqual(stats.session.activeSubagents[0].agentId, 'a1');

    const global = readJSON(stateFile);
    assert.strictEqual(global.state, 'subagent');
    assert.strictEqual(global.detail, 'conducting 1');
    cleanup(tmp);
  });
});

describe('update-state -- agent tool events route to the agent orbital', () => {
  function startAgent(env, agentId, type) {
    runUpdateState('SubagentStart', {
      session_id: 'p', hook_event_name: 'SubagentStart', cwd: process.cwd(),
      agent_id: agentId, agent_type: type || 'Explore',
      invocation_prompt: 'Find all callers of foo',
    }, env);
  }

  test('PreToolUse writes the agent file and leaves global + parent alone', () => {
    const { tmp, stateFile, sessionsDir, statsFile, env } = makeTempEnv('p');
    startAgent(env, 'a1');

    const globalBefore = readJSON(stateFile);
    const parentBefore = readJSON(sessionFile(sessionsDir, 'p'));
    const callsBefore = readJSON(statsFile).session.toolCalls;

    runUpdateState('PreToolUse', {
      session_id: 'p', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      agent_id: 'a1', agent_type: 'Explore',
      tool_name: 'Grep', tool_input: { pattern: 'foo' },
    }, env);

    const orbital = readJSON(sessionFile(sessionsDir, 'p-agent-a1'));
    assert.strictEqual(orbital.state, 'searching');
    assert.strictEqual(orbital.taskDescription, 'Find all callers of foo',
      'sticky taskDescription must survive the tool write');
    assert.strictEqual(orbital.parentSession, 'p');

    const globalAfter = readJSON(stateFile);
    assert.strictEqual(globalAfter.timestamp, globalBefore.timestamp,
      'a subagent tool event must not touch the global state file');
    assert.strictEqual(globalAfter.state, globalBefore.state);

    const parentAfter = readJSON(sessionFile(sessionsDir, 'p'));
    assert.strictEqual(parentAfter.timestamp, parentBefore.timestamp,
      "a subagent tool event must not rewrite the parent's session file");

    assert.strictEqual(readJSON(statsFile).session.toolCalls, callsBefore + 1,
      "subagent tool calls still count toward the owner's stats");
    cleanup(tmp);
  });

  test('PostToolUse failure shows error on the agent orbital only', () => {
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('p');
    startAgent(env, 'a1');
    const globalBefore = readJSON(stateFile);

    runUpdateState('PostToolUse', {
      session_id: 'p', hook_event_name: 'PostToolUse', cwd: process.cwd(),
      agent_id: 'a1',
      tool_name: 'Bash', tool_input: { command: 'npm test' },
      tool_response: { stdout: 'FAIL', exitCode: 1 },
    }, env);

    const orbital = readJSON(sessionFile(sessionsDir, 'p-agent-a1'));
    assert.strictEqual(orbital.state, 'error');
    const globalAfter = readJSON(stateFile);
    assert.strictEqual(globalAfter.timestamp, globalBefore.timestamp);
    assert.strictEqual(globalAfter.state, globalBefore.state);
    cleanup(tmp);
  });

  test('PermissionRequest routes to the agent orbital', () => {
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('p');
    startAgent(env, 'a1');
    const globalBefore = readJSON(stateFile);

    runUpdateState('PermissionRequest', {
      session_id: 'p', hook_event_name: 'PermissionRequest', cwd: process.cwd(),
      agent_id: 'a1', tool_name: 'Bash',
    }, env);

    const orbital = readJSON(sessionFile(sessionsDir, 'p-agent-a1'));
    assert.strictEqual(orbital.state, 'waiting');
    const globalAfter = readJSON(stateFile);
    assert.strictEqual(globalAfter.timestamp, globalBefore.timestamp);
    assert.strictEqual(globalAfter.state, globalBefore.state);
    cleanup(tmp);
  });

  test('a stopped parent does not retire a still-working agent orbital', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('p');
    startAgent(env, 'a1');
    // The parent's own turn ends -- global state carries stopped: true.
    runUpdateState('Stop', {
      session_id: 'p', hook_event_name: 'Stop', cwd: process.cwd(),
    }, env);

    // A background agent keeps working afterwards.
    runUpdateState('PostToolUse', {
      session_id: 'p', hook_event_name: 'PostToolUse', cwd: process.cwd(),
      agent_id: 'a1', agent_type: 'Explore',
      tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const orbital = readJSON(sessionFile(sessionsDir, 'p-agent-a1'));
    assert.strictEqual(!!orbital.stopped, false,
      "the parent's stopped flag must not be copied onto a live agent orbital");
    cleanup(tmp);
  });

  test('the agent orbital keeps its agent_type as modelName', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('p');
    startAgent(env, 'a1', 'Plan');

    runUpdateState('PreToolUse', {
      session_id: 'p', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      agent_id: 'a1', agent_type: 'Plan',
      tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const orbital = readJSON(sessionFile(sessionsDir, 'p-agent-a1'));
    assert.strictEqual(orbital.modelName, 'Plan',
      "the parent's modelName must not overwrite the agent type");
    assert.strictEqual(orbital.agentType, 'Plan');
    cleanup(tmp);
  });

  test('Stop inside a subagent ends that agent turn, not the parent session', () => {
    const { tmp, stateFile, sessionsDir, statsFile, env } = makeTempEnv('p');
    startAgent(env, 'a1');
    const globalBefore = readJSON(stateFile);
    const startBefore = readJSON(statsFile).session.start;
    assert.ok(startBefore > 0, 'precondition: session start is set');

    runUpdateState('Stop', {
      session_id: 'p', hook_event_name: 'Stop', cwd: process.cwd(),
      agent_id: 'a1',
    }, env);

    const orbital = readJSON(sessionFile(sessionsDir, 'p-agent-a1'));
    assert.strictEqual(orbital.state, 'responding');
    assert.strictEqual(!!orbital.stopped, false,
      'an agent Stop must not retire the orbital -- SubagentStop does that');

    const globalAfter = readJSON(stateFile);
    assert.strictEqual(globalAfter.timestamp, globalBefore.timestamp);
    assert.strictEqual(globalAfter.state, globalBefore.state);

    const statsAfter = readJSON(statsFile);
    assert.strictEqual(statsAfter.session.start, startBefore,
      "an agent Stop must not close the parent's session records");
    cleanup(tmp);
  });
});

describe('update-state -- SubagentStop matches by agent_id', () => {
  test('retires the finishing agent, not the oldest one', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('p');

    runUpdateState('SubagentStart', {
      session_id: 'p', hook_event_name: 'SubagentStart', cwd: process.cwd(),
      agent_id: 'a1', agent_type: 'Explore', invocation_prompt: 'first task',
    }, env);
    runUpdateState('SubagentStart', {
      session_id: 'p', hook_event_name: 'SubagentStart', cwd: process.cwd(),
      agent_id: 'a2', agent_type: 'Plan', invocation_prompt: 'second task',
    }, env);

    const a2Before = readJSON(sessionFile(sessionsDir, 'p-agent-a2'));

    runUpdateState('SubagentStop', {
      session_id: 'p', hook_event_name: 'SubagentStop', cwd: process.cwd(),
      agent_id: 'a1', agent_type: 'Explore',
    }, env);

    const a1 = readJSON(sessionFile(sessionsDir, 'p-agent-a1'));
    assert.strictEqual(a1.stopped, true);
    assert.strictEqual(a1.state, 'happy');
    assert.strictEqual(a1.taskDescription, 'first task');
    assert.strictEqual(a1.agentType, 'Explore');

    const a2After = readJSON(sessionFile(sessionsDir, 'p-agent-a2'));
    assert.strictEqual(!!a2After.stopped, false, 'the other agent must stay live');
    assert.strictEqual(a2After.timestamp, a2Before.timestamp,
      "SubagentStop must not rewrite another agent's file");

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.activeSubagents.length, 1);
    assert.strictEqual(stats.session.activeSubagents[0].agentId, 'a2');
    cleanup(tmp);
  });
});

describe('update-state -- legacy subagents without agent_id', () => {
  test('SubagentStart mints a p-sub-<ts> orbital and SubagentStop retires it', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('p');

    runUpdateState('SubagentStart', {
      session_id: 'p', hook_event_name: 'SubagentStart', cwd: process.cwd(),
      description: 'legacy task',
    }, env);

    const files = fs.readdirSync(sessionsDir).filter(f => /^p-sub-\d+\.json$/.test(f));
    assert.strictEqual(files.length, 1, 'expected exactly one legacy synthetic orbital');

    runUpdateState('SubagentStop', {
      session_id: 'p', hook_event_name: 'SubagentStop', cwd: process.cwd(),
    }, env);

    const retired = readJSON(path.join(sessionsDir, files[0]));
    assert.strictEqual(retired.stopped, true);
    assert.strictEqual(retired.taskDescription, 'legacy task');
    assert.strictEqual(readJSON(statsFile).session.activeSubagents.length, 0);
    cleanup(tmp);
  });
});

describe('update-state -- active subagent ageing net', () => {
  // opts.legacy seeds a pre-agent_id synthetic entry (no agentId): the parent
  // is its only writer, so the parent's touch is what keeps it alive.
  function seed(env, statsFile, sessionsDir, startedAt, opts = {}) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    writeJsonAtomic(sessionFile(sessionsDir, 'p-agent-old'), {
      session_id: 'p-agent-old', state: 'coding', detail: 'working',
      timestamp: startedAt, stopped: false,
      parentSession: 'p', taskDescription: 'long job', modelName: 'Explore',
      agentType: 'Explore',
    });
    // Backdate the file so a successful touch is measurable.
    const old = new Date(startedAt);
    fs.utimesSync(sessionFile(sessionsDir, 'p-agent-old'), old, old);
    writeJsonAtomic(statsFile, {
      streak: 0, bestStreak: 0, brokenStreak: 0, brokenStreakAt: 0,
      totalToolCalls: 0, totalErrors: 0,
      records: { longestSession: 0, mostSubagents: 1, mostFilesEdited: 0 },
      session: {
        id: 'p', start: Date.now() - 60000, toolCalls: 0, filesEdited: [],
        subagentCount: 1, commitCount: 0,
        activeSubagents: [{
          id: 'p-agent-old',
          ...(opts.legacy ? {} : { agentId: 'old' }),
          description: 'long job',
          taskDescription: 'long job', agentType: 'Explore',
          model: 'Explore', editor: 'claude', startedAt,
        }],
      },
      recentMilestone: null,
      daily: { date: new Date().toISOString().slice(0, 10), sessionCount: 1, cumulativeMs: 0 },
      frequentFiles: {},
      topLevelSessions: { p: Date.now() },
    });
  }

  test('an 11-minute-old agent survives the ageing net', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('p');
    seed(env, statsFile, sessionsDir, Date.now() - 11 * 60000);

    runUpdateState('PreToolUse', {
      session_id: 'p', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.activeSubagents.length, 1,
      'an agent running longer than 10 minutes must not be dropped');
    cleanup(tmp);
  });

  // The bookkeeping entry surviving is NOT the same as the orbital surviving.
  // An agent-owned entry keeps its own file fresh by writing to it; the parent
  // must not vouch for it, or a missed SubagentStop leaves a ghost orbital
  // that the parent's own tool calls keep alive for the full 4-hour net.
  test("a parent tool call does not refresh its agent-owned child's file", () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('p');
    const startedAt = Date.now() - 11 * 60000;
    seed(env, statsFile, sessionsDir, startedAt);

    runUpdateState('PreToolUse', {
      session_id: 'p', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const mtime = fs.statSync(sessionFile(sessionsDir, 'p-agent-old')).mtimeMs;
    assert.ok(Date.now() - mtime > 60000,
      `a child with an agentId must keep its own file: mtime was refreshed to `
      + `${Date.now() - mtime}ms old by the parent's activity`);
    cleanup(tmp);
  });

  test('a parent tool call still refreshes a legacy synthetic child', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('p');
    const startedAt = Date.now() - 11 * 60000;
    seed(env, statsFile, sessionsDir, startedAt, { legacy: true });

    runUpdateState('PreToolUse', {
      session_id: 'p', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const mtime = fs.statSync(sessionFile(sessionsDir, 'p-agent-old')).mtimeMs;
    assert.ok(Date.now() - mtime < 2000,
      `a synthetic child has no writer of its own, so the parent must keep it `
      + `alive: mtime was ${Date.now() - mtime}ms old`);
    cleanup(tmp);
  });

  test('a 5-hour-old entry is dropped by the safety net', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('p');
    seed(env, statsFile, sessionsDir, Date.now() - 5 * 3600000);

    runUpdateState('PreToolUse', {
      session_id: 'p', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    assert.strictEqual(readJSON(statsFile).session.activeSubagents.length, 0);
    cleanup(tmp);
  });
});

// -- an agent event must never reset the stats owner's session ---------

describe('update-state -- agent events never adopt the stats session', () => {
  test("an agent of a non-owner parent leaves the owner's activeSubagents intact", () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('Q');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Owner Q is conducting one agent of its own.
    writeJsonAtomic(sessionFile(sessionsDir, 'Q-agent-q1'), {
      session_id: 'Q-agent-q1', state: 'coding', detail: 'work',
      timestamp: Date.now(), stopped: false,
      parentSession: 'Q', taskDescription: 'owner task', modelName: 'Explore',
    });
    writeJsonAtomic(statsFile, {
      streak: 0, bestStreak: 0, brokenStreak: 0, brokenStreakAt: 0,
      totalToolCalls: 7, totalErrors: 0,
      records: { longestSession: 1234, mostSubagents: 1, mostFilesEdited: 0 },
      session: {
        id: 'Q', start: Date.now() - 60000, toolCalls: 7, filesEdited: [],
        subagentCount: 1, commitCount: 0,
        activeSubagents: [{
          id: 'Q-agent-q1', agentId: 'q1', description: 'owner task',
          taskDescription: 'owner task', agentType: 'Explore',
          model: 'Explore', editor: 'claude', startedAt: Date.now() - 5000,
        }],
      },
      recentMilestone: null,
      daily: { date: new Date().toISOString().slice(0, 10), sessionCount: 1, cumulativeMs: 0 },
      frequentFiles: {},
      topLevelSessions: { Q: Date.now() },
    });

    // A different top-level session P has its own agent working.
    runUpdateState('PreToolUse', {
      session_id: 'P', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      agent_id: 'p1', agent_type: 'Plan',
      tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.id, 'Q',
      "an agent event must not adopt stats.session from its parent's id");
    assert.strictEqual(stats.session.activeSubagents.length, 1,
      "the owner's activeSubagents must survive an unrelated agent event");
    assert.strictEqual(stats.session.activeSubagents[0].id, 'Q-agent-q1');
    assert.ok(stats.session.start > 0, "the owner's session records must survive");
    assert.strictEqual(stats.daily.sessionCount, 1,
      'no session reset means no spurious sessionCount increment');
    // P's agent still gets its own orbital.
    const pAgent = readJSON(sessionFile(sessionsDir, 'P-agent-p1'));
    assert.strictEqual(pAgent.state, 'reading');
    assert.strictEqual(pAgent.parentSession, 'P');
    cleanup(tmp);
  });
});

// -- family heartbeat --------------------------------------------------

describe('update-state -- agent writes heartbeat the parent session file', () => {
  test("an agent event refreshes the parent's file mtime without rewriting it", () => {
    const { tmp, sessionsDir, env } = makeTempEnv('p');
    runUpdateState('SubagentStart', {
      session_id: 'p', hook_event_name: 'SubagentStart', cwd: process.cwd(),
      agent_id: 'a1', agent_type: 'Explore', invocation_prompt: 'long job',
    }, env);

    const parentPath = sessionFile(sessionsDir, 'p');
    const before = readJSON(parentPath);
    // Pretend the parent has been silently waiting on its agent for 10 minutes.
    const old = new Date(Date.now() - 10 * 60000);
    fs.utimesSync(parentPath, old, old);

    runUpdateState('PreToolUse', {
      session_id: 'p', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      agent_id: 'a1', agent_type: 'Explore',
      tool_name: 'Grep', tool_input: { pattern: 'x' },
    }, env);

    const mtime = fs.statSync(parentPath).mtimeMs;
    assert.ok(Date.now() - mtime < 2000,
      `the parent's file should be touched by its agent's write, got ${Date.now() - mtime}ms old`);
    const after = readJSON(parentPath);
    assert.strictEqual(after.timestamp, before.timestamp,
      'the heartbeat must touch the mtime, not rewrite the parent state');
    assert.strictEqual(after.state, before.state);
    cleanup(tmp);
  });
});

// -- grid.js child staleness ------------------------------------------

describe('grid.js -- child orbital staleness', () => {
  test('CHILD_ORPHAN_TIMEOUT is 15 minutes and longer than ORPHAN_TIMEOUT', () => {
    assert.strictEqual(CHILD_ORPHAN_TIMEOUT, 900000);
    assert.ok(CHILD_ORPHAN_TIMEOUT > ORPHAN_TIMEOUT);
  });

  function childFace(ageMs, extra) {
    const mf = new MiniFace('p-agent-a1');
    const mtime = Date.now() - ageMs;
    mf.updateFromFile({
      session_id: 'p-agent-a1', state: 'coding', detail: 'edit foo',
      timestamp: mtime, stopped: false, parentSession: 'p',
      agentType: 'Explore', ...extra,
    }, mtime);
    return mf;
  }

  test('a 5-minute-silent child is not stale', () => {
    assert.strictEqual(childFace(5 * 60000).isStale(), false);
  });

  test('a 16-minute-silent child is stale', () => {
    assert.strictEqual(childFace(16 * 60000).isStale(), true);
  });

  test('a top-level session at 5 minutes is still stale', () => {
    const mf = new MiniFace('other');
    const mtime = Date.now() - 5 * 60000;
    mf.updateFromFile({
      session_id: 'other', state: 'coding', timestamp: mtime, stopped: false,
    }, mtime);
    assert.strictEqual(mf.isStale(), true);
  });

  test('updateFromFile reads agentType', () => {
    assert.strictEqual(childFace(1000).agentType, 'Explore');
  });

  test('a child whose parent has gone silent falls back to ORPHAN_TIMEOUT', () => {
    const mf = childFace(5 * 60000);
    mf.parentAlive = false;
    assert.strictEqual(mf.isStale(), true,
      "a ghost child of a crashed parent must not hold the long window");
  });

  // The parent heartbeat (every agent write touches the parent's file) is what
  // makes "parent file fresh" a real liveness signal, so the purge can tell a
  // waiting conductor from a crashed one.
  function childResult(ageMs) {
    return {
      file: 'p-agent-a1.json',
      data: {
        session_id: 'p-agent-a1', state: 'coding', stopped: false,
        parentSession: 'p', taskDescription: 'long job',
      },
      mtimeMs: Date.now() - ageMs,
    };
  }
  function parentResult(ageMs) {
    return {
      file: 'p.json',
      data: { session_id: 'p', state: 'subagent', stopped: false },
      mtimeMs: Date.now() - ageMs,
    };
  }

  test('_applySessionResults keeps a 5-minute-old child under a fresh parent', () => {
    const os = new OrbitalSystem();
    os._applySessionResults('main-id', [parentResult(1000), childResult(5 * 60000)]);
    assert.ok(os.faces.has('p-agent-a1'),
      'a subagent in a long model turn must survive the mtime purge');
    assert.strictEqual(os.faces.get('p-agent-a1').parentAlive, true);
  });

  test('_applySessionResults drops a 5-minute-old child under a silent parent', () => {
    const os = new OrbitalSystem();
    os._applySessionResults('main-id', [parentResult(10 * 60000), childResult(5 * 60000)]);
    assert.ok(!os.faces.has('p-agent-a1'),
      "a crashed parent's ghost child must not get the 15-minute window");
  });

  test('_applySessionResults drops a child whose parent file is gone entirely', () => {
    const os = new OrbitalSystem();
    os._applySessionResults('main-id', [childResult(5 * 60000)]);
    assert.ok(!os.faces.has('p-agent-a1'));
  });

  test('_applySessionResults still drops a 5-minute-old top-level file', () => {
    const os = new OrbitalSystem();
    const mtimeMs = Date.now() - 5 * 60000;
    os._applySessionResults('main-id', [{
      file: 'other.json',
      data: { session_id: 'other', state: 'coding', stopped: false },
      mtimeMs,
    }]);
    assert.ok(!os.faces.has('other'));
  });

  test('STALE_MS is the parent-freshness window and is shorter than the child one', () => {
    assert.ok(STALE_MS < CHILD_ORPHAN_TIMEOUT);
  });

  test('updateFromFile takes a newer mtime when only the file was touched', () => {
    const mf = new MiniFace('p-agent-a1');
    const ts = Date.now() - 5 * 60000;
    const data = { session_id: 'p-agent-a1', state: 'coding', timestamp: ts, parentSession: 'p' };
    mf.updateFromFile(data, ts);
    assert.strictEqual(mf.lastUpdate, ts);
    // Same content, fresher mtime -- a heartbeat touch, not a rewrite.
    const touched = Date.now();
    mf.updateFromFile(data, touched);
    assert.strictEqual(mf.lastUpdate, touched,
      'a touched file must refresh lastUpdate so the face does not go stale under it');
  });
});

// -- the conducting face is not a running tool ------------------------
// `subagent` lives in ACTIVE_WORK_STATES, which answers "what may interrupt
// what" -- a different question from "is a tool running". Borrowing it for the
// long-tool escalation made the conducting hold render
// `conducting 3 - still running ... 240s` and sweat for as long as the agents
// ran. `responding` was excluded from the cascade's hold for exactly this
// reason but never from escalation.

describe('face.js -- escalation is for tools, not for held states', () => {
  function heldFace(state, detail, heldMs) {
    const face = new ClaudeFace();
    face.state = state;
    face.stateDetail = detail;
    face.lastStateChange = Date.now() - heldMs;
    return face;
  }

  test('a conducting face never counts up "still running"', () => {
    const face = heldFace('subagent', 'conducting 3', 240000);
    assert.strictEqual(face.displayDetail(), 'conducting 3',
      'the conducting hold is not a tool call and must not be timed');
  });

  test('a conducting face never sweats', () => {
    const face = heldFace('subagent', 'conducting 3', 240000);
    face.particles.particles.length = 0;
    for (let i = 0; i < 60; i++) face.update(66);
    assert.ok(!face.particles.particles.some(p => p.style === 'sweat'),
      'a multi-agent run must not put the main face in permanent distress');
  });

  test('a responding face never escalates either', () => {
    const face = heldFace('responding', 'wrapping up', 240000);
    assert.strictEqual(face.displayDetail(), 'wrapping up',
      'responding is a post-turn state, never a tool');
    face.particles.particles.length = 0;
    for (let i = 0; i < 60; i++) face.update(66);
    assert.ok(!face.particles.particles.some(p => p.style === 'sweat'));
  });

  test('a real long-running tool still escalates and sweats', () => {
    const face = heldFace('executing', 'npm test', 240000);
    assert.ok(face.displayDetail().includes('still running'),
      'the long-tool escalation must survive this fix');
    assert.ok(face.displayDetail().includes('240s'));
    face.particles.particles.length = 0;
    for (let i = 0; i < 60; i++) face.update(66);
    assert.ok(face.particles.particles.some(p => p.style === 'sweat'));
  });

  test('every other work state still escalates', () => {
    for (const s of ['coding', 'reading', 'searching', 'testing',
      'installing', 'committing', 'reviewing', 'training']) {
      assert.ok(heldFace(s, 'x', 240000).displayDetail().includes('still running'),
        `${s} is a real tool and must still escalate`);
    }
  });

  test('a waiting face still counts up bare', () => {
    assert.strictEqual(heldFace('waiting', 'allow?', 45000).displayDetail(),
      'allow?' + DETAIL_SEP + '45s');
  });
});

// -- main face conducting hold ----------------------------------------

describe('renderer -- idleCascade conducting hold', () => {
  const base = { sessionActive: true, lingerMs: 0, fileState: 'idle' };

  test('existing callers are unaffected (liveChildren defaults to 0)', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'idle', sinceChangeMs: SLEEP_TIMEOUT + 1,
    }), 'sleeping');
    assert.strictEqual(idleCascade({
      ...base, state: 'thinking', sinceChangeMs: THINKING_TIMEOUT + 1, fileState: 'thinking',
    }), 'idle');
  });

  test('idle is lifted to subagent while children are live', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'idle', sinceChangeMs: 100, liveChildren: 3,
    }), 'subagent');
  });

  test('sleeping is lifted to subagent while children are live', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'sleeping', sinceChangeMs: 999999, liveChildren: 1,
    }), 'subagent');
  });

  test('subagent holds instead of degrading to thinking or idle', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'subagent', sinceChangeMs: 999999, fileState: 'subagent', liveChildren: 2,
    }), null);
    assert.strictEqual(idleCascade({
      ...base, state: 'subagent', sinceChangeMs: 999999, fileState: 'idle',
      sessionActive: false, liveChildren: 2,
    }), null);
  });

  test('a finished turn still shows its reward before conducting resumes', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'responding', sinceChangeMs: 0, sessionActive: false, liveChildren: 2,
    }), 'happy');
    // ...and the reward holds for its linger.
    assert.strictEqual(idleCascade({
      ...base, state: 'happy', sinceChangeMs: 1000, lingerMs: 5000, liveChildren: 2,
    }), null);
    // ...then falls to conducting rather than thinking/idle.
    assert.strictEqual(idleCascade({
      ...base, state: 'happy', sinceChangeMs: 5001, lingerMs: 5000, liveChildren: 2,
    }), 'subagent');
  });

  test('real work states are never intercepted', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'coding', sinceChangeMs: 100, fileState: 'coding', liveChildren: 2,
    }), null);
  });

  // Ordering against Task 3's `waiting` bound. "The editor needs YOU" is
  // actionable and outranks the ambient "your agents are busy", so the waiting
  // hold wins while it lasts; conducting only fills the vacuum afterwards.
  test('waiting on the user outranks conducting', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'waiting', sinceChangeMs: 999999, fileState: 'waiting',
      fileAgeMs: 1000, liveChildren: 4,
    }), null, 'a live waiting hold must not be replaced by conducting');
  });

  test('a stale waiting hold degrades to conducting, not idle, with live children', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'waiting', sinceChangeMs: 999999, fileState: 'waiting',
      fileAgeMs: WAIT_HOLD_STALE_MS + 1, liveChildren: 4,
    }), 'subagent',
    'the global write clock has gone quiet but the agents demonstrably have not');
  });

  test('a stale waiting hold still degrades to idle with no children', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'waiting', sinceChangeMs: 999999, fileState: 'waiting',
      fileAgeMs: WAIT_HOLD_STALE_MS + 1,
    }), 'idle');
  });

  test('the hold releases when the last child retires', () => {
    assert.strictEqual(idleCascade({
      ...base, state: 'subagent', sinceChangeMs: 999999, fileState: 'subagent', liveChildren: 0,
    }), 'thinking');
    assert.strictEqual(idleCascade({
      ...base, state: 'idle', sinceChangeMs: SLEEP_TIMEOUT + 1, liveChildren: 0,
    }), 'sleeping');
  });
});

describe('grid.js -- liveChildCount bounds the conducting hold', () => {
  function systemWith(children) {
    const os = new OrbitalSystem();
    os.mainSessionId = 'p';
    for (const c of children) {
      const mf = new MiniFace(c.id);
      const mtime = Date.now() - (c.ageMs || 0);
      mf.updateFromFile({
        session_id: c.id, state: 'coding', timestamp: mtime,
        stopped: !!c.stopped, parentSession: c.parentSession,
      }, mtime);
      if (c.parentAlive === false) mf.parentAlive = false;
      os.faces.set(c.id, mf);
    }
    return os;
  }

  test('counts live children of the main session', () => {
    const os = systemWith([
      { id: 'p-agent-a1', parentSession: 'p' },
      { id: 'p-agent-a2', parentSession: 'p' },
    ]);
    assert.strictEqual(os.liveChildCount(), 2);
  });

  test('ignores stopped children', () => {
    const os = systemWith([
      { id: 'p-agent-a1', parentSession: 'p', stopped: true },
      { id: 'p-agent-a2', parentSession: 'p' },
    ]);
    assert.strictEqual(os.liveChildCount(), 1);
  });

  test('ignores stale children of a crashed parent', () => {
    const os = systemWith([
      { id: 'p-agent-a1', parentSession: 'p', ageMs: 5 * 60000, parentAlive: false },
    ]);
    assert.strictEqual(os.liveChildCount(), 0,
      'a stale ghost must not hold the main face at conducting');
  });

  test("ignores another session's children and top-level orbitals", () => {
    const os = systemWith([
      { id: 'q-agent-b1', parentSession: 'q' },
      { id: 'other', parentSession: undefined },
    ]);
    assert.strictEqual(os.liveChildCount(), 0);
  });

  test('is zero when the main session is unknown', () => {
    const os = systemWith([{ id: 'p-agent-a1', parentSession: 'p' }]);
    os.mainSessionId = null;
    assert.strictEqual(os.liveChildCount(), 0);
  });
});

module.exports = suite;
