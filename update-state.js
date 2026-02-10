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
const STATS_FILE = path.join(HOME, '.claude-face-stats.json');

// Event type passed as CLI argument (cross-platform -- no env var tricks)
const hookEvent = process.argv[2] || '';

function safeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// Write to the single state file (backward compat with renderer.js)
function writeState(state, detail = '', extra = {}) {
  const data = JSON.stringify({ state, detail, timestamp: Date.now(), ...extra });
  try {
    fs.writeFileSync(STATE_FILE, data, 'utf8');
  } catch {
    // Silently fail -- don't break Claude Code
  }
}

// Write per-session state file for the grid renderer
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
    return {
      streak: 0, bestStreak: 0,
      brokenStreak: 0, brokenStreakAt: 0,
      totalToolCalls: 0, totalErrors: 0,
      records: { longestSession: 0, mostSubagents: 0, mostFilesEdited: 0 },
      session: { id: '', start: 0, toolCalls: 0, filesEdited: [], subagentCount: 0 },
      recentMilestone: null,
      daily: { date: '', sessionCount: 0, cumulativeMs: 0 },
      frequentFiles: {},
    };
  }
}

function writeStats(stats) {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats), 'utf8'); } catch {}
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

    // Detect test commands
    if (/\b(jest|pytest|vitest|mocha|cypress|playwright|\.test\.|spec)\b/i.test(cmd) ||
        /\bnpm\s+(run\s+)?test\b/i.test(cmd)) {
      return { state: 'testing', detail: shortCmd || 'running tests' };
    }

    // Detect install commands
    if (/\b(npm\s+install|yarn\s+(add|install)|pip\s+install|cargo\s+build|apt(-get)?\s+install|brew\s+install|pnpm\s+(add|install)|bun\s+(add|install))\b/i.test(cmd)) {
      return { state: 'installing', detail: shortCmd || 'installing' };
    }

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
    const query = toolInput?.query || toolInput?.url || '';
    const shortQuery = query.length > 30 ? query.slice(0, 27) + '...' : query;
    return { state: 'searching', detail: shortQuery ? `searching "${shortQuery}"` : 'searching the web' };
  }

  // Task/subagent
  if (/^(task|subagent)$/i.test(toolName)) {
    const desc = toolInput?.description || '';
    const shortDesc = desc.length > 30 ? desc.slice(0, 27) + '...' : desc;
    return { state: 'subagent', detail: shortDesc || 'spawning subagent' };
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
        toolCalls: 0, filesEdited: [], subagentCount: 0,
      };
    }

    // Clear old milestones (older than 8 seconds)
    if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
      stats.recentMilestone = null;
    }

    if (hookEvent === 'PreToolUse') {
      ({ state, detail } = toolToState(toolName, toolInput));
      stats.session.toolCalls++;
      stats.totalToolCalls = (stats.totalToolCalls || 0) + 1;

      // Track files edited
      if (/^(edit|multiedit|write|str_replace|create_file)$/i.test(toolName)) {
        const fp = toolInput?.file_path || toolInput?.path || '';
        const base = fp ? path.basename(fp) : '';
        if (base && !stats.session.filesEdited.includes(base)) {
          stats.session.filesEdited.push(base);
        }
        if (base) {
          stats.frequentFiles[base] = (stats.frequentFiles[base] || 0) + 1;
        }
      }

      // Track subagents
      if (/^(task|subagent)$/i.test(toolName)) {
        stats.session.subagentCount++;
        if (stats.session.subagentCount > (stats.records.mostSubagents || 0)) {
          stats.records.mostSubagents = stats.session.subagentCount;
        }
      }
    }
    else if (hookEvent === 'PostToolUse') {
      // ── Error detection ───────────────────────────────────────────
      // Claude Code doesn't pass exit_code to hooks, so we have to
      // play detective with what we DO get: stdout, stderr, isError,
      // and interrupted.  This is forensic error detection.
      const stdout = toolResponse?.stdout || '';
      const stderr = toolResponse?.stderr || '';
      const isError = toolResponse?.isError || data?.isError || false;

      // Try to extract an exit code from stdout -- Claude Code often
      // appends "Exit code: N" to the output even though it doesn't
      // give us exit_code as a field.  Sneaky, but we can read.
      const exitMatch = stdout.match(/(?:exit code|exited with|returned?)[:=\s]+(\d+)/i);
      const inferredExit = exitMatch ? parseInt(exitMatch[1], 10) : null;

      // Signature patterns that scream "something broke" in stdout
      const stdoutErrorPatterns = [
        /\bcommand not found\b/i,
        /\bno such file or directory\b/i,
        /\bpermission denied\b/i,
        /\bsegmentation fault\b/i,
        /\bsyntax error\b/i,
        /\bENOENT\b/,
        /\bENOTDIR\b/,
        /\bEACCES\b/,
        /\bEPERM\b/,
        /\bFATAL\b/,
        /\bPANIC\b/i,
        /\bUnhandledPromiseRejection\b/,
        /\bTraceback \(most recent call last\)/,        // Python
        /\bat Object\.<anonymous>.*\n\s+at /,           // Node stack trace
        /\bCannot find module\b/,
        /\bModuleNotFoundError\b/,
        /\bImportError\b/,
        /\bCompilation failed\b/i,
        /\bbuild failed\b/i,
        /\btest(s)? failed\b/i,
        /\bfailed with exit code\b/i,
        /\bnpm ERR!/,
        /\bcargo error\b/i,
        /\frustc.*error\[E\d+\]/,                       // Rust compiler errors
      ];

      // Patterns in stderr that actually mean trouble (not just warnings)
      const stderrErrorPatterns = [
        /\berror\b/i,
        /\bfatal\b/i,
        /\bfailed\b/i,
        /\bENOENT\b/,
        /\bEACCES\b/,
        /\bcommand not found\b/i,
        /\bpermission denied\b/i,
        /\bsegmentation fault\b/i,
        /\bpanic\b/i,
      ];

      // False positive guards: these look scary but aren't
      const falsePositives = [
        /0 errors?\b/i,
        /no errors?\b/i,
        /errors?:\s*0\b/i,
        /error handling/i,
        /error\.js/i,                                     // Just a filename
        /stderr/i,                                        // Talking about stderr
        /\.error\s*[=(]/,                                 // Property/method named error
        /error_count.*0/i,
        /warning/i,                                       // warnings aren't errors
      ];

      function looksLikeError(text, patterns) {
        if (!text) return false;
        const hit = patterns.some(p => p.test(text));
        if (!hit) return false;
        // Check it's not a false positive
        const isFP = falsePositives.some(p => p.test(text));
        return !isFP;
      }

      // Colorful error detail based on what we found
      function errorDetail(stdout, stderr) {
        if (/command not found/i.test(stdout + stderr)) return 'command not found';
        if (/permission denied/i.test(stdout + stderr)) return 'permission denied';
        if (/no such file or directory/i.test(stdout + stderr)) return 'file not found';
        if (/segmentation fault/i.test(stdout + stderr)) return 'segfault!';
        if (/ENOENT/.test(stdout + stderr)) return 'missing file/path';
        if (/syntax error/i.test(stdout + stderr)) return 'syntax error';
        if (/Traceback|at Object\.<anonymous>|Error:/.test(stdout)) return 'exception thrown';
        if (/Cannot find module|ModuleNotFound/i.test(stdout + stderr)) return 'missing module';
        if (/Compilation failed|build failed/i.test(stdout + stderr)) return 'build broke';
        if (/test(s)? failed|\d+\s+failed/i.test(stdout + stderr)) return 'tests failed';
        if (/npm ERR!/i.test(stdout + stderr)) return 'npm error';
        return 'something went wrong';
      }

      // The decision tree -- in order of confidence
      if (isError) {
        state = 'error';
        detail = errorDetail(stdout, stderr);
      } else if (toolResponse?.interrupted) {
        state = 'error';
        detail = 'interrupted';
      } else if (inferredExit !== null && inferredExit !== 0) {
        state = 'error';
        detail = errorDetail(stdout, stderr) || `exit ${inferredExit}`;
      } else if (looksLikeError(stderr, stderrErrorPatterns)) {
        state = 'error';
        detail = errorDetail(stdout, stderr);
      } else if (/^bash$/i.test(toolName) && looksLikeError(stdout, stdoutErrorPatterns)) {
        // Only check stdout patterns for Bash -- other tools have structured output
        state = 'error';
        detail = errorDetail(stdout, stderr);
      } else if (/^(edit|multiedit|write|str_replace|create_file)$/i.test(toolName)) {
        state = 'proud';
        const fp = toolInput?.file_path || toolInput?.path || '';
        detail = fp ? `saved ${path.basename(fp)}` : 'code written';
        // Calculate diff info for thought bubbles
        const oldStr = toolInput?.old_string || toolInput?.old_str || '';
        const newStr = toolInput?.new_string || toolInput?.new_str || toolInput?.content || '';
        if (oldStr || newStr) {
          const removed = oldStr ? oldStr.split('\n').length : 0;
          const added = newStr ? newStr.split('\n').length : 0;
          diffInfo = { added, removed };
        }
      } else if (/^(read|view|cat)$/i.test(toolName)) {
        state = 'satisfied';
        const fp = toolInput?.file_path || toolInput?.path || '';
        detail = fp ? `read ${path.basename(fp)}` : 'got it';
      } else if (/^(grep|glob|search|ripgrep|find|list)$/i.test(toolName)) {
        state = 'satisfied';
        const pattern = toolInput?.pattern || toolInput?.query || '';
        detail = pattern ? `found "${pattern.length > 20 ? pattern.slice(0, 17) + '...' : pattern}"` : 'got it';
      } else if (/^(web_search|web_fetch|fetch|webfetch)$/i.test(toolName)) {
        state = 'satisfied';
        detail = 'search complete';
      } else if (/^bash$/i.test(toolName)) {
        state = 'relieved';
        const cmd = toolInput?.command || '';
        const isTest = /\b(jest|pytest|vitest|mocha|cypress|playwright|\.test\.|spec)\b/i.test(cmd) ||
                       /\bnpm\s+(run\s+)?test\b/i.test(cmd);
        const isBuild = /\b(build|compile|tsc|webpack|vite|esbuild|rollup|make)\b/i.test(cmd);
        const isGit = /\bgit\s/i.test(cmd);
        const isInstall = /\b(npm\s+install|yarn|pip\s+install|cargo\s+build|pnpm|bun\s+(add|install))\b/i.test(cmd);

        if (isTest) {
          // Try to pull test count from stdout
          const testCount = stdout.match(/(\d+)\s+(?:tests?|specs?)\s+passed/i)
                         || stdout.match(/(\d+)\s+passing/i);
          detail = testCount ? `${testCount[1]} tests passed` : 'tests passed';
        } else if (isBuild) {
          detail = 'build succeeded';
        } else if (isGit) {
          detail = 'git done';
        } else if (isInstall) {
          detail = 'installed';
        } else {
          detail = 'command succeeded';
        }
      } else {
        state = 'satisfied';
        detail = 'step complete';
      }

      if (state === 'error') {
        stats.brokenStreak = stats.streak || 0;
        stats.brokenStreakAt = Date.now();
        stats.streak = 0;
        stats.totalErrors = (stats.totalErrors || 0) + 1;
      } else {
        stats.streak = (stats.streak || 0) + 1;
        if (stats.streak > (stats.bestStreak || 0)) {
          stats.bestStreak = stats.streak;
        }
        // Milestone checks
        const milestones = [10, 25, 50, 100, 200, 500];
        if (milestones.includes(stats.streak)) {
          stats.recentMilestone = { type: 'streak', value: stats.streak, at: Date.now() };
        }
      }
    }
    else if (hookEvent === 'Stop') {
      state = 'happy';
      detail = 'all done!';
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
    }
    else if (hookEvent === 'Notification') {
      state = 'waiting';
      detail = 'needs attention';
    }
    else {
      if (toolName) {
        ({ state, detail } = toolToState(toolName, toolInput));
      }
    }

    // Build extra data for state files
    const currentSessionMs = stats.session.start ? Date.now() - stats.session.start : 0;
    const extra = {
      toolCalls: stats.session.toolCalls,
      filesEdited: stats.session.filesEdited.length,
      sessionStart: stats.session.start,
      streak: stats.streak,
      bestStreak: stats.bestStreak,
      brokenStreak: stats.brokenStreak,
      brokenStreakAt: stats.brokenStreakAt,
      milestone: stats.recentMilestone,
      diffInfo,
      dailySessions: stats.daily.sessionCount,
      dailyCumulativeMs: stats.daily.cumulativeMs + currentSessionMs,
      frequentFiles: stats.frequentFiles,
    };

    // Write both: single file (backward compat) + session file (grid mode)
    writeState(state, detail, extra);
    writeSessionState(sessionId, state, detail, stopped, extra);
    writeStats(stats);
  } catch {
    writeState('thinking');
  }

  process.exit(0);
});

process.stdin.on('close', () => {
  process.exit(0);
});
