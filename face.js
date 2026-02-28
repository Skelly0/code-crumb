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
  isNoColor,
} = require('./themes');
const path = require('path');
const { eyes, mouths } = require('./animations');
const { ParticleSystem } = require('./particles');
const { getAccessory } = require('./accessories');

// Active tool states that represent real work happening NOW.
// These bypass the min display time of passive/thinking/completion states,
// mirroring how 'error' and 'ratelimited' already bypass.
const ACTIVE_WORK_STATES = new Set([
  'executing', 'coding', 'reading', 'searching', 'testing',
  'installing', 'committing', 'reviewing', 'subagent', 'responding',
]);
// Low-activity states used for timeline compression and consecutive-entry capping
const LOW_ACTIVITY_STATES = new Set(['idle', 'sleeping', 'waiting']);

// Max visual duration (ms) for any single low-activity gap in the timeline bar
const COMPRESS_LOW_CAP = 30000;

const INTERRUPTIBLE_STATES = new Set([
  'thinking', 'happy', 'satisfied', 'proud', 'relieved',
  'idle', 'sleeping', 'waiting',
]);
const COMPLETION_STATES = new Set(['happy', 'satisfied', 'proud', 'relieved']);
// Minimum ms a completion state must be visible before a work state can bypass it.
// Prevents the "satisfied flicker" where work immediately swallows the reward face.
const COMPLETION_MIN_SHOW_MS = 500;

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

    // Orbital subagents
    this.showOrbitals = true;
    this.subagentCount = 0;
    this.lastPos = null;

    // Minimal mode (--minimal flag: face + status only, no chrome)
    this.minimalMode = false;

    // Model name (shown in status line: "{name} is thinking")
    this.modelName = process.env.CODE_CRUMB_MODEL || 'claude';

    // Git context
    this.cwd = null;
    this.isWorktree = false;
    this.gitBranch = null;
    this.commitCount = 0;
  }

  _nextBlink() {
    return BLINK_MIN + Math.random() * (BLINK_MAX - BLINK_MIN);
  }

  _getMinDisplayMs(state) {
    const times = {
      happy: 4000, proud: 4500, satisfied: 2500, relieved: 2500,
      error: 4000, coding: 6000, thinking: 2500, responding: 3000, reading: 4000,
      searching: 4000, executing: 4000, testing: 4000, installing: 4000,
      caffeinated: 2500, subagent: 4000, waiting: 1500, sleeping: 1000,
      starting: 1500, spawning: 4000, committing: 3500, reviewing: 3500, ratelimited: 5000,
    };
    return times[state] || 1000;
  }

  setState(newState, detail = '') {
    if (newState !== this.state) {
      const now = Date.now();

      // Minimum display time: buffer incoming state if current hasn't shown long enough.
      // Errors and rate limits always bypass -- critical feedback.
      //
      // Anti-flicker rules (Fix #96 follow-up):
      //   1. Work states bypass completion states, BUT only after COMPLETION_MIN_SHOW_MS
      //      so the reward face isn't swallowed in a single frame.
      //   2. Completion states do NOT bypass active work states -- they queue behind work
      //      and show once the current tool finishes, preventing satisfied→reading→satisfied
      //      oscillation on fast tool sequences.
      //   3. update() flushes a buffered work state early once the completion window passes.
      const completionAge = now - this.lastStateChange;
      const shouldBypass = ACTIVE_WORK_STATES.has(newState)
          && INTERRUPTIBLE_STATES.has(this.state)
          && (!COMPLETION_STATES.has(this.state) || completionAge >= COMPLETION_MIN_SHOW_MS);

      // Completion states are buffered (not bypassed) when work is actively running.
      const isCompletionDuringWork = COMPLETION_STATES.has(newState) && ACTIVE_WORK_STATES.has(this.state);

      const shouldBuffer = now < this.minDisplayUntil
          && newState !== 'error'
          && newState !== 'ratelimited'
          && (!COMPLETION_STATES.has(newState) || isCompletionDuringWork)
          && !shouldBypass;

      if (shouldBuffer) {
        // Errors are never overwritten. Completions protect against mundane overwrites
        // (e.g. idle shouldn't displace a pending satisfied), but yield to newer completions.
        const pendingIsProtected = this.pendingState === 'error'
            || (COMPLETION_STATES.has(this.pendingState) && !COMPLETION_STATES.has(newState) && newState !== 'error');
        if (!pendingIsProtected) {
          this.pendingState = newState;
          this.pendingDetail = detail;
        }
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

      // Track timeline (cap consecutive idle/sleeping to prevent bar domination)
      const MAX_CONSECUTIVE_LOW = 3;
      if (LOW_ACTIVITY_STATES.has(newState)) {
        let consecutive = 0;
        for (let i = this.timeline.length - 1; i >= 0; i--) {
          if (this.timeline[i].state === newState) consecutive++;
          else break;
        }
        if (consecutive < MAX_CONSECUTIVE_LOW) {
          this.timeline.push({ state: newState, at: Date.now() });
        }
      } else {
        this.timeline.push({ state: newState, at: Date.now() });
      }
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
      } else if (newState === 'responding') {
        this.particles.spawn(4, 'float');
      } else if (newState === 'subagent') {
        this.particles.spawn(8, 'stream');
      } else if (newState === 'caffeinated') {
        this.particles.spawn(6, 'speedline');
      } else if (newState === 'committing') {
        this.particles.spawn(14, 'push');
      } else if (newState === 'ratelimited') {
        this.particles.spawn(8, 'glitch');
        this.glitchIntensity = 1.0;
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
    // modelName priority: CODE_CRUMB_MODEL env var > state file value.
    // Lower layers (update-state.js guard, base-adapter.js guardedWriteState) preserve
    // the owner's name on disk; this layer ensures the env var always wins at render time.
    if (data.modelName && !process.env.CODE_CRUMB_MODEL) this.modelName = data.modelName;
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

    // Git context
    if (data.cwd) this.cwd = data.cwd;
    this.isWorktree = !!data.isWorktree;
    if (data.gitBranch) this.gitBranch = data.gitBranch;
    this.commitCount = data.commitCount || 0;

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
    } else if (this.state === 'error' && this.stateDetail === 'merge conflict!') {
      this.thoughtText = '<<<<<<< HEAD';
    } else if (this.state === 'error' && this.lastBrokenStreak > 10) {
      this.thoughtText = `...${this.lastBrokenStreak} streak gone`;
    } else if (this.state === 'committing') {
      const thoughts = STATE_THOUGHTS.committing;
      this.thoughtText = thoughts[this.thoughtIndex % thoughts.length];
    } else if (this.state === 'proud' && this.stateDetail === 'pushed!') {
      this.thoughtText = 'shipped!';
    } else if (this.state === 'proud' && this.stateDetail === 'committed') {
      this.thoughtText = 'committed!';
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
    } else if (this.state === 'starting') {
      this.thoughtText = '';
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
    if (isNoColor()) return;
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

  toggleOrbitals() {
    this.showOrbitals = !this.showOrbitals;
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
      case 'responding':  return eyes.responding(theme, frame);
      case 'coding':      return eyes.focused(theme, frame);
      case 'reading':     return eyes.narrowed(theme, frame);
      case 'searching':
        if (this.lookDir < 0) return eyes.lookLeft(theme, frame);
        if (this.lookDir > 0) return eyes.lookRight(theme, frame);
        return eyes.wide(theme, frame);
      case 'executing':   return eyes.open(theme, frame);
      case 'happy':       return this.petSpamLevel > 3 ? eyes.heart() : eyes.sparkle(theme, frame);
      case 'satisfied':   return eyes.content(theme, frame);
      case 'proud':       return eyes.pleased(theme, frame);
      case 'relieved':    return eyes.open(theme, frame);
      case 'error':
        if (this.glitchIntensity > 0.3 && Math.random() < this.glitchIntensity * 0.4) {
          return eyes.glitch(theme, frame);
        }
        return eyes.cross(theme, frame);
      case 'sleeping':    return frame % 200 < 20 ? eyes.tired() : eyes.sleeping(theme, frame);
      case 'waiting':     return eyes.waiting(theme, frame);
      case 'testing':     return eyes.intense(theme, frame);
      case 'installing':  return eyes.down(theme, frame);
      case 'caffeinated': return frame % 30 < 5 ? eyes.star(theme, frame) : eyes.vibrate(theme, frame);
      case 'subagent':    return eyes.conducting(theme, frame);
      case 'starting':    return eyes.spin(theme, Math.floor(frame / 4));
      case 'committing':  return eyes.focused(theme, frame);
      case 'reviewing':   return eyes.narrowed(theme, frame);
      case 'ratelimited': return eyes.cross(theme, frame);
      default:            return eyes.open(theme, frame);
    }
  }

  getMouth(theme, frame) {
    if (this.petSpamActive) {
      return this.petSpamLevel >= 2 ? mouths.grin() : mouths.wide();
    }
    if (this.petAfterglowTimer > 0) return mouths.catMouth();
    if (this.petTimer > 0) return mouths.catMouth();
    switch (this.state) {
      case 'idle':      return mouths.smile();
      case 'thinking':  return mouths.neutral();
      case 'responding': return mouths.responding();
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
      case 'subagent':    return mouths.conducting();
      case 'starting':    return mouths.dots();
      case 'committing':  return mouths.determined();
      case 'reviewing':   return mouths.neutral();
      case 'ratelimited': return mouths.frown();
      default:          return mouths.smile();
    }
  }

  update(dt) {
    this.time += dt;
    this.frame++;
    this.transitionFrame++;

    // Apply pending state if minimum display time has passed
    const nowMs = Date.now();
    if (this.pendingState && nowMs >= this.minDisplayUntil) {
      this.setState(this.pendingState, this.pendingDetail);
    } else if (this.pendingState
        && ACTIVE_WORK_STATES.has(this.pendingState)
        && COMPLETION_STATES.has(this.state)
        && nowMs - this.lastStateChange >= COMPLETION_MIN_SHOW_MS) {
      // Work state was buffered during the completion guaranteed window -- flush it early
      // now that the window has passed, so we don't sit on satisfied for 4 full seconds.
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
    if ((this.state === 'error' || this.state === 'ratelimited') && this.glitchIntensity > 0.1 && this.frame % 5 === 0) this.particles.spawn(1, 'glitch');
    if (this.state === 'happy' && this.frame % 20 === 0) this.particles.spawn(2, 'sparkle');
    if (this.state === 'proud' && this.frame % 30 === 0) this.particles.spawn(1, 'sparkle');
    if (this.state === 'satisfied' && this.frame % 50 === 0) this.particles.spawn(1, 'float');
    if (this.state === 'relieved' && this.frame % 45 === 0) this.particles.spawn(1, 'float');
    if (this.state === 'sleeping' && this.frame % 30 === 0) this.particles.spawn(1, 'zzz');
    if (this.state === 'waiting' && this.frame % 45 === 0) this.particles.spawn(1, 'question');
    if (this.state === 'testing' && this.frame % 12 === 0) this.particles.spawn(1, 'sweat');
    if (this.state === 'installing' && this.frame % 8 === 0) this.particles.spawn(1, 'falling');
    if (this.state === 'caffeinated' && this.frame % 4 === 0) this.particles.spawn(1, 'speedline');
    if (this.state === 'subagent' && this.frame % 8 === 0) this.particles.spawn(1, 'stream');
    if (this.state === 'responding' && this.frame % 18 === 0) this.particles.spawn(1, 'float');
    if (this.state === 'committing' && this.frame % 5 === 0) this.particles.spawn(2, 'push');
    if (this.state === 'coding' && this.frame % 6 === 0) this.particles.spawn(1, 'rain');

    // Caffeinated detection — triggers when 5+ state changes happen within 10s.
    // Routes through setState() for proper minDisplayUntil / lastStateChange tracking.
    // Excludes completion, idle, error, and post-stop states to prevent oscillation
    // (responding + caffeinated would feed stateChangeTimes indefinitely).
    const now = Date.now();
    const recentChanges = this.stateChangeTimes.filter(t => now - t < CAFFEINE_WINDOW);
    if (recentChanges.length >= CAFFEINE_THRESHOLD &&
        this.state !== 'idle' && this.state !== 'sleeping' &&
        this.state !== 'happy' && this.state !== 'satisfied' &&
        this.state !== 'proud' && this.state !== 'relieved' &&
        this.state !== 'error' && this.state !== 'caffeinated' &&
        this.state !== 'committing' && this.state !== 'responding' &&
        this.state !== 'ratelimited' && this.state !== 'waiting') {
      this.setState('caffeinated', this.stateDetail || 'hyperdrive!');
    } else if (this.state === 'caffeinated' && recentChanges.length < CAFFEINE_THRESHOLD - 1) {
      this.setState(this.prevState || 'idle');
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

  _compressTimeline(now) {
    if (this.timeline.length < 2) {
      return { entries: this.timeline.slice(), displayNow: now };
    }
    const entries = [{ state: this.timeline[0].state, at: this.timeline[0].at }];
    let offset = 0;
    for (let i = 1; i < this.timeline.length; i++) {
      const gap = this.timeline[i].at - this.timeline[i - 1].at;
      const prevState = this.timeline[i - 1].state;
      if (LOW_ACTIVITY_STATES.has(prevState) && gap > COMPRESS_LOW_CAP) {
        offset += gap - COMPRESS_LOW_CAP;
      }
      entries.push({ state: this.timeline[i].state, at: this.timeline[i].at - offset });
    }
    return { entries, displayNow: now - offset };
  }

  _buildSparkline(barWidth, now, compressed) {
    const tl = compressed ? compressed.entries : this.timeline;
    const effectiveNow = compressed ? compressed.displayNow : now;
    if (tl.length < 3) return null;
    const tlStart = tl[0].at;
    const totalDur = effectiveNow - tlStart;
    if (totalDur < 2000) return null;

    const buckets = new Array(barWidth).fill(0);
    const bucketDur = totalDur / barWidth;
    for (let i = 1; i < tl.length; i++) {
      const idx = Math.min(barWidth - 1, Math.floor((tl[i].at - tlStart) / bucketDur));
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
      ' a      toggle accessories',
      ' o      toggle subagents',
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

    // Store position for orbital system (bubble bounds added during thought bubble render)
    const activeAccessory = this.accessoriesEnabled ? getAccessory(this.state) : null;
    this.lastPos = {
      row: startRow, col: startCol,
      w: faceW, h: faceH,
      centerX: startCol + Math.floor(faceW / 2),
      centerY: startRow + Math.floor(faceH / 2),
      bubble: null,
      accessoriesActive: !!activeAccessory,
      accessoryHeight: activeAccessory ? activeAccessory.lines.length : 0,
    };

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
    if (this.accessoriesEnabled && !this.minimalMode) {
      const accessory = getAccessory(this.state);
      if (accessory) {
        const ac = ansi.fg(...dimColor(breathe(theme.accent, breathTime), 0.85));
        const lines = accessory.lines;
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineRow = startRow - lines.length + i;
          const lineCol = Math.max(1, startCol + Math.ceil((faceW - line.length) / 2) + gx);
          if (lineRow >= 1) {
            buf += ansi.to(lineRow, lineCol) + `${ac}${line}${r}`;
          }
        }
      }
    }

    // Status line
    const emoji = theme.emoji;
    let statusSuffix = '';
    if (this.state === 'subagent' && this.subagentCount > 0) {
      statusSuffix = ` ${this.subagentCount} subagent${this.subagentCount === 1 ? '' : 's'}`;
    }
    const statusText = `${emoji}  ${this.modelName} is ${theme.status}${statusSuffix}  ${emoji}`;
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
      buf += `${ansi.fg(...dimColor(theme.label, 0.65))}${' '.repeat(Math.max(0, detailPad))}${detailText}${r}`;
    }

    // Thought bubble (skipped in minimal mode)
    if (this.thoughtText && !this.minimalMode) {
      const bc = ansi.fg(...dimColor(theme.accent, 0.5));
      const tc = `${ansi.italic}${ansi.fg(...dimColor(theme.label, 0.7))}`;
      const hasAccessory = this.accessoriesEnabled && getAccessory(this.state);

      if (hasAccessory) {
        // Right-side bubble to avoid overlapping accessories above the face
        const boxRight = startCol + 5 + inner;
        const bubbleCol = boxRight + 4;
        const maxTextW = cols - bubbleCol - 4;

        if (maxTextW >= 6) {
          let txt = this.thoughtText;
          if (txt.length > maxTextW) txt = txt.slice(0, maxTextW - 3) + '...';
          const bubbleInner = txt.length + 2;

          buf += ansi.to(startRow + 2, bubbleCol);
          buf += `${bc}\u256d${'\u2500'.repeat(bubbleInner)}\u256e${r}`;
          buf += ansi.to(startRow + 3, boxRight + 2);
          buf += `${bc}\u25cb${r}`;
          buf += ansi.to(startRow + 3, bubbleCol);
          buf += `${bc}\u2502 ${tc}${txt}${r} ${bc}\u2502${r}`;
          buf += ansi.to(startRow + 4, bubbleCol);
          buf += `${bc}\u2570${'\u2500'.repeat(bubbleInner)}\u256f${r}`;
          this.lastPos.bubble = { row: startRow + 2, col: boxRight + 2, w: (bubbleCol - boxRight - 2) + bubbleInner + 2, h: 3 };
        }
      } else if (startRow >= 5) {
        // Above-face bubble (original position, no accessory conflict)
        const txt = this.thoughtText;
        const bubbleInner = txt.length + 2;
        const bubbleLeft = startCol + Math.floor(faceW / 2);

        if (bubbleLeft + bubbleInner + 2 < cols) {
          buf += ansi.to(startRow - 4, bubbleLeft);
          buf += `${bc}\u256d${'\u2500'.repeat(bubbleInner)}\u256e${r}`;
          buf += ansi.to(startRow - 3, bubbleLeft);
          buf += `${bc}\u2502 ${tc}${txt}${r} ${bc}\u2502${r}`;
          buf += ansi.to(startRow - 2, bubbleLeft);
          buf += `${bc}\u2570${'\u2500'.repeat(bubbleInner)}\u256f${r}`;
          buf += ansi.to(startRow - 1, bubbleLeft + 2);
          buf += `${bc}\u25cb${r}`;
          this.lastPos.bubble = { row: startRow - 4, col: bubbleLeft, w: bubbleInner + 2, h: 4 };
        }
      }
    }

    // Streak counter, timeline, sparkline (togglable via 's', skipped in minimal mode)
    if (this.showStats && !this.minimalMode) {
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
          sc = ansi.fg(...dimColor(theme.label, 0.55));
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

      // Session timeline bar (with time-compression for long idle/sleep gaps)
      const tlColors = this.getTimelineColors();
      const now = Date.now();
      const compressed = this._compressTimeline(now); // computed once, shared with sparkline
      if (this.timeline.length > 1) {
        const barWidth = Math.min(faceW - 2, 38);
        const cTl = compressed.entries;
        const cNow = compressed.displayNow;
        const tlStart = cTl[0].at;
        const totalDur = cNow - tlStart;

        if (totalDur > 2000) {
          let bar = '';
          for (let i = 0; i < barWidth; i++) {
            const t = tlStart + (totalDur * i / barWidth);
            let st = 'idle';
            for (let j = cTl.length - 1; j >= 0; j--) {
              if (cTl[j].at <= t) { st = cTl[j].state; break; }
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
        const sparkBuckets = this._buildSparkline(spkWidth, now, compressed);
        if (sparkBuckets) {
          const maxCount = Math.max(1, ...sparkBuckets);
          let sparkline = '';
          for (let i = 0; i < sparkBuckets.length; i++) {
            const ratio = sparkBuckets[i] / maxCount;
            const blockIdx = Math.round(ratio * (SPARKLINE_BLOCKS.length - 1));
            const brightness = sparkBuckets[i] === 0 ? 0.28 : 0.45 + ratio * 0.55;
            sparkline += ansi.fg(...dimColor(theme.accent, brightness)) + SPARKLINE_BLOCKS[blockIdx];
          }
          const barPad = Math.floor((faceW - spkWidth) / 2);
          buf += ansi.to(startRow + 14, startCol + barPad) + sparkline + r;
        }
      }
    }

    // Indicators row: accs + subs (left), palette name (right) — skipped in minimal mode
    if (!this.minimalMode) {
      const dc = ansi.fg(...dimColor(theme.label, 0.55));
      const accText = this.accessoriesEnabled ? '\u25cf accs' : '\u25cb accs';
      const subText = this.showOrbitals ? '\u25cf subs' : '\u25cb subs';
      const leftText = `${accText}  ${subText}`;
      const pName = this.paletteIndex > 0 ? (PALETTE_NAMES[this.paletteIndex] || '') : '';

      buf += ansi.to(startRow + 8, startCol) + `${dc}${leftText}${r}`;
      if (pName) {
        buf += ansi.to(startRow + 8, startCol + faceW - pName.length);
        buf += `${dc}${pName}${r}`;
      }
    }

    // Project context row: folder + branch, centered below status/detail — skipped in minimal mode
    if (!this.minimalMode) {
      const folder = this.cwd ? path.basename(this.cwd) : '';
      if (folder || this.gitBranch) {
        const dc = ansi.fg(...dimColor(theme.label, 0.45));
        const branchIcon = this.isWorktree ? '\u25c4' : '\u2387';
        const commitsStr = this.commitCount > 0 ? ` \u2191${this.commitCount}` : '';

        // Build parts, truncating each to share the budget fairly
        let folderPart = '';
        let branchPart = '';
        const sep = (folder && this.gitBranch) ? '  ' : '';

        if (folder && this.gitBranch) {
          // Both: split budget — folder gets up to half, branch gets the rest
          const overhead = 2 + 2 + sep.length + commitsStr.length; // "⌂ " + "X " + sep + commits
          const available = faceW - overhead;
          const maxF = Math.max(3, Math.floor(available / 2));
          const f = folder.length > maxF ? folder.slice(0, maxF - 1) + '\u2026' : folder;
          const maxB = available - f.length;
          const b = this.gitBranch.length > maxB
            ? this.gitBranch.slice(0, Math.max(1, maxB - 1)) + '\u2026'
            : this.gitBranch;
          folderPart = `\u2302 ${f}`;
          branchPart = `${branchIcon} ${b}${commitsStr}`;
        } else if (folder) {
          const maxF = faceW - 2; // "⌂ "
          folderPart = `\u2302 ${folder.length > maxF ? folder.slice(0, maxF - 1) + '\u2026' : folder}`;
        } else if (this.gitBranch) {
          const maxB = faceW - 2 - commitsStr.length; // "X " + commits
          const b = this.gitBranch.length > maxB
            ? this.gitBranch.slice(0, maxB - 1) + '\u2026'
            : this.gitBranch;
          branchPart = `${branchIcon} ${b}${commitsStr}`;
        }

        const ctx = folderPart + sep + branchPart;
        const ctxPad = Math.floor((faceW - ctx.length) / 2);
        buf += ansi.to(startRow + 11, startCol + ctxPad) + `${dc}${ctx}${r}`;
      }
    }

    // Key hints bar (bottom of terminal) — skipped in minimal mode
    if (!this.minimalMode) {
      const dc = ansi.fg(...dimColor(theme.label, 0.55));
      const kc = ansi.fg(...dimColor(theme.accent, 0.6));
      const sep = `${dc}\u00b7${r}`;
      const hint = `${kc}space${dc} pet ${sep} ${kc}t${dc} theme ${sep} ${kc}s${dc} stats ${sep} ${kc}a${dc} accs ${sep} ${kc}o${dc} subs ${sep} ${kc}h${dc} help ${sep} ${kc}q${dc} quit${r}`;
      // Strip ANSI to measure visible length
      const visible = hint.replace(/\x1b\[[^m]*m/g, '');
      const hintCol = Math.max(1, Math.floor((cols - visible.length) / 2) + 1);
      buf += ansi.to(rows, hintCol) + hint;
    }

    // Help overlay (skipped in minimal mode)
    if (this.showHelp && !this.minimalMode) {
      buf += this._renderHelp(cols, rows, theme);
    }

    // Particles (drawn on top of face)
    buf += this.particles.render(startRow - 2, startCol - 5, theme.accent);
    buf += r;

    return buf;
  }
}

module.exports = { ClaudeFace, LOW_ACTIVITY_STATES, COMPRESS_LOW_CAP };
