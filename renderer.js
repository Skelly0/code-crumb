#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb -- A terminal tamagotchi for AI coding assistants   |
// |  Shows what your AI coding assistant is doing                   |
// |  Subagent mini-faces orbit the main face as satellites          |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { HOME, STATE_FILE, SESSIONS_DIR, TEAMS_DIR, loadPrefs, savePrefs } = require('./shared');

// -- Modules -------------------------------------------------------
const {
  ansi, lerpColor, dimColor, breathe,
  themes, TIMELINE_COLORS, SPARKLINE_BLOCKS,
  COMPLETION_LINGER,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
  PALETTES, PALETTE_NAMES,
} = require('./themes');
const { mouths, eyes, gridMouths } = require('./animations');
const { ParticleSystem } = require('./particles');
const { ClaudeFace } = require('./face');
const { MiniFace, OrbitalSystem } = require('./grid');

// -- Config --------------------------------------------------------
const PID_FILE = path.join(HOME, '.code-crumb.pid');
const FPS = 15;
const FRAME_MS = Math.floor(1000 / FPS);
const IDLE_TIMEOUT = 8000;
const THINKING_TIMEOUT = 300000; // 5min -- stay thinking while Claude processes between tools
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
  } catch {
    return false;
  }
}

function writePid() {
  try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch {}
}

function removePid() {
  try { fs.unlinkSync(PID_FILE); } catch {}
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
  const face = new ClaudeFace();
  const rendererStartTime = Date.now();
  face.setState('starting');
  const orbital = new OrbitalSystem();

  // Ensure sessions directory exists
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

  // Load persisted preferences
  const prefs = loadPrefs();
  if (typeof prefs.paletteIndex === 'number') face.paletteIndex = prefs.paletteIndex % PALETTES.length;
  if (typeof prefs.accessoriesEnabled === 'boolean') face.accessoriesEnabled = prefs.accessoriesEnabled;
  if (typeof prefs.showStats === 'boolean') face.showStats = prefs.showStats;
  if (typeof prefs.showOrbitals === 'boolean') face.showOrbitals = prefs.showOrbitals;

  // Main session isolation
  let mainSessionId = null;
  let lastMainUpdate = 0;

  let lastMtime = 0;
  let lastFileState = 'idle'; // Track the last state written to the file by hooks
  let lastStopped = false;    // Track if Stop hook has fired (session ended)
  function checkState() {
    try {
      const stat = fs.statSync(STATE_FILE);
      if (stat.mtimeMs < rendererStartTime) {
        // File predates this renderer session — ignore stale state, fall through to timeouts
      } else if (stat.mtimeMs > lastMtime) {
        lastMtime = stat.mtimeMs;
        const stateData = readState();

        // First session we see becomes "main"
        if (!mainSessionId && stateData.sessionId) {
          mainSessionId = stateData.sessionId;
        }

        // If sessionId is missing, treat as belonging to current main session
        // (fallback for older hooks or parse failures)
        const incomingId = stateData.sessionId || mainSessionId;

        // If a different session is writing to the state file:
        if (incomingId && mainSessionId && incomingId !== mainSessionId) {
          // Adopt as new main only if old main session ended or is very stale
          if (lastStopped || Date.now() - lastMainUpdate > 120000) {
            mainSessionId = incomingId;
            lastStopped = false;
          } else {
            return; // Ignore — this is a subagent writing to the state file
          }
        }

        lastMainUpdate = Date.now();
        lastFileState = stateData.state;
        lastStopped = stateData.stopped || false;
        face.setState(stateData.state, stateData.detail);
        face.setStats(stateData);
      }
    } catch {}

    const now = Date.now();
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
      face.setState('thinking');
    } else if (face.state === 'thinking' &&
               now - face.lastStateChange > (sessionActive ? THINKING_TIMEOUT : IDLE_TIMEOUT)) {
      face.setState('idle');
    } else if (!completionStates.includes(face.state) &&
               face.state !== 'idle' && face.state !== 'sleeping' &&
               face.state !== 'waiting' && face.state !== 'thinking' &&
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

  // Watch sessions directory for subagent changes
  try {
    fs.watch(SESSIONS_DIR, () => { orbital.loadSessions(mainSessionId); });
  } catch {}

  // Initial session load
  orbital.loadSessions(mainSessionId);

  // Initial team discovery
  let activeTeams = scanTeams();

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
      // Help dismiss: any key while help is showing closes it
      if (face.showHelp && key !== '\x03') { face.showHelp = false; return; }
      if (key === ' ') face.pet();
      else if (key === 't') { face.cycleTheme(); orbital.paletteIndex = face.paletteIndex; persistPrefs(); }
      else if (key === 's') { face.toggleStats(); persistPrefs(); }
      else if (key === 'a') { face.toggleAccessories(); persistPrefs(); }
      else if (key === 'o') { face.toggleOrbitals(); persistPrefs(); }
      else if (key === 'h' || key === '?') face.toggleHelp();
      else if (key === 'q' || key === '\x03') cleanup(); // q or Ctrl+C
    });
  }

  process.stdout.on('resize', () => {
    face.particles.fadeAll(5);
    process.stdout.write(ansi.clear);
  });

  let lastTime = Date.now();
  function loop() {
    const now = Date.now();
    const dt = now - lastTime;
    lastTime = now;

    face.update(dt);
    orbital.update(dt);

    // Periodically reload sessions
    if (orbital.frame % (FPS * 2) === 0) orbital.loadSessions(mainSessionId);

    // Periodically rescan team configs (~every 10s)
    if (orbital.frame % (FPS * 10) === 0) activeTeams = scanTeams();

    if (face.frame % Math.floor(FPS / 2) === 0) checkState();

    // Tell face how many subagents are active (for status line)
    face.subagentCount = orbital.faces.size;

    // Sync palette
    orbital.paletteIndex = face.paletteIndex;

    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;

    let out = face.render();
    if (face.showOrbitals && face.lastPos && orbital.faces.size > 0) {
      const paletteThemes = (PALETTES[face.paletteIndex] || PALETTES[0]).themes;
      out += orbital.render(cols, rows, face.lastPos, paletteThemes);
    }
    process.stdout.write(ansi.home + out);
    setTimeout(loop, FRAME_MS);
  }

  loop();
}

// -- Entry ---------------------------------------------------------
function main() {
  if (isAlreadyRunning()) {
    console.log('Code Crumb is already running in another window.');
    process.exit(0);
  }
  writePid();

  function cleanup() {
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
