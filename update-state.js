#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Hook -- writes state for the face renderer              |
// |  Called by editor hooks via stdin JSON                           |
// |  Usage: node update-state.js <event>                            |
// |  Events: PreToolUse, PostToolUse, PostToolUseFailure, Stop,     |
// |          Notification, SubagentStart, SubagentStop,            |
// |          TeammateIdle, TaskCompleted, SessionStart, SessionEnd, |
// |          PreCompact, PostCompact, PermissionRequest, Setup,    |
// |          Elicitation, ElicitationResult, ConfigChange,         |
// |          InstructionsLoaded, StopFailure                       |
// |                                                                  |
// |  Works with Claude Code, Codex CLI, and OpenCode                |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR, STATS_FILE, PREFS_FILE, PID_FILE, QUIT_FLAG_FILE, safeFilename, getGitBranch, getIsWorktree } = require('./shared');
const {
  toolToState, normalizeToolResponse, classifyToolResult, classifyTruncatedInput, updateStreak, defaultStats,
  EDIT_TOOLS, SUBAGENT_TOOLS,
  pruneFrequentFiles, topFrequentFiles, buildSubagentSessionState,
} = require('./state-machine');

// Event type passed as CLI argument (cross-platform -- no env var tricks)
const hookEvent = process.argv[2] || '';

// -- File I/O --------------------------------------------------------

// Write to the single state file (backward compat with renderer.js)
function writeState(state, detail = '', extra = {}) {
  const data = JSON.stringify({ state, detail, timestamp: Date.now(), ...extra });
  try {
    fs.writeFileSync(STATE_FILE, data, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Silently fail -- don't break Claude Code
  }
}

// Write per-session state file for orbital subagent rendering
function writeSessionState(sessionId, state, detail = '', stopped = false, extra = {}) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
    const filename = safeFilename(sessionId) + '.json';
    const data = JSON.stringify({
      session_id: sessionId, state, detail,
      timestamp: Date.now(), cwd: process.cwd(), stopped,
      pid: process.ppid, // editor PID — hook runs as child, so ppid is the long-lived process
      ...extra,
    });
    fs.writeFileSync(path.join(SESSIONS_DIR, filename), data, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // Silently fail
  }
}

// Write tool state to an active subagent's session file, preserving sticky fields.
// Pure logic lives in state-machine.js (buildSubagentSessionState); this is the I/O wrapper.
function _writeSubagentToolState(sub, state, detail, parentSessionId) {
  try {
    const fp = path.join(SESSIONS_DIR, safeFilename(sub.id) + '.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
    const built = buildSubagentSessionState(existing, sub, parentSessionId, process.cwd());
    if (!built) return;
    writeSessionState(sub.id, state, detail, false, built);
  } catch {}
}

// Touch (refresh mtime on) all active subagent files except the latest, to prevent
// staleness purging while the parent is still actively dispatching tool calls.
function _touchEarlierSubagents(activeSubagents) {
  for (let i = 0; i < activeSubagents.length - 1; i++) {
    try {
      const fp = path.join(SESSIONS_DIR, safeFilename(activeSubagents[i].id) + '.json');
      const now = new Date();
      fs.utimesSync(fp, now, now);
    } catch {}
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
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats), { encoding: 'utf8', mode: 0o600 }); } catch {}
}

// -- Autolaunch ------------------------------------------------------

// If the renderer isn't running and the user has opted in, spawn it in
// a new terminal window. Runs on every hook call — the fast path (PID
// alive) costs ~1-2ms, well within the 50ms hook budget.
function ensureRendererRunning() {
  try {
    // Check pref — fast sync read, bail early if disabled
    let prefs = {};
    try { prefs = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch {}
    if (!prefs.autolaunch) return;

    // Check quit flag — user intentionally quit, don't auto-relaunch
    try { fs.accessSync(QUIT_FLAG_FILE); return; } catch {}

    // Check if renderer alive via PID file
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (!isNaN(pid)) { process.kill(pid, 0); return; } // alive
    } catch {}

    // Renderer dead/missing — spawn in new terminal, detached
    const rendererPath = path.resolve(__dirname, 'renderer.js');
    const { spawn } = require('child_process');
    const platform = process.platform;

    let child;
    if (platform === 'win32') {
      // Probe for Windows Terminal before spawning (spawn doesn't throw synchronously)
      let hasWt = false;
      try { require('child_process').execSync('where wt', { stdio: 'ignore' }); hasWt = true; } catch {}
      if (hasWt) {
        child = spawn('wt', ['-w', '0', 'new-tab', '--title', 'Code Crumb', 'node', rendererPath],
          { detached: true, stdio: 'ignore', shell: false });
      } else {
        child = spawn('cmd', ['/c', 'start', '"Code Crumb"', 'node', rendererPath],
          { detached: true, stdio: 'ignore', shell: true });
      }
    } else if (platform === 'darwin') {
      const escaped = rendererPath.replace(/'/g, "'\\''");
      child = spawn('osascript', ['-e',
        `tell application "Terminal" to do script "node '${escaped}'; exit"`],
        { detached: true, stdio: 'ignore' });
    } else {
      // Linux — try common terminal emulators in order
      const terms = [
        ['gnome-terminal', ['--', 'node', rendererPath]],
        ['konsole', ['-e', 'node', rendererPath]],
        ['xfce4-terminal', ['-e', `node ${rendererPath}`]],
        ['xterm', ['-e', `node ${rendererPath}`]],
      ];
      for (const [term, args] of terms) {
        try {
          require('child_process').execSync(`command -v ${term}`, { stdio: 'ignore' });
          child = spawn(term, args, { detached: true, stdio: 'ignore' });
          break;
        } catch {}
      }
    }
    if (child) child.unref();
  } catch {} // Never throw from a hook
}

// -- Main handler ----------------------------------------------------

// Read stdin
let input = '';
const MAX_INPUT = 1048576;
let inputTruncated = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (input.length < MAX_INPUT) input += chunk;
  else inputTruncated = true;
});
process.stdin.on('end', () => {
  ensureRendererRunning();
  if (inputTruncated) {
    const truncResult = classifyTruncatedInput(hookEvent, input);
    writeState(truncResult.state, truncResult.detail);
    process.exit(0);
  }
  let state = 'thinking';
  let detail = '';
  let stopped = false;
  let diffInfo = null;
  let workState = null;
  let workDetail = null;

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const toolResponse = normalizeToolResponse(data);

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

    // Detect subagent sessions: different session_id while parent has active subagents.
    // Subagent hooks fire with their own session_id, not the parent's.
    // Without this, subagent hooks would trigger session reset (wiping parent stats)
    // and write tool state to the global file instead of their own orbital file.
    // Lifecycle events have dedicated handlers and must not be rerouted to subagent files.
    // Per-session interactive events (PermissionRequest, Elicitation, ElicitationResult)
    // stay OUT of this set so they correctly route to orbital files in subagent context.
    const LIFECYCLE_EVENTS = new Set([
      'SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop',
      'PreCompact', 'PostCompact', 'Setup', 'ConfigChange',
      'InstructionsLoaded', 'StopFailure',
    ]);

    let isKnownSubagent = false;
    if (stats.session.id && stats.session.id !== sessionId
        && stats.session.activeSubagents && stats.session.activeSubagents.length > 0
        && !LIFECYCLE_EVENTS.has(hookEvent)) {
      isKnownSubagent = true;
    }

    // Initialize session if new (skip for known subagents to preserve parent stats)
    if (stats.session.id !== sessionId && !isKnownSubagent) {
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
        toolCalls: 0, filesEdited: [], subagentCount: 0, commitCount: 0,
      };
    }

    // Initialize subagent tracking for synthetic orbital sessions
    if (!stats.session.activeSubagents) stats.session.activeSubagents = [];
    // Clean up stale synthetic subagents (older than 10 minutes)
    stats.session.activeSubagents = stats.session.activeSubagents.filter(
      sub => Date.now() - sub.startedAt < 600000
    );

    // Clear old milestones (older than 8 seconds)
    if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
      stats.recentMilestone = null;
    }

    if (hookEvent === 'PreToolUse') {
      ({ state, detail } = toolToState(toolName, toolInput));

      // Only count stats for the parent session -- subagent tool calls
      // should not inflate the parent's counters or file tracking.
      if (!isKnownSubagent) {
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
      }

      // Propagate tool state to the most recently started subagent orbital.
      // Only the latest gets live tool state -- earlier subagents keep their last
      // known state. This is correct because the parent's tool calls are sequential
      // and logically belong to the most recent subagent context.
      // Skip propagation for known subagents -- they write their own session files directly.
      if (stats.session.activeSubagents.length > 0 && !SUBAGENT_TOOLS.test(toolName) && !isKnownSubagent) {
        const latest = stats.session.activeSubagents[stats.session.activeSubagents.length - 1];
        _writeSubagentToolState(latest, state, detail, sessionId);
        _touchEarlierSubagents(stats.session.activeSubagents);
        state = 'subagent';
        detail = `conducting ${stats.session.activeSubagents.length}`;
      }
    }
    else if (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure') {
      // PostToolUseFailure is the same as PostToolUse but the tool execution
      // itself failed -- force the error flag so we always show error state.
      const isErrorFlag = hookEvent === 'PostToolUseFailure'
        || toolResponse?.isError || data?.isError || false;
      const result = classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag);
      state = result.state;
      detail = result.detail;
      diffInfo = result.diffInfo;

      // Piggyback the PreToolUse work state onto the PostToolUse write so the
      // renderer can inject it if it missed the PreToolUse file write (race condition
      // on fast commands where PostToolUse overwrites before the renderer reads).
      const preToolResult = toolToState(toolName, toolInput);
      if (preToolResult.state !== 'idle' && preToolResult.state !== 'thinking') {
        workState = preToolResult.state;
        workDetail = preToolResult.detail;
      }

      // Track git commits and streaks (skip for known subagents -- their
      // results should not affect the parent session's counters or streak).
      if (!isKnownSubagent) {
        if (result.state === 'proud' && result.detail === 'committed') {
          stats.session.commitCount = (stats.session.commitCount || 0) + 1;
        }
        updateStreak(stats, state === 'error');
      }

      // Propagate tool result state to the most recently started subagent (see PreToolUse comment)
      if (stats.session.activeSubagents.length > 0 && !SUBAGENT_TOOLS.test(toolName) && !isKnownSubagent) {
        const latest = stats.session.activeSubagents[stats.session.activeSubagents.length - 1];
        _writeSubagentToolState(latest, state, detail, sessionId);
        _touchEarlierSubagents(stats.session.activeSubagents);
        state = 'subagent';
        detail = `conducting ${stats.session.activeSubagents.length}`;
        workState = null;  // conducting state is not a completion -- no piggyback needed
        workDetail = null;
      }
    }
    else if (hookEvent === 'Stop') {
      const lastMsg = data.last_assistant_message || '';
      state = 'responding';
      detail = 'wrapping up';
      stopped = true;

      // Update session records (skip for known subagents -- their Stop must not
      // zero the parent's session.start or inflate duration/record counters).
      if (stats.session.start && !isKnownSubagent) {
        const dur = Date.now() - stats.session.start;
        if (dur > (stats.records.longestSession || 0)) stats.records.longestSession = dur;
        stats.daily.cumulativeMs += dur;
        stats.session.start = 0; // Prevent double-counting on next session change
      }
      if (!isKnownSubagent && (stats.session.filesEdited?.length || 0) > (stats.records.mostFilesEdited || 0)) {
        stats.records.mostFilesEdited = stats.session.filesEdited.length;
      }

      // Don't clean up synthetic subagent sessions here — background subagents
      // may still be running after the parent's turn ends. SessionEnd handles
      // final cleanup; SubagentStop handles individual foreground agents.
    }
    else if (hookEvent === 'Notification') {
      state = 'waiting';
      detail = 'needs attention';
    }
    else if (hookEvent === 'TeammateIdle') {
      state = 'waiting';
      detail = data.teammate_name ? `${data.teammate_name} idle` : 'idle';
      const teamExtra = {
        teamName: data.team_name || '',
        teammateName: data.teammate_name || '',
        isTeammate: true,
      };
      writeSessionState(sessionId, state, detail, false, { ...teamExtra, sessionId });
      writeStats(stats);
      process.exit(0);
    }
    else if (hookEvent === 'TaskCompleted') {
      const taskSubject = data.task_subject || '';
      state = stats.streak >= 10 ? 'proud' : stats.streak >= 3 ? 'satisfied' : 'happy';
      detail = taskSubject ? taskSubject.slice(0, 40) : 'task done';
      const teamExtra = {
        teamName: data.team_name || '',
        teammateName: data.teammate_name || '',
        taskSubject,
        isTeammate: true,
      };
      writeSessionState(sessionId, state, detail, false, { ...teamExtra, sessionId });
      writeStats(stats);
      process.exit(0);
    }
    else if (hookEvent === 'SubagentStart') {
      // Native subagent lifecycle event -- create a synthetic orbital session
      state = 'subagent';
      const desc = (data.description || data.prompt || data.agent_name || 'subagent').slice(0, 40);
      detail = desc;
      const subId = data.subagent_id || `${sessionId}-sub-${Date.now()}`;
      stats.session.subagentCount = (stats.session.subagentCount || 0) + 1;
      if (stats.session.subagentCount > (stats.records.mostSubagents || 0)) {
        stats.records.mostSubagents = stats.session.subagentCount;
      }
      stats.session.activeSubagents.push({ id: subId, description: desc, taskDescription: desc, model: data.model || 'haiku', startedAt: Date.now() });
      writeSessionState(subId, 'spawning', desc, false, {
        sessionId: subId, modelName: data.model || 'haiku', cwd: process.cwd(),
        gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
        parentSession: sessionId, taskDescription: desc,
      });
      detail = `conducting ${stats.session.activeSubagents.length}`;
    }
    else if (hookEvent === 'SubagentStop') {
      // Native subagent lifecycle event -- mark the subagent session as done
      const subId = data.subagent_id || '';
      if (subId && stats.session.activeSubagents.length > 0) {
        const idx = stats.session.activeSubagents.findIndex(s => s.id === subId);
        if (idx >= 0) {
          const finished = stats.session.activeSubagents.splice(idx, 1)[0];
          writeSessionState(finished.id, 'happy', 'done', true, {
            sessionId: finished.id, stopped: true, cwd: process.cwd(),
            gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
            parentSession: sessionId, taskDescription: finished.taskDescription || finished.description,
            modelName: finished.model || 'haiku',
          });
        }
        // If subId not found in our list, skip — it may belong to another session
      } else if (stats.session.activeSubagents.length > 0) {
        const finished = stats.session.activeSubagents.shift();
        writeSessionState(finished.id, 'happy', 'done', true, {
          sessionId: finished.id, stopped: true, cwd: process.cwd(),
          gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
          parentSession: sessionId, taskDescription: finished.taskDescription || finished.description,
          modelName: finished.model || 'haiku',
        });
      }
      if (stats.session.activeSubagents.length > 0) {
        state = 'subagent';
        detail = `conducting ${stats.session.activeSubagents.length}`;
      } else {
        state = 'happy';
        detail = 'subagent done';
      }
    }
    else if (hookEvent === 'SessionStart') {
      state = 'idle';
      detail = 'session starting';
      // sessionCount already incremented in new-session block above
      // Clean up any stale session file from previous session with same ID
      const staleSessionFile = path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');
      try { fs.unlinkSync(staleSessionFile); } catch {}
      stats.session = {
        id: sessionId, start: Date.now(),
        toolCalls: 0, filesEdited: [], subagentCount: 0, commitCount: 0,
        activeSubagents: [],
      };
    }
    else if (hookEvent === 'SessionEnd') {
      state = 'responding';
      detail = 'session ending';
      stopped = true;
      // Finalize session records
      if (stats.session.start) {
        const dur = Date.now() - stats.session.start;
        if (dur > (stats.records.longestSession || 0)) stats.records.longestSession = dur;
        stats.daily.cumulativeMs += dur;
        stats.session.start = 0;
      }
      if ((stats.session.filesEdited?.length || 0) > (stats.records.mostFilesEdited || 0)) {
        stats.records.mostFilesEdited = stats.session.filesEdited.length;
      }
      // Clean up any remaining synthetic subagent sessions
      for (const sub of stats.session.activeSubagents) {
        writeSessionState(sub.id, 'happy', 'done', true, {
          sessionId: sub.id, stopped: true, cwd: process.cwd(),
          gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
          parentSession: sessionId, modelName: sub.model || 'haiku',
        });
      }
      stats.session.activeSubagents = [];
    }
    else if (hookEvent === 'PreCompact') {
      state = 'thinking';
      const trigger = data.trigger || 'auto';
      detail = trigger === 'manual' ? 'compacting memory' : 'auto-compacting';
    }
    else if (hookEvent === 'PostCompact') {
      state = 'satisfied';
      detail = 'memory compacted';
    }
    else if (hookEvent === 'PermissionRequest') {
      state = 'waiting';
      const tool = data.tool_name || '';
      detail = tool ? `allow ${tool}?` : 'needs permission';
    }
    else if (hookEvent === 'Setup') {
      state = 'starting';
      const trigger = data.trigger || 'init';
      detail = trigger === 'maintenance' ? 'maintenance' : 'setting up';
    }
    else if (hookEvent === 'Elicitation') {
      state = 'waiting';
      const server = (data.mcp_server_name || 'MCP').slice(0, 20);
      detail = `${server}: needs input`;
    }
    else if (hookEvent === 'ElicitationResult') {
      const action = data.action || 'accept';
      if (action === 'accept') {
        state = 'satisfied';
        detail = 'input received';
      } else {
        state = 'relieved';
        detail = action === 'decline' ? 'input declined' : 'input cancelled';
      }
    }
    else if (hookEvent === 'ConfigChange') {
      state = 'reading';
      const fp = data.file_path || '';
      const base = fp ? path.basename(fp) : '';
      detail = base ? `config: ${base}` : 'config updated';
    }
    else if (hookEvent === 'InstructionsLoaded') {
      state = 'reading';
      const fp = data.file_path || '';
      detail = fp ? path.basename(fp) : 'loading instructions';
    }
    else if (hookEvent === 'StopFailure') {
      state = 'error';
      const errorType = data.error || data.error_type || '';
      if (errorType === 'rate_limit') detail = 'rate limited!';
      else if (errorType === 'server_error') detail = 'server error';
      else if (errorType === 'max_output_tokens') detail = 'output too long';
      else if (errorType === 'authentication_failed') detail = 'auth failed';
      else if (errorType === 'billing_error') detail = 'billing error';
      else detail = errorType || 'API error';
      // Track in stats -- API failures break the streak
      if (!isKnownSubagent) {
        updateStreak(stats, true);
      }
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
      sessionId,
      modelName,
      toolCalls: stats.session.toolCalls,
      filesEdited: stats.session.filesEdited?.length || 0,
      sessionStart: stats.session.start,
      streak: stats.streak,
      cwd: process.cwd(),
      isWorktree: getIsWorktree(process.cwd()),
      gitBranch: getGitBranch(process.cwd()),
      commitCount: stats.session.commitCount || 0,
      bestStreak: stats.bestStreak,
      brokenStreak: stats.brokenStreak,
      brokenStreakAt: stats.brokenStreakAt,
      milestone: stats.recentMilestone,
      diffInfo,
      dailySessions: stats.daily.sessionCount,
      dailyCumulativeMs: stats.daily.cumulativeMs + currentSessionMs,
      frequentFiles: topFrequentFiles(stats.frequentFiles),
    };

    if (stopped) extra.stopped = true;
    if (workState) { extra.workState = workState; extra.workDetail = workDetail; }
    if (hookEvent === 'SessionStart') extra.isSessionStart = true;

    // Stamp parentSession on subagent writes so the parentSession guard
    // blocks them from writing global state, and the renderer treats them as orbitals.
    if (isKnownSubagent) {
      extra.parentSession = stats.session.id;
      // Retire synthetic orbital: SubagentStart created a synthetic file (spawning state).
      // Now that the real subagent is sending its own hooks, mark the synthetic as done
      // so it is pruned after STOPPED_LINGER_MS (10s) instead of lingering for STALE_MS (120s).
      // PreToolUse is the first tool event a real subagent sends -- retire on first contact.
      if (hookEvent === 'PreToolUse') {
        const subs = stats.session.activeSubagents;
        // Iterate forward: oldest spawning synthetic is most likely to match
        // the first real subagent hook when multiple subagents are concurrent.
        for (let i = 0; i < subs.length; i++) {
          try {
            const synthFp = path.join(SESSIONS_DIR, safeFilename(subs[i].id) + '.json');
            const synthData = JSON.parse(fs.readFileSync(synthFp, 'utf8'));
            if (!synthData.stopped && synthData.state === 'spawning') {
              if (synthData.taskDescription) extra.taskDescription = synthData.taskDescription;
              fs.writeFileSync(synthFp, JSON.stringify({
                ...synthData, stopped: true, state: 'happy', detail: 'done',
              }), { encoding: 'utf8', mode: 0o600 });
              break;
            }
          } catch {}
        }
      }
    }

    // Only write to global state file if this session "owns" it.
    // Subagents should only write to their per-session file so they
    // don't overwrite the main session's state in the renderer.
    let shouldWriteGlobal = true;
    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (existing.sessionId && existing.sessionId !== sessionId &&
          !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
        shouldWriteGlobal = false;
      }
      // Preserve stopped flag — only late PostToolUse/PostToolUseFailure can arrive after Stop.
      // PreToolUse (new turn) must be allowed to clear the stopped flag.
      if (existing.stopped && existing.sessionId === sessionId && !stopped &&
          (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure')) {
        stopped = true;
        extra.stopped = true;
      }
      // Preserve model name — subagents sharing session ID must not overwrite the owner's name.
      // See also: base-adapter.js guardedWriteState (adapters) and face.js setStats (env var).
      if (existing.sessionId === sessionId && existing.modelName &&
          extra.modelName !== existing.modelName) {
        extra.modelName = existing.modelName;
      }
    } catch {}

    // Subagents should never take over the global state file —
    // they appear as orbitals via their per-session files.
    if (shouldWriteGlobal) {
      try {
        const mySession = JSON.parse(fs.readFileSync(
          path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'), 'utf8'));
        if (mySession.parentSession) shouldWriteGlobal = false;
      } catch {}
    }

    // SessionStart always takes over global state — explicit new-session signal
    if (hookEvent === 'SessionStart') shouldWriteGlobal = true;

    if (shouldWriteGlobal) writeState(state, detail, extra);
    // Always write per-session file so parallel Claude Code sessions
    // appear as orbitals. The renderer excludes the main session by ID.
    if (hookEvent !== 'SessionStart') {
      // Preserve stopped flag and sticky fields from existing session file
      // (set once at SubagentStart/TeammateIdle, must survive subsequent hook updates)
      const STICKY_FIELDS = ['taskDescription', 'parentSession', 'isTeammate', 'teamName', 'teammateName'];
      try {
        const existingSession = JSON.parse(fs.readFileSync(
          path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'), 'utf8'));
        if (!stopped && existingSession.stopped &&
            (hookEvent === 'PostToolUse' || hookEvent === 'PostToolUseFailure')) {
          stopped = true;
          extra.stopped = true;
        }
        for (const field of STICKY_FIELDS) {
          if (existingSession[field] && !extra[field]) {
            extra[field] = existingSession[field];
          }
        }
      } catch {}
      if (hookEvent === 'Stop') {
        // Stop = end of turn, not end of session. Keep orbital visible as idle.
        // Global state file already has stopped=true for ownership release.
        const idleExtra = { ...extra };
        delete idleExtra.stopped;
        writeSessionState(sessionId, 'idle', 'between turns', false, idleExtra);
      } else {
        writeSessionState(sessionId, state, detail, stopped, extra);
      }
    }
    pruneFrequentFiles(stats.frequentFiles);
    writeStats(stats);
  } catch {
    // JSON parse may fail for events with empty or non-JSON stdin
    // (e.g., Stop, Notification, lifecycle events) -- still write the
    // correct state for the hook event.
    // Try to reuse the session ID from the global state file so we don't
    // create an orphan session file that appears as a phantom orbital.
    const originalFallbackId = process.env.CLAUDE_SESSION_ID || String(process.ppid);
    let fallbackSessionId = originalFallbackId;
    let shouldWriteGlobal = true;
    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (existing.sessionId) {
        fallbackSessionId = existing.sessionId;
      }
      if (existing.sessionId && existing.sessionId !== originalFallbackId &&
          !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
        shouldWriteGlobal = false;
      }
    } catch {}

    // Same parentSession guard as the try block above — subagents must not write global state.
    // Uses originalFallbackId (the caller's identity), not fallbackSessionId
    // (which may be the adopted main session's ID from the state file).
    if (shouldWriteGlobal) {
      try {
        const mySession = JSON.parse(fs.readFileSync(
          path.join(SESSIONS_DIR, safeFilename(originalFallbackId) + '.json'), 'utf8'));
        if (mySession.parentSession) shouldWriteGlobal = false;
      } catch {}
    }

    // SessionStart always takes over global state — explicit new-session signal
    if (hookEvent === 'SessionStart') shouldWriteGlobal = true;

    const fallbackExtra = { sessionId: fallbackSessionId, modelName: process.env.CODE_CRUMB_MODEL || 'claude' };

    let fallbackState = 'thinking';
    let fallbackDetail = '';
    if (hookEvent === 'SessionEnd') {
      fallbackState = 'responding';
      fallbackDetail = 'session ending';
      fallbackExtra.stopped = true;
    } else if (hookEvent === 'Stop') {
      fallbackState = 'responding';
      fallbackDetail = 'wrapping up';
      fallbackExtra.stopped = true; // for global state only
    } else if (hookEvent === 'Notification') {
      fallbackState = 'waiting';
      fallbackDetail = 'needs attention';
    } else if (hookEvent === 'SessionStart') {
      fallbackState = 'idle';
      fallbackDetail = 'session starting';
      fallbackExtra.isSessionStart = true;
      // Clean up any stale session file from previous session with same ID
      const staleSessionFile = path.join(SESSIONS_DIR, safeFilename(fallbackSessionId) + '.json');
      try { fs.unlinkSync(staleSessionFile); } catch {}
    } else if (hookEvent === 'SubagentStart') {
      fallbackState = 'subagent';
      fallbackDetail = 'spawning subagent';
      // Create subagent orbital file even in fallback path
      const subId = `${fallbackSessionId}-sub-${Date.now()}`;
      writeSessionState(subId, 'spawning', 'subagent', false, {
        sessionId: subId, parentSession: fallbackSessionId,
        modelName: 'haiku', taskDescription: 'subagent',
      });
    } else if (hookEvent === 'SubagentStop') {
      fallbackState = 'happy';
      fallbackDetail = 'subagent done';
    } else if (hookEvent === 'PostToolUseFailure') {
      fallbackState = 'error';
      fallbackDetail = 'tool failed';
    } else if (hookEvent === 'PreCompact') {
      fallbackState = 'thinking';
      fallbackDetail = 'compacting memory';
    } else if (hookEvent === 'PostCompact') {
      fallbackState = 'satisfied';
      fallbackDetail = 'memory compacted';
    } else if (hookEvent === 'PermissionRequest') {
      fallbackState = 'waiting';
      fallbackDetail = 'needs permission';
    } else if (hookEvent === 'Setup') {
      fallbackState = 'starting';
      fallbackDetail = 'setting up';
    } else if (hookEvent === 'Elicitation') {
      fallbackState = 'waiting';
      fallbackDetail = 'needs input';
    } else if (hookEvent === 'ElicitationResult') {
      fallbackState = 'satisfied';
      fallbackDetail = 'input received';
    } else if (hookEvent === 'ConfigChange') {
      fallbackState = 'reading';
      fallbackDetail = 'config updated';
    } else if (hookEvent === 'InstructionsLoaded') {
      fallbackState = 'reading';
      fallbackDetail = 'loading instructions';
    } else if (hookEvent === 'StopFailure') {
      fallbackState = 'error';
      fallbackDetail = 'API error';
    }

    if (shouldWriteGlobal) writeState(fallbackState, fallbackDetail, fallbackExtra);
    // Always write per-session file so parallel sessions appear as orbitals.
    if (hookEvent === 'Stop') {
      const idleFallbackExtra = { ...fallbackExtra };
      delete idleFallbackExtra.stopped;
      writeSessionState(fallbackSessionId, 'idle', 'between turns', false, idleFallbackExtra);
    } else {
      writeSessionState(fallbackSessionId, fallbackState, fallbackDetail,
        hookEvent === 'SessionEnd', fallbackExtra);
    }
  }

  process.exit(0);
});

