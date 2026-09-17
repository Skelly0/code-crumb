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
// |                                                                |
// |  Each adapter imports these helpers and supplies its own       |
// |  event normalisation + mapping logic.                          |
// +================================================================+

const fs = require('fs');
const path = require('path');
const {
  STATE_FILE, SESSIONS_DIR, STATS_FILE, STATS_LOCK_FILE,
  safeFilename, writeJsonAtomic, acquireFileLock,
} = require('../shared');
const {
  toolToState, classifyToolResult, classifyTruncatedInput, updateStreak, defaultStats, normalizeStats,
  EDIT_TOOLS,
  pruneFrequentFiles, topFrequentFiles, prettyModelName,
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

function writeState(state, detail = '', extra = {}) {
  const data = { state, detail, timestamp: Date.now(), ...pidField(), ...extra };
  try { writeJsonAtomic(STATE_FILE, data, 0o600); } catch {}
}

function writeSessionState(sessionId, state, detail = '', stopped = false, extra = {}) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    const filename = safeFilename(sessionId) + '.json';
    const data = {
      session_id: sessionId, state, detail,
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
  try { writeJsonAtomic(STATS_FILE, stats, 0o600); } catch {}
}

// -- Session-guarded global state write --------------------------------
// Only writes the global state file if no other active session owns it.

function guardedWriteState(sessionId, state, detail, extra) {
  let writeExtra = extra;
  try {
    const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (existing.sessionId && existing.sessionId !== sessionId &&
        !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
      return; // Another session owns the state file
    }
    // Preserve stopped flag — late PostToolUse must not erase a prior Stop
    if (existing.stopped && existing.sessionId === sessionId && !writeExtra?.stopped) {
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

function initSession(stats, sessionId) {
  const today = new Date().toISOString().slice(0, 10);
  if (!stats.daily || stats.daily.date !== today) {
    stats.daily = { date: today, sessionCount: 0, cumulativeMs: 0 };
  }
  if (!stats.frequentFiles) stats.frequentFiles = {};
  if (stats.session.id !== sessionId) {
    stats.daily.sessionCount++;
    stats.session = { id: sessionId, start: Date.now(), toolCalls: 0, filesEdited: [], subagentCount: 0, commitCount: 0, activeSubagents: [] };
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
  const currentSessionMs = stats.session.start ? Date.now() - stats.session.start : 0;
  return {
    sessionId,
    modelName,
    ...(model ? { model } : {}),
    editor: editor || '',
    toolCalls: stats.session.toolCalls,
    filesEdited: stats.session.filesEdited.length,
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
    if (base) stats.frequentFiles[base] = (stats.frequentFiles[base] || 0) + 1;
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
  return result;
}

// -- Stdin JSON reader -------------------------------------------------
// Reads all of stdin as a single JSON blob, parses it, and calls the
// provided handler function. This is the pattern used by opencode-adapter,
// openclaw-adapter, and similar stdin-based adapters.
//
// handler(data) should process the parsed event object.
// On parse failure, fallbackFn(err) is called if provided. A throw inside
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
      writeState(truncResult.state, truncResult.detail);
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
    try { handler(data); } catch {}
    exit(0);
  });
  // 'end' handler above already calls exit(0); no 'close' handler needed
}

// -- Stdin JSONL (streaming) reader ------------------------------------
// Reads newline-delimited JSON from a stream (e.g. a child process stdout).
// Calls handler(event) for each parsed JSON line.

function processJsonlStream(stream, handler) {
  let buffer = '';
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
    buffer += chunk.toString();
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
  stream.on('end', flush);
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
    // self-describing and never collide across editors.
    const sessionId = norm.sessionId
      || data.session_id
      || process.env.CLAUDE_SESSION_ID
      || `${defaultEditor}-${process.ppid}`;
    const modelName = norm.modelName
      || data.model_name
      || process.env.CODE_CRUMB_MODEL
      || defaultModel;
    const editor = norm.editor
      || data.editor
      || process.env.CODE_CRUMB_EDITOR
      || defaultEditor;
    // Real model identity, when an adapter can supply one. No env fallback:
    // CODE_CRUMB_MODEL overrides modelName (the display name), not this.
    // Prettified here so every adapter can just forward the provider's raw id.
    const model = prettyModelName(norm.model || data.model || '');

    // Read -> mutate -> write of the shared stats file, serialized: several
    // adapter processes can run at once and the last writer would otherwise
    // drop the others' counter increments. A failed acquire proceeds
    // unlocked -- the lock must never cost the adapter its event.
    const releaseStats = acquireFileLock(STATS_LOCK_FILE);
    try {
      const stats = readStats();
      initSession(stats, sessionId);

      const extra = buildExtra(stats, sessionId, modelName, editor, model);

      // Attention stamp for the renderer's main-face policy. Each adapter
      // event is its own process, so the session file is the only memory:
      // the first event of a session, or the first after a turn end, starts a
      // new turn and stamps now; anything else carries the old stamp forward.
      let prevSession = null;
      try {
        prevSession = JSON.parse(fs.readFileSync(
          path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'), 'utf8'));
      } catch {}
      const endsTurn = event === 'turn_end' || event === 'Stop' || event === 'session_end' || event === 'error';
      // A live file with no stamp self-heals rather than staying blind for the
      // whole turn: an `error` can be the first event a session ever writes,
      // and an upgrade can land mid-turn over a pre-feature session file.
      if (!endsTurn && (!prevSession || prevSession.stopped || !prevSession.lastPromptAt)) extra.lastPromptAt = Date.now();
      else if (prevSession && prevSession.lastPromptAt) extra.lastPromptAt = prevSession.lastPromptAt;

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
        detail = data.message || data.reason || data.output?.error || 'something went wrong';
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

      guardedWriteState(sessionId, state, detail, extra);
      writeSessionState(sessionId, state, detail, stopped, extra);
      pruneFrequentFiles(stats.frequentFiles);
      writeStats(stats);
    } finally {
      if (releaseStats) releaseStats();
    }
  }, () => {
    // Fallback on parse error -- write thinking state with guard.
    // Same editor-prefixed ID as the main path so the session never splits.
    const sessionId = process.env.CLAUDE_SESSION_ID || `${defaultEditor}-${process.ppid}`;
    guardedWriteState(sessionId, 'thinking', '', {});
  });
}

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
};
