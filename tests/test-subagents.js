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
  MiniFace, OrbitalSystem, CHILD_ORPHAN_TIMEOUT, ORPHAN_TIMEOUT,
} = require('../grid');

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
  function seed(env, statsFile, sessionsDir, startedAt) {
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
          id: 'p-agent-old', agentId: 'old', description: 'long job',
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

  test('an 11-minute-old agent survives and its file is touched', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('p');
    seed(env, statsFile, sessionsDir, Date.now() - 11 * 60000);

    runUpdateState('PreToolUse', {
      session_id: 'p', hook_event_name: 'PreToolUse', cwd: process.cwd(),
      tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.activeSubagents.length, 1,
      'an agent running longer than 10 minutes must not be dropped');
    const mtime = fs.statSync(sessionFile(sessionsDir, 'p-agent-old')).mtimeMs;
    assert.ok(Date.now() - mtime < 2000,
      `expected a fresh mtime, got ${Date.now() - mtime}ms old`);
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

  test('_applySessionResults keeps a 5-minute-old child file', () => {
    const os = new OrbitalSystem();
    const mtimeMs = Date.now() - 5 * 60000;
    os._applySessionResults('main-id', [{
      file: 'p-agent-a1.json',
      data: {
        session_id: 'p-agent-a1', state: 'coding', stopped: false,
        parentSession: 'p', taskDescription: 'long job',
      },
      mtimeMs,
    }]);
    assert.ok(os.faces.has('p-agent-a1'),
      'a subagent in a long model turn must survive the mtime purge');
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
});

module.exports = suite;
