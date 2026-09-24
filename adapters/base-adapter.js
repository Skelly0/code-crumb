'use strict';

// +================================================================+
// |  Base Adapter -- shared logic for all Code Crumb adapters      |
// |                                                                |
// |  Provides:                                                     |
// |    - writeState / writeSessionState   (state file IPC)         |
// |    - readStats / writeStats           (persistent stats)       |
// |    - guardedWriteState                (session-aware global)   |
// |    - initSession                      (stats bootstrapping)    |
// |    - buildExtra                       (extra fields for state) |
// |    - handleToolStart / handleToolEnd  (common tool event logic)|
// |    - processStdinEvent                (stdin JSON reader loop) |
// |    - trackEditedFile                  (file tracking helper)   |
// |    - signalExitCode                   (128 + signal number)    |
// |                                                                |
// |  Each adapter imports these helpers and supplies its own       |
// |  event normalisation + mapping logic.                          |
// +================================================================+

const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const {
  STATE_FILE, SESSIONS_DIR, STATS_FILE, STATS_LOCK_FILE,
  safeFilename, writeJsonAtomic, acquireFileLock, detailText,
} = require('../shared');
const {
  toolToState, classifyToolResult, classifyTruncatedInput, updateStreak, defaultStats, normalizeStats,
  EDIT_TOOLS,
  pruneFrequentFiles, topFrequentFiles, prettyModelName, toText,
  COUNTER_MAX_FILES, freshCounter, normalizeCounter, parkAgents, unparkAgents, pruneCounters,
  creditSession, creditEndFor, localDay,
} = require('../state-machine');

// -- State file writing ------------------------------------------------

// Same PID policy as update-state.js: ppid is the editor on Unix (per-event
// processes like codex-notify run as its children) and enables liveness
// rescue; on Windows ppid is a transient cmd.exe shim -- useless and a
// PID-recycling hazard -- so it is omitted and staleness timeouts apply.
// Long-lived adapters (codex-wrapper) override via extra.pid.
function pidField() {
  return process.platform !== 'win32' ? { pid: process.ppid } : {};
}

// Every adapter detail goes through here: providers hand over raw error
// objects and multi-line messages (an OpenClaw `message: {code, text}` object,
// a Codex notify reply with blank lines), which the renderer cannot draw.
// The cap keeps a long provider error inside the ~1 KB state-file budget.
const MAX_DETAIL_CHARS = 200;
function cleanDetail(detail) {
  return detailText(detail).slice(0, MAX_DETAIL_CHARS);
}

function writeState(state, detail = '', extra = {}) {
  const data = { state, detail: cleanDetail(detail), timestamp: Date.now(), ...pidField(), ...extra };
  try { writeJsonAtomic(STATE_FILE, data, 0o600); } catch {}
}

function writeSessionState(sessionId, state, detail = '', stopped = false, extra = {}) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    const filename = safeFilename(sessionId) + '.json';
    const data = {
      session_id: sessionId, state, detail: cleanDetail(detail),
      timestamp: Date.now(), cwd: process.cwd(), stopped,
      ...pidField(),
      ...extra,
    };
    writeJsonAtomic(path.join(SESSIONS_DIR, filename), data, 0o600);
  } catch {}
}

// -- Stats persistence -------------------------------------------------

// Always returns a fully-shaped stats object: a {} or old-schema file must
// not make stats.session.id throw inside an adapter.
function readStats() {
  try { return normalizeStats(JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))); }
  catch { return defaultStats(); }
}

function writeStats(stats) {
  try { syncSessionCounter(stats); } catch {}
  try { writeJsonAtomic(STATS_FILE, stats, 0o600); } catch {}
}

// Mirror the owner's live counters into its sessionCounters entry, so a later
// switch away and back (by an adapter or by update-state.js) restores them.
function syncSessionCounter(stats, now = Date.now()) {
  const id = stats && stats.session && stats.session.id;
  if (!id) return;
  const counters = sessionCounters(stats);
  let c = normalizeCounter(counters[id], now);
  if (!c) c = counters[id] = freshCounter(now);
  c.toolCalls = stats.session.toolCalls || 0;
  c.filesEdited = (stats.session.filesEdited || [])
    .filter(f => typeof f === 'string').slice(0, COUNTER_MAX_FILES);
  if (stats.session.start) c.start = stats.session.start;
  c.commitCount = stats.session.commitCount || 0;
  c.lastSeen = now;
  pruneCounters(counters, id, now);
}

// Fold the owner's elapsed time into today's total and the records, as
// update-state.js does at Stop/SessionEnd. Adapters never did, so an
// OpenCode/OpenClaw/Codex session's time only reached daily.cumulativeMs when
// another session took ownership away from it.
function creditOwnerSession(stats, now = Date.now()) {
  try {
    syncSessionCounter(stats, now);
    const c = stats.sessionCounters && stats.sessionCounters[stats.session.id];
    if (c) creditSession(stats, c, now);
  } catch {}
}

function sessionCounters(stats) {
  if (!stats.sessionCounters || typeof stats.sessionCounters !== 'object'
      || Array.isArray(stats.sessionCounters)) {
    stats.sessionCounters = Object.create(null);
  }
  return stats.sessionCounters;
}

// -- Session-guarded global state write --------------------------------
// Only writes the global state file if no other active session owns it.
//
// opts.toolEnd: this write is a tool END (tool_end / PostToolUse). Only
// such a write can straggle in after the turn it belongs to has ended, so it
// is the only one that keeps the global file's `stopped` -- the same rule as
// update-state.js. Every other event is the session doing something new, and
// carrying `stopped` onto it left tmux reporting a working session as done
// for the whole of the next turn.

function guardedWriteState(sessionId, state, detail, extra, opts = {}) {
  let writeExtra = extra;
  try {
    const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (existing.sessionId && existing.sessionId !== sessionId &&
        !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
      return; // Another session owns the state file
    }
    // Preserve stopped flag -- a late tool end must not erase a prior Stop
    if (opts.toolEnd && existing.stopped && existing.sessionId === sessionId &&
        !writeExtra?.stopped) {
      writeExtra = { ...writeExtra, stopped: true };
    }
    // Preserve model name established by the session owner. See also: update-state.js guard
    // block (same logic for Claude Code hooks) and face.js setStats (env var wins at render).
    if (existing.sessionId === sessionId && existing.modelName) {
      writeExtra = { ...writeExtra, modelName: existing.modelName };
      extra.modelName = existing.modelName; // Propagate to caller (writeSessionState)
    }
    // Same preservation for editor provenance
    if (existing.sessionId === sessionId && existing.editor) {
      writeExtra = { ...writeExtra, editor: existing.editor };
      extra.editor = existing.editor;
    }
    // And for the real model. This is what makes `model` sticky on the adapter
    // path at all -- writeSessionState rebuilds its object from scratch, so
    // nothing else carries it forward. It matters for OpenCode: the plugin
    // remembers the model in memory, so an OpenCode restart would otherwise
    // drop the field from the session file until the next assistant message.
    if (existing.sessionId === sessionId && existing.model && !extra.model) {
      writeExtra = { ...writeExtra, model: existing.model };
      extra.model = existing.model;
    }
  } catch {}
  writeState(state, detail, writeExtra);
}

// -- Stats initialisation ----------------------------------------------
// Call once per event to ensure the stats object has today's daily bucket
// and the current session is tracked.

// A change of owner follows the update-state.js contract: the incoming
// session gets its OWN counters back (a switch is not a new session), it is
// counted in daily.sessionCount once per id and day, and the outgoing owner's
// running agents are parked on its counter entry. Zeroing here used to make two
// alternating adapter sessions each report a single tool call, count a
// "session" per event, and wipe a conducting Claude owner's activeSubagents
// -- leaving its synthetic orbitals nothing to retire them.
function initSession(stats, sessionId) {
  const now = Date.now();
  const today = localDay(now);
  if (!stats.daily || stats.daily.date !== today) {
    stats.daily = { date: today, sessionCount: 0, cumulativeMs: 0 };
  }
  if (!stats.frequentFiles) stats.frequentFiles = Object.create(null);
  const counters = sessionCounters(stats);
  // Seed the owner's entry from stats.session when it has none (a stats file
  // from before the map): it was counted when it was adopted.
  if (stats.session.id && !normalizeCounter(counters[stats.session.id], now)) {
    counters[stats.session.id] = {
      ...freshCounter(stats.session.start || now),
      toolCalls: stats.session.toolCalls || 0,
      filesEdited: (stats.session.filesEdited || []).filter(f => typeof f === 'string').slice(0, COUNTER_MAX_FILES),
      commitCount: stats.session.commitCount || 0,
      lastSeen: now, countedDay: stats.daily.date,
    };
  }
  let counter = normalizeCounter(counters[sessionId], now);
  if (!counter) counter = counters[sessionId] = freshCounter(now);
  counter.lastSeen = now;
  // Once per session per day -- a session running across midnight counts in
  // the new day too (see freshCounter's countedDay).
  if (counter.countedDay !== stats.daily.date) {
    stats.daily.sessionCount++;
    counter.countedDay = stats.daily.date;
  }
  if (stats.session.id !== sessionId) {
    const outgoing = stats.session.id ? normalizeCounter(counters[stats.session.id], now) : null;
    // Credit the outgoing owner up to its own last activity (creditEndFor),
    // as update-state.js does on a switch.
    if (outgoing) creditSession(stats, outgoing, creditEndFor(outgoing, now));
    if (outgoing) parkAgents(outgoing, stats.session);
    stats.session = {
      id: sessionId, start: counter.start,
      toolCalls: counter.toolCalls, filesEdited: counter.filesEdited.slice(),
      subagentCount: 0, commitCount: counter.commitCount, activeSubagents: [],
    };
    unparkAgents(counter, stats.session);
  }
  if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
    stats.recentMilestone = null;
  }
}

// -- Extra fields builder ----------------------------------------------
// Constructs the metadata object included in every state file write.

// `model` is spread conditionally rather than defaulted to '': an empty key in
// every write costs the ~1 KB state-file budget for nothing, and would defeat
// the `!extra[field]` sticky test on the reading side.
function buildExtra(stats, sessionId, modelName, editor, model) {
  // Minus what update-state.js already credited to daily.cumulativeMs when it
  // took ownership away from this session -- the same sum it writes itself.
  // Restoring the session's original start made that time count twice.
  const counter = stats.sessionCounters && stats.sessionCounters[sessionId];
  const credited = counter && typeof counter.creditedMs === 'number' ? counter.creditedMs : 0;
  const currentSessionMs = stats.session.start ? Math.max(0, Date.now() - stats.session.start - credited) : 0;
  return {
    sessionId,
    modelName,
    ...(model ? { model } : {}),
    editor: editor || '',
    toolCalls: stats.session.toolCalls,
    filesEdited: stats.session.filesEdited.length,
    // Without it the face never showed the commit marker for an adapter
    // session, though update-state.js writes it for Claude/Codex hooks.
    commitCount: stats.session.commitCount || 0,
    sessionStart: stats.session.start,
    streak: stats.streak,
    bestStreak: stats.bestStreak,
    brokenStreak: stats.brokenStreak,
    brokenStreakAt: stats.brokenStreakAt,
    milestone: stats.recentMilestone,
    diffInfo: null,
    dailySessions: stats.daily.sessionCount,
    dailyCumulativeMs: stats.daily.cumulativeMs + currentSessionMs,
    frequentFiles: topFrequentFiles(stats.frequentFiles),
  };
}

// -- File tracking helper ----------------------------------------------

function trackEditedFile(stats, toolName, toolInput) {
  if (EDIT_TOOLS.test(toolName)) {
    const raw = toolInput?.file_path || toolInput?.notebook_path || toolInput?.path || toolInput?.target_file || '';
    const fp = typeof raw === 'string' ? raw : '';
    const base = fp ? path.basename(fp) : '';
    if (base && !stats.session.filesEdited.includes(base)) {
      stats.session.filesEdited.push(base);
    }
    if (base) {
      stats.frequentFiles[base] = (stats.frequentFiles[base] || 0) + 1;
      pruneFrequentFiles(stats.frequentFiles, base);
    }
  }
}

// -- Common tool event handlers ----------------------------------------

function handleToolStart(stats, toolName, toolInput) {
  const result = toolToState(toolName, toolInput);
  stats.session.toolCalls++;
  stats.totalToolCalls = (stats.totalToolCalls || 0) + 1;
  trackEditedFile(stats, toolName, toolInput);
  return result;
}

function handleToolEnd(stats, toolName, toolInput, toolResponse, isError) {
  const result = classifyToolResult(toolName, toolInput, toolResponse, isError);
  updateStreak(stats, result.state === 'error');
  // Same rule as update-state.js: a commit counts for this session.
  if (result.state === 'proud' && result.detail === 'committed') {
    stats.session.commitCount = (stats.session.commitCount || 0) + 1;
  }
  return result;
}

// -- Signal exit codes -------------------------------------------------
// The shell convention for "died of signal N" is 128 + N (SIGINT 130,
// SIGTERM 143). Long-lived wrappers exit with it both when they catch a signal
// themselves and when the child they wrapped was killed by one -- a killed
// child reports code null, and `code || 0` used to turn that into success.

function signalExitCode(signal) {
  const n = (signal && os.constants.signals[signal]) || 0;
  return n ? 128 + n : 1;
}

// -- Exiting after a passthrough ---------------------------------------
// A write to a piped stdout is asynchronous on POSIX, and process.exit()
// discards whatever the pipe has not taken yet: a 200 KB engmux result
// reached its reader as 146 KB, and a slow reader of codex-wrapper lost the
// last JSONL lines (turn.completed among them). Writes complete in order, so
// the callback of an empty write fires once everything before it is out.
function exitWhenFlushed(code, stream = process.stdout) {
  process.exitCode = code;
  try {
    stream.write('', () => process.exit(code));
  } catch {
    process.exit(code);
  }
}

// -- Stdin JSON reader -------------------------------------------------
// Reads all of stdin as a single JSON blob, parses it, and calls the
// provided handler function. This is the pattern used by opencode-adapter,
// openclaw-adapter, and similar stdin-based adapters.
//
// handler(data) should process the parsed event object. A JSON array is a
// batch (the OpenCode plugin queues a session's events while its previous
// child runs): each element is handled in order, as if it had been its own
// process, and one element's throw does not stop the rest.
// On parse failure, fallbackFn(err) is called if provided; on input over
// MAX_INPUT, fallbackFn(null, { override, raw }) -- override is the
// classifyTruncatedInput result, raw the truncated text. A throw inside
// handler() is swallowed on its own -- it must NOT be reported as
// "unparseable stdin", or every mapping bug would hide behind the fallback's
// thinking face.
//
// opts.stream / opts.exit exist for tests (default: process.stdin / process.exit).

function processStdinEvent(handler, fallbackFn, opts = {}) {
  const stream = opts.stream || process.stdin;
  const exit = opts.exit || ((code) => process.exit(code));
  let input = '';
  const MAX_INPUT = 1048576;
  let inputTruncated = false;
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    if (input.length < MAX_INPUT) input += chunk;
    else inputTruncated = true;
  });
  stream.on('end', () => {
    if (inputTruncated) {
      const truncResult = classifyTruncatedInput('', input);
      // The adapter's fallback knows the session and takes the ownership
      // guard; a bare writeState let any huge payload (a Write of a big file)
      // clobber the global file another live session owns.
      if (fallbackFn) {
        try { fallbackFn(null, { override: truncResult, raw: input }); } catch {}
      } else {
        writeState(truncResult.state, truncResult.detail);
      }
      exit(0);
      return;
    }
    let data;
    try {
      data = JSON.parse(input);
    } catch (err) {
      if (fallbackFn) {
        try { fallbackFn(err); } catch {}
      }
      exit(0);
      return;
    }
    for (const item of Array.isArray(data) ? data : [data]) {
      try { handler(item); } catch {}
    }
    exit(0);
  });
  // 'end' handler above already calls exit(0); no 'close' handler needed
}

// -- Stdin JSONL (streaming) reader ------------------------------------
// Reads newline-delimited JSON from a stream (e.g. a child process stdout).
// Calls handler(event) for each parsed JSON line.

function processJsonlStream(stream, handler) {
  let buffer = '';
  // Decode across chunk boundaries: chunk.toString() on each Buffer turned a
  // multi-byte character split between two chunks into two U+FFFD, so a path
  // like café.js reached the face (and frequentFiles) garbled.
  const decoder = new StringDecoder('utf8');
  const flush = () => {
    if (buffer.trim()) {
      try {
        const event = JSON.parse(buffer);
        handler(event);
      } catch {
        // Not valid JSON, skip
      }
    }
  };
  stream.on('data', (chunk) => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop(); // Keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        handler(event);
      } catch {
        // Not valid JSON, skip
      }
    }
  });
  stream.on('end', () => {
    buffer += decoder.end();
    flush();
  });
}

// -- Full stdin-based adapter runner -----------------------------------
// Wires up the complete flow: read stdin JSON, init session, normalise
// event, map to state, write state files + stats.
//
// Options:
//   defaultModel   - model name fallback (e.g. 'opencode', 'openclaw')
//   defaultEditor  - editor provenance fallback (e.g. 'opencode', 'openclaw')
//   normaliseEvent - fn(data) => { event, toolName, toolInput, toolOutput, isError, sessionId, modelName, editor }
//   mapEvent       - fn(event, toolName, toolInput, toolOutput, isError, data)
//                    => { state, detail, stopped, extra } or null to use defaults
//
// normaliseEvent extracts adapter-specific fields from the parsed JSON.
// mapEvent handles adapter-specific event types (like OpenCode's message_update).
// Common events (tool_start, tool_end, turn_end, error, waiting) are handled
// automatically if mapEvent returns null.

function runStdinAdapter(options) {
  const { defaultModel, defaultEditor, normaliseEvent, mapEvent } = options;

  processStdinEvent((data) => {
    const norm = normaliseEvent(data);
    const event = norm.event || '';
    const toolName = norm.toolName || '';
    const toolInput = norm.toolInput || {};
    const toolOutput = norm.toolOutput || '';
    const isError = norm.isError || false;
    // Fallback ID is editor-prefixed so anonymous sessions are
    // self-describing and never collide across editors. Every identity field
    // is text (update-state.js does the same): an object session_id keyed the
    // renderer's faces by a fresh object on every load (a respawn and a swap
    // animation every 2s), a number made the session list read the selection
    // as a row index, and an object model_name crashed the renderer's labels.
    const sessionId = toText(norm.sessionId)
      || toText(data.session_id)
      || process.env.CLAUDE_SESSION_ID
      || `${defaultEditor}-${process.ppid}`;
    const modelName = toText(norm.modelName)
      || toText(data.model_name)
      || process.env.CODE_CRUMB_MODEL
      || defaultModel;
    const editor = toText(norm.editor)
      || toText(data.editor)
      || process.env.CODE_CRUMB_EDITOR
      || defaultEditor;
    // Real model identity, when an adapter can supply one. No env fallback:
    // CODE_CRUMB_MODEL overrides modelName (the display name), not this.
    // Prettified here so every adapter can just forward the provider's raw id.
    const model = prettyModelName(norm.model || data.model || '');

    // The session file is the only memory an adapter has (each event is its
    // own process): the attention stamp, the model and the parent below all
    // come from it.
    let prevSession = null;
    try {
      prevSession = JSON.parse(fs.readFileSync(
        path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'), 'utf8'));
    } catch {}
    if (!prevSession || typeof prevSession !== 'object') prevSession = null;

    // A child session -- OpenCode's task tool runs one per delegated task --
    // is an orbital of its parent, like a Claude Code subagent: it never
    // stamps attention (every task used to take the center from the session
    // that launched it), never owns the global file, counts its tool calls
    // toward its parent, and its turn end retires it. Only session.created
    // names the parent, so later events take it from the session file.
    let parentSession = toText(norm.parentSession) || toText(data.parentSession)
      || (prevSession ? toText(prevSession.parentSession) : '');
    if (parentSession === sessionId) parentSession = '';
    const statsId = parentSession || sessionId;

    // Read -> mutate -> write of the shared stats file, serialized: several
    // adapter processes can run at once and the last writer would otherwise
    // drop the others' counter increments. A failed acquire proceeds
    // unlocked -- the lock must never cost the adapter its event.
    const releaseStats = acquireFileLock(STATS_LOCK_FILE);
    try {
      const stats = readStats();
      initSession(stats, statsId);

      const extra = buildExtra(stats, statsId, modelName, editor, model);
      extra.sessionId = sessionId;
      if (parentSession) extra.parentSession = parentSession;

      // Attention stamp for the renderer's main-face policy: the first event
      // of a session, or the first after a turn end, starts a new turn and
      // stamps now; anything else carries the old stamp forward.
      // The session file is the only memory an adapter has, and a plugin that
      // restarts holds no model until its next message: carry it forward.
      if (prevSession && prevSession.model && !extra.model) extra.model = prevSession.model;
      const endsTurn = event === 'turn_end' || event === 'Stop' || event === 'session_end' || event === 'error';
      // A tool end can straggle in after the turn (or session) it belongs to
      // has ended. It is not a new turn: it must neither re-stamp attention
      // (that stole the center for a session the user had finished with) nor
      // erase the turn end. update-state.js treats a late PostToolUse the same.
      const isToolEnd = event === 'tool_end' || event === 'PostToolUse';
      const lateToolEnd = isToolEnd && !!prevSession && !!(prevSession.stopped || prevSession.turnEnded);
      // A live file with no stamp self-heals rather than staying blind for the
      // whole turn: an `error` can be the first event a session ever writes,
      // and an upgrade can land mid-turn over a pre-feature session file.
      if (!endsTurn && !lateToolEnd && !parentSession &&
          (!prevSession || prevSession.stopped || prevSession.turnEnded || !prevSession.lastPromptAt)) {
        extra.lastPromptAt = Date.now();
      } else if (prevSession && prevSession.lastPromptAt) {
        extra.lastPromptAt = prevSession.lastPromptAt;
      }

      let state = 'thinking';
      let detail = '';
      let stopped = false;

      // Let the adapter handle custom event types first
      const custom = mapEvent
        ? mapEvent(event, toolName, toolInput, toolOutput, isError, data)
        : null;

      if (custom) {
        state = custom.state || state;
        detail = custom.detail || detail;
        stopped = custom.stopped || false;
        if (custom.extra) Object.assign(extra, custom.extra);
      }
      // Common event handling
      else if (event === 'tool_start' || event === 'PreToolUse') {
        ({ state, detail } = handleToolStart(stats, toolName, toolInput));
      }
      else if (event === 'tool_end' || event === 'PostToolUse') {
        const toolResponse = { stdout: toolOutput, stderr: norm.stderr || '', isError };
        const result = handleToolEnd(stats, toolName, toolInput, toolResponse, isError);
        state = result.state;
        detail = result.detail;
        extra.diffInfo = result.diffInfo;
      }
      else if (event === 'turn_end' || event === 'Stop' || event === 'session_end') {
        state = 'happy';
        detail = 'all done!';
        stopped = true;
      }
      else if (event === 'error') {
        state = 'error';
        detail = toText(data.message) || toText(data.reason) || toText(data.output?.error)
          || 'something went wrong';
        updateStreak(stats, true);
      }
      else if (event === 'waiting' || event === 'Notification') {
        state = 'waiting';
        detail = 'needs attention';
      }

      // Update extra with latest counters
      extra.toolCalls = stats.session.toolCalls;
      extra.filesEdited = stats.session.filesEdited.length;
      if (stopped) extra.stopped = true;

      // A turn (or session) end folds this session's time into today's
      // total and the records. (extra's dailyCumulativeMs already counts
      // that time as the running session's, so it reads the same.)
      if (stopped && !parentSession) creditOwnerSession(stats);
      // Built before the tool end was classified, so refresh the commit count.
      extra.commitCount = stats.session.commitCount || 0;
      if (!parentSession) guardedWriteState(sessionId, state, detail, extra, { toolEnd: isToolEnd });
      // A turn end is not a session end. On the session file `stopped` is
      // reserved for session_end (the update-state.js contract): the orbital
      // loader latches it and the main policy drops a stopped session, so a
      // turn-end `stopped` bounced the center away and back every turn and
      // released any pin on it. The global file keeps `stopped` for tmux.
      // A child's turn end is its whole life: it retires like a subagent.
      const turnOnly = stopped && event !== 'session_end' && !parentSession;
      const sessionExtra = { ...extra };
      if (turnOnly) { delete sessionExtra.stopped; sessionExtra.turnEnded = true; }
      let sessionStopped = stopped && !turnOnly;
      // A late tool end keeps whatever end its session file already records:
      // `stopped` after a session_end, `turnEnded` after a turn end.
      if (lateToolEnd && !stopped) {
        if (prevSession.stopped) sessionStopped = true;
        else sessionExtra.turnEnded = true;
      }
      writeSessionState(sessionId, state, detail, sessionStopped, sessionExtra);
      pruneFrequentFiles(stats.frequentFiles);
      writeStats(stats);
    } finally {
      if (releaseStats) releaseStats();
    }
  }, (err, trunc) => {
    // Fallback on unparseable or oversized stdin -- still this session's
    // event, so it goes through the ownership guard, under the payload's own
    // id when a truncated one still names it, else the same editor-prefixed
    // id as the main path so the session never splits. The id rides in extra
    // too: a write without one erased the owner's sessionId from the global
    // file, and the next event from any other window took it over.
    const rawId = trunc
      ? ((/"session_?id"\s*:\s*"([^"\\]{1,256})"/i.exec(trunc.raw) || [])[1] || '') : '';
    const sessionId = rawId || process.env.CLAUDE_SESSION_ID || `${defaultEditor}-${process.ppid}`;
    // What the oversized payload was. Only a tool END is judged for errors:
    // judging any event as one read a huge Write's content ("exit code 2")
    // as a failure. A tool start shows its tool; anything else, thinking.
    const raw = trunc ? trunc.raw : '';
    const rawType = (/"(?:type|event)"\s*:\s*"([^"\\]{1,64})"/.exec(raw) || [])[1] || '';
    const rawTool = (/"(?:tool_name|toolName|tool)"\s*:\s*"([^"\\]{1,128})"/.exec(raw) || [])[1] || '';
    const toolEnd = TRUNC_TOOL_END_RE.test(rawType);
    let shown;
    if (!trunc) shown = { state: 'thinking', detail: '' };
    else if (toolEnd || !rawType) shown = classifyTruncatedInput(toolEnd ? 'PostToolUse' : '', raw);
    else if (TRUNC_TOOL_START_RE.test(rawType) && rawTool) shown = toolToState(rawTool, {});
    else shown = { state: 'thinking', detail: 'large input' };

    // The session file too, like update-state.js's fallback: without it the
    // orbital (or the main face, which reads the session file) stood on the
    // tool's start for up to the 10-minute long-tool hold.
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'), 'utf8'));
    } catch {}
    if (!prev || typeof prev !== 'object') prev = null;
    const extra = {
      sessionId,
      modelName: (prev && toText(prev.modelName)) || process.env.CODE_CRUMB_MODEL || defaultModel,
      editor: (prev && toText(prev.editor)) || defaultEditor,
    };
    for (const k of ['lastPromptAt', 'model', 'parentSession', 'taskDescription']) {
      if (prev && prev[k]) extra[k] = prev[k];
    }
    if (!extra.parentSession) {
      guardedWriteState(sessionId, shown.state, shown.detail, { ...extra }, { toolEnd });
    }
    if (!(prev && prev.stopped)) {
      const sessionExtra = { ...extra };
      if (prev && (prev.turnEnded || prev.turnOver) && toolEnd) sessionExtra.turnEnded = true;
      writeSessionState(sessionId, shown.state, shown.detail, false, sessionExtra);
    }
  });
}

// Event types in an oversized adapter payload (OpenCode plugin, OpenClaw,
// generic), read out of the raw text by the fallback above.
const TRUNC_TOOL_END_RE = /^(?:tool\.execute\.after|tool\.error|tool_end|tool_result|PostToolUse|PostToolUseFailure)$/;
const TRUNC_TOOL_START_RE = /^(?:tool\.execute\.before|tool_start|tool_call|PreToolUse)$/;

module.exports = {
  pidField,
  writeState,
  writeSessionState,
  readStats,
  writeStats,
  guardedWriteState,
  initSession,
  buildExtra,
  trackEditedFile,
  handleToolStart,
  handleToolEnd,
  processStdinEvent,
  processJsonlStream,
  runStdinAdapter,
  signalExitCode,
  exitWhenFlushed,
  creditOwnerSession,
};
