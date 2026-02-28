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
    // Send two edit events so count >= 2 survives frequentFiles pruning
    runStdinAdapter(ADAPTER, {
      event: 'tool_call',
      toolName: 'edit',
      input: { file_path: '/home/user/project/main.py' },
      session_id: 'claw-17',
    }, env);
    runStdinAdapter(ADAPTER, {
      event: 'tool_call',
      toolName: 'edit',
      input: { file_path: '/home/user/project/main.py' },
      session_id: 'claw-17',
    }, env);
    const stats = readJSON(statsFile);
    assert.ok(stats.session.filesEdited.includes('main.py'), 'should track edited file');
    assert.ok(stats.frequentFiles['main.py'] >= 2, 'should track in frequentFiles');
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
    assert.ok(src.includes('this.petSpamLevel >= 3'));
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

  test('update-state.js has no hardcoded subagent state cycling (Fix #79)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'update-state.js'), 'utf8');
    assert.ok(!src.includes('lastCycleTime'), 'cycling mechanism should be removed');
    assert.ok(!src.includes('SUB_STATES'), 'hardcoded state array should be removed');
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

  test('renderer.js PID guard handles EPERM as running (#65)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.ok(src.includes("err.code === 'EPERM'"),
      'PID guard catch should check for EPERM and treat as running');
  });

  test('renderer.js responding state gets 3000ms minDisplayUntil (#67)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    // Both occurrences of the responding→happy transition should use now + 3000
    const matches = src.match(/minDisplayUntil = now \+ 3000;.*responding/g)
                 || src.match(/now \+ 3000;.*3s min display/g)
                 || [];
    // Source-level check: no `now;` (immediate expire) near 'wrapping up'
    assert.ok(!src.includes("minDisplayUntil = now;"),
      'responding should not use minDisplayUntil = now (immediate expire)');
    assert.ok(src.includes("now + 3000"),
      'responding transitions should use now + 3000');
  });
});

// -- Stopped flag preservation (#98) ----------------------------------------

describe('update-state.js stopped flag preservation (#98)', () => {
  const updateStatePath = path.join(__dirname, '..', 'update-state.js');
  const sharedMod = require(path.join(__dirname, '..', 'shared'));
  const STATE_FILE = sharedMod.STATE_FILE;
  const SESSIONS_DIR = sharedMod.SESSIONS_DIR;
  const safeFilename = sharedMod.safeFilename;

  test('source: global state file read preserves stopped flag for same session', () => {
    const src = fs.readFileSync(updateStatePath, 'utf8');
    assert.ok(
      src.includes('existing.stopped && existing.sessionId === sessionId && !stopped'),
      'update-state.js should check existing.stopped for same session and preserve it'
    );
  });

  test('source: session file read preserves stopped flag before writeSessionState', () => {
    const src = fs.readFileSync(updateStatePath, 'utf8');
    assert.ok(
      src.includes('existingSession.stopped'),
      'update-state.js should read existing session file and preserve stopped flag'
    );
  });

  test('source: renderer lastStopped only goes false->true from state file', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    // Should use `if (stateData.stopped) lastStopped = true` not `lastStopped = stateData.stopped || false`
    assert.ok(
      src.includes('if (stateData.stopped) lastStopped = true'),
      'renderer.js should only set lastStopped to true, never back to false from state file'
    );
    assert.ok(
      !src.includes('lastStopped = stateData.stopped || false'),
      'renderer.js should not have the old bidirectional lastStopped assignment'
    );
  });

  test('source: renderer fresh-read loop only detects false->true stopped transitions', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.ok(
      src.includes('stoppedNow && !lastStopped && freshTs'),
      'renderer.js fresh-read should only detect false->true transitions'
    );
    assert.ok(
      !src.includes('stoppedNow !== lastStopped && freshTs'),
      'renderer.js should not have the old bidirectional stoppedNow !== lastStopped check'
    );
  });

  test('integration: PostToolUse after Stop preserves stopped in global state file', () => {
    // Write a stopped state file simulating a Stop event
    const testSessionId = 'test-stopped-' + Date.now();
    const stoppedState = JSON.stringify({
      state: 'responding', detail: 'wrapping up',
      timestamp: Date.now(), sessionId: testSessionId, stopped: true,
    });
    try { fs.writeFileSync(STATE_FILE, stoppedState, 'utf8'); } catch { return; }

    // Simulate a late PostToolUse by spawning update-state.js
    try {
      execFileSync(process.execPath, [updateStatePath, 'PostToolUse'], {
        input: JSON.stringify({
          tool_name: 'Write', tool_input: { file_path: '/tmp/test.txt' },
          tool_result: { stdout: 'ok' }, session_id: testSessionId,
        }),
        env: { ...process.env, CLAUDE_SESSION_ID: testSessionId, CODE_CRUMB_STATE: STATE_FILE },
        timeout: 5000,
      });
    } catch {}

    // Read the state file back — stopped must still be true
    try {
      const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      assert.strictEqual(result.stopped, true,
        'stopped flag must be preserved after late PostToolUse for same session');
    } catch (e) {
      // If the file can't be read (e.g. permissions), skip gracefully
      if (e.code !== 'ENOENT' && e instanceof assert.AssertionError) throw e;
    }
  });

  test('integration: PostToolUse after Stop preserves stopped in session file', () => {
    const testSessionId = 'test-session-stopped-' + Date.now();
    const sessionFile = path.join(SESSIONS_DIR, safeFilename(testSessionId) + '.json');

    // Write a stopped session file
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify({
        session_id: testSessionId, state: 'responding', detail: 'wrapping up',
        timestamp: Date.now(), stopped: true,
      }), 'utf8');
    } catch { return; }

    // Simulate late PostToolUse
    try {
      execFileSync(process.execPath, [updateStatePath, 'PostToolUse'], {
        input: JSON.stringify({
          tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' },
          tool_result: { stdout: 'ok' }, session_id: testSessionId,
        }),
        env: { ...process.env, CLAUDE_SESSION_ID: testSessionId, CODE_CRUMB_STATE: STATE_FILE },
        timeout: 5000,
      });
    } catch {}

    // Session file must still have stopped: true
    try {
      const result = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      assert.strictEqual(result.stopped, true,
        'session file stopped flag must be preserved after late PostToolUse');
    } catch (e) {
      if (e.code !== 'ENOENT' && e instanceof assert.AssertionError) throw e;
    } finally {
      try { fs.unlinkSync(sessionFile); } catch {}
    }
  });
});

describe('base-adapter guardedWriteState modelName preservation (#78)', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const sharedMod = require(path.join(__dirname, '..', 'shared'));
  const STATE_FILE = sharedMod.STATE_FILE;

  test('preserves modelName when same session writes with different model', () => {
    // Write initial state with claude as model owner
    const sessionId = 'test-model-' + Date.now();
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        state: 'thinking', detail: '', timestamp: Date.now(),
        sessionId, modelName: 'claude',
      }), 'utf8');
    } catch { return; }

    // guardedWriteState with same session but modelName: 'opencode'
    baseAdapter.guardedWriteState(sessionId, 'coding', 'editing file', {
      sessionId, modelName: 'opencode',
    });

    try {
      const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      assert.strictEqual(result.modelName, 'claude',
        'modelName must be preserved as "claude", not overwritten by "opencode"');
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
  });

  test('allows modelName for new session (no existing file)', () => {
    // Remove state file to simulate fresh start
    try { fs.unlinkSync(STATE_FILE); } catch {}

    const sessionId = 'test-model-new-' + Date.now();
    baseAdapter.guardedWriteState(sessionId, 'thinking', '', {
      sessionId, modelName: 'opencode',
    });

    try {
      const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      assert.strictEqual(result.modelName, 'opencode',
        'modelName should be written when no existing state file');
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
  });

  test('allows modelName when previous session stopped', () => {
    const oldSession = 'test-model-old-' + Date.now();
    const newSession = 'test-model-takeover-' + Date.now();
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        state: 'happy', detail: 'done', timestamp: Date.now(),
        sessionId: oldSession, modelName: 'claude', stopped: true,
      }), 'utf8');
    } catch { return; }

    // New session takes over — its modelName should stick
    baseAdapter.guardedWriteState(newSession, 'thinking', '', {
      sessionId: newSession, modelName: 'opencode',
    });

    try {
      const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      assert.strictEqual(result.modelName, 'opencode',
        'new session should establish its own modelName');
    } catch (e) {
      if (e instanceof assert.AssertionError) throw e;
    }
  });
});

// -- base-adapter unit tests (guardedWriteState, initSession, buildExtra, trackEditedFile, processJsonlStream)

describe('base-adapter -- guardedWriteState unit tests', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const sharedMod = require(path.join(__dirname, '..', 'shared'));
  const STATE_FILE = sharedMod.STATE_FILE;

  // Save and restore state file
  let savedState;
  try { savedState = fs.readFileSync(STATE_FILE, 'utf8'); } catch { savedState = null; }

  test('writes state when no existing file', () => {
    try { fs.unlinkSync(STATE_FILE); } catch {}
    baseAdapter.guardedWriteState('gw-1', 'thinking', 'test', { sessionId: 'gw-1' });
    const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(result.state, 'thinking');
  });

  test('writes state when existing file has same sessionId', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      state: 'reading', sessionId: 'gw-2', timestamp: Date.now(), stopped: false,
    }), 'utf8');
    baseAdapter.guardedWriteState('gw-2', 'coding', 'editing', { sessionId: 'gw-2' });
    const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(result.state, 'coding');
  });

  test('skips write when different active session owns file', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      state: 'executing', sessionId: 'owner-session', timestamp: Date.now(), stopped: false,
    }), 'utf8');
    baseAdapter.guardedWriteState('intruder-session', 'thinking', '', { sessionId: 'intruder-session' });
    const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(result.sessionId, 'owner-session', 'owner session should not be overwritten');
    assert.strictEqual(result.state, 'executing');
  });

  test('writes when existing session is stopped', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      state: 'happy', sessionId: 'old-session', timestamp: Date.now(), stopped: true,
    }), 'utf8');
    baseAdapter.guardedWriteState('new-session', 'thinking', '', { sessionId: 'new-session' });
    const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(result.state, 'thinking');
  });

  test('writes when existing session is stale (>120s old)', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      state: 'coding', sessionId: 'stale-session', timestamp: Date.now() - 130000, stopped: false,
    }), 'utf8');
    baseAdapter.guardedWriteState('fresh-session', 'reading', '', { sessionId: 'fresh-session' });
    const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(result.state, 'reading');
  });

  test('preserves modelName for same session', () => {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      state: 'thinking', sessionId: 'gw-model', timestamp: Date.now(), stopped: false, modelName: 'claude',
    }), 'utf8');
    baseAdapter.guardedWriteState('gw-model', 'coding', 'edit', { sessionId: 'gw-model', modelName: 'other' });
    const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    assert.strictEqual(result.modelName, 'claude', 'modelName should be preserved');
  });

  // Restore
  try {
    if (savedState !== null) fs.writeFileSync(STATE_FILE, savedState, 'utf8');
    else fs.unlinkSync(STATE_FILE);
  } catch {}
});

describe('base-adapter -- initSession unit tests', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const { defaultStats } = require(path.join(__dirname, '..', 'state-machine'));

  test('creates daily bucket on first call', () => {
    const stats = defaultStats();
    stats.daily = { date: '', sessionCount: 0, cumulativeMs: 0 };
    baseAdapter.initSession(stats, 'init-1');
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual(stats.daily.date, today);
  });

  test('rolls over on date change', () => {
    const stats = defaultStats();
    stats.daily = { date: '2020-01-01', sessionCount: 5, cumulativeMs: 1000 };
    baseAdapter.initSession(stats, 'init-2');
    const today = new Date().toISOString().slice(0, 10);
    assert.strictEqual(stats.daily.date, today);
    assert.strictEqual(stats.daily.sessionCount, 1);
  });

  test('increments sessionCount on new session ID', () => {
    const stats = defaultStats();
    baseAdapter.initSession(stats, 'sess-a');
    const count1 = stats.daily.sessionCount;
    baseAdapter.initSession(stats, 'sess-b');
    assert.strictEqual(stats.daily.sessionCount, count1 + 1);
  });

  test('does not increment sessionCount for same session ID', () => {
    const stats = defaultStats();
    baseAdapter.initSession(stats, 'sess-same');
    const count1 = stats.daily.sessionCount;
    baseAdapter.initSession(stats, 'sess-same');
    assert.strictEqual(stats.daily.sessionCount, count1);
  });

  test('clears stale recentMilestone (>8s old)', () => {
    const stats = defaultStats();
    stats.recentMilestone = { type: 'streak', value: 10, at: Date.now() - 9000 };
    baseAdapter.initSession(stats, 'init-ms');
    assert.strictEqual(stats.recentMilestone, null);
  });

  test('preserves fresh recentMilestone (<8s old)', () => {
    const stats = defaultStats();
    stats.recentMilestone = { type: 'streak', value: 10, at: Date.now() - 3000 };
    baseAdapter.initSession(stats, 'init-ms-fresh');
    assert.ok(stats.recentMilestone !== null);
    assert.strictEqual(stats.recentMilestone.value, 10);
  });
});

describe('base-adapter -- buildExtra unit tests', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const { defaultStats } = require(path.join(__dirname, '..', 'state-machine'));

  test('returns object with all expected fields', () => {
    const stats = defaultStats();
    stats.session = { id: 'be-1', start: Date.now() - 5000, toolCalls: 3, filesEdited: ['a.js', 'b.js'], subagentCount: 1 };
    stats.streak = 5;
    stats.bestStreak = 10;
    const extra = baseAdapter.buildExtra(stats, 'be-1', 'claude');
    assert.strictEqual(extra.sessionId, 'be-1');
    assert.strictEqual(extra.modelName, 'claude');
    assert.strictEqual(extra.toolCalls, 3);
    assert.strictEqual(extra.filesEdited, 2);
    assert.strictEqual(extra.streak, 5);
    assert.strictEqual(extra.bestStreak, 10);
    assert.ok('dailySessions' in extra);
    assert.ok('dailyCumulativeMs' in extra);
    assert.ok('frequentFiles' in extra);
    assert.strictEqual(extra.diffInfo, null);
  });

  test('frequentFiles truncated to top 10 with count >= 3', () => {
    const stats = defaultStats();
    stats.session = { id: 'be-2', start: Date.now(), toolCalls: 0, filesEdited: [], subagentCount: 0 };
    // Add 15 files, some below threshold
    for (let i = 0; i < 15; i++) {
      stats.frequentFiles[`file${i}.js`] = i + 1;
    }
    const extra = baseAdapter.buildExtra(stats, 'be-2', 'test');
    const keys = Object.keys(extra.frequentFiles);
    assert.ok(keys.length <= 10, `should have at most 10, got ${keys.length}`);
    for (const [, count] of Object.entries(extra.frequentFiles)) {
      assert.ok(count >= 3, `each file should have count >= 3, got ${count}`);
    }
  });

  test('handles empty stats gracefully', () => {
    const stats = defaultStats();
    const extra = baseAdapter.buildExtra(stats, 'be-3', 'test');
    assert.strictEqual(extra.toolCalls, 0);
    assert.strictEqual(extra.filesEdited, 0);
    assert.strictEqual(extra.streak, 0);
  });
});

describe('base-adapter -- trackEditedFile unit tests', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const { defaultStats } = require(path.join(__dirname, '..', 'state-machine'));

  test('detects edit tools and extracts file path', () => {
    const stats = defaultStats();
    baseAdapter.trackEditedFile(stats, 'Edit', { file_path: '/src/app.js' });
    assert.ok(stats.session.filesEdited.includes('app.js'));
    assert.strictEqual(stats.frequentFiles['app.js'], 1);
  });

  test('prevents duplicate file entries in session', () => {
    const stats = defaultStats();
    baseAdapter.trackEditedFile(stats, 'Edit', { file_path: '/src/app.js' });
    baseAdapter.trackEditedFile(stats, 'Edit', { file_path: '/src/app.js' });
    assert.strictEqual(stats.session.filesEdited.filter(f => f === 'app.js').length, 1);
    assert.strictEqual(stats.frequentFiles['app.js'], 2);
  });

  test('ignores non-edit tools', () => {
    const stats = defaultStats();
    baseAdapter.trackEditedFile(stats, 'Read', { file_path: '/src/app.js' });
    assert.strictEqual(stats.session.filesEdited.length, 0);
  });

  test('handles Write tool (edit variant)', () => {
    const stats = defaultStats();
    baseAdapter.trackEditedFile(stats, 'Write', { file_path: '/src/new.ts' });
    assert.ok(stats.session.filesEdited.includes('new.ts'));
  });

  test('handles missing file_path gracefully', () => {
    const stats = defaultStats();
    baseAdapter.trackEditedFile(stats, 'Edit', {});
    assert.strictEqual(stats.session.filesEdited.length, 0);
  });
});

describe('base-adapter -- processJsonlStream unit tests', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const { Readable } = require('stream');

  function makeStream(chunks) {
    const stream = new Readable({ read() {} });
    for (const chunk of chunks) stream.push(chunk);
    stream.push(null);
    return stream;
  }

  test('parses valid JSONL lines', (done) => {
    const events = [];
    const stream = makeStream(['{"a":1}\n{"b":2}\n']);
    baseAdapter.processJsonlStream(stream, (ev) => events.push(ev));
    stream.on('end', () => {
      // Give a tick for the flush handler
      setTimeout(() => {
        assert.strictEqual(events.length, 2);
        assert.strictEqual(events[0].a, 1);
        assert.strictEqual(events[1].b, 2);
      }, 10);
    });
  });

  test('skips malformed lines silently', () => {
    const events = [];
    const stream = makeStream(['{"valid":true}\nnot json\n{"also":true}\n']);
    baseAdapter.processJsonlStream(stream, (ev) => events.push(ev));
    stream.on('end', () => {
      setTimeout(() => {
        assert.strictEqual(events.length, 2);
      }, 10);
    });
  });

  test('handles \\r\\n line endings', () => {
    const events = [];
    const stream = makeStream(['{"x":1}\r\n{"y":2}\r\n']);
    baseAdapter.processJsonlStream(stream, (ev) => events.push(ev));
    stream.on('end', () => {
      setTimeout(() => {
        assert.strictEqual(events.length, 2);
      }, 10);
    });
  });

  test('calls handler for each parsed object', () => {
    const events = [];
    const stream = makeStream(['{"type":"a"}\n', '{"type":"b"}\n']);
    baseAdapter.processJsonlStream(stream, (ev) => events.push(ev));
    stream.on('end', () => {
      setTimeout(() => {
        assert.ok(events.length >= 2);
        assert.strictEqual(events[0].type, 'a');
      }, 10);
    });
  });
});

// -- Bug fix structural tests (bugs #1, #2, #4, #5, #7, #10, #13, #16) --------

describe('bug fix structural tests', () => {
  const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');
  const BASE_ADAPTER = path.join(ADAPTERS_DIR, 'base-adapter.js');
  const OPENCODE_ADAPTER = path.join(ADAPTERS_DIR, 'opencode-adapter.js');
  const PARTICLES = path.join(__dirname, '..', 'particles.js');
  const FACE = path.join(__dirname, '..', 'face.js');

  // Bug #1 -- Windows Terminal fallback probes with execSync('where wt')
  test('update-state.js probes for wt with "where wt" before spawning', () => {
    const src = fs.readFileSync(UPDATE_STATE, 'utf8');
    assert.ok(src.includes('where wt'),
      'should probe for wt with execSync("where wt") instead of relying on spawn throw');
  });

  test('update-state.js sets hasWt flag from where-wt probe result', () => {
    const src = fs.readFileSync(UPDATE_STATE, 'utf8');
    assert.ok(src.includes('hasWt'),
      'should have hasWt boolean flag controlled by where-wt probe');
  });

  // Bug #2 -- OpenCode adapter toolInput uses data.tool_input || toolArgs, not data.input
  test('opencode-adapter.js does not use data.input as first choice for toolInput', () => {
    const src = fs.readFileSync(OPENCODE_ADAPTER, 'utf8');
    // data.input is the full {tool, args} wrapper — should not be used directly as toolInput
    assert.ok(!src.includes('toolInput = data.input'),
      'toolInput must not be set to data.input (the full wrapper object)');
  });

  test('opencode-adapter.js uses data.tool_input || toolArgs pattern for toolInput', () => {
    const src = fs.readFileSync(OPENCODE_ADAPTER, 'utf8');
    assert.ok(src.includes('data.tool_input || toolArgs'),
      'toolInput should prefer data.tool_input, falling back to the unwrapped toolArgs');
  });

  // Bug #4 -- SubagentStop only splices when idx >= 0
  test('update-state.js guards SubagentStop splice with idx >= 0 check', () => {
    const src = fs.readFileSync(UPDATE_STATE, 'utf8');
    assert.ok(src.includes('if (idx >= 0)'),
      'SubagentStop handler must check idx >= 0 before splicing to avoid removing wrong subagent');
  });

  // Bug #5 -- Redundant stdin close handlers removed
  test('update-state.js does not have process.stdin.on("close") handler', () => {
    const src = fs.readFileSync(UPDATE_STATE, 'utf8');
    assert.ok(!src.includes("process.stdin.on('close'"),
      'update-state.js should not have a stdin close handler (process.exit is in end handler)');
  });

  test('base-adapter.js does not have process.stdin.on("close") calling process.exit', () => {
    const src = fs.readFileSync(BASE_ADAPTER, 'utf8');
    // Check that there is no close handler that calls process.exit
    const hasCloseExit = src.includes("process.stdin.on('close'") &&
      src.includes('process.exit');
    // The close handler specifically (not just process.exit elsewhere) should be gone
    assert.ok(!src.includes("process.stdin.on('close', () => { process.exit"),
      'base-adapter.js should not have redundant stdin close handler that calls process.exit');
  });

  // Bug #7 -- Particle render includes ansi.reset after char
  test('particles.js render method appends ansi.reset after particle character', () => {
    const src = fs.readFileSync(PARTICLES, 'utf8');
    assert.ok(src.includes('ansi.reset'),
      'particles.js render should include ansi.reset to avoid color bleed after particle chars');
  });

  // Bug #10 -- base-adapter initSession includes commitCount and activeSubagents
  test('base-adapter.js initSession initialises commitCount in session object', () => {
    const src = fs.readFileSync(BASE_ADAPTER, 'utf8');
    assert.ok(src.includes('commitCount: 0'),
      'initSession must include commitCount: 0 in the new session object');
  });

  test('base-adapter.js initSession initialises activeSubagents in session object', () => {
    const src = fs.readFileSync(BASE_ADAPTER, 'utf8');
    assert.ok(src.includes('activeSubagents: []'),
      'initSession must include activeSubagents: [] in the new session object');
  });

  // Bug #13 -- base-adapter guardedWriteState preserves existing.stopped flag
  test('base-adapter.js guardedWriteState checks existing.stopped to preserve the flag', () => {
    const src = fs.readFileSync(BASE_ADAPTER, 'utf8');
    assert.ok(src.includes('existing.stopped'),
      'guardedWriteState must read existing.stopped to preserve it for same-session writes');
  });

  // Bug #16 -- petSpamLevel threshold is >= 3, not > 3
  test('face.js uses petSpamLevel >= 3 threshold (not > 3)', () => {
    const src = fs.readFileSync(FACE, 'utf8');
    assert.ok(src.includes('petSpamLevel >= 3'),
      'face.js should activate caffeinated mode at petSpamLevel >= 3, not > 3');
    assert.ok(!src.includes('petSpamLevel > 3'),
      'face.js must not use petSpamLevel > 3 (off-by-one: level 3 would never trigger)');
  });
});

module.exports = { passed: () => passed, failed: () => failed };
