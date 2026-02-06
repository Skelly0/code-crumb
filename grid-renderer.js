#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Grid -- multi-session tamagotchi for Claude Code   |
// |  Shows one mini-face per active session/subagent, auto-layouts  |
// |  in a responsive grid based on terminal size.                   |
// +================================================================+

const fs = require('fs');
const path = require('path');

// -- Config --------------------------------------------------------
const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const SESSIONS_DIR = path.join(HOME, '.claude-face-sessions');
const FPS = 12;
const FRAME_MS = Math.floor(1000 / FPS);
const STALE_MS = 120000;      // remove session after 2min of no updates
const STOPPED_LINGER_MS = 5000; // keep "done" state visible for 5s
const IDLE_RETURN_MS = 10000; // return face to idle if no state change
const HAPPY_RETURN_MS = 4000;

// Cell layout (chars)
const CELL_W = 12;   // 8 box + 4 gap
const CELL_H = 7;    // 4 box + 2 labels + 1 gap
const BOX_W = 8;     // ╭──────╮
const BOX_INNER = 6; // inner width

// -- ANSI ----------------------------------------------------------
const CSI = '\x1b[';
const ansi = {
  reset:     `${CSI}0m`,
  bold:      `${CSI}1m`,
  dim:       `${CSI}2m`,
  hide:      `${CSI}?25l`,
  show:      `${CSI}?25h`,
  clear:     `${CSI}2J${CSI}H`,
  home:      `${CSI}H`,
  to:        (r, c) => `${CSI}${r};${c}H`,
  fg:        (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  clearLine: `${CSI}2K`,
};

// -- Color ---------------------------------------------------------
function dimColor(color, factor) {
  return color.map(c => Math.round(c * factor));
}

function breathe(color, time) {
  const t = (Math.sin(time * Math.PI * 2 / 4000) + 1) / 2;
  return dimColor(color, 0.7 + t * 0.3);
}

// -- Themes --------------------------------------------------------
const themes = {
  idle:      { border: [100,160,210], eye: [180,220,255], mouth: [140,190,230], label: [120,170,210], status: 'idle' },
  thinking:  { border: [170,110,220], eye: [210,180,255], mouth: [160,120,200], label: [180,130,230], status: 'thinking' },
  coding:    { border: [70,190,110],  eye: [150,240,180], mouth: [100,200,140], label: [80,200,120],  status: 'coding' },
  reading:   { border: [100,180,180], eye: [160,220,220], mouth: [120,190,190], label: [110,190,190], status: 'reading' },
  searching: { border: [210,190,70],  eye: [250,240,150], mouth: [200,180,90],  label: [220,200,80],  status: 'searching' },
  executing: { border: [210,150,70],  eye: [250,210,150], mouth: [200,160,100], label: [220,160,80],  status: 'executing' },
  happy:     { border: [220,200,60],  eye: [255,250,150], mouth: [230,210,90],  label: [240,220,80],  status: 'done!' },
  error:     { border: [210,70,70],   eye: [255,150,150], mouth: [200,100,100], label: [220,90,90],   status: 'error!' },
  sleeping:  { border: [60,50,110],   eye: [90,80,150],   mouth: [70,60,120],   label: [80,70,140],   status: 'zzz' },
  waiting:   { border: [150,140,180], eye: [190,180,220], mouth: [160,150,190], label: [160,150,190], status: 'waiting' },
  testing:   { border: [180,200,70],  eye: [220,240,130], mouth: [190,210,100], label: [190,210,80],  status: 'testing' },
  installing:{ border: [70,160,190],  eye: [130,200,230], mouth: [100,170,200], label: [80,170,200],  status: 'installing' },
  caffeinated:{ border: [255,180,50], eye: [255,220,100], mouth: [240,190,70],  label: [250,190,60],  status: '!!!' },
  subagent:  { border: [150,100,210], eye: [190,160,240], mouth: [140,110,200], label: [160,120,220], status: 'spawning' },
};

// -- MiniFace ------------------------------------------------------
// A compact, single-row-eyes face for the grid.
// Each face maintains its own blink timer and animation state.

class MiniFace {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.state = 'idle';
    this.detail = '';
    this.label = '';
    this.cwd = '';
    this.lastUpdate = Date.now();
    this.firstSeen = Date.now();
    this.stopped = false;
    this.stoppedAt = 0;

    // Animation state
    this.frame = 0;
    this.time = 0;
    this.blinkTimer = 2500 + Math.random() * 3500;
    this.blinkFrame = -1;
    this.lookDir = 0;
    this.lookTimer = 0;
  }

  // Update from a parsed session file
  updateFromFile(data) {
    const newState = data.state || 'idle';
    if (newState !== this.state) {
      this.state = newState;
    }
    this.detail = data.detail || '';
    this.lastUpdate = data.timestamp || Date.now();
    if (data.cwd) this.cwd = data.cwd;
    if (data.stopped && !this.stopped) {
      this.stopped = true;
      this.stoppedAt = Date.now();
    }
  }

  // Should this session be removed from the grid?
  isStale() {
    if (this.stopped) return Date.now() - this.stoppedAt > STOPPED_LINGER_MS;
    return Date.now() - this.lastUpdate > STALE_MS;
  }

  tick(dt) {
    this.time += dt;
    this.frame++;

    // Blink
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkFrame = 0;
      this.blinkTimer = 2500 + Math.random() * 3500;
    }
    if (this.blinkFrame >= 0) {
      this.blinkFrame++;
      if (this.blinkFrame >= 3) this.blinkFrame = -1;
    }

    // Searching eye direction
    if (this.state === 'searching') {
      this.lookTimer += dt;
      if (this.lookTimer > 600) {
        this.lookDir = [-1, 0, 1, 0][Math.floor(Math.random() * 4)];
        this.lookTimer = 0;
      }
    }

    // Auto-return to idle (but not sleeping or waiting)
    const elapsed = Date.now() - this.lastUpdate;
    if (this.state === 'happy' && elapsed > HAPPY_RETURN_MS) {
      this.state = 'idle';
    } else if (this.state !== 'idle' && this.state !== 'happy' &&
               this.state !== 'sleeping' && this.state !== 'waiting' &&
               elapsed > IDLE_RETURN_MS) {
      this.state = 'idle';
    }
    // Idle for 60s => sleeping
    if (this.state === 'idle' && elapsed > 60000) {
      this.state = 'sleeping';
    }
  }

  // Single-row eyes: 6 chars fitting inside the box
  // Layout: _LL_RR  (1 pad + 2 left eye + 1 gap + 2 right eye = 6)
  getEyes() {
    if (this.blinkFrame >= 0) return ' \u2584\u2584 \u2584\u2584';

    switch (this.state) {
      case 'idle':
        return ' \u2588\u2588 \u2588\u2588';

      case 'thinking': {
        // Dots rotate positions
        const p = Math.floor(this.frame / 4) % 4;
        return [
          ' \u25cf\u00b7 \u00b7\u25cf',
          ' \u00b7\u25cf \u25cf\u00b7',
          ' \u25cf\u00b7 \u25cf\u00b7',
          ' \u00b7\u25cf \u00b7\u25cf',
        ][p];
      }

      case 'reading':
        return ' \u2500\u2500 \u2500\u2500';

      case 'searching':
        if (this.lookDir < 0) return ' \u2588\u2588 \u2588\u00b7';
        if (this.lookDir > 0) return ' \u00b7\u2588 \u2588\u2588';
        return ' \u2588\u2588 \u2588\u2588';

      case 'coding':
        return ' \u2580\u2580 \u2580\u2580';

      case 'executing':
        return ' \u2588\u2588 \u2588\u2588';

      case 'happy': {
        const h = Math.floor(this.frame / 3) % 2;
        return [
          ' \u2726\u2727 \u2727\u2726',
          ' \u2727\u2726 \u2726\u2727',
        ][h];
      }

      case 'error': {
        // Occasional glitch
        if (Math.random() < 0.12) {
          const g = ['\u2593\u2591', '\u2591\u2592', '\u2592\u2593', '\u2588\u2591'];
          const i = Math.floor(Math.random() * g.length);
          const j = (i + 2) % g.length;
          return ` ${g[i]} ${g[j]}`;
        }
        return ' \u2572\u2571 \u2572\u2571';
      }

      case 'sleeping': {
        // Closed lines with occasional flutter
        if (this.frame % 150 > 145) return ' \u2584\u2584 \u2584\u2584';
        return ' \u2500\u2500 \u2500\u2500';
      }

      case 'waiting': {
        // Half-lidded, drifting
        const drift = Math.floor(this.frame / 40) % 3;
        if (drift === 1) return ' \u2584\u2588 \u2584\u2588';
        return ' \u2584\u2584 \u2584\u2584';
      }

      case 'testing': {
        // Intense stare with nervous twitch
        if (this.frame % 25 < 2) return ' \u2580\u2588 \u2588\u2580';
        return ' \u2588\u2588 \u2588\u2588';
      }

      case 'installing':
        // Looking down
        return ' \u2584\u2584 \u2584\u2584';

      case 'caffeinated': {
        // Vibrating
        const j = this.frame % 3;
        if (j === 1) return '  \u2588\u2588\u2588 ';
        if (j === 2) return ' \u2588 \u2588 \u2588';
        return ' \u2588\u2588 \u2588\u2588';
      }

      case 'subagent':
        return ' \u2588\u2588 \u2588\u2588';

      default:
        return ' \u2588\u2588 \u2588\u2588';
    }
  }

  getMouth() {
    switch (this.state) {
      case 'idle':      return '\u25e1\u25e1\u25e1';
      case 'thinking':  return '\u2500\u2500\u2500';
      case 'reading':   return '\u2500\u2500\u2500';
      case 'searching': return ' \u25cb ';
      case 'coding':    return '\u2550\u2550\u2550';
      case 'executing': return ' \u25e1\u25e1';
      case 'happy':     return '\u25e1\u25e1\u25e1';
      case 'error':
        if (Math.random() < 0.08) {
          return ['\u25e1\u25e0\u25e1', '\u25e0\u25e1\u25e0', '\u2500\u25e1\u2500'][Math.floor(Math.random() * 3)];
        }
        return '\u25e0\u25e0\u25e0';
      case 'sleeping':    return '\uff5e\uff5e\uff5e';
      case 'waiting':     return '\u2500\u2500\u2500';
      case 'testing':     return '\u2550\u2550\u2550';
      case 'installing':  return '\u00b7\u00b7\u00b7';
      case 'caffeinated': return '\u25aa\u25e1\u25aa';
      case 'subagent':    return ' \u25e1\u25e1';
      default:          return '\u25e1\u25e1\u25e1';
    }
  }

  // Render this face at an absolute terminal position.
  // Returns an ANSI string buffer.
  render(startRow, startCol, globalTime) {
    const theme = themes[this.state] || themes.idle;
    const breathSpeed = this.state === 'sleeping' ? 0.5
      : this.state === 'caffeinated' ? 2.5 : 1;
    const bc = breathe(theme.border, (globalTime + this.firstSeen % 2000) * breathSpeed); // offset so they don't all pulse together
    const fc = ansi.fg(...bc);
    const ec = ansi.fg(...theme.eye);
    const mc = ansi.fg(...theme.mouth);
    const lc = ansi.fg(...theme.label);
    const dc = ansi.fg(...dimColor(theme.label, 0.55));
    const r = ansi.reset;

    const eyeStr = this.getEyes();
    const mouthStr = this.getMouth();
    const mPad = Math.floor((BOX_INNER - mouthStr.length) / 2);
    const mRight = BOX_INNER - mPad - mouthStr.length;

    let buf = '';

    // ╭──────╮
    buf += ansi.to(startRow, startCol);
    buf += `${fc}\u256d${'\u2500'.repeat(BOX_INNER)}\u256e${r}`;

    // │ ██ ██│
    buf += ansi.to(startRow + 1, startCol);
    buf += `${fc}\u2502${ec}${eyeStr}${fc}\u2502${r}`;

    // │ ◡◡◡  │
    buf += ansi.to(startRow + 2, startCol);
    buf += `${fc}\u2502${' '.repeat(mPad)}${mc}${mouthStr}${r}${' '.repeat(Math.max(0, mRight))}${fc}\u2502${r}`;

    // ╰──────╯
    buf += ansi.to(startRow + 3, startCol);
    buf += `${fc}\u2570${'\u2500'.repeat(BOX_INNER)}\u256f${r}`;

    // Label (centered under the box)
    const lbl = (this.label || '?').slice(0, BOX_W);
    const lPad = Math.max(0, Math.floor((BOX_W - lbl.length) / 2));
    buf += ansi.to(startRow + 4, startCol);
    buf += `${lc}${' '.repeat(lPad)}${lbl}${r}`;

    // State text
    const st = (theme.status || '').slice(0, BOX_W);
    const sPad = Math.max(0, Math.floor((BOX_W - st.length) / 2));
    buf += ansi.to(startRow + 5, startCol);
    buf += `${ansi.dim}${dc}${' '.repeat(sPad)}${st}${r}`;

    return buf;
  }
}

// -- FaceGrid ------------------------------------------------------
// Manages all sessions: reading state files, assigning labels,
// laying out the grid, and compositing the final frame.

class FaceGrid {
  constructor() {
    this.faces = new Map(); // sessionId -> MiniFace
    this.frame = 0;
    this.time = 0;
  }

  // Scan the sessions directory and sync our face map
  loadSessions() {
    let files;
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    } catch {
      return; // dir doesn't exist yet
    }

    const seenIds = new Set();

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8').trim();
        if (!raw) continue;
        const data = JSON.parse(raw);
        const id = data.session_id || path.basename(file, '.json');
        seenIds.add(id);

        if (!this.faces.has(id)) {
          this.faces.set(id, new MiniFace(id));
        }
        this.faces.get(id).updateFromFile(data);
      } catch {
        continue;
      }
    }

    // Remove faces whose files are gone or that are stale
    for (const [id, face] of this.faces) {
      if (!seenIds.has(id) || face.isStale()) {
        this.faces.delete(id);
        // Clean up the file too
        try {
          const fp = path.join(SESSIONS_DIR, safeFilename(id) + '.json');
          if (face.isStale() && fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch {}
      }
    }

    this.assignLabels();
  }

  // Give each face a short, meaningful label
  assignLabels() {
    const sorted = [...this.faces.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    if (sorted.length === 0) return;

    // Count how many sessions share each cwd basename
    const cwdCounts = {};
    for (const face of sorted) {
      const base = face.cwd ? path.basename(face.cwd) : '';
      cwdCounts[base] = (cwdCounts[base] || 0) + 1;
    }

    // Assign labels
    const cwdIndex = {};
    for (let i = 0; i < sorted.length; i++) {
      const face = sorted[i];
      const base = face.cwd ? path.basename(face.cwd) : '';

      if (sorted.length === 1) {
        // Solo session: use cwd or "claude"
        face.label = base ? base.slice(0, 8) : 'claude';
      } else if (base && cwdCounts[base] === 1) {
        // Unique cwd: use the basename
        face.label = base.slice(0, 8);
      } else {
        // Multiple sessions share cwd (main + subagents), or no cwd
        cwdIndex[base] = (cwdIndex[base] || 0) + 1;
        if (cwdIndex[base] === 1) {
          face.label = i === 0 ? 'main' : (base || 'sub').slice(0, 6) + '-' + cwdIndex[base];
        } else {
          face.label = 'sub-' + (cwdIndex[base] - 1);
        }
      }
    }
  }

  update(dt) {
    this.time += dt;
    this.frame++;
    for (const face of this.faces.values()) {
      face.tick(dt);
    }
  }

  render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const faces = [...this.faces.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    const n = faces.length;

    // -- Empty state: centered waiting message --
    if (n === 0) {
      const lines = [
        '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u256e',
        '\u2502 \u00b7\u00b7 \u00b7\u00b7\u2502',
        '\u2502 \u25e1\u25e1\u25e1  \u2502',
        '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f',
        '',
        'waiting for claude...',
      ];
      const maxLen = Math.max(...lines.map(l => l.length));
      const baseRow = Math.max(1, Math.floor((rows - lines.length) / 2));
      const baseCol = Math.max(1, Math.floor((cols - maxLen) / 2));
      let buf = '';
      const c = ansi.fg(80, 120, 160);
      for (let i = 0; i < lines.length; i++) {
        const pad = Math.max(0, Math.floor((maxLen - lines[i].length) / 2));
        buf += ansi.to(baseRow + i, baseCol + pad);
        buf += `${ansi.dim}${c}${lines[i]}${ansi.reset}`;
      }
      return buf;
    }

    // -- Calculate grid layout --
    const maxPerRow = Math.max(1, Math.floor(cols / CELL_W));
    const gridCols = Math.min(n, maxPerRow);
    const gridRows = Math.ceil(n / gridCols);
    const gridW = gridCols * CELL_W;
    const gridH = gridRows * CELL_H;
    const baseCol = Math.max(1, Math.floor((cols - gridW) / 2));
    const baseRow = Math.max(1, Math.floor((rows - gridH) / 2));

    let buf = '';

    for (let i = 0; i < n; i++) {
      const gridRow = Math.floor(i / gridCols);
      const gridCol = i % gridCols;

      // Center incomplete last row
      const facesInRow = (gridRow < gridRows - 1)
        ? gridCols
        : (n % gridCols || gridCols);
      const rowOffset = Math.floor((gridCols - facesInRow) * CELL_W / 2);

      const faceRow = baseRow + gridRow * CELL_H;
      const faceCol = baseCol + rowOffset + gridCol * CELL_W;

      buf += faces[i].render(faceRow, faceCol, this.time);
    }

    // Session count in top-right corner
    const countText = `${n} session${n === 1 ? '' : 's'}`;
    buf += ansi.to(1, cols - countText.length - 1);
    buf += `${ansi.dim}${ansi.fg(80, 110, 140)}${countText}${ansi.reset}`;

    return buf;
  }
}

// -- Helpers -------------------------------------------------------

function safeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// -- PID guard (separate from single-face renderer) ----------------
const PID_FILE = path.join(HOME, '.claude-face-grid.pid');

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

// -- Main ----------------------------------------------------------

function main() {
  if (isAlreadyRunning()) {
    console.log('Claude Face Grid is already running in another window.');
    process.exit(0);
  }
  writePid();

  // Ensure sessions dir exists
  try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

  const grid = new FaceGrid();

  // Cleanup
  function cleanup() {
    removePid();
    process.stdout.write(ansi.show + ansi.clear + ansi.reset);
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  try { process.on('SIGHUP', cleanup); } catch {}
  process.on('exit', removePid);

  // Hide cursor, clear screen
  process.stdout.write(ansi.hide + ansi.clear);
  process.stdout.write(`\x1b]0;Claude Face Grid\x07`);

  // Watch sessions directory for immediate updates
  try {
    fs.watch(SESSIONS_DIR, () => { grid.loadSessions(); });
  } catch {
    // Fallback: just poll
  }

  // Initial load
  grid.loadSessions();

  // Main render loop
  let lastTime = Date.now();
  function loop() {
    const now = Date.now();
    const dt = now - lastTime;
    lastTime = now;

    grid.update(dt);

    // Reload sessions every ~2 seconds as backup to fs.watch
    if (grid.frame % (FPS * 2) === 0) {
      grid.loadSessions();
    }

    const buf = grid.render();
    process.stdout.write(ansi.home + buf);

    setTimeout(loop, FRAME_MS);
  }

  loop();

  // Handle terminal resize
  process.stdout.on('resize', () => {
    process.stdout.write(ansi.clear);
  });
}

main();
