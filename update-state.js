#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Hook -- writes state for the face renderer              |
// |  Called by editor hooks via stdin JSON                           |
// |  Usage: node update-state.js <event>                            |
// |  Events: PreToolUse, PostToolUse, Stop, Notification,           |
// |          TeammateIdle, TaskCompleted                            |
// |                                                                  |
// |  Works with Claude Code, Codex CLI, and OpenCode                |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR, STATS_FILE, safeFilename, getGitBranch, getIsWorktree } = require('./shared');
const {
  toolToState, classifyToolResult, updateStreak, defaultStats,
  EDIT_TOOLS, SUBAGENT_TOOLS,
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

// -- Main handler ----------------------------------------------------

// Read stdin
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
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
    else if (hookEvent === 'PostToolUse') {
      const isErrorFlag = toolResponse?.isError || data?.isError || false;
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
      state = 'responding';
      detail = 'wrapping up';
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
    else {
      if (toolName) {
        ({ state, detail } = toolToState(toolName, toolInput));
      }
    }

    // -- Synthetic subagent tracking for orbital mini-faces --
    // Claude Code subagents share the parent session ID, so they don't
    // create their own session files. We create synthetic sessions for
    // Task/subagent tool spawns so they appear as orbital mini-faces.
    const isSubagentTool = SUBAGENT_TOOLS.test(toolName);

    if (hookEvent === 'PreToolUse' && isSubagentTool) {
      // New subagent spawned — create synthetic orbital session
      const subId = `${sessionId}-sub-${Date.now()}`;
      const desc = (toolInput.description || toolInput.prompt || 'subagent').slice(0, 40);
      stats.session.activeSubagents.push({ id: subId, description: desc, startedAt: Date.now(), modelName: toolInput.model || 'haiku' });
      writeSessionState(subId, 'spawning', desc, false, {
        sessionId: subId, modelName: toolInput.model || 'haiku', cwd: process.cwd(),
        gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
        parentSession: sessionId,
      });
      state = 'subagent';
      detail = `conducting ${stats.session.activeSubagents.length}`;
    } 
    // PostToolUse handling removed: PostToolUse fires when the Task tool 
    // invocation completes, not when the subagent finishes. Subagents run 
    // asynchronously, so we can't know when they're done. Leave them 
    // active until the parent session ends (Stop hook handles cleanup).
    else if (stats.session.activeSubagents.length > 0 && !isSubagentTool &&
               hookEvent !== 'Stop' && hookEvent !== 'Notification') {
      // Tool call from within a subagent — update latest synthetic session
      const latestSub = stats.session.activeSubagents[stats.session.activeSubagents.length - 1];
      writeSessionState(latestSub.id, state, detail, false, {
        sessionId: latestSub.id, cwd: process.cwd(),
        gitBranch: getGitBranch(process.cwd()), isWorktree: getIsWorktree(process.cwd()),
        parentSession: sessionId,
        modelName: toolInput.model || data.model_name || process.env.CODE_CRUMB_MODEL || 'claude',
      });
      // Main face stays in conducting mode — but don't override errors or
      // completion states, those are important visual feedback
      const noOverride = ['error', 'happy', 'satisfied', 'proud', 'relieved'];
      if (!noOverride.includes(state)) {
        state = 'subagent';
        detail = `conducting ${stats.session.activeSubagents.length}`;
      }
    }

    // Cycle active subagent sessions through rotating states
    const SUB_STATES = ['thinking','reading','coding','searching','executing','thinking'];
    for (const sub of stats.session.activeSubagents) {
      const age = Date.now() - sub.startedAt;
      const stateIndex = Math.floor(age / 8000) % SUB_STATES.length;
      writeSessionState(sub.id, SUB_STATES[stateIndex], sub.description, false, {
        sessionId: sub.id,
        modelName: sub.modelName || 'haiku',
        cwd: process.cwd(),
        gitBranch: getGitBranch(process.cwd()),
        isWorktree: getIsWorktree(process.cwd()),
        parentSession: sessionId,
      });
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
      frequentFiles: stats.frequentFiles,
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
    } catch {}

    if (shouldWriteGlobal) writeState(state, detail, extra);
    // Only write per-session file if this is a synthetic subagent session
    // (has parentSession) or a teammate. The main session's state belongs in
    // the global STATE_FILE only — writing it to SESSIONS_DIR creates ghost
    // orbital faces that clutter the display (issue #42).
    if (extra.parentSession || extra.isTeammate) {
      writeSessionState(sessionId, state, detail, stopped, extra);
    }
    writeStats(stats);
  } catch {
    // JSON parse may fail for Stop/Notification events with empty or
    // non-JSON stdin -- still write the correct state for the hook event.
    // Try to reuse the session ID from the global state file so we don't
    // create an orphan session file that appears as a phantom orbital.
    let fallbackSessionId = process.env.CLAUDE_SESSION_ID || String(process.ppid);
    let shouldWriteGlobal = true;
    try {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (existing.sessionId) {
        fallbackSessionId = existing.sessionId;
      }
      if (existing.sessionId && existing.sessionId !== fallbackSessionId &&
          !existing.stopped && Date.now() - (existing.timestamp || 0) < 120000) {
        shouldWriteGlobal = false;
      }
    } catch {}
    const fallbackExtra = { sessionId: fallbackSessionId };

    let fallbackState = 'thinking';
    let fallbackDetail = '';
    if (hookEvent === 'Stop') {
      fallbackState = 'responding';
      fallbackDetail = 'wrapping up';
      fallbackExtra.stopped = true;
    } else if (hookEvent === 'Notification') {
      fallbackState = 'waiting';
      fallbackDetail = 'needs attention';
    }

    if (shouldWriteGlobal) writeState(fallbackState, fallbackDetail, fallbackExtra);
    // Don't write main session to SESSIONS_DIR in fallback path either —
    // only subagents/teammates belong there (issue #42).
    if (fallbackExtra.parentSession || fallbackExtra.isTeammate) {
      writeSessionState(fallbackSessionId, fallbackState, fallbackDetail,
        hookEvent === 'Stop', fallbackExtra);
    }
  }

  process.exit(0);
});

process.stdin.on('close', () => {
  process.exit(0);
});
