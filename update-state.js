#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Hook -- writes state for the face renderer         |
// |  Called by Claude Code hooks via stdin JSON                     |
// |  Usage: node update-state.js <event>                           |
// |  Events: PreToolUse, PostToolUse, Stop, Notification           |
// +================================================================+

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const STATE_FILE = process.env.CLAUDE_FACE_STATE || path.join(HOME, '.claude-face-state');
const SESSIONS_DIR = path.join(HOME, '.claude-face-sessions');

// Event type passed as CLI argument (cross-platform -- no env var tricks)
const hookEvent = process.argv[2] || '';

function safeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// Write to the single state file (backward compat with renderer.js)
function writeState(state, detail = '') {
  const data = JSON.stringify({ state, detail, timestamp: Date.now() });
  try {
    fs.writeFileSync(STATE_FILE, data, 'utf8');
  } catch {
    // Silently fail -- don't break Claude Code
  }
}

// Write per-session state file for the grid renderer
function writeSessionState(sessionId, state, detail = '', stopped = false) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const filename = safeFilename(sessionId) + '.json';
    const data = JSON.stringify({
      session_id: sessionId,
      state,
      detail,
      timestamp: Date.now(),
      cwd: process.cwd(),
      stopped,
    });
    fs.writeFileSync(path.join(SESSIONS_DIR, filename), data, 'utf8');
  } catch {
    // Silently fail
  }
}

// Map tool names to face states
function toolToState(toolName, toolInput) {
  // Writing/editing code
  if (/^(edit|multiedit|write|str_replace|create_file)$/i.test(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.path || '';
    const shortPath = filePath ? path.basename(filePath) : '';
    return { state: 'coding', detail: shortPath ? `editing ${shortPath}` : 'writing code' };
  }

  // Running commands
  if (/^bash$/i.test(toolName)) {
    const cmd = toolInput?.command || '';
    const shortCmd = cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
    return { state: 'executing', detail: shortCmd || 'running command' };
  }

  // Reading files
  if (/^(read|view|cat)$/i.test(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.path || '';
    const shortPath = filePath ? path.basename(filePath) : '';
    return { state: 'reading', detail: shortPath ? `reading ${shortPath}` : 'reading' };
  }

  // Searching
  if (/^(grep|glob|search|ripgrep|find|list)$/i.test(toolName)) {
    const pattern = toolInput?.pattern || toolInput?.query || '';
    return { state: 'searching', detail: pattern ? `looking for "${pattern}"` : 'searching' };
  }

  // Web/fetch
  if (/^(web_search|web_fetch|fetch|webfetch)$/i.test(toolName)) {
    return { state: 'searching', detail: 'searching the web' };
  }

  // Task/subagent
  if (/^(task|subagent)$/i.test(toolName)) {
    return { state: 'thinking', detail: 'delegating to subagent' };
  }

  // MCP tools
  if (/^mcp__/.test(toolName)) {
    const parts = toolName.split('__');
    const server = parts[1] || 'external';
    const tool = parts[2] || '';
    return { state: 'executing', detail: `${server}: ${tool}` };
  }

  // Default
  return { state: 'thinking', detail: toolName || '' };
}

// Read stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let state = 'thinking';
  let detail = '';
  let stopped = false;

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const toolResponse = data.tool_response || {};

    // Extract session ID: try hook data, env, then fall back to PPID
    const sessionId = data.session_id
      || process.env.CLAUDE_SESSION_ID
      || String(process.ppid);

    if (hookEvent === 'PreToolUse') {
      ({ state, detail } = toolToState(toolName, toolInput));
    }
    else if (hookEvent === 'PostToolUse') {
      const exitCode = toolResponse?.exit_code;
      const stderr = toolResponse?.stderr || '';

      if (exitCode !== undefined && exitCode !== 0) {
        state = 'error';
        detail = `command failed (exit ${exitCode})`;
      } else if (stderr && stderr.toLowerCase().includes('error')) {
        state = 'error';
        detail = 'something went wrong';
      } else {
        state = 'happy';
        detail = 'step complete';
      }
    }
    else if (hookEvent === 'Stop') {
      state = 'happy';
      detail = 'all done!';
      stopped = true;
    }
    else if (hookEvent === 'Notification') {
      state = 'thinking';
      detail = 'needs attention';
    }
    else {
      if (toolName) {
        ({ state, detail } = toolToState(toolName, toolInput));
      }
    }

    // Write both: single file (backward compat) + session file (grid mode)
    writeState(state, detail);
    writeSessionState(sessionId, state, detail, stopped);
  } catch {
    writeState('thinking');
  }

  process.exit(0);
});

process.stdin.on('close', () => {
  process.exit(0);
});
