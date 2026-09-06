// +================================================================+
// |  OpenCode Plugin -- the shipped Code Crumb plugin (1.18 API)   |
// |                                                                |
// |  OpenCode loads plugins with its own Bun runtime, so this file |
// |  is ESM (.mjs, strict by default) while the rest of the        |
// |  package stays CommonJS.                                       |
// |                                                                |
// |  Install:                                                      |
// |    node setup.js opencode --install                            |
// |  or by hand, in ~/.config/opencode/opencode.json:              |
// |    { "plugin": ["<repo>/adapters/opencode-plugin.mjs"] }       |
// |                                                                |
// |  Hook shapes (@opencode-ai/plugin 1.18):                       |
// |    event(input)                    input  = { event }          |
// |    tool.execute.before(in, out)    out    = { args }           |
// |    tool.execute.after(in, out)     out    = { title, output }  |
// |    permission.ask(input, out)      input  = Permission         |
// |                                                                |
// |  Turn boundaries, reasoning and errors are NOT hooks: they     |
// |  arrive on the bus through event(). tool.execute.after is not  |
// |  called when a tool throws -- those show up as a               |
// |  message.part.updated whose part.state.status is 'error'.      |
// |                                                                |
// |  translate() is pure, so the whole payload contract is         |
// |  testable from Node without a Bun child process.               |
// +================================================================+

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ADAPTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'opencode-adapter.js');

// process.execPath is the Bun binary in here, and the adapter is plain
// CommonJS Node code -- resolve node explicitly. A bare `node` is a real
// executable on every platform (never a .cmd shim), so no shell is needed.
const NODE = process.env.CODE_CRUMB_NODE || 'node';

// Never embed tool output in a state file: the adapter only needs enough
// text for the error forensics.
const MAX_OUTPUT = 4000;

// -- Pure translation ---------------------------------------------------
// One OpenCode hook call or bus event -> one adapter stdin payload, or null
// when there is nothing worth showing.
//
// Not exported on its own: OpenCode calls EVERY named export as a plugin
// factory and then reads .config / .dispose off whatever came back, so a
// second export -- even a pure helper -- kills plugin loading with
// "null is not an object (evaluating 'N.config')". It is hung off the
// factory below instead, where tests can still reach it.

function translate(hook, input, output) {
  if (hook === 'event') {
    const ev = input && input.event;
    if (!ev) return null;
    const p = ev.properties || {};
    switch (ev.type) {
      case 'session.created':
        return { type: 'session.created', sessionId: p.info && p.info.id };
      case 'session.idle':
        return { type: 'session.idle', sessionId: p.sessionID };
      case 'session.error':
        return { type: 'session.error', sessionId: p.sessionID, error: errorText(p.error) };
      // 1.18.21 emits permission.asked; permission.updated is the older
      // spelling of the same Permission payload.
      case 'permission.asked':
      case 'permission.updated':
        return { type: 'permission.asked', sessionId: p.sessionID, title: p.title || p.type };
      case 'permission.replied':
        return { type: 'permission.replied', sessionId: p.sessionID, response: p.response };
      case 'message.part.updated': {
        const part = p.part || {};
        if (part.type === 'reasoning') {
          return { type: 'thinking', sessionId: part.sessionID };
        }
        if (part.type === 'tool' && part.state && part.state.status === 'error') {
          return {
            type: 'tool.error',
            sessionId: part.sessionID,
            callID: part.callID,
            tool: part.tool,
            toolInput: part.state.input || {},
            error: errorText(part.state.error),
          };
        }
        return null;
      }
      default:
        return null;
    }
  }
  const i = input || {};
  const o = output || {};
  if (hook === 'tool.execute.before') {
    return {
      type: 'tool.execute.before',
      sessionId: i.sessionID,
      callID: i.callID,
      tool: i.tool,
      toolInput: o.args || {},
    };
  }
  if (hook === 'tool.execute.after') {
    return {
      type: 'tool.execute.after',
      sessionId: i.sessionID,
      callID: i.callID,
      tool: i.tool,
      toolInput: i.args || {},
      title: o.title,
      output: typeof o.output === 'string' ? o.output.slice(0, MAX_OUTPUT) : '',
    };
  }
  if (hook === 'permission.ask') {
    return { type: 'permission.asked', sessionId: i.sessionID, title: i.title || i.type };
  }
  return null;
}

// SDK errors are { name, data: { message } }; a tool error state is a plain
// string. Both have to end up as one short line of text.
function errorText(e) {
  if (!e) return 'error';
  if (typeof e === 'string') return e;
  return e.message || (e.data && e.data.message) || e.name || e.type || 'error';
}

// -- Delivery -----------------------------------------------------------
// Fire and forget: a face must never block, slow or break OpenCode. The old
// documented snippet used execSync with a 200ms timeout, which killed a cold
// Node start (60-150ms on Windows) mid-write.
//
// The exception is the end of a turn. `opencode run` exits the moment the
// turn is over and takes the freshly spawned child with it -- measured
// against 1.18.21: session.idle arrived 200ms after the last successful
// write and never landed, leaving the face on `thinking` and the global
// state file owned by a session that never said `stopped`. Returning a
// promise from the hook does not help; OpenCode does not wait for it. So the
// two payloads that race process exit are written synchronously. The turn is
// already over, so the pause costs the user nothing.
const SYNC_TYPES = new Set(['session.idle', 'session.error']);

// Safety valve only. The old documented snippet used 200ms, which is less
// than a cold Node start on Windows, so its writes were killed mid-flight.
const SYNC_CAP_MS = 5000;

// A reasoning part is republished on every streaming delta -- dozens per
// message. The face says the same thing for all of them, so collapse a burst
// into one write instead of paying a cold Node start and a stats
// read-modify-write per chunk. A long stream still refreshes itself often
// enough to stay ahead of the renderer's 45s thinking timeout.
const THROTTLE_MS = 5000;
const THROTTLED_TYPES = new Set(['thinking']);
// One entry per streaming session; cleared wholesale rather than pruned,
// since a stale entry only costs one extra write.
const MAX_THROTTLE_KEYS = 64;
const lastSentAt = new Map();

function throttled(payload, now) {
  if (!THROTTLED_TYPES.has(payload.type)) return false;
  const key = `${payload.type}:${payload.sessionId || ''}`;
  if (now - (lastSentAt.get(key) || 0) < THROTTLE_MS) return true;
  if (lastSentAt.size >= MAX_THROTTLE_KEYS) lastSentAt.clear();
  lastSentAt.set(key, now);
  return false;
}

// Returns whether the payload was handed to a child process. OpenCode
// ignores what a hook resolves to; the tests use it to count sends.
function send(payload) {
  if (!payload) return false;
  try {
    if (throttled(payload, Date.now())) return false;
    const json = JSON.stringify(payload);
    if (SYNC_TYPES.has(payload.type)) {
      spawnSync(NODE, [ADAPTER], {
        input: json,
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
        timeout: SYNC_CAP_MS,
      });
      return true;
    }
    const child = spawn(NODE, [ADAPTER], {
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(json);
    return true;
  } catch {
    return false;
  }
}

// -- Plugin -------------------------------------------------------------
// Exactly one export, and it is a plugin factory: see the note on
// translate() above.

// Total by construction. OpenCode awaits the tool.execute.* hooks, so a
// throw or a rejection here would surface inside the editor -- whatever the
// payload looks like, a broken face stays the face's problem.
async function dispatch(hook, input, output) {
  try {
    return send(translate(hook, input, output));
  } catch {
    return false;
  }
}

export const CodeCrumbPlugin = async () => ({
  event: async (input) => dispatch('event', input),
  'tool.execute.before': async (input, output) => dispatch('tool.execute.before', input, output),
  'tool.execute.after': async (input, output) => dispatch('tool.execute.after', input, output),
  'permission.ask': async (input, output) => dispatch('permission.ask', input, output),
});

// Test seam: a static property is invisible to the plugin loader.
CodeCrumbPlugin.translate = translate;
