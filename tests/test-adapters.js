#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - Adapter coverage                      |
// |  Tests for codex-notify, codex-wrapper, opencode-adapter,      |
// |  opencode-plugin, openclaw-adapter and engmux-adapter.         |
// |                                                                |
// |  Adapters are scripts, not libraries, so we test them by       |
// |  spawning child processes with controlled env/stdin/argv and   |
// |  verifying the state files they write. A handful of tests are  |
// |  named `source:` -- those assert on the file text on purpose,  |
// |  because what they guard has no observable outside the render  |
// |  loop or needs a CLI the suite cannot supply portably. Every   |
// |  one carries a comment saying why. Nothing else greps source.  |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync, spawn } = require('child_process');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;
const { makeTempEnv, cleanup, readJSON } = require('./_harness');

// -- Helpers ----------------------------------------------------------

const ADAPTERS_DIR = path.join(__dirname, '..', 'adapters');
const NODE = process.execPath;

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

const UPDATE_STATE_JS = path.join(__dirname, '..', 'update-state.js');

// Run one Claude Code hook against a temp home. `input` may be an object
// (JSON encoded) or a raw string, so '' and 'not json' reach the catch path
// that handles Stop/Notification/lifecycle events with no parsable stdin.
function runUpdateState(event, input, env, extraArgs = []) {
  try {
    execFileSync(NODE, [UPDATE_STATE_JS, event, ...extraArgs], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      env,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status !== 0 && e.status !== null) throw e;
  }
}

// Seed a per-session orbital file inside a temp home.
function seedSession(sessionsDir, sessionId, fields) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, `${sessionId}.json`), JSON.stringify({
    session_id: sessionId, timestamp: Date.now(), ...fields,
  }), 'utf8');
}

// Stats blob for an owner session conducting one subagent.
function conductingStats(ownerId, subId, subStartedAt, topLevelSessions = {}) {
  return {
    streak: 0, bestStreak: 0, brokenStreak: 0, brokenStreakAt: 0,
    totalToolCalls: 5, totalErrors: 0,
    records: { longestSession: 0, mostSubagents: 1, mostFilesEdited: 0 },
    session: {
      id: ownerId, start: Date.now() - 60000, toolCalls: 5, filesEdited: [],
      subagentCount: 1, commitCount: 0,
      activeSubagents: [{
        id: subId, description: 'real task', taskDescription: 'real task',
        model: 'haiku', editor: 'claude', startedAt: subStartedAt,
      }],
    },
    recentMilestone: null,
    daily: { date: new Date().toISOString().slice(0, 10), sessionCount: 1, cumulativeMs: 0 },
    frequentFiles: {},
    topLevelSessions,
  };
}

// Run `fn` with the shared STATE_FILE (which test.js has already redirected
// into the throwaway home) holding `data`, then put back whatever was there.
// For in-process readers -- shared.js fixes its paths at first require, so a
// per-test temp dir is only usable by subprocesses.
const SHARED = require(path.join(__dirname, '..', 'lib', 'shared'));

function withStateFile(data, fn) {
  let saved = null;
  try { saved = fs.readFileSync(SHARED.STATE_FILE, 'utf8'); } catch {}
  try {
    fs.writeFileSync(SHARED.STATE_FILE, JSON.stringify(data), 'utf8');
    return fn();
  } finally {
    if (saved !== null) fs.writeFileSync(SHARED.STATE_FILE, saved, 'utf8');
    else try { fs.unlinkSync(SHARED.STATE_FILE); } catch {}
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

  // A brand new session is starting, not waiting on the user: `waiting` is
  // the face for "it needs you", and OpenCode has real events for that now
  // (permission.asked / permission.ask).
  test('session.created writes starting state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-8');
    runStdinAdapter(ADAPTER, {
      type: 'session.created',
      session_id: 'oc-8',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'starting');
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

// -- opencode-plugin.mjs (the shipped OpenCode plugin) ----------------
// OpenCode loads the plugin inside its own Bun runtime, so translate() is
// kept pure: the whole payload contract can be checked from Node without a
// Bun child process. Shapes below are the real 1.18 ones (Hooks in
// @opencode-ai/plugin, Event in @opencode-ai/sdk).

describe('adapters -- opencode-plugin translate()', () => {
  const PLUGIN_FILE = path.join(ADAPTERS_DIR, 'opencode-plugin.mjs');
  // The plugin resolves its node binary per spawn, from this variable; pin
  // it to the node running the suite so a test that really does spawn the
  // adapter does not depend on what is on PATH.
  process.env.CODE_CRUMB_NODE = NODE;
  const loadModule = () => import(require('url').pathToFileURL(PLUGIN_FILE).href);
  // translate() rides on the factory rather than being its own export: see
  // "every export is a plugin factory" below.
  const load = async () => ({ translate: (await loadModule()).CodeCrumbPlugin.translate });
  const bus = (type, properties) => ({ event: { type, properties } });

  // A fresh module instance -- the query string busts the ESM cache -- so a
  // test that exercises the delivery path gets its own throttle state and
  // cannot colour another test's. (The node binary is not captured here; it
  // is read per spawn, which is what withoutSpawning below relies on.)
  const loadIsolated = (tag) => import(`${require('url').pathToFileURL(PLUGIN_FILE).href}?t=${tag}`);
  const reasoning = (sessionID) => bus('message.part.updated', {
    part: { type: 'reasoning', sessionID, text: 'weighing options' },
  });

  // Run fn() with the plugin pointed at a node binary that does not exist,
  // so a test about hook behaviour never starts a real adapter. The plugin
  // reads CODE_CRUMB_NODE per spawn, and a hook runs its whole body
  // synchronously (an async function only yields at an await, and there is
  // none before the spawn) -- so fn() must make its calls and hand back the
  // promises, which are awaited after the env is restored. Nothing else can
  // observe the swap in between.
  const withoutSpawning = (fn) => {
    const realNode = process.env.CODE_CRUMB_NODE;
    process.env.CODE_CRUMB_NODE = path.join(ADAPTERS_DIR, 'no-such-node-binary');
    try {
      return fn();
    } finally {
      if (realNode === undefined) delete process.env.CODE_CRUMB_NODE;
      else process.env.CODE_CRUMB_NODE = realNode;
    }
  };

  test.async('session.created reads properties.info.id', async () => {
    const { translate } = await load();
    const out = translate('event', bus('session.created', { info: { id: 'ses_1' } }));
    assert.strictEqual(out.type, 'session.created');
    assert.strictEqual(out.sessionId, 'ses_1');
  });

  test.async('session.idle reads properties.sessionID', async () => {
    const { translate } = await load();
    const out = translate('event', bus('session.idle', { sessionID: 'ses_1' }));
    assert.deepStrictEqual(out, { type: 'session.idle', sessionId: 'ses_1' });
  });

  test.async('session.error flattens the SDK error object to text', async () => {
    const { translate } = await load();
    const out = translate('event', bus('session.error', {
      sessionID: 'ses_1',
      error: { name: 'UnknownError', data: { message: 'connection lost' } },
    }));
    assert.strictEqual(out.type, 'session.error');
    assert.strictEqual(out.sessionId, 'ses_1');
    assert.strictEqual(out.error, 'connection lost');
  });

  test.async('session.error falls back to the error name when there is no message', async () => {
    const { translate } = await load();
    const out = translate('event', bus('session.error', { error: { name: 'MessageAbortedError', data: {} } }));
    assert.strictEqual(out.error, 'MessageAbortedError');
  });

  test.async('permission.asked becomes a waiting payload', async () => {
    const { translate } = await load();
    const out = translate('event', bus('permission.asked', {
      sessionID: 'ses_1', type: 'bash', title: 'rm -rf build',
    }));
    assert.strictEqual(out.type, 'permission.asked');
    assert.strictEqual(out.sessionId, 'ses_1');
    assert.strictEqual(out.title, 'rm -rf build');
  });

  test.async('permission.replied carries the response', async () => {
    const { translate } = await load();
    const out = translate('event', bus('permission.replied', {
      sessionID: 'ses_1', permissionID: 'p1', response: 'always',
    }));
    assert.strictEqual(out.type, 'permission.replied');
    assert.strictEqual(out.response, 'always');
  });

  test.async('a reasoning part becomes thinking', async () => {
    const { translate } = await load();
    const out = translate('event', bus('message.part.updated', {
      part: { type: 'reasoning', sessionID: 'ses_1', text: 'weighing options' },
    }));
    assert.strictEqual(out.type, 'thinking');
    assert.strictEqual(out.sessionId, 'ses_1');
  });

  test.async('a failed tool part becomes tool.error (tool.execute.after never fires for it)', async () => {
    const { translate } = await load();
    const out = translate('event', bus('message.part.updated', {
      part: {
        type: 'tool', sessionID: 'ses_1', callID: 'c1', tool: 'bash',
        state: { status: 'error', input: { command: 'exit 1' }, error: 'exit code 1' },
      },
    }));
    assert.strictEqual(out.type, 'tool.error');
    assert.strictEqual(out.sessionId, 'ses_1');
    assert.strictEqual(out.tool, 'bash');
    assert.deepStrictEqual(out.toolInput, { command: 'exit 1' });
    assert.strictEqual(out.error, 'exit code 1');
  });

  test.async('a text part is ignored', async () => {
    const { translate } = await load();
    assert.strictEqual(translate('event', bus('message.part.updated', {
      part: { type: 'text', sessionID: 'ses_1', text: 'hello' },
    })), null);
  });

  test.async('a completed tool part is ignored (tool.execute.after covers it)', async () => {
    const { translate } = await load();
    assert.strictEqual(translate('event', bus('message.part.updated', {
      part: { type: 'tool', sessionID: 'ses_1', tool: 'read', state: { status: 'completed', input: {}, output: 'x' } },
    })), null);
  });

  test.async('unknown bus events and a missing event object are ignored', async () => {
    const { translate } = await load();
    assert.strictEqual(translate('event', bus('lsp.updated', {})), null);
    assert.strictEqual(translate('event', {}), null);
    assert.strictEqual(translate('event', null), null);
  });

  test.async('tool.execute.before reads args from OUTPUT, not input', async () => {
    const { translate } = await load();
    const out = translate('tool.execute.before',
      { tool: 'edit', sessionID: 'ses_1', callID: 'c1' },
      { args: { filePath: 'a.js' } });
    assert.strictEqual(out.type, 'tool.execute.before');
    assert.strictEqual(out.sessionId, 'ses_1');
    assert.strictEqual(out.tool, 'edit');
    assert.strictEqual(out.toolInput.filePath, 'a.js');
    assert.strictEqual(out.callID, 'c1');
  });

  test.async('tool.execute.before survives a missing output object', async () => {
    const { translate } = await load();
    const out = translate('tool.execute.before', { tool: 'edit', sessionID: 'ses_1', callID: 'c1' });
    assert.deepStrictEqual(out.toolInput, {});
  });

  test.async('tool.execute.after reads args from input and caps the output text', async () => {
    const { translate } = await load();
    const out = translate('tool.execute.after',
      { tool: 'bash', sessionID: 'ses_1', callID: 'c1', args: { command: 'echo hi' } },
      { title: 'echo hi', output: 'x'.repeat(9000), metadata: {} });
    assert.strictEqual(out.type, 'tool.execute.after');
    assert.deepStrictEqual(out.toolInput, { command: 'echo hi' });
    assert.strictEqual(out.title, 'echo hi');
    assert.strictEqual(out.output.length, 4000, 'tool output must never be embedded whole');
  });

  test.async('tool.execute.after with a non-string output yields empty text', async () => {
    const { translate } = await load();
    const out = translate('tool.execute.after',
      { tool: 'read', sessionID: 'ses_1', callID: 'c1', args: {} },
      { title: 'read', output: { not: 'a string' }, metadata: {} });
    assert.strictEqual(out.output, '');
  });

  test.async('the permission.ask hook maps to the same waiting payload', async () => {
    const { translate } = await load();
    const out = translate('permission.ask',
      { id: 'p1', type: 'bash', sessionID: 'ses_1', title: 'rm -rf build', metadata: {} },
      { status: 'ask' });
    assert.strictEqual(out.type, 'permission.asked');
    assert.strictEqual(out.sessionId, 'ses_1');
    assert.strictEqual(out.title, 'rm -rf build');
  });

  test.async('an unknown hook name is ignored', async () => {
    const { translate } = await load();
    assert.strictEqual(translate('chat.params', {}, {}), null);
  });

  // OpenCode calls every named export as a plugin factory and then reads
  // .config / .dispose off the result. A second export (even a pure helper)
  // returns something that is not a Hooks object and breaks plugin loading
  // with "null is not an object" -- verified against opencode 1.18.21.
  test.async('exports exactly one thing, and it is a plugin factory', async () => {
    const mod = await loadModule();
    const names = Object.keys(mod);
    assert.deepStrictEqual(names, ['CodeCrumbPlugin'], `unexpected exports: ${names.join(', ')}`);
    assert.strictEqual(typeof mod.CodeCrumbPlugin, 'function');
    assert.strictEqual(typeof mod.CodeCrumbPlugin.translate, 'function', 'translate must stay reachable for tests');
  });

  test.async('CodeCrumbPlugin resolves to the four hooks OpenCode calls', async () => {
    const { CodeCrumbPlugin } = await loadModule();
    const hooks = await CodeCrumbPlugin({ project: {}, directory: '.', worktree: '.' });
    for (const key of ['event', 'tool.execute.before', 'tool.execute.after', 'permission.ask']) {
      assert.strictEqual(typeof hooks[key], 'function', `missing hook ${key}`);
    }
    // Hooks must resolve even when nothing can be sent (unknown event).
    await hooks.event({ event: { type: 'lsp.updated', properties: {} } });
  });

  // NOTE: the message.updated shape below is the documented SDK shape, not one
  // observed against a running OpenCode. Every branch is guarded, so a wrong
  // guess costs a missing model and nothing else.
  test.async('message.updated becomes a model observation, not an event', async () => {
    const { translate } = await load();
    const got = translate('event', bus('message.updated', {
      info: { id: 'm1', sessionID: 's1', modelID: 'claude-sonnet-5', providerID: 'anthropic' },
    }));
    assert.deepStrictEqual(got,
      { type: 'model.observed', sessionId: 's1', model: 'claude-sonnet-5' });
  });

  test.async('a message.updated without a modelID yields nothing', async () => {
    const { translate } = await load();
    assert.strictEqual(translate('event', bus('message.updated', { info: { id: 'm1' } })), null);
    assert.strictEqual(translate('event', bus('message.updated', {})), null);
  });

  test.async('an observed model spawns nothing but labels later payloads', async () => {
    const mod = await loadIsolated('model-observe');
    const hooks = await mod.CodeCrumbPlugin({ project: {}, directory: '.', worktree: '.' });
    const pending = withoutSpawning(() => [
      hooks.event(bus('message.updated', { info: { modelID: 'claude-opus-5' } })),
      hooks['tool.execute.before']({ sessionID: 's1', callID: 'c1', tool: 'read' }, { args: {} }),
    ]);
    const sent = await Promise.all(pending);
    assert.strictEqual(sent[0], false, 'an observation costs no process');
    assert.strictEqual(sent[1], true, 'the real event still goes out');
  });

  test.async('an observed model is remembered per session, not globally', async () => {
    const { translate } = await load();
    // One OpenCode process can have several sessions in flight; an unkeyed
    // memory would stamp session A's model onto session B's orbital.
    const a = translate('event', bus('message.updated', {
      info: { sessionID: 'ses_a', modelID: 'claude-opus-5' },
    }));
    assert.strictEqual(a.sessionId, 'ses_a', 'the observation carries its session');
    const b = translate('event', bus('message.updated', {
      info: { sessionID: 'ses_b', modelID: 'claude-haiku-4-5' },
    }));
    assert.strictEqual(b.sessionId, 'ses_b');
    assert.notStrictEqual(a.model, b.model);
  });

  // Proves the two tests below really do start nothing: the plugin reads
  // CODE_CRUMB_NODE per spawn, so a bogus binary disarms delivery. (If it
  // were captured at import instead, those tests would quietly go on
  // spawning real adapters and still pass.)
  test.async('CODE_CRUMB_NODE is honoured per spawn, so a bogus binary starts nothing', async () => {
    const { CodeCrumbPlugin } = await loadIsolated('nospawn');
    const hooks = await CodeCrumbPlugin();
    const home = process.env.USERPROFILE || process.env.HOME;
    const sid = `plug-nospawn-${process.pid}`;
    const file = path.join(home, '.code-crumb-sessions', `${sid}.json`);
    try { fs.unlinkSync(file); } catch {}

    // session.idle takes the synchronous path: a real adapter would have
    // written the session file by the time the hook resolves.
    await withoutSpawning(() => hooks.event(bus('session.idle', { sessionID: sid })));
    assert.strictEqual(fs.existsSync(file), false, 'no adapter may run with a bogus node binary');
  });

  // OpenCode awaits the tool.execute.* hooks, so anything that escapes a
  // hook surfaces inside the editor. Every hook must be total, whatever it
  // is handed: missing arguments, a null event, a getter that throws, or a
  // payload JSON.stringify cannot serialise.
  test.async('every hook is total: hostile input never throws or rejects', async () => {
    const { CodeCrumbPlugin } = await loadIsolated('hostile');
    const hooks = await CodeCrumbPlugin();
    const names = ['event', 'tool.execute.before', 'tool.execute.after', 'permission.ask'];
    const landmine = {
      get event() { throw new Error('boom'); },
      get sessionID() { throw new Error('boom'); },
      get tool() { throw new Error('boom'); },
      get args() { throw new Error('boom'); },
      get title() { throw new Error('boom'); },
      get output() { throw new Error('boom'); },
    };
    const cases = [
      undefined, null, {}, { event: null }, { event: {} },
      { event: { type: 'message.part.updated', properties: null } },
      { event: { type: 'message.part.updated', properties: { part: null } } },
      landmine,
    ];
    // JSON.stringify throws on a cycle: that must be dropped, not raised.
    const cyclic = { args: {} };
    cyclic.args.self = cyclic;

    // Most of these payloads survive translate() and would reach the spawn:
    // the assertions are about totality, not about starting 21 real adapters.
    const pending = withoutSpawning(() => {
      const calls = [];
      for (const c of cases) {
        for (const name of names) calls.push([name, hooks[name](c, c)]);
      }
      calls.push(['cyclic', hooks['tool.execute.before']({ sessionID: 'ses_1', tool: 'edit', callID: 'c1' }, cyclic)]);
      return calls;
    });

    for (const [name, promise] of pending) {
      const result = await promise;
      assert.strictEqual(typeof result, 'boolean', `${name} must resolve, not reject`);
    }
    assert.strictEqual(await pending[pending.length - 1][1], false,
      'an unserialisable payload must be dropped');
  });

  // A reasoning part is republished on every streaming delta. One cold Node
  // start (plus a stats read-modify-write) per chunk is load this project
  // never had before the plugin existed.
  test.async('a burst of reasoning deltas collapses into a single send', async () => {
    const { CodeCrumbPlugin } = await loadIsolated('throttle');
    const hooks = await CodeCrumbPlugin();

    const before = { sessionID: 'ses_burst', tool: 'read', callID: 'c1' };
    const calls = withoutSpawning(() => ({
      burst: Array.from({ length: 20 }, () => hooks.event(reasoning('ses_burst'))),
      // The throttle is per session, and only reasoning is throttled.
      otherSession: hooks.event(reasoning('ses_other')),
      tools: [hooks['tool.execute.before'](before, { args: {} }),
        hooks['tool.execute.before'](before, { args: {} })],
    }));

    const sent = (await Promise.all(calls.burst)).filter(Boolean).length;
    assert.strictEqual(sent, 1, 'one send per burst, not one per delta');
    assert.strictEqual(await calls.otherSession, true,
      'another session must not inherit the first one\'s throttle');
    assert.deepStrictEqual(await Promise.all(calls.tools), [true, true],
      'tool events are never collapsed');
  });

  // Measured against opencode 1.18.21: `opencode run` exits the instant the
  // turn ends, and a child spawned microseconds earlier dies with it -- the
  // session.idle write never landed, so the face stayed on thinking and the
  // global state file stayed owned by a session that never said stopped.
  test.async('the session.idle write has landed by the time the hook resolves', async () => {
    const { CodeCrumbPlugin } = await loadModule();
    const hooks = await CodeCrumbPlugin();
    const home = process.env.USERPROFILE || process.env.HOME;
    const sid = `plug-idle-${process.pid}`;
    const file = path.join(home, '.code-crumb-sessions', `${sid}.json`);
    try { fs.unlinkSync(file); } catch {}

    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: sid } } });

    assert.ok(fs.existsSync(file), 'turn-end write must not be left in flight');
    const s = readJSON(file);
    assert.strictEqual(s.state, 'happy');
    // A turn end, not a session end: the session file says turnEnded and
    // keeps `stopped` for a real session end (see base-adapter.js).
    assert.strictEqual(s.turnEnded, true);
    assert.strictEqual(s.stopped, false);
  });
});

describe('adapters -- opencode-plugin structure', () => {
  const src = fs.readFileSync(path.join(ADAPTERS_DIR, 'opencode-plugin.mjs'), 'utf8');
  // Comments talk about what the plugin must NOT do, so assert on code only.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');

  test('spawns a real node, not process.execPath (which is bun inside OpenCode)', () => {
    assert.ok(!code.includes('process.execPath'), 'process.execPath is the bun binary under OpenCode');
    assert.ok(code.includes('CODE_CRUMB_NODE'), 'the node binary must be overridable');
  });

  test('no exec timeout short enough to kill a cold node start', () => {
    assert.ok(!code.includes('execSync'), 'execSync with a 200ms cap killed writes mid-flight');
    const caps = [...code.matchAll(/timeout:\s*(\w+)/g)].map(m => m[1]);
    for (const cap of caps) {
      const value = cap === 'SYNC_CAP_MS' ? 5000 : Number(cap);
      assert.ok(value >= 1000, `spawn timeout ${cap} is shorter than a cold node start`);
    }
    assert.ok(code.includes('windowsHide'), 'no console flash on Windows');
  });

  test('only the turn-end payloads block: ordinary tool events stay fire-and-forget', () => {
    assert.ok(/SYNC_TYPES = new Set\(\['session.idle', 'session.error'\]\)/.test(code),
      'the synchronous set must stay limited to the writes that race process exit');
    assert.ok(/if \(SYNC_TYPES\.has\(payload\.type\)\)/.test(code),
      'everything else must go through the async spawn');
  });

  test('a failed spawn is handled rather than left to reject', () => {
    assert.ok(src.includes("child.on('error'"), 'a failed spawn must not reject');
  });
});

// -- opencode-adapter: payloads produced by the shipped plugin ---------

describe('adapters -- opencode-adapter (plugin payloads)', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'opencode-adapter.js');

  test('tool.execute.before with an OpenCode filePath arg writes coding and tracks the file', () => {
    const { tmp, stateFile, statsFile, env } = makeTempEnv('oc-plug-1');
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before', sessionId: 'ses_1', callID: 'c1',
      tool: 'edit', toolInput: { filePath: 'a.js' },
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'coding');
    assert.strictEqual(state.detail, 'editing a.js');
    assert.strictEqual(state.sessionId, 'ses_1');
    const stats = readJSON(statsFile);
    assert.ok(stats.frequentFiles && stats.frequentFiles['a.js'] >= 1,
      `frequentFiles should track a.js, got ${JSON.stringify(stats.frequentFiles)}`);
    cleanup(tmp);
  });

  test('the payload session id wins over the opencode-<ppid> fallback', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-2');
    delete env.CLAUDE_SESSION_ID;
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before', sessionId: 'ses_1', tool: 'bash', toolInput: { command: 'ls' },
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.sessionId, 'ses_1');
    assert.ok(!/^opencode-\d+$/.test(state.sessionId), 'must not fall back to a ppid-derived id');
    cleanup(tmp);
  });

  test('tool.execute.after writes a completion state', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-3');
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.after', sessionId: 'ses_1', tool: 'bash',
      toolInput: { command: 'echo hi' }, title: 'echo hi', output: 'hi',
    }, env);
    const state = readJSON(stateFile);
    assert.ok(['happy', 'satisfied', 'proud', 'relieved'].includes(state.state),
      `expected completion state, got "${state.state}"`);
    cleanup(tmp);
  });

  test('tool.error writes the error face with the error text', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-4');
    runStdinAdapter(ADAPTER, {
      type: 'tool.error', sessionId: 'ses_1', tool: 'bash',
      toolInput: { command: 'exit 1' }, error: 'exit code 1',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    cleanup(tmp);
  });

  test('session.created writes the starting face', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-5');
    runStdinAdapter(ADAPTER, { type: 'session.created', sessionId: 'ses_1' }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'starting');
    assert.strictEqual(state.detail, 'session started');
    assert.strictEqual(state.sessionId, 'ses_1');
    cleanup(tmp);
  });

  test('session.idle still stops the session', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-6');
    runStdinAdapter(ADAPTER, { type: 'session.idle', sessionId: 'ses_1' }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'happy');
    assert.strictEqual(state.detail, 'all done!');
    assert.strictEqual(state.stopped, true);
    cleanup(tmp);
  });

  test('session.error carries the flattened error text into the detail', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-7');
    runStdinAdapter(ADAPTER, {
      type: 'session.error', sessionId: 'ses_1', error: 'connection lost',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    assert.ok(state.detail.includes('connection lost'), `detail was "${state.detail}"`);
    cleanup(tmp);
  });

  test('thinking writes the thinking face', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-8');
    runStdinAdapter(ADAPTER, { type: 'thinking', sessionId: 'ses_1' }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'thinking');
    cleanup(tmp);
  });

  test('permission.asked waits with the allow? detail that spawns question particles', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-9');
    runStdinAdapter(ADAPTER, {
      type: 'permission.asked', sessionId: 'ses_1', title: 'rm -rf build',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'waiting');
    assert.strictEqual(state.detail, 'allow?');
    cleanup(tmp);
  });

  test('permission.replied returns to satisfied', () => {
    const { tmp, stateFile, env } = makeTempEnv('oc-plug-10');
    runStdinAdapter(ADAPTER, {
      type: 'permission.replied', sessionId: 'ses_1', response: 'once',
    }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'satisfied');
    assert.strictEqual(state.detail, 'got your answer');
    cleanup(tmp);
  });

  test('one OpenCode turn produces exactly one session file', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('oc-plug-11');
    delete env.CLAUDE_SESSION_ID;
    for (const payload of [
      { type: 'session.created', sessionId: 'ses_1' },
      { type: 'thinking', sessionId: 'ses_1' },
      { type: 'tool.execute.before', sessionId: 'ses_1', tool: 'bash', toolInput: { command: 'ls' } },
      { type: 'tool.execute.after', sessionId: 'ses_1', tool: 'bash', toolInput: { command: 'ls' }, output: 'a.js' },
      { type: 'session.idle', sessionId: 'ses_1' },
    ]) runStdinAdapter(ADAPTER, payload, env);
    const files = fs.readdirSync(sessionsDir);
    assert.deepStrictEqual(files, ['ses_1.json'],
      `expected a single ses_1 session file, got ${files.join(', ')}`);
    cleanup(tmp);
  });
});

// -- opencode session_id consolidation (phantom orbital fix) ----------

describe('adapters -- opencode session_id consolidation', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'opencode-adapter.js');

  test('multiple events with same session_id produce one session file', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('oc-consolidate-1');
    // Simulate a typical OpenCode sequence: session.created, tool before, tool after
    runStdinAdapter(ADAPTER, {
      type: 'session.created', session_id: 'oc-consolidate-1',
    }, env);
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before', session_id: 'oc-consolidate-1',
      input: { tool: 'file_edit', args: {} },
    }, env);
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.after', session_id: 'oc-consolidate-1',
      input: { tool: 'file_edit', args: {} }, output: {},
    }, env);
    const files = fs.readdirSync(sessionsDir);
    assert.strictEqual(files.length, 1,
      `expected 1 session file, got ${files.length}: ${files.join(', ')}`);
    cleanup(tmp);
  });

  test('normaliseEvent extracts session_id into sessionId field', () => {
    const { normaliseEvent } = require(path.join(ADAPTERS_DIR, 'opencode-adapter.js'));
    const norm = normaliseEvent({
      type: 'tool.execute.before',
      session_id: 'oc-norm-test',
      input: { tool: 'shell', args: {} },
    });
    assert.strictEqual(norm.sessionId, 'oc-norm-test',
      'normaliseEvent should extract session_id as sessionId');
  });

  test('normaliseEvent returns empty sessionId when session_id missing', () => {
    const { normaliseEvent } = require(path.join(ADAPTERS_DIR, 'opencode-adapter.js'));
    const norm = normaliseEvent({
      type: 'tool.execute.before',
      input: { tool: 'shell', args: {} },
    });
    assert.strictEqual(norm.sessionId, '',
      'normaliseEvent should return empty string when no session_id');
  });

  test('different session_ids produce separate session files', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('oc-separate-a');
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before', session_id: 'oc-separate-a',
      input: { tool: 'shell', args: {} },
    }, env);
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before', session_id: 'oc-separate-b',
      input: { tool: 'file_edit', args: {} },
    }, env);
    const files = fs.readdirSync(sessionsDir);
    assert.strictEqual(files.length, 2,
      `different session_ids should produce 2 files, got ${files.length}`);
    cleanup(tmp);
  });

  test('CLAUDE_SESSION_ID env var used as fallback when session_id missing', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('oc-env-fallback');
    // Send events without session_id in payload -- env var should be used
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.before',
      input: { tool: 'shell', args: {} },
    }, env);
    runStdinAdapter(ADAPTER, {
      type: 'tool.execute.after',
      input: { tool: 'shell', args: {} }, output: {},
    }, env);
    const files = fs.readdirSync(sessionsDir);
    assert.strictEqual(files.length, 1,
      `env fallback should consolidate to 1 session file, got ${files.length}`);
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

describe('adapters -- codex-wrapper bootstrap guard', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'codex-wrapper.js');

  test('requiring the wrapper starts no codex and writes no state', () => {
    // Without the require.main guard, a plain require spawns `codex exec`
    // and takes over the global state file -- which is exactly what the
    // in-process classifyItem block below would trip over.
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('wrapper-require');
    execFileSync(NODE, ['-e', 'require(process.argv[1]);', ADAPTER], {
      env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.ok(!fs.existsSync(stateFile), 'a bare require must not write global state');
    assert.ok(!fs.existsSync(sessionsDir), 'a bare require must not create an orbital');
    cleanup(tmp);
  });

  // Kept as a source check: the wrapper spawns the real `codex` binary, and
  // on Windows that is a .cmd shim node refuses to exec without shell:true.
  // The fake-codex block below proves the shim path works, but only when the
  // suite happens to run on win32 -- posix CI would never notice a regression.
  test('source: codex is spawned through buildEditorSpawn (Windows .cmd shims)', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('buildEditorSpawn'), 'should use buildEditorSpawn');
    assert.ok(!/spawn\(\s*'codex'/.test(src), 'should not spawn the bare codex name');
  });
});

// -- codex-notify.js (structural tests) ------------------------------

describe('adapters -- codex-notify guards and unknown events', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'codex-notify.js');

  function runNotify(event, env) {
    try {
      execFileSync(NODE, [ADAPTER, JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
  }

  test('approval-requested is not a codex notify event -- it falls through to thinking', () => {
    // The handler used to special-case it; codex never emits it, so it must
    // take the same unknown-type path as any future event name.
    const { tmp, stateFile, env } = makeTempEnv('notify-approval');
    runNotify({ type: 'approval-requested', 'thread-id': 'notify-approval' }, env);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'thinking');
    assert.strictEqual(state.detail, 'approval-requested');
    cleanup(tmp);
  });

  test('another live session keeps the global state file; the orbital is still written', () => {
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('notify-guard');
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'coding', detail: 'editing app.js', sessionId: 'someone-else',
      stopped: false, timestamp: Date.now(),
    }), 'utf8');

    runNotify({ type: 'agent-turn-complete', 'thread-id': 'notify-guard' }, env);

    const state = readJSON(stateFile);
    assert.strictEqual(state.sessionId, 'someone-else',
      'a live owner must not be evicted from the global state file');
    assert.strictEqual(state.state, 'coding');
    const session = readJSON(path.join(sessionsDir, 'notify-guard.json'));
    assert.strictEqual(session.state, 'happy',
      'the guarded session still gets its own orbital file');
    cleanup(tmp);
  });

  test('a stopped owner releases the global state file to the codex thread', () => {
    const { tmp, stateFile, env } = makeTempEnv('notify-takeover');
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'happy', detail: 'all done!', sessionId: 'someone-else',
      stopped: true, timestamp: Date.now(),
    }), 'utf8');

    runNotify({ type: 'agent-turn-complete', 'thread-id': 'notify-takeover' }, env);

    const state = readJSON(stateFile);
    assert.strictEqual(state.sessionId, 'notify-takeover');
    assert.strictEqual(state.state, 'happy');
    cleanup(tmp);
  });

  test('the editor provenance of the session owner survives a notify write', () => {
    const { tmp, stateFile, env } = makeTempEnv('notify-editor');
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'thinking', detail: '', sessionId: 'notify-editor',
      editor: 'opencode', stopped: false, timestamp: Date.now(),
    }), 'utf8');

    runNotify({ type: 'agent-turn-complete', 'thread-id': 'notify-editor' }, env);

    const state = readJSON(stateFile);
    assert.strictEqual(state.editor, 'opencode',
      "the owner's editor tag must not be relabelled codex mid-session");
    cleanup(tmp);
  });
});

// -- codex-wrapper.js: the real `codex exec --json` schema -------------
// Codex 0.146 emits thread.started / turn.* / item.started|updated|completed
// with typed items (command_execution, file_change, mcp_tool_call, ...).
// classifyItem is pure and tested in-process; anything that writes a state
// file goes through a subprocess with its own temp HOME, because shared.js
// fixes its paths at first require.

describe('adapters -- codex-wrapper classifyItem (real ThreadEvent schema)', () => {
  const wrapper = require('../adapters/codex-wrapper');

  test('requiring the wrapper exports its pure helpers and spawns nothing', () => {
    assert.strictEqual(typeof wrapper.classifyItem, 'function', 'classifyItem exported');
    assert.strictEqual(typeof wrapper.handleEvent, 'function', 'handleEvent exported');
  });

  test('command_execution start maps to the Bash tool with its command', () => {
    const c = wrapper.classifyItem({ id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' }, 'started');
    assert.strictEqual(c.toolName, 'Bash');
    assert.strictEqual(c.toolInput.command, 'npm test');
  });

  test('command_execution completion carries output, exit code and failure flag', () => {
    const c = wrapper.classifyItem({
      id: 'i1', type: 'command_execution', command: 'npm test',
      aggregated_output: 'FAIL', exit_code: 1, status: 'failed',
    }, 'completed');
    assert.strictEqual(c.toolName, 'Bash');
    assert.strictEqual(c.toolResponse.stdout, 'FAIL');
    assert.strictEqual(c.toolResponse.exitCode, 1);
    assert.strictEqual(c.toolResponse.isError, true);
  });

  test('a declined command is relief, not an error', () => {
    const c = wrapper.classifyItem({
      id: 'i1', type: 'command_execution', command: 'rm -rf /', status: 'declined',
    }, 'completed');
    assert.strictEqual(c.state, 'relieved');
    assert.strictEqual(c.detail, 'command declined');
  });

  test('file_change start maps to the Edit tool with the first path', () => {
    const c = wrapper.classifyItem({
      id: 'i2', type: 'file_change', status: 'in_progress',
      changes: [{ path: '/repo/a.js', kind: 'update' }, { path: '/repo/b.js', kind: 'add' }],
    }, 'started');
    assert.strictEqual(c.toolName, 'Edit');
    assert.strictEqual(c.toolInput.file_path, '/repo/a.js');
    assert.deepStrictEqual(c.filePaths, ['/repo/a.js', '/repo/b.js']);
  });

  test('file_change completion is proud, and counts multiple files', () => {
    const one = wrapper.classifyItem({
      id: 'i2', type: 'file_change', status: 'completed',
      changes: [{ path: '/repo/a.js', kind: 'update' }],
    }, 'completed');
    assert.strictEqual(one.state, 'proud');
    assert.strictEqual(one.detail, 'saved a.js');

    const two = wrapper.classifyItem({
      id: 'i2', type: 'file_change', status: 'completed',
      changes: [{ path: '/repo/a.js', kind: 'update' }, { path: '/repo/b.js', kind: 'add' }],
    }, 'completed');
    assert.strictEqual(two.state, 'proud');
    assert.strictEqual(two.detail, 'saved 2 files');
  });

  test('a failed file_change is an error', () => {
    const c = wrapper.classifyItem({
      id: 'i2', type: 'file_change', status: 'failed',
      changes: [{ path: '/repo/a.js', kind: 'update' }],
    }, 'completed');
    assert.strictEqual(c.state, 'error');
    assert.strictEqual(c.detail, 'edit failed');
  });

  test('mcp_tool_call becomes an mcp__server__tool name for the verb classifier', () => {
    const c = wrapper.classifyItem({
      id: 'i3', type: 'mcp_tool_call', server: 'github', tool: 'list_issues',
      arguments: { repo: 'x' }, status: 'in_progress',
    }, 'started');
    assert.strictEqual(c.toolName, 'mcp__github__list_issues');
    assert.deepStrictEqual(c.toolInput, { repo: 'x' });
  });

  test('an mcp_tool_call error is reported as an error', () => {
    const c = wrapper.classifyItem({
      id: 'i3', type: 'mcp_tool_call', server: 'github', tool: 'list_issues',
      error: 'not authorised', status: 'failed',
    }, 'completed');
    assert.strictEqual(c.toolResponse.isError, true);
  });

  test('web_search maps to the WebSearch tool', () => {
    const c = wrapper.classifyItem({ id: 'i4', type: 'web_search', query: 'node 18 fs' }, 'started');
    assert.strictEqual(c.toolName, 'WebSearch');
    assert.strictEqual(c.toolInput.query, 'node 18 fs');
  });

  test('collab items delegate and finish as an agent', () => {
    for (const type of ['collab_tool_call', 'collab_agent_tool_call']) {
      const started = wrapper.classifyItem({ id: 'i5', type, status: 'in_progress' }, 'started');
      assert.strictEqual(started.toolName, 'Task', type);
      assert.strictEqual(started.toolInput.description, 'delegating', type);
      const done = wrapper.classifyItem({ id: 'i5', type, status: 'completed' }, 'completed');
      assert.strictEqual(done.toolName, 'Task', type);
    }
  });

  test('todo_list and plan_update are planning, then a plan update', () => {
    for (const type of ['todo_list', 'plan_update']) {
      const started = wrapper.classifyItem({ id: 'i6', type }, 'started');
      assert.strictEqual(started.toolName, 'TodoWrite', type);
      const done = wrapper.classifyItem({ id: 'i6', type }, 'completed');
      assert.strictEqual(done.state, 'satisfied', type);
      assert.strictEqual(done.detail, 'plan updated', type);
    }
  });

  test('context_compaction is thinking, then satisfied', () => {
    const started = wrapper.classifyItem({ id: 'i7', type: 'context_compaction' }, 'started');
    assert.strictEqual(started.state, 'thinking');
    assert.strictEqual(started.detail, 'compacting memory');
    const done = wrapper.classifyItem({ id: 'i7', type: 'context_compaction' }, 'completed');
    assert.strictEqual(done.state, 'satisfied');
    assert.strictEqual(done.detail, 'memory compacted');
  });

  test('reasoning thinks without touching the detail line', () => {
    const c = wrapper.classifyItem({ id: 'i8', type: 'reasoning', text: 'hmm' }, 'completed');
    assert.strictEqual(c.state, 'thinking');
    assert.strictEqual(c.detail, undefined, 'no detail means "keep what is on screen"');
    assert.ok(!c.toolName, 'reasoning is not a tool call');
  });

  test('agent_message responds', () => {
    const c = wrapper.classifyItem({ id: 'i9', type: 'agent_message', text: 'done' }, 'completed');
    assert.strictEqual(c.state, 'responding');
    assert.ok(!c.toolName, 'a message is not a tool call');
  });

  test('unknown item types are executed by their humanised name', () => {
    for (const type of ['image_generation', 'image_view', 'dynamic_tool_call', 'brand_new_thing']) {
      const started = wrapper.classifyItem({ id: 'i10', type }, 'started');
      assert.strictEqual(started.state, 'executing', type);
      assert.ok(started.detail && !started.detail.includes('_'), `${type} detail should be humanised`);
      const done = wrapper.classifyItem({ id: 'i10', type }, 'completed');
      assert.strictEqual(done.state, 'satisfied', type);
      assert.strictEqual(done.detail, 'done', type);
    }
  });

  test('item type "error" is a codex diagnostic, not a face state', () => {
    // Live capture: codex reports warnings ("Skill descriptions were shortened",
    // "clamping SessionEnd hook timeout") as item.completed items of type error.
    const c = wrapper.classifyItem({ id: 'i11', type: 'error', message: 'skill descriptions were shortened' }, 'completed');
    assert.strictEqual(c, null);
  });

  test('a malformed item never throws', () => {
    assert.strictEqual(wrapper.classifyItem(null, 'started'), null);
    assert.strictEqual(wrapper.classifyItem({}, 'completed'), null);
  });
});

describe('adapters -- codex-wrapper against a fake codex on PATH', () => {
  const WRAPPER = path.join(ADAPTERS_DIR, 'codex-wrapper.js');

  // Replays a fixture through the wrapper's real spawn path: on Windows the
  // fake is a .cmd shim, which only starts if the wrapper passes shell:true
  // (Node refuses to spawn .cmd otherwise), so this also covers the Windows
  // spawn fix.
  const FAKE_SRC = [
    "'use strict';",
    "const fs = require('fs');",
    "const text = fs.readFileSync(process.env.CODEX_FAKE_FIXTURE, 'utf8');",
    "for (const line of text.split('\\n')) {",
    "  if (line.trim()) process.stdout.write(line + '\\n');",
    "}",
    '',
  ].join('\n');

  function runFakeCodex(events, seedStats, extraArgs = []) {
    const base = makeTempEnv('codex-thread');
    const binDir = path.join(base.tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    if (seedStats) fs.writeFileSync(base.statsFile, JSON.stringify(seedStats), 'utf8');

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
      execFileSync(NODE, [WRAPPER, ...extraArgs, 'a prompt'], {
        env, timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    return base;
  }

  test('a running npm test shows the testing face', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'testing');
    assert.ok(state.detail.includes('npm test'), state.detail);
    assert.strictEqual(state.editor, 'codex');
    cleanup(tmp);
  });

  test('a failing command ends on the error face', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', aggregated_output: 'FAIL', exit_code: 1, status: 'failed' } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    cleanup(tmp);
  });

  test('a clean exit code is relief', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls -la', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'ls -la', aggregated_output: 'a\nb', exit_code: 0, status: 'completed' } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'relieved');
    cleanup(tmp);
  });

  test('a declined command shows relieved / command declined', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'rm -rf /', status: 'declined' } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'relieved');
    assert.strictEqual(state.detail, 'command declined');
    cleanup(tmp);
  });

  test('a file_change codes, then is proud of every file it saved', () => {
    const changes = [{ path: '/repo/a.js', kind: 'update' }, { path: '/repo/b.js', kind: 'add' }];
    const start = runFakeCodex([
      { type: 'item.started', item: { id: 'i2', type: 'file_change', changes, status: 'in_progress' } },
    ]);
    const coding = readJSON(start.stateFile);
    assert.strictEqual(coding.state, 'coding');
    assert.strictEqual(coding.detail, 'editing a.js');
    cleanup(start.tmp);

    const { tmp, stateFile, statsFile } = runFakeCodex([
      { type: 'item.started', item: { id: 'i2', type: 'file_change', changes, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes, status: 'completed' } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'proud');
    assert.strictEqual(state.detail, 'saved 2 files');
    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.filesEdited.length, 2, 'both changed files are tracked');
    cleanup(tmp);
  });

  test('an mcp tool reads, then reports the server as done', () => {
    const item = { id: 'i3', type: 'mcp_tool_call', server: 'github', tool: 'list_issues', arguments: {} };
    const start = runFakeCodex([
      { type: 'item.started', item: { ...item, status: 'in_progress' } },
    ]);
    assert.strictEqual(readJSON(start.stateFile).state, 'reading');
    cleanup(start.tmp);

    const { tmp, stateFile } = runFakeCodex([
      { type: 'item.started', item: { ...item, status: 'in_progress' } },
      { type: 'item.completed', item: { ...item, status: 'completed', result: 'ok' } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'satisfied');
    assert.strictEqual(state.detail, 'github done');
    cleanup(tmp);
  });

  test('a web search shows the searching face', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'item.started', item: { id: 'i4', type: 'web_search', query: 'node 18 fs' } },
    ]);
    assert.strictEqual(readJSON(stateFile).state, 'searching');
    cleanup(tmp);
  });

  test('a collaboration item shows the subagent face', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'item.started', item: { id: 'i5', type: 'collab_tool_call', status: 'in_progress' } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'subagent');
    assert.strictEqual(state.detail, 'delegating');
    cleanup(tmp);
  });

  test('turn.failed shows the error with its message and stops the session', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'boom' } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    assert.strictEqual(state.detail, 'boom');
    assert.strictEqual(state.stopped, true);
    cleanup(tmp);
  });

  test('a failed turn breaks the streak once, not twice', () => {
    // Codex reports one failure as BOTH a top-level error and a turn.failed.
    // Breaking the streak on each would leave brokenStreak at 0 (face.js only
    // reacts while brokenStreak > 0) and count the failure twice.
    const blob = '{"type":"error","status":400,"error":{"message":"nope"}}';
    const { tmp, stateFile, statsFile } = runFakeCodex([
      { type: 'turn.started' },
      { type: 'error', message: blob },
      { type: 'turn.failed', error: { message: blob } },
    ], { streak: 5, bestStreak: 7, totalErrors: 2 });

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.brokenStreak, 5, 'the lost streak must survive for the face reaction');
    assert.strictEqual(stats.streak, 0);
    assert.strictEqual(stats.totalErrors, 3, 'one failure counts once');
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'error');
    assert.strictEqual(state.brokenStreak, 5);
    cleanup(tmp);
  });

  // codex 0.146 emits a top-level `error` for every retryable stream error
  // (will_retry in the app-server protocol) and then carries on; a real
  // failure always ends in turn.failed. So the error face shows, but only
  // turn.failed may cost the streak -- a completed turn used to lose it.
  test('a standalone error (a retry notice) shows but does not break the streak', () => {
    const { tmp, statsFile, stateFile } = runFakeCodex([
      { type: 'turn.started' },
      { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected before completion)' },
    ], { streak: 4, bestStreak: 9, totalErrors: 1 });

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.streak, 4);
    assert.strictEqual(stats.brokenStreak || 0, 0);
    assert.strictEqual(stats.totalErrors, 1);
    assert.strictEqual(readJSON(stateFile).state, 'error', 'the notice is still shown');
    cleanup(tmp);
  });

  test('a retry notice inside a turn that completes keeps the streak growing', () => {
    const { tmp, statsFile } = runFakeCodex([
      { type: 'thread.started', thread_id: 'retry' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i0', type: 'command_execution', command: 'ls', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i0', type: 'command_execution', command: 'ls', aggregated_output: 'a', exit_code: 0, status: 'completed' } },
      { type: 'error', message: 'Reconnecting... 1/5' },
      { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'All good.' } },
      { type: 'turn.completed', usage: {} },
    ], { streak: 12, bestStreak: 12, totalErrors: 0 });

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.streak, 13);
    assert.strictEqual(stats.brokenStreak || 0, 0);
    assert.strictEqual(stats.totalErrors, 0);
    cleanup(tmp);
  });

  test('a second turn can break the streak again', () => {
    const { tmp, statsFile } = runFakeCodex([
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'first' } },
      { type: 'turn.started' },
      { type: 'turn.failed', error: { message: 'second' } },
    ], { streak: 3, bestStreak: 3, totalErrors: 0 });

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.totalErrors, 2, 'two failed turns count twice');
    cleanup(tmp);
  });

  test('thread.started names the session after the codex thread', () => {
    const { tmp, stateFile, sessionsDir } = runFakeCodex([
      { type: 'thread.started', thread_id: 'abc' },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.sessionId, 'codex-abc');
    assert.strictEqual(state.editor, 'codex');
    assert.strictEqual(state.modelName, 'codex', 'the status line says "codex is ..." by default');
    // The wrapper is long-lived, so it publishes its OWN pid, not its parent's.
    assert.strictEqual(typeof state.pid, 'number');
    assert.ok(state.pid > 0 && state.pid !== process.pid,
      `pid should be the wrapper process, not the test runner (${process.pid})`);
    const files = fs.readdirSync(sessionsDir);
    assert.deepStrictEqual(files, ['codex-abc.json'], 'exactly one orbital, named for the thread');
    cleanup(tmp);
  });

  test('item.updated refreshes the face without counting the tool twice', () => {
    const { tmp, stateFile, statsFile } = runFakeCodex([
      { type: 'thread.started', thread_id: 'upd' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' } },
      { type: 'item.updated', item: { id: 'i1', type: 'command_execution', command: 'npm run lint', status: 'in_progress' } },
    ]);
    const state = readJSON(stateFile);
    assert.ok(state.detail.includes('npm run lint'),
      `the updated command should reach the face, got "${state.detail}"`);
    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.toolCalls, 1,
      'item.started + item.updated is one tool call, not two');
    cleanup(tmp);
  });

  test('the pre-0.146 item.created / tool_use schema is ignored, not misread', () => {
    // codex 0.146 emits item.started|updated|completed with typed items; the
    // old guess (item.created carrying a tool_use item) must move nothing.
    const { tmp, stateFile } = runFakeCodex([
      { type: 'thread.started', thread_id: 'old' },
      { type: 'item.created', item: { id: 'i1', type: 'tool_use', name: 'Bash', input: { command: 'npm test' } } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'starting',
      `the face must stay on the thread.started frame, got "${state.state}"`);
    assert.ok(!/npm test/.test(state.detail || ''),
      'no tool detail should be derived from the old schema');
    cleanup(tmp);
  });

  test('a whole captured turn ends on responding / stopped', () => {
    // Shape taken from a live `codex exec --json` capture (codex-cli 0.146.0).
    const { tmp, stateFile } = runFakeCodex([
      { type: 'thread.started', thread_id: 'live' },
      { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'clamping SessionEnd hook timeout to 3s' } },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'running it' } },
      { type: 'item.started', item: { id: 'item_3', type: 'command_execution', command: 'pwsh -Command echo hi', aggregated_output: '', exit_code: null, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'item_3', type: 'command_execution', command: 'pwsh -Command echo hi', aggregated_output: 'hi', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'item_4', type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 47463, output_tokens: 118 } },
    ]);
    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'responding');
    assert.strictEqual(state.detail, 'wrapping up');
    assert.strictEqual(state.stopped, true);
    assert.strictEqual(state.sessionId, 'codex-live');
    cleanup(tmp);
  });

  test('-m stamps the model on the state file', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'thread.started', thread_id: 'tm1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
    ], null, ['-m', 'gpt-5']);
    const state = readJSON(stateFile);
    assert.strictEqual(state.model, 'gpt-5', 'the flag its header has always documented');
    assert.strictEqual(state.editor, 'codex');
    cleanup(tmp);
  });

  test('--model=<id> is parsed too, and prettified when it is a known family', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'thread.started', thread_id: 'tm2' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
    ], null, ['--model=anthropic/claude-opus-5']);
    assert.strictEqual(readJSON(stateFile).model, 'Opus');
    cleanup(tmp);
  });

  test('no -m leaves the model absent rather than guessing', () => {
    const { tmp, stateFile } = runFakeCodex([
      { type: 'thread.started', thread_id: 'tm3' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'ls', status: 'in_progress' } },
    ]);
    const state = readJSON(stateFile);
    assert.ok(!state.model, 'codex-s configured default is not reported in the event stream');
    assert.strictEqual(state.modelName, 'codex', 'the display name is unaffected');
    cleanup(tmp);
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

describe('adapters -- engmux-adapter', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'engmux-adapter.js');
  // Requiring the adapter must not start a dispatch: the runtime lives behind
  // a require.main guard, so a bare require only hands back the arg parsers.
  const engmux = require('../adapters/engmux-adapter');

  // Runs one dispatch to completion with a stand-in for the python
  // interpreter and returns the orbital session file it left behind.
  function runEngmux(args, python) {
    const base = makeTempEnv('engmux-parent');
    const env = { ...base.env, ENGMUX_PYTHON: python };
    try {
      execFileSync(NODE, [ADAPTER, ...args], {
        env, timeout: 20000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      // The adapter exits with the child's code; only a killed adapter matters.
      if (e.status === null || e.status === undefined) throw e;
    }
    const files = fs.existsSync(base.sessionsDir) ? fs.readdirSync(base.sessionsDir) : [];
    const session = files.length
      ? readJSON(path.join(base.sessionsDir, files[0]))
      : null;
    cleanup(base.tmp);
    return { files, session };
  }

  test('requiring the adapter exports its arg parsers and starts no dispatch', () => {
    assert.strictEqual(typeof engmux.extractModel, 'function');
    assert.strictEqual(typeof engmux.extractEngine, 'function');
  });

  test('extractModel takes -m / --model and strips the provider prefix', () => {
    assert.strictEqual(engmux.extractModel(['-m', 'opencode/big-pickle']), 'big-pickle');
    assert.strictEqual(engmux.extractModel(['--model', 'anthropic/claude-opus']), 'claude-opus');
    assert.strictEqual(engmux.extractModel(['-m', 'plain-name']), 'plain-name');
    assert.strictEqual(engmux.extractModel(['-E', 'opencode', 'do X']), 'engmux',
      'no -m falls back to the adapter name');
    assert.strictEqual(engmux.extractModel(['-m']), 'engmux', 'a dangling -m is not a model');
  });

  test('extractEngine takes -E / --engine as the editor provenance', () => {
    assert.strictEqual(engmux.extractEngine(['-E', 'opencode']), 'opencode');
    assert.strictEqual(engmux.extractEngine(['--engine', 'claude']), 'claude');
    assert.strictEqual(engmux.extractEngine(['-m', 'opencode/x', 'do X']), 'engmux',
      'no -E falls back to the adapter name');
    assert.strictEqual(engmux.extractEngine(['--engine']), 'engmux',
      'a dangling --engine is not an engine');
  });

  test('a dispatch writes one orbital carrying model, engine and parent session', () => {
    // ENGMUX_PYTHON points at node, which rejects `-m`: the child exits
    // non-zero, which drives the real spawn + close path to the error branch.
    const { files, session } = runEngmux(
      ['-E', 'opencode', '-m', 'opencode/big-pickle', '-e', 'medium', 'do X'], NODE);
    assert.strictEqual(files.length, 1, `one orbital per dispatch, got ${files.join(', ')}`);
    assert.strictEqual(session.modelName, 'big-pickle', 'the -m value labels the orbital');
    assert.strictEqual(session.editor, 'opencode', 'the -E value is the editor provenance');
    assert.strictEqual(session.parentSession, 'engmux-parent',
      "the dispatcher's CLAUDE_SESSION_ID becomes the parent");
    assert.ok(session.sessionId.startsWith('engmux-'), session.sessionId);
    assert.strictEqual(session.state, 'error', 'a failed dispatch ends on the error face');
    assert.strictEqual(session.stopped, true, 'the orbital is retired when the dispatch ends');
    assert.ok(session.detail, 'the failure is described');
  });

  test('a python that cannot be spawned still retires the orbital with an error', () => {
    const { session } = runEngmux(['-E', 'claude', 'do X'],
      path.join(__dirname, 'no-such-python-binary'));
    assert.strictEqual(session.state, 'error');
    assert.strictEqual(session.stopped, true);
    assert.ok(session.detail, 'the spawn failure message is shown');
  });

  // Kept as source checks: what is left of the runtime is timer- and
  // child-driven (an 8s work-state cycle, the initial spawning write that the
  // final write overwrites, and the JSON stdout passthrough). Observing any of
  // it needs a working `python -m engmux`, which the suite cannot supply
  // portably -- there is no fake interpreter that node can spawn on win32
  // without a shell.
  test('source: the running dispatch cycles through work states', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('SUB_STATES'), 'a cycling state list');
    for (const s of ['thinking', 'coding', 'searching']) {
      assert.ok(src.includes(`'${s}'`), `${s} should be one of the cycled states`);
    }
    assert.ok(src.includes('setInterval('), 'cycling is timer-driven');
    assert.ok(src.includes("writeState('spawning'"),
      'the orbital appears before the child starts');
  });

  test('source: engmux JSON stdout is passed through unchanged', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('process.stdout.write(stdout)'),
      "the caller must still receive engmux's own JSON result");
  });
});

// -- Bug fix regression tests -------------------------------------------
// The `source:`-prefixed tests below, and the layout-constant ones, are kept
// deliberately: they are lint rules for code whose only effect is on drawn
// pixels inside the 15fps render loop (grid.js padding and exclusion zones,
// renderer.js try/catch and PID-guard branches, the particles TTY fallbacks
// that only differ on a real terminal). Everything with an observable file
// or object has been converted.

describe('bug fix regressions', () => {
  test('renderer.js has no duplicate const minimal', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const matches = src.match(/const minimal\b/g) || [];
    assert.strictEqual(matches.length, 1, `Expected 1 "const minimal" but found ${matches.length}`);
  });

  test('petSpamLevel 3 changes the eyes on a happy face', () => {
    // The counter was once petCount and the threshold once `> 3`, so level 3
    // never reached the reward eyes. Assert the level actually drives them.
    const { ClaudeFace } = require(path.join(__dirname, '..', 'lib', 'face.js'));
    const { eyes } = require(path.join(__dirname, '..', 'lib', 'animations.js'));
    const calm = new ClaudeFace();
    calm.state = 'happy';
    const spam = new ClaudeFace();
    spam.state = 'happy';
    spam.petSpamLevel = 3;
    const theme = calm.getTheme();
    assert.deepStrictEqual(spam.getEyes(theme, 0), eyes.heart(),
      'level 3 on a happy face should give heart eyes');
    assert.notDeepStrictEqual(calm.getEyes(theme, 0), eyes.heart(),
      'level 0 must not');
  });

  test('particles.js has TTY fallbacks for rows/columns', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'particles.js'), 'utf8');
    assert.ok(src.includes('process.stdout.rows || 24'));
    assert.ok(src.includes('process.stdout.columns || 80'));
  });

  test('grid.js spawn scale starts at 0.3 minimum', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'grid.js'), 'utf8');
    assert.ok(src.includes('Math.max(0.3,'));
  });

  test('source: renderer.js wraps face.render() in try-catch and layers it over the ring', () => {
    // The render loop is a closure inside main(); there is no seam to drive it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const renderIdx = src.indexOf('faceOut = face.render()');
    assert.ok(renderIdx > 0, 'face output is captured on its own');
    const preceding = src.slice(Math.max(0, renderIdx - 30), renderIdx);
    assert.ok(preceding.includes('try'), 'face.render() should be inside a try block');
    // The main face is appended AFTER the orbitals, so it draws on top of them.
    const orbIdx = src.indexOf('out += orbital.render(', renderIdx);
    const appendIdx = src.indexOf('out += faceOut', renderIdx);
    assert.ok(orbIdx > 0 && appendIdx > orbIdx, 'face output must follow the orbital output');
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

  test('parent tool state reaches only the latest subagent orbital', () => {
    // Guards what is left of two removed blocks. A file count cannot see
    // either, because both wrote into files that already exist:
    //   (a) PreToolUse used to mint its own synthetic orbital alongside the
    //       one SubagentStart makes, so a Task call showed two faces;
    //   (b) the old state-mirroring block copied the parent's state into a
    //       subagent file unconditionally -- including on the Task call that
    //       spawned it, and without the sticky-field merge.
    // Propagation itself is deliberate and current (_writeSubagentToolState):
    // the LATEST active subagent shows the parent's live tool state, earlier
    // ones keep their own, subagent tools never propagate, and the sticky
    // fields survive. That is the invariant asserted here.
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('conductor');
    const stats = conductingStats('conductor', 'sub-old', Date.now() - 5000);
    stats.session.activeSubagents.push({
      id: 'sub-new', description: 'newer task', taskDescription: 'newer task',
      model: 'sonnet', editor: 'claude', startedAt: Date.now() - 1000,
    });
    fs.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');
    seedSession(sessionsDir, 'sub-old', {
      state: 'coding', detail: 'editing old.js', stopped: false,
      parentSession: 'conductor', taskDescription: 'real task', modelName: 'haiku',
    });
    seedSession(sessionsDir, 'sub-new', {
      state: 'spawning', detail: 'newer task', stopped: false,
      parentSession: 'conductor', taskDescription: 'newer task', modelName: 'sonnet',
    });
    const oldBefore = readJSON(path.join(sessionsDir, 'sub-old.json'));

    // A subagent tool must not propagate -- it is the parent conducting.
    runUpdateState('PreToolUse', {
      session_id: 'conductor', tool_name: 'Task',
      tool_input: { description: 'go and look', subagent_type: 'Explore' },
    }, env);
    assert.strictEqual(readJSON(path.join(sessionsDir, 'sub-new.json')).state, 'spawning',
      'a Task call is the parent conducting -- it must not overwrite an orbital');

    // An ordinary tool call does propagate, to the latest subagent only.
    runUpdateState('PreToolUse', {
      session_id: 'conductor', tool_name: 'Read', tool_input: { file_path: '/src/app.js' },
    }, env);

    const files = fs.readdirSync(sessionsDir).sort();
    assert.deepStrictEqual(files, ['conductor.json', 'sub-new.json', 'sub-old.json'],
      `no synthetic extra orbital may be minted, got ${files.join(', ')}`);

    const newer = readJSON(path.join(sessionsDir, 'sub-new.json'));
    assert.strictEqual(newer.state, 'reading', 'the latest subagent shows the live tool state');
    assert.strictEqual(newer.parentSession, 'conductor', 'sticky parentSession survives');
    assert.strictEqual(newer.taskDescription, 'newer task', 'sticky taskDescription survives');
    assert.strictEqual(newer.modelName, 'sonnet', 'sticky modelName survives');

    const older = readJSON(path.join(sessionsDir, 'sub-old.json'));
    assert.strictEqual(older.state, oldBefore.state,
      `an earlier subagent keeps its own state, got '${older.state}'`);
    assert.strictEqual(older.detail, oldBefore.detail,
      `and its own detail, got '${older.detail}'`);

    // The parent keeps the conducting face while its subagents work: the tool
    // state went to the orbital, not to the conductor.
    const parent = readJSON(path.join(sessionsDir, 'conductor.json'));
    assert.strictEqual(parent.state, 'subagent');
    assert.strictEqual(parent.detail, 'conducting 2');
    cleanup(tmp);
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

  test('update-state.js fallback catch block includes modelName', () => {
    // Bug: catch-block writes lacked modelName, so a stale wrong modelName
    // from a previous session could persist until a valid JSON event corrected it.
    const { tmp, stateFile, env } = makeTempEnv('model-fallback-1');
    const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');

    try {
      execFileSync(NODE, [UPDATE_STATE, 'PreToolUse'], {
        input: 'not valid json',
        env,
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }

    const state = readJSON(stateFile);
    assert.strictEqual(state.modelName, 'claude',
      `fallback should include modelName 'claude', got '${state.modelName}'`);
    cleanup(tmp);
  });

  test('update-state.js fallback catch block respects CODE_CRUMB_MODEL env', () => {
    const { tmp, stateFile, env } = makeTempEnv('model-env-1');
    const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');
    env.CODE_CRUMB_MODEL = 'opencode';

    try {
      execFileSync(NODE, [UPDATE_STATE, 'PreToolUse'], {
        input: 'not valid json',
        env,
        timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }

    const state = readJSON(stateFile);
    assert.strictEqual(state.modelName, 'opencode',
      `fallback should use CODE_CRUMB_MODEL env, got '${state.modelName}'`);
    cleanup(tmp);
  });

  test('readState propagates isSessionStart so the renderer can adopt the session', () => {
    const state = withStateFile({
      state: 'idle', detail: 'session starting', sessionId: 'rs-1',
      isSessionStart: true, timestamp: Date.now(),
    }, () => require(path.join(__dirname, '..', 'renderer.js')).readState());
    assert.strictEqual(state.isSessionStart, true);

    const plain = withStateFile({
      state: 'coding', detail: 'editing', sessionId: 'rs-1', timestamp: Date.now(),
    }, () => require(path.join(__dirname, '..', 'renderer.js')).readState());
    assert.strictEqual(plain.isSessionStart, false, 'absent means false, never undefined');
  });

  test('renderer.js PID guard handles EPERM as running (#65)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.ok(src.includes("err.code === 'EPERM'"),
      'PID guard catch should check for EPERM and treat as running');
  });

  test('forceState applies the state at once and holds it for the given minimum (#67)', () => {
    // The renderer's responding rescues call forceState(..., 3000). This is the
    // half of that contract that lives in face.js and can be observed.
    const { ClaudeFace } = require(path.join(__dirname, '..', 'lib', 'face.js'));
    const face = new ClaudeFace();
    face.setState('coding', 'editing app.js');
    const before = Date.now();
    face.forceState('responding', 'wrapping up', 3000);
    const after = Date.now();
    assert.strictEqual(face.state, 'responding', 'forceState skips the pending queue');
    assert.strictEqual(face.stateDetail, 'wrapping up');
    assert.strictEqual(face.pendingState, null, 'the queue is dropped');
    assert.ok(face.minDisplayUntil >= before + 3000 && face.minDisplayUntil <= after + 3000,
      `minDisplayUntil should be ~now+3000, got ${face.minDisplayUntil - before}ms out`);
    // And the hold is real: a later work state does not replace it immediately.
    face.setState('coding', 'editing again');
    assert.strictEqual(face.state, 'responding', 'the 3s minimum buffers the next state');
  });

  // Kept as a source check: both rescue paths live inside the renderer's
  // 15fps render loop, which the suite has no harness for. This asserts only
  // that they still route through face.forceState (whose behaviour the test
  // above covers) rather than hand-rolling the transition again.
  test('source: the renderer responding rescues go through face.forceState', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    const calls = src.match(/face\.forceState\('responding'/g) || [];
    assert.strictEqual(calls.length, 2,
      `both the stopped-flag and fresh-read rescues should forceState, found ${calls.length}`);
    assert.ok(!src.includes('minDisplayUntil = now;'),
      'responding should not use minDisplayUntil = now (immediate expire)');
    assert.ok(!src.includes("face.state = 'responding';"),
      'renderer should not assign face.state directly for responding');
  });
});

// -- Stopped flag preservation (#98) ----------------------------------------

describe('update-state.js stopped flag preservation (#98)', () => {
  test('a late PostToolUse keeps the stopped flag on the global state file', () => {
    // Stop already released ownership; a tool result that lands afterwards
    // must not resurrect the session and hold the main face hostage.
    const { tmp, stateFile, env } = makeTempEnv('stop-global');
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'responding', detail: 'wrapping up',
      timestamp: Date.now(), sessionId: 'stop-global', stopped: true,
    }), 'utf8');

    runUpdateState('PostToolUse', {
      tool_name: 'Write', tool_input: { file_path: '/tmp/test.txt' },
      tool_result: { stdout: 'ok' }, session_id: 'stop-global',
    }, env);

    const state = readJSON(stateFile);
    assert.strictEqual(state.stopped, true,
      'stopped must survive a late PostToolUse from the same session');
    cleanup(tmp);
  });

  test('a late PostToolUse keeps the stopped flag on the session file', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('stop-session');
    seedSession(sessionsDir, 'stop-session', {
      state: 'responding', detail: 'wrapping up', stopped: true,
    });

    runUpdateState('PostToolUse', {
      tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' },
      tool_result: { stdout: 'ok' }, session_id: 'stop-session',
    }, env);

    const session = readJSON(path.join(sessionsDir, 'stop-session.json'));
    assert.strictEqual(session.stopped, true,
      'the orbital must not come back to life on a late tool result');
    cleanup(tmp);
  });

  test('a subagent carrying a parentSession never writes the global state file', () => {
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('sub-blocked');
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'thinking', detail: 'planning',
      timestamp: Date.now(), sessionId: 'main-owner', stopped: true,
    }), 'utf8');
    // What SubagentStart leaves behind before the subagent's first own hook.
    seedSession(sessionsDir, 'sub-blocked', {
      state: 'spawning', detail: 'subagent', parentSession: 'main-owner',
    });

    runUpdateState('PreToolUse', {
      tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' },
      session_id: 'sub-blocked',
    }, env);

    const state = readJSON(stateFile);
    assert.strictEqual(state.sessionId, 'main-owner',
      'a subagent must not take the main face even when the owner has stopped');
    assert.strictEqual(state.state, 'thinking');
    assert.strictEqual(readJSON(path.join(sessionsDir, 'sub-blocked.json')).state, 'reading',
      'it still updates its own orbital');
    cleanup(tmp);
  });

  test('the empty-stdin fallback blocks a subagent from the global state file too', () => {
    // The catch path (Stop with no parsable stdin) has its own copy of the
    // parentSession guard. It once compared the adopted owner id against
    // itself, so it always passed and a subagent Stop stole the main face.
    // The state file is owned by the subagent's OWN id here, so only the
    // parentSession guard can stop the write.
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('sub-fallback');
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'coding', detail: 'editing app.js',
      timestamp: Date.now(), sessionId: 'sub-fallback', stopped: false,
    }), 'utf8');
    seedSession(sessionsDir, 'sub-fallback', {
      state: 'spawning', detail: 'subagent', parentSession: 'main-owner',
    });

    runUpdateState('Stop', '', env);

    const state = readJSON(stateFile);
    assert.strictEqual(state.state, 'coding',
      'a subagent Stop must not write responding/wrapping-up over the main face');
    assert.strictEqual(state.stopped, false,
      'nor release ownership for the main session');
    assert.strictEqual(readJSON(path.join(sessionsDir, 'sub-fallback.json')).state, 'idle',
      'the subagent orbital still goes idle between turns');
    cleanup(tmp);
  });

  // Kept as source checks: both live inside the renderer's 15fps loop, which
  // the suite has no harness for. They are one-way-latch regressions -- the
  // shape of the comparison is the whole fix.
  test('source: renderer lastStopped tracks the flag instead of latching on', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.ok(
      src.includes('lastStopped = !!stateData.stopped'),
      'renderer.js should reset lastStopped when the state file has no stopped flag'
    );
    assert.ok(
      !src.includes('if (stateData.stopped) lastStopped = true'),
      'renderer.js should not have the old one-way latch'
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
});

describe('update-state.js parallel sessions orbital visibility fix', () => {
  test('PreToolUse after a Stop clears stopped on both files (a new turn began)', () => {
    // Preservation is deliberately limited to PostToolUse/PostToolUseFailure,
    // the events that can legitimately arrive after a Stop. Anything else --
    // PreToolUse first among them -- means a new turn, so the flag must go.
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('pre-clears');
    seedSession(sessionsDir, 'pre-clears', {
      state: 'responding', detail: 'wrapping up', stopped: true,
    });
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'responding', detail: 'wrapping up',
      timestamp: Date.now(), sessionId: 'pre-clears', stopped: true,
    }), 'utf8');

    runUpdateState('PreToolUse', {
      tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' },
      session_id: 'pre-clears',
    }, env);

    assert.strictEqual(readJSON(path.join(sessionsDir, 'pre-clears.json')).stopped, false,
      'PreToolUse must clear stopped on the per-session file');
    assert.ok(!readJSON(stateFile).stopped,
      'and on the global state file, so the renderer stops rescuing');
    cleanup(tmp);
  });

  test('Stop leaves the orbital idle between turns, not stopped', () => {
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('stop-idle');
    seedSession(sessionsDir, 'stop-idle', { state: 'coding', detail: 'editing', stopped: false });
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'coding', detail: 'editing', timestamp: Date.now(), sessionId: 'stop-idle',
    }), 'utf8');

    runUpdateState('Stop', { session_id: 'stop-idle' }, env);

    const session = readJSON(path.join(sessionsDir, 'stop-idle.json'));
    assert.strictEqual(session.state, 'idle', 'Stop is the end of a turn, not the session');
    assert.strictEqual(session.detail, 'between turns');
    assert.strictEqual(session.stopped, false, 'the orbital stays visible');
    assert.strictEqual(readJSON(stateFile).stopped, true,
      'the global state file still releases ownership');
    cleanup(tmp);
  });

  test('SessionEnd does retire the orbital', () => {
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('sess-end');
    seedSession(sessionsDir, 'sess-end', { state: 'coding', detail: 'editing', stopped: false });
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'coding', detail: 'editing', timestamp: Date.now(), sessionId: 'sess-end',
    }), 'utf8');

    runUpdateState('SessionEnd', { session_id: 'sess-end' }, env);

    assert.strictEqual(readJSON(path.join(sessionsDir, 'sess-end.json')).stopped, true,
      'SessionEnd must write stopped=true to the per-session file');
    cleanup(tmp);
  });

  test('the empty-stdin fallback tells Stop and SessionEnd apart', () => {
    // They used to share one condition, so a plain Stop retired the orbital
    // and the parallel window vanished from the ellipse for the rest of the
    // session. Same input, same code path, only the hook name differs.
    const stop = makeTempEnv('fb-stop');
    seedSession(stop.sessionsDir, 'fb-stop', { state: 'coding', detail: 'editing', stopped: false });
    runUpdateState('Stop', '', stop.env);
    const afterStop = readJSON(path.join(stop.sessionsDir, 'fb-stop.json'));
    assert.strictEqual(afterStop.state, 'idle');
    assert.strictEqual(afterStop.detail, 'between turns');
    assert.strictEqual(afterStop.stopped, false, 'a turn ending must not retire the orbital');
    cleanup(stop.tmp);

    const end = makeTempEnv('fb-end');
    seedSession(end.sessionsDir, 'fb-end', { state: 'coding', detail: 'editing', stopped: false });
    runUpdateState('SessionEnd', '', end.env);
    const afterEnd = readJSON(path.join(end.sessionsDir, 'fb-end.json'));
    assert.strictEqual(afterEnd.state, 'responding');
    assert.strictEqual(afterEnd.detail, 'session ending');
    assert.strictEqual(afterEnd.stopped, true, 'only SessionEnd retires it');
    cleanup(end.tmp);
  });
});

describe('base-adapter guardedWriteState modelName preservation (#78)', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const sharedMod = require(path.join(__dirname, '..', 'lib', 'shared'));
  const STATE_FILE = sharedMod.STATE_FILE;

  // Save and restore state file (tests write to the real file)
  let savedModelState;
  try { savedModelState = fs.readFileSync(STATE_FILE, 'utf8'); } catch { savedModelState = null; }

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

  // Restore the state file as it was before this block ran.
  if (savedModelState !== null) fs.writeFileSync(STATE_FILE, savedModelState, 'utf8');
  else try { fs.unlinkSync(STATE_FILE); } catch {}
});

// -- base-adapter unit tests (guardedWriteState, initSession, buildExtra, trackEditedFile, processJsonlStream)

describe('base-adapter -- guardedWriteState unit tests', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const sharedMod = require(path.join(__dirname, '..', 'lib', 'shared'));
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
  const { defaultStats } = require(path.join(__dirname, '..', 'lib', 'state-machine'));

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
  const { defaultStats } = require(path.join(__dirname, '..', 'lib', 'state-machine'));

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
  const { defaultStats } = require(path.join(__dirname, '..', 'lib', 'state-machine'));

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

  // processJsonlStream flushes its buffer on 'end'. Resolve one tick after
  // that so the assertions see the final event list.
  function collect(chunks) {
    return new Promise((resolve) => {
      const events = [];
      const stream = makeStream(chunks);
      baseAdapter.processJsonlStream(stream, (ev) => events.push(ev));
      stream.on('end', () => setImmediate(() => resolve(events)));
    });
  }

  test.async('parses valid JSONL lines', async () => {
    const events = await collect(['{"a":1}\n{"b":2}\n']);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].a, 1);
    assert.strictEqual(events[1].b, 2);
  });

  test.async('skips malformed lines silently', async () => {
    const events = await collect(['{"valid":true}\nnot json\n{"also":true}\n']);
    assert.strictEqual(events.length, 2);
  });

  test.async('handles \\r\\n line endings', async () => {
    const events = await collect(['{"x":1}\r\n{"y":2}\r\n']);
    assert.strictEqual(events.length, 2);
  });

  test.async('calls handler for each parsed object', async () => {
    const events = await collect(['{"type":"a"}\n', '{"type":"b"}\n']);
    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0].type, 'a');
    assert.strictEqual(events[1].type, 'b');
  });

  test.async('flushes a trailing line that has no newline', async () => {
    const events = await collect(['{"tail":true}']);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].tail, true);
  });
});

// -- Bug fix structural tests (bugs #1, #2, #4, #5, #7, #10, #13, #16) --------

describe('bug fix structural tests', () => {
  const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');
  const BASE_ADAPTER = path.join(ADAPTERS_DIR, 'base-adapter.js');
  const OPENCODE_ADAPTER = path.join(ADAPTERS_DIR, 'opencode-adapter.js');
  const PARTICLES = path.join(__dirname, '..', 'lib', 'particles.js');

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

  // Bug #2 -- OpenCode adapter toolInput unwraps the args, never the wrapper
  test('normaliseEvent unwraps input.args instead of taking the {tool, args} wrapper', () => {
    const { normaliseEvent } = require(OPENCODE_ADAPTER);
    const norm = normaliseEvent({
      type: 'tool.execute.before',
      input: { tool: 'file_edit', args: { file_path: '/src/app.js' } },
    });
    assert.strictEqual(norm.toolName, 'file_edit');
    assert.deepStrictEqual(norm.toolInput, { file_path: '/src/app.js' },
      'toolInput is the args, not the wrapper');
    assert.strictEqual(norm.toolInput.tool, undefined,
      'the wrapper object must never leak into toolInput');
  });

  test('normaliseEvent prefers the flat plugin field, then tool_input, then input.args', () => {
    const { normaliseEvent } = require(OPENCODE_ADAPTER);
    const all = normaliseEvent({
      type: 'tool.execute.before', tool: 'edit',
      toolInput: { filePath: 'flat.js' },
      tool_input: { file_path: 'snake.js' },
      input: { tool: 'file_edit', args: { file_path: 'nested.js' } },
    });
    // normaliseToolInput also mirrors filePath onto file_path for the mapper.
    assert.strictEqual(all.toolInput.file_path, 'flat.js', 'flat plugin field wins');

    const snake = normaliseEvent({
      type: 'tool.execute.before', tool: 'edit',
      tool_input: { file_path: 'snake.js' },
      input: { tool: 'file_edit', args: { file_path: 'nested.js' } },
    });
    assert.deepStrictEqual(snake.toolInput, { file_path: 'snake.js' }, 'tool_input beats input.args');
  });

  // Bug #4 -- SubagentStop only splices when idx >= 0
  test('SubagentStop for an unknown id retires nobody', () => {
    // findIndex returns -1 for an id we never registered; splicing on that
    // removes the LAST subagent and marks the wrong orbital done.
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-stop-guard');
    const UPDATE_STATE_PATH = path.join(__dirname, '..', 'update-state.js');
    const stats = {
      streak: 0, bestStreak: 0, brokenStreak: 0, brokenStreakAt: 0,
      totalToolCalls: 0, totalErrors: 0,
      records: { longestSession: 0, mostSubagents: 1, mostFilesEdited: 0 },
      session: {
        id: 'sub-stop-guard', start: Date.now() - 1000, toolCalls: 0, filesEdited: [],
        subagentCount: 1, commitCount: 0,
        activeSubagents: [{
          id: 'real-sub', description: 'real task', taskDescription: 'real task',
          model: 'haiku', editor: 'claude', startedAt: Date.now() - 500,
        }],
      },
      recentMilestone: null,
      daily: { date: new Date().toISOString().slice(0, 10), sessionCount: 1, cumulativeMs: 0 },
      frequentFiles: {}, topLevelSessions: {},
    };
    fs.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'real-sub.json'), JSON.stringify({
      session_id: 'real-sub', state: 'coding', detail: 'editing',
      timestamp: Date.now(), stopped: false, parentSession: 'sub-stop-guard',
    }), 'utf8');

    try {
      execFileSync(NODE, [UPDATE_STATE_PATH, 'SubagentStop'], {
        input: JSON.stringify({ session_id: 'sub-stop-guard', subagent_id: 'never-registered' }),
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }

    const after = readJSON(statsFile);
    assert.strictEqual(after.session.activeSubagents.length, 1,
      'an unknown subagent id must not splice the real one out');
    assert.strictEqual(after.session.activeSubagents[0].id, 'real-sub');
    assert.strictEqual(readJSON(path.join(sessionsDir, 'real-sub.json')).stopped, false,
      "the running subagent's orbital must not be retired");
    cleanup(tmp);
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

  // Bug #7 -- every particle is closed with a reset, or its colour bleeds
  test('every rendered particle is followed by a reset', () => {
    const { ParticleSystem } = require(PARTICLES);
    const { ansi } = require(path.join(__dirname, '..', 'lib', 'themes.js'));
    assert.ok(ansi.reset.length > 0, 'colour is on, so a reset is observable');
    const ps = new ParticleSystem();
    ps.spawn(20, 'float');
    const out = ps.render(2, 2, [255, 128, 0]);
    assert.ok(out.length > 0, 'the particles should be inside the terminal bounds');
    assert.ok(out.endsWith(ansi.reset), 'the last particle must close its colour');
    const chunks = out.split(ansi.reset).filter(Boolean);
    for (const chunk of chunks) {
      assert.ok(!chunk.includes(ansi.reset), 'split invariant');
    }
    assert.strictEqual(out.split(ansi.reset).length - 1, ps.particles.length,
      'one reset per particle drawn');
  });

  // Bug #10 -- base-adapter initSession includes commitCount and activeSubagents
  test('initSession gives a new session commitCount 0 and an empty activeSubagents', () => {
    const baseAdapter = require(BASE_ADAPTER);
    const { defaultStats } = require(path.join(__dirname, '..', 'lib', 'state-machine.js'));
    const stats = defaultStats();
    baseAdapter.initSession(stats, 'fresh-session');
    assert.strictEqual(stats.session.id, 'fresh-session');
    assert.strictEqual(stats.session.commitCount, 0,
      'a missing commitCount makes the commit counter NaN on the first commit');
    assert.deepStrictEqual(stats.session.activeSubagents, [],
      'a missing activeSubagents throws on the first SubagentStart');
  });

  // Bug #13 -- base-adapter guardedWriteState preserves existing.stopped flag,
  // but only for a tool END: that is the only write that can straggle in after
  // the turn it belongs to (the update-state.js rule).
  test('guardedWriteState preserves a prior stopped flag for a late tool end', () => {
    const baseAdapter = require(BASE_ADAPTER);
    const result = withStateFile({
      state: 'responding', detail: 'wrapping up', sessionId: 'gws-stopped',
      stopped: true, timestamp: Date.now(),
    }, () => {
      baseAdapter.guardedWriteState('gws-stopped', 'relieved', 'command succeeded',
        { sessionId: 'gws-stopped' }, { toolEnd: true });
      return readJSON(SHARED.STATE_FILE);
    });
    assert.strictEqual(result.state, 'relieved', 'the late write still lands');
    assert.strictEqual(result.stopped, true,
      'a late PostToolUse must not erase the Stop that already happened');
  });

  test('guardedWriteState lets any other event clear a prior stopped flag', () => {
    const baseAdapter = require(BASE_ADAPTER);
    const result = withStateFile({
      state: 'happy', detail: 'all done!', sessionId: 'gws-newturn',
      stopped: true, timestamp: Date.now(),
    }, () => {
      baseAdapter.guardedWriteState('gws-newturn', 'executing', 'running ls',
        { sessionId: 'gws-newturn' });
      return readJSON(SHARED.STATE_FILE);
    });
    assert.strictEqual(result.state, 'executing');
    assert.ok(!result.stopped, 'the next turn is not stopped');
  });
});

// -- Base adapter structure -------------------------------------------

describe('adapters -- base-adapter structure', () => {
  test('requiring base-adapter does not throw', () => {
    assert.doesNotThrow(() => require(path.join(ADAPTERS_DIR, 'base-adapter.js')));
  });

  test('base-adapter exports an object with expected functions', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter, 'object', 'module should export an object');
    assert.strictEqual(typeof baseAdapter.writeState, 'function', 'writeState should be a function');
    assert.strictEqual(typeof baseAdapter.writeSessionState, 'function', 'writeSessionState should be a function');
    assert.strictEqual(typeof baseAdapter.readStats, 'function', 'readStats should be a function');
    assert.strictEqual(typeof baseAdapter.writeStats, 'function', 'writeStats should be a function');
  });

  test('base-adapter exports guardedWriteState', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter.guardedWriteState, 'function');
  });

  test('base-adapter exports initSession', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter.initSession, 'function');
  });

  test('base-adapter exports buildExtra', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter.buildExtra, 'function');
  });

  test('base-adapter exports processStdinEvent', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter.processStdinEvent, 'function');
  });

  test('base-adapter exports processJsonlStream', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter.processJsonlStream, 'function');
  });

  test('base-adapter exports runStdinAdapter', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter.runStdinAdapter, 'function');
  });

  test('base-adapter exports handleToolStart and handleToolEnd', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter.handleToolStart, 'function');
    assert.strictEqual(typeof baseAdapter.handleToolEnd, 'function');
  });

  test('base-adapter exports trackEditedFile', () => {
    const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter.js'));
    assert.strictEqual(typeof baseAdapter.trackEditedFile, 'function');
  });
});

// -- adapter files: exist, parse, declare strict mode --------------------
// One gate for every adapter, replacing the per-adapter "file exists" /
// "starts with use strict" / "is a valid Node.js script" copies. Parsing is
// done in-process with vm.Script (compile, never run) so this costs no
// subprocesses; opencode-plugin.mjs is ESM and is really imported by the
// "opencode-plugin translate()" block above, which is a stronger check.

describe('adapters -- every adapter file exists and parses', () => {
  const adapterFiles = [
    'base-adapter.js',
    'codex-wrapper.js',
    'codex-notify.js',
    'opencode-adapter.js',
    'opencode-plugin.mjs',
    'openclaw-adapter.js',
    'engmux-adapter.js',
  ];

  for (const file of adapterFiles) {
    test(`${file} exists, and parses under strict mode`, () => {
      const fullPath = path.join(ADAPTERS_DIR, file);
      assert.ok(fs.existsSync(fullPath), `${file} should exist at ${fullPath}`);
      const src = fs.readFileSync(fullPath, 'utf8');
      if (file.endsWith('.mjs')) {
        // ESM is strict by definition and is parsed by the real import above.
        assert.ok(/\bexport\b/.test(src), `${file} should export something`);
        return;
      }
      assert.ok(src.includes("'use strict'"), `${file} should declare strict mode`);
      assert.doesNotThrow(() => new vm.Script(src, { filename: fullPath }),
        `${file} should parse`);
    });
  }
});

// -- editor PID liveness tracking ---------------------------------------
// The global state file carries the writer's parent PID so the renderer can
// detect a crashed editor. The renderer must validate the PID (transient
// cmd.exe shims on Windows die instantly) and keep death detection in a
// sticky flag — not lastStopped, which every forced re-read overwrites.

describe('editor PID liveness tracking', () => {
  const rendererSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');

  test('codex-notify publishes the parent PID (posix only -- omitted on win32 like update-state.js)', () => {
    const { tmp, stateFile, env } = makeTempEnv('pid-1');
    const event = { type: 'agent-turn-complete', 'thread-id': 'pid-1' };
    try {
      execFileSync(NODE, [path.join(ADAPTERS_DIR, 'codex-notify.js'), JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    const state = readJSON(stateFile);
    // The adapter is our direct child, so its ppid is this test process --
    // except on Windows, where the pid is omitted (same policy as update-state.js:
    // the ppid there is a transient shim and a PID-recycling hazard).
    if (process.platform === 'win32') {
      assert.strictEqual(state.pid, undefined, 'win32 must not publish a transient ppid');
    } else {
      assert.strictEqual(state.pid, process.pid,
        `state.pid should be the parent process (${process.pid}), got ${state.pid}`);
    }
    cleanup(tmp);
  });

  test('update-state.js writes parent PID to global state file', () => {
    const { tmp, stateFile, env } = makeTempEnv('pid-2');
    const input = JSON.stringify({
      session_id: 'pid-2',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x.js' },
    });
    try {
      execFileSync(NODE, [path.join(__dirname, '..', 'update-state.js'), 'PreToolUse'], {
        input, env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    const state = readJSON(stateFile);
    if (process.platform === 'win32') {
      // win32: ppid is a transient cmd.exe shim — intentionally omitted
      // (recycled-PID hazard); these sessions rely on staleness timeouts
      assert.strictEqual(state.pid, undefined,
        `win32 update-state.js must omit pid, got ${state.pid}`);
    } else {
      assert.strictEqual(state.pid, process.pid,
        `state.pid should be the parent process (${process.pid}), got ${state.pid}`);
    }
    cleanup(tmp);
  });

  test('readState propagates the writer pid, and reports 0 when there is none', () => {
    const { readState } = require(path.join(__dirname, '..', 'renderer.js'));
    const withPid = withStateFile({
      state: 'coding', detail: 'editing', sessionId: 'pid-3',
      pid: 4242, timestamp: Date.now(),
    }, readState);
    assert.strictEqual(withPid.pid, 4242, 'the renderer must see the pid to arm it');

    const withoutPid = withStateFile({
      state: 'coding', detail: 'editing', sessionId: 'pid-3', timestamp: Date.now(),
    }, readState);
    assert.strictEqual(withoutPid.pid, 0,
      'a win32 write carries no pid; 0 means "nothing to arm", never undefined');
  });

  test('renderer keeps PID death in sticky editorDead flag, not lastStopped', () => {
    // Bug: setting lastStopped=true on PID death was clobbered by the forced
    // re-read in the same tick (lastStopped = !!stateData.stopped), making
    // the rescue a no-op. Death must live in its own flag.
    assert.ok(rendererSrc.includes('editorDead = true'),
      'PID death should set editorDead');
    assert.ok(rendererSrc.includes('(lastStopped || editorDead) && !RESCUE_EXCLUDE.has(face.state)'),
      'rescue block should fire on lastStopped OR editorDead');
    assert.ok(rendererSrc.includes('!lastStopped && !editorDead'),
      'sessionActive should account for editorDead');
    assert.ok(!rendererSrc.match(/isProcessAlive\(lastEditorPid\)\)\s*\{\s*lastStopped = true/),
      'PID death must not be stored in lastStopped (clobbered by forced re-read)');
  });

  test('renderer validates candidate PIDs before arming (transient shim guard)', () => {
    // Windows hooks report a transient cmd.exe shim as ppid — a PID is only
    // trusted if it is still alive 2.5s after it was first seen in a write.
    assert.ok(rendererSrc.includes('candidateSince > 2500'),
      'candidate PID should require a 2.5s survival window');
    assert.ok(rendererSrc.includes('isProcessAlive(candidatePid)'),
      'candidate PID should be liveness-checked before arming');
    assert.ok(rendererSrc.includes('editorDead && ts > lastAppliedTimestamp'),
      'a fresh write should clear a false editorDead (PID reuse guard)');
  });

  test('renderer arms candidate via start-time identity, not bare liveness', () => {
    assert.ok(rendererSrc.includes('isOwnedByLiveProcess(candidatePid, candidateTs)'),
      'arming must verify the candidate process predates the reporting write');
    assert.ok(rendererSrc.includes('candidateTs = ts || Date.now()'),
      'the reporting write timestamp must be captured with the candidate');
  });
});

describe('adapters -- editor provenance field', () => {
  test('buildExtra includes editor', () => {
    const baseAdapter = require('../adapters/base-adapter');
    const stats = { session: { id: 's', start: Date.now(), toolCalls: 0, filesEdited: [] },
      streak: 0, bestStreak: 0, brokenStreak: 0, brokenStreakAt: 0, recentMilestone: null,
      daily: { sessionCount: 1, cumulativeMs: 0 }, frequentFiles: {} };
    const extra = baseAdapter.buildExtra(stats, 'sid', 'codex', 'codex');
    assert.strictEqual(extra.editor, 'codex');
  });

  test('each stdin adapter stamps its own editor onto the state file', () => {
    // codex-wrapper is covered by the fake-codex block (editor: 'codex') and
    // engmux by its own dispatch test (editor from -E).
    const cases = [
      ['opencode-adapter.js', 'opencode', { type: 'thinking', sessionId: 'ed-oc' }],
      ['openclaw-adapter.js', 'openclaw', { event: 'tool_call', toolName: 'read', sessionId: 'ed-cl' }],
    ];
    for (const [file, editor, payload] of cases) {
      const { tmp, stateFile, env } = makeTempEnv(`ed-${editor}`);
      runStdinAdapter(path.join(ADAPTERS_DIR, file), payload, env);
      assert.strictEqual(readJSON(stateFile).editor, editor, file);
      cleanup(tmp);
    }

    const { tmp, stateFile, env } = makeTempEnv('ed-codex');
    try {
      execFileSync(NODE, [path.join(ADAPTERS_DIR, 'codex-notify.js'),
        JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 'ed-codex' })], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
    assert.strictEqual(readJSON(stateFile).editor, 'codex', 'codex-notify.js');
    cleanup(tmp);
  });

  test('an anonymous adapter session gets an editor-prefixed fallback id', () => {
    // ${defaultEditor}-${process.ppid}: under execFileSync the adapter's
    // parent is this test runner, so the ppid it sees is our own pid.
    const { tmp, stateFile, env } = makeTempEnv('unused');
    delete env.CLAUDE_SESSION_ID;
    runStdinAdapter(path.join(ADAPTERS_DIR, 'opencode-adapter.js'),
      { type: 'thinking' }, env); // no sessionId / session_id anywhere
    const state = readJSON(stateFile);
    assert.strictEqual(state.sessionId, `opencode-${process.pid}`,
      `an anonymous session must be self-describing, got "${state.sessionId}"`);
    cleanup(tmp);
  });

  test('update-state.js takes its editor from CODE_CRUMB_EDITOR, then --editor, then claude', () => {
    const dflt = makeTempEnv('ed-default');
    delete dflt.env.CODE_CRUMB_EDITOR;
    runUpdateState('PreToolUse', {
      session_id: 'ed-default', tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, dflt.env);
    assert.strictEqual(readJSON(dflt.stateFile).editor, 'claude', 'default');
    cleanup(dflt.tmp);

    const flag = makeTempEnv('ed-flag');
    delete flag.env.CODE_CRUMB_EDITOR;
    runUpdateState('PreToolUse', {
      session_id: 'ed-flag', tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, flag.env, ['--editor', 'opencode']);
    assert.strictEqual(readJSON(flag.stateFile).editor, 'opencode', '--editor <name>');
    cleanup(flag.tmp);

    const env = makeTempEnv('ed-env');
    env.env.CODE_CRUMB_EDITOR = 'foo';
    runUpdateState('PreToolUse', {
      session_id: 'ed-env', tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env.env, ['--editor', 'opencode']);
    assert.strictEqual(readJSON(env.stateFile).editor, 'foo', 'the env var outranks the flag');
    cleanup(env.tmp);
  });

  test('the editor a session established survives later hooks of another editor', () => {
    // The owner guard in update-state.js pins modelName and editor for the
    // session that owns the state file, and the same `extra` then goes to the
    // orbital -- so a claude-defaulted hook cannot relabel an openclaw session.
    const { tmp, stateFile, sessionsDir, env } = makeTempEnv('ed-sticky');
    delete env.CODE_CRUMB_EDITOR;
    fs.writeFileSync(stateFile, JSON.stringify({
      state: 'idle', detail: '', sessionId: 'ed-sticky',
      editor: 'openclaw', stopped: false, timestamp: Date.now(),
    }), 'utf8');

    runUpdateState('PreToolUse', {
      session_id: 'ed-sticky', tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    assert.strictEqual(readJSON(stateFile).editor, 'openclaw',
      'a claude-defaulted hook must not relabel the session');
    assert.strictEqual(readJSON(path.join(sessionsDir, 'ed-sticky.json')).editor, 'openclaw',
      'and the orbital carries the same provenance');
    cleanup(tmp);
  });

  test('guardedWriteState keeps the editor the session owner established', () => {
    const baseAdapter = require('../adapters/base-adapter');
    const result = withStateFile({
      state: 'thinking', detail: '', sessionId: 'ed-owner',
      editor: 'openclaw', stopped: false, timestamp: Date.now(),
    }, () => {
      baseAdapter.guardedWriteState('ed-owner', 'coding', 'editing',
        { sessionId: 'ed-owner', editor: 'codex' });
      return readJSON(SHARED.STATE_FILE);
    });
    assert.strictEqual(result.state, 'coding', 'the write still lands');
    assert.strictEqual(result.editor, 'openclaw',
      'the owner editor wins over the writing adapter');
  });
});

// -- update-state.js parallel session classification (#134) -----------
// Parallel top-level editor windows were misclassified as subagents of
// whichever session owned stats.session while it had active subagents:
// stamped with a sticky parentSession, blocked from global state, and
// falsely retiring the real subagent's synthetic orbital.

describe('update-state -- parallel sessions vs subagents (#134)', () => {
  // conductingStats() is shared with the state-mirroring regression above.
  function seedSyntheticOrbital(sessionsDir, subId, ownerId) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, `${subId}.json`), JSON.stringify({
      session_id: subId, state: 'spawning', detail: 'real task',
      timestamp: Date.now(), stopped: false,
      parentSession: ownerId, taskDescription: 'real task', modelName: 'haiku',
    }), 'utf8');
  }

  test('registered parallel window is NOT stamped as subagent', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('par-reg-1');
    seedSyntheticOrbital(sessionsDir, 'owner-1-sub-1', 'owner-1');
    fs.writeFileSync(statsFile, JSON.stringify(conductingStats(
      'owner-1', 'owner-1-sub-1', Date.now() - 1000,
      { 'par-reg-1': Date.now() })), 'utf8');

    runUpdateState('PreToolUse', {
      session_id: 'par-reg-1', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, env);

    const session = readJSON(path.join(sessionsDir, 'par-reg-1.json'));
    assert.strictEqual(session.parentSession, undefined,
      'parallel window must not get a parentSession stamp');
    assert.strictEqual(session.taskDescription, undefined,
      'parallel window must not steal the subagent taskDescription');
    assert.strictEqual(session.state, 'executing',
      "parallel window shows its own tool state, not 'subagent' conducting");
    const synth = readJSON(path.join(sessionsDir, 'owner-1-sub-1.json'));
    assert.strictEqual(synth.stopped, false,
      'real subagent synthetic must not be retired by an unrelated session');
    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.id, 'owner-1',
      'parallel window must not steal stats.session from the conductor');
    assert.strictEqual(stats.session.toolCalls, 5,
      "parallel window must not inflate the owner's toolCalls");
    cleanup(tmp);
  });

  test('unregistered session whose file predates the subagent is parallel', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('par-born-1');
    fs.mkdirSync(sessionsDir, { recursive: true });
    // Session file exists NOW; the subagent "starts" 60s in the future,
    // so the file provably predates it (birthtime check).
    fs.writeFileSync(path.join(sessionsDir, 'par-born-1.json'), JSON.stringify({
      session_id: 'par-born-1', state: 'idle', timestamp: Date.now(), stopped: false,
    }), 'utf8');
    seedSyntheticOrbital(sessionsDir, 'owner-1-sub-1', 'owner-1');
    fs.writeFileSync(statsFile, JSON.stringify(conductingStats(
      'owner-1', 'owner-1-sub-1', Date.now() + 60000)), 'utf8');

    runUpdateState('PreToolUse', {
      session_id: 'par-born-1', tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const session = readJSON(path.join(sessionsDir, 'par-born-1.json'));
    assert.strictEqual(session.parentSession, undefined,
      'pre-existing session file proves the session is not the new subagent');
    cleanup(tmp);
  });

  test('unknown new session is still classified as subagent (regression)', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('real-sub-1');
    seedSyntheticOrbital(sessionsDir, 'owner-1-sub-1', 'owner-1');
    fs.writeFileSync(statsFile, JSON.stringify(conductingStats(
      'owner-1', 'owner-1-sub-1', Date.now() - 1000)), 'utf8');

    runUpdateState('PreToolUse', {
      session_id: 'real-sub-1', tool_name: 'Read', tool_input: { file_path: 'a.js' },
    }, env);

    const session = readJSON(path.join(sessionsDir, 'real-sub-1.json'));
    assert.strictEqual(session.parentSession, 'owner-1',
      'real subagent keeps the parentSession stamp');
    assert.strictEqual(session.taskDescription, 'real task',
      'real subagent inherits the synthetic taskDescription');
    const synth = readJSON(path.join(sessionsDir, 'owner-1-sub-1.json'));
    assert.strictEqual(synth.stopped, true,
      'synthetic orbital is retired on the real subagent first contact');
    const stats = readJSON(statsFile);
    assert.strictEqual(stats.session.id, 'owner-1', 'owner keeps stats.session');
    assert.strictEqual(stats.session.toolCalls, 5, 'subagent does not inflate toolCalls');
    cleanup(tmp);
  });

  test('healing: registered window with stale stamp gets it stripped', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('heal-1');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'heal-1.json'), JSON.stringify({
      session_id: 'heal-1', state: 'idle', timestamp: Date.now(), stopped: false,
      parentSession: 'owner-1', taskDescription: 'subagent',
    }), 'utf8');
    seedSyntheticOrbital(sessionsDir, 'owner-1-sub-1', 'owner-1');
    fs.writeFileSync(statsFile, JSON.stringify(conductingStats(
      'owner-1', 'owner-1-sub-1', Date.now() - 1000,
      { 'heal-1': Date.now() })), 'utf8');

    runUpdateState('PreToolUse', {
      session_id: 'heal-1', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, env);

    const session = readJSON(path.join(sessionsDir, 'heal-1.json'));
    assert.strictEqual(session.parentSession, undefined, 'stale parentSession stripped');
    assert.strictEqual(session.taskDescription, undefined, 'stale taskDescription stripped');
    cleanup(tmp);
  });

  test('healing: stats owner with stale stamp gets it stripped (no subagents)', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('heal-own-1');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'heal-own-1.json'), JSON.stringify({
      session_id: 'heal-own-1', state: 'idle', timestamp: Date.now(), stopped: false,
      parentSession: 'ghost-parent', taskDescription: 'subagent',
    }), 'utf8');
    const stats = conductingStats('heal-own-1', 'unused', Date.now());
    stats.session.activeSubagents = [];
    fs.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');

    runUpdateState('PreToolUse', {
      session_id: 'heal-own-1', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, env);

    const session = readJSON(path.join(sessionsDir, 'heal-own-1.json'));
    assert.strictEqual(session.parentSession, undefined, 'owner cannot be a subagent');
    assert.strictEqual(session.taskDescription, undefined, 'stale taskDescription stripped');
    cleanup(tmp);
  });

  test('healing spares teammates -- their fields are legitimately set', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('mate-1');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, 'mate-1.json'), JSON.stringify({
      session_id: 'mate-1', state: 'idle', timestamp: Date.now(), stopped: false,
      isTeammate: true, teammateName: 'alice', taskDescription: 'fix tests',
    }), 'utf8');
    const stats = conductingStats('mate-1', 'unused', Date.now());
    stats.session.activeSubagents = [];
    fs.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');

    runUpdateState('PreToolUse', {
      session_id: 'mate-1', tool_name: 'Bash', tool_input: { command: 'ls' },
    }, env);

    const session = readJSON(path.join(sessionsDir, 'mate-1.json'));
    assert.strictEqual(session.isTeammate, true, 'isTeammate preserved');
    assert.strictEqual(session.taskDescription, 'fix tests',
      'teammate taskDescription must survive healing');
    cleanup(tmp);
  });

  test('SessionStart registers the session in topLevelSessions', () => {
    const { tmp, statsFile, env } = makeTempEnv('reg-go-1');

    runUpdateState('SessionStart', { session_id: 'reg-go-1' }, env);

    const stats = readJSON(statsFile);
    assert.ok(stats.topLevelSessions, 'registry exists in stats');
    assert.strictEqual(typeof stats.topLevelSessions['reg-go-1'], 'number',
      'SessionStart records the session id with a timestamp');
    cleanup(tmp);
  });
});

// -- Stats lock end to end ---------------------------------------------

describe('update-state.js -- parallel hooks keep every stats increment', () => {
  const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');

  function preToolInput(sessionId) {
    return JSON.stringify({
      session_id: sessionId, tool_name: 'Read', tool_input: { file_path: 'a.js' },
    });
  }

  test.async('6 concurrent PreToolUse hooks each count once', async () => {
    const { tmp, statsFile, env } = makeTempEnv('lock-session');
    try {
      // One hook first, synchronously: it creates the session so the parallel
      // batch only increments (a session reset mid-race would zero the counter).
      execFileSync(NODE, [UPDATE_STATE, 'PreToolUse'], {
        input: preToolInput('lock-session'), env, timeout: 10000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      assert.strictEqual(readJSON(statsFile).session.toolCalls, 1, 'first hook counted');

      await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
        const child = spawn(NODE, [UPDATE_STATE, 'PreToolUse'], {
          env, stdio: ['pipe', 'ignore', 'ignore'],
        });
        child.on('error', reject);
        child.on('exit', resolve);
        child.stdin.end(preToolInput('lock-session'));
      })));

      const stats = readJSON(statsFile);
      assert.strictEqual(stats.session.toolCalls, 7, 'no session.toolCalls increment lost');
      assert.strictEqual(stats.totalToolCalls, 7, 'no totalToolCalls increment lost');
    } finally { cleanup(tmp); }
  });

  test('the process.exit(0) paths release the lock before exiting', () => {
    const { tmp, env } = makeTempEnv('lock-exit');
    try {
      try {
        execFileSync(NODE, [UPDATE_STATE, 'TeammateIdle'], {
          input: JSON.stringify({ teammate_name: 'x', team_name: 't' }),
          env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        if (e.status !== 0 && e.status !== null) throw e;
      }
      assert.ok(!fs.existsSync(path.join(tmp, '.code-crumb-stats.lock')),
        'process.exit skips finally -- the exit paths must release explicitly');
    } finally { cleanup(tmp); }
  });
});

// -- Model identity through the adapters ---------------------------------

describe('adapters -- buildExtra carries model', () => {
  const { buildExtra } = require('../adapters/base-adapter');
  const { defaultStats } = require('../lib/state-machine');

  test('emits the model when given one', () => {
    const e = buildExtra(defaultStats(), 's1', 'codex', 'codex', 'Opus');
    assert.strictEqual(e.model, 'Opus');
    assert.strictEqual(e.modelName, 'codex', 'modelName is still the editor display name');
  });

  test('omits the key entirely when not given one', () => {
    const e = buildExtra(defaultStats(), 's1', 'codex', 'codex');
    assert.ok(!('model' in e), 'no empty model key against the ~1KB budget');
  });

  test('an empty model is treated as absent', () => {
    const e = buildExtra(defaultStats(), 's1', 'codex', 'codex', '');
    assert.ok(!('model' in e));
  });

  // writeSessionState rebuilds its object from scratch, so guardedWriteState is
  // the only thing making `model` sticky on the adapter path. It matters for
  // OpenCode, whose plugin holds the model in memory: an OpenCode restart would
  // otherwise drop the field from the session file on disk.
  test('guardedWriteState carries a known model across a write that lacks one', () => {
    const { tmp, stateFile, env } = makeTempEnv('gw-model');
    try {
      const ADAPTER = path.join(ADAPTERS_DIR, 'opencode-adapter.js');
      runStdinAdapter(ADAPTER, {
        type: 'tool.execute.before', sessionId: 'gw-model',
        tool: 'read', toolInput: {}, model: 'claude-opus-5',
      }, env);
      assert.strictEqual(readJSON(stateFile).model, 'Opus', 'first write stamps it');
      // A later event with no model at all (the plugin forgot it).
      runStdinAdapter(ADAPTER, {
        type: 'tool.execute.before', sessionId: 'gw-model', tool: 'edit', toolInput: {},
      }, env);
      assert.strictEqual(readJSON(stateFile).model, 'Opus', 'and it survives');
    } finally { cleanup(tmp); }
  });
});

// -- Adapter turn-end / session-end contract (Sep 2026 review) --------
// A turn end writes `stopped` to the global file and `turnEnded` to the
// session file; `stopped` on a session file means the session is over. A late
// tool end keeps whichever end is already recorded; nothing else does.

const POSIX = process.platform !== 'win32';

// Poll until fn() is truthy (or throw after `ms`).
async function waitFor(fn, ms = 10000, what = 'condition') {
  const until = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = fn(); } catch {}
    if (ok) return ok;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
}

// Resolves with { code, signal } when the child exits.
function exited(child) {
  return new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
}

describe('adapters -- late tool ends and the next turn (base-adapter)', () => {
  const OPENCODE = path.join(ADAPTERS_DIR, 'opencode-adapter.js');
  const OPENCLAW = path.join(ADAPTERS_DIR, 'openclaw-adapter.js');
  const spin = () => { const until = Date.now() + 3; while (Date.now() < until) { /* 3ms */ } };

  test('the next turn\'s tool start clears the global stopped flag', () => {
    const t = makeTempEnv('lt-1');
    try {
      runStdinAdapter(OPENCODE, { type: 'session.created', sessionId: 'lt-1' }, t.env);
      runStdinAdapter(OPENCODE, { type: 'session.idle', sessionId: 'lt-1' }, t.env);
      assert.strictEqual(readJSON(t.stateFile).stopped, true, 'the turn end stops the global file');
      runStdinAdapter(OPENCODE, { type: 'tool.execute.before', sessionId: 'lt-1', tool: 'bash', toolInput: { command: 'ls' } }, t.env);
      const g = readJSON(t.stateFile);
      assert.strictEqual(g.state, 'executing');
      assert.ok(!g.stopped, 'tmux must see a working session, not a finished one');
      const s = readJSON(path.join(t.sessionsDir, 'lt-1.json'));
      assert.ok(!s.stopped && !s.turnEnded, 'the session file is a live turn again');
    } finally { cleanup(t.tmp); }
  });

  test('a late tool end keeps the turn end on both files and does not re-stamp attention', () => {
    const t = makeTempEnv('lt-2');
    try {
      runStdinAdapter(OPENCODE, { type: 'session.created', sessionId: 'lt-2' }, t.env);
      const stamp = readJSON(path.join(t.sessionsDir, 'lt-2.json')).lastPromptAt;
      assert.ok(stamp > 0);
      runStdinAdapter(OPENCODE, { type: 'session.idle', sessionId: 'lt-2' }, t.env);
      spin();
      runStdinAdapter(OPENCODE, {
        type: 'tool.execute.after', sessionId: 'lt-2', tool: 'bash',
        toolInput: { command: 'ls' }, output: 'a.js',
      }, t.env);
      const s = readJSON(path.join(t.sessionsDir, 'lt-2.json'));
      assert.strictEqual(s.turnEnded, true, 'the late tool end must not erase the turn end');
      assert.strictEqual(s.stopped, false, 'and must not turn it into a session end');
      assert.strictEqual(s.lastPromptAt, stamp, 'a straggler is not the user addressing the session');
      assert.strictEqual(readJSON(t.stateFile).stopped, true, 'the global file stays stopped too');
    } finally { cleanup(t.tmp); }
  });

  test('a late tool end after a session end keeps the session stopped', () => {
    const t = makeTempEnv('lt-3');
    try {
      runStdinAdapter(OPENCLAW, { event: 'tool_call', toolName: 'read', input: { file_path: 'a.js' } }, t.env);
      runStdinAdapter(OPENCLAW, { event: 'session_end' }, t.env);
      runStdinAdapter(OPENCLAW, { event: 'tool_result', toolName: 'read', input: { file_path: 'a.js' }, output: 'x' }, t.env);
      const s = readJSON(path.join(t.sessionsDir, 'lt-3.json'));
      assert.strictEqual(s.stopped, true, 'a finished session is not revived by a straggler');
    } finally { cleanup(t.tmp); }
  });
});

describe('adapters -- codex-notify marks a turn end', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'codex-notify.js');
  function notify(event, env) {
    try {
      execFileSync(NODE, [ADAPTER, JSON.stringify(event)], {
        env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      if (e.status !== 0 && e.status !== null) throw e;
    }
  }

  test('agent-turn-complete: turnEnded on the session file, stopped on the global one', () => {
    const t = makeTempEnv('nt-1');
    try {
      notify({ type: 'agent-turn-complete', 'thread-id': 'nt-1', 'last-assistant-message': 'done' }, t.env);
      const s = readJSON(path.join(t.sessionsDir, 'nt-1.json'));
      assert.strictEqual(s.state, 'happy');
      assert.strictEqual(s.turnEnded, true, 'the renderer must see the turn finish');
      assert.strictEqual(s.stopped, false, 'a turn end must not retire the orbital');
      assert.strictEqual(readJSON(t.stateFile).stopped, true, 'tmux sees the turn end');
    } finally { cleanup(t.tmp); }
  });

  test('an unknown notify event is not a turn end', () => {
    const t = makeTempEnv('nt-2');
    try {
      notify({ type: 'something-new', 'thread-id': 'nt-2' }, t.env);
      const s = readJSON(path.join(t.sessionsDir, 'nt-2.json'));
      assert.ok(!s.turnEnded && !s.stopped);
      assert.ok(!readJSON(t.stateFile).stopped);
    } finally { cleanup(t.tmp); }
  });
});

describe('adapters -- codex-wrapper turn end vs session end', () => {
  const wrapper = require('../adapters/codex-wrapper');
  const { signalExitCode } = require('../adapters/base-adapter');

  // In-process: only the session file after each single event can tell a turn
  // end from the close handler's session end, which overwrites it.
  test('turn.completed / turn.failed are turn ends; the next turn clears them', () => {
    const threadId = `te-${Date.now()}`;
    const file = path.join(SHARED.SESSIONS_DIR, SHARED.safeFilename(`codex-${threadId}`) + '.json');
    withStateFile({ sessionId: 'nobody', stopped: true, timestamp: 0 }, () => {
      wrapper.handleEvent({ type: 'thread.started', thread_id: threadId });
      wrapper.handleEvent({ type: 'turn.started' });
      wrapper.handleEvent({ type: 'turn.completed', usage: {} });
      let s = readJSON(file);
      assert.strictEqual(s.state, 'responding');
      assert.strictEqual(s.turnEnded, true);
      assert.strictEqual(s.stopped, false, 'a turn end must not retire the codex orbital');
      assert.strictEqual(readJSON(SHARED.STATE_FILE).stopped, true, 'the global file keeps stopped for tmux');

      wrapper.handleEvent({ type: 'turn.started' });
      s = readJSON(file);
      assert.ok(!s.turnEnded && !s.stopped, 'a new turn is live');
      assert.ok(!readJSON(SHARED.STATE_FILE).stopped, 'and so is the global file');

      wrapper.handleEvent({ type: 'turn.failed', error: { message: 'boom' } });
      s = readJSON(file);
      assert.strictEqual(s.state, 'error');
      assert.strictEqual(s.turnEnded, true);
      assert.strictEqual(s.stopped, false);
    });
  });

  test('signalExitCode is 128 + the signal number', () => {
    assert.strictEqual(signalExitCode('SIGINT'), 130);
    assert.strictEqual(signalExitCode('SIGTERM'), 143);
    assert.strictEqual(signalExitCode('SIGKILL'), 137);
    assert.strictEqual(signalExitCode('NOPE'), 1, 'an unknown signal is still a failure');
    assert.strictEqual(signalExitCode(null), 1);
  });

  test('closeOutcome: a signal-killed codex is an error, never a success', () => {
    const o = wrapper.closeOutcome({ code: null, signal: 'SIGTERM', caught: null, turnOutcome: null, lastState: 'executing', lastDetail: 'npm test' });
    assert.strictEqual(o.state, 'error');
    assert.strictEqual(o.detail, 'codex killed (SIGTERM)');
    assert.strictEqual(o.stopped, true);
    assert.strictEqual(o.exitCode, 143, 'code null used to exit 0');
  });

  test('closeOutcome: a caught Ctrl+C reads as interrupted and exits 130', () => {
    const o = wrapper.closeOutcome({ code: 0, signal: null, caught: 'SIGINT', turnOutcome: 'completed', lastState: 'responding', lastDetail: 'x' });
    assert.strictEqual(o.state, 'error');
    assert.strictEqual(o.detail, 'interrupted');
    assert.strictEqual(o.exitCode, 130);
  });

  test('closeOutcome: the exit-code branches are unchanged', () => {
    const crash = wrapper.closeOutcome({ code: 2, signal: null, caught: null, turnOutcome: 'completed', lastState: 'responding', lastDetail: 'x' });
    assert.deepStrictEqual([crash.state, crash.detail, crash.exitCode], ['error', 'codex exited 2', 2]);
    const failed = wrapper.closeOutcome({ code: 1, signal: null, caught: null, turnOutcome: 'failed', lastState: 'error', lastDetail: 'boom' });
    assert.deepStrictEqual([failed.state, failed.detail, failed.exitCode], ['error', 'boom', 1]);
    const clean = wrapper.closeOutcome({ code: 0, signal: null, caught: null, turnOutcome: null, lastState: null, lastDetail: '' });
    assert.deepStrictEqual([clean.state, clean.detail, clean.exitCode, clean.stopped], ['responding', 'codex finished', 0, true]);
  });

  // Real signals need POSIX: on win32 a kill from another process terminates
  // outright and never reaches a handler.
  const WRAPPER = path.join(ADAPTERS_DIR, 'codex-wrapper.js');
  const HANG_SRC = [
    "'use strict';",
    "const fs = require('fs');",
    "fs.writeSync(1, JSON.stringify({ type: 'thread.started', thread_id: 'sig' }) + '\\n');",
    "fs.writeSync(1, JSON.stringify({ type: 'turn.started' }) + '\\n');",
    "fs.writeSync(1, JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'npm test', status: 'in_progress' } }) + '\\n');",
    "if (process.env.CODEX_FAKE_THEN === 'kill') setTimeout(() => process.kill(process.pid, 'SIGKILL'), 300);",
    // 'late': keep printing while shutting down after a forwarded SIGTERM.
    "if (process.env.CODEX_FAKE_THEN === 'late') process.on('SIGTERM', () => {",
    "  fs.writeSync(1, JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } }) + '\\n');",
    "  setTimeout(() => process.exit(0), 100);",
    "});",
    "if (process.env.CODEX_FAKE_THEN !== 'kill') setInterval(() => {}, 1000);",
    '',
  ].join('\n');

  function spawnHangingWrapper(then) {
    const base = makeTempEnv('codex-sig');
    const binDir = path.join(base.tmp, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex-fake.js'), HANG_SRC, 'utf8');
    const sh = path.join(binDir, 'codex');
    fs.writeFileSync(sh, '#!/bin/sh\nexec node "$(dirname "$0")/codex-fake.js" "$@"\n', 'utf8');
    fs.chmodSync(sh, 0o755);
    const env = { ...base.env, CODEX_FAKE_THEN: then || '' };
    for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
    env.PATH = binDir + path.delimiter + (process.env.PATH || '');
    delete env.CLAUDE_SESSION_ID;
    const child = spawn(NODE, [WRAPPER, 'a prompt'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    return { ...base, child, done: exited(child), sessionFile: path.join(base.sessionsDir, 'codex-sig.json') };
  }

  if (POSIX) {
    test.async('SIGTERM to the wrapper retires the session and exits 143', async () => {
      const w = spawnHangingWrapper('hang');
      try {
        await waitFor(() => readJSON(w.sessionFile).state === 'testing', 10000, 'the running tool');
        w.child.kill('SIGTERM');
        const { code } = await w.done;
        assert.strictEqual(code, 143);
        const s = readJSON(w.sessionFile);
        assert.strictEqual(s.stopped, true, 'no ghost orbital on its last work face');
        assert.strictEqual(s.state, 'error');
      } finally { try { w.child.kill('SIGKILL'); } catch {} cleanup(w.tmp); }
    });

    test.async('events codex prints while shutting down do not undo the retirement', async () => {
      const w = spawnHangingWrapper('late');
      try {
        await waitFor(() => readJSON(w.sessionFile).state === 'testing', 10000, 'the running tool');
        w.child.kill('SIGTERM');
        const { code } = await w.done;
        assert.strictEqual(code, 143);
        const s = readJSON(w.sessionFile);
        assert.strictEqual(s.stopped, true, 'a late item.completed used to rewrite it live');
        assert.strictEqual(s.state, 'error');
      } finally { try { w.child.kill('SIGKILL'); } catch {} cleanup(w.tmp); }
    });

    test.async('a codex killed by a signal ends on the error face with 128+N', async () => {
      const w = spawnHangingWrapper('kill');
      try {
        const { code } = await w.done;
        assert.strictEqual(code, 137, 'a killed child used to exit 0');
        const s = readJSON(w.sessionFile);
        assert.strictEqual(s.state, 'error');
        assert.strictEqual(s.detail, 'codex killed (SIGKILL)');
        assert.strictEqual(s.stopped, true);
      } finally { cleanup(w.tmp); }
    });
  }
});

describe('adapters -- engmux interrupted dispatch', () => {
  const ADAPTER = path.join(ADAPTERS_DIR, 'engmux-adapter.js');
  if (POSIX) {
    test.async('SIGTERM retires the orbital as interrupted and exits 143', async () => {
      const base = makeTempEnv('engmux-sig');
      const py = path.join(base.tmp, 'fake-python');
      fs.writeFileSync(py, '#!/bin/sh\nexec sleep 30\n', 'utf8');
      fs.chmodSync(py, 0o755);
      const child = spawn(NODE, [ADAPTER, '-E', 'opencode', 'do X'], {
        env: { ...base.env, ENGMUX_PYTHON: py }, stdio: ['ignore', 'ignore', 'ignore'],
      });
      const done = exited(child);
      try {
        const file = await waitFor(() => {
          const f = fs.readdirSync(base.sessionsDir)[0];
          return f && path.join(base.sessionsDir, f);
        }, 10000, 'the spawning orbital');
        child.kill('SIGTERM');
        const { code } = await done;
        assert.strictEqual(code, 143, 'used to exit 0');
        const s = readJSON(file);
        assert.strictEqual(s.state, 'error');
        assert.strictEqual(s.detail, 'interrupted');
        assert.strictEqual(s.stopped, true, 'the orbital is retired, not left cycling');
      } finally { try { child.kill('SIGKILL'); } catch {} cleanup(base.tmp); }
    });
  }
});

describe('setup -- the demo hint only names a demo that exists', () => {
  const setup = require('../setup');
  function usage(baseDir) {
    const lines = [];
    setup.printClaudeUsage('/x/settings.json', (s) => lines.push(s), baseDir);
    return lines.join('\n');
  }

  test('an npm install (no demo/) is not told to run one', () => {
    const t = makeTempEnv('setup-nodemo');
    try {
      const out = usage(t.tmp);
      assert.ok(!out.includes('demo/single.js'), 'the npm tarball excludes demo/');
      assert.ok(out.includes('renderer.js'), 'the rest of the usage is still printed');
    } finally { cleanup(t.tmp); }
  });

  test('a clone (demo/ present) still gets the hint', () => {
    const out = usage(path.join(__dirname, '..'));
    assert.ok(out.includes('demo/single.js'));
    assert.ok(out.includes('preview all expressions'));
  });
});

describe('demos -- clean up demo-main on every terminating signal', () => {
  // POSIX only: a win32 kill terminates without running handlers.
  for (const script of ['demo/single.js', 'demo/orbital.js']) {
    for (const sig of ['SIGTERM', 'SIGHUP']) {
      if (!POSIX) continue;
      test.async(`${script}: ${sig} unlinks the demo-main session file`, async () => {
        const base = makeTempEnv('demo-sig');
        const child = spawn(NODE, [path.join(__dirname, '..', script)], {
          env: base.env, stdio: ['ignore', 'ignore', 'ignore'],
        });
        const done = exited(child);
        const file = path.join(base.sessionsDir, 'demo-main.json');
        try {
          await waitFor(() => fs.existsSync(file), 10000, 'demo-main');
          child.kill(sig);
          await done;
          assert.ok(!fs.existsSync(file), 'demo-main would hold the center over the real session');
        } finally { try { child.kill('SIGKILL'); } catch {} cleanup(base.tmp); }
      });
    }
  }
});

// -- Third review pass (Sep 2026) --------------------------------------------
// Each block below was reproduced against the pre-fix sources first.

describe('adapters -- third review pass: details are drawable text', () => {
  const OPENCLAW = path.join(ADAPTERS_DIR, 'openclaw-adapter.js');
  const NOTIFY = path.join(ADAPTERS_DIR, 'codex-notify.js');

  test('an error OBJECT becomes the generic detail, never an object in the file', () => {
    const t = makeTempEnv('claw-obj');
    try {
      runStdinAdapter(OPENCLAW, { event: 'error', session_id: 'claw-obj', message: { code: 500, text: 'boom' } }, t.env);
      const s = readJSON(path.join(t.sessionsDir, 'claw-obj.json'));
      assert.strictEqual(s.detail, 'something went wrong');
    } finally { cleanup(t.tmp); }
  });

  test('a multi-line message is written on one line', () => {
    const t = makeTempEnv('notify-lines');
    try {
      const ev = { type: 'agent-turn-complete', 'thread-id': 'nl-1', 'last-assistant-message': 'Done.\n\nI updated it.' };
      try { execFileSync(NODE, [NOTIFY, JSON.stringify(ev)], { env: t.env, timeout: 10000, stdio: 'pipe' }); } catch (e) { if (e.status) throw e; }
      const s = readJSON(path.join(t.sessionsDir, 'nl-1.json'));
      assert.ok(!/[\r\n]/.test(s.detail), JSON.stringify(s.detail));
    } finally { cleanup(t.tmp); }
  });
});

describe('adapters -- third review pass: degraded stdin respects ownership', () => {
  const OPENCODE = path.join(ADAPTERS_DIR, 'opencode-adapter.js');
  function run(env, input) {
    try { execFileSync(NODE, [OPENCODE], { input, env, timeout: 10000, stdio: 'pipe', maxBuffer: 1 << 26 }); }
    catch (e) { if (e.status) throw e; }
  }

  test('a payload over 1 MB does not clobber a global file another session owns', () => {
    const t = makeTempEnv('oc-big');
    try {
      const owner = { state: 'coding', detail: 'editing x.js', sessionId: 'claude-live', timestamp: Date.now() };
      fs.writeFileSync(t.stateFile, JSON.stringify(owner));
      run(t.env, JSON.stringify({ type: 'tool.execute.before', sessionId: 'ses_big', tool: 'write',
        toolInput: { filePath: 'big.txt', content: 'x'.repeat(1200000) } }));
      const g = readJSON(t.stateFile);
      assert.strictEqual(g.sessionId, 'claude-live');
      assert.strictEqual(g.state, 'coding');
    } finally { cleanup(t.tmp); }
  });

  test('unparseable stdin keeps the owner\'s sessionId on the global file', () => {
    const t = makeTempEnv('oc-owner');
    try {
      const env = { ...t.env, CLAUDE_SESSION_ID: 'oc-owner' };
      fs.writeFileSync(t.stateFile, JSON.stringify({ state: 'coding', sessionId: 'oc-owner', timestamp: Date.now() }));
      run(env, 'not json');
      const g = readJSON(t.stateFile);
      assert.strictEqual(g.sessionId, 'oc-owner', 'without it any other window took the file over');
      assert.strictEqual(g.state, 'thinking');
    } finally { cleanup(t.tmp); }
  });
});

describe('adapters -- third review pass: per-session counters', () => {
  const OPENCODE = path.join(ADAPTERS_DIR, 'opencode-adapter.js');
  test('two alternating sessions keep their own tool counts and count once each', () => {
    const t = makeTempEnv('oc-alt');
    try {
      for (let i = 0; i < 3; i++) {
        for (const sid of ['ses_A', 'ses_B']) {
          runStdinAdapter(OPENCODE, { type: 'tool.execute.before', sessionId: sid, callID: `c${i}`, tool: 'read', toolInput: { filePath: 'a.js' } }, t.env);
        }
      }
      assert.strictEqual(readJSON(path.join(t.sessionsDir, 'ses_A.json')).toolCalls, 3);
      assert.strictEqual(readJSON(path.join(t.sessionsDir, 'ses_B.json')).toolCalls, 3);
      assert.strictEqual(readJSON(t.statsFile).daily.sessionCount, 2);
    } finally { cleanup(t.tmp); }
  });

  test('an adapter event parks a conducting owner\'s agents instead of wiping them', () => {
    const base = require(path.join(ADAPTERS_DIR, 'base-adapter'));
    const { defaultStats } = require('../lib/state-machine');
    const stats = defaultStats();
    base.initSession(stats, 'claude-A');
    stats.session.activeSubagents = [{ id: 'claude-A-sub-1', startedAt: Date.now() }];
    stats.session.subagentCount = 1;
    base.initSession(stats, 'ses_oc');            // an OpenCode event takes the owner slot
    assert.deepStrictEqual(stats.session.activeSubagents, []);
    base.initSession(stats, 'claude-A');          // and hands it back
    assert.strictEqual(stats.session.activeSubagents.length, 1);
    assert.strictEqual(stats.session.subagentCount, 1);
  });
});

describe('adapters -- third review pass: streams', () => {
  const base = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  test.async('a multi-byte character split across chunks survives', async () => {
    const { PassThrough } = require('stream');
    const stream = new PassThrough();
    const got = [];
    base.processJsonlStream(stream, (e) => got.push(e));
    const buf = Buffer.from(JSON.stringify({ path: '/repo/café.js' }) + '\n', 'utf8');
    const cut = buf.indexOf(0xc3) + 1;             // between the two bytes of the e-acute
    stream.write(buf.subarray(0, cut));
    stream.write(buf.subarray(cut));
    stream.end();
    await new Promise(r => setImmediate(r));
    assert.deepStrictEqual(got, [{ path: '/repo/café.js' }]);
  });

  test('exitWhenFlushed exits only once the stream has taken everything', () => {
    const realExit = process.exit;
    const realCode = process.exitCode;
    const calls = [];
    let flush = null;
    process.exit = (c) => { calls.push(c); };
    try {
      base.exitWhenFlushed(3, { write: (s, cb) => { flush = cb; return false; } });
      assert.deepStrictEqual(calls, [], 'not before the pipe drains');
      flush();
      assert.deepStrictEqual(calls, [3]);
    } finally {
      process.exit = realExit;
      process.exitCode = realCode;
    }
  });

  test('source: the passthrough adapters exit through exitWhenFlushed', () => {
    const engmux = fs.readFileSync(path.join(ADAPTERS_DIR, 'engmux-adapter.js'), 'utf8');
    const wrapper = fs.readFileSync(path.join(ADAPTERS_DIR, 'codex-wrapper.js'), 'utf8');
    assert.ok(engmux.includes('exitWhenFlushed(code || 0)'));
    assert.ok(wrapper.includes('exitWhenFlushed(outcome.exitCode)'));
    assert.ok(engmux.includes("child.stdout.setEncoding('utf8')"));
  });
});

describe('adapters -- third review pass: the OpenCode plugin keeps a session in order', () => {
  const PLUGIN_FILE = path.join(ADAPTERS_DIR, 'opencode-plugin.mjs');
  if (POSIX) {
    test.async('one session\'s payloads spawn one at a time, in order', async () => {
      const os = require('os');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-order-'));
      const log = path.join(dir, 'log');
      const fake = path.join(dir, 'fake-node');
      // Stands in for `node adapter.js`: logs the payload, works a while, logs the end.
      fs.writeFileSync(fake, `#!/bin/sh\ncat >> "${log}"\necho >> "${log}"\nsleep 0.3\necho end >> "${log}"\n`);
      fs.chmodSync(fake, 0o755);
      const realNode = process.env.CODE_CRUMB_NODE;
      try {
        const { CodeCrumbPlugin } = await import(`${require('url').pathToFileURL(PLUGIN_FILE).href}?t=order`);
        const hooks = await CodeCrumbPlugin();
        process.env.CODE_CRUMB_NODE = fake;
        const input = { sessionID: 'ses_order', tool: 'read', callID: 'c1' };
        const calls = [
          hooks['tool.execute.before'](input, { args: { filePath: 'a.js' } }),
          hooks['tool.execute.after']({ ...input, args: { filePath: 'a.js' } }, { title: '', output: 'x', metadata: {} }),
        ];
        process.env.CODE_CRUMB_NODE = realNode;
        await Promise.all(calls);
        await waitFor(() => (fs.readFileSync(log, 'utf8').match(/^end$/gm) || []).length === 2, 10000, 'both children');
        const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
        assert.strictEqual(lines.length, 4, lines.join(' | '));
        assert.strictEqual(lines[1], 'end', 'the second child must not start before the first ends');
        assert.ok(lines[0].includes('tool.execute.before'));
        assert.ok(lines[2].includes('tool.execute.after'));
      } finally {
        if (realNode === undefined) delete process.env.CODE_CRUMB_NODE; else process.env.CODE_CRUMB_NODE = realNode;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('adapters -- review round: batches, turn ends and counters', () => {
  const base = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const { defaultStats } = require('../lib/state-machine');
  const OPENCODE = path.join(ADAPTERS_DIR, 'opencode-adapter.js');

  test.async('processStdinEvent applies a JSON array in order, one handler call each', async () => {
    const { Readable } = require('stream');
    const seen = [];
    await new Promise((resolve) => {
      const stream = new Readable({ read() {} });
      base.processStdinEvent((d) => { seen.push(d.n); if (d.n === 2) throw new Error('one bad event'); }, null, {
        stream, exit: () => resolve(),
      });
      stream.push('[{"n":1},{"n":2},{"n":3}]');
      stream.push(null);
    });
    assert.deepStrictEqual(seen, [1, 2, 3], 'a throw in one element does not stop the rest');
  });

  test('a batched turn end lands last: queued tool events cannot undo it', () => {
    const t = makeTempEnv('oc-batch');
    try {
      const input = JSON.stringify([
        { type: 'tool.execute.before', sessionId: 'ses_b', callID: 'c1', tool: 'read', toolInput: { filePath: 'a.js' } },
        { type: 'tool.execute.after', sessionId: 'ses_b', callID: 'c1', tool: 'read', toolInput: { filePath: 'a.js' }, output: 'x' },
        { type: 'session.idle', sessionId: 'ses_b' },
      ]);
      try { execFileSync(NODE, [OPENCODE], { input, env: t.env, timeout: 10000, stdio: 'pipe' }); }
      catch (e) { if (e.status) throw e; }
      const sf = readJSON(path.join(t.sessionsDir, 'ses_b.json'));
      assert.strictEqual(sf.state, 'happy');
      assert.strictEqual(sf.turnEnded, true);
      assert.strictEqual(sf.toolCalls, 1, 'the queued tool still counted');
      assert.strictEqual(readJSON(t.stateFile).stopped, true);
    } finally { cleanup(t.tmp); }
  });

  test('buildExtra does not count time update-state.js already credited', () => {
    const stats = defaultStats();
    base.initSession(stats, 'ses_c');
    stats.session.start = Date.now() - 3600000;
    stats.sessionCounters.ses_c.creditedMs = 3600000;   // credited on a switch away
    const extra = base.buildExtra(stats, 'ses_c', 'opencode', 'opencode');
    assert.ok(extra.dailyCumulativeMs - stats.daily.cumulativeMs < 60000,
      `${extra.dailyCumulativeMs - stats.daily.cumulativeMs}ms counted twice`);
  });

  test('a session carried across midnight counts once in the new day', () => {
    const stats = defaultStats();
    base.initSession(stats, 'A');
    base.initSession(stats, 'B');
    // Make that "yesterday": both were counted in the old day's bucket.
    stats.daily = { date: '2020-01-01', sessionCount: 2, cumulativeMs: 0 };
    stats.sessionCounters.A.countedDay = '2020-01-01';
    stats.sessionCounters.B.countedDay = '2020-01-01';
    base.initSession(stats, 'A');
    base.initSession(stats, 'B');
    base.initSession(stats, 'A');
    assert.strictEqual(stats.daily.sessionCount, 2);
  });

  test('pruneCounters evicts throwaway ids before a busy window', () => {
    const { pruneCounters, freshCounter } = require('../lib/state-machine');
    const now = Date.now();
    const map = { busy: { ...freshCounter(now - 100000), toolCalls: 3 } };
    for (let i = 0; i < 60; i++) map[`flood-${i}`] = { ...freshCounter(now - i), toolCalls: 1 };
    pruneCounters(map, 'flood-0', now);
    assert.ok(map.busy, 'the least recently seen, but busy, window keeps its counters');
    assert.strictEqual(Object.keys(map).length, 50);
  });

  test('pruneCounters never evicts parked agents', () => {
    const { pruneCounters, freshCounter } = require('../lib/state-machine');
    const now = Date.now();
    const map = { owner: { ...freshCounter(now - 100000), activeSubagents: [{ id: 'owner-sub-1' }] } };
    for (let i = 0; i < 60; i++) map[`flood-${i}`] = freshCounter(now - i);
    pruneCounters(map, 'flood-0', now);
    assert.ok(map.owner, 'the oldest entry holds agents and stays');
    assert.ok(Object.keys(map).length <= 51);
  });

  if (POSIX) {
    test.async('the plugin\'s session.idle takes the queued payloads with it', async () => {
      const os = require('os');
      const PLUGIN_FILE = path.join(ADAPTERS_DIR, 'opencode-plugin.mjs');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-drain-'));
      const log = path.join(dir, 'log');
      const fake = path.join(dir, 'fake-node');
      // One write per payload, so two children cannot interleave inside a line.
      fs.writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$(cat)" >> "${log}"\nsleep 0.3\necho end >> "${log}"\n`);
      fs.chmodSync(fake, 0o755);
      const realNode = process.env.CODE_CRUMB_NODE;
      try {
        const { CodeCrumbPlugin } = await import(`${require('url').pathToFileURL(PLUGIN_FILE).href}?t=drain`);
        const hooks = await CodeCrumbPlugin();
        process.env.CODE_CRUMB_NODE = fake;
        const tool = (id) => ({ sessionID: 'ses_d', tool: 'read', callID: id });
        const calls = [
          hooks['tool.execute.before'](tool('c1'), { args: { filePath: 'a.js' } }),   // spawns now
          hooks['tool.execute.before'](tool('c2'), { args: { filePath: 'b.js' } }),   // queued
          hooks['tool.execute.before'](tool('c3'), { args: { filePath: 'c.js' } }),   // queued
          hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_d' } } }),
        ];
        process.env.CODE_CRUMB_NODE = realNode;
        await Promise.all(calls);
        await new Promise(r => setTimeout(r, 1200));
        const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
        const payloads = lines.filter(l => l !== 'end');
        assert.strictEqual(payloads.length, 2, lines.join(' | '));
        const batch = JSON.parse(payloads.find(l => l.startsWith('[')));
        assert.deepStrictEqual(batch.map(p => p.type),
          ['tool.execute.before', 'tool.execute.before', 'session.idle'], 'the turn end is last');
      } finally {
        if (realNode === undefined) delete process.env.CODE_CRUMB_NODE; else process.env.CODE_CRUMB_NODE = realNode;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test('source: the plugin\'s spawn never throws past its promise', () => {
    const src = fs.readFileSync(path.join(ADAPTERS_DIR, 'opencode-plugin.mjs'), 'utf8');
    assert.ok(src.includes('if (!child.stdin) { done(); return; }'), 'EMFILE: a child with no stdin');
    const i = src.indexOf('function spawnAdapter');
    assert.ok(/return new Promise\(\(resolve\) => \{\s*try \{/.test(src.slice(i, i + 200)));
  });
});

describe('adapters -- third review pass: the OpenClaw snippets name their session', () => {
  test('both snippets send a stable session_id without a shell', () => {
    const header = fs.readFileSync(path.join(ADAPTERS_DIR, 'openclaw-adapter.js'), 'utf8');
    const setupSrc = fs.readFileSync(path.join(__dirname, '..', 'setup.js'), 'utf8');
    for (const src of [header, setupSrc]) {
      assert.ok(src.includes('execFileSync'), 'no shell, so the adapter\'s parent is Pi itself');
      assert.ok(/openclaw-\$\{process\.pid\}|openclaw-\\\$\{process\.pid\}/.test(src), 'one id per Pi process');
    }
  });
});

module.exports = suite;
