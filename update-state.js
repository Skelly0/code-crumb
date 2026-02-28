#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Hook -- writes state for the face renderer              |
// |  Called by editor hooks via stdin JSON                           |
// |  Usage: node update-state.js <event>                            |
// |  Events: PreToolUse, PostToolUse, PostToolUseFailure, Stop,     |
// |          Notification, SubagentStart, SubagentStop,            |
// |          TeammateIdle, TaskCompleted, SessionStart, SessionEnd  |
// |                                                                  |
// |  Works with Claude Code, Codex CLI, and OpenCode                |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR, STATS_FILE, PREFS_FILE, PID_FILE, QUIT_FLAG_FILE, safeFilename, getGitBranch, getIsWorktree } = require('./shared');
const {
  toolToState, classifyToolResult, updateStreak, defaultStats,
  looksLikeRateLimit, EDIT_TOOLS, SUBAGENT_TOOLS,
  pruneFrequentFiles, topFrequentFiles,
} = require('./state-machine');

// Event type passed as CLI argument (cross-platform -- no env var tricks)
const hookEvent = process.argv[2] || '';

// -- File I/O --------------------------------------------------------

// Write to the single state file (backward compat with renderer.js)
function writeState(state, detail = '', extra = {}) {
  const data = JSON.stringify({ state, detail, timestamp: Date.now(), ...extra });
  try {
    fs.writeFileSync(STATE_FILE, data, 'utf8');
  } catch {
    // Silently fail -- don't break Claude Code
  }
}

// Write per-session state file for orbital subagent rendering
function writeSessionState(sessionId, state, detail = '', stopped = false, extra = {}) {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const filename = safeFilename(sessionId) + '.json';
    const data = JSON.stringify({
      session_id: sessionId, state, detail,
      timestamp: Date.now(), cwd: process.cwd(), stopped,
      ...extra,
    });
    fs.writeFileSync(path.join(SESSIONS_DIR, filename), data, 'utf8');
  } catch {
    // Silently fail
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
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8'); } catch {}
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
      // Try Windows Terminal first, fall back to cmd start
      try {
        child = spawn('wt', ['-w', '0', 'new-tab', '--title', 'Code Crumb', 'node', rendererPath],
          { detached: true, stdio: 'ignore', shell: false });
      } catch {
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
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  ensureRendererRunning();
  let state = 'thinking';
  let detail = '';
  let stopped = false;
  let diffInfo = null;

  try {
    const data = JSON.parse(input);
    const toolName = data.tool_name || '';
    const toolInput = data.tool_input || {};
    const toolResponse = data.tool_response || {};

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

    // Initialize session if new
    if (stats.session.id !== sessionId) {
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
    // Clean up stale synthetic subagents (older than 3 minutes)
    stats.session.activeSubagents = stats.session.activeSubagents.filter(
      sub => Date.now() - sub.startedAt < 180000
    );

    // Clear old milestones (older than 8 seconds)
    if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
      stats.recentMilestone = null;
    }

    if (hookEvent === 'PreToolUse') {
      ({ state, detail } = toolToState(toolName, toolInput));
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

      // Track subagents
      if (SUBAGENT_TOOLS.test(toolName)) {
        stats.session.subagentCount++;
        if (stats.session.subagentCount > (stats.records.mostSubagents || 0)) {
          stats.records.mostSubagents = stats.session.subagentCount;
        }
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

      // Track git commits
      if (result.state === 'proud' && result.detail === 'committed') {
        stats.session.commitCount = (stats.session.commitCount || 0) + 1;
      }

      updateStreak(stats, state === 'error');
    }
    else if (hookEvent === 'Stop') {
      const lastMsg = data.last_assistant_message || '';
      if (looksLikeRateLimit(lastMsg, '')) {
        state = 'ratelimited';
        detail = 'usage limit';
      } else {
        state = 'responding';
        detail = 'wrapping up';
      }
      stopped = true;

      // Update session records
      if (stats.session.start) {
        const dur = Date.now() - stats.session.start;
        if (dur > (stats.records.longestSession || 0)) stats.records.longestSession = dur;
        stats.daily.cumulativeMs += dur;
        stats.session.start = 0; // Prevent double-counting on next session change
      }
      if ((stats.session.filesEdited?.length || 0) > (stats.records.mostFilesEdited || 0)) {
        stats.records.mostFilesEdited = stats.session.filesEdited.length;
      }

      // Clean up synthetic subagent sessions — main turn ended
      for (const sub of stats.session.activeSubagents) {
        writeSessionState(sub.id, 'happy', 'done', true, {
          sessionId: sub.id, stopped: true, cwd: process.cwd(),
          gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
          parentSession: sessionId,
        });
      }
      stats.session.activeSubagents = [];
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
      stats.session.activeSubagents.push({ id: subId, description: desc, taskDescription: desc, startedAt: Date.now() });
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
        const finished = idx >= 0
          ? stats.session.activeSubagents.splice(idx, 1)[0]
          : stats.session.activeSubagents.shift();
        writeSessionState(finished.id, 'happy', 'done', true, {
          sessionId: finished.id, stopped: true, cwd: process.cwd(),
          gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
          parentSession: sessionId, taskDescription: finished.taskDescription || finished.description,
        });
      } else if (stats.session.activeSubagents.length > 0) {
        const finished = stats.session.activeSubagents.shift();
        writeSessionState(finished.id, 'happy', 'done', true, {
          sessionId: finished.id, stopped: true, cwd: process.cwd(),
          gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
          parentSession: sessionId, taskDescription: finished.taskDescription || finished.description,
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
          parentSession: sessionId,
        });
      }
      stats.session.activeSubagents = [];
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
      filesEdited: stats.session.filesEdited.length,
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
      // Preserve stopped flag — late PostToolUse must not erase a prior Stop/SessionEnd
      if (existing.stopped && existing.sessionId === sessionId && !stopped) {
        stopped = true;
        extra.stopped = true;
      }
      // Preserve model name — subagents sharing session ID must not overwrite the owner's name
      if (existing.sessionId === sessionId && existing.modelName &&
          extra.modelName !== existing.modelName) {
        extra.modelName = existing.modelName;
      }
    } catch {}

    if (shouldWriteGlobal) writeState(state, detail, extra);
    // Always write per-session file so parallel Claude Code sessions
    // appear as orbitals. The renderer excludes the main session by ID.
    if (hookEvent !== 'SessionStart') {
      // Preserve stopped flag and taskDescription from existing session file
      try {
        const existingSession = JSON.parse(fs.readFileSync(
          path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'), 'utf8'));
        if (!stopped && existingSession.stopped) {
          stopped = true;
          extra.stopped = true;
        }
        if (existingSession.taskDescription && !extra.taskDescription) {
          extra.taskDescription = existingSession.taskDescription;
        }
      } catch {}
      writeSessionState(sessionId, state, detail, stopped, extra);
    }
    pruneFrequentFiles(stats.frequentFiles);
    writeStats(stats);
  } catch {
    // JSON parse may fail for Stop/Notification events with empty or
    // non-JSON stdin -- still write the correct state for the hook event.
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

    const fallbackExtra = { sessionId: fallbackSessionId };

    let fallbackState = 'thinking';
    let fallbackDetail = '';
    if (hookEvent === 'Stop' || hookEvent === 'SessionEnd') {
      fallbackState = 'responding';
      fallbackDetail = hookEvent === 'SessionEnd' ? 'session ending' : 'wrapping up';
      fallbackExtra.stopped = true;
    } else if (hookEvent === 'Notification') {
      fallbackState = 'waiting';
      fallbackDetail = 'needs attention';
    } else if (hookEvent === 'SessionStart') {
      fallbackState = 'waiting';
      fallbackDetail = 'session starting';
      // Clean up any stale session file from previous session with same ID
      const staleSessionFile = path.join(SESSIONS_DIR, safeFilename(fallbackSessionId) + '.json');
      try { fs.unlinkSync(staleSessionFile); } catch {}
    } else if (hookEvent === 'SubagentStart') {
      fallbackState = 'subagent';
      fallbackDetail = 'spawning subagent';
    } else if (hookEvent === 'SubagentStop') {
      fallbackState = 'happy';
      fallbackDetail = 'subagent done';
    } else if (hookEvent === 'PostToolUseFailure') {
      fallbackState = 'error';
      fallbackDetail = 'tool failed';
    }

    if (shouldWriteGlobal) writeState(fallbackState, fallbackDetail, fallbackExtra);
    // Always write per-session file so parallel sessions appear as orbitals.
    writeSessionState(fallbackSessionId, fallbackState, fallbackDetail,
      hookEvent === 'Stop', fallbackExtra);
  }

  process.exit(0);
});

process.stdin.on('close', () => {
  process.exit(0);
});
