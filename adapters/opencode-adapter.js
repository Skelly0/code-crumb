#!/usr/bin/env node
'use strict';

// +================================================================+
// |  OpenCode Adapter -- bridges OpenCode events to Code Crumb          |
// |                                                                  |
// |  OpenCode uses a plugin system that emits events like:         |
// |    - tool.execute.before  (maps to tool_start state)           |
// |    - tool.execute.after   (maps to tool_end state)             |
// |    - session.idle         (maps to turn_end/happy)            |
// |    - session.error        (maps to error state)                |
// |                                                                  |
// |  Usage (with OpenCode plugin):                                  |
// |    Add a plugin that pipes events to this adapter via stdin.   |
// |                                                                  |
// |  Event Schema from OpenCode plugins:                            |
// |    {                                                             |
// |      "type": "tool.execute.before"|"tool.execute.after"|...    |
// |      "input": { "tool": "...", "args": {...} },                |
// |      "output": {...}                                            |
// |    }                                                             |
// |                                                                  |
// |  Also supports generic format for compatibility:               |
// |    { "event": "tool_start"|"tool_end"|"turn_end"|"error", ... } |
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

// -- Main handler ----------------------------------------------------

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    
    // OpenCode uses "type" for event name, generic uses "event"
    const event = data.type || data.event || '';
    
    // OpenCode: input.tool, input.args; Generic: tool, tool_input
    const opencodeInput = data.input || {};
    const toolName = opencodeInput.tool || data.tool || data.tool_name || '';
    const toolArgs = opencodeInput.args || {};
    const toolInput = data.input || data.tool_input || toolArgs;
    const toolOutput = data.output?.content?.[0]?.text 
      || data.output?.output 
      || data.output 
      || '';
    const isError = data.output?.error || data.error || data.is_error || false;
    
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
    if (!stats.session.activeSubagents) stats.session.activeSubagents = [];
    stats.session.activeSubagents = stats.session.activeSubagents.filter(
      sub => Date.now() - sub.startedAt < 600000
    );

    if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
      stats.recentMilestone = null;
    }

    // Model name: from event data, env var, or default to 'opencode'
    const modelName = data.model_name || process.env.CODE_CRUMB_MODEL || 'opencode';

    const currentSessionMs = stats.session.start ? Date.now() - stats.session.start : 0;
    const extra = {
      sessionId,
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

    // Map OpenCode event types to internal event names
    const mappedEvent = 
      event === 'session.created' ? 'session_start' :
      event === 'message.part.updated' ? 'message_update' :
      event === 'tool.execute.before' ? 'tool_start' :
      event === 'tool.execute.after' ? 'tool_end' :
      event === 'session.idle' ? 'turn_end' :
      event === 'session.error' ? 'error' :
      event;

    if (mappedEvent === 'session_start') {
      state = 'waiting';
      detail = 'session started';
    }
    else if (mappedEvent === 'message_update') {
      if (data.is_thinking) {
        state = 'thinking';
        detail = data.thinking || 'analyzing';
      } else if (data.tools_called) {
        state = 'responding';
        detail = 'generating response';
      } else {
        state = 'waiting';
        detail = 'receiving message';
      }
    }
    else if (mappedEvent === 'tool_start' || mappedEvent === 'PreToolUse') {
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
    else if (mappedEvent === 'tool_end' || mappedEvent === 'PostToolUse') {
      const toolResponse = { stdout: toolOutput, stderr: data.output?.error || '', isError };
      const result = classifyToolResult(toolName, toolInput, toolResponse, isError);
      state = result.state;
      detail = result.detail;
      extra.diffInfo = result.diffInfo;
      updateStreak(stats, state === 'error');
    }
    else if (mappedEvent === 'turn_end' || mappedEvent === 'Stop' || mappedEvent === 'session_end') {
      state = 'happy';
      detail = 'all done!';
      stopped = true;
      // Clean up synthetic subagent sessions
      for (const sub of stats.session.activeSubagents) {
        writeSessionState(sub.id, 'happy', 'done', true, {
          sessionId: sub.id, stopped: true, cwd: '', parentSession: sessionId,
        });
      }
      stats.session.activeSubagents = [];
    }
    else if (mappedEvent === 'error') {
      state = 'error';
      detail = data.output?.error || data.message || 'something went wrong';
      updateStreak(stats, true);
    }
    else if (mappedEvent === 'waiting' || mappedEvent === 'Notification') {
      state = 'waiting';
      detail = 'needs attention';
    }

    const isSubagentTool = SUBAGENT_TOOLS.test(toolName);

    if ((mappedEvent === 'tool_start' || mappedEvent === 'PreToolUse') && isSubagentTool) {
      const subId = `${sessionId}-sub-${Date.now()}`;
      const desc = (toolInput.description || toolInput.prompt || 'subagent').slice(0, 40);
      stats.session.activeSubagents.push({ id: subId, description: desc, startedAt: Date.now() });
      writeSessionState(subId, 'thinking', desc, false, {
        sessionId: subId, modelName: toolInput.model || 'opencode', cwd: '', parentSession: sessionId,
      });
      state = 'subagent';
      detail = `conducting ${stats.session.activeSubagents.length}`;
    } else if ((mappedEvent === 'tool_end' || mappedEvent === 'PostToolUse') && isSubagentTool && stats.session.activeSubagents.length > 0) {
      const finished = stats.session.activeSubagents.shift();
      writeSessionState(finished.id, 'happy', 'done', true, {
        sessionId: finished.id, stopped: true, cwd: '', parentSession: sessionId,
      });
      if (stats.session.activeSubagents.length > 0) {
        state = 'subagent';
        detail = `conducting ${stats.session.activeSubagents.length}`;
      }
    } else if (stats.session.activeSubagents.length > 0 && !isSubagentTool &&
               mappedEvent !== 'turn_end' && mappedEvent !== 'Stop' && mappedEvent !== 'session_end' &&
               mappedEvent !== 'waiting' && mappedEvent !== 'Notification') {
      const latestSub = stats.session.activeSubagents[stats.session.activeSubagents.length - 1];
      writeSessionState(latestSub.id, state, detail, false, {
        sessionId: latestSub.id, cwd: '', parentSession: sessionId,
      });
      state = 'subagent';
      detail = `conducting ${stats.session.activeSubagents.length}`;
    }

    extra.toolCalls = stats.session.toolCalls;
    extra.filesEdited = stats.session.filesEdited.length;

    // Guard global state file — don't let other sessions overwrite the owner
    let shouldWriteGlobal = true;
    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (existing.sessionId && existing.sessionId !== sessionId &&
          !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
        shouldWriteGlobal = false;
      }
    } catch {}

    if (shouldWriteGlobal) writeState(state, detail, extra);
    writeSessionState(sessionId, state, detail, stopped, extra);
    writeStats(stats);
  } catch {
    // Guard global state file even in error fallback
    let shouldWriteGlobal = true;
    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (existing.sessionId && existing.sessionId !== sessionId &&
          !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
        shouldWriteGlobal = false;
      }
    } catch {}
    if (shouldWriteGlobal) writeState('thinking');
  }

  process.exit(0);
});

process.stdin.on('close', () => { process.exit(0); });
