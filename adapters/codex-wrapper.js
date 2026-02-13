#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Codex Wrapper -- bridges OpenAI Codex CLI to Code Crumb           |
// |                                                                  |
// |  Wraps `codex exec --json` and translates JSONL events into     |
// |  Code Crumb state file writes. Only works in non-interactive    |
// |  (headless) mode since Codex lacks a hook system.               |
// |                                                                  |
// |  Usage:                                                          |
// |    node adapters/codex-wrapper.js "your prompt here"            |
// |    node adapters/codex-wrapper.js --approval auto "fix the bug" |
// |                                                                  |
// |  All flags before the last argument are passed to codex exec.    |
// +================================================================+

const { spawn } = require('child_process');
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

// -- JSONL Event Processor -------------------------------------------

const sessionId = process.env.CLAUDE_SESSION_ID || `codex-${process.pid}`;
const stats = readStats();

// Initialize session
const today = new Date().toISOString().slice(0, 10);
if (!stats.daily || stats.daily.date !== today) {
  stats.daily = { date: today, sessionCount: 0, cumulativeMs: 0 };
}
if (!stats.frequentFiles) stats.frequentFiles = {};
if (stats.session.id !== sessionId) {
  stats.daily.sessionCount++;
  stats.session = { id: sessionId, start: Date.now(), toolCalls: 0, filesEdited: [], subagentCount: 0 };
}

// Model name: from env var or default to 'codex'
const modelName = process.env.CODE_CRUMB_MODEL || 'codex';

// Track active tool calls by item ID
const activeTools = new Map();

function buildExtra() {
  const currentSessionMs = stats.session.start ? Date.now() - stats.session.start : 0;
  return {
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

function handleEvent(event) {
  try {
    const type = event.type || '';
    const item = event.item || {};

    // Clear old milestones
    if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
      stats.recentMilestone = null;
    }

    // Tool call started (item.created with tool_use type)
    if (type === 'item.created' && item.type === 'tool_use') {
      const toolName = item.name || item.tool_name || '';
      const toolInput = item.input || item.tool_input || {};

      activeTools.set(item.id, { toolName, toolInput });

      const { state, detail } = toolToState(toolName, toolInput);
      stats.session.toolCalls++;
      stats.totalToolCalls = (stats.totalToolCalls || 0) + 1;

      // Track files edited
      if (EDIT_TOOLS.test(toolName)) {
        const fp = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
        const base = fp ? path.basename(fp) : '';
        if (base && !stats.session.filesEdited.includes(base)) {
          stats.session.filesEdited.push(base);
        }
        if (base) stats.frequentFiles[base] = (stats.frequentFiles[base] || 0) + 1;
      }
      if (SUBAGENT_TOOLS.test(toolName)) {
        stats.session.subagentCount++;
      }

      writeState(state, detail, buildExtra());
      writeSessionState(sessionId, state, detail, false, buildExtra());
      writeStats(stats);
    }

    // Tool call completed (item.completed with tool_use type)
    else if (type === 'item.completed' && item.type === 'tool_use') {
      const cached = activeTools.get(item.id) || {};
      const toolName = cached.toolName || item.name || '';
      const toolInput = cached.toolInput || item.input || {};
      const output = item.output || '';
      const isError = item.status === 'failed' || item.error != null;

      const toolResponse = { stdout: output, stderr: '', isError };
      const result = classifyToolResult(toolName, toolInput, toolResponse, isError);
      updateStreak(stats, result.state === 'error');

      const extra = buildExtra();
      extra.diffInfo = result.diffInfo;
      writeState(result.state, result.detail, extra);
      writeSessionState(sessionId, result.state, result.detail, false, extra);
      writeStats(stats);
      activeTools.delete(item.id);
    }

    // Turn completed
    else if (type === 'turn.completed') {
      writeState('happy', 'all done!', buildExtra());
      writeSessionState(sessionId, 'happy', 'all done!', true, buildExtra());
      writeStats(stats);
    }

    // Turn failed
    else if (type === 'turn.failed' || type === 'error') {
      updateStreak(stats, true);
      writeState('error', event.message || 'something went wrong', buildExtra());
      writeSessionState(sessionId, 'error', event.message || 'something went wrong', false, buildExtra());
      writeStats(stats);
    }

    // Thread/turn started → thinking
    else if (type === 'turn.started' || type === 'thread.started') {
      writeState('thinking', 'warming up...', buildExtra());
      writeSessionState(sessionId, 'thinking', 'warming up...', false, buildExtra());
    }
  } catch {
    // Silent failure -- don't break the wrapper
  }
}

// -- Main: spawn codex exec --json and parse JSONL -------------------

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node codex-wrapper.js [codex-flags] "your prompt"');
  console.error('  Wraps `codex exec --json` and shows Code Crumb reactions.');
  process.exit(1);
}

// Set initial state
writeState('thinking', 'starting codex...', buildExtra());

const codex = spawn('codex', ['exec', '--json', ...args], {
  stdio: ['inherit', 'pipe', 'inherit'],
  shell: true,
});

let buffer = '';
codex.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop(); // Keep incomplete line in buffer
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      handleEvent(event);
    } catch {
      // Not valid JSON, skip
    }
  }

  // Also pass through to our stdout so user sees output
  process.stdout.write(chunk);
});

codex.on('error', (err) => {
  console.error('Failed to start codex:', err.message);
  console.error('Make sure the Codex CLI is installed: https://github.com/openai/codex');
  process.exit(1);
});

codex.on('exit', (code) => {
  writeState('happy', 'codex finished', buildExtra());
  writeSessionState(sessionId, 'happy', 'codex finished', true, buildExtra());
  writeStats(stats);
  process.exit(code || 0);
});
