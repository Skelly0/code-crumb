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

const fs = require('fs');
const path = require('path');
const {
  writeSessionState, guardedWriteState, readStats, writeStats, initSession, buildExtra,
  creditOwnerSession,
} = require('./base-adapter');
const { withStatsLock, SESSIONS_DIR, safeFilename } = require('../lib/shared');

// What the session file knows that a turn-complete notification does not.
// Codex's native hooks write the same session (same thread id), and the
// rebuilt-from-scratch notify write used to erase all of it at every turn
// end: the attention stamp above all, so the center face left a Codex window
// the moment its turn finished for anyone with both the notify line and the
// hooks. The sticky set is update-state.js's (STICKY_FIELDS); the branch and
// worktree flag only a hook can compute.
const CARRIED_FIELDS = [
  'taskDescription', 'parentSession', 'agentType', 'isTeammate', 'teamName', 'teammateName',
  'lastPromptAt', 'model', 'gitBranch', 'isWorktree',
];

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
  let turnEnded = false;
  if (eventType === 'agent-turn-complete') {
    const lastMsg = event['last-assistant-message'] || '';
    const short = lastMsg.length > 40 ? lastMsg.slice(0, 37) + '...' : lastMsg;
    state = 'happy';
    detail = short || 'turn complete';
    turnEnded = true;
  }

  // Without the stats cycle, notify-mode sessions rendered with a blank status
  // line (toolCalls 0, no session start, no streak).
  withStatsLock(() => {
    const stats = readStats();
    initSession(stats, sessionId);
    // The turn is over: fold its time into today's total and the records.
    if (turnEnded) creditOwnerSession(stats);
    const extra = buildExtra(stats, sessionId, modelName, editor);
    // A turn end, on the adapter contract: `stopped` on the global file (tmux
    // and the ownership guard read it), `turnEnded` on the session file --
    // `stopped` there means the session is OVER and would retire the orbital.
    // Without either, the renderer never saw the turn finish at all.
    // guardedWriteState copies the owner's modelName/editor/model back onto
    // the object it is given, so the session write is derived from that one.
    const globalExtra = turnEnded ? { ...extra, stopped: true } : extra;
    guardedWriteState(sessionId, state, detail, globalExtra);
    const sessionExtra = { ...globalExtra };
    delete sessionExtra.stopped;
    if (turnEnded) sessionExtra.turnEnded = true;
    // Who wrote this, for codex-wrapper: it goes quiet once codex's hooks
    // write its session, and a notify write looks like one (editor codex,
    // another pid, isWorktree carried below) -- so a notify line beside the
    // wrapper, with no hooks, silenced every turn after the first. Not in
    // CARRIED_FIELDS: the next write by anyone else is not a notify write.
    sessionExtra.writer = 'notify';
    let prev = null;
    try {
      prev = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'), 'utf8'));
    } catch {}
    if (prev && typeof prev === 'object') {
      for (const field of CARRIED_FIELDS) {
        if (prev[field] !== undefined && prev[field] !== null && sessionExtra[field] === undefined) {
          sessionExtra[field] = prev[field];
        }
      }
    }
    writeSessionState(sessionId, state, detail, false, sessionExtra);
    writeStats(stats);
  });
} catch {
  // Silent failure
}

process.exit(0);
