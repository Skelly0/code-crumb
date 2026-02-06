#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face -- A tamagotchi for Claude Code                    |
// |  Shows what Claude is doing with an animated terminal face      |
// +================================================================+

const fs = require('fs');
const path = require('path');

// -- Config --------------------------------------------------------
const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const STATE_FILE = process.env.CLAUDE_FACE_STATE || path.join(HOME, '.claude-face-state');
const FPS = 15;
const FRAME_MS = Math.floor(1000 / FPS);
const BLINK_MIN = 2500;
const BLINK_MAX = 6000;
const BLINK_FRAMES = 3; // ~200ms at 15fps
const BREATH_PERIOD = 4000; // full breath cycle in ms
const PARTICLE_SPEED = 0.06;
const IDLE_TIMEOUT = 8000; // ms before returning to idle after last state change
const SLEEP_TIMEOUT = 60000; // ms of idle before drifting to sleep
const CAFFEINE_WINDOW = 10000; // track state changes in this window
const CAFFEINE_THRESHOLD = 5; // this many changes = caffeinated

// -- ANSI Helpers --------------------------------------------------
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

// -- Color Utilities -----------------------------------------------
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
  // Sinusoidal brightness pulse
  const t = (Math.sin(time * Math.PI * 2 / BREATH_PERIOD) + 1) / 2;
  const factor = 0.65 + t * 0.35;
  return dimColor(color, factor);
}

// -- Themes --------------------------------------------------------
const themes = {
  idle: {
    border:  [100, 160, 210],
    eye:     [180, 220, 255],
    mouth:   [140, 190, 230],
    accent:  [80, 130, 180],
    label:   [120, 170, 210],
    status:  'idle',
    emoji:   '\u00b7',
  },
  thinking: {
    border:  [170, 110, 220],
    eye:     [210, 180, 255],
    mouth:   [160, 120, 200],
    accent:  [200, 140, 255],
    label:   [180, 130, 230],
    status:  'thinking',
    emoji:   '\u25c6',
  },
  coding: {
    border:  [70, 190, 110],
    eye:     [150, 240, 180],
    mouth:   [100, 200, 140],
    accent:  [90, 210, 130],
    label:   [80, 200, 120],
    status:  'writing code',
    emoji:   '\u25aa',
  },
  reading: {
    border:  [100, 180, 180],
    eye:     [160, 220, 220],
    mouth:   [120, 190, 190],
    accent:  [80, 200, 200],
    label:   [110, 190, 190],
    status:  'reading',
    emoji:   '\u25cb',
  },
  searching: {
    border:  [210, 190, 70],
    eye:     [250, 240, 150],
    mouth:   [200, 180, 90],
    accent:  [230, 210, 100],
    label:   [220, 200, 80],
    status:  'searching',
    emoji:   '\u25c7',
  },
  executing: {
    border:  [210, 150, 70],
    eye:     [250, 210, 150],
    mouth:   [200, 160, 100],
    accent:  [230, 170, 90],
    label:   [220, 160, 80],
    status:  'running command',
    emoji:   '\u25b8',
  },
  happy: {
    border:  [220, 200, 60],
    eye:     [255, 250, 150],
    mouth:   [230, 210, 90],
    accent:  [255, 240, 100],
    label:   [240, 220, 80],
    status:  'done!',
    emoji:   '\u2726',
  },
  error: {
    border:  [210, 70, 70],
    eye:     [255, 150, 150],
    mouth:   [200, 100, 100],
    accent:  [230, 90, 90],
    label:   [220, 90, 90],
    status:  'hit a snag',
    emoji:   '\u00d7',
  },
  sleeping: {
    border:  [60, 50, 110],
    eye:     [90, 80, 150],
    mouth:   [70, 60, 120],
    accent:  [110, 90, 170],
    label:   [80, 70, 140],
    status:  'sleeping',
    emoji:   'z',
  },
  waiting: {
    border:  [150, 140, 180],
    eye:     [190, 180, 220],
    mouth:   [160, 150, 190],
    accent:  [180, 170, 210],
    label:   [160, 150, 190],
    status:  'waiting',
    emoji:   '?',
  },
  testing: {
    border:  [180, 200, 70],
    eye:     [220, 240, 130],
    mouth:   [190, 210, 100],
    accent:  [200, 220, 90],
    label:   [190, 210, 80],
    status:  'running tests',
    emoji:   '\u29eb',
  },
  installing: {
    border:  [70, 160, 190],
    eye:     [130, 200, 230],
    mouth:   [100, 170, 200],
    accent:  [90, 180, 210],
    label:   [80, 170, 200],
    status:  'installing',
    emoji:   '\u25bc',
  },
  caffeinated: {
    border:  [255, 180, 50],
    eye:     [255, 220, 100],
    mouth:   [240, 190, 70],
    accent:  [255, 200, 80],
    label:   [250, 190, 60],
    status:  'hyperdrive!',
    emoji:   '\u25c9',
  },
  subagent: {
    border:  [150, 100, 210],
    eye:     [190, 160, 240],
    mouth:   [140, 110, 200],
    accent:  [180, 130, 230],
    label:   [160, 120, 220],
    status:  'spawning',
    emoji:   '\u25c8',
  },
};

// -- Face Components -----------------------------------------------

// Eyes: each is a function(theme, frame, state) => { left: [top, bot], right: [top, bot] }
const eyes = {
  open(theme, frame) {
    return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
  },

  blink(theme, frame) {
    return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] };
  },

  halfClose(theme, frame) {
    return { left: ['\u2580\u2580', '  '], right: ['\u2580\u2580', '  '] };
  },

  narrowed(theme, frame) {
    return { left: ['\u2500\u2500', '\u2500\u2500'], right: ['\u2500\u2500', '\u2500\u2500'] };
  },

  focused(theme, frame) {
    return { left: ['\u2584\u2584', '\u2580\u2580'], right: ['\u2584\u2584', '\u2580\u2580'] };
  },

  lookLeft(theme, frame) {
    return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588 ', '\u2588 '] };
  },

  lookRight(theme, frame) {
    return { left: [' \u2588', ' \u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
  },

  sparkle(theme, frame) {
    const chars = ['\u2726 ', ' \u2726', '\u2727 ', ' \u2727'];
    const i = frame % chars.length;
    return { left: [chars[i], chars[(i + 1) % chars.length]], right: [chars[(i + 2) % chars.length], chars[(i + 3) % chars.length]] };
  },

  cross(theme, frame) {
    return { left: ['\u2572\u2571', '\u2571\u2572'], right: ['\u2572\u2571', '\u2571\u2572'] };
  },

  glitch(theme, frame) {
    const glitchChars = ['\u2588\u2593', '\u2593\u2591', '\u2591\u2592', '\u2592\u2588', '\u2593\u2593', '\u2591\u2591', '\u2588\u2588', '\u2592\u2593'];
    const i = Math.floor(Math.random() * glitchChars.length);
    const j = Math.floor(Math.random() * glitchChars.length);
    return {
      left:  [glitchChars[i], glitchChars[j]],
      right: [glitchChars[(i+3) % glitchChars.length], glitchChars[(j+2) % glitchChars.length]],
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

  wide(theme, frame) {
    return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
  },

  sleeping(theme, frame) {
    // Closed lines with occasional flutter
    if (frame % 150 > 145) {
      return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] };
    }
    return { left: ['  ', '\u2500\u2500'], right: ['  ', '\u2500\u2500'] };
  },

  waiting(theme, frame) {
    // Half-lidded, slowly drifting gaze
    const drift = Math.floor(frame / 40) % 3;
    if (drift === 1) return { left: ['\u2584\u2584', '\u2588 '], right: ['\u2584\u2584', ' \u2588'] };
    return { left: ['\u2584\u2584', '\u2588\u2588'], right: ['\u2584\u2584', '\u2588\u2588'] };
  },

  intense(theme, frame) {
    // Wide stare with nervous twitch
    if (frame % 25 < 2) {
      return { left: ['\u2588\u2588', '\u2580\u2580'], right: ['\u2580\u2580', '\u2588\u2588'] };
    }
    return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
  },

  down(theme, frame) {
    // Looking downward
    return { left: ['  ', '\u2584\u2584'], right: ['  ', '\u2584\u2584'] };
  },

  vibrate(theme, frame) {
    // Rapid jitter between positions
    const j = frame % 3;
    if (j === 0) return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
    if (j === 1) return { left: [' \u2588', '\u2588 '], right: ['\u2588 ', ' \u2588'] };
    return { left: ['\u2588 ', ' \u2588'], right: [' \u2588', '\u2588 '] };
  },

  echo(theme, frame) {
    // Normal eyes (ghost effect comes from particles)
    return { left: ['\u2588\u2588', '\u2588\u2588'], right: ['\u2588\u2588', '\u2588\u2588'] };
  },
};

// Mouths: function(theme, frame) => string (centered in face)
const mouths = {
  smile:      () => '\u25e1\u25e1\u25e1',
  neutral:    () => '\u2500\u2500\u2500',
  wide:       () => '\u25e1\u25e1\u25e1\u25e1\u25e1',
  curious:    () => ' \u25cb ',
  frown:      () => '\u25e0\u25e0\u25e0',
  smirk:      () => '  \u25e1\u25e1',
  ooh:        () => ' \u25ef ',
  determined: () => '\u2550\u2550\u2550',
  glitch: (frame) => {
    const ms = ['\u25e1\u25e0\u25e1', '\u25e0\u25e1\u25e0', '\u2550\u25e1\u2550', '\u25e1\u2550\u25e1', '\u2500\u25e1\u2500', '\u25e1\u2500\u25e1'];
    return ms[Math.floor(Math.random() * ms.length)];
  },
  wavy:       () => '\uff5e\uff5e\uff5e',
  wait:       () => '\u2500\u2500\u2500',
  tight:      () => '\u2550\u2550\u2550',
  dots:       () => '\u00b7\u00b7\u00b7',
  grin:       () => '\u25aa\u25e1\u25aa',
  calm:       () => ' \u25e1\u25e1',
};

// -- Particles -----------------------------------------------------

class ParticleSystem {
  constructor() {
    this.particles = [];
    this.width = 40;
    this.height = 14;
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
          vx: 0,
          vy: 0,
          life: 3 + Math.random() * 8,
          maxLife: 11,
          char: ['\u2593', '\u2591', '\u2592', '\u2588', '\u2573', '\u256c'][Math.floor(Math.random() * 6)],
          style,
        });
      } else if (style === 'orbit') {
        const angle = Math.random() * Math.PI * 2;
        this.particles.push({
          x: 0, y: 0,
          angle,
          radius: 10 + Math.random() * 5,
          speed: 0.03 + Math.random() * 0.03,
          life: 80 + Math.random() * 60,
          maxLife: 140,
          char: ['\u25c6', '\u25c7', '\u00b7', '\u2022'][Math.floor(Math.random() * 4)],
          style,
        });
      } else if (style === 'zzz') {
        // Zzz floating upward and to the right
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
        // ? gently floating above
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
        // Sweat drops falling from forehead area
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
        // Dots raining down like packages
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
        // Horizontal speed lines shooting outward
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
        // Ghost face outline fragments
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

// -- Main Renderer -------------------------------------------------

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
    this.lookDir = 0; // -1 left, 0 center, 1 right (for searching)
    this.lookTimer = 0;
    this.transitionFrame = 0;
    this.glitchIntensity = 0;
    this.stateChangeTimes = []; // for caffeinated detection
    this.isCaffeinated = false;
  }

  _nextBlink() {
    return BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
  }

  setState(newState, detail = '') {
    if (newState !== this.state) {
      this.prevState = this.state;
      this.state = newState;
      this.transitionFrame = 0;
      this.lastStateChange = Date.now();
      this.stateDetail = detail;

      // Track state changes for caffeinated detection
      this.stateChangeTimes.push(Date.now());
      if (this.stateChangeTimes.length > 20) this.stateChangeTimes.shift();

      // Spawn appropriate particles
      if (newState === 'happy') {
        this.particles.spawn(12, 'sparkle');
      } else if (newState === 'error') {
        this.particles.spawn(8, 'glitch');
        this.glitchIntensity = 1.0;
      } else if (newState === 'thinking') {
        this.particles.spawn(6, 'orbit');
      } else if (newState === 'subagent') {
        this.particles.spawn(8, 'echo');
      } else if (newState === 'sleeping') {
        // Gentle initial zzz
      } else if (newState === 'caffeinated') {
        this.particles.spawn(6, 'speedline');
      }
    } else {
      this.lastStateChange = Date.now();
      this.stateDetail = detail;
    }
  }

  getTheme() {
    return themes[this.state] || themes.idle;
  }

  getEyes(theme, frame) {
    // Handle blinking (overrides state eyes)
    if (this.blinkFrame >= 0 && this.blinkFrame < BLINK_FRAMES) {
      return eyes.blink(theme, frame);
    }

    switch (this.state) {
      case 'idle':
        return eyes.open(theme, frame);

      case 'thinking': {
        const thinkFrame = Math.floor(frame / 4);
        return eyes.spin(theme, thinkFrame);
      }

      case 'coding':
        return eyes.focused(theme, frame);

      case 'reading':
        return eyes.narrowed(theme, frame);

      case 'searching': {
        if (this.lookDir < 0) return eyes.lookLeft(theme, frame);
        if (this.lookDir > 0) return eyes.lookRight(theme, frame);
        return eyes.wide(theme, frame);
      }

      case 'executing':
        return eyes.open(theme, frame);

      case 'happy':
        return eyes.sparkle(theme, frame);

      case 'error': {
        if (this.glitchIntensity > 0.3 && Math.random() < this.glitchIntensity * 0.4) {
          return eyes.glitch(theme, frame);
        }
        return eyes.cross(theme, frame);
      }

      case 'sleeping':
        return eyes.sleeping(theme, frame);

      case 'waiting':
        return eyes.waiting(theme, frame);

      case 'testing':
        return eyes.intense(theme, frame);

      case 'installing':
        return eyes.down(theme, frame);

      case 'caffeinated':
        return eyes.vibrate(theme, frame);

      case 'subagent':
        return eyes.echo(theme, frame);

      default:
        return eyes.open(theme, frame);
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
      case 'error':
        if (this.glitchIntensity > 0.2 && Math.random() < 0.3) {
          return mouths.glitch(frame);
        }
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

    // Blink timer
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkFrame = 0;
      this.blinkTimer = this._nextBlink();
    }
    if (this.blinkFrame >= 0) {
      this.blinkFrame++;
      if (this.blinkFrame >= BLINK_FRAMES) {
        this.blinkFrame = -1;
      }
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

    // Spawn thinking particles continuously
    if (this.state === 'thinking' && this.frame % 15 === 0) {
      this.particles.spawn(1, 'orbit');
    }

    // Spawn idle float particles occasionally
    if (this.state === 'idle' && this.frame % 40 === 0) {
      this.particles.spawn(1, 'float');
    }

    // Spawn error glitch particles
    if (this.state === 'error' && this.glitchIntensity > 0.1 && this.frame % 5 === 0) {
      this.particles.spawn(1, 'glitch');
    }

    // Happy sparkle burst
    if (this.state === 'happy' && this.frame % 20 === 0) {
      this.particles.spawn(2, 'sparkle');
    }

    // Sleeping Zzz particles
    if (this.state === 'sleeping' && this.frame % 30 === 0) {
      this.particles.spawn(1, 'zzz');
    }

    // Waiting ? particles
    if (this.state === 'waiting' && this.frame % 45 === 0) {
      this.particles.spawn(1, 'question');
    }

    // Testing sweat drops
    if (this.state === 'testing' && this.frame % 12 === 0) {
      this.particles.spawn(1, 'sweat');
    }

    // Installing falling packages
    if (this.state === 'installing' && this.frame % 8 === 0) {
      this.particles.spawn(1, 'falling');
    }

    // Caffeinated speed lines
    if (this.state === 'caffeinated' && this.frame % 4 === 0) {
      this.particles.spawn(1, 'speedline');
    }

    // Subagent echo fragments
    if (this.state === 'subagent' && this.frame % 10 === 0) {
      this.particles.spawn(1, 'echo');
    }

    // Caffeinated detection: 5+ state changes in last 10s
    const now = Date.now();
    const recentChanges = this.stateChangeTimes.filter(t => now - t < CAFFEINE_WINDOW);
    if (recentChanges.length >= CAFFEINE_THRESHOLD &&
        this.state !== 'idle' && this.state !== 'sleeping' &&
        this.state !== 'happy' && this.state !== 'error' &&
        this.state !== 'caffeinated') {
      this.isCaffeinated = true;
      this.prevState = this.state;
      this.state = 'caffeinated';
      this.stateDetail = this.stateDetail || 'hyperdrive!';
      this.particles.spawn(4, 'speedline');
    } else if (this.state === 'caffeinated' && recentChanges.length < CAFFEINE_THRESHOLD - 1) {
      // Drop out of caffeinated when things calm down
      this.isCaffeinated = false;
    }

    this.particles.update();
  }

  render() {
    const cols = process.stdout.columns || 80;
    const rows = process.stdout.rows || 24;
    const theme = this.getTheme();

    // Breathing border color (slower for sleeping, faster for caffeinated)
    const breathTime = this.state === 'sleeping' ? this.time * 0.5
      : this.state === 'caffeinated' ? this.time * 2.5
      : this.time;
    const borderColor = breathe(theme.border, breathTime);
    const eyeColor = theme.eye;
    const mouthColor = theme.mouth;

    // Face dimensions
    const faceW = 30;
    const faceH = 10;
    const totalH = faceH + 4;

    // Center position
    const startCol = Math.max(1, Math.floor((cols - faceW) / 2));
    const startRow = Math.max(1, Math.floor((rows - totalH) / 2));

    const fc = ansi.fg(...borderColor);
    const ec = ansi.fg(...eyeColor);
    const mc = ansi.fg(...mouthColor);
    const r = ansi.reset;

    // Get face components
    const eyeData = this.getEyes(theme, this.frame);
    const mouthStr = this.getMouth(theme, this.frame);

    // Glitch offset for error state
    let gx = (this.state === 'error' && this.glitchIntensity > 0.3 && Math.random() < 0.15)
      ? Math.floor(Math.random() * 3) - 1 : 0;
    // Caffeinated jitter
    if (this.state === 'caffeinated' && this.frame % 2 === 0) {
      gx = Math.floor(Math.random() * 3) - 1;
    }

    // Build face lines
    let buf = '';

    // Top border
    buf += ansi.to(startRow, startCol + gx);
    buf += `${fc}    \u256d${'\u2500'.repeat(faceW - 10)}\u256e${r}`;

    // Row 1: empty
    buf += ansi.to(startRow + 1, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(faceW - 10)}\u2502${r}`;

    // Row 2: eyes top
    const eyePad = 4;
    const eyeGap = 8;
    buf += ansi.to(startRow + 2, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(eyePad)}${ec}${eyeData.left[0]}${r}${' '.repeat(eyeGap)}${ec}${eyeData.right[0]}${r}`;
    const used2 = eyePad + 2 + eyeGap + 2;
    buf += `${' '.repeat(faceW - 10 - used2)}${fc}\u2502${r}`;

    // Row 3: eyes bottom
    buf += ansi.to(startRow + 3, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(eyePad)}${ec}${eyeData.left[1]}${r}${' '.repeat(eyeGap)}${ec}${eyeData.right[1]}${r}`;
    buf += `${' '.repeat(faceW - 10 - used2)}${fc}\u2502${r}`;

    // Row 4: empty
    buf += ansi.to(startRow + 4, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(faceW - 10)}\u2502${r}`;

    // Row 5: mouth
    const mouthPad = Math.floor((faceW - 10 - mouthStr.length) / 2);
    buf += ansi.to(startRow + 5, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(mouthPad)}${mc}${mouthStr}${r}`;
    buf += `${' '.repeat(faceW - 10 - mouthPad - mouthStr.length)}${fc}\u2502${r}`;

    // Row 6: empty
    buf += ansi.to(startRow + 6, startCol + gx);
    buf += `${fc}    \u2502${' '.repeat(faceW - 10)}\u2502${r}`;

    // Bottom border
    buf += ansi.to(startRow + 7, startCol + gx);
    buf += `${fc}    \u2570${'\u2500'.repeat(faceW - 10)}\u256f${r}`;

    // Status line
    const emoji = theme.emoji;
    const statusText = `${emoji}  claude is ${theme.status}  ${emoji}`;
    const statusPad = Math.floor((faceW - statusText.length) / 2) + 4;
    buf += ansi.to(startRow + 9, startCol);
    buf += `${ansi.fg(...theme.label)}${' '.repeat(Math.max(0, statusPad))}${statusText}${r}`;

    // Detail line (tool name, command, etc.)
    if (this.stateDetail) {
      const detailText = this.stateDetail.length > faceW + 4
        ? this.stateDetail.slice(0, faceW + 1) + '...'
        : this.stateDetail;
      const detailPad = Math.floor((faceW - detailText.length) / 2) + 4;
      buf += ansi.to(startRow + 10, startCol);
      buf += ansi.clearLine;
      buf += `${ansi.dim}${ansi.fg(...dimColor(theme.label, 0.6))}${' '.repeat(Math.max(0, detailPad))}${detailText}${r}`;
    } else {
      buf += ansi.to(startRow + 10, startCol);
      buf += ansi.clearLine;
    }

    // Particles
    buf += this.particles.render(startRow - 2, startCol - 5, theme.accent);

    // Reset
    buf += r;

    return buf;
  }
}

// -- State File Watcher --------------------------------------------

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (!raw) return { state: 'idle', detail: '' };
    const data = JSON.parse(raw);
    return {
      state: data.state || 'idle',
      detail: data.detail || '',
      timestamp: data.timestamp || 0,
    };
  } catch {
    return { state: 'idle', detail: '' };
  }
}

// -- Entry Point ---------------------------------------------------

const PID_FILE = path.join(HOME, '.claude-face.pid');

function isAlreadyRunning() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (isNaN(pid)) return false;
    process.kill(pid, 0); // signal 0 = just check if alive
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

function main() {
  // Single-instance guard
  if (isAlreadyRunning()) {
    console.log('Claude Face is already running in another window.');
    process.exit(0);
  }
  writePid();

  const face = new ClaudeFace();

  // Clean up on exit
  function cleanup() {
    removePid();
    process.stdout.write(ansi.show + ansi.clear + ansi.reset);
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  // SIGHUP doesn't exist on Windows -- guard it
  try { process.on('SIGHUP', cleanup); } catch {}
  process.on('exit', removePid);

  // Hide cursor, clear screen
  process.stdout.write(ansi.hide + ansi.clear);

  // Watch state file
  let lastMtime = 0;
  function checkState() {
    try {
      const stat = fs.statSync(STATE_FILE);
      if (stat.mtimeMs > lastMtime) {
        lastMtime = stat.mtimeMs;
        const { state, detail } = readState();
        face.setState(state, detail);
      }
    } catch {
      // File doesn't exist yet, that's fine
    }

    // Auto-return to idle after timeout (but not sleeping or waiting)
    if (face.state !== 'idle' && face.state !== 'happy' &&
        face.state !== 'sleeping' && face.state !== 'waiting' &&
        Date.now() - face.lastStateChange > IDLE_TIMEOUT) {
      face.setState('idle');
    }
    // Happy state returns to idle after a shorter period
    if (face.state === 'happy' && Date.now() - face.lastStateChange > 4000) {
      face.setState('idle');
    }
    // Idle for 60s+ => drift to sleeping
    if (face.state === 'idle' && Date.now() - face.lastStateChange > SLEEP_TIMEOUT) {
      face.setState('sleeping');
    }
  }

  // Initial state
  checkState();

  // Also try to use fs.watch for immediate updates
  try {
    const dir = path.dirname(STATE_FILE);
    const basename = path.basename(STATE_FILE);
    fs.watch(dir, (eventType, filename) => {
      if (filename === basename) {
        checkState();
      }
    });
  } catch {
    // Fallback: just poll
  }

  // Title
  process.stdout.write(`\x1b]0;Claude Face\x07`);

  // Main render loop
  let lastTime = Date.now();
  function loop() {
    const now = Date.now();
    const dt = now - lastTime;
    lastTime = now;

    face.update(dt);

    // Poll state file every ~500ms as backup to fs.watch
    if (face.frame % (FPS / 2) === 0) {
      checkState();
    }

    const buf = face.render();
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
