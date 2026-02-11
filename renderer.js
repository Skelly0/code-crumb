#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face -- A tamagotchi for Claude Code                    |
// |  Shows what Claude is doing with an animated terminal face      |
// |                                                                 |
// |  Modes:                                                         |
// |    node renderer.js            Single face (default)            |
// |    node renderer.js --grid     Multi-face grid                  |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { HOME, STATE_FILE, SESSIONS_DIR } = require('./shared');

// -- Modules -------------------------------------------------------
const {
  ansi, lerpColor, dimColor, breathe,
  themes, TIMELINE_COLORS, SPARKLINE_BLOCKS,
  COMPLETION_LINGER,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
} = require('./themes');
const { mouths, eyes, gridMouths } = require('./animations');
const { ParticleSystem } = require('./particles');
const { ClaudeFace } = require('./face');
const { MiniFace, FaceGrid } = require('./grid');

// -- Mode ----------------------------------------------------------
const GRID_MODE = process.argv.includes('--grid');

// -- Config --------------------------------------------------------
const PID_FILE = path.join(HOME, GRID_MODE ? '.claude-face-grid.pid' : '.claude-face.pid');
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
      face.setState('idle');
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
      if (filename === basename) checkState();
    });
  } catch {}

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

  try {
    fs.watch(SESSIONS_DIR, () => { grid.loadSessions(); });
  } catch {}

  grid.loadSessions();

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
    console.log(`Claude Face${GRID_MODE ? ' Grid' : ''} is already running in another window.`);
    process.exit(0);
  }
  writePid();

  function cleanup() {
    removePid();
    process.stdout.write(ansi.show + ansi.clear + ansi.reset);
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  try { process.on('SIGHUP', cleanup); } catch {}
  process.on('exit', removePid);

  process.stdout.write(ansi.hide + ansi.clear);
  const title = GRID_MODE ? 'Claude Face Grid' : 'Claude Face';
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
  };
}
