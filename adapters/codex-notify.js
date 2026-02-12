#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Codex Notify Handler -- receives Codex `notify` events         |
// |                                                                  |
// |  Codex fires its `notify` program with a single JSON argument   |
// |  containing turn-level data. This handler writes Claude Face    |
// |  state files based on that data.                                |
// |                                                                  |
// |  Setup in ~/.codex/config.toml:                                 |
// |    notify = ["node", "/path/to/adapters/codex-notify.js"]       |
// |                                                                  |
// |  Limitation: Codex only fires `agent-turn-complete` events,     |
// |  so this handler can only show turn completions -- not          |
// |  individual tool calls. For richer output, use codex-wrapper.js |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR, STATS_FILE, safeFilename } = require('../shared');
const { defaultStats } = require('../state-machine');

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

// -- Parse the notify JSON argument ----------------------------------

try {
  // Codex passes a single JSON argument to the notify command
  const jsonArg = process.argv[2];
  if (!jsonArg) process.exit(0);

  const event = JSON.parse(jsonArg);
  const eventType = event.type || '';
  const sessionId = event['thread-id'] || `codex-${process.ppid}`;

  if (eventType === 'agent-turn-complete') {
    // Extract info from the turn data
    const lastMsg = event['last-assistant-message'] || '';
    const detail = lastMsg.length > 40 ? lastMsg.slice(0, 37) + '...' : lastMsg;

    writeState('happy', detail || 'turn complete');
    writeSessionState(sessionId, 'happy', detail || 'turn complete', false);
  } else if (eventType === 'approval-requested') {
    writeState('waiting', 'needs approval');
    writeSessionState(sessionId, 'waiting', 'needs approval', false);
  } else {
    // Unknown event -- show as thinking
    writeState('thinking', eventType || 'codex event');
    writeSessionState(sessionId, 'thinking', eventType || 'codex event', false);
  }
} catch {
  // Silent failure
}

process.exit(0);
