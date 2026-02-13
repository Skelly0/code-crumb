#!/usr/bin/env node
'use strict';

// +================================================================+
// |  OpenClaw Adapter -- bridges OpenClaw/Pi events to Code Crumb    |
// |                                                                  |
// |  OpenClaw (formerly Clawdbot/Moltbot) uses the Pi coding agent  |
// |  engine. Pi's core tools: read, write, edit, bash.            |
// |  OpenClaw adds: exec, process, browser, canvas, sessions, etc.  |
// |                                                                  |
// |  This adapter accepts events via stdin JSON, supporting both    |
// |  Pi-native event names and the generic Code Crumb format.        |
// |                                                                  |
// |  Pi-native events:                                               |
// |    tool_call            → before tool execution                 |
// |    tool_execution_start → tool execution begins                 |
// |    tool_execution_end   → tool execution completes              |
// |    tool_result          → after tool execution (with output)    |
// |                                                                  |
// |  Generic events (also accepted):                                 |
// |    tool_start, tool_end, turn_end, error, waiting               |
// |                                                                  |
// |  Usage (standalone):                                             |
// |    echo '{"event":"tool_call","toolName":"edit",...}' |         |
// |      node adapters/openclaw-adapter.js                           |
// |                                                                  |
// |  Usage (as Pi extension -- add to your skill or extension):     |
// |    const { execSync } = require('child_process');                |
// |    pi.on('tool_call', (event) => {                              |
// |      execSync(`echo '${JSON.stringify({                         |
// |        event: 'tool_call',                                       |
// |        toolName: event.toolName,                                 |
// |        input: event.input                                        |
// |      })}' | node /path/to/openclaw-adapter.js`);                |
// |    });                                                           |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR, STATS_FILE, safeFilename } = require('../shared');
const {
  toolToState, classifyToolResult, updateStreak, defaultStats,
  EDIT_TOOLS, SUBAGENT_TOOLS,
} = require('../state-machine');

// -- State writing (mirrors update-state.js) -------------------------

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

function readStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, 'utf8')); }
  catch { return defaultStats(); }
}

function writeStats(stats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8'); } catch {}
}

// -- Event normalisation ---------------------------------------------
// Pi uses event names like tool_call, tool_execution_start, etc.
// Normalise them to the generic tool_start / tool_end format.

function normalisePiEvent(raw) {
  switch (raw) {
    case 'tool_call':
    case 'tool_execution_start':
      return 'tool_start';
    case 'tool_execution_end':
    case 'tool_result':
      return 'tool_end';
    case 'session_end':
    case 'turn_end':
    case 'Stop':
      return 'turn_end';
    case 'Notification':
      return 'waiting';
    default:
      return raw; // tool_start, tool_end, error, waiting pass through
  }
}

// -- Main handler ----------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const event = normalisePiEvent(data.event || '');
    // Pi uses toolName; generic uses tool/tool_name
    const toolName = data.toolName || data.tool || data.tool_name || '';
    const toolInput = data.input || data.tool_input || {};
    const toolOutput = data.output || data.result || '';
    const isError = data.error || data.is_error || data.blocked || false;
    const sessionId = data.session_id
      || process.env.CLAUDE_SESSION_ID
      || String(process.ppid);

    const stats = readStats();
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

    // Model name: from event data, env var, or default to 'openclaw'
    const modelName = data.model_name || process.env.CODE_CRUMB_MODEL || 'openclaw';

    const currentSessionMs = stats.session.start ? Date.now() - stats.session.start : 0;
    const extra = {
      modelName,
      toolCalls: stats.session.toolCalls,
      filesEdited: stats.session.filesEdited.length,
      sessionStart: stats.session.start,
      streak: stats.streak, bestStreak: stats.bestStreak,
      brokenStreak: stats.brokenStreak, brokenStreakAt: stats.brokenStreakAt,
      milestone: stats.recentMilestone, diffInfo: null,
      dailySessions: stats.daily.sessionCount,
      dailyCumulativeMs: stats.daily.cumulativeMs + currentSessionMs,
      frequentFiles: stats.frequentFiles,
    };

    let state = 'thinking';
    let detail = '';
    let stopped = false;

    if (event === 'tool_start' || event === 'PreToolUse') {
      ({ state, detail } = toolToState(toolName, toolInput));
      stats.session.toolCalls++;
      stats.totalToolCalls = (stats.totalToolCalls || 0) + 1;

      if (EDIT_TOOLS.test(toolName)) {
        const fp = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
        const base = fp ? path.basename(fp) : '';
        if (base && !stats.session.filesEdited.includes(base)) {
          stats.session.filesEdited.push(base);
        }
        if (base) stats.frequentFiles[base] = (stats.frequentFiles[base] || 0) + 1;
      }
      if (SUBAGENT_TOOLS.test(toolName)) stats.session.subagentCount++;
    }
    else if (event === 'tool_end' || event === 'PostToolUse') {
      const toolResponse = { stdout: toolOutput, stderr: data.stderr || '', isError };
      const result = classifyToolResult(toolName, toolInput, toolResponse, isError);
      state = result.state;
      detail = result.detail;
      extra.diffInfo = result.diffInfo;
      updateStreak(stats, state === 'error');
    }
    else if (event === 'turn_end') {
      state = 'happy';
      detail = 'all done!';
      stopped = true;
    }
    else if (event === 'error') {
      state = 'error';
      detail = data.message || data.reason || 'something went wrong';
      updateStreak(stats, true);
    }
    else if (event === 'waiting') {
      state = 'waiting';
      detail = 'needs attention';
    }

    extra.toolCalls = stats.session.toolCalls;
    extra.filesEdited = stats.session.filesEdited.length;

    writeState(state, detail, extra);
    writeSessionState(sessionId, state, detail, stopped, extra);
    writeStats(stats);
  } catch {
    writeState('thinking');
  }

  process.exit(0);
});

process.stdin.on('close', () => { process.exit(0); });
