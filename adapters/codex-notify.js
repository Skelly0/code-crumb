#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Codex Notify Handler -- Codex's LEGACY event channel          |
// |                                                                |
// |  Codex fires its `notify` program with a single JSON argument  |
// |  containing turn-level data. This handler writes Code Crumb    |
// |  state files based on that data, with the same stats plumbing  |
// |  (tool calls, streak, daily sessions) as the other adapters.   |
// |                                                                |
// |  Setup in ~/.codex/config.toml (node setup.js codex-notify):   |
// |    notify = ["node", "/path/to/adapters/codex-notify.js"]      |
// |                                                                |
// |  `notify` is Codex's pre-hooks callback (legacy_notify.rs      |
// |  upstream) and only ever fires `agent-turn-complete`, so this  |
// |  handler shows turn completions and nothing finer. Prefer the  |
// |  native hooks (node setup.js codex) or codex-wrapper.js.       |
// +================================================================+

const {
  writeSessionState, guardedWriteState, readStats, writeStats, initSession, buildExtra,
} = require('./base-adapter');
const shared = require('../shared');

// Task 4 adds withStatsLock to shared.js; until it lands the stats cycle runs
// unlocked, exactly as it did before.
const withStatsLock = shared.withStatsLock || ((fn) => fn());

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

  // agent-turn-complete is the only type codex emits; anything new falls
  // through as a thinking face labelled with its own name.
  let state = 'thinking';
  let detail = eventType || 'codex event';
  if (eventType === 'agent-turn-complete') {
    const lastMsg = event['last-assistant-message'] || '';
    const short = lastMsg.length > 40 ? lastMsg.slice(0, 37) + '...' : lastMsg;
    state = 'happy';
    detail = short || 'turn complete';
  }

  // Without the stats cycle, notify-mode sessions rendered with a blank status
  // line (toolCalls 0, no session start, no streak).
  withStatsLock(() => {
    const stats = readStats();
    initSession(stats, sessionId);
    const extra = buildExtra(stats, sessionId, modelName, editor);
    guardedWriteState(sessionId, state, detail, extra);
    writeSessionState(sessionId, state, detail, false, extra);
    writeStats(stats);
  });
} catch {
  // Silent failure
}

process.exit(0);
