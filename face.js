'use strict';

// +================================================================+
// |  ClaudeFace -- single face mode renderer class                  |
// |  Manages state, animations, particles, thought bubbles,         |
// |  streaks, timeline, and renders the full-size ASCII face         |
// +================================================================+

const {
  ansi, breathe, dimColor,
  themes, TIMELINE_COLORS, SPARKLINE_BLOCKS,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
  PALETTES, PALETTE_NAMES,
} = require('./themes');
const { eyes, mouths, gridMouths } = require('./animations');
const { ParticleSystem } = require('./particles');
const { getAccessory } = require('./accessories');
const { SESSIONS_DIR, safeFilename } = require('./shared');
const path = require('path');
const fs = require('fs');

// -- Config --------------------------------------------------------
const BLINK_MIN = 2500;
const BLINK_MAX = 6000;
const BLINK_FRAMES = 3;
const CAFFEINE_WINDOW = 10000;
const CAFFEINE_THRESHOLD = 5;
const MIN_COLS_SINGLE = 38;
const MIN_ROWS_SINGLE = 20;
const PET_SPAM_WINDOW = 2000;      // 2s window to detect rapid petting
const PET_SPAM_THRESHOLD = 8;      // pets in window to trigger easter egg
const PET_SPAM_DURATION = 45;      // ~3s at 15fps
const PET_SPAM_AFTERGLOW = 30;     // ~2s at 15fps -- post-pet bliss
const PET_SPAM_ESCALATE_WINDOW = 10000; // 10s to keep escalation level
const PET_SPAM_THOUGHTS = [
  ['!!!!!!', 'so much love!', ':D :D :D', 'best day ever', 'hehehehe'],
  ['AAAAAA', "I'M GONNA EXPLODE", 'TOO MUCH LOVE', 'MAXIMUM PET', 'AAAAAHHHHH'],
  ['ajksdh', '!!!?!?!', '\u2665\u2665\u2665\u2665\u2665', 'hfjkdsl', 'a;slkdfj', '?!?!?!?!'],
];
const PET_AFTERGLOW_THOUGHTS = ['...', 'mmmm', 'purrrr', 'so warm', '\u25e1\u25e1\u25e1'];

// -- Surround mode config --------------------------------------------
const SURROUND_CELL_W = 12;
const SURROUND_CELL_H = 7;
const SURROUND_STALE_MS = 120000;
const SURROUND_STOPPED_LINGER_MS = 5000;
const BOX_W = 8;
const BOX_INNER = 6;

// -- SurroundMiniFace (mini face for surround mode) -----------------
class SurroundMiniFace {
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
  }

  updateFromFile(data) {
    const newState = data.state || 'idle';
    if (newState !== this.state) this.state = newState;
    this.detail = data.detail || '';
    this.lastUpdate = data.timestamp || Date.now();
    if (data.cwd) this.cwd = data.cwd;
    if (data.modelName) this.modelName = data.modelName;
    if (data.stopped && !this.stopped) {
      this.stopped = true;
      this.stoppedAt = Date.now();
    }
  }

  isStale() {
    if (this.stopped) return Date.now() - this.stoppedAt > SURROUND_STOPPED_LINGER_MS;
    return Date.now() - this.lastUpdate > SURROUND_STALE_MS;
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

// -- ClaudeFace ----------------------------------------------------
class ClaudeFace {
  constructor() {
    this.state = 'idle';
    this.prevState = 'idle';
    this.frame = 0;
    this.time = 0;
    this.blinkTimer = this._nextBlink();
    this.blinkFrame = -1;
    this.particles = new ParticleSystem();
    this.lastStateChange = Date.now();
    this.stateDetail = '';
    this.lookDir = 0;
    this.lookTimer = 0;
    this.transitionFrame = 0;
    this.glitchIntensity = 0;
    this.stateChangeTimes = [];
    this.isCaffeinated = false;

    // Minimum display time (prevents rapid state flickering)
    this.minDisplayUntil = 0;
    this.pendingState = null;
    this.pendingDetail = '';

    // Thought bubbles
    this.thoughtText = '';
    this.thoughtTimer = 0;
    this.thoughtIndex = 0;
    this.toolCallCount = 0;
    this.filesEditedCount = 0;
    this.sessionStart = 0;

    // Streaks
    this.streak = 0;
    this.bestStreak = 0;
    this.brokenStreakAt = 0;
    this.lastBrokenStreak = 0;
    this.milestone = null;
    this.milestoneShowTime = 0;

    // Inter-session memory
    this.diffInfo = null;
    this.dailySessions = 0;
    this.dailyCumulativeMs = 0;
    this.frequentFiles = {};

    // Timeline
    this.timeline = [{ state: 'idle', at: Date.now() }];

    // Interactive keypresses
    this.paletteIndex = 0;
    this.showStats = true;
    this.showHelp = false;
    this.petTimer = 0;
    this.petWiggle = 0;
    this.petTimes = [];
    this.petSpamActive = false;
    this.petSpamTimer = 0;
    this.petSpamLevel = 0;
    this.petSpamLastAt = 0;
    this.petAfterglowTimer = 0;

    // Accessories
    this.accessoriesEnabled = true;

    // Model name (shown in status line: "{name} is thinking")
    this.modelName = process.env.CODE_CRUMB_MODEL || 'claude';

    // Surround mode (mini faces on sides)
    this.surroundMode = false;
    this.surroundFaces = new Map();
  }

  _nextBlink() {
    return BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
  }

  _getMinDisplayMs(state) {
    const times = {
      happy: 5000, proud: 4500, satisfied: 4000, relieved: 4500,
      error: 3500, coding: 2500, thinking: 2500, reading: 2000,
      searching: 2000, executing: 2500, testing: 2500, installing: 2500,
      caffeinated: 2500, subagent: 2500, waiting: 1500, sleeping: 1000,
    };
    return times[state] || 1000;
  }

  setState(newState, detail = '') {
    if (newState !== this.state) {
      const now = Date.now();

      // Minimum display time: buffer incoming state if current hasn't shown long enough
      if (now < this.minDisplayUntil) {
        this.pendingState = newState;
        this.pendingDetail = detail;
        return;
      }

      this.prevState = this.state;
      this.state = newState;
      this.transitionFrame = 0;
      this.lastStateChange = now;
      this.stateDetail = detail;
      this.minDisplayUntil = now + this._getMinDisplayMs(newState);
      this.pendingState = null;
      this.pendingDetail = '';

      // Track timeline
      this.timeline.push({ state: newState, at: Date.now() });
      if (this.timeline.length > 200) this.timeline.shift();

      // Fade out old particles quickly on state change
      this.particles.fadeAll();

      this.stateChangeTimes.push(Date.now());
      if (this.stateChangeTimes.length > 20) this.stateChangeTimes.shift();

      if (newState === 'happy') {
        this.particles.spawn(12, 'sparkle');
      } else if (newState === 'proud') {
        this.particles.spawn(6, 'sparkle');
      } else if (newState === 'satisfied') {
        this.particles.spawn(4, 'float');
      } else if (newState === 'relieved') {
        this.particles.spawn(3, 'float');
      } else if (newState === 'error') {
        this.particles.spawn(8, 'glitch');
        this.glitchIntensity = 1.0;
      } else if (newState === 'thinking') {
        this.particles.spawn(6, 'orbit');
      } else if (newState === 'subagent') {
        this.particles.spawn(8, 'echo');
      } else if (newState === 'caffeinated') {
        this.particles.spawn(6, 'speedline');
      }
    } else {
      this.lastStateChange = Date.now();
      this.stateDetail = detail;
    }

    // Immediately show new activity in thought bubble
    this.thoughtTimer = 0;
    this._updateThought();
  }

  setStats(data) {
    if (data.modelName) this.modelName = data.modelName;
    this.toolCallCount = data.toolCalls || 0;
    this.filesEditedCount = data.filesEdited || 0;
    this.sessionStart = data.sessionStart || 0;
    this.streak = data.streak || 0;
    this.bestStreak = data.bestStreak || 0;

    // Detect streak break -- dramatic reaction proportional to lost streak
    if (data.brokenStreak > 0 && data.brokenStreakAt !== this.brokenStreakAt) {
      this.lastBrokenStreak = data.brokenStreak;
      this.brokenStreakAt = data.brokenStreakAt;
      const drama = Math.min(1.0, data.brokenStreak / 50);
      this.glitchIntensity = Math.max(this.glitchIntensity, 0.5 + drama * 0.5);
      this.particles.spawn(Math.floor(4 + drama * 16), 'glitch');
    }

    // Inter-session memory
    this.diffInfo = data.diffInfo || null;
    this.dailySessions = data.dailySessions || 0;
    this.dailyCumulativeMs = data.dailyCumulativeMs || 0;
    if (data.frequentFiles) this.frequentFiles = data.frequentFiles;

    // Detect milestone
    if (data.milestone && (!this.milestone || data.milestone.at !== this.milestone.at)) {
      this.milestone = data.milestone;
      this.milestoneShowTime = 180; // ~12 seconds at 15fps
      this.particles.spawn(15, 'sparkle');
    }
  }

  _updateThought() {
    if (this.petSpamActive) {
      const lvl = Math.min(this.petSpamLevel, PET_SPAM_THOUGHTS.length) - 1;
      const pool = PET_SPAM_THOUGHTS[Math.max(0, lvl)];
      if (this.petSpamLevel >= 3 && Math.random() < 0.4) {
        // Overstimulated -- can't form words anymore
        const chars = 'abcdefghjklsdf!?';
        let scramble = '';
        for (let i = 0; i < 5 + Math.floor(Math.random() * 4); i++) {
          scramble += chars[Math.floor(Math.random() * chars.length)];
        }
        this.thoughtText = scramble;
      } else {
        this.thoughtText = pool[this.thoughtIndex % pool.length];
      }
      return;
    }
    if (this.petAfterglowTimer > 0) {
      this.thoughtText = PET_AFTERGLOW_THOUGHTS[this.thoughtIndex % PET_AFTERGLOW_THOUGHTS.length];
      return;
    }
    if (this.state === 'sleeping') {
      this.thoughtText = '';
    } else if (this.state === 'idle') {
      // Sometimes hide (flicker effect)
      if (Math.random() < 0.25) { this.thoughtText = ''; return; }
      // Build dynamic idle thoughts with session memory
      const thoughts = [...IDLE_THOUGHTS];
      if (this.dailySessions > 1) {
        thoughts.push(`session ${this.dailySessions} today`);
      }
      if (this.dailyCumulativeMs > 1800000) {
        const hours = Math.floor(this.dailyCumulativeMs / 3600000);
        const mins = Math.floor((this.dailyCumulativeMs % 3600000) / 60000);
        thoughts.push(hours > 0 ? `${hours}h ${mins}m today` : `${mins}m today`);
      }
      const topFile = this._getTopFile();
      if (topFile) thoughts.push(`back to ${topFile} again...`);
      this.thoughtText = thoughts[this.thoughtIndex % thoughts.length];
    } else if (this.state === 'happy' && this.milestone && this.milestoneShowTime > 0) {
      this.thoughtText = '';
    } else if (this.state === 'error' && this.lastBrokenStreak > 10) {
      this.thoughtText = `...${this.lastBrokenStreak} streak gone`;
    } else if (this.state === 'proud' && this.diffInfo) {
      const { added, removed } = this.diffInfo;
      if (added > 0 && removed > 0) {
        this.thoughtText = `+${added} -${removed} lines`;
      } else if (added > 0) {
        this.thoughtText = `+${added} lines`;
      } else {
        this.thoughtText = COMPLETION_THOUGHTS[this.thoughtIndex % COMPLETION_THOUGHTS.length];
      }
    } else if (['satisfied', 'proud', 'relieved'].includes(this.state)) {
      this.thoughtText = COMPLETION_THOUGHTS[this.thoughtIndex % COMPLETION_THOUGHTS.length];
    } else if (STATE_THOUGHTS[this.state]) {
      // Reactive personality thoughts -- detail line below handles the facts
      const thoughts = STATE_THOUGHTS[this.state];
      this.thoughtText = thoughts[this.thoughtIndex % thoughts.length];
    } else if (this.state === 'thinking') {
      this.thoughtText = THINKING_THOUGHTS[this.thoughtIndex % THINKING_THOUGHTS.length];
    } else {
      this.thoughtText = '';
    }
  }

  _getTopFile() {
    if (!this.frequentFiles) return null;
    let max = 0, top = null;
    for (const [file, count] of Object.entries(this.frequentFiles)) {
      if (count > max && count >= 3) { max = count; top = file; }
    }
    return top;
  }

  // -- Interactive methods --------------------------------------------

  pet() {
    const now = Date.now();
    this.petTimes.push(now);
    this.petTimes = this.petTimes.filter(t => now - t < PET_SPAM_WINDOW);

    if (this.petTimes.length >= PET_SPAM_THRESHOLD) {
      // Easter egg: pet spam detected!
      // Only escalate on the first threshold hit per trigger sequence
      if (!this.petSpamActive) {
        if (now - this.petSpamLastAt < PET_SPAM_ESCALATE_WINDOW) {
          this.petSpamLevel = Math.min(this.petSpamLevel + 1, 3);
        } else {
          this.petSpamLevel = 1;
        }
        this.petSpamLastAt = now;
      }
      this.petSpamActive = true;
      this.petSpamTimer = PET_SPAM_DURATION;
      this.petAfterglowTimer = 0;
      this.particles.spawn(30, 'heart');
      this.petTimer = PET_SPAM_DURATION;
      this.thoughtIndex++;
      this._updateThought();
    } else {
      this.particles.spawn(15, 'sparkle');
      this.petTimer = 22; // ~1.5s at 15fps
    }
  }

  cycleTheme() {
    this.paletteIndex = (this.paletteIndex + 1) % PALETTES.length;
  }

  toggleStats() {
    this.showStats = !this.showStats;
  }

  toggleHelp() {
    this.showHelp = !this.showHelp;
  }

  toggleAccessories() {
    this.accessoriesEnabled = !this.accessoriesEnabled;
  }

  toggleSurroundMode() {
    this.surroundMode = !this.surroundMode;
    if (this.surroundMode) {
      this.loadSurroundSessions();
    }
  }

  loadSurroundSessions() {
    // Get main session info to exclude it from surround faces
    let mainModelName = null;
    let mainCwd = null;
    try {
      const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
      if (raw) {
        const data = JSON.parse(raw);
        mainModelName = data.modelName || null;
        mainCwd = data.cwd || null;
      }
    } catch {}

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

        // Skip the main session - match by modelName and cwd
        if (mainModelName && data.modelName === mainModelName) {
          // If cwd matches too, skip it
          if (!mainCwd || !data.cwd || path.basename(data.cwd) === path.basename(mainCwd)) {
            continue;
          }
        }

        seenIds.add(id);

        if (!this.surroundFaces.has(id)) {
          this.surroundFaces.set(id, new SurroundMiniFace(id));
        }
        this.surroundFaces.get(id).updateFromFile(data);
      } catch {
        continue;
      }
    }

    for (const [id, face] of this.surroundFaces) {
      if (!seenIds.has(id) || face.isStale()) {
        this.surroundFaces.delete(id);
      }
    }

    this.assignSurroundLabels();
  }

  assignSurroundLabels() {
    const sorted = [...this.surroundFaces.values()].sort((a, b) => a.firstSeen - b.firstSeen);
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
        face.label = base ? base.slice(0, 8) : (face.modelName || 'claude').slice(0, 8);
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

  calculateSurroundPositions(cols, rows, faceW, faceH, startRow, startCol) {
    const faces = [...this.surroundFaces.values()].sort((a, b) => a.firstSeen - b.firstSeen);
    const n = faces.length;
    if (n === 0) return [];

    // Reserve space at bottom for key hints (last 2 rows)
    const availableRows = rows - 3;
    const maxPerColumn = Math.floor((availableRows - startRow) / SURROUND_CELL_H);
    const columnCapacity = Math.max(1, maxPerColumn);

    // Symmetrical columns: equal distance from face edges
    // Left: SURROUND_CELL_W + 2 chars left of face left edge
    // Right: SURROUND_CELL_W + 2 chars right of face right edge
    const gap = 2;
    const leftCol = Math.max(1, startCol - SURROUND_CELL_W - gap);
    const rightCol = Math.min(cols - SURROUND_CELL_W, startCol + faceW + gap);
    const leftCol2 = Math.max(1, leftCol - SURROUND_CELL_W - gap);
    const rightCol2 = Math.min(cols - SURROUND_CELL_W, rightCol + SURROUND_CELL_W + gap);

    // Place faces in columns starting from center outward
    const positions = [];
    for (let i = 0; i < n; i++) {
      const colIndex = Math.floor(i / columnCapacity);
      const rowIndex = i % columnCapacity;

      let col;
      if (colIndex === 0) {
        col = i < columnCapacity ? leftCol : rightCol;
      } else if (colIndex === 1) {
        col = i < columnCapacity * 2 ? rightCol : leftCol;
      } else if (colIndex === 2) {
        col = leftCol2;
      } else if (colIndex === 3) {
        col = rightCol2;
      } else {
        // Fallback - just use right side for overflow
        col = rightCol2;
      }

      positions.push({
        face: faces[i],
        row: startRow + rowIndex * SURROUND_CELL_H,
        col: col,
      });
    }

    return positions;
  }

  getTheme() {
    const palette = PALETTES[this.paletteIndex] || PALETTES[0];
    return palette.themes[this.state] || palette.themes.idle;
  }

  getTimelineColors() {
    const palette = PALETTES[this.paletteIndex] || PALETTES[0];
    return palette.timelineColors;
  }

  getEyes(theme, frame) {
    if (this.petSpamActive) {
      // L3: overstimulated vibrating eyes, L1-2: sparkle eyes
      return this.petSpamLevel >= 3
        ? eyes.vibrate(theme, frame)
        : eyes.sparkle(theme, frame);
    }
    if (this.petAfterglowTimer > 0) {
      return eyes.content(theme, frame);
    }
    if (this.blinkFrame >= 0 && this.blinkFrame < BLINK_FRAMES) {
      return eyes.blink(theme, frame);
    }
    switch (this.state) {
      case 'idle':        return eyes.open(theme, frame);
      case 'thinking':    return eyes.spin(theme, Math.floor(frame / 4));
      case 'coding':      return eyes.focused(theme, frame);
      case 'reading':     return eyes.narrowed(theme, frame);
      case 'searching':
        if (this.lookDir < 0) return eyes.lookLeft(theme, frame);
        if (this.lookDir > 0) return eyes.lookRight(theme, frame);
        return eyes.wide(theme, frame);
      case 'executing':   return eyes.open(theme, frame);
      case 'happy':       return eyes.sparkle(theme, frame);
      case 'satisfied':   return eyes.content(theme, frame);
      case 'proud':       return eyes.pleased(theme, frame);
      case 'relieved':    return eyes.open(theme, frame);
      case 'error':
        if (this.glitchIntensity > 0.3 && Math.random() < this.glitchIntensity * 0.4) {
          return eyes.glitch(theme, frame);
        }
        return eyes.cross(theme, frame);
      case 'sleeping':    return eyes.sleeping(theme, frame);
      case 'waiting':     return eyes.waiting(theme, frame);
      case 'testing':     return eyes.intense(theme, frame);
      case 'installing':  return eyes.down(theme, frame);
      case 'caffeinated': return eyes.vibrate(theme, frame);
      case 'subagent':    return eyes.echo(theme, frame);
      default:            return eyes.open(theme, frame);
    }
  }

  getMouth(theme, frame) {
    if (this.petSpamActive) {
      return this.petSpamLevel >= 2 ? mouths.grin() : mouths.wide();
    }
    if (this.petAfterglowTimer > 0) return mouths.smile();
    switch (this.state) {
      case 'idle':      return mouths.smile();
      case 'thinking':  return mouths.neutral();
      case 'coding':    return mouths.determined();
      case 'reading':   return mouths.neutral();
      case 'searching': return mouths.curious();
      case 'executing': return mouths.smirk();
      case 'happy':     return mouths.wide();
      case 'satisfied': return mouths.smile();
      case 'proud':     return mouths.smirk();
      case 'relieved':  return mouths.exhale();
      case 'error':
        if (this.glitchIntensity > 0.2 && Math.random() < 0.3) return mouths.glitch();
        return mouths.frown();
      case 'sleeping':    return mouths.wavy();
      case 'waiting':     return mouths.wait();
      case 'testing':     return mouths.tight();
      case 'installing':  return mouths.dots();
      case 'caffeinated': return mouths.grin();
      case 'subagent':    return mouths.calm();
      default:          return mouths.smile();
    }
  }

  update(dt) {
    this.time += dt;
    this.frame++;
    this.transitionFrame++;

    // Apply pending state if minimum display time has passed
    if (this.pendingState && Date.now() >= this.minDisplayUntil) {
      this.setState(this.pendingState, this.pendingDetail);
    }

    // Blink timer
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkFrame = 0;
      this.blinkTimer = this._nextBlink();
    }
    if (this.blinkFrame >= 0) {
      this.blinkFrame++;
      if (this.blinkFrame >= BLINK_FRAMES) this.blinkFrame = -1;
    }

    // Searching look direction
    if (this.state === 'searching') {
      this.lookTimer += dt;
      if (this.lookTimer > 600) {
        this.lookDir = [-1, 0, 1, 0][Math.floor(Math.random() * 4)];
        this.lookTimer = 0;
      }
    }

    // Glitch decay
    if (this.glitchIntensity > 0) {
      this.glitchIntensity = Math.max(0, this.glitchIntensity - 0.008);
    }

    // Continuous particle spawning per state
    if (this.state === 'thinking' && this.frame % 15 === 0) this.particles.spawn(1, 'orbit');
    if (this.state === 'idle' && this.frame % 40 === 0) this.particles.spawn(1, 'float');
    if (this.state === 'error' && this.glitchIntensity > 0.1 && this.frame % 5 === 0) this.particles.spawn(1, 'glitch');
    if (this.state === 'happy' && this.frame % 20 === 0) this.particles.spawn(2, 'sparkle');
    if (this.state === 'proud' && this.frame % 30 === 0) this.particles.spawn(1, 'sparkle');
    if (this.state === 'satisfied' && this.frame % 50 === 0) this.particles.spawn(1, 'float');
    if (this.state === 'relieved' && this.frame % 45 === 0) this.particles.spawn(1, 'float');
    if (this.state === 'sleeping' && this.frame % 30 === 0) this.particles.spawn(1, 'zzz');
    if (this.state === 'waiting' && this.frame % 45 === 0) this.particles.spawn(1, 'question');
    if (this.state === 'testing' && this.frame % 12 === 0) this.particles.spawn(1, 'sweat');
    if (this.state === 'installing' && this.frame % 8 === 0) this.particles.spawn(1, 'falling');
    if (this.state === 'caffeinated' && this.frame % 4 === 0) this.particles.spawn(1, 'speedline');
    if (this.state === 'subagent' && this.frame % 10 === 0) this.particles.spawn(1, 'echo');

    // Caffeinated detection
    const now = Date.now();
    const recentChanges = this.stateChangeTimes.filter(t => now - t < CAFFEINE_WINDOW);
    if (recentChanges.length >= CAFFEINE_THRESHOLD &&
        this.state !== 'idle' && this.state !== 'sleeping' &&
        this.state !== 'happy' && this.state !== 'satisfied' &&
        this.state !== 'proud' && this.state !== 'relieved' &&
        this.state !== 'error' && this.state !== 'caffeinated') {
      this.isCaffeinated = true;
      this.prevState = this.state;
      this.state = 'caffeinated';
      this.stateDetail = this.stateDetail || 'hyperdrive!';
      this.particles.spawn(4, 'speedline');
    } else if (this.state === 'caffeinated' && recentChanges.length < CAFFEINE_THRESHOLD - 1) {
      this.isCaffeinated = false;
    }

    // Thought bubble cycling (jittery at pet spam level 3+)
    this.thoughtTimer += dt;
    const thoughtInterval = (this.petSpamActive && this.petSpamLevel >= 3) ? 200 : 4000;
    if (this.thoughtTimer > thoughtInterval) {
      this.thoughtTimer = 0;
      this.thoughtIndex++;
      this._updateThought();
    }

    // Milestone display decay
    if (this.milestoneShowTime > 0) this.milestoneShowTime--;

    // Pet wiggle decay
    if (this.petTimer > 0) {
      this.petTimer--;
      const amp = this.petSpamActive ? 2 : 1;
      this.petWiggle = (this.petTimer % 2 === 0) ? amp : -amp;
    } else {
      this.petWiggle = 0;
    }

    // Pet spam decay & continuous hearts
    if (this.petSpamTimer > 0) {
      this.petSpamTimer--;
      if (this.frame % 3 === 0) this.particles.spawn(2, 'heart');
    } else if (this.petSpamActive) {
      // Transition to afterglow: post-pet bliss
      this.petSpamActive = false;
      this.petAfterglowTimer = PET_SPAM_AFTERGLOW;
      this.particles.spawn(3, 'heart');
      this._updateThought();
    }

    // Pet afterglow decay -- lazy drifting hearts
    if (this.petAfterglowTimer > 0) {
      this.petAfterglowTimer--;
      if (this.frame % 20 === 0) this.particles.spawn(1, 'heart');
      if (this.petAfterglowTimer <= 0) this._updateThought();
    }

    this.particles.update();
  }

  _buildSparkline(barWidth, now) {
    if (this.timeline.length < 3) return null;
    const tlStart = this.timeline[0].at;
    const totalDur = now - tlStart;
    if (totalDur < 2000) return null;

    const buckets = new Array(barWidth).fill(0);
    const bucketDur = totalDur / barWidth;
    for (let i = 1; i < this.timeline.length; i++) {
      const idx = Math.min(barWidth - 1, Math.floor((this.timeline[i].at - tlStart) / bucketDur));
      if (idx >= 0) buckets[idx]++;
    }
    return buckets;
  }

  _renderHelp(cols, rows, theme) {
    const lines = [
      ' Keybindings ',
      '',
      ' space  pet the face',
      ' t      cycle palette',
      ' s      toggle stats',
      ' g      toggle surround',
      ' a      toggle accessories',
      ' h/?    this help',
      ' q      quit',
    ];
    const boxW = 28;
    const boxH = lines.length + 2;
    const bx = Math.max(1, Math.floor((cols - boxW) / 2));
    const by = Math.max(1, Math.floor((rows - boxH) / 2));
    const bc = ansi.fg(...dimColor(theme.border, 0.8));
    const tc = ansi.fg(...dimColor(theme.label, 0.9));
    const r = ansi.reset;
    let buf = '';
    buf += ansi.to(by, bx) + `${bc}\u256d${'\u2500'.repeat(boxW)}\u256e${r}`;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const pad = boxW - line.length;
      buf += ansi.to(by + 1 + i, bx) + `${bc}\u2502${tc}${line}${' '.repeat(Math.max(0, pad))}${bc}\u2502${r}`;
    }
    buf += ansi.to(by + 1 + lines.length, bx) + `${bc}\u2570${'\u2500'.repeat(boxW)}\u256f${r}`;
    return buf;
  }

  render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const theme = this.getTheme();

    // Terminal too small -- show compact fallback
    if (cols < MIN_COLS_SINGLE || rows < MIN_ROWS_SINGLE) {
      let buf = '';
      for (let row = 1; row <= rows; row++) {
        buf += ansi.to(row, 1) + ansi.clearLine;
      }
      const msg = cols < 20 ? '\u00b7_\u00b7' : '\u00b7_\u00b7  resize me';
      const msgCol = Math.max(1, Math.floor((cols - msg.length) / 2));
      const msgRow = Math.max(1, Math.floor(rows / 2));
      buf += ansi.to(msgRow, msgCol);
      buf += `${ansi.fg(...dimColor(theme.border, 0.6))}${msg}${ansi.reset}`;
      return buf;
    }

    const breathTime = this.petAfterglowTimer > 0 ? this.time * 0.5
      : this.state === 'sleeping' ? this.time * 0.5
      : this.state === 'caffeinated' ? this.time * 2.5
      : this.time;
    const borderColor = breathe(theme.border, breathTime);
    const eyeColor = theme.eye;
    const mouthColor = theme.mouth;

    const faceW = 30;
    const faceH = 10;
    const totalH = faceH + 15; // face + status/detail + thought bubble above + accessories above + streak/timeline/sparkline below

    const startCol = Math.max(1, Math.floor((cols - faceW) / 2) + 1);
    const startRow = Math.max(7, Math.floor((rows - totalH) / 2) + 4);

    const fc = ansi.fg(...borderColor);
    const ec = ansi.fg(...eyeColor);
    const mc = ansi.fg(...mouthColor);
    const r = ansi.reset;

    const eyeData = this.getEyes(theme, this.frame);
    const mouthStr = this.getMouth(theme, this.frame);

    // Glitch / caffeinated / pet horizontal jitter
    let gx = (this.state === 'error' && this.glitchIntensity > 0.3 && Math.random() < 0.15)
      ? Math.floor(Math.random() * 3) - 1 : 0;
    if (this.state === 'caffeinated' && this.frame % 2 === 0) {
      gx = Math.floor(Math.random() * 3) - 1;
    }
    gx += this.petWiggle;

    let buf = '';

    // Clear the full terminal to prevent ghost particles
    // (float/zzz particles can drift far above the face)
    for (let row = 1; row <= rows; row++) {
      buf += ansi.to(row, 1) + ansi.clearLine;
    }

    // Face box
    const inner = faceW - 10;

    buf += ansi.to(startRow, startCol + gx);
    buf += `${fc}    \u256d${'\u2500'.repeat(inner)}\u256e${r}`;

    buf += ansi.to(startRow + 1, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(inner)}\u2502${r}`;

    // Eyes top
    const eyePad = 4;
    const eyeGap = 8;
    const used = eyePad + 2 + eyeGap + 2;
    buf += ansi.to(startRow + 2, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(eyePad)}${ec}${eyeData.left[0]}${r}${' '.repeat(eyeGap)}${ec}${eyeData.right[0]}${r}${' '.repeat(inner - used)}${fc}\u2502${r}`;

    // Eyes bottom
    buf += ansi.to(startRow + 3, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(eyePad)}${ec}${eyeData.left[1]}${r}${' '.repeat(eyeGap)}${ec}${eyeData.right[1]}${r}${' '.repeat(inner - used)}${fc}\u2502${r}`;

    buf += ansi.to(startRow + 4, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(inner)}\u2502${r}`;

    // Mouth
    const mouthPad = Math.floor((inner - mouthStr.length) / 2);
    buf += ansi.to(startRow + 5, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(mouthPad)}${mc}${mouthStr}${r}${' '.repeat(inner - mouthPad - mouthStr.length)}${fc}\u2502${r}`;

    buf += ansi.to(startRow + 6, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(inner)}\u2502${r}`;

    buf += ansi.to(startRow + 7, startCol + gx);
    buf += `${fc}    \u2570${'\u2500'.repeat(inner)}\u256f${r}`;

    // Accessories (above face box, rendered before thought bubble so bubble takes priority)
    if (this.accessoriesEnabled) {
      const accessory = getAccessory(this.state);
      if (accessory) {
        const ac = ansi.fg(...dimColor(breathe(theme.accent, breathTime), 0.85));
        const lines = accessory.lines;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineRow = startRow - lines.length + i;
          const lineCol = Math.max(1, startCol + Math.floor((faceW - line.length) / 2) + gx);
          if (lineRow >= 1) {
            buf += ansi.to(lineRow, lineCol) + `${ac}${line}${r}`;
          }
        }
      }
    }

    // Status line
    const emoji = theme.emoji;
    const statusText = `${emoji}  ${this.modelName} is ${theme.status}  ${emoji}`;
    const statusPad = Math.floor((faceW - statusText.length) / 2);
    buf += ansi.to(startRow + 9, startCol);
    buf += `${ansi.fg(...theme.label)}${' '.repeat(Math.max(0, statusPad))}${statusText}${r}`;

    // Detail line
    if (this.stateDetail) {
      const maxDetailWidth = Math.max(10, cols - startCol - 8);
      const detailText = this.stateDetail.length > maxDetailWidth
        ? this.stateDetail.slice(0, maxDetailWidth - 3) + '...'
        : this.stateDetail;
      const detailPad = Math.floor((faceW - detailText.length) / 2);
      buf += ansi.to(startRow + 10, startCol);
      buf += `${ansi.dim}${ansi.fg(...dimColor(theme.label, 0.6))}${' '.repeat(Math.max(0, detailPad))}${detailText}${r}`;
    }

    // Thought bubble (above face, right of center)
    // Offset upward when accessories are present to avoid overlap
    let bubbleOffset = 0;
    if (this.accessoriesEnabled && getAccessory(this.state)) {
      bubbleOffset = getAccessory(this.state).lines.length;
    }
    if (this.thoughtText && startRow >= 5 + bubbleOffset) {
      const txt = this.thoughtText;
      const bubbleInner = txt.length + 2;
      const bubbleLeft = startCol + Math.floor(faceW / 2);
      const bc = ansi.fg(...dimColor(theme.accent, 0.5));
      const tc = `${ansi.italic}${ansi.fg(...dimColor(theme.label, 0.7))}`;

      if (bubbleLeft + bubbleInner + 2 < cols) {
        buf += ansi.to(startRow - 4 - bubbleOffset, bubbleLeft);
        buf += `${bc}\u256d${'\u2500'.repeat(bubbleInner)}\u256e${r}`;
        buf += ansi.to(startRow - 3 - bubbleOffset, bubbleLeft);
        buf += `${bc}\u2502 ${tc}${txt}${r} ${bc}\u2502${r}`;
        buf += ansi.to(startRow - 2 - bubbleOffset, bubbleLeft);
        buf += `${bc}\u2570${'\u2500'.repeat(bubbleInner)}\u256f${r}`;
        buf += ansi.to(startRow - 1 - bubbleOffset, bubbleLeft + 2);
        buf += `${bc}\u25cb${r}`;
      }
    }

    // Streak counter, timeline, sparkline (togglable via 's')
    if (this.showStats) {
      if (this.streak > 0 || this.milestoneShowTime > 0) {
        let streakText, sc;
        if (this.milestoneShowTime > 0 && this.milestone) {
          const stars = '\u2605'.repeat(Math.min(5, Math.ceil(this.milestone.value / 20)));
          streakText = `${stars} ${this.milestone.value} in a row! ${stars}`;
          sc = ansi.fg(255, 220, 50);
        } else if (this.streak >= 25) {
          streakText = `\u2605 ${this.streak} successful in a row`;
          sc = ansi.fg(...dimColor(theme.label, 0.7));
        } else if (this.streak > 1) {
          streakText = `${this.streak} successful in a row`;
          sc = ansi.fg(...dimColor(theme.label, 0.4));
        } else {
          streakText = '';
          sc = '';
        }
        if (streakText) {
          const streakPad = Math.floor((faceW - streakText.length) / 2);
          buf += ansi.to(startRow + 12, startCol);
          buf += `${sc}${' '.repeat(Math.max(0, streakPad))}${streakText}${r}`;
        }
      }
      // Show dramatic broken streak message
      if (this.state === 'error' && this.lastBrokenStreak > 5) {
        const severity = this.lastBrokenStreak >= 50 ? 'DEVASTATION.'
          : this.lastBrokenStreak >= 25 ? 'that really hurt.'
          : this.lastBrokenStreak >= 10 ? 'ouch.'
          : '';
        if (severity) {
          const spad = Math.floor((faceW - severity.length) / 2);
          buf += ansi.to(startRow + 12, startCol);
          buf += `${ansi.fg(230, 80, 80)}${' '.repeat(Math.max(0, spad))}${severity}${r}`;
        }
      }

      // Session timeline bar
      const tlColors = this.getTimelineColors();
      if (this.timeline.length > 1) {
        const barWidth = Math.min(faceW - 2, 38);
        const now = Date.now();
        const tlStart = this.timeline[0].at;
        const totalDur = now - tlStart;

        if (totalDur > 2000) {
          let bar = '';
          for (let i = 0; i < barWidth; i++) {
            const t = tlStart + (totalDur * i / barWidth);
            let st = 'idle';
            for (let j = this.timeline.length - 1; j >= 0; j--) {
              if (this.timeline[j].at <= t) { st = this.timeline[j].state; break; }
            }
            const color = tlColors[st] || tlColors.idle;
            bar += ansi.fg(...color) + '\u2588';
          }
          const barPad = Math.floor((faceW - barWidth) / 2);
          buf += ansi.to(startRow + 13, startCol + barPad) + bar + r;
        }
      }

      // Activity sparkline (tool call density below timeline)
      {
        const spkWidth = Math.min(faceW - 2, 38);
        const sparkBuckets = this._buildSparkline(spkWidth, Date.now());
        if (sparkBuckets) {
          const maxCount = Math.max(1, ...sparkBuckets);
          let sparkline = '';
          for (let i = 0; i < sparkBuckets.length; i++) {
            const ratio = sparkBuckets[i] / maxCount;
            const blockIdx = Math.round(ratio * (SPARKLINE_BLOCKS.length - 1));
            const brightness = sparkBuckets[i] === 0 ? 0.15 : 0.3 + ratio * 0.7;
            sparkline += ansi.fg(...dimColor(theme.accent, brightness)) + SPARKLINE_BLOCKS[blockIdx];
          }
          const barPad = Math.floor((faceW - spkWidth) / 2);
          buf += ansi.to(startRow + 14, startCol + barPad) + sparkline + r;
        }
      }
    }

    // Indicators row: accessories state (left) + palette name (right)
    {
      const dc = `${ansi.dim}${ansi.fg(...dimColor(theme.label, 0.4))}`;
      const accText = this.accessoriesEnabled ? '\u25cf accs' : '\u25cb accs';
      buf += ansi.to(startRow + 8, startCol) + `${dc}${accText}${r}`;
      if (this.paletteIndex > 0) {
        const pName = PALETTE_NAMES[this.paletteIndex] || '';
        buf += ansi.to(startRow + 8, startCol + faceW - pName.length);
        buf += `${dc}${pName}${r}`;
      }
    }

    // Key hints bar (bottom of terminal)
    {
      const dc = `${ansi.dim}${ansi.fg(...dimColor(theme.label, 0.3))}`;
      const kc = ansi.fg(...dimColor(theme.accent, 0.4));
      const sep = `${dc}\u00b7${r}`;
      const hint = `${kc}space${dc} pet ${sep} ${kc}t${dc} theme ${sep} ${kc}s${dc} stats ${sep} ${kc}g${dc} surround ${sep} ${kc}a${dc} accs ${sep} ${kc}h${dc} help ${sep} ${kc}q${dc} quit${r}`;
      // Strip ANSI to measure visible length
      const visible = hint.replace(/\x1b\[[^m]*m/g, '');
      const hintCol = Math.max(1, Math.floor((cols - visible.length) / 2) + 1);
      buf += ansi.to(rows, hintCol) + hint;
    }

    // Help overlay
    if (this.showHelp) {
      buf += this._renderHelp(cols, rows, theme);
    }

    // Surround mode mini faces
    if (this.surroundMode) {
      const positions = this.calculateSurroundPositions(cols, rows, faceW, faceH, startRow, startCol);
      const paletteThemes = (PALETTES[this.paletteIndex] || PALETTES[0]).themes;
      for (const pos of positions) {
        pos.face.tick(16);
        buf += pos.face.render(pos.row, pos.col, this.time, paletteThemes);
      }
    }

    // Particles (drawn on top of face)
    buf += this.particles.render(startRow - 2, startCol - 5, theme.accent);
    buf += r;

    return buf;
  }
}

module.exports = { ClaudeFace, SurroundMiniFace };
