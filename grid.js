'use strict';

// +================================================================+
// |  Grid mode -- MiniFace and FaceGrid classes                     |
// |  Renders multiple concurrent Claude sessions in a grid layout   |
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
const STOPPED_LINGER_MS = 5000;
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
  }

  updateFromFile(data) {
    const newState = data.state || 'idle';
    if (newState !== this.state) this.state = newState;
    this.detail = data.detail || '';
    this.lastUpdate = data.timestamp || Date.now();
    if (data.cwd) this.cwd = data.cwd;
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

// -- FaceGrid ------------------------------------------------------
class FaceGrid {
  constructor() {
    this.faces = new Map();
    this.frame = 0;
    this.time = 0;
    this.prevFaceCount = 0;

    // Interactive keypresses
    this.paletteIndex = 0;
    this.showHelp = false;
  }

  cycleTheme() {
    this.paletteIndex = (this.paletteIndex + 1) % PALETTES.length;
  }

  toggleHelp() {
    this.showHelp = !this.showHelp;
  }

  loadSessions() {
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

    this.assignLabels();
  }

  assignLabels() {
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
        face.label = base ? base.slice(0, 8) : 'claude';
      } else if (base && cwdCounts[base] === 1) {
        face.label = base.slice(0, 8);
      } else {
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

    // Terminal too small -- show compact fallback
    if (cols < MIN_COLS_GRID || rows < MIN_ROWS_GRID) {
      let buf = '';
      for (let row = 1; row <= rows; row++) {
        buf += ansi.to(row, 1) + ansi.clearLine;
      }
      const msg = '\u00b7_\u00b7';
      const msgCol = Math.max(1, Math.floor((cols - msg.length) / 2));
      const msgRow = Math.max(1, Math.floor(rows / 2));
      buf += ansi.to(msgRow, msgCol);
      buf += `${ansi.dim}${ansi.fg(80, 120, 160)}${msg}${ansi.reset}`;
      return buf;
    }

    const faces = [...this.faces.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    const n = faces.length;

    let buf = '';

    // Full clear when face count changes (handles removed faces cleanly)
    if (n !== this.prevFaceCount) {
      buf += ansi.clear;
      this.prevFaceCount = n;
    }

    // Empty state
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
      const c = ansi.fg(80, 120, 160);
      for (let i = 0; i < lines.length; i++) {
        const pad = Math.max(0, Math.floor((maxLen - lines[i].length) / 2));
        buf += ansi.to(baseRow + i, baseCol + pad);
        buf += `${ansi.dim}${c}${lines[i]}${ansi.reset}`;
      }
      return buf;
    }

    // Grid layout
    const maxPerRow = Math.max(1, Math.floor(cols / CELL_W));
    const gridCols = Math.min(n, maxPerRow);
    const gridRows = Math.ceil(n / gridCols);
    const gridW = gridCols * CELL_W;
    const gridH = gridRows * CELL_H;
    const baseCol = Math.max(1, Math.floor((cols - gridW) / 2));
    const baseRow = Math.max(1, Math.floor((rows - gridH) / 2));

    // Clear the grid area + margins to prevent ghost labels/status
    const clearTop = Math.max(1, baseRow - 1);
    const clearBot = Math.min(rows, baseRow + gridH + 1);
    for (let row = clearTop; row <= clearBot; row++) {
      buf += ansi.to(row, 1) + ansi.clearLine;
    }
    // Also clear the counter row
    buf += ansi.to(1, 1) + ansi.clearLine;

    for (let i = 0; i < n; i++) {
      const gridRow = Math.floor(i / gridCols);
      const gridCol = i % gridCols;

      const facesInRow = (gridRow < gridRows - 1)
        ? gridCols
        : (n % gridCols || gridCols);
      const rowOffset = Math.floor((gridCols - facesInRow) * CELL_W / 2);

      const faceRow = baseRow + gridRow * CELL_H;
      const faceCol = baseCol + rowOffset + gridCol * CELL_W;

      const paletteThemes = (PALETTES[this.paletteIndex] || PALETTES[0]).themes;
      buf += faces[i].render(faceRow, faceCol, this.time, paletteThemes);
    }

    // Session count + palette name
    const pName = this.paletteIndex > 0 ? ` [${PALETTE_NAMES[this.paletteIndex]}]` : '';
    const countText = `${n} session${n === 1 ? '' : 's'}${pName}`;
    buf += ansi.to(1, cols - countText.length - 1);
    buf += `${ansi.dim}${ansi.fg(80, 110, 140)}${countText}${ansi.reset}`;

    // Key hints bar (bottom of terminal)
    {
      const dc = `${ansi.dim}${ansi.fg(80, 110, 140)}`;
      const kc = ansi.fg(100, 140, 180);
      const sep = `${dc}\u00b7${ansi.reset}`;
      const r = ansi.reset;
      const hint = `${kc}t${dc} theme ${sep} ${kc}h${dc} help ${sep} ${kc}q${dc} quit${r}`;
      const visible = hint.replace(/\x1b\[[^m]*m/g, '');
      const hintCol = Math.max(1, Math.floor((cols - visible.length) / 2) + 1);
      buf += ansi.to(rows, hintCol) + hint;
    }

    // Help overlay
    if (this.showHelp) {
      const lines = [
        ' Keybindings ',
        '',
        ' t      cycle palette',
        ' h/?    this help',
        ' q      quit',
      ];
      const boxW = 24;
      const boxH = lines.length + 2;
      const bx = Math.max(1, Math.floor((cols - boxW) / 2));
      const by = Math.max(1, Math.floor((rows - boxH) / 2));
      const bc = ansi.fg(80, 110, 140);
      const tc = ansi.fg(140, 170, 200);
      const r = ansi.reset;
      buf += ansi.to(by, bx) + `${bc}\u256d${'\u2500'.repeat(boxW)}\u256e${r}`;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const pad = boxW - line.length;
        buf += ansi.to(by + 1 + i, bx) + `${bc}\u2502${tc}${line}${' '.repeat(Math.max(0, pad))}${bc}\u2502${r}`;
      }
      buf += ansi.to(by + 1 + lines.length, bx) + `${bc}\u2570${'\u2500'.repeat(boxW)}\u256f${r}`;
    }

    return buf;
  }
}

module.exports = { MiniFace, FaceGrid };
