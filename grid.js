'use strict';

// +================================================================+
// |  Orbital mode -- MiniFace and OrbitalSystem classes              |
// |  MiniFace renders compact subagent faces                        |
// |  OrbitalSystem orbits them around the main ClaudeFace           |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { SESSIONS_DIR, safeFilename } = require('./shared');
const { ansi, breathe, dimColor, themes, COMPLETION_LINGER, PALETTES, PALETTE_NAMES } = require('./themes');
const { gridMouths } = require('./animations');

// -- Config --------------------------------------------------------
const CELL_W = 12;
const CELL_H = 7;
const BOX_W = 8;
const BOX_INNER = 6;
const STALE_MS = 120000;
const STOPPED_LINGER_MS = 15000;
const MIN_COLS_GRID = 14;
const MIN_ROWS_GRID = 9;
const IDLE_TIMEOUT = 8000;
const SLEEP_TIMEOUT = 60000;

// -- MiniFace (compact, for grid) ----------------------------------
class MiniFace {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.state = 'idle';
    this.detail = '';
    this.label = '';
    this.cwd = '';
    this.modelName = '';
    this.lastUpdate = Date.now();
    this.firstSeen = Date.now();
    this.stopped = false;
    this.stoppedAt = 0;
    this.frame = 0;
    this.time = 0;
    this.blinkTimer = 2500 + Math.random() * 3500;
    this.blinkFrame = -1;
    this.lookDir = 0;
    this.lookTimer = 0;
    this.parentSession = null; // set if this is a synthetic subagent
  }

  updateFromFile(data) {
    const newState = data.state || 'idle';
    if (newState !== this.state) this.state = newState;
    this.detail = data.detail || '';
    this.lastUpdate = data.timestamp || Date.now();
    if (data.cwd) this.cwd = data.cwd;
    if (data.modelName) this.modelName = data.modelName;
    if (data.parentSession) this.parentSession = data.parentSession;
    if (data.stopped && !this.stopped) {
      this.stopped = true;
      this.stoppedAt = Date.now();
    }
  }

  isStale() {
    if (this.stopped) return Date.now() - this.stoppedAt > STOPPED_LINGER_MS;
    return Date.now() - this.lastUpdate > STALE_MS;
  }

  tick(dt) {
    this.time += dt;
    this.frame++;

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkFrame = 0;
      this.blinkTimer = 2500 + Math.random() * 3500;
    }
    if (this.blinkFrame >= 0) {
      this.blinkFrame++;
      if (this.blinkFrame >= 3) this.blinkFrame = -1;
    }

    if (this.state === 'searching') {
      this.lookTimer += dt;
      if (this.lookTimer > 600) {
        this.lookDir = [-1, 0, 1, 0][Math.floor(Math.random() * 4)];
        this.lookTimer = 0;
      }
    }

    const elapsed = Date.now() - this.lastUpdate;
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    const completionLinger = COMPLETION_LINGER[this.state];
    if (completionLinger && elapsed > completionLinger) {
      this.state = 'idle';
    } else if (!completionStates.includes(this.state) &&
               this.state !== 'idle' && this.state !== 'sleeping' &&
               this.state !== 'waiting' && elapsed > IDLE_TIMEOUT) {
      this.state = 'idle';
    }
    if (this.state === 'idle' && elapsed > SLEEP_TIMEOUT) {
      this.state = 'sleeping';
    }
  }

  getEyes() {
    if (this.blinkFrame >= 0) return ' \u2584\u2584 \u2584\u2584';

    switch (this.state) {
      case 'idle':        return ' \u2588\u2588 \u2588\u2588';
      case 'thinking': {
        const p = Math.floor(this.frame / 4) % 4;
        return [' \u25cf\u00b7 \u00b7\u25cf', ' \u00b7\u25cf \u25cf\u00b7', ' \u25cf\u00b7 \u25cf\u00b7', ' \u00b7\u25cf \u00b7\u25cf'][p];
      }
      case 'responding': {
        const r = Math.floor(this.frame / 30) % 2;
        return r ? ' \u2584\u2584 \u2588 ' : ' \u2584\u2584 \u2588\u2588';
      }
      case 'reading':     return ' \u2500\u2500 \u2500\u2500';
      case 'searching':
        if (this.lookDir < 0) return ' \u2588\u2588 \u2588\u00b7';
        if (this.lookDir > 0) return ' \u00b7\u2588 \u2588\u2588';
        return ' \u2588\u2588 \u2588\u2588';
      case 'coding':      return ' \u2580\u2580 \u2580\u2580';
      case 'executing':   return ' \u2588\u2588 \u2588\u2588';
      case 'happy': {
        const h = Math.floor(this.frame / 3) % 2;
        return [' \u2726\u2727 \u2727\u2726', ' \u2727\u2726 \u2726\u2727'][h];
      }
      case 'error': {
        if (Math.random() < 0.12) {
          const g = ['\u2593\u2591', '\u2591\u2592', '\u2592\u2593', '\u2588\u2591'];
          const i = Math.floor(Math.random() * g.length);
          const j = (i + 2) % g.length;
          return ` ${g[i]} ${g[j]}`;
        }
        return ' \u2572\u2571 \u2572\u2571';
      }
      case 'sleeping': {
        if (this.frame % 150 > 145) return ' \u2584\u2584 \u2584\u2584';
        return ' \u2500\u2500 \u2500\u2500';
      }
      case 'waiting': {
        const drift = Math.floor(this.frame / 40) % 3;
        if (drift === 1) return ' \u2584\u2588 \u2584\u2588';
        return ' \u2584\u2584 \u2584\u2584';
      }
      case 'testing': {
        if (this.frame % 25 < 2) return ' \u2580\u2588 \u2588\u2580';
        return ' \u2588\u2588 \u2588\u2588';
      }
      case 'installing':  return ' \u2584\u2584 \u2584\u2584';
      case 'caffeinated': {
        const j = this.frame % 3;
        if (j === 1) return '  \u2588\u2588\u2588 ';
        if (j === 2) return ' \u2588 \u2588 \u2588';
        return ' \u2588\u2588 \u2588\u2588';
      }
      case 'subagent':    return ' \u2588\u2588 \u2588\u2588';
      case 'satisfied':   return ' \u2580\u2580 \u2580\u2580';
      case 'proud':       return ' \u2584\u2584 \u2584\u2584';
      case 'relieved':    return ' \u2588\u2588 \u2588\u2588';
      default:            return ' \u2588\u2588 \u2588\u2588';
    }
  }

  getMouth() {
    if (this.state === 'error' && Math.random() < 0.08) {
      return ['\u25e1\u25e0\u25e1', '\u25e0\u25e1\u25e0', '\u2500\u25e1\u2500'][Math.floor(Math.random() * 3)];
    }
    return gridMouths[this.state] || '\u25e1\u25e1\u25e1';
  }

  render(startRow, startCol, globalTime, paletteThemes) {
    const themeMap = paletteThemes || themes;
    const theme = themeMap[this.state] || themeMap.idle;
    const breathSpeed = this.state === 'sleeping' ? 0.5
      : this.state === 'caffeinated' ? 2.5 : 1;
    const bc = breathe(theme.border, (globalTime + this.firstSeen % 2000) * breathSpeed);
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

    buf += ansi.to(startRow, startCol);
    buf += `${fc}\u256d${'\u2500'.repeat(BOX_INNER)}\u256e${r}`;

    buf += ansi.to(startRow + 1, startCol);
    buf += `${fc}\u2502${ec}${eyeStr}${fc}\u2502${r}`;

    buf += ansi.to(startRow + 2, startCol);
    buf += `${fc}\u2502${' '.repeat(mPad)}${mc}${mouthStr}${r}${' '.repeat(Math.max(0, mRight))}${fc}\u2502${r}`;

    buf += ansi.to(startRow + 3, startCol);
    buf += `${fc}\u2570${'\u2500'.repeat(BOX_INNER)}\u256f${r}`;

    const lbl = (this.label || '?').slice(0, BOX_W);
    const lPad = Math.max(0, Math.floor((BOX_W - lbl.length) / 2));
    buf += ansi.to(startRow + 4, startCol);
    buf += `${lc}${' '.repeat(lPad)}${lbl}${r}`;

    const st = (theme.status || '').slice(0, BOX_W);
    const sPad = Math.max(0, Math.floor((BOX_W - st.length) / 2));
    buf += ansi.to(startRow + 5, startCol);
    buf += `${ansi.dim}${dc}${' '.repeat(sPad)}${st}${r}`;

    return buf;
  }
}

// -- OrbitalSystem -------------------------------------------------
// Orbits subagent MiniFaces around the main ClaudeFace
const MINI_W = BOX_W;       // 8 cols visible width of mini face
const MINI_H = CELL_H;      // 7 rows (box + label + status)
const MAX_ORBITALS = 8;      // Beyond this, labels become unreadable
const MIN_ORBITAL_COLS = 80;
const MIN_ORBITAL_ROWS = 30;

class OrbitalSystem {
  constructor() {
    this.faces = new Map();        // sessionId → MiniFace
    this.rotationAngle = 0;        // Current global rotation (radians)
    this.rotationSpeed = 0.007;    // ~1 full rotation per 60s at 15fps
    this.frame = 0;
    this.time = 0;
    this.prevCount = 0;            // Track face count changes for clear
    this.paletteIndex = 0;         // Synced from main face
  }

  loadSessions(excludeId) {
    let files;
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    } catch {
      return;
    }

    const seenIds = new Set();

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf8').trim();
        if (!raw) continue;
        const data = JSON.parse(raw);
        const id = data.session_id || path.basename(file, '.json');

        // Skip the main session — it's the big face, not an orbital
        if (excludeId && id === excludeId) continue;

        seenIds.add(id);

        if (!this.faces.has(id)) {
          this.faces.set(id, new MiniFace(id));
        }
        this.faces.get(id).updateFromFile(data);
      } catch {
        continue;
      }
    }

    for (const [id, face] of this.faces) {
      if (!seenIds.has(id) || face.isStale()) {
        this.faces.delete(id);
        try {
          const fp = path.join(SESSIONS_DIR, safeFilename(id) + '.json');
          if (face.isStale() && fs.existsSync(fp)) fs.unlinkSync(fp);
        } catch {}
      }
    }

    this._assignLabels();
  }

  _assignLabels() {
    const sorted = [...this.faces.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    if (sorted.length === 0) return;

    const cwdCounts = {};
    for (const face of sorted) {
      const base = face.cwd ? path.basename(face.cwd) : '';
      cwdCounts[base] = (cwdCounts[base] || 0) + 1;
    }

    const cwdIndex = {};
    for (let i = 0; i < sorted.length; i++) {
      const face = sorted[i];
      const base = face.cwd ? path.basename(face.cwd) : '';

      if (sorted.length === 1) {
        face.label = base ? base.slice(0, 8) : (face.modelName || 'sub').slice(0, 8);
      } else if (base && cwdCounts[base] === 1) {
        face.label = base.slice(0, 8);
      } else {
        cwdIndex[base] = (cwdIndex[base] || 0) + 1;
        face.label = 'sub-' + (i + 1);
      }
    }
  }

  calculateOrbit(cols, rows, mainPos) {
    // Minimum ellipse semi-axes: must clear the main face box + decorations
    // Vertical: face box + accessories/thought bubble above (~5 rows) + stats below (~4 rows)
    const minA = Math.floor(mainPos.w / 2) + Math.floor(MINI_W / 2) + 3;
    const minB = Math.floor(mainPos.h / 2) + Math.floor(MINI_H / 2) + 6;

    // Maximum: constrained by terminal edges from main face center
    const maxA = Math.min(
      mainPos.centerX - Math.floor(MINI_W / 2) - 1,
      cols - mainPos.centerX - Math.floor(MINI_W / 2)
    );
    const maxB = Math.min(
      mainPos.centerY - Math.floor(MINI_H / 2) - 1,
      rows - mainPos.centerY - Math.floor(MINI_H / 2) - 1
    );

    // Terminal too small for orbitals (math-based check only)
    if (maxA < minA || maxB < minB) {
      return { a: 0, b: 0, maxSlots: 0 };
    }

    // Use the larger available space, clamped to minimums
    const a = Math.min(maxA, Math.max(minA, Math.floor(cols * 0.35)));
    const b = Math.min(maxB, Math.max(minB, Math.floor(rows * 0.3)));

    // Max faces that fit without overlapping: approximate by angular spacing
    // Each face needs ~MINI_W cols of clearance at the widest point of the ellipse
    const circumference = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
    const maxSlots = Math.min(MAX_ORBITALS, Math.max(1, Math.floor(circumference / (MINI_W + 2))));

    return { a, b, maxSlots };
  }

  _renderConnections(mainPos, positions, accentColor) {
    let out = '';
    const r = ansi.reset;

    for (const pos of positions) {
      // Only draw connection lines to actual subagents, not independent sessions
      if (pos.face && !pos.face.parentSession) continue;

      const dx = pos.col - mainPos.centerX;
      const dy = pos.row - mainPos.centerY;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));
      if (steps < 4) continue;

      // Skip points inside main face box or inside orbital box
      const mainLeft = mainPos.col;
      const mainRight = mainPos.col + mainPos.w;
      const mainTop = mainPos.row;
      const mainBot = mainPos.row + mainPos.h;

      for (let s = 1; s < steps - 1; s++) {
        const t = s / steps;
        const col = Math.round(mainPos.centerX + dx * t);
        const row = Math.round(mainPos.centerY + dy * t);

        // Skip if inside main face area (extended for thought bubbles,
        // accessories above, and status/indicators below)
        if (col >= mainLeft - 2 && col <= mainRight + 16 &&
            row >= mainTop - 5 && row <= mainBot + 4) continue;

        // Skip if inside orbital box
        if (col >= pos.col - 1 && col <= pos.col + MINI_W + 1 &&
            row >= pos.row - 1 && row <= pos.row + MINI_H) continue;

        // Skip if out of bounds
        if (row < 1 || row >= (process.stdout.rows || 24) || col < 1 || col >= (process.stdout.columns || 80)) continue;

        // Pulse: brighter dots traveling outward (~3s cycle)
        const pulsePos = (this.time * 0.0004) % 1;
        const dist = Math.abs(t - pulsePos);
        const bright = dist < 0.08 || Math.abs(t - ((pulsePos + 0.5) % 1)) < 0.08;

        const color = bright
          ? ansi.fg(...dimColor(accentColor, 0.7))
          : ansi.fg(...dimColor(accentColor, 0.2));
        out += `\x1b[${row};${col}H${color}\u00b7${r}`;
      }
    }
    return out;
  }

  update(dt) {
    this.time += dt;
    this.frame++;
    this.rotationAngle += this.rotationSpeed;
    if (this.rotationAngle > Math.PI * 2) this.rotationAngle -= Math.PI * 2;
    for (const face of this.faces.values()) {
      face.tick(dt);
    }
  }

  _renderSidePanel(cols, rows, mainPos, paletteThemes) {
    const sorted = [...this.faces.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    if (sorted.length === 0) return '';

    const SIDE_PAD = 2;
    const SIDE_PAD_RIGHT = 16; // Extra clearance for thought bubbles extending right
    const leftCol = mainPos.col - MINI_W - SIDE_PAD;
    const rightCol = mainPos.col + mainPos.w + SIDE_PAD_RIGHT;
    const canLeft = leftCol >= 1;
    const canRight = rightCol + MINI_W <= cols;

    if (!canLeft && !canRight) {
      // Truly no space — show text indicator
      const n = sorted.length;
      const text = `+${n} subagent${n === 1 ? '' : 's'}`;
      const textCol = Math.max(1, mainPos.centerX - Math.floor(text.length / 2));
      const textRow = Math.min(rows - 1, mainPos.row + mainPos.h + 3);
      const dc = `${ansi.dim}${ansi.fg(...dimColor([140, 170, 200], 0.5))}`;
      return `${ansi.to(textRow, textCol)}${dc}${text}${ansi.reset}`;
    }

    // How many fit vertically per side?
    const maxPerSide = Math.max(1, Math.floor((rows - 1) / MINI_H));

    // Distribute faces: alternate left/right for visual balance
    const leftFaces = [];
    const rightFaces = [];
    for (const face of sorted) {
      if (canLeft && leftFaces.length < maxPerSide &&
          (!canRight || leftFaces.length <= rightFaces.length)) {
        leftFaces.push(face);
      } else if (canRight && rightFaces.length < maxPerSide) {
        rightFaces.push(face);
      } else if (canLeft && leftFaces.length < maxPerSide) {
        leftFaces.push(face);
      } else {
        break; // No more room
      }
    }

    const visibleCount = leftFaces.length + rightFaces.length;
    const overflow = sorted.length - visibleCount;
    let buf = '';

    // Render a vertical stack of faces centered on the main face
    const renderStack = (faces, col) => {
      if (faces.length === 0) return;
      const totalH = faces.length * MINI_H;
      let startRow = Math.max(1, Math.round(mainPos.centerY - totalH / 2));
      startRow = Math.min(startRow, Math.max(1, rows - totalH));
      for (let i = 0; i < faces.length; i++) {
        buf += faces[i].render(startRow + i * MINI_H, col, this.time, paletteThemes);
      }
    };

    renderStack(leftFaces, leftCol);
    renderStack(rightFaces, rightCol);

    if (overflow > 0) {
      const text = `+${overflow} more`;
      const textCol = Math.max(1, mainPos.centerX - Math.floor(text.length / 2));
      const textRow = Math.min(rows - 1, mainPos.row + mainPos.h + 3);
      const dc = `${ansi.dim}${ansi.fg(...dimColor([140, 170, 200], 0.5))}`;
      buf += `${ansi.to(textRow, textCol)}${dc}${text}${ansi.reset}`;
    }

    return buf;
  }

  render(cols, rows, mainPos, paletteThemes) {
    if (this.faces.size === 0) return '';

    const { a, b, maxSlots } = this.calculateOrbit(cols, rows, mainPos);

    // Terminal too small for orbits — use side panel layout
    if (maxSlots === 0) {
      return this._renderSidePanel(cols, rows, mainPos, paletteThemes);
    }

    const sorted = [...this.faces.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    const visible = sorted.slice(0, maxSlots);
    const overflow = sorted.length - visible.length;
    const n = visible.length;

    // Calculate orbital positions
    const positions = [];
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i / n) + this.rotationAngle;
      const col = Math.round(mainPos.centerX + Math.cos(angle) * a - MINI_W / 2);
      // Shift orbit center down by 2 rows to account for thought bubbles/accessories above
      const row = Math.round((mainPos.centerY + 2) + Math.sin(angle) * b - MINI_H / 2);

      // Clamp to terminal bounds
      let clampedCol = Math.max(1, Math.min(cols - MINI_W, col));
      let clampedRow = Math.max(1, Math.min(rows - MINI_H, row));

      // Nudge away from thought bubble if overlapping
      if (mainPos.bubble) {
        const bub = mainPos.bubble;
        const pad = 1;
        if (clampedCol < bub.col + bub.w + pad && clampedCol + MINI_W > bub.col - pad &&
            clampedRow < bub.row + bub.h + pad && clampedRow + MINI_H > bub.row - pad) {
          const nCol = Math.round(mainPos.centerX + Math.cos(angle) * (a + 6) - MINI_W / 2);
          const nRow = Math.round((mainPos.centerY + 2) + Math.sin(angle) * (b + 4) - MINI_H / 2);
          clampedCol = Math.max(1, Math.min(cols - MINI_W, nCol));
          clampedRow = Math.max(1, Math.min(rows - MINI_H, nRow));
        }
      }

      positions.push({ col: clampedCol, row: clampedRow, face: visible[i] });
    }

    let buf = '';

    // Full clear when face count changes
    if (n !== this.prevCount) {
      this.prevCount = n;
    }

    // Get accent color for connections from the theme
    const themeMap = paletteThemes || themes;
    const accentColor = (themeMap.subagent || themeMap.idle).accent || [100, 160, 210];

    // Render connection lines
    buf += this._renderConnections(mainPos, positions, accentColor);

    // Render each mini-face at its orbital position
    for (let i = 0; i < n; i++) {
      buf += visible[i].render(
        positions[i].row, positions[i].col,
        this.time, paletteThemes
      );
    }

    // Overflow indicator
    if (overflow > 0) {
      const text = `+${overflow} more`;
      const textCol = Math.max(1, mainPos.centerX - Math.floor(text.length / 2));
      const textRow = Math.min(rows - 2, mainPos.row + mainPos.h + 3);
      const dc = `${ansi.dim}${ansi.fg(...dimColor([140, 170, 200], 0.5))}`;
      buf += `${ansi.to(textRow, textCol)}${dc}${text}${ansi.reset}`;
    }

    return buf;
  }
}

module.exports = { MiniFace, OrbitalSystem };
