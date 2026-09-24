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
// Read per spawn, not at import: OpenCode loads a plugin once when it
// starts, so a variable captured here would outlive any change to it.
function nodeBinary() {
  return process.env.CODE_CRUMB_NODE || 'node';
}

// Never embed tool output in a state file: the adapter only needs enough
// text for the error forensics.
const MAX_OUTPUT = 4000;

// The adapter reads at most 1 MB of stdin, and anything over it is judged
// from the raw text alone: a batch over the cap lost every event in it. So
// no single argument may be huge (a Write's whole file), and a batch is cut
// before it reaches the cap. A long argument keeps its line count -- the
// adapter counts a write's lines for the "+N" thought -- as bare newlines.
const MAX_FIELD = 64 * 1024;
const MAX_BATCH_BYTES = 900 * 1024;

function capText(v) {
  if (typeof v !== 'string' || v.length <= MAX_FIELD) return v;
  let lines = 0;
  for (let i = v.indexOf('\n', MAX_FIELD); i !== -1; i = v.indexOf('\n', i + 1)) lines++;
  return v.slice(0, MAX_FIELD) + '\n'.repeat(lines);
}

function capInput(v, depth = 0) {
  if (typeof v === 'string') return capText(v);
  if (!v || typeof v !== 'object' || depth > 3) return v;
  if (Array.isArray(v)) return v.map(x => capInput(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = capInput(x, depth + 1);
  return out;
}

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
      // The task tool runs each delegated task in a child session
      // (sessions.create({ parentID })). This is the only event that names
      // the parent; `send` remembers it for the child's later payloads.
      case 'session.created': {
        const info = p.info || {};
        return typeof info.parentID === 'string' && info.parentID
          ? { type: 'session.created', sessionId: info.id, parentSession: info.parentID }
          : { type: 'session.created', sessionId: info.id };
      }
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
      // An assistant message names the provider model it ran on. This is the
      // only place OpenCode reports it, and it is NOT forwarded as an event
      // of its own -- `send` records it and spawns nothing, then stamps it
      // onto the payloads already going out. Otherwise a streaming turn would
      // cost a node start per message update.
      //
      // UNVERIFIED against a live OpenCode: the field names below are the
      // documented SDK shape, but nobody has watched a real message.updated
      // go past. Guarded so a wrong guess simply yields no model.
      case 'message.updated': {
        const info = p.info || {};
        return info.modelID
          ? { type: 'model.observed', sessionId: info.sessionID, model: String(info.modelID) }
          : null;
      }
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
            toolInput: capInput(part.state.input || {}),
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
      toolInput: capInput(o.args || {}),
    };
  }
  if (hook === 'tool.execute.after') {
    return {
      type: 'tool.execute.after',
      sessionId: i.sessionID,
      callID: i.callID,
      tool: i.tool,
      toolInput: capInput(i.args || {}),
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

// The last provider model reported, per session. Keyed the same way
// `throttled` is, and for the same reason: one OpenCode process can have
// several sessions in flight, and an unkeyed value would stamp session A's
// model onto session B's orbital. Cleared wholesale rather than pruned.
const lastModelBySession = new Map();
const MAX_MODEL_KEYS = 64;

// Child session -> its parent, from session.created. The adapter also keeps
// it on the child's session file, so a plugin restart (or a cleared map)
// costs nothing once the child has written once.
const parentBySession = new Map();
const MAX_PARENT_KEYS = 256;

// Per-session delivery order for the async payloads. Each one used to be its
// own node process and nothing ordered two of them: for a fast tool the
// `after` child could take the stats lock and write before the `before` child
// (4-7 runs in 30), leaving the face on "reading ... still running" after the
// tool had finished. A session now has one child at a time; whatever arrives
// meanwhile queues and goes out as ONE batch (the adapter takes a JSON array
// and applies it in order) when that child is done, so a burst costs a single
// cold start. The hooks still return at once. A child that hangs holds its
// session's queue for CHAIN_WAIT_MS at most.
//
// The turn-end payloads (SYNC_TYPES) take the session's queue with them, in
// the same synchronous batch: queued events used to spawn AFTER the turn end
// and undo it -- a late tool.execute.before re-opened the turn, re-stamped
// attention and cleared `stopped`.
const CHAIN_WAIT_MS = 3000;
const queues = new Map(); // sessionId -> { running, pending: [{ json, node, bytes }] }

// This plugin instance, and the order it reported events in.
const PLUGIN_ID = `${process.pid}-${Date.now().toString(36)}`;
let sequence = 0;

// Resolves when the child is done (or CHAIN_WAIT_MS passes); never rejects,
// whatever spawn does -- under EMFILE a child comes back with no stdin, and a
// throw here used to leave a rejected promise that muted the session for good.
function spawnAdapter(node, input) {
  return new Promise((resolve) => {
    try {
      const child = spawn(node, [ADAPTER], {
        stdio: ['pipe', 'ignore', 'ignore'],
        windowsHide: true,
      });
      const timer = setTimeout(resolve, CHAIN_WAIT_MS);
      if (timer.unref) timer.unref();
      const done = () => { clearTimeout(timer); resolve(); };
      child.on('error', done);
      child.on('close', done);
      if (!child.stdin) { done(); return; }
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    } catch {
      resolve();
    }
  });
}

// One payload is sent as itself, several as a JSON array.
function batchInput(items) {
  return items.length === 1 ? items[0].json : `[${items.map(i => i.json).join(',')}]`;
}

// The first items of `pending` that fit in one adapter's stdin (always at
// least one), taken out of it.
function takeBatch(pending) {
  let bytes = 2;
  let n = 0;
  while (n < pending.length && (n === 0 || bytes + pending[n].bytes + 1 <= MAX_BATCH_BYTES)) {
    bytes += pending[n].bytes + 1;
    n++;
  }
  return pending.splice(0, n);
}

function pump(key) {
  const q = queues.get(key);
  if (!q || q.running) return;
  if (!q.pending.length) { queues.delete(key); return; }
  const batch = takeBatch(q.pending);
  q.running = true;
  spawnAdapter(batch[0].node, batchInput(batch)).then(() => {
    q.running = false;
    pump(key);
  });
}

function sendInOrder(key, node, json) {
  let q = queues.get(key);
  if (!q) { q = { running: false, pending: [] }; queues.set(key, q); }
  q.pending.push(item(json, node));
  pump(key);
}

function item(json, node) {
  return { json, node, bytes: Buffer.byteLength(json) };
}

// Everything still queued for this session, taken out of the queue.
function takeQueued(key) {
  const q = queues.get(key);
  return q ? q.pending.splice(0) : [];
}

// Returns whether the payload was handed to a child process. OpenCode
// ignores what a hook resolves to; the tests use it to count sends.
function send(payload) {
  if (!payload) return false;
  try {
    // Observation only: record and spend no process on it.
    if (payload.type === 'model.observed') {
      if (payload.model) {
        if (lastModelBySession.size >= MAX_MODEL_KEYS) lastModelBySession.clear();
        lastModelBySession.set(payload.sessionId || '', payload.model);
      }
      return false;
    }
    if (payload.parentSession && payload.sessionId) {
      if (parentBySession.size >= MAX_PARENT_KEYS) parentBySession.clear();
      parentBySession.set(payload.sessionId, payload.parentSession);
    }
    if (throttled(payload, Date.now())) return false;
    const known = lastModelBySession.get(payload.sessionId || '');
    if (known && !payload.model) payload = { ...payload, model: known };
    const parent = parentBySession.get(payload.sessionId || '');
    if (parent && !payload.parentSession) payload = { ...payload, parentSession: parent };
    // Numbered in the order OpenCode reported them (see the adapter's
    // straggler rule): a child can land after a later synchronous turn end.
    payload = { ...payload, seq: ++sequence, pluginId: PLUGIN_ID };
    const json = JSON.stringify(payload);
    const node = nodeBinary();
    if (SYNC_TYPES.has(payload.type)) {
      const batch = takeQueued(payload.sessionId || '');
      batch.push(item(json, node));
      // In order, each within the stdin cap; the turn end is in the last.
      while (batch.length) {
        spawnSync(node, [ADAPTER], {
          input: batchInput(takeBatch(batch)),
          stdio: ['pipe', 'ignore', 'ignore'],
          windowsHide: true,
          timeout: SYNC_CAP_MS,
        });
      }
      return true;
    }
    sendInOrder(payload.sessionId || '', node, json);
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

// Test seams: a static property is invisible to the plugin loader.
CodeCrumbPlugin.translate = translate;
CodeCrumbPlugin.takeBatch = takeBatch;
