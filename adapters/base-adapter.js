'use strict';

// +================================================================+
// |  Base Adapter -- shared logic for all Code Crumb adapters           |
// |                                                                  |
// |  Provides:                                                       |
// |    - writeState / writeSessionState   (state file IPC)           |
// |    - readStats / writeStats           (persistent stats)         |
// |    - guardedWriteState                (session-aware global)     |
// |    - initSession                      (stats bootstrapping)      |
// |    - buildExtra                       (extra fields for state)   |
// |    - handleToolStart / handleToolEnd  (common tool event logic)  |
// |    - processStdinEvent                (stdin JSON reader loop)   |
// |    - trackEditedFile                  (file tracking helper)     |
// |                                                                  |
// |  Each adapter imports these helpers and supplies its own         |
// |  event normalisation + mapping logic.                            |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR, STATS_FILE, safeFilename } = require('../shared');
const {
  toolToState, classifyToolResult, updateStreak, defaultStats,
  EDIT_TOOLS,
} = require('../state-machine');

// -- State file writing ------------------------------------------------

function writeState(state, detail = '', extra = {}) {
  const data = JSON.stringify({ state, detail, timestamp: Date.now(), ...extra });
  try { fs.writeFileSync(STATE_FILE, data, 'utf8'); } catch {}
}

function writeSessionState(sessionId, state, detail = '', stopped = false, extra = {}) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const filename = safeFilename(sessionId) + '.json';
    const data = JSON.stringify({
      session_id: sessionId, state, detail,
      timestamp: Date.now(), cwd: process.cwd(), stopped, ...extra,
    });
    fs.writeFileSync(path.join(SESSIONS_DIR, filename), data, 'utf8');
  } catch {}
}

// -- Stats persistence -------------------------------------------------

function readStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch { return defaultStats(); }
}

function writeStats(stats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8'); } catch {}
}

// -- Session-guarded global state write --------------------------------
// Only writes the global state file if no other active session owns it.

function guardedWriteState(sessionId, state, detail, extra) {
  try {
    const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (existing.sessionId && existing.sessionId !== sessionId &&
        !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
      return; // Another session owns the state file
    }
  } catch {}
  writeState(state, detail, extra);
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
    stats.session = { id: sessionId, start: Date.now(), toolCalls: 0, filesEdited: [], subagentCount: 0 };
  }
  if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
    stats.recentMilestone = null;
  }
}

// -- Extra fields builder ----------------------------------------------
// Constructs the metadata object included in every state file write.

function buildExtra(stats, sessionId, modelName) {
  const currentSessionMs = stats.session.start ? Date.now() - stats.session.start : 0;
  return {
    sessionId,
    modelName,
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
    frequentFiles: stats.frequentFiles,
  };
}

// -- File tracking helper ----------------------------------------------

function trackEditedFile(stats, toolName, toolInput) {
  if (EDIT_TOOLS.test(toolName)) {
    const fp = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
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
// On parse failure, fallbackFn(err) is called if provided.

function processStdinEvent(handler, fallbackFn) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      handler(data);
    } catch (err) {
      if (fallbackFn) {
        try { fallbackFn(err); } catch {}
      }
    }
    process.exit(0);
  });
  process.stdin.on('close', () => { process.exit(0); });
}

// -- Stdin JSONL (streaming) reader ------------------------------------
// Reads newline-delimited JSON from a stream (e.g. a child process stdout).
// Calls handler(event) for each parsed JSON line.

function processJsonlStream(stream, handler) {
  let buffer = '';
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
}

// -- Full stdin-based adapter runner -----------------------------------
// Wires up the complete flow: read stdin JSON, init session, normalise
// event, map to state, write state files + stats.
//
// Options:
//   defaultModel   - model name fallback (e.g. 'opencode', 'openclaw')
//   normaliseEvent - fn(data) => { event, toolName, toolInput, toolOutput, isError, sessionId, modelName }
//   mapEvent       - fn(event, toolName, toolInput, toolOutput, isError, data)
//                    => { state, detail, stopped, extra } or null to use defaults
//
// normaliseEvent extracts adapter-specific fields from the parsed JSON.
// mapEvent handles adapter-specific event types (like OpenCode's message_update).
// Common events (tool_start, tool_end, turn_end, error, waiting) are handled
// automatically if mapEvent returns null.

function runStdinAdapter(options) {
  const { defaultModel, normaliseEvent, mapEvent } = options;

  processStdinEvent((data) => {
    const norm = normaliseEvent(data);
    const event = norm.event || '';
    const toolName = norm.toolName || '';
    const toolInput = norm.toolInput || {};
    const toolOutput = norm.toolOutput || '';
    const isError = norm.isError || false;
    const sessionId = norm.sessionId
      || data.session_id
      || process.env.CLAUDE_SESSION_ID
      || String(process.ppid);
    const modelName = norm.modelName
      || data.model_name
      || process.env.CODE_CRUMB_MODEL
      || defaultModel;

    const stats = readStats();
    initSession(stats, sessionId);

    const extra = buildExtra(stats, sessionId, modelName);

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

    guardedWriteState(sessionId, state, detail, extra);
    writeSessionState(sessionId, state, detail, stopped, extra);
    writeStats(stats);
  }, () => {
    // Fallback on parse error -- write thinking state with guard
    const sessionId = process.env.CLAUDE_SESSION_ID || String(process.ppid);
    guardedWriteState(sessionId, 'thinking', '', {});
  });
}

module.exports = {
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
