#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - Adapter coverage                      |
// |  Tests for codex-notify, opencode-adapter, openclaw-adapter,   |
// |  and codex-wrapper (structure only — requires codex binary).   |
// |                                                                |
// |  Adapters are scripts, not libraries, so we test them by       |
// |  spawning child processes with controlled env/stdin/argv and   |
// |  verifying the state files they write.                         |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync, spawn } = require('child_process');

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
  // The plugin resolves its node binary once, at import time.
  process.env.CODE_CRUMB_NODE = NODE;
  const loadModule = () => import(require('url').pathToFileURL(PLUGIN_FILE).href);
  // translate() rides on the factory rather than being its own export: see
  // "every export is a plugin factory" below.
  const load = async () => ({ translate: (await loadModule()).CodeCrumbPlugin.translate });
  const bus = (type, properties) => ({ event: { type, properties } });

  // A fresh module instance -- the query string busts the ESM cache -- so a
  // test that exercises the delivery path gets its own throttle state and
  // cannot colour another test's. (Do not swap CODE_CRUMB_NODE around this:
  // module evaluation is async, and a sibling test's import would read the
  // swapped value.)
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
    assert.strictEqual(s.stopped, true);
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

  test('adapter handles item.started events', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'item.started'"), 'should handle item.started');
  });

  test('adapter handles item.updated events', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'item.updated'"), 'should handle item.updated');
  });

  test('adapter no longer looks for the item.created/tool_use schema', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(!src.includes("'item.created'"), 'item.created does not exist in codex 0.146');
    assert.ok(!src.includes("'tool_use'"), 'tool_use is not a codex item type');
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

  test('adapter maps codex collaboration items onto the subagent face', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('collab_tool_call'), 'should handle collab_tool_call');
    assert.ok(src.includes('collab_agent_tool_call'), 'should handle collab_agent_tool_call');
  });

  test('adapter spawns codex through buildEditorSpawn (Windows .cmd shims)', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('buildEditorSpawn'), 'should use buildEditorSpawn');
    assert.ok(!/spawn\(\s*'codex'/.test(src), 'should not spawn the bare codex name');
  });

  test('adapter bootstrap is behind a require.main guard', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes('require.main === module'), 'should guard the CLI bootstrap');
    assert.ok(/module\.exports\s*=/.test(src), 'should export its pure helpers');
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

  test('handles the only notify event codex emits', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(src.includes("'agent-turn-complete'"), 'should handle agent-turn-complete');
    assert.ok(!src.includes("'approval-requested'"),
      'codex never emits approval-requested -- unknown types fall through to thinking');
  });

  test('guards global state file against other sessions', () => {
    const src = fs.readFileSync(ADAPTER, 'utf8');
    assert.ok(
      src.includes('shouldWriteGlobal') || src.includes('guardedWriteState'),
      'should guard global writes'
    );
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

  function runFakeCodex(events, seedStats) {
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
      execFileSync(NODE, [WRAPPER, 'a prompt'], {
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

  test('a standalone error with no turn.failed still breaks the streak', () => {
    const { tmp, statsFile } = runFakeCodex([
      { type: 'turn.started' },
      { type: 'error', message: 'stream died' },
    ], { streak: 4, bestStreak: 9, totalErrors: 1 });

    const stats = readJSON(statsFile);
    assert.strictEqual(stats.brokenStreak, 4);
    assert.strictEqual(stats.streak, 0);
    assert.strictEqual(stats.totalErrors, 2);
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
    const files = fs.readdirSync(sessionsDir);
    assert.deepStrictEqual(files, ['codex-abc.json'], 'exactly one orbital, named for the thread');
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
    assert.ok(src.includes('out += face.render()'));
    const renderIdx = src.indexOf('out += face.render()');
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

  test('renderer.js readState returns isSessionStart field', () => {
    // readState() must propagate isSessionStart so SessionStart events
    // can trigger immediate session adoption in the render loop.
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.ok(src.includes('isSessionStart: data.isSessionStart'),
      'readState should include isSessionStart field');
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

  test('renderer.js responding rescue paths use forceState with a 3000ms min display (#67)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    // Both rescue paths (stopped-flag rescue and fresh-read rescue) go through
    // face.forceState so the 3s responding minimum is applied in one place.
    assert.ok(src.includes("face.forceState('responding', 'wrapping up', 3000)"),
      'stopped-flag rescue should forceState responding with 3000ms');
    assert.ok(src.includes("face.forceState('responding', freshData.detail || 'wrapping up', 3000)"),
      'fresh-read rescue should forceState responding with 3000ms');
    // No hand-rolled transition left behind
    assert.ok(!src.includes("minDisplayUntil = now;"),
      'responding should not use minDisplayUntil = now (immediate expire)');
    assert.ok(!src.includes("face.state = 'responding';"),
      'renderer should not assign face.state directly for responding');
  });
});

// -- Stopped flag preservation (#98) ----------------------------------------

describe('update-state.js stopped flag preservation (#98)', () => {
  const updateStatePath = path.join(__dirname, '..', 'update-state.js');
  const sharedMod = require(path.join(__dirname, '..', 'shared'));
  const STATE_FILE = sharedMod.STATE_FILE;
  const SESSIONS_DIR = sharedMod.SESSIONS_DIR;
  const safeFilename = sharedMod.safeFilename;

  // Save and restore state file (integration tests write to the real file)
  let savedStoppedState;
  try { savedStoppedState = fs.readFileSync(STATE_FILE, 'utf8'); } catch { savedStoppedState = null; }

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

  test('source: renderer lastStopped resets when same session sends non-stopped state', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
    assert.ok(
      src.includes('lastStopped = !!stateData.stopped'),
      'renderer.js should reset lastStopped when state file has no stopped flag'
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

  test('source: update-state.js blocks subagents with parentSession from global state writes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'update-state.js'), 'utf8');
    const pattern = 'mySession.parentSession) shouldWriteGlobal = false';
    const matches = src.split(pattern).length - 1;
    assert.ok(matches >= 2,
      `update-state.js should have parentSession guard in both main and fallback paths (found ${matches})`);
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

  test('integration: subagent with parentSession is blocked from global state writes', () => {
    // Set up: main session owns the global state file
    const mainId = 'test-main-' + Date.now();
    const subId = 'test-sub-' + Date.now();
    const mainState = JSON.stringify({
      state: 'thinking', detail: 'planning',
      timestamp: Date.now(), sessionId: mainId, stopped: true,
    });
    try { fs.writeFileSync(STATE_FILE, mainState, 'utf8'); } catch { return; }

    // Create a session file for the subagent with parentSession set
    // (simulates what SubagentStart does before the subagent's first hook)
    const subSessionFile = path.join(SESSIONS_DIR, safeFilename(subId) + '.json');
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(subSessionFile, JSON.stringify({
        session_id: subId, state: 'spawning', detail: 'subagent',
        timestamp: Date.now(), parentSession: mainId,
      }), 'utf8');
    } catch { return; }

    // Spawn update-state.js as the subagent sending a PreToolUse
    try {
      execFileSync(process.execPath, [updateStatePath, 'PreToolUse'], {
        input: JSON.stringify({
          tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' },
          session_id: subId,
        }),
        env: { ...process.env, CLAUDE_SESSION_ID: subId, CODE_CRUMB_STATE: STATE_FILE },
        timeout: 5000,
      });
    } catch {}

    // Global state file must still belong to main session — subagent was blocked
    try {
      const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      assert.strictEqual(result.sessionId, mainId,
        'subagent with parentSession must not overwrite global state file');
    } catch (e) {
      if (e.code !== 'ENOENT' && e instanceof assert.AssertionError) throw e;
    } finally {
      try { fs.unlinkSync(subSessionFile); } catch {}
    }
  });

  // Restore the state file as it was before this block ran.
  if (savedStoppedState !== null) fs.writeFileSync(STATE_FILE, savedStoppedState, 'utf8');
  else try { fs.unlinkSync(STATE_FILE); } catch {}
});

describe('update-state.js parallel sessions orbital visibility fix', () => {
  const updateStatePath = path.join(__dirname, '..', 'update-state.js');
  const sharedMod = require(path.join(__dirname, '..', 'shared'));
  const STATE_FILE = sharedMod.STATE_FILE;
  const SESSIONS_DIR = sharedMod.SESSIONS_DIR;
  const safeFilename = sharedMod.safeFilename;

  // Save and restore state file
  let savedOrbitalState;
  try { savedOrbitalState = fs.readFileSync(STATE_FILE, 'utf8'); } catch { savedOrbitalState = null; }

  // -- Source tests: hookEvent guard on stopped preservation --

  test('source: global stopped preservation is restricted to PostToolUse/PostToolUseFailure', () => {
    const src = fs.readFileSync(updateStatePath, 'utf8');
    // The stopped preservation block must check hookEvent
    assert.ok(
      src.includes("hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure'"),
      'stopped preservation must be gated on PostToolUse/PostToolUseFailure hookEvent'
    );
  });

  test('source: per-session stopped preservation is restricted to PostToolUse/PostToolUseFailure', () => {
    const src = fs.readFileSync(updateStatePath, 'utf8');
    // Both global and session preservation blocks should have the hookEvent guard
    const matches = src.match(/hookEvent === 'PostToolUse' \|\| hookEvent === 'PostToolUseFailure'/g);
    assert.ok(matches && matches.length >= 2,
      'both global and per-session stopped preservation must have hookEvent guard');
  });

  test('source: Stop writes idle to per-session file (not stopped)', () => {
    const src = fs.readFileSync(updateStatePath, 'utf8');
    assert.ok(
      src.includes("hookEvent === 'Stop'") && src.includes("'idle', 'between turns', false"),
      'Stop handler should write idle/between-turns/stopped=false to per-session file'
    );
  });

  test('source: fallback catch separates Stop from SessionEnd', () => {
    const src = fs.readFileSync(updateStatePath, 'utf8');
    // Should NOT have the combined condition anymore
    assert.ok(
      !src.includes("hookEvent === 'Stop' || hookEvent === 'SessionEnd'"),
      'fallback catch must not combine Stop and SessionEnd in the same condition'
    );
  });

  // -- Integration tests: PreToolUse clears stopped --

  test('integration: PreToolUse after Stop clears stopped on per-session file', () => {
    const testSessionId = 'test-pretool-clears-' + Date.now();
    const sessionFile = path.join(SESSIONS_DIR, safeFilename(testSessionId) + '.json');

    // Write a stopped session file (simulating a prior Stop)
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify({
        session_id: testSessionId, state: 'responding', detail: 'wrapping up',
        timestamp: Date.now(), stopped: true,
      }), 'utf8');
      // Also write a stopped global state for same session
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        state: 'responding', detail: 'wrapping up',
        timestamp: Date.now(), sessionId: testSessionId, stopped: true,
      }), 'utf8');
    } catch { return; }

    // Send PreToolUse (new turn starting) — should clear stopped
    try {
      execFileSync(process.execPath, [updateStatePath, 'PreToolUse'], {
        input: JSON.stringify({
          tool_name: 'Read', tool_input: { file_path: '/tmp/test.txt' },
          session_id: testSessionId,
        }),
        env: { ...process.env, CLAUDE_SESSION_ID: testSessionId, CODE_CRUMB_STATE: STATE_FILE },
        timeout: 5000,
      });
    } catch {}

    // Per-session file must NOT have stopped: true
    try {
      const result = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      assert.strictEqual(result.stopped, false,
        'PreToolUse must clear stopped flag on per-session file (new turn)');
    } catch (e) {
      if (e.code !== 'ENOENT' && e instanceof assert.AssertionError) throw e;
    } finally {
      try { fs.unlinkSync(sessionFile); } catch {}
    }
  });

  test('integration: Stop writes idle with stopped=false to per-session file', () => {
    const testSessionId = 'test-stop-idle-' + Date.now();
    const sessionFile = path.join(SESSIONS_DIR, safeFilename(testSessionId) + '.json');

    // Write an active session file first
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify({
        session_id: testSessionId, state: 'coding', detail: 'editing',
        timestamp: Date.now(), stopped: false,
      }), 'utf8');
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        state: 'coding', detail: 'editing',
        timestamp: Date.now(), sessionId: testSessionId,
      }), 'utf8');
    } catch { return; }

    // Send Stop event
    try {
      execFileSync(process.execPath, [updateStatePath, 'Stop'], {
        input: JSON.stringify({ session_id: testSessionId }),
        env: { ...process.env, CLAUDE_SESSION_ID: testSessionId, CODE_CRUMB_STATE: STATE_FILE },
        timeout: 5000,
      });
    } catch {}

    // Per-session file: state=idle, stopped=false (orbital stays visible)
    try {
      const result = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      assert.strictEqual(result.state, 'idle',
        'Stop should write state=idle to per-session file');
      assert.strictEqual(result.stopped, false,
        'Stop should write stopped=false to per-session file (keep orbital visible)');
      assert.strictEqual(result.detail, 'between turns',
        'Stop should write detail="between turns" to per-session file');
    } catch (e) {
      if (e.code !== 'ENOENT' && e instanceof assert.AssertionError) throw e;
    } finally {
      try { fs.unlinkSync(sessionFile); } catch {}
    }
  });

  test('integration: SessionEnd still writes stopped=true to per-session file', () => {
    const testSessionId = 'test-sessend-stopped-' + Date.now();
    const sessionFile = path.join(SESSIONS_DIR, safeFilename(testSessionId) + '.json');

    // Write an active session file
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(sessionFile, JSON.stringify({
        session_id: testSessionId, state: 'coding', detail: 'editing',
        timestamp: Date.now(), stopped: false,
      }), 'utf8');
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        state: 'coding', detail: 'editing',
        timestamp: Date.now(), sessionId: testSessionId,
      }), 'utf8');
    } catch { return; }

    // Send SessionEnd event
    try {
      execFileSync(process.execPath, [updateStatePath, 'SessionEnd'], {
        input: JSON.stringify({ session_id: testSessionId }),
        env: { ...process.env, CLAUDE_SESSION_ID: testSessionId, CODE_CRUMB_STATE: STATE_FILE },
        timeout: 5000,
      });
    } catch {}

    // Per-session file: stopped=true (session truly over)
    try {
      const result = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
      assert.strictEqual(result.stopped, true,
        'SessionEnd must write stopped=true to per-session file');
    } catch (e) {
      if (e.code !== 'ENOENT' && e instanceof assert.AssertionError) throw e;
    } finally {
      try { fs.unlinkSync(sessionFile); } catch {}
    }
  });

  test('integration: Stop writes stopped=true to global state file (ownership release)', () => {
    const testSessionId = 'test-stop-global-' + Date.now();

    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        state: 'coding', detail: 'editing',
        timestamp: Date.now(), sessionId: testSessionId,
      }), 'utf8');
    } catch { return; }

    try {
      execFileSync(process.execPath, [updateStatePath, 'Stop'], {
        input: JSON.stringify({ session_id: testSessionId }),
        env: { ...process.env, CLAUDE_SESSION_ID: testSessionId, CODE_CRUMB_STATE: STATE_FILE },
        timeout: 5000,
      });
    } catch {}

    // Global state must still have stopped=true for ownership release
    try {
      const result = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      assert.strictEqual(result.stopped, true,
        'Stop must write stopped=true to global state file for ownership release');
    } catch (e) {
      if (e.code !== 'ENOENT' && e instanceof assert.AssertionError) throw e;
    }
  });

  // Restore the state file as it was before this block ran.
  if (savedOrbitalState !== null) fs.writeFileSync(STATE_FILE, savedOrbitalState, 'utf8');
  else try { fs.unlinkSync(STATE_FILE); } catch {}
});

describe('base-adapter guardedWriteState modelName preservation (#78)', () => {
  const baseAdapter = require(path.join(ADAPTERS_DIR, 'base-adapter'));
  const sharedMod = require(path.join(__dirname, '..', 'shared'));
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

  test('opencode-adapter.js unwraps the tool args instead of taking the wrapper', () => {
    const src = fs.readFileSync(OPENCODE_ADAPTER, 'utf8');
    assert.ok(/data\.toolInput \|\| data\.tool_input \|\| opencodeInput\.args/.test(src),
      'toolInput should prefer the flat plugin field, then tool_input, then the unwrapped args');
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

// -- engmux adapter structure -----------------------------------------

describe('adapters -- engmux adapter structure', () => {
  test('engmux-adapter.js file can be read without error', () => {
    const adapterPath = path.join(ADAPTERS_DIR, 'engmux-adapter.js');
    assert.ok(fs.existsSync(adapterPath), 'engmux-adapter.js should exist');
    assert.doesNotThrow(() => fs.readFileSync(adapterPath, 'utf8'));
  });

  test('engmux-adapter.js is a valid Node.js script', () => {
    const adapterPath = path.join(ADAPTERS_DIR, 'engmux-adapter.js');
    const src = fs.readFileSync(adapterPath, 'utf8');
    assert.ok(src.includes("'use strict'"), 'should use strict mode');
    assert.ok(src.includes("require('./base-adapter')"), 'should require base-adapter');
  });

  test('engmux-adapter.js uses writeSessionState from base-adapter', () => {
    const src = fs.readFileSync(path.join(ADAPTERS_DIR, 'engmux-adapter.js'), 'utf8');
    assert.ok(src.includes('writeSessionState'), 'should use writeSessionState');
  });
});

// -- codex-wrapper structure ------------------------------------------

describe('adapters -- codex-wrapper structure', () => {
  test('codex-wrapper.js file exists and is readable', () => {
    const adapterPath = path.join(ADAPTERS_DIR, 'codex-wrapper.js');
    assert.ok(fs.existsSync(adapterPath), 'codex-wrapper.js should exist');
    assert.doesNotThrow(() => fs.readFileSync(adapterPath, 'utf8'));
  });

  test('codex-wrapper.js is a valid Node.js script', () => {
    const src = fs.readFileSync(path.join(ADAPTERS_DIR, 'codex-wrapper.js'), 'utf8');
    assert.ok(src.includes("'use strict'"), 'should use strict mode');
    assert.ok(src.includes("require('./base-adapter')"), 'should require base-adapter');
  });

  test('codex-wrapper.js imports expected base-adapter functions', () => {
    const src = fs.readFileSync(path.join(ADAPTERS_DIR, 'codex-wrapper.js'), 'utf8');
    assert.ok(src.includes('writeSessionState'), 'should import writeSessionState');
    assert.ok(src.includes('readStats'), 'should import readStats');
    assert.ok(src.includes('writeStats'), 'should import writeStats');
    assert.ok(src.includes('guardedWriteState'), 'should import guardedWriteState');
    assert.ok(src.includes('initSession'), 'should import initSession');
    assert.ok(src.includes('buildExtra'), 'should import buildExtra');
    assert.ok(src.includes('handleToolStart'), 'should import handleToolStart');
    assert.ok(src.includes('handleToolEnd'), 'should import handleToolEnd');
    assert.ok(src.includes('processJsonlStream'), 'should import processJsonlStream');
  });
});

// -- adapter files all exist ------------------------------------------

describe('adapters -- adapter files all exist', () => {
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
    test(`${file} exists in adapters directory`, () => {
      const fullPath = path.join(ADAPTERS_DIR, file);
      assert.ok(fs.existsSync(fullPath), `${file} should exist at ${fullPath}`);
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
  const updateStateSrc = fs.readFileSync(path.join(__dirname, '..', 'update-state.js'), 'utf8');

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

  test('update-state.js writeState adds pid in the function, platform-conditionally', () => {
    assert.ok(
      updateStateSrc.includes("...(process.platform !== 'win32' ? { pid: process.ppid } : {}), ...extra"),
      'writeState should spread pid conditionally (omit on win32) before ...extra'
    );
  });

  test('codex-wrapper reports its own pid (long-lived, exits with codex)', () => {
    const src = fs.readFileSync(path.join(ADAPTERS_DIR, 'codex-wrapper.js'), 'utf8');
    assert.ok(src.includes('pid: process.pid'),
      'codex-wrapper should override pid with process.pid');
  });

  test('renderer readState returns pid field', () => {
    assert.ok(rendererSrc.includes('pid: data.pid || 0'),
      'readState should propagate the pid field');
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

  test('every adapter declares its editor', () => {
    const read = f => fs.readFileSync(path.join(__dirname, '..', 'adapters', f), 'utf8');
    assert.ok(read('opencode-adapter.js').includes("defaultEditor: 'opencode'"));
    assert.ok(read('openclaw-adapter.js').includes("defaultEditor: 'openclaw'"));
    assert.ok(read('codex-notify.js').includes('editor'));
    assert.ok(read('codex-wrapper.js').includes("const EDITOR = 'codex'"));
    assert.ok(read('engmux-adapter.js').includes('extractEngine'));
  });

  test('runStdinAdapter fallback session id is editor-prefixed', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'base-adapter.js'), 'utf8');
    assert.ok(src.includes('${defaultEditor}-${process.ppid}'));
  });

  test('update-state.js: editor invariants', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'update-state.js'), 'utf8');
    // env > --editor <name> > 'claude', resolved before FALLBACK_SESSION_ID
    assert.ok(src.includes("process.env.CODE_CRUMB_EDITOR || HOOK_ARGS.editor || 'claude'"), 'editor resolution');
    assert.ok(src.includes("'editor'"), 'editor in STICKY_FIELDS');
    assert.ok(src.includes('FALLBACK_SESSION_ID'), 'single shared fallback id expression');
    assert.ok(src.includes("process.platform !== 'win32'"), 'win32 transient-shim pid omission');
  });

  test('guardedWriteState preserves owner editor', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'base-adapter.js'), 'utf8');
    assert.ok(src.includes('existing.editor'), 'editor preservation in guardedWriteState');
  });
});

// -- update-state.js parallel session classification (#134) -----------
// Parallel top-level editor windows were misclassified as subagents of
// whichever session owned stats.session while it had active subagents:
// stamped with a sticky parentSession, blocked from global state, and
// falsely retiring the real subagent's synthetic orbital.

describe('update-state -- parallel sessions vs subagents (#134)', () => {
  const UPDATE_STATE = path.join(__dirname, '..', 'update-state.js');

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

  // Stats blob for an owner session conducting one subagent
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

module.exports = suite;
