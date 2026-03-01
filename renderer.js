#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb -- A terminal tamagotchi for AI coding assistants   |
// |  Shows what your AI coding assistant is doing                   |
// |  Subagent mini-faces orbit the main face as satellites          |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { HOME, STATE_FILE, SESSIONS_DIR, TEAMS_DIR, TMUX_FILE, loadPrefs, savePrefs, getGitBranch, QUIT_FLAG_FILE, safeFilename } = require('./shared');

// -- Modules -------------------------------------------------------
const {
  ansi, lerpColor, dimColor, breathe, dimAnsiOutput,
  themes, TIMELINE_COLORS, SPARKLINE_BLOCKS,
  COMPLETION_LINGER,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
  PALETTES, PALETTE_NAMES,
  setNoColor, isNoColor,
} = require('./themes');
const { mouths, eyes, gridMouths } = require('./animations');
const { ParticleSystem } = require('./particles');
const { ClaudeFace } = require('./face');
const { MiniFace, OrbitalSystem, renderSessionList } = require('./grid');
const { SwapTransition } = require('./transition');

// -- Config --------------------------------------------------------
const PID_FILE = path.join(HOME, '.code-crumb.pid');
const FPS = 15;
const FRAME_MS = Math.floor(1000 / FPS);
const IDLE_TIMEOUT = 8000;
const THINKING_TIMEOUT = 45000; // 45s -- safety net if Stop event is missed
const SLEEP_TIMEOUT = 60000;

// ===================================================================
// SHARED RUNTIME
// ===================================================================

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (!raw) return { state: 'idle', detail: '' };
    const data = JSON.parse(raw);
    return {
      state: data.state || 'idle',
      detail: data.detail || '',
      timestamp: data.timestamp || 0,
      sessionId: data.sessionId || '',
      modelName: data.modelName || '',
      toolCalls: data.toolCalls || 0,
      filesEdited: data.filesEdited || 0,
      sessionStart: data.sessionStart || 0,
      streak: data.streak || 0,
      bestStreak: data.bestStreak || 0,
      brokenStreak: data.brokenStreak || 0,
      brokenStreakAt: data.brokenStreakAt || 0,
      milestone: data.milestone || null,
      diffInfo: data.diffInfo || null,
      dailySessions: data.dailySessions || 0,
      dailyCumulativeMs: data.dailyCumulativeMs || 0,
      frequentFiles: data.frequentFiles || {},
      stopped: data.stopped || false,
      cwd: data.cwd || null,
      isWorktree: data.isWorktree || false,
      gitBranch: data.gitBranch || null,
      commitCount: data.commitCount || 0,
    };
  } catch {
    return { state: 'idle', detail: '' };
  }
}

// -- PID guard -----------------------------------------------------
function isAlreadyRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

function writePid() {
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
}

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function clearQuitFlag() {
  try { fs.unlinkSync(QUIT_FLAG_FILE); } catch {}
}

function writeQuitFlag() {
  try { fs.writeFileSync(QUIT_FLAG_FILE, String(Date.now()), 'utf8'); } catch {}
}

// -- Team discovery ------------------------------------------------
// Scans ~/.claude/teams/*/config.json and returns a map of
// team name → { teammates: string[] } for display purposes.
function scanTeams() {
  const teams = {};
  try {
    const entries = fs.readdirSync(TEAMS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const cfg = JSON.parse(
          fs.readFileSync(path.join(TEAMS_DIR, entry.name, 'config.json'), 'utf8')
        );
        teams[entry.name] = {
          teammates: Array.isArray(cfg.teammates) ? cfg.teammates : [],
        };
      } catch {
        // Config missing or malformed — skip
      }
    }
  } catch {
    // Teams dir doesn't exist — agent teams not in use
  }
  return teams;
}

// -- Unified mode (main face + orbital subagents) ------------------
function runUnifiedMode() {
  const minimal = (process.argv.includes('--minimal') || process.env.MINIMAL_BOOT === '1');
  const face = new ClaudeFace();
  const rendererStartTime = Date.now();
  face.setState('starting');
  const orbital = new OrbitalSystem();
  const swapTransition = new SwapTransition();

  // Minimal mode: strip all UI chrome, just face + status line
  if (minimal) {
    face.minimalMode = true;
    face.accessoriesEnabled = false;
    face.showStats = false;
    face.showOrbitals = false;
  }

  // Ensure sessions directory exists
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

  // Load persisted preferences (skipped in minimal mode)
  if (!minimal) {
    const prefs = loadPrefs();
    if (typeof prefs.paletteIndex === 'number') face.paletteIndex = prefs.paletteIndex % PALETTES.length;
    if (typeof prefs.accessoriesEnabled === 'boolean') face.accessoriesEnabled = prefs.accessoriesEnabled;
    if (typeof prefs.showStats === 'boolean') face.showStats = prefs.showStats;
    if (typeof prefs.showOrbitals === 'boolean') face.showOrbitals = prefs.showOrbitals;
  }

  // Main session isolation
  let mainSessionId = null;
  let lastMainUpdate = 0;

  let lastMtime = 0;
  let lastFileState = 'idle'; // Track the last state written to the file by hooks
  let lastStopped = false;    // Track if Stop hook has fired (session ended)
  let lastForceReadTime = 0;  // Track periodic forced re-reads (bypasses mtime race)
  let lastAppliedTimestamp = 0; // Dedup: skip re-applying state with same timestamp
  function checkState() {
    const now = Date.now();
    try {
      const stat = fs.statSync(STATE_FILE);
      // Every 2s, bypass mtime check to eliminate NTFS 1-second mtime race
      const forceRead = (now - lastForceReadTime > 2000);
      if (stat.mtimeMs > lastMtime || forceRead) {
        if (forceRead) lastForceReadTime = now;
        lastMtime = stat.mtimeMs;
        const stateData = readState();

        // Use JSON timestamp (ms precision) for staleness instead of
        // filesystem mtime (NTFS has 1-second granularity, and mtime
        // never updates if Claude is thinking with no tool calls).
        // Skip state older than 2 minutes pre-renderer-start — truly stale.
        const ts = stateData.timestamp || 0;
        if (ts > 0 && ts < rendererStartTime - 120000) {
          return;
        }

        // First session we see becomes "main"
        if (!mainSessionId && stateData.sessionId) {
          mainSessionId = stateData.sessionId;
        }

        // If sessionId is missing, treat as belonging to current main session
        // (fallback for older hooks or parse failures)
        const incomingId = stateData.sessionId || mainSessionId;

        // If a different session is writing to the state file:
        if (incomingId && mainSessionId && incomingId !== mainSessionId) {
          // Adopt as new main only if old main session ended, is very stale,
          // or a new session is explicitly starting (SessionStart hook)
          if (lastStopped || Date.now() - lastMainUpdate > 120000
              || stateData.isSessionStart === true) {
            if (!swapTransition.active) {
              swapTransition.start(mainSessionId, incomingId);
            }
            // Actual swap happens on the 'swap' frame in the render loop
            lastStopped = false;
          } else {
            return; // Ignore — this is a subagent writing to the state file
          }
        }

        lastMainUpdate = Date.now();
        lastFileState = stateData.state;
        if (stateData.stopped) lastStopped = true;

        // Don't apply incoming state while a swap transition is animating —
        // the face should dissolve with its current state until the swap frame.
        if (swapTransition.active) return;

        if (ts > lastAppliedTimestamp) {
          lastAppliedTimestamp = ts;
          // Force-apply stopped state (session ended) — bypass minimum display time
          // so the face doesn't get stuck on "thinking" when Claude is interrupted
          if (stateData.stopped && Date.now() < face.minDisplayUntil) {
            face.minDisplayUntil = Date.now();
          }
          face.setState(stateData.state, stateData.detail);
          face.setStats(stateData);
        }
      }
    } catch {}

    // -- Stopped-flag rescue: runs BEFORE the minDisplayUntil early return --
    // If Stop hook fired (lastStopped=true) but the face is still showing an
    // active/thinking state (either because the file read was missed due to mtime
    // granularity, or because setState buffered 'responding' as pendingState
    // while minDisplayUntil was active), force-transition to 'responding' now.
    // We bypass setState() here to avoid it re-buffering the state.
    // Completion states (happy/satisfied/proud/relieved) are excluded — they
    // already transition to idle via the linger path with sessionActive=false.
    const rescueExclude = new Set(['idle', 'sleeping', 'responding', 'starting', 'happy', 'satisfied', 'proud', 'relieved']);
    if (lastStopped && !rescueExclude.has(face.state)) {
      face.prevState = face.state;
      face.state = 'responding';
      face.transitionFrame = 0;
      face.lastStateChange = now;
      face.stateDetail = 'wrapping up';
      face.minDisplayUntil = now + 3000; // respect responding's 3s min display time
      face.pendingState = null;
      face.pendingDetail = '';
      face.particles.fadeAll();
      face.timeline.push({ state: 'responding', at: now });
      if (face.timeline.length > 200) face.timeline.shift();
    }

    // If we're past minDisplayUntil and in an active state,
    // do a fresh file read to catch any stop/start event missed by fs.watch mtime
    // granularity (common on Windows FAT/NTFS with 1-second mtime resolution).
    const freshReadStates = ['thinking', 'executing', 'coding', 'reading', 'searching', 'testing', 'installing', 'responding', 'happy', 'satisfied', 'proud', 'relieved'];
    if (now >= face.minDisplayUntil &&
        freshReadStates.includes(face.state) &&
        (face.state === 'thinking' || now - lastMainUpdate > 2000)) {
      try {
        const freshData = readState();
        const freshTs = freshData.timestamp || 0;
        // Detect stopped transition: false->true only (resets via session adoption)
        const stoppedNow = freshData.stopped || false;
        if (stoppedNow && !lastStopped && freshTs > lastAppliedTimestamp) {
          lastAppliedTimestamp = freshTs;
          lastStopped = stoppedNow;
          lastFileState = freshData.state;
          // If the file says responding (or ratelimited), apply it; otherwise
          // we just set lastStopped so the rescue block above fires next frame.
          if (freshData.state === 'responding' || freshData.state === 'ratelimited') {
            face.prevState = face.state;
            face.state = freshData.state;
            face.transitionFrame = 0;
            face.lastStateChange = now;
            face.stateDetail = freshData.detail || 'wrapping up';
            face.minDisplayUntil = now + 3000; // respect responding's 3s min display time
            face.pendingState = null;
            face.pendingDetail = '';
            face.particles.fadeAll();
            face.timeline.push({ state: freshData.state, at: now });
            if (face.timeline.length > 200) face.timeline.shift();
          }
        }
      } catch {}
    }

    // Don't apply timeouts if minimum display time hasn't passed
    if (now < face.minDisplayUntil) return;

    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    const completionLinger = COMPLETION_LINGER[face.state];
    // Session is active until Stop hook fires (writes stopped: true)
    const sessionActive = !lastStopped;

    // Auto-transition: starting → idle after min display
    if (face.state === 'starting' && now - face.lastStateChange > 2500) {
      face.setState('idle');
    // Auto-transition: responding → happy after min display (Stop already fired)
    } else if (face.state === 'responding' && lastStopped && now >= face.minDisplayUntil) {
      face.setState('happy');
    } else if (completionLinger && now - face.lastStateChange > completionLinger) {
      face.setState(sessionActive ? 'thinking' : 'idle');
    } else if (face.state === 'thinking' &&
               now - face.lastStateChange > (sessionActive ? THINKING_TIMEOUT : IDLE_TIMEOUT)) {
      face.setState('idle');
    } else if (!completionStates.includes(face.state) &&
               face.state !== 'idle' && face.state !== 'sleeping' &&
               face.state !== 'thinking' &&
               face.state !== 'starting' &&
               now - face.lastStateChange > IDLE_TIMEOUT) {
      // Active tool states degrade to thinking (not idle) if session is still running
      face.setState(sessionActive ? 'thinking' : 'idle');
    }
    if (face.state === 'idle' && now - face.lastStateChange > SLEEP_TIMEOUT) {
      face.setState('sleeping');
    }
  }

  checkState();

  // Watch state file for changes
  try {
    const dir = path.dirname(STATE_FILE);
    const basename = path.basename(STATE_FILE);
    fs.watch(dir, (eventType, filename) => {
      // filename can be null on some platforms (macOS with certain filesystems)
      if (!filename || filename === basename) checkState();
    });
  } catch {}

  // Watch sessions directory for subagent changes (skipped in minimal mode)
  if (!minimal) {
    let sessionWatchTimer = null;
    try {
      fs.watch(SESSIONS_DIR, () => {
        checkState();
        if (sessionWatchTimer) clearTimeout(sessionWatchTimer);
        sessionWatchTimer = setTimeout(() => {
          if (mainSessionId) orbital.loadSessions(mainSessionId);
        }, 80);
      });
    } catch {}
  }

  // Pre-populate mainSessionId before loading sessions (prevents phantom orbital race)
  if (!minimal) checkState();

  // Initial session load (skipped in minimal mode)
  if (!minimal) orbital.loadSessions(mainSessionId);

  // Initial team discovery (skipped in minimal mode)
  let activeTeams = minimal ? {} : scanTeams();

  // Raw stdin keypress handling
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    function persistPrefs() {
      savePrefs({
        paletteIndex: face.paletteIndex,
        accessoriesEnabled: face.accessoriesEnabled,
        showStats: face.showStats,
        showOrbitals: face.showOrbitals,
      });
    }

    process.stdin.on('data', (key) => {
      if (key === 'q' || key === '\x03') { cleanup(); return; } // q or Ctrl+C
      if (minimal) {
        // Minimal mode: only pet and quit
        if (key === ' ') face.pet();
        return;
      }
      // Help dismiss: any key while help is showing closes it
      if (face.showHelp) { face.showHelp = false; return; }
      // Session list navigation: arrows/j/k to navigate, Enter to promote, Esc/other to dismiss
      if (face.showSessionList) {
        const maxIdx = face.sessionListCount - 1;
        if (key === '\x1b[A' || key === 'k') {
          face.sessionListIndex = Math.max(0, face.sessionListIndex - 1);
        } else if (key === '\x1b[B' || key === 'j') {
          face.sessionListIndex = Math.min(Math.max(0, maxIdx), face.sessionListIndex + 1);
        } else if (key === '\r' || key === '\n') {
          if (face.sessionListIndex > 0) {
            face.sessionListPromote = face.sessionListIndex;
          }
          face.showSessionList = false;
          face.sessionListIndex = 0;
        } else {
          face.showSessionList = false;
          face.sessionListIndex = 0;
        }
        return;
      }
      if (key === ' ') face.pet();
      else if (key === 't' && !isNoColor()) { face.cycleTheme(); orbital.paletteIndex = face.paletteIndex; persistPrefs(); }
      else if (key === 's') { face.toggleStats(); persistPrefs(); }
      else if (key === 'a') { face.toggleAccessories(); persistPrefs(); }
      else if (key === 'o') { face.toggleOrbitals(); persistPrefs(); }
      else if (key === 'l') face.toggleSessionList();
      else if (key === 'h' || key === '?') face.toggleHelp();
    });
  }

  process.stdout.on('resize', () => {
    // Force-complete swap on resize to avoid ghost artifacts
    if (swapTransition.active) {
      _executeSwap();
      swapTransition.cancel();
    }
    face.particles.fadeAll(5);
    orbital._prevClearBuf = '';  // Full clear handles it
    prevSessionListClear = '';
    process.stdout.write(ansi.clear);
  });

  // Execute the actual main↔orbital swap (called on 'swap' frame or forced by resize)
  function _executeSwap() {
    const oldId = swapTransition.fromId;
    const newId = swapTransition.toId;
    if (!oldId || !newId) return;

    // Write old main's current state as an orbital session file
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      const oldData = {
        session_id: oldId,
        state: face.state,
        detail: face.stateDetail,
        timestamp: Date.now(),
        modelName: face.modelName || 'claude',
        cwd: face.cwd,
        gitBranch: face.gitBranch,
        stopped: lastStopped,
      };
      fs.writeFileSync(
        path.join(SESSIONS_DIR, safeFilename(oldId) + '.json'),
        JSON.stringify(oldData), 'utf8'
      );
    } catch {}

    // Adopt the new session as main
    mainSessionId = newId;

    // Read the new main's session file and apply state
    try {
      const newFile = path.join(SESSIONS_DIR, safeFilename(newId) + '.json');
      const newData = JSON.parse(fs.readFileSync(newFile, 'utf8'));
      face.setState(newData.state || 'idle', newData.detail || '');
      if (newData.modelName) face.modelName = newData.modelName;
      if (newData.cwd) face.cwd = newData.cwd;
      if (newData.gitBranch) face.gitBranch = newData.gitBranch;
      lastStopped = !!newData.stopped;
      // Remove promoted session's orbital file
      try { fs.unlinkSync(newFile); } catch {}
    } catch {
      // If session file can't be read, just adopt the ID and read state next cycle
    }

    // Spawn celebration particles
    face.particles.spawn(8, 'sparkle');
    face.particles.spawn(4, 'push');

    // Reload orbital sessions
    orbital.loadSessions(mainSessionId);
  }

  let lastTime = Date.now();
  let prevFrame = null;
  let prevSessionListClear = '';
  function loop() {
    const now = Date.now();
    const dt = now - lastTime;
    lastTime = now;

    face.update(dt);
    orbital.update(dt);

    // -- Transition tick --
    if (swapTransition.active) {
      const result = swapTransition.tick();
      if (result.phase === 'dissolve') {
        // Spawn glitch particles during dissolve
        if (swapTransition.frame === 1) face.particles.fadeAll();
        if (swapTransition.frame % 2 === 0) face.particles.spawn(2, 'glitch');
      } else if (result.phase === 'swap') {
        _executeSwap();
      } else if (result.phase === 'materialize') {
        if (swapTransition.frame % 3 === 0) face.particles.spawn(1, 'stream');
      }
    }

    // -- Manual promotion from session list --
    if (face.sessionListPromote !== null && !swapTransition.active) {
      const subSorted = orbital.getSortedFaces();
      const promoteIdx = face.sessionListPromote - 1; // subtract 1 for main at index 0
      if (promoteIdx >= 0 && promoteIdx < subSorted.length) {
        const target = subSorted[promoteIdx];
        swapTransition.start(mainSessionId, target.sessionId);
      }
      face.sessionListPromote = null;
    }

    // Periodically reload sessions
    if (orbital.frame % (FPS * 5) === 0) orbital.loadSessions(mainSessionId);

    // Periodically rescan team configs (~every 10s)
    if (orbital.frame % (FPS * 10) === 0) activeTeams = scanTeams();

    if (face.frame % Math.floor(FPS / 2) === 0) checkState();

    // Tell face how many subagents are active (for status line)
    face.subagentCount = orbital.faces.size;

    // Sync palette
    orbital.paletteIndex = face.paletteIndex;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    let out;
    try {
      out = face.render();
    } catch {
      out = '';
    }
    if (!minimal && face.showOrbitals && face.lastPos) {
      const paletteThemes = (PALETTES[face.paletteIndex] || PALETTES[0]).themes;
      try {
        out += orbital.render(cols, rows, face.lastPos, paletteThemes);
      } catch {}
    }

    // Apply transition dim to face output
    if (swapTransition.active) {
      out = dimAnsiOutput(out, swapTransition.dimFactor());
    }

    // Session list overlay (drawn on top of orbital, not dimmed)
    if (!minimal && face.showSessionList) {
      const paletteThemes = (PALETTES[face.paletteIndex] || PALETTES[0]).themes;
      const subSorted = orbital.getSortedFaces();
      face.sessionListCount = 1 + subSorted.length; // main + orbitals
      const mainInfo = {
        state: face.state,
        detail: face.stateDetail,
        cwd: face.cwd,
        gitBranch: face.gitBranch,
        label: face.modelName || 'claude',
        stopped: lastStopped,
        firstSeen: 0, // sort first
        isMain: true,
      };
      const slBounds = {};
      try { out += renderSessionList(cols, rows, subSorted, paletteThemes, mainInfo, face.sessionListIndex, slBounds); } catch {}
      // Build clear buffer for when the overlay is dismissed
      if (slBounds.bx != null) {
        let clr = '';
        const clearRow = ' '.repeat(slBounds.w);
        for (let r = slBounds.by; r < slBounds.by + slBounds.h; r++) {
          clr += `\x1b[${r};${slBounds.bx}H${clearRow}`;
        }
        prevSessionListClear = clr;
      }
    } else if (prevSessionListClear) {
      out += prevSessionListClear;
      prevSessionListClear = '';
    }

    // Update terminal title bar to reflect current state
    const _pal = PALETTES[face.paletteIndex] || PALETTES[0];
    const _status = (_pal.themes[face.state] || _pal.themes.idle).status;
    const _title = `\x1b]0;Code Crumb \u00b7 ${face.modelName} is ${_status}\x07`;

    if (out === prevFrame) {
      setTimeout(loop, FRAME_MS);
      return;
    }
    prevFrame = out;
    process.stdout.write(_title + ansi.home + out);
    setTimeout(loop, FRAME_MS);
  }

  loop();
}

// -- tmux status line mode -----------------------------------------
// Lightweight poll loop that writes a compact one-line status to a file
// readable via #(cat ~/.code-crumb-tmux) in tmux status-line config.
//
// Usage in .tmux.conf:
//   set -g status-right "#(cat ~/.code-crumb-tmux)"
//
// Start with: node renderer.js --tmux  (or: npm run tmux)
// No PID guard — can run alongside the full-face renderer.

const TMUX_POLL_MS = 2000;

function runTmuxMode() {
  const defaultThemes = PALETTES[0].themes;

  function writeTmuxStatus() {
    try {
      const data = readState();
      const state = data.state || 'idle';
      const theme = defaultThemes[state] || defaultThemes.idle;
      const emoji = theme.emoji || '';
      const status = theme.status || state;
      const model = data.modelName || process.env.CODE_CRUMB_MODEL || 'claude';
      const branch = data.gitBranch || getGitBranch() || '';
      const streak = data.streak || 0;

      let line = `${emoji} ${status} [${model}]`;
      if (branch) line += ` [${branch}]`;
      if (streak > 0) line += ` \uD83D\uDD25${streak}`;

      fs.writeFileSync(TMUX_FILE, line, 'utf8');
    } catch {}
  }

  // Write initial status immediately
  writeTmuxStatus();

  // Poll on interval
  const timer = setInterval(writeTmuxStatus, TMUX_POLL_MS);

  function cleanup() {
    clearInterval(timer);
    try { fs.unlinkSync(TMUX_FILE); } catch {}
    process.exit(0);
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  try { process.on('SIGHUP', cleanup); } catch {}
  process.on('exit', () => { try { fs.unlinkSync(TMUX_FILE); } catch {} });
}

// -- Entry ---------------------------------------------------------
function main() {
  const tmuxMode = process.argv.includes('--tmux');

  // Skip PID guard for tmux mode — can run alongside full renderer
  if (!tmuxMode) {
    // Clear quit flag on normal startup so autolaunch works for new sessions
    clearQuitFlag();
    if (isAlreadyRunning()) {
      console.log('Code Crumb is already running in another window.');
      process.exit(0);
    }
    writePid();
  }

  // NO_COLOR compliance (https://no-color.org)
  if (process.env.NO_COLOR !== undefined || process.argv.includes('--no-color')) {
    setNoColor(true);
  }

  if (tmuxMode) {
    runTmuxMode();
    return;
  }

  function cleanup() {
    writeQuitFlag();
    removePid();
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch {}
    process.stdout.write(ansi.show + ansi.clear + ansi.reset);
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  try { process.on('SIGHUP', cleanup); } catch {}
  process.on('exit', removePid);

  process.stdout.write(ansi.hide + ansi.clear);
  process.stdout.write(`\x1b]0;Code Crumb\x07`);

  runUnifiedMode();
}

// -- Module exports (for testing) / Entry ----------------------------
if (require.main === module) {
  main();
} else {
  module.exports = {
    ClaudeFace, MiniFace, OrbitalSystem, ParticleSystem,
    lerpColor, dimColor, breathe,
    themes, mouths, eyes, gridMouths,
    COMPLETION_LINGER, TIMELINE_COLORS, SPARKLINE_BLOCKS,
    IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
    PALETTES, PALETTE_NAMES,
  };
}
