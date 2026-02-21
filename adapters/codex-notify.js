#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Codex Notify Handler -- receives Codex `notify` events           |
// |                                                                  |
// |  Codex fires its `notify` program with a single JSON argument    |
// |  containing turn-level data. This handler writes Code Crumb     |
// |  state files based on that data.                                |
// |                                                                  |
// |  Setup in ~/.codex/config.toml:                                 |
// |    notify = ["node", "/path/to/adapters/codex-notify.js"]       |
// |                                                                  |
// |  Limitation: Codex only fires `agent-turn-complete` events,      |
// |  so this handler can only show turn completions -- not           |
// |  individual tool calls. For richer output, use codex-wrapper.js |
// +================================================================+

const { writeState, writeSessionState, guardedWriteState } = require('./base-adapter');

// -- Parse the notify JSON argument ----------------------------------

try {
  // Codex passes a single JSON argument to the notify command
  const jsonArg = process.argv[2];
  if (!jsonArg) process.exit(0);

  const event = JSON.parse(jsonArg);
  const eventType = event.type || '';
  const sessionId = event['thread-id'] || `codex-${process.ppid}`;
  const modelName = process.env.CODE_CRUMB_MODEL || 'codex';

  if (eventType === 'agent-turn-complete') {
    const lastMsg = event['last-assistant-message'] || '';
    const detail = lastMsg.length > 40 ? lastMsg.slice(0, 37) + '...' : lastMsg;

    guardedWriteState(sessionId, 'happy', detail || 'turn complete', { sessionId, modelName });
    writeSessionState(sessionId, 'happy', detail || 'turn complete', false, { sessionId, modelName });
  } else if (eventType === 'approval-requested') {
    guardedWriteState(sessionId, 'waiting', 'needs approval', { sessionId, modelName });
    writeSessionState(sessionId, 'waiting', 'needs approval', false, { sessionId, modelName });
  } else {
    // Unknown event -- show as thinking
    guardedWriteState(sessionId, 'thinking', eventType || 'codex event', { sessionId, modelName });
    writeSessionState(sessionId, 'thinking', eventType || 'codex event', false, { sessionId, modelName });
  }
} catch {
  // Silent failure
}

process.exit(0);
