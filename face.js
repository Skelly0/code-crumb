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
} = require('./themes');
const { eyes, mouths } = require('./animations');
const { ParticleSystem } = require('./particles');

// -- Config --------------------------------------------------------
const BLINK_MIN = 2500;
const BLINK_MAX = 6000;
const BLINK_FRAMES = 3;
const CAFFEINE_WINDOW = 10000;
const CAFFEINE_THRESHOLD = 5;
const MIN_COLS_SINGLE = 38;
const MIN_ROWS_SINGLE = 20;

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

    const breathTime = this.state === 'sleeping' ? this.time * 0.5
      : this.state === 'caffeinated' ? this.time * 2.5
      : this.time;
    const borderColor = breathe(theme.border, breathTime);
    const eyeColor = theme.eye;
    const mouthColor = theme.mouth;

    const faceW = 30;
    const faceH = 10;
    const totalH = faceH + 13; // face + status/detail + thought bubble above + streak/timeline/sparkline below

    const startCol = Math.max(1, Math.floor((cols - faceW) / 2) + 1);
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

    // Particles (drawn on top of face)
    buf += this.particles.render(startRow - 2, startCol - 5, theme.accent);
    buf += r;

    return buf;
  }
}

module.exports = { ClaudeFace };
