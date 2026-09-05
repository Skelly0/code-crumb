#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Codex Notify Handler -- receives Codex `notify` events        |
// |                                                                |
// |  Codex fires its `notify` program with a single JSON argument  |
// |  containing turn-level data. This handler writes Code Crumb    |
// |  state files based on that data, with the same stats plumbing  |
// |  (tool calls, streak, daily sessions) as the other adapters.   |
// |                                                                |
// |  Setup in ~/.codex/config.toml:                                |
// |    notify = ["node", "/path/to/adapters/codex-notify.js"]      |
// |                                                                |
// |  Limitation: Codex only fires `agent-turn-complete` events,    |
// |  so this handler can only show turn completions -- not         |
// |  individual tool calls. For richer output use codex-wrapper.js.|
// +================================================================+

const {
  writeSessionState, guardedWriteState, readStats, writeStats, initSession, buildExtra,
} = require('./base-adapter');

// -- Parse the notify JSON argument ----------------------------------

try {
  // Codex passes a single JSON argument to the notify command
  const jsonArg = process.argv[2];
  if (!jsonArg) process.exit(0);

  const event = JSON.parse(jsonArg);
  const eventType = event.type || '';
  const sessionId = event['thread-id'] || `codex-${process.ppid}`;
  const modelName = process.env.CODE_CRUMB_MODEL || 'codex';
  const editor = 'codex';

  // Without this, notify-mode sessions rendered with a blank status line
  // (toolCalls 0, no session start, no streak).
  const stats = readStats();
  initSession(stats, sessionId);
  const extra = buildExtra(stats, sessionId, modelName, editor);

  let state = 'thinking';
  let detail = eventType || 'codex event';
  if (eventType === 'agent-turn-complete') {
    const lastMsg = event['last-assistant-message'] || '';
    const short = lastMsg.length > 40 ? lastMsg.slice(0, 37) + '...' : lastMsg;
    state = 'happy';
    detail = short || 'turn complete';
  } else if (eventType === 'approval-requested') {
    state = 'waiting';
    detail = 'needs approval';
  }

  guardedWriteState(sessionId, state, detail, extra);
  writeSessionState(sessionId, state, detail, false, extra);
  writeStats(stats);
} catch {
  // Silent failure
}

process.exit(0);
