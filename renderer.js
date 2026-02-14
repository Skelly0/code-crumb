#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb -- A terminal tamagotchi for AI coding assistants   |
// |  Shows what your AI coding assistant is doing                   |
// |                                                                 |
// |  Modes:                                                         |
// |    node renderer.js            Single face (default)            |
// |    node renderer.js --grid     Multi-face grid                  |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { HOME, STATE_FILE, SESSIONS_DIR, loadPrefs, savePrefs } = require('./shared');

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
const { MiniFace, FaceGrid } = require('./grid');

// -- Mode ----------------------------------------------------------
const GRID_MODE = process.argv.includes('--grid');

// -- Config --------------------------------------------------------
const PID_FILE = path.join(HOME, GRID_MODE ? '.code-crumb-grid.pid' : '.code-crumb.pid');
const FPS = 15;
const FRAME_MS = Math.floor(1000 / FPS);
const IDLE_TIMEOUT = 8000;
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

// -- Single face mode ----------------------------------------------
function runSingleMode() {
  const face = new ClaudeFace();

  // Load persisted preferences
  const prefs = loadPrefs();
  if (typeof prefs.paletteIndex === 'number') face.paletteIndex = prefs.paletteIndex % PALETTES.length;
  if (typeof prefs.accessoriesEnabled === 'boolean') face.accessoriesEnabled = prefs.accessoriesEnabled;
  if (typeof prefs.showStats === 'boolean') face.showStats = prefs.showStats;

  let lastMtime = 0;
  function checkState() {
    try {
      const stat = fs.statSync(STATE_FILE);
      if (stat.mtimeMs > lastMtime) {
        lastMtime = stat.mtimeMs;
        const stateData = readState();
        face.setState(stateData.state, stateData.detail);
        face.setStats(stateData);
      }
    } catch {}

    const now = Date.now();
    // Don't apply timeouts if minimum display time hasn't passed
    if (now < face.minDisplayUntil) return;

    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    const completionLinger = COMPLETION_LINGER[face.state];

    if (completionLinger && now - face.lastStateChange > completionLinger) {
      face.setState('thinking');
    } else if (!completionStates.includes(face.state) &&
               face.state !== 'idle' && face.state !== 'sleeping' &&
               face.state !== 'waiting' &&
               now - face.lastStateChange > IDLE_TIMEOUT) {
      face.setState('idle');
    }
    if (face.state === 'idle' && now - face.lastStateChange > SLEEP_TIMEOUT) {
      face.setState('sleeping');
    }
  }

  checkState();

  try {
    const dir = path.dirname(STATE_FILE);
    const basename = path.basename(STATE_FILE);
    fs.watch(dir, (eventType, filename) => {
      // filename can be null on some platforms (macOS with certain filesystems)
      if (!filename || filename === basename) checkState();
    });
  } catch {}

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
      });
    }

    process.stdin.on('data', (key) => {
      // Help dismiss: any key while help is showing closes it
      if (face.showHelp && key !== '\x03') { face.showHelp = false; return; }
      if (key === ' ') face.pet();
      else if (key === 't') { face.cycleTheme(); persistPrefs(); }
      else if (key === 's') { face.toggleStats(); persistPrefs(); }
      else if (key === 'a') { face.toggleAccessories(); persistPrefs(); }
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
    if (face.frame % Math.floor(FPS / 2) === 0) checkState();

    process.stdout.write(ansi.home + face.render());
    setTimeout(loop, FRAME_MS);
  }

  loop();
}

// -- Grid mode -----------------------------------------------------
function runGridMode() {
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

  const grid = new FaceGrid();

  // Load persisted preferences
  const prefs = loadPrefs();
  if (typeof prefs.paletteIndex === 'number') grid.paletteIndex = prefs.paletteIndex % PALETTES.length;

  try {
    fs.watch(SESSIONS_DIR, () => { grid.loadSessions(); });
  } catch {}

  grid.loadSessions();

  // Raw stdin keypress handling
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (key) => {
      if (grid.showHelp && key !== '\x03') { grid.showHelp = false; return; }
      if (key === 't') { grid.cycleTheme(); savePrefs({ paletteIndex: grid.paletteIndex }); }
      else if (key === 'h' || key === '?') grid.toggleHelp();
      else if (key === 'q' || key === '\x03') cleanup();
    });
  }

  process.stdout.on('resize', () => {
    grid.prevFaceCount = -1;
    process.stdout.write(ansi.clear);
  });

  let lastTime = Date.now();
  function loop() {
    const now = Date.now();
    const dt = now - lastTime;
    lastTime = now;

    grid.update(dt);
    if (grid.frame % (FPS * 2) === 0) grid.loadSessions();

    process.stdout.write(ansi.home + grid.render());
    setTimeout(loop, FRAME_MS);
  }

  loop();
}

// -- Entry ---------------------------------------------------------
function main() {
  if (isAlreadyRunning()) {
    console.log(`Code Crumb${GRID_MODE ? ' Grid' : ''} is already running in another window.`);
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
  const title = GRID_MODE ? 'Code Crumb Grid' : 'Code Crumb';
  process.stdout.write(`\x1b]0;${title}\x07`);

  if (GRID_MODE) {
    runGridMode();
  } else {
    runSingleMode();
  }
}

// -- Module exports (for testing) / Entry ----------------------------
if (require.main === module) {
  main();
} else {
  module.exports = {
    ClaudeFace, MiniFace, FaceGrid, ParticleSystem,
    lerpColor, dimColor, breathe,
    themes, mouths, eyes, gridMouths,
    COMPLETION_LINGER, TIMELINE_COLORS, SPARKLINE_BLOCKS,
    IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
    PALETTES, PALETTE_NAMES,
  };
}
