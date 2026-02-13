#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Hook -- writes state for the face renderer              |
// |  Called by editor hooks via stdin JSON                           |
// |  Usage: node update-state.js <event>                            |
// |  Events: PreToolUse, PostToolUse, Stop, Notification            |
// |                                                                  |
// |  Works with Claude Code, Codex CLI, and OpenCode                |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR, STATS_FILE, safeFilename } = require('./shared');
const {
  toolToState, classifyToolResult, updateStreak, defaultStats,
  EDIT_TOOLS, SUBAGENT_TOOLS,
} = require('./state-machine');

// Event type passed as CLI argument (cross-platform -- no env var tricks)
const hookEvent = process.argv[2] || '';

// -- File I/O --------------------------------------------------------

// Write to the single state file (backward compat with renderer.js)
function writeState(state, detail = '', extra = {}) {
  const data = JSON.stringify({ state, detail, timestamp: Date.now(), ...extra });
  try {
    fs.writeFileSync(STATE_FILE, data, 'utf8');
  } catch {
    // Silently fail -- don't break Claude Code
  }
}

// Write per-session state file for the grid renderer
function writeSessionState(sessionId, state, detail = '', stopped = false, extra = {}) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const filename = safeFilename(sessionId) + '.json';
    const data = JSON.stringify({
      session_id: sessionId, state, detail,
      timestamp: Date.now(), cwd: process.cwd(), stopped,
      ...extra,
    });
    fs.writeFileSync(path.join(SESSIONS_DIR, filename), data, 'utf8');
  } catch {
    // Silently fail
  }
}

// Persistent stats (streaks, records, session counters)
function readStats() {
  try {
    return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'));
  } catch {
    return defaultStats();
  }
}

function writeStats(stats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8'); } catch {}
}

// -- Main handler ----------------------------------------------------

// Read stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let state = 'thinking';
  let detail = '';
  let stopped = false;
  let diffInfo = null;

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const toolResponse = data.tool_response || {};

    // Extract session ID: try hook data, env, then fall back to PPID
    const sessionId = data.session_id
      || process.env.CLAUDE_SESSION_ID
      || String(process.ppid);

    // Load persistent stats
    const stats = readStats();

    // Daily tracking -- reset counters on new day
    const today = new Date().toISOString().slice(0, 10);
    if (!stats.daily || stats.daily.date !== today) {
      stats.daily = { date: today, sessionCount: 0, cumulativeMs: 0 };
    }
    if (!stats.frequentFiles) stats.frequentFiles = {};

    // Initialize session if new
    if (stats.session.id !== sessionId) {
      // Save records from previous session before resetting
      if (stats.session.id && stats.session.start) {
        const dur = Date.now() - stats.session.start;
        if (dur > (stats.records.longestSession || 0)) stats.records.longestSession = dur;
        if ((stats.session.filesEdited?.length || 0) > (stats.records.mostFilesEdited || 0)) {
          stats.records.mostFilesEdited = stats.session.filesEdited.length;
        }
        if ((stats.session.subagentCount || 0) > (stats.records.mostSubagents || 0)) {
          stats.records.mostSubagents = stats.session.subagentCount;
        }
        stats.daily.cumulativeMs += dur;
      }
      stats.daily.sessionCount++;
      stats.session = {
        id: sessionId, start: Date.now(),
        toolCalls: 0, filesEdited: [], subagentCount: 0,
      };
    }

    // Clear old milestones (older than 8 seconds)
    if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
      stats.recentMilestone = null;
    }

    if (hookEvent === 'PreToolUse') {
      ({ state, detail } = toolToState(toolName, toolInput));
      stats.session.toolCalls++;
      stats.totalToolCalls = (stats.totalToolCalls || 0) + 1;

      // Track files edited (multi-editor: Claude Code, Codex, OpenCode)
      if (EDIT_TOOLS.test(toolName)) {
        const fp = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
        const base = fp ? path.basename(fp) : '';
        if (base && !stats.session.filesEdited.includes(base)) {
          stats.session.filesEdited.push(base);
        }
        if (base) {
          stats.frequentFiles[base] = (stats.frequentFiles[base] || 0) + 1;
        }
      }

      // Track subagents
      if (SUBAGENT_TOOLS.test(toolName)) {
        stats.session.subagentCount++;
        if (stats.session.subagentCount > (stats.records.mostSubagents || 0)) {
          stats.records.mostSubagents = stats.session.subagentCount;
        }
      }
    }
    else if (hookEvent === 'PostToolUse') {
      const isErrorFlag = toolResponse?.isError || data?.isError || false;
      const result = classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag);
      state = result.state;
      detail = result.detail;
      diffInfo = result.diffInfo;

      updateStreak(stats, state === 'error');
    }
    else if (hookEvent === 'Stop') {
      state = 'happy';
      detail = 'all done!';
      stopped = true;

      // Update session records
      if (stats.session.start) {
        const dur = Date.now() - stats.session.start;
        if (dur > (stats.records.longestSession || 0)) stats.records.longestSession = dur;
        stats.daily.cumulativeMs += dur;
        stats.session.start = 0; // Prevent double-counting on next session change
      }
      if ((stats.session.filesEdited?.length || 0) > (stats.records.mostFilesEdited || 0)) {
        stats.records.mostFilesEdited = stats.session.filesEdited.length;
      }
    }
    else if (hookEvent === 'Notification') {
      state = 'waiting';
      detail = 'needs attention';
    }
    else {
      if (toolName) {
        ({ state, detail } = toolToState(toolName, toolInput));
      }
    }

    // Model name: from event data, env var, or default to 'claude'
    const modelName = data.model_name || process.env.CODE_CRUMB_MODEL || 'claude';

    // Build extra data for state files
    const currentSessionMs = stats.session.start ? Date.now() - stats.session.start : 0;
    const extra = {
      modelName,
      toolCalls: stats.session.toolCalls,
      filesEdited: stats.session.filesEdited.length,
      sessionStart: stats.session.start,
      streak: stats.streak,
      bestStreak: stats.bestStreak,
      brokenStreak: stats.brokenStreak,
      brokenStreakAt: stats.brokenStreakAt,
      milestone: stats.recentMilestone,
      diffInfo,
      dailySessions: stats.daily.sessionCount,
      dailyCumulativeMs: stats.daily.cumulativeMs + currentSessionMs,
      frequentFiles: stats.frequentFiles,
    };

    // Write both: single file (backward compat) + session file (grid mode)
    writeState(state, detail, extra);
    writeSessionState(sessionId, state, detail, stopped, extra);
    writeStats(stats);
  } catch {
    writeState('thinking');
  }

  process.exit(0);
});

process.stdin.on('close', () => {
  process.exit(0);
});
