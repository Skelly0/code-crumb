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

// -- Mode ----------------------------------------------------------
const GRID_MODE = process.argv.includes('--grid');

// -- Config --------------------------------------------------------
const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const STATE_FILE = process.env.CLAUDE_FACE_STATE || path.join(HOME, '.claude-face-state');
const SESSIONS_DIR = path.join(HOME, '.claude-face-sessions');
const PID_FILE = path.join(HOME, GRID_MODE ? '.claude-face-grid.pid' : '.claude-face.pid');
const FPS = 15;
const FRAME_MS = Math.floor(1000 / FPS);
const BLINK_MIN = 2500;
const BLINK_MAX = 6000;
const BLINK_FRAMES = 3;
const BREATH_PERIOD = 4000;
const IDLE_TIMEOUT = 8000;
const SLEEP_TIMEOUT = 60000;
const CAFFEINE_WINDOW = 10000;
const CAFFEINE_THRESHOLD = 5;

// Grid cell layout
const CELL_W = 12;
const CELL_H = 7;
const BOX_W = 8;
const BOX_INNER = 6;
const STALE_MS = 120000;
const STOPPED_LINGER_MS = 5000;

// -- Thought bubbles -------------------------------------------------
const IDLE_THOUGHTS = [
  'thinking about types',
  'contemplating recursion',
  'wondering about edge cases',
  'refactoring dreams',
  'pondering abstractions',
  'imagining clean code',
  'considering the void',
  'counting semicolons',
  'mapping dependencies',
  'tracing call stacks',
  'optimizing nothing',
  'cataloguing lint warnings',
];
const THINKING_THOUGHTS = [
  'hmm...', 'what if...', 'let me think...',
  'almost there...', 'connecting dots', 'following a thread',
  'one sec...', 'untangling this',
];
const COMPLETION_THOUGHTS = [
  'nice', 'good', 'clean', 'got it', 'smooth',
  'okay', 'that worked', 'moving on', 'next...',
];

// Per-state reactive thoughts -- personality, not status
const STATE_THOUGHTS = {
  coding: [
    'refactoring this...', 'let me fix this', 'almost there...',
    'one more edit', 'cleaning this up', 'this should work',
    'restructuring...', 'tweaking...', 'here we go',
  ],
  reading: [
    'let me see...', 'hmm interesting', 'checking this out',
    'scanning through', 'ah I see...', 'okay okay...',
    'taking notes...', 'absorbing this',
  ],
  searching: [
    'where is it...', 'gotta be somewhere', 'looking around...',
    'digging through', 'hunting...', 'let me find this',
    'scanning...', 'it must be here',
  ],
  executing: [
    'let\'s see...', 'running this...', 'here goes...',
    'fingers crossed', 'moment of truth', 'let me try this',
  ],
  testing: [
    'please pass...', 'moment of truth', 'sweating a bit',
    'come on...', 'hope this works', 'deep breath...',
  ],
  installing: [
    'downloading...', 'pulling deps', 'this might take a sec',
    'loading up...', 'grabbing packages', 'patience...',
  ],
  subagent: [
    'delegating this', 'sending a helper', 'teamwork...',
    'splitting the work', 'parallel vibes', 'tag team',
  ],
  error: [
    'ugh', 'wait what', 'hmm not right',
    'okay let me think', 'well that broke', 'debugging time',
  ],
};

// -- Timeline colors -------------------------------------------------
const TIMELINE_COLORS = {
  idle:        [60, 70, 80],
  thinking:    [140, 90, 180],
  coding:      [60, 160, 90],
  reading:     [80, 150, 150],
  searching:   [180, 160, 50],
  executing:   [180, 130, 50],
  happy:       [190, 170, 40],
  satisfied:   [90, 180, 150],
  proud:       [130, 200, 80],
  relieved:    [190, 170, 110],
  error:       [190, 50, 50],
  sleeping:    [40, 35, 80],
  waiting:     [120, 110, 150],
  testing:     [150, 170, 50],
  installing:  [50, 130, 160],
  caffeinated: [220, 150, 30],
  subagent:    [120, 80, 180],
};

// How long completion states linger before fading to idle
const COMPLETION_LINGER = {
  happy: 8000,
  proud: 7000,
  satisfied: 5500,
  relieved: 6000,
};

// -- ANSI ----------------------------------------------------------
const CSI = '\x1b[';
const ansi = {
  reset:      `${CSI}0m`,
  bold:       `${CSI}1m`,
  dim:        `${CSI}2m`,
  italic:     `${CSI}3m`,
  hide:       `${CSI}?25l`,
  show:       `${CSI}?25h`,
  clear:      `${CSI}2J${CSI}H`,
  home:       `${CSI}H`,
  to:         (r, c) => `${CSI}${r};${c}H`,
  fg:         (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  bg:         (r, g, b) => `${CSI}48;2;${r};${g};${b}m`,
  clearLine:  `${CSI}2K`,
  clearBelow: `${CSI}J`,
};

// -- Colors --------------------------------------------------------
function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function dimColor(color, factor) {
  return color.map(c => Math.round(c * factor));
}

function breathe(color, time) {
  const t = (Math.sin(time * Math.PI * 2 / BREATH_PERIOD) + 1) / 2;
  const factor = 0.65 + t * 0.35;
  return dimColor(color, factor);
}

// -- Themes --------------------------------------------------------
const themes = {
  idle: {
    border: [100,160,210], eye: [180,220,255], mouth: [140,190,230],
    accent: [80,130,180], label: [120,170,210], status: 'idle', emoji: '\u00b7',
  },
  thinking: {
    border: [170,110,220], eye: [210,180,255], mouth: [160,120,200],
    accent: [200,140,255], label: [180,130,230], status: 'thinking', emoji: '\u25c6',
  },
  coding: {
    border: [70,190,110], eye: [150,240,180], mouth: [100,200,140],
    accent: [90,210,130], label: [80,200,120], status: 'writing code', emoji: '\u25aa',
  },
  reading: {
    border: [100,180,180], eye: [160,220,220], mouth: [120,190,190],
    accent: [80,200,200], label: [110,190,190], status: 'reading', emoji: '\u25cb',
  },
  searching: {
    border: [210,190,70], eye: [250,240,150], mouth: [200,180,90],
    accent: [230,210,100], label: [220,200,80], status: 'searching', emoji: '\u25c7',
  },
  executing: {
    border: [210,150,70], eye: [250,210,150], mouth: [200,160,100],
    accent: [230,170,90], label: [220,160,80], status: 'running command', emoji: '\u25b8',
  },
  happy: {
    border: [220,200,60], eye: [255,250,150], mouth: [230,210,90],
    accent: [255,240,100], label: [240,220,80], status: 'done!', emoji: '\u2726',
  },
  satisfied: {
    border: [90,180,150], eye: [150,220,200], mouth: [120,200,170],
    accent: [110,200,180], label: [100,190,160], status: 'satisfied', emoji: '\u2218',
  },
  proud: {
    border: [130,200,80], eye: [190,240,140], mouth: [150,210,100],
    accent: [170,230,110], label: [150,220,90], status: 'proud', emoji: '\u25b8',
  },
  relieved: {
    border: [190,170,110], eye: [230,220,170], mouth: [210,190,140],
    accent: [220,200,140], label: [200,190,130], status: 'relieved', emoji: '\u25cb',
  },
  error: {
    border: [210,70,70], eye: [255,150,150], mouth: [200,100,100],
    accent: [230,90,90], label: [220,90,90], status: 'hit a snag', emoji: '\u00d7',
  },
  sleeping: {
    border: [60,50,110], eye: [90,80,150], mouth: [70,60,120],
    accent: [110,90,170], label: [80,70,140], status: 'sleeping', emoji: 'z',
  },
  waiting: {
    border: [150,140,180], eye: [190,180,220], mouth: [160,150,190],
    accent: [180,170,210], label: [160,150,190], status: 'waiting', emoji: '?',
  },
  testing: {
    border: [180,200,70], eye: [220,240,130], mouth: [190,210,100],
    accent: [200,220,90], label: [190,210,80], status: 'running tests', emoji: '\u29eb',
  },
  installing: {
    border: [70,160,190], eye: [130,200,230], mouth: [100,170,200],
    accent: [90,180,210], label: [80,170,200], status: 'installing', emoji: '\u25bc',
  },
  caffeinated: {
    border: [255,180,50], eye: [255,220,100], mouth: [240,190,70],
    accent: [255,200,80], label: [250,190,60], status: 'hyperdrive!', emoji: '\u25c9',
  },
  subagent: {
    border: [150,100,210], eye: [190,160,240], mouth: [140,110,200],
    accent: [180,130,230], label: [160,120,220], status: 'spawning', emoji: '\u25c8',
  },
};

// -- Mouths (full-size face) ---------------------------------------
const mouths = {
  smile:      () => '\u25e1\u25e1\u25e1',
  neutral:    () => '\u2500\u2500\u2500',
  wide:       () => '\u25e1\u25e1\u25e1\u25e1\u25e1',
  curious:    () => ' \u25cb ',
  frown:      () => '\u25e0\u25e0\u25e0',
  smirk:      () => '  \u25e1\u25e1',
  ooh:        () => ' \u25cb ',
  determined: () => '\u2550\u2550\u2550',
  glitch: () => {
    const ms = ['\u25e1\u25e0\u25e1', '\u25e0\u25e1\u25e0', '\u2550\u25e1\u2550', '\u25e1\u2550\u25e1', '\u2500\u25e1\u2500', '\u25e1\u2500\u25e1'];
    return ms[Math.floor(Math.random() * ms.length)];
  },
  wavy:       () => '~~~',
  wait:       () => '\u2500\u2500\u2500',
  tight:      () => '\u2550\u2550\u2550',
  dots:       () => '\u00b7\u00b7\u00b7',
  grin:       () => '\u25aa\u25e1\u25aa',
  calm:       () => ' \u25e1\u25e1',
  exhale:     () => ' \u25e1 ',
  content:    () => '\u25e1\u25e1 ',
};

// -- Grid mouths (compact for BOX_INNER=6) -------------------------
const gridMouths = {
  idle:        '\u25e1\u25e1\u25e1',
  thinking:    '\u2500\u2500\u2500',
  reading:     '\u2500\u2500\u2500',
  searching:   ' \u25cb ',
  coding:      '\u2550\u2550\u2550',
  executing:   ' \u25e1\u25e1',
  happy:       '\u25e1\u25e1\u25e1',
  error:       '\u25e0\u25e0\u25e0',
  sleeping:    '~~~',
  waiting:     '\u2500\u2500\u2500',
  testing:     '\u2550\u2550\u2550',
  installing:  '\u00b7\u00b7\u00b7',
  caffeinated: '\u25aa\u25e1\u25aa',
  subagent:    ' \u25e1\u25e1',
  satisfied:   '\u25e1\u25e1\u25e1',
  proud:       '  \u25e1\u25e1',
  relieved:    ' \u25e1 ',
};

// -- Helpers -------------------------------------------------------
function safeFilename(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ===================================================================
// SINGLE FACE MODE
// ===================================================================

// -- Eyes (2-row) --------------------------------------------------
const eyes = {
  open()     { return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] }; },
  blink()    { return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] }; },
  halfClose(){ return { left: ['\u2580\u2580', '  '], right: ['\u2580\u2580', '  '] }; },
  narrowed() { return { left: ['\u2500\u2500', '\u2500\u2500'], right: ['\u2500\u2500', '\u2500\u2500'] }; },
  focused()  { return { left: ['\u2584\u2584', '\u2580\u2580'], right: ['\u2584\u2584', '\u2580\u2580'] }; },
  lookLeft() { return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588 ', '\u2588 '] }; },
  lookRight(){ return { left: [' \u2588', ' \u2588'], right: ['\u2588\u2588', '\u2588\u2588'] }; },

  sparkle(theme, frame) {
    const chars = ['\u2726 ', ' \u2726', '\u2727 ', ' \u2727'];
    const i = frame % chars.length;
    return {
      left:  [chars[i], chars[(i + 1) % chars.length]],
      right: [chars[(i + 2) % chars.length], chars[(i + 3) % chars.length]],
    };
  },

  cross() { return { left: ['\u2572\u2571', '\u2571\u2572'], right: ['\u2572\u2571', '\u2571\u2572'] }; },

  glitch() {
    const g = ['\u2588\u2593', '\u2593\u2591', '\u2591\u2592', '\u2592\u2588', '\u2593\u2593', '\u2591\u2591', '\u2588\u2588', '\u2592\u2593'];
    const i = Math.floor(Math.random() * g.length);
    const j = Math.floor(Math.random() * g.length);
    return {
      left:  [g[i], g[j]],
      right: [g[(i+3) % g.length], g[(j+2) % g.length]],
    };
  },

  spin(theme, frame) {
    const phases = [
      { left: ['\u25cf ', '  '], right: ['  ', '  '] },
      { left: ['  ', '  '], right: ['\u25cf ', '  '] },
      { left: ['  ', '  '], right: ['  ', ' \u25cf'] },
      { left: ['  ', ' \u25cf'], right: ['  ', '  '] },
    ];
    return phases[frame % phases.length];
  },

  wide()  { return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] }; },

  sleeping(theme, frame) {
    if (frame % 150 > 145) return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] };
    return { left: ['  ', '\u2500\u2500'], right: ['  ', '\u2500\u2500'] };
  },

  waiting(theme, frame) {
    const drift = Math.floor(frame / 40) % 3;
    if (drift === 1) return { left: ['\u2584\u2584', '\u2588 '], right: ['\u2584\u2584', ' \u2588'] };
    return { left: ['\u2584\u2584', '\u2588\u2588'], right: ['\u2584\u2584', '\u2588\u2588'] };
  },

  intense(theme, frame) {
    if (frame % 25 < 2) return { left: ['\u2588\u2588', '\u2580\u2580'], right: ['\u2580\u2580', '\u2588\u2588'] };
    return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
  },

  down()  { return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] }; },

  vibrate(theme, frame) {
    const j = frame % 3;
    if (j === 0) return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
    if (j === 1) return { left: [' \u2588', '\u2588 '], right: ['\u2588 ', ' \u2588'] };
    return { left: ['\u2588 ', ' \u2588'], right: [' \u2588', '\u2588 '] };
  },

  echo() { return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] }; },

  pleased(theme, frame) {
    if (frame % 50 < 3) return { left: ['\u2580\u2580', '\u2500\u2500'], right: ['\u2580\u2580', '\u2500\u2500'] };
    return { left: ['\u2584\u2584', '\u2588\u2588'], right: ['\u2584\u2584', '\u2588\u2588'] };
  },

  content() { return { left: ['\u2580\u2580', '  '], right: ['\u2580\u2580', '  '] }; },
};

// -- Particles -----------------------------------------------------
class ParticleSystem {
  constructor() {
    this.particles = [];
    this.width = 40;
    this.height = 14;
  }

  // Rapidly age all particles so they fade out on state change
  fadeAll(maxLife = 12) {
    for (const p of this.particles) {
      p.life = Math.min(p.life, maxLife);
    }
  }

  spawn(count, style = 'float') {
    for (let i = 0; i < count; i++) {
      if (style === 'float') {
        this.particles.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          vx: (Math.random() - 0.5) * 0.3,
          vy: -Math.random() * 0.2 - 0.05,
          life: 60 + Math.random() * 120,
          maxLife: 180,
          char: ['\u00b7', '\u2022', '\u2218', '\u00b0', '\u02da'][Math.floor(Math.random() * 5)],
          style,
        });
      } else if (style === 'sparkle') {
        const angle = Math.random() * Math.PI * 2;
        const dist = 8 + Math.random() * 6;
        this.particles.push({
          x: this.width / 2 + Math.cos(angle) * dist,
          y: this.height / 2 + Math.sin(angle) * dist * 0.5,
          vx: Math.cos(angle) * 0.15,
          vy: Math.sin(angle) * 0.08,
          life: 20 + Math.random() * 40,
          maxLife: 60,
          char: ['\u2726', '\u2727', '\u22b9', '\u00b7', '*'][Math.floor(Math.random() * 5)],
          style,
        });
      } else if (style === 'glitch') {
        this.particles.push({
          x: Math.random() * this.width,
          y: Math.random() * this.height,
          vx: 0, vy: 0,
          life: 3 + Math.random() * 8,
          maxLife: 11,
          char: ['\u2593', '\u2591', '\u2592', '\u2588', '\u2573', '\u256c'][Math.floor(Math.random() * 6)],
          style,
        });
      } else if (style === 'orbit') {
        const angle = Math.random() * Math.PI * 2;
        this.particles.push({
          x: 0, y: 0, angle,
          radius: 10 + Math.random() * 5,
          speed: 0.03 + Math.random() * 0.03,
          life: 80 + Math.random() * 60,
          maxLife: 140,
          char: ['\u25c6', '\u25c7', '\u00b7', '\u2022'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'zzz') {
        this.particles.push({
          x: this.width / 2 + 4 + Math.random() * 3,
          y: this.height / 2 - 2,
          vx: 0.04 + Math.random() * 0.04,
          vy: -0.08 - Math.random() * 0.04,
          life: 50 + Math.random() * 50,
          maxLife: 100,
          char: ['z', 'Z', 'z', '\u00b7'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'question') {
        this.particles.push({
          x: this.width / 2 + (Math.random() - 0.5) * 8,
          y: this.height / 2 - 3 - Math.random() * 2,
          vx: (Math.random() - 0.5) * 0.04,
          vy: -0.02 - Math.random() * 0.02,
          life: 40 + Math.random() * 40,
          maxLife: 80,
          char: ['?', '\u00b7', '?', '\u00b7'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'sweat') {
        this.particles.push({
          x: this.width / 2 + (Math.random() > 0.5 ? 1 : -1) * (7 + Math.random() * 2),
          y: this.height / 2 - 3,
          vx: (Math.random() - 0.5) * 0.08,
          vy: 0.15 + Math.random() * 0.1,
          life: 15 + Math.random() * 15,
          maxLife: 30,
          char: ['\u00b7', '\u2022', '\u00b0'][Math.floor(Math.random() * 3)],
          style,
        });
      } else if (style === 'falling') {
        this.particles.push({
          x: this.width / 4 + Math.random() * (this.width / 2),
          y: 0,
          vx: (Math.random() - 0.5) * 0.08,
          vy: 0.15 + Math.random() * 0.12,
          life: 50 + Math.random() * 30,
          maxLife: 80,
          char: ['\u00b7', '\u2022', '\u2218', '\u25cb'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'speedline') {
        const side = Math.random() > 0.5 ? 1 : -1;
        this.particles.push({
          x: this.width / 2 + side * (4 + Math.random() * 8),
          y: this.height / 2 - 2 + Math.random() * 4,
          vx: side * (0.3 + Math.random() * 0.2),
          vy: 0,
          life: 6 + Math.random() * 10,
          maxLife: 16,
          char: ['\u2500', '\u2501', '\u2550', '\u2500'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'echo') {
        const angle = Math.random() * Math.PI * 2;
        this.particles.push({
          x: this.width / 2 + Math.cos(angle) * (5 + Math.random() * 3),
          y: this.height / 2 + Math.sin(angle) * (2.5 + Math.random() * 1.5),
          vx: Math.cos(angle) * 0.06,
          vy: Math.sin(angle) * 0.03,
          life: 25 + Math.random() * 25,
          maxLife: 50,
          char: ['\u256d', '\u256e', '\u2570', '\u256f', '\u2502', '\u2500'][Math.floor(Math.random() * 6)],
          style,
        });
      }
    }
  }

  update() {
    this.particles = this.particles.filter(p => {
      p.life--;
      if (p.style === 'orbit') {
        p.angle += p.speed;
        p.x = this.width / 2 + Math.cos(p.angle) * p.radius;
        p.y = this.height / 2 + Math.sin(p.angle) * p.radius * 0.45;
      } else {
        p.x += p.vx;
        p.y += p.vy;
      }
      return p.life > 0;
    });
  }

  render(offsetRow, offsetCol, accentColor) {
    let out = '';
    for (const p of this.particles) {
      const col = Math.round(p.x) + offsetCol;
      const row = Math.round(p.y) + offsetRow;
      if (row >= 1 && col >= 1 && row < process.stdout.rows && col < process.stdout.columns) {
        const fade = Math.min(1, p.life / (p.maxLife * 0.3));
        const color = dimColor(accentColor, fade);
        out += ansi.to(row, col) + ansi.fg(...color) + p.char;
      }
    }
    return out;
  }
}

// -- ClaudeFace (single face) --------------------------------------
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

    // Timeline
    this.timeline = [{ state: 'idle', at: Date.now() }];
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

    // Detect milestone
    if (data.milestone && (!this.milestone || data.milestone.at !== this.milestone.at)) {
      this.milestone = data.milestone;
      this.milestoneShowTime = 180; // ~12 seconds at 15fps
      this.particles.spawn(15, 'sparkle');
    }
  }

  _updateThought() {
    if (this.state === 'sleeping') {
      this.thoughtText = '';
    } else if (this.state === 'idle') {
      // Sometimes hide (flicker effect)
      if (Math.random() < 0.25) { this.thoughtText = ''; return; }
      this.thoughtText = IDLE_THOUGHTS[this.thoughtIndex % IDLE_THOUGHTS.length];
    } else if (this.state === 'happy' && this.milestone && this.milestoneShowTime > 0) {
      this.thoughtText = '';
    } else if (this.state === 'error' && this.lastBrokenStreak > 10) {
      this.thoughtText = `...${this.lastBrokenStreak} streak gone`;
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

  getTheme() {
    return themes[this.state] || themes.idle;
  }

  getEyes(theme, frame) {
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

    // Thought bubble cycling
    this.thoughtTimer += dt;
    if (this.thoughtTimer > 4000) {
      this.thoughtTimer = 0;
      this.thoughtIndex++;
      this._updateThought();
    }

    // Milestone display decay
    if (this.milestoneShowTime > 0) this.milestoneShowTime--;

    this.particles.update();
  }

  render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const theme = this.getTheme();

    const breathTime = this.state === 'sleeping' ? this.time * 0.5
      : this.state === 'caffeinated' ? this.time * 2.5
      : this.time;
    const borderColor = breathe(theme.border, breathTime);
    const eyeColor = theme.eye;
    const mouthColor = theme.mouth;

    const faceW = 30;
    const faceH = 10;
    const totalH = faceH + 12; // face + status/detail + thought bubble above + streak/timeline below

    const startCol = Math.max(1, Math.floor((cols - faceW) / 2));
    const startRow = Math.max(5, Math.floor((rows - totalH) / 2) + 4);

    const fc = ansi.fg(...borderColor);
    const ec = ansi.fg(...eyeColor);
    const mc = ansi.fg(...mouthColor);
    const r = ansi.reset;

    const eyeData = this.getEyes(theme, this.frame);
    const mouthStr = this.getMouth(theme, this.frame);

    // Glitch / caffeinated horizontal jitter
    let gx = (this.state === 'error' && this.glitchIntensity > 0.3 && Math.random() < 0.15)
      ? Math.floor(Math.random() * 3) - 1 : 0;
    if (this.state === 'caffeinated' && this.frame % 2 === 0) {
      gx = Math.floor(Math.random() * 3) - 1;
    }

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

    // Status line
    const emoji = theme.emoji;
    const statusText = `${emoji}  claude is ${theme.status}  ${emoji}`;
    const statusPad = Math.floor((faceW - statusText.length) / 2) + 4;
    buf += ansi.to(startRow + 9, startCol);
    buf += `${ansi.fg(...theme.label)}${' '.repeat(Math.max(0, statusPad))}${statusText}${r}`;

    // Detail line
    if (this.stateDetail) {
      const detailText = this.stateDetail.length > faceW + 4
        ? this.stateDetail.slice(0, faceW + 1) + '...'
        : this.stateDetail;
      const detailPad = Math.floor((faceW - detailText.length) / 2) + 4;
      buf += ansi.to(startRow + 10, startCol);
      buf += `${ansi.dim}${ansi.fg(...dimColor(theme.label, 0.6))}${' '.repeat(Math.max(0, detailPad))}${detailText}${r}`;
    }

    // Thought bubble (above face, right of center)
    if (this.thoughtText && startRow >= 5) {
      const txt = this.thoughtText;
      const bubbleInner = txt.length + 2;
      const bubbleLeft = startCol + Math.floor(faceW / 2);
      const bc = ansi.fg(...dimColor(theme.accent, 0.5));
      const tc = `${ansi.italic}${ansi.fg(...dimColor(theme.label, 0.7))}`;

      if (bubbleLeft + bubbleInner + 2 < cols) {
        buf += ansi.to(startRow - 4, bubbleLeft);
        buf += `${bc}\u256d${'\u2500'.repeat(bubbleInner)}\u256e${r}`;
        buf += ansi.to(startRow - 3, bubbleLeft);
        buf += `${bc}\u2502 ${tc}${txt}${r} ${bc}\u2502${r}`;
        buf += ansi.to(startRow - 2, bubbleLeft);
        buf += `${bc}\u2570${'\u2500'.repeat(bubbleInner)}\u256f${r}`;
        buf += ansi.to(startRow - 1, bubbleLeft + 2);
        buf += `${bc}\u25cb${r}`;
      }
    }

    // Streak counter
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
        const streakPad = Math.floor((faceW - streakText.length) / 2) + 4;
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
        const spad = Math.floor((faceW - severity.length) / 2) + 4;
        buf += ansi.to(startRow + 12, startCol);
        buf += `${ansi.fg(230, 80, 80)}${' '.repeat(Math.max(0, spad))}${severity}${r}`;
      }
    }

    // Session timeline bar
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
          const color = TIMELINE_COLORS[st] || TIMELINE_COLORS.idle;
          bar += ansi.fg(...color) + '\u2588';
        }
        const barPad = Math.floor((faceW - barWidth) / 2) + 4;
        buf += ansi.to(startRow + 13, startCol + barPad) + bar + r;
      }
    }

    // Particles (drawn on top of face)
    buf += this.particles.render(startRow - 2, startCol - 5, theme.accent);
    buf += r;

    return buf;
  }
}

// ===================================================================
// GRID MODE
// ===================================================================

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

  render(startRow, startCol, globalTime) {
    const theme = themes[this.state] || themes.idle;
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

      buf += faces[i].render(faceRow, faceCol, this.time);
    }

    // Session count
    const countText = `${n} session${n === 1 ? '' : 's'}`;
    buf += ansi.to(1, cols - countText.length - 1);
    buf += `${ansi.dim}${ansi.fg(80, 110, 140)}${countText}${ansi.reset}`;

    return buf;
  }
}

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

  process.stdout.on('resize', () => {
    process.stdout.write(ansi.clear);
  });
}

main();
