#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - Adapter coverage                        |
// |  Tests for codex-notify, opencode-adapter, openclaw-adapter,     |
// |  and codex-wrapper (structure only — requires codex binary).     |
// |                                                                  |
// |  Adapters are scripts, not libraries, so we test them by         |
// |  spawning child processes with controlled env/stdin/argv and     |
// |  verifying the state files they write.                           |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const os = require('os');

let passed = 0;
let failed = 0;

function describe(name, fn) {
  console.log(`\n  ${name}`);
  fn();
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    \x1b[32m\u2713\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`    \x1b[31m\u2717\x1b[0m ${name}`);
    console.log(`      ${e.message}`);
  }
}

// -- Helpers ----------------------------------------------------------

const ADAPTERS_DIR = path.join(__dirname, '..', 'adapters');
const NODE = process.execPath;

// Create a temp directory for each test run so adapters write state
// files there instead of polluting the real home directory.
function makeTempEnv(sessionId) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-test-'));
  const stateFile = path.join(tmp, '.code-crumb-state');
  const sessionsDir = path.join(tmp, '.code-crumb-sessions');
  const statsFile = path.join(tmp, '.code-crumb-stats.json');
  // Adapters resolve paths via shared.js which reads HOME/USERPROFILE
  // and CODE_CRUMB_STATE. We override HOME so all paths land in tmp.
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    CODE_CRUMB_STATE: stateFile,
    CLAUDE_SESSION_ID: sessionId || 'test-session',
  };
  return { tmp, stateFile, sessionsDir, statsFile, env };
}

function cleanup(tmp) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

function readJSON(filepath) {
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

// Run an adapter that reads stdin, return the state file contents
function runStdinAdapter(adapterFile, inputObj, env) {
  const input = JSON.stringify(inputObj);
  try {
    execFileSync(NODE, [adapterFile], {
      input,
      env,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    // Adapters call process.exit(0), which can throw in execFileSync
    // on some Node versions. That's fine as long as the state file was written.
    if (e.status !== 0 && e.status !== null) throw e;
  }
}

// -- codex-notify.js -------------------------------------------------

describe('adapters -- codex-notify', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'codex-notify.js');

  test('agent-turn-complete writes happy state', () => {
    const { tmp, stateFile, env } = makeTempEnv('notify-1');
    const event = {
      type: 'agent-turn-complete',
      'thread-id': 'notify-1',
      'last-assistant-message': 'I fixed the bug',
    };
    try {
      execFileSync(NODE, [ADAPTER, JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'happy');
    assert.ok(state.detail.includes('I fixed the bug'));
    assert.strictEqual(state.modelName, 'codex');
    cleanup(tmp);
  });

  test('agent-turn-complete truncates long messages', () => {
    const { tmp, stateFile, env } = makeTempEnv('notify-2');
    const longMsg = 'A'.repeat(60);
    const event = {
      type: 'agent-turn-complete',
      'thread-id': 'notify-2',
      'last-assistant-message': longMsg,
    };
    try {
      execFileSync(NODE, [ADAPTER, JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'happy');
    assert.ok(state.detail.length <= 40, `detail should be truncated, got ${state.detail.length}`);
    assert.ok(state.detail.endsWith('...'));
    cleanup(tmp);
  });

  test('approval-requested writes waiting state', () => {
    const { tmp, stateFile, env } = makeTempEnv('notify-3');
    const event = { type: 'approval-requested', 'thread-id': 'notify-3' };
    try {
      execFileSync(NODE, [ADAPTER, JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'waiting');
    assert.strictEqual(state.detail, 'needs approval');
    cleanup(tmp);
  });

  test('unknown event type writes thinking state', () => {
    const { tmp, stateFile, env } = makeTempEnv('notify-4');
    const event = { type: 'some-new-event', 'thread-id': 'notify-4' };
    try {
      execFileSync(NODE, [ADAPTER, JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'thinking');
    assert.strictEqual(state.detail, 'some-new-event');
    cleanup(tmp);
  });

  test('writes session file alongside global state', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('notify-5');
    const event = { type: 'agent-turn-complete', 'thread-id': 'notify-5' };
    try {
      execFileSync(NODE, [ADAPTER, JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    assert.ok(fs.existsSync(sessionsDir), 'sessions directory should exist');
    const files = fs.readdirSync(sessionsDir);
    assert.ok(files.length > 0, 'should have at least one session file');
    const sessionData = readJSON(path.join(sessionsDir, files[0]));
    assert.strictEqual(sessionData.state, 'happy');
    assert.strictEqual(sessionData.session_id, 'notify-5');
    cleanup(tmp);
  });

  test('exits cleanly with no arguments', () => {
    const { tmp, env } = makeTempEnv('notify-6');
    // No JSON argument -- should exit silently
    try {
      execFileSync(NODE, [ADAPTER], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    // Just verifying no crash
    assert.ok(true, 'should not throw');
    cleanup(tmp);
  });

  test('respects CODE_CRUMB_MODEL env var', () => {
    const { tmp, stateFile, env } = makeTempEnv('notify-7');
    env.CODE_CRUMB_MODEL = 'my-codex';
    const event = { type: 'agent-turn-complete', 'thread-id': 'notify-7' };
    try {
      execFileSync(NODE, [ADAPTER, JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    const state = readJSON(stateFile);
    assert.strictEqual(state.modelName, 'my-codex');
    cleanup(tmp);
  });
});

// -- opencode-adapter.js ---------------------------------------------

describe('adapters -- opencode-adapter', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'opencode-adapter.js');

  test('tool.execute.before with edit tool writes coding state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-1');
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before',
      input: { tool: 'file_edit', args: { file_path: '/tmp/foo.js' } },
      session_id: 'oc-1',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'coding');
    assert.strictEqual(state.modelName, 'opencode');
    cleanup(tmp);
  });

  test('tool.execute.before with bash tool writes executing state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-2');
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before',
      input: { tool: 'shell', args: {} },
      session_id: 'oc-2',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'executing');
    cleanup(tmp);
  });

  test('tool.execute.before with search tool writes searching state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-3');
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before',
      input: { tool: 'codebase_search', args: {} },
      session_id: 'oc-3',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'searching');
    cleanup(tmp);
  });

  test('tool.execute.after writes result state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-4');
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.after',
      input: { tool: 'shell', args: {} },
      output: { output: 'success' },
      session_id: 'oc-4',
    }, env);
    const state = readJSON(stateFile);
    // Should be a completion state (happy, satisfied, proud, relieved)
    assert.ok(
      ['happy', 'satisfied', 'proud', 'relieved'].includes(state.state),
      `expected completion state, got "${state.state}"`
    );
    cleanup(tmp);
  });

  test('tool.execute.after with error writes error state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-5');
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.after',
      input: { tool: 'shell', args: {} },
      output: { output: 'FATAL ERROR: segfault' },
      error: true,
      is_error: true,
      session_id: 'oc-5',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    cleanup(tmp);
  });

  test('session.idle writes happy/stopped state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-6');
    runStdinAdapter(ADAPTER, {
      type: 'session.idle',
      session_id: 'oc-6',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'happy');
    assert.strictEqual(state.detail, 'all done!');
    cleanup(tmp);
  });

  test('session.error writes error state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-7');
    runStdinAdapter(ADAPTER, {
      type: 'session.error',
      output: { error: 'connection lost' },
      session_id: 'oc-7',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    assert.ok(state.detail.includes('connection lost'));
    cleanup(tmp);
  });

  test('session.created writes waiting state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-8');
    runStdinAdapter(ADAPTER, {
      type: 'session.created',
      session_id: 'oc-8',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'waiting');
    assert.strictEqual(state.detail, 'session started');
    cleanup(tmp);
  });

  test('message.part.updated with is_thinking writes thinking', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-9');
    runStdinAdapter(ADAPTER, {
      type: 'message.part.updated',
      is_thinking: true,
      thinking: 'reasoning about architecture',
      session_id: 'oc-9',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'thinking');
    cleanup(tmp);
  });

  test('writes session file alongside global state', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('oc-10');
    runStdinAdapter(ADAPTER, {
      type: 'session.idle',
      session_id: 'oc-10',
    }, env);
    assert.ok(fs.existsSync(sessionsDir), 'sessions directory should exist');
    const files = fs.readdirSync(sessionsDir);
    assert.ok(files.length > 0, 'should have session file');
    const sessionData = readJSON(path.join(sessionsDir, files[0]));
    assert.strictEqual(sessionData.session_id, 'oc-10');
    assert.strictEqual(sessionData.state, 'happy');
    cleanup(tmp);
  });

  test('respects model_name from event data', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-11');
    runStdinAdapter(ADAPTER, {
      type: 'session.idle',
      session_id: 'oc-11',
      model_name: 'deepseek-v3',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.modelName, 'deepseek-v3');
    cleanup(tmp);
  });

  test('generic tool_start event works', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-12');
    runStdinAdapter(ADAPTER, {
      event: 'tool_start',
      tool: 'Grep',
      tool_input: { pattern: 'foo' },
      session_id: 'oc-12',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'searching');
    cleanup(tmp);
  });

  test('generic tool_end event works', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-13');
    runStdinAdapter(ADAPTER, {
      event: 'tool_end',
      tool: 'Read',
      tool_input: { file_path: '/tmp/x.js' },
      output: 'file contents here',
      session_id: 'oc-13',
    }, env);
    const state = readJSON(stateFile);
    assert.ok(
      ['happy', 'satisfied', 'proud', 'relieved'].includes(state.state),
      `expected completion state, got "${state.state}"`
    );
    cleanup(tmp);
  });

  test('tracks tool call count in stats', () => {
    const { tmp, statsFile, env } = makeTempEnv('oc-14');
    // Send two tool_start events
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before',
      input: { tool: 'shell', args: {} },
      session_id: 'oc-14',
    }, env);
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before',
      input: { tool: 'Read', args: {} },
      session_id: 'oc-14',
    }, env);
    const stats = readJSON(statsFile);
    assert.ok(stats.totalToolCalls >= 2, `expected >= 2 tool calls, got ${stats.totalToolCalls}`);
    cleanup(tmp);
  });
});

// -- openclaw-adapter.js ---------------------------------------------

describe('adapters -- openclaw-adapter', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'openclaw-adapter.js');

  test('tool_call event normalises to tool_start and writes state', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-1');
    runStdinAdapter(ADAPTER, {
      event: 'tool_call',
      toolName: 'edit',
      input: { file_path: '/tmp/foo.py' },
      session_id: 'claw-1',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'coding');
    assert.strictEqual(state.modelName, 'openclaw');
    cleanup(tmp);
  });

  test('tool_execution_start normalises to tool_start', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-2');
    runStdinAdapter(ADAPTER, {
      event: 'tool_execution_start',
      toolName: 'bash',
      input: { command: 'ls' },
      session_id: 'claw-2',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'executing');
    cleanup(tmp);
  });

  test('tool_execution_end normalises to tool_end', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-3');
    runStdinAdapter(ADAPTER, {
      event: 'tool_execution_end',
      toolName: 'read',
      input: { file_path: '/tmp/x.py' },
      output: 'file contents',
      session_id: 'claw-3',
    }, env);
    const state = readJSON(stateFile);
    assert.ok(
      ['happy', 'satisfied', 'proud', 'relieved'].includes(state.state),
      `expected completion state, got "${state.state}"`
    );
    cleanup(tmp);
  });

  test('tool_result normalises to tool_end', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-4');
    runStdinAdapter(ADAPTER, {
      event: 'tool_result',
      toolName: 'bash',
      input: { command: 'npm test' },
      result: 'all tests passed',
      session_id: 'claw-4',
    }, env);
    const state = readJSON(stateFile);
    assert.ok(
      ['happy', 'satisfied', 'proud', 'relieved'].includes(state.state),
      `expected completion state, got "${state.state}"`
    );
    cleanup(tmp);
  });

  test('session_end normalises to turn_end (happy)', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-5');
    runStdinAdapter(ADAPTER, {
      event: 'session_end',
      session_id: 'claw-5',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'happy');
    assert.strictEqual(state.detail, 'all done!');
    cleanup(tmp);
  });

  test('turn_end event writes happy state', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-6');
    runStdinAdapter(ADAPTER, {
      event: 'turn_end',
      session_id: 'claw-6',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'happy');
    cleanup(tmp);
  });

  test('Stop event normalises to turn_end', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-7');
    runStdinAdapter(ADAPTER, {
      event: 'Stop',
      session_id: 'claw-7',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'happy');
    cleanup(tmp);
  });

  test('Notification event normalises to waiting', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-8');
    runStdinAdapter(ADAPTER, {
      event: 'Notification',
      session_id: 'claw-8',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'waiting');
    assert.strictEqual(state.detail, 'needs attention');
    cleanup(tmp);
  });

  test('error event writes error state with message', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-9');
    runStdinAdapter(ADAPTER, {
      event: 'error',
      message: 'connection timed out',
      session_id: 'claw-9',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    assert.ok(state.detail.includes('connection timed out'));
    cleanup(tmp);
  });

  test('error event uses reason field as fallback', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-10');
    runStdinAdapter(ADAPTER, {
      event: 'error',
      reason: 'rate limited',
      session_id: 'claw-10',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    assert.ok(state.detail.includes('rate limited'));
    cleanup(tmp);
  });

  test('blocked flag triggers error in tool_end', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-11');
    runStdinAdapter(ADAPTER, {
      event: 'tool_result',
      toolName: 'bash',
      input: { command: 'rm -rf /' },
      blocked: true,
      session_id: 'claw-11',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    cleanup(tmp);
  });

  test('writes session file alongside global state', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('claw-12');
    runStdinAdapter(ADAPTER, {
      event: 'tool_call',
      toolName: 'read',
      input: {},
      session_id: 'claw-12',
    }, env);
    assert.ok(fs.existsSync(sessionsDir), 'sessions directory should exist');
    const files = fs.readdirSync(sessionsDir);
    assert.ok(files.length > 0, 'should have session file');
    cleanup(tmp);
  });

  test('respects model_name from event data', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-13');
    runStdinAdapter(ADAPTER, {
      event: 'turn_end',
      session_id: 'claw-13',
      model_name: 'pi-custom',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.modelName, 'pi-custom');
    cleanup(tmp);
  });

  test('respects CODE_CRUMB_MODEL env var', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-14');
    env.CODE_CRUMB_MODEL = 'my-claw';
    runStdinAdapter(ADAPTER, {
      event: 'turn_end',
      session_id: 'claw-14',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.modelName, 'my-claw');
    cleanup(tmp);
  });

  test('Pi read tool maps to reading state', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-15');
    runStdinAdapter(ADAPTER, {
      event: 'tool_call',
      toolName: 'Read',
      input: { file_path: '/tmp/data.txt' },
      session_id: 'claw-15',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'reading');
    cleanup(tmp);
  });

  test('Pi search tool maps to searching state', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-16');
    runStdinAdapter(ADAPTER, {
      event: 'tool_call',
      toolName: 'search_files',
      input: {},
      session_id: 'claw-16',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'searching');
    cleanup(tmp);
  });

  test('tracks edited files in stats', () => {
    const { tmp, statsFile, env } = makeTempEnv('claw-17');
    runStdinAdapter(ADAPTER, {
      event: 'tool_call',
      toolName: 'edit',
      input: { file_path: '/home/user/project/main.py' },
      session_id: 'claw-17',
    }, env);
    const stats = readJSON(statsFile);
    assert.ok(stats.session.filesEdited.includes('main.py'), 'should track edited file');
    assert.ok(stats.frequentFiles['main.py'] >= 1, 'should track in frequentFiles');
    cleanup(tmp);
  });

  test('generic tool_start passthrough works', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-18');
    runStdinAdapter(ADAPTER, {
      event: 'tool_start',
      tool: 'Bash',
      session_id: 'claw-18',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'executing');
    cleanup(tmp);
  });

  test('generic tool_end passthrough works', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-19');
    runStdinAdapter(ADAPTER, {
      event: 'tool_end',
      tool: 'Bash',
      output: 'command output',
      session_id: 'claw-19',
    }, env);
    const state = readJSON(stateFile);
    assert.ok(
      ['happy', 'satisfied', 'proud', 'relieved'].includes(state.state),
      `expected completion state, got "${state.state}"`
    );
    cleanup(tmp);
  });

  test('waiting event passthrough works', () => {
    const { tmp, stateFile, env } = makeTempEnv('claw-20');
    runStdinAdapter(ADAPTER, {
      event: 'waiting',
      session_id: 'claw-20',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'waiting');
    cleanup(tmp);
  });
});

// -- codex-wrapper.js (structural tests) -----------------------------

describe('adapters -- codex-wrapper (structural)', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'codex-wrapper.js');

  test('adapter file exists', () => {
    assert.ok(fs.existsSync(ADAPTER), 'codex-wrapper.js should exist');
  });

  test('adapter file starts with use strict', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'use strict'"), 'should have use strict');
  });

  test('adapter imports shared.js dependencies', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(
      src.includes("require('../shared')") || src.includes("require('./base-adapter')"),
      'should import shared or base-adapter'
    );
    assert.ok(
      src.includes("require('../state-machine')") || src.includes("require('./base-adapter')"),
      'should import state-machine or base-adapter'
    );
  });

  test('adapter has handleEvent function', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('function handleEvent'), 'should define handleEvent');
  });

  test('adapter handles item.created events', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'item.created'"), 'should handle item.created');
  });

  test('adapter handles item.completed events', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'item.completed'"), 'should handle item.completed');
  });

  test('adapter handles turn.completed events', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'turn.completed'"), 'should handle turn.completed');
  });

  test('adapter handles turn.failed events', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'turn.failed'"), 'should handle turn.failed');
  });

  test('adapter handles turn.started events', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'turn.started'"), 'should handle turn.started');
  });

  test('adapter tracks subagent sessions', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('activeSubagents'), 'should track subagents');
    assert.ok(src.includes('SUBAGENT_TOOLS'), 'should use SUBAGENT_TOOLS pattern');
  });

  test('adapter defaults model name to codex', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("|| 'codex'"), 'should default to codex');
  });
});

// -- codex-notify.js (structural tests) ------------------------------

describe('adapters -- codex-notify (structural)', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'codex-notify.js');

  test('adapter file exists', () => {
    assert.ok(fs.existsSync(ADAPTER), 'codex-notify.js should exist');
  });

  test('adapter file starts with use strict', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'use strict'"), 'should have use strict');
  });

  test('handles three event types', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'agent-turn-complete'"), 'should handle agent-turn-complete');
    assert.ok(src.includes("'approval-requested'"), 'should handle approval-requested');
  });

  test('guards global state file against other sessions', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(
      src.includes('shouldWriteGlobal') || src.includes('guardedWriteState'),
      'should guard global writes'
    );
  });
});

// -- normalisePiEvent logic (tested by exercising openclaw-adapter) ---

describe('adapters -- openclaw normalisePiEvent coverage', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'openclaw-adapter.js');

  // We already tested tool_call, tool_execution_start, tool_execution_end,
  // tool_result, session_end, turn_end, Stop, Notification above.
  // This section covers edge cases.

  test('unknown event type defaults to thinking', () => {
    const { tmp, stateFile, env } = makeTempEnv('norm-1');
    runStdinAdapter(ADAPTER, {
      event: 'some_future_event',
      session_id: 'norm-1',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'thinking');
    cleanup(tmp);
  });

  test('empty event string defaults to thinking', () => {
    const { tmp, stateFile, env } = makeTempEnv('norm-2');
    runStdinAdapter(ADAPTER, {
      event: '',
      session_id: 'norm-2',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'thinking');
    cleanup(tmp);
  });

  test('PreToolUse event passthrough works', () => {
    const { tmp, stateFile, env } = makeTempEnv('norm-3');
    runStdinAdapter(ADAPTER, {
      event: 'PreToolUse',
      toolName: 'WebFetch',
      input: {},
      session_id: 'norm-3',
    }, env);
    const state = readJSON(stateFile);
    // WebFetch should map to reading or searching depending on toolToState
    assert.ok(state.state !== 'error', 'should not be error');
    cleanup(tmp);
  });

  test('PostToolUse event passthrough works', () => {
    const { tmp, stateFile, env } = makeTempEnv('norm-4');
    runStdinAdapter(ADAPTER, {
      event: 'PostToolUse',
      toolName: 'Bash',
      input: { command: 'echo hello' },
      output: 'hello',
      session_id: 'norm-4',
    }, env);
    const state = readJSON(stateFile);
    assert.ok(
      ['happy', 'satisfied', 'proud', 'relieved'].includes(state.state),
      `expected completion state, got "${state.state}"`
    );
    cleanup(tmp);
  });

  test('malformed JSON input does not crash', () => {
    const { tmp, env } = makeTempEnv('norm-5');
    try {
      execFileSync(NODE, [ADAPTER], {
        input: 'not valid json at all',
        env,
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    // No crash is the assertion
    assert.ok(true, 'should not crash on malformed JSON');
    cleanup(tmp);
  });
});

// -- engmux-adapter.js (structural) ------------------------------------

describe('adapters -- engmux-adapter (structural)', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'engmux-adapter.js');

  test('adapter file exists', () => {
    assert.ok(fs.existsSync(ADAPTER));
  });

  test('adapter file starts with use strict', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'use strict'"));
  });

  test('adapter imports base-adapter writeSessionState', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("require('./base-adapter')"));
    assert.ok(src.includes('writeSessionState'));
  });

  test('adapter uses spawn for child process', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("require('child_process')"));
    assert.ok(src.includes('spawn'));
  });

  test('adapter cycles through SUB_STATES', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('SUB_STATES'));
    assert.ok(src.includes('thinking'));
    assert.ok(src.includes('coding'));
    assert.ok(src.includes('searching'));
  });

  test('adapter writes spawning state on start', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'spawning'"));
  });

  test('adapter writes happy on success and error on failure', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'happy'"));
    assert.ok(src.includes("'error'"));
  });

  test('adapter sets parentSession from env', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('PARENT_SESSION'));
    assert.ok(src.includes('parentSession'));
  });

  test('adapter extracts model name from -m flag', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('extractModel'));
    // Strips prefix like "opencode/"
    assert.ok(src.includes("replace(/^[^/]+\\//"));
  });

  test('adapter passes through engmux JSON stdout', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('process.stdout.write(stdout)'));
  });
});

// -- Bug fix regression tests -------------------------------------------

describe('bug fix regressions', () => {
  test('renderer.js has no duplicate const minimal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const matches = src.match(/const minimal\b/g) || [];
    assert.strictEqual(matches.length, 1, `Expected 1 "const minimal" but found ${matches.length}`);
  });

  test('face.js uses petSpamLevel not petCount in getEyes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'face.js'), 'utf8');
    assert.ok(!src.includes('this.petCount'), 'should not reference this.petCount');
    assert.ok(src.includes('this.petSpamLevel > 3'));
  });

  test('particles.js has TTY fallbacks for rows/columns', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'particles.js'), 'utf8');
    assert.ok(src.includes('process.stdout.rows || 24'));
    assert.ok(src.includes('process.stdout.columns || 80'));
  });

  test('grid.js verticalPadAbove uses dynamic accH when accessories active', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'grid.js'), 'utf8');
    assert.ok(src.includes('accessoriesActive ? (accH + 7)'));
  });

  test('grid.js connection exclusion uses mainTop - 8', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'grid.js'), 'utf8');
    assert.ok(src.includes('mainTop - 8'));
  });

  test('grid.js spawn scale starts at 0.3 minimum', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'grid.js'), 'utf8');
    assert.ok(src.includes('Math.max(0.3,'));
  });

  test('update-state.js rate-limits subagent cycling', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'update-state.js'), 'utf8');
    assert.ok(src.includes('lastCycleTime'));
    assert.ok(src.includes('now_cycle - lastCycle > 4000'));
  });

  test('renderer.js wraps face.render() in try-catch', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    // Should have try { out = face.render() } catch
    assert.ok(src.includes('out = face.render()'));
    const renderIdx = src.indexOf('out = face.render()');
    const preceding = src.slice(Math.max(0, renderIdx - 30), renderIdx);
    assert.ok(preceding.includes('try'), 'face.render() should be inside a try block');
  });

  test('update-state.js SessionStart writes idle (not waiting)', () => {
    // Bug: SessionStart was writing 'waiting', which the renderer degrades to
    // 'thinking' after IDLE_TIMEOUT because 'waiting' is not in the exclusion
    // list. 'idle' is in the exclusion list and is semantically correct.
    const { tmp, stateFile, env } = makeTempEnv('ss-idle-1');
    const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');
    try {
      execFileSync(NODE, [UPDATE_STATE, 'SessionStart'], {
        input: JSON.stringify({ session_id: 'ss-idle-1' }),
        env,
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'idle',
      `SessionStart should write 'idle', got '${state.state}'`);
    cleanup(tmp);
  });

  test('update-state.js has no PreToolUse synthetic subagent session block', () => {
    // Bug: PreToolUse + SubagentStart both created orbital sessions, causing
    // duplicate faces. The PreToolUse block was the old workaround before
    // SubagentStart/SubagentStop hooks existed — it's been removed.
    const src = fs.readFileSync(path.join(__dirname, '..', 'update-state.js'), 'utf8');
    assert.ok(!src.includes('isSubagentTool'),
      'isSubagentTool variable should be gone (PreToolUse synthetic session block removed)');
    assert.ok(!src.includes("'PreToolUse' && isSubagentTool"),
      'PreToolUse isSubagentTool branch should not exist');
  });

  test('update-state.js fallback catch block respects subagent isolation', () => {
    // Bug #69: The fallback catch block (for Stop/Notification with empty stdin)
    // set fallbackSessionId = existing.sessionId, then compared them — always equal.
    // A subagent Stop with empty stdin would overwrite the main session's global state.
    const { tmp, stateFile, env } = makeTempEnv('sub-iso-1');
    const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');

    // Pre-seed the global state file with an active main session
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'coding', detail: 'editing file',
      sessionId: 'main-session-abc', stopped: false,
      timestamp: Date.now(),
    }), 'utf8');

    // Run a Stop event with non-JSON stdin so it hits the catch block.
    // Use a different session ID (from env) than what's in the state file.
    const subEnv = { ...env, CLAUDE_SESSION_ID: 'sub-iso-1' };
    try {
      execFileSync(NODE, [UPDATE_STATE, 'Stop'], {
        input: 'not valid json',
        env: subEnv,
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }

    // The global state file should still belong to the main session —
    // the subagent's Stop should NOT have overwritten it.
    const state = readJSON(stateFile);
    assert.strictEqual(state.sessionId, 'main-session-abc',
      `global state should still belong to main session, got '${state.sessionId}'`);
    assert.strictEqual(state.state, 'coding',
      `global state should still be 'coding', got '${state.state}'`);
    cleanup(tmp);
  });

  test('update-state.js fallback catch block writes global when session matches', () => {
    // Complementary test: when the fallback session ID matches the existing file,
    // it SHOULD write to the global state file.
    const { tmp, stateFile, env } = makeTempEnv('fallback-match-1');
    const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');

    // Pre-seed with same session ID as the env will provide
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'thinking', detail: '',
      sessionId: 'fallback-match-1', stopped: false,
      timestamp: Date.now(),
    }), 'utf8');

    try {
      execFileSync(NODE, [UPDATE_STATE, 'Stop'], {
        input: 'not valid json',
        env,
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }

    // The global state should have been updated to 'responding' (Stop event)
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'responding',
      `global state should be 'responding' after Stop, got '${state.state}'`);
    cleanup(tmp);
  });

  test('update-state.js has no state-mirroring block for orbital faces', () => {
    // Bug: an else-if block mirrored every parent tool call's state directly
    // into the latest subagent session file, making orbital faces flicker
    // and mirror the main face. Removed in favour of the time-based cycling.
    const src = fs.readFileSync(path.join(__dirname, '..', 'update-state.js'), 'utf8');
    assert.ok(!src.includes('latestSub'),
      'latestSub variable should be gone (state-mirroring block removed)');
    assert.ok(!src.includes('!isSubagentTool'),
      '!isSubagentTool guard should be gone (state-mirroring block removed)');
  });
});

module.exports = { passed: () => passed, failed: () => failed };
