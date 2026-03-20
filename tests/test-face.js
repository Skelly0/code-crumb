#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - face.js                                   |
// +================================================================+

const assert = require('assert');
const { ClaudeFace, LOW_ACTIVITY_STATES, COMPRESS_LOW_CAP, MAX_SEGMENT_BLOCKS } = require('../face');
const { ParticleSystem } = require('../particles');
const { themes, PALETTES } = require('../themes');
const { mouths, eyes } = require('../animations');

let passed = 0;
let failed = 0;
let currentDescribe = '';

function describe(name, fn) {
  currentDescribe = name;
  console.log(`\n  ${name}`);
  fn();
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    \x1b[32m\u2713\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`    \x1b[31m\u2717\x1b[0m ${name}`);
    console.log(`      ${e.message}`);
  }
}

describe('face.js -- ClaudeFace constructor', () => {
  test('initializes with idle state', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.state, 'idle');
  });

  test('initializes with zero counters', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.frame, 0);
    assert.strictEqual(face.streak, 0);
    assert.strictEqual(face.toolCallCount, 0);
    assert.strictEqual(face.filesEditedCount, 0);
  });

  test('has a particle system', () => {
    const face = new ClaudeFace();
    assert.ok(face.particles instanceof ParticleSystem);
  });
});

describe('face.js -- ClaudeFace._getMinDisplayMs', () => {
  const face = new ClaudeFace();

  test('happy → 4000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('happy'), 4000);
  });

  test('error → 4000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('error'), 4000);
  });

  test('coding → 6000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('coding'), 6000);
  });

  test('reading → 4000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('reading'), 4000);
  });

  test('sleeping → 1000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('sleeping'), 1000);
  });

  test('committing → 3500ms', () => {
    assert.strictEqual(face._getMinDisplayMs('committing'), 3500);
  });

  test('training min display is 5000', () => {
    assert.strictEqual(face._getMinDisplayMs('training'), 5000);
  });

  test('unknown state → 1000ms default', () => {
    assert.strictEqual(face._getMinDisplayMs('nonexistent'), 1000);
  });
});

describe('face.js -- ClaudeFace.setState', () => {
  test('changes state', () => {
    const face = new ClaudeFace();
    face.setState('coding', 'editing App.tsx');
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.stateDetail, 'editing App.tsx');
  });

  test('sets prevState', () => {
    const face = new ClaudeFace();
    face.setState('coding');
    assert.strictEqual(face.prevState, 'idle');
  });

  test('updates timeline', () => {
    const face = new ClaudeFace();
    const initialLen = face.timeline.length;
    face.setState('reading');
    assert.strictEqual(face.timeline.length, initialLen + 1);
    assert.strictEqual(face.timeline[face.timeline.length - 1].state, 'reading');
  });

  test('buffers pending state during min display time', () => {
    const face = new ClaudeFace();
    // caffeinated is NOT an active work state, so it should be buffered
    // when happy (interruptible) has min display time remaining
    face.setState('coding');
    face.setState('caffeinated');
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.pendingState, 'caffeinated');
  });

  test('same state updates detail without changing state', () => {
    const face = new ClaudeFace();
    face.setState('coding', 'editing a.ts');
    face.setState('coding', 'editing b.ts');
    assert.strictEqual(face.stateDetail, 'editing b.ts');
  });

  test('spawns particles on happy', () => {
    const face = new ClaudeFace();
    face.setState('happy');
    assert.ok(face.particles.particles.length > 0);
  });

  test('spawns particles on error', () => {
    const face = new ClaudeFace();
    face.setState('error');
    assert.ok(face.particles.particles.length > 0);
    assert.strictEqual(face.glitchIntensity, 1.0);
  });

  test('spawns push particles on committing', () => {
    const face = new ClaudeFace();
    face.setState('committing', 'committing changes');
    assert.ok(face.particles.particles.length > 0);
    assert.ok(face.particles.particles.every(p => p.style === 'push'));
  });

  test('spawns fire particles on training', () => {
    const face = new ClaudeFace();
    face.setState('training');
    assert.ok(face.particles.particles.length > 0);
    assert.ok(face.particles.particles.every(p => p.style === 'fire'));
  });

  test('fades old particles on state change', () => {
    const face = new ClaudeFace();
    face.particles.spawn(10, 'float');
    const maxBefore = Math.max(...face.particles.particles.map(p => p.life));
    face.setState('coding');
    const maxAfter = Math.max(...face.particles.particles.map(p => p.life));
    assert.ok(maxAfter <= 12);
  });
});

describe('face.js -- ClaudeFace.setStats', () => {
  test('updates tool call count', () => {
    const face = new ClaudeFace();
    face.setStats({ toolCalls: 42 });
    assert.strictEqual(face.toolCallCount, 42);
  });

  test('updates files edited count', () => {
    const face = new ClaudeFace();
    face.setStats({ filesEdited: 5 });
    assert.strictEqual(face.filesEditedCount, 5);
  });

  test('updates streak data', () => {
    const face = new ClaudeFace();
    face.setStats({ streak: 15, bestStreak: 20 });
    assert.strictEqual(face.streak, 15);
    assert.strictEqual(face.bestStreak, 20);
  });

  test('detects broken streak', () => {
    const face = new ClaudeFace();
    face.setStats({ brokenStreak: 10, brokenStreakAt: Date.now() });
    assert.strictEqual(face.lastBrokenStreak, 10);
    assert.ok(face.glitchIntensity > 0);
  });

  test('detects milestone', () => {
    const face = new ClaudeFace();
    face.setStats({ milestone: { type: 'streak', value: 25, at: Date.now() } });
    assert.ok(face.milestone);
    assert.strictEqual(face.milestone.value, 25);
    assert.strictEqual(face.milestoneShowTime, 180);
  });

  test('ignores duplicate milestone', () => {
    const face = new ClaudeFace();
    const ms = { type: 'streak', value: 25, at: 12345 };
    face.setStats({ milestone: ms });
    const firstShowTime = face.milestoneShowTime;
    face.milestoneShowTime = 50;
    face.setStats({ milestone: ms });
    assert.strictEqual(face.milestoneShowTime, 50);
  });

  test('updates daily data', () => {
    const face = new ClaudeFace();
    face.setStats({ dailySessions: 3, dailyCumulativeMs: 3600000 });
    assert.strictEqual(face.dailySessions, 3);
    assert.strictEqual(face.dailyCumulativeMs, 3600000);
  });

  test('updates diffInfo', () => {
    const face = new ClaudeFace();
    face.setStats({ diffInfo: { added: 10, removed: 3 } });
    assert.deepStrictEqual(face.diffInfo, { added: 10, removed: 3 });
  });

  test('updates modelName from state data', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.modelName, 'claude');
    face.setStats({ modelName: 'codex' });
    assert.strictEqual(face.modelName, 'codex');
  });

  test('modelName ignores empty string', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'kimi-k2.5' });
    face.setStats({ modelName: '' });
    assert.strictEqual(face.modelName, 'kimi-k2.5');
  });

  test('modelName updates to different values', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'o3' });
    assert.strictEqual(face.modelName, 'o3');
    face.setStats({ modelName: 'gpt-4.1' });
    assert.strictEqual(face.modelName, 'gpt-4.1');
  });
});

describe('face.js -- ClaudeFace modelName', () => {
  test('default modelName is "claude"', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.modelName, 'claude');
  });

  test('modelName can be set via setStats', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'codex' });
    assert.strictEqual(face.modelName, 'codex');
  });

  test('modelName persists across multiple setStats calls', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'kimi-k2.5' });
    face.setStats({ toolCalls: 5 });
    assert.strictEqual(face.modelName, 'kimi-k2.5');
  });

  test('modelName supports hyphenated names', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'gpt-4.1-mini' });
    assert.strictEqual(face.modelName, 'gpt-4.1-mini');
  });

  test('setStats ignores modelName when CODE_CRUMB_MODEL env var is set', () => {
    const orig = process.env.CODE_CRUMB_MODEL;
    try {
      process.env.CODE_CRUMB_MODEL = 'claude';
      const face = new ClaudeFace();
      face.setStats({ modelName: 'opencode' });
      assert.strictEqual(face.modelName, 'claude',
        'modelName must not change when CODE_CRUMB_MODEL is set');
    } finally {
      if (orig === undefined) delete process.env.CODE_CRUMB_MODEL;
      else process.env.CODE_CRUMB_MODEL = orig;
    }
  });

  test('setStats accepts modelName when CODE_CRUMB_MODEL not set', () => {
    const orig = process.env.CODE_CRUMB_MODEL;
    try {
      delete process.env.CODE_CRUMB_MODEL;
      const face = new ClaudeFace();
      face.setStats({ modelName: 'opencode' });
      assert.strictEqual(face.modelName, 'opencode',
        'modelName should update when CODE_CRUMB_MODEL is not set');
    } finally {
      if (orig !== undefined) process.env.CODE_CRUMB_MODEL = orig;
    }
  });
});

describe('face.js -- ClaudeFace.update', () => {
  test('increments frame counter', () => {
    const face = new ClaudeFace();
    face.update(66);
    assert.strictEqual(face.frame, 1);
    face.update(66);
    assert.strictEqual(face.frame, 2);
  });

  test('accumulates time', () => {
    const face = new ClaudeFace();
    face.update(100);
    face.update(200);
    assert.strictEqual(face.time, 300);
  });

  test('applies pending state after min display time expires', () => {
    const face = new ClaudeFace();
    face.setState('happy');
    face.setState('coding');
    face.minDisplayUntil = Date.now() - 1;
    face.update(66);
    assert.strictEqual(face.state, 'coding');
  });

  test('glitch intensity decays', () => {
    const face = new ClaudeFace();
    face.glitchIntensity = 1.0;
    face.update(66);
    assert.ok(face.glitchIntensity < 1.0);
  });

  test('milestone show time decays', () => {
    const face = new ClaudeFace();
    face.milestoneShowTime = 100;
    face.update(66);
    assert.strictEqual(face.milestoneShowTime, 99);
  });

  test('particles are updated', () => {
    const face = new ClaudeFace();
    face.particles.spawn(1, 'float');
    const lifeBefore = face.particles.particles[0].life;
    face.update(66);
    assert.strictEqual(face.particles.particles[0].life, lifeBefore - 1);
  });
});

describe('face.js -- ClaudeFace.getTheme', () => {
  test('returns theme for current state', () => {
    const face = new ClaudeFace();
    face.state = 'error';
    const theme = face.getTheme();
    assert.deepStrictEqual(theme, themes.error);
  });

  test('falls back to idle theme for unknown state', () => {
    const face = new ClaudeFace();
    face.state = 'nonexistent';
    const theme = face.getTheme();
    assert.deepStrictEqual(theme, themes.idle);
  });
});

describe('face.js -- ClaudeFace.getEyes', () => {
  test('returns eyes for all states', () => {
    const states = [
      'idle', 'thinking', 'coding', 'reading', 'searching',
      'executing', 'happy', 'satisfied', 'proud', 'relieved',
      'error', 'sleeping', 'waiting', 'testing', 'installing',
      'caffeinated', 'subagent', 'training',
    ];
    for (const state of states) {
      const face = new ClaudeFace();
      face.state = state;
      face.blinkFrame = -1;
      const theme = face.getTheme();
      const result = face.getEyes(theme, 0);
      assert.ok(result.left, `getEyes failed for state: ${state}`);
      assert.ok(result.right, `getEyes failed for state: ${state}`);
    }
  });

  test('returns blink eyes when blinking', () => {
    const face = new ClaudeFace();
    face.blinkFrame = 1;
    const theme = face.getTheme();
    const result = face.getEyes(theme, 0);
    assert.deepStrictEqual(result, eyes.blink());
  });
});

describe('face.js -- ClaudeFace.getMouth', () => {
  test('returns mouth for all states', () => {
    const states = [
      'idle', 'thinking', 'coding', 'reading', 'searching',
      'executing', 'happy', 'satisfied', 'proud', 'relieved',
      'error', 'sleeping', 'waiting', 'testing', 'installing',
      'caffeinated', 'subagent', 'training',
    ];
    for (const state of states) {
      const face = new ClaudeFace();
      face.state = state;
      face.glitchIntensity = 0;
      const theme = face.getTheme();
      const result = face.getMouth(theme, 0);
      assert.ok(typeof result === 'string', `getMouth failed for state: ${state}`);
    }
  });
});

describe('face.js -- ClaudeFace._buildSparkline', () => {
  test('returns null with fewer than 3 timeline entries', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face._buildSparkline(10, Date.now()), null);
    face.timeline.push({ state: 'coding', at: Date.now() });
    assert.strictEqual(face._buildSparkline(10, Date.now()), null);
  });

  test('returns null when session duration < 2000ms', () => {
    const face = new ClaudeFace();
    const now = Date.now();
    face.timeline = [
      { state: 'idle', at: now },
      { state: 'coding', at: now + 500 },
      { state: 'reading', at: now + 1000 },
    ];
    assert.strictEqual(face._buildSparkline(10, now + 1500), null);
  });

  test('returns array of correct length', () => {
    const face = new ClaudeFace();
    const now = Date.now();
    face.timeline = [
      { state: 'idle', at: now - 10000 },
      { state: 'coding', at: now - 8000 },
      { state: 'reading', at: now - 5000 },
    ];
    const buckets = face._buildSparkline(20, now);
    assert.ok(Array.isArray(buckets));
    assert.strictEqual(buckets.length, 20);
  });

  test('counts state transitions in correct buckets', () => {
    const face = new ClaudeFace();
    const start = Date.now() - 10000;
    face.timeline = [
      { state: 'idle', at: start },
      { state: 'coding', at: start + 1000 },
      { state: 'reading', at: start + 1500 },
      { state: 'executing', at: start + 8000 },
    ];
    const buckets = face._buildSparkline(10, start + 10000);
    assert.strictEqual(buckets[1], 2);
    assert.strictEqual(buckets[8], 1);
    assert.strictEqual(buckets[0], 0);
    assert.strictEqual(buckets[5], 0);
  });

  test('total transitions equals timeline length minus 1', () => {
    const face = new ClaudeFace();
    const start = Date.now() - 20000;
    face.timeline = [
      { state: 'idle', at: start },
      { state: 'coding', at: start + 2000 },
      { state: 'reading', at: start + 5000 },
      { state: 'executing', at: start + 9000 },
      { state: 'happy', at: start + 15000 },
    ];
    const buckets = face._buildSparkline(10, start + 20000);
    const total = buckets.reduce((sum, b) => sum + b, 0);
    assert.strictEqual(total, 4);
  });

  test('clamps last-bucket transitions correctly', () => {
    const face = new ClaudeFace();
    const start = Date.now() - 5000;
    face.timeline = [
      { state: 'idle', at: start },
      { state: 'coding', at: start + 4999 },
      { state: 'reading', at: start + 4999 },
    ];
    const buckets = face._buildSparkline(5, start + 5000);
    assert.strictEqual(buckets[4], 2);
  });
});

describe('face.js -- pet()', () => {
  test('spawns sparkle particles', () => {
    const face = new ClaudeFace();
    face.pet();
    assert.ok(face.particles.particles.length >= 15);
    assert.strictEqual(face.particles.particles[0].style, 'sparkle');
  });

  test('sets petTimer to 22', () => {
    const face = new ClaudeFace();
    face.pet();
    assert.strictEqual(face.petTimer, 22);
  });

  test('does NOT change state', () => {
    const face = new ClaudeFace();
    face.setState('coding');
    face.minDisplayUntil = 0;
    face.pet();
    assert.strictEqual(face.state, 'coding');
  });

  test('wiggle alternates then decays to 0', () => {
    const face = new ClaudeFace();
    face.pet();
    const wiggles = [];
    for (let i = 0; i < 25; i++) {
      face.update(66);
      wiggles.push(face.petWiggle);
    }
    assert.ok(wiggles.slice(0, 5).some(w => w !== 0));
    assert.strictEqual(wiggles[wiggles.length - 1], 0);
  });

  test('wiggle alternates between +1 and -1', () => {
    const face = new ClaudeFace();
    face.pet();
    face.update(66);
    const w1 = face.petWiggle;
    face.update(66);
    const w2 = face.petWiggle;
    assert.ok((w1 === 1 && w2 === -1) || (w1 === -1 && w2 === 1));
  });
});

describe('face.js -- pet spam easter egg', () => {
  test('tracks pet timestamps', () => {
    const face = new ClaudeFace();
    face.pet();
    face.pet();
    assert.strictEqual(face.petTimes.length, 2);
  });

  test('activates after 8 rapid pets', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.petSpamActive);
  });

  test('does NOT activate below threshold', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 7; i++) face.pet();
    assert.ok(!face.petSpamActive);
  });

  test('spawns heart particles on activation', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    const hearts = face.particles.particles.filter(p => p.style === 'heart');
    assert.ok(hearts.length >= 30);
  });

  test('spawns sparkles (not hearts) below threshold', () => {
    const face = new ClaudeFace();
    face.pet();
    const hearts = face.particles.particles.filter(p => p.style === 'heart');
    const sparkles = face.particles.particles.filter(p => p.style === 'sparkle');
    assert.strictEqual(hearts.length, 0);
    assert.ok(sparkles.length >= 15);
  });

  test('wiggle amplitude is 2 during pet spam', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    face.update(66);
    assert.ok(Math.abs(face.petWiggle) === 2);
  });

  test('deactivates after timer expires', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.petSpamActive);
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(!face.petSpamActive);
  });

  test('sets special thought text on activation', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.thoughtText.length > 0);
  });

  test('spawns continuous heart particles while active', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 6; i++) face.update(66);
    const heartsAfter = face.particles.particles.filter(p => p.style === 'heart').length;
    assert.ok(heartsAfter > 0);
  });

  test('filters out old pet timestamps outside window', () => {
    const face = new ClaudeFace();
    face.petTimes = [Date.now() - 3000, Date.now() - 2500];
    face.pet();
    assert.strictEqual(face.petTimes.length, 1);
  });

  test('re-triggering during active spam extends timer', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 10; i++) face.update(66);
    face.pet();
    assert.ok(face.petSpamActive);
    assert.strictEqual(face.petSpamTimer, 45);
  });
});

describe('face.js -- pet spam escalation', () => {
  test('first trigger sets level 1', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
  });

  test('re-trigger within 10s escalates to level 2', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 2);
  });

  test('third re-trigger reaches level 3', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 3);
  });

  test('level caps at 3', () => {
    const face = new ClaudeFace();
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 8; i++) face.pet();
      for (let i = 0; i < 50; i++) face.update(66);
    }
    assert.ok(face.petSpamLevel <= 3);
  });

  test('level resets after 10s gap', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
    face.petSpamLastAt = Date.now() - 11000;
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
  });

  test('level 3 thought cycling is faster (200ms interval)', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 3);
    const thoughts = new Set();
    for (let i = 0; i < 30; i++) {
      face.update(66);
      thoughts.add(face.thoughtText);
    }
    assert.ok(thoughts.size > 1);
  });

  test('eyes override to sparkle during L1-2 spam (even in error state)', () => {
    const face = new ClaudeFace();
    face.state = 'error';
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.petSpamActive);
    const theme = face.getTheme();
    const eyeResult = face.getEyes(theme, 0);
    const sparkleEyes = eyes.sparkle(theme, 0);
    assert.deepStrictEqual(eyeResult, sparkleEyes);
  });

  test('eyes override to vibrate during L3 spam', () => {
    const face = new ClaudeFace();
    face.state = 'idle';
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 3);
    const theme = face.getTheme();
    const eyeResult = face.getEyes(theme, 0);
    const vibrateEyes = eyes.vibrate(theme, 0);
    assert.deepStrictEqual(eyeResult, vibrateEyes);
  });

  test('mouth override to wide at L1, grin at L2+', () => {
    const face = new ClaudeFace();
    face.state = 'error';
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
    const theme = face.getTheme();
    assert.strictEqual(face.getMouth(theme, 0), mouths.wide());
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 2);
    assert.strictEqual(face.getMouth(theme, 0), mouths.grin());
  });
});

describe('face.js -- pet afterglow', () => {
  test('afterglow activates when pet spam expires', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(!face.petSpamActive);
    assert.ok(face.petAfterglowTimer > 0);
  });

  test('afterglow timer is 30 frames (~2s)', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0 && face.petAfterglowTimer <= 30);
  });

  test('afterglow overrides eyes to content', () => {
    const face = new ClaudeFace();
    face.state = 'coding';
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    face.blinkFrame = -1;
    const theme = face.getTheme();
    const eyeResult = face.getEyes(theme, 0);
    const contentEyes = eyes.content(theme, 0);
    assert.deepStrictEqual(eyeResult, contentEyes);
  });

  test('afterglow overrides mouth to catMouth', () => {
    const face = new ClaudeFace();
    face.state = 'error';
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    const theme = face.getTheme();
    const mouthResult = face.getMouth(theme, 0);
    assert.strictEqual(mouthResult, mouths.catMouth());
  });

  test('afterglow shows calm thought text', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    const calmThoughts = ['...', 'mmmm', 'purrrr', 'so warm', '\u25e1\u25e1\u25e1'];
    assert.ok(calmThoughts.includes(face.thoughtText));
  });

  test('afterglow spawns lazy hearts', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    face.particles.particles = face.particles.particles.filter(p => p.style !== 'heart');
    for (let i = 0; i < 25; i++) face.update(66);
    const lazyHearts = face.particles.particles.filter(p => p.style === 'heart');
    assert.ok(lazyHearts.length >= 1);
  });

  test('afterglow fully expires back to normal', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 90; i++) face.update(66);
    assert.ok(!face.petSpamActive);
    assert.strictEqual(face.petAfterglowTimer, 0);
  });

  test('new pet spam cancels afterglow', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.petSpamActive);
    assert.strictEqual(face.petAfterglowTimer, 0);
  });
});

describe('face.js -- cycleTheme()', () => {
  test('increments paletteIndex', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.paletteIndex, 0);
    face.cycleTheme();
    assert.strictEqual(face.paletteIndex, 1);
  });

  test('wraps around to 0', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < PALETTES.length; i++) face.cycleTheme();
    assert.strictEqual(face.paletteIndex, 0);
  });

  test('getTheme returns different colors per palette', () => {
    const face = new ClaudeFace();
    face.state = 'idle';
    const defaultTheme = face.getTheme();
    face.cycleTheme();
    const neonTheme = face.getTheme();
    const sameBorder = defaultTheme.border[0] === neonTheme.border[0] &&
                       defaultTheme.border[1] === neonTheme.border[1] &&
                       defaultTheme.border[2] === neonTheme.border[2];
    assert.ok(!sameBorder);
  });

  test('getTimelineColors returns palette-specific colors', () => {
    const face = new ClaudeFace();
    const defColors = face.getTimelineColors();
    face.cycleTheme();
    const neonColors = face.getTimelineColors();
    assert.notDeepStrictEqual(defColors.idle, neonColors.idle);
  });
});

describe('face.js -- toggleStats()', () => {
  test('starts true, toggles to false', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.showStats, true);
    face.toggleStats();
    assert.strictEqual(face.showStats, false);
  });

  test('double toggle returns to original', () => {
    const face = new ClaudeFace();
    face.toggleStats();
    face.toggleStats();
    assert.strictEqual(face.showStats, true);
  });
});

describe('face.js -- toggleHelp()', () => {
  test('starts false, toggles to true', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.showHelp, false);
    face.toggleHelp();
    assert.strictEqual(face.showHelp, true);
  });

  test('double toggle returns to original', () => {
    const face = new ClaudeFace();
    face.toggleHelp();
    face.toggleHelp();
    assert.strictEqual(face.showHelp, false);
  });
});

describe('face.js -- accessories', () => {
  test('accessoriesEnabled defaults to true', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.accessoriesEnabled, true);
  });

  test('toggleAccessories flips the flag', () => {
    const face = new ClaudeFace();
    face.toggleAccessories();
    assert.strictEqual(face.accessoriesEnabled, false);
    face.toggleAccessories();
    assert.strictEqual(face.accessoriesEnabled, true);
  });
});

describe('face.js -- accessories indicator in render', () => {
  test('render contains filled circle when accessories enabled', () => {
    const face = new ClaudeFace();
    face.accessoriesEnabled = true;
    const origCols = process.stdout.columns;
    const origRows = process.stdout.rows;
    process.stdout.columns = 80;
    process.stdout.rows = 30;
    const output = face.render();
    process.stdout.columns = origCols;
    process.stdout.rows = origRows;
    const stripped = output.replace(/\x1b\[[^m]*m/g, '');
    assert.ok(stripped.includes('\u25cf accs'));
  });

  test('render contains hollow circle when accessories disabled', () => {
    const face = new ClaudeFace();
    face.accessoriesEnabled = false;
    const origCols = process.stdout.columns;
    const origRows = process.stdout.rows;
    process.stdout.columns = 80;
    process.stdout.rows = 30;
    const output = face.render();
    process.stdout.columns = origCols;
    process.stdout.rows = origRows;
    const stripped = output.replace(/\x1b\[[^m]*m/g, '');
    assert.ok(stripped.includes('\u25cb accs'));
  });

  test('indicator changes when toggling accessories', () => {
    const face = new ClaudeFace();
    const origCols = process.stdout.columns;
    const origRows = process.stdout.rows;
    process.stdout.columns = 80;
    process.stdout.rows = 30;
    const out1 = face.render().replace(/\x1b\[[^m]*m/g, '');
    assert.ok(out1.includes('\u25cf accs'));
    face.toggleAccessories();
    const out2 = face.render().replace(/\x1b\[[^m]*m/g, '');
    assert.ok(out2.includes('\u25cb accs'));
    process.stdout.columns = origCols;
    process.stdout.rows = origRows;
  });
});

describe('face.js -- project context row in render', () => {
  const origCols = process.stdout.columns;
  const origRows = process.stdout.rows;
  function renderStripped(face) {
    process.stdout.columns = 80;
    process.stdout.rows = 30;
    const out = face.render().replace(/\x1b\[[^m]*m/g, '');
    process.stdout.columns = origCols;
    process.stdout.rows = origRows;
    return out;
  }

  test('shows folder name from cwd', () => {
    const face = new ClaudeFace();
    face.setStats({ cwd: '/home/user/my-project' });
    const out = renderStripped(face);
    assert.ok(out.includes('\u2302 my-project'), 'should show folder name');
  });

  test('shows branch name alongside folder', () => {
    const face = new ClaudeFace();
    face.setStats({ cwd: '/home/user/proj', gitBranch: 'main' });
    const out = renderStripped(face);
    assert.ok(out.includes('\u2302 proj'), 'should show folder');
    assert.ok(out.includes('\u2387 main'), 'should show branch');
  });

  test('does not show context row when cwd is null and no branch', () => {
    const face = new ClaudeFace();
    face.setStats({ cwd: null });
    const out = renderStripped(face);
    assert.ok(!out.includes('\u2302'), 'should not show house icon');
  });

  test('does not show folder for root path', () => {
    const face = new ClaudeFace();
    face.setStats({ cwd: '/' });
    const out = renderStripped(face);
    assert.ok(!out.includes('\u2302'), 'basename of / is empty, should skip');
  });

  test('shows branch even without cwd', () => {
    const face = new ClaudeFace();
    face.setStats({ gitBranch: 'develop' });
    const out = renderStripped(face);
    assert.ok(out.includes('\u2387 develop'), 'branch should show without folder');
  });

  test('folder appears before branch', () => {
    const face = new ClaudeFace();
    face.setStats({ cwd: '/home/user/proj', gitBranch: 'main' });
    const out = renderStripped(face);
    const folderPos = out.indexOf('\u2302');
    const branchPos = out.indexOf('\u2387');
    assert.ok(folderPos > -1, 'folder icon should appear');
    assert.ok(branchPos > -1, 'branch icon should appear');
    assert.ok(folderPos < branchPos, 'folder should come before branch');
  });

  test('context row is separate from indicator row', () => {
    const face = new ClaudeFace();
    face.paletteIndex = 1;
    face.setStats({ cwd: '/home/user/my-project', gitBranch: 'feat' });
    const out = renderStripped(face);
    const { PALETTE_NAMES } = require('../themes');
    assert.ok(out.includes(PALETTE_NAMES[1]), 'palette name should appear');
    assert.ok(out.includes('\u2302 my-project'), 'folder should appear');
    assert.ok(out.includes('\u2387 feat'), 'branch should appear');
  });

  test('truncates when folder + branch exceeds face width', () => {
    const face = new ClaudeFace();
    face.setStats({ cwd: '/home/user/this-is-a-really-really-long-folder-name', gitBranch: 'feature/also-very-long' });
    const out = renderStripped(face);
    assert.ok(out.includes('\u2302'), 'folder icon should appear');
    assert.ok(out.includes('\u2026'), 'should have ellipsis for truncation');
  });

  test('shows worktree icon instead of branch icon', () => {
    const face = new ClaudeFace();
    face.setStats({ gitBranch: 'feat-x', isWorktree: true });
    const out = renderStripped(face);
    assert.ok(out.includes('\u25c4'), 'should show worktree icon \u25c4');
    assert.ok(!out.includes('\u2387'), 'should not show regular branch icon');
  });

  test('shows commit count after branch', () => {
    const face = new ClaudeFace();
    face.setStats({ gitBranch: 'main', commitCount: 3 });
    const out = renderStripped(face);
    assert.ok(out.includes('\u21913'), 'should show ↑3 after branch');
  });
});

describe('face.js -- minimalMode', () => {
  const origCols = process.stdout.columns;
  const origRows = process.stdout.rows;
  function renderStrippedMinimal(face) {
    process.stdout.columns = 80;
    process.stdout.rows = 30;
    const out = face.render().replace(/\x1b\[[^m]*m/g, '');
    process.stdout.columns = origCols;
    process.stdout.rows = origRows;
    return out;
  }

  test('minimalMode defaults to false', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.minimalMode, false);
  });

  test('minimal mode skips indicator row (accs/subs)', () => {
    const face = new ClaudeFace();
    face.minimalMode = true;
    const out = renderStrippedMinimal(face);
    assert.ok(!out.includes('accs'), 'should not contain accs indicator');
    assert.ok(!out.includes('subs'), 'should not contain subs indicator');
  });

  test('minimal mode skips thought bubble', () => {
    const face = new ClaudeFace();
    face.minimalMode = true;
    face.thoughtText = 'hmm...';
    const out = renderStrippedMinimal(face);
    assert.ok(!out.includes('hmm...'), 'should not render thought bubble text');
  });

  test('minimal mode skips key hints bar', () => {
    const face = new ClaudeFace();
    face.minimalMode = true;
    const out = renderStrippedMinimal(face);
    assert.ok(!out.includes('theme'), 'should not contain key hint "theme"');
    assert.ok(!out.includes('help'), 'should not contain key hint "help"');
  });

  test('minimal mode skips help overlay even when showHelp is true', () => {
    const face = new ClaudeFace();
    face.minimalMode = true;
    face.showHelp = true;
    const out = renderStrippedMinimal(face);
    assert.ok(!out.includes('Keybindings'), 'should not render help overlay');
  });

  test('minimal mode skips stats rows', () => {
    const face = new ClaudeFace();
    face.minimalMode = true;
    face.showStats = true;
    face.streak = 15;
    const out = renderStrippedMinimal(face);
    assert.ok(!out.includes('successful in a row'), 'should not render streak');
  });

  test('minimal mode skips project context row', () => {
    const face = new ClaudeFace();
    face.minimalMode = true;
    face.setStats({ cwd: '/home/user/my-project', gitBranch: 'main' });
    const out = renderStrippedMinimal(face);
    assert.ok(!out.includes('my-project'), 'should not render project folder');
  });

  test('minimal mode still renders face box and status line', () => {
    const face = new ClaudeFace();
    face.minimalMode = true;
    const out = renderStrippedMinimal(face);
    // Face box borders
    assert.ok(out.includes('\u256d'), 'should contain top-left box corner');
    assert.ok(out.includes('\u2570'), 'should contain bottom-left box corner');
    // Status line
    assert.ok(out.includes('is'), 'should contain status text');
  });

  test('minimal mode skips accessories', () => {
    const face = new ClaudeFace();
    face.minimalMode = true;
    face.accessoriesEnabled = true;
    face.setState('thinking'); // thinking has a hat accessory
    const outMinimal = renderStrippedMinimal(face);
    // Compare with non-minimal
    const face2 = new ClaudeFace();
    face2.setState('thinking');
    face2.accessoriesEnabled = true;
    const outNormal = renderStrippedMinimal(face2);
    // Minimal output should be shorter (less chrome)
    assert.ok(outMinimal.length <= outNormal.length, 'minimal output should not be longer than normal');
  });
});

describe('face.js -- active work bypasses thinking min display (Bug 2)', () => {
  test('executing bypasses thinking min display', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    assert.strictEqual(face.state, 'thinking');
    // thinking has 2500ms min display — executing should punch through
    face.setState('executing', 'git status');
    assert.strictEqual(face.state, 'executing');
    assert.strictEqual(face.stateDetail, 'git status');
  });

  test('coding bypasses relieved min display after 500ms guaranteed window', () => {
    const face = new ClaudeFace();
    face.setState('relieved');
    assert.strictEqual(face.state, 'relieved');
    // Simulate relieved has been showing for 600ms (past the guaranteed window)
    face.lastStateChange = Date.now() - 600;
    face.setState('coding', 'editing app.ts');
    assert.strictEqual(face.state, 'coding');
  });

  test('responding bypasses thinking min display', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    face.setState('responding', 'generating');
    assert.strictEqual(face.state, 'responding');
  });

  test('searching bypasses idle min display', () => {
    const face = new ClaudeFace();
    face.setState('idle');
    face.setState('searching', 'grep pattern');
    assert.strictEqual(face.state, 'searching');
  });

  test('active work does NOT bypass other active work (coding blocked by executing)', () => {
    const face = new ClaudeFace();
    face.setState('executing', 'npm test');
    assert.strictEqual(face.state, 'executing');
    face.setState('coding', 'editing file');
    // executing is not interruptible, so coding should be buffered
    assert.strictEqual(face.state, 'executing');
    assert.strictEqual(face.pendingState, 'coding');
  });

  test('idle does NOT bypass thinking (passive-to-passive)', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    face.setState('idle');
    assert.strictEqual(face.state, 'thinking');
    assert.strictEqual(face.pendingState, 'idle');
  });

  test('sleeping does NOT bypass thinking', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    face.setState('sleeping');
    assert.strictEqual(face.state, 'thinking');
    assert.strictEqual(face.pendingState, 'sleeping');
  });

  test('work state buffered during fresh completion -- no immediate bypass (anti-flicker)', () => {
    const face = new ClaudeFace();
    face.setState('happy');
    // reading arrives immediately -- happy hasn't shown for 500ms yet
    face.setState('reading');
    assert.strictEqual(face.state, 'happy');         // still on happy
    assert.strictEqual(face.pendingState, 'reading'); // reading queued for early flush
  });

  test('work state bypasses completion after 500ms guaranteed window (Fix #96)', () => {
    const face = new ClaudeFace();
    face.setState('happy');
    face.lastStateChange = Date.now() - 600; // simulate 600ms elapsed
    face.setState('reading');
    assert.strictEqual(face.state, 'reading'); // bypasses now that window passed
    assert.strictEqual(face.pendingState, null);
  });

  test('completion state buffered during active work -- no reverse bypass (anti-flicker)', () => {
    const face = new ClaudeFace();
    face.setState('reading');
    face.setState('satisfied');
    assert.strictEqual(face.state, 'reading');           // still on reading
    assert.strictEqual(face.pendingState, 'satisfied');  // satisfied queued behind work
  });

  test('latest completion overwrites earlier pending completion', () => {
    const face = new ClaudeFace();
    face.setState('reading');
    face.setState('happy');
    assert.strictEqual(face.pendingState, 'happy');
    face.setState('proud'); // more recent completion
    assert.strictEqual(face.pendingState, 'proud');
  });

  test('mundane state does not displace pending completion', () => {
    const face = new ClaudeFace();
    face.setState('reading');
    face.setState('satisfied'); // gets buffered
    assert.strictEqual(face.pendingState, 'satisfied');
    face.setState('idle');      // should NOT overwrite satisfied
    assert.strictEqual(face.pendingState, 'satisfied');
  });

  test('error still bypasses any state (unchanged behavior)', () => {
    const face = new ClaudeFace();
    face.setState('executing', 'running');
    assert.strictEqual(face.state, 'executing');
    face.setState('error', 'command failed');
    assert.strictEqual(face.state, 'error');
    assert.strictEqual(face.stateDetail, 'command failed');
  });

  test('caffeinated does NOT bypass thinking (not an active work state)', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    face.setState('caffeinated', 'hyperdrive!');
    assert.strictEqual(face.state, 'thinking');
    assert.strictEqual(face.pendingState, 'caffeinated');
  });

  test('executing bypasses happy min display after 500ms guaranteed window', () => {
    const face = new ClaudeFace();
    face.setState('happy');
    face.lastStateChange = Date.now() - 600;
    face.setState('executing', 'next command');
    assert.strictEqual(face.state, 'executing');
  });

  test('testing bypasses satisfied min display after 500ms guaranteed window', () => {
    const face = new ClaudeFace();
    face.setState('satisfied');
    face.lastStateChange = Date.now() - 600;
    face.setState('testing', 'npm test');
    assert.strictEqual(face.state, 'testing');
  });

  test('installing bypasses waiting min display', () => {
    const face = new ClaudeFace();
    face.setState('waiting');
    face.setState('installing', 'npm install');
    assert.strictEqual(face.state, 'installing');
  });

  test('completion state bypasses immediately instead of going to pending (Bug 66 + #76)', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    face.setState('happy');
    // With #76, happy bypasses minDisplayUntil and applies immediately
    assert.strictEqual(face.state, 'happy',
      'completion state should apply immediately, not go to pending');
    assert.strictEqual(face.pendingState, null,
      'pendingState should be null when completion applies directly');
  });

  test('proud bypasses immediately even during thinking (Bug 66 + #76)', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    face.setState('proud', 'saved file.js');
    // proud bypasses and applies immediately
    assert.strictEqual(face.state, 'proud',
      'proud should apply immediately');
  });

  test('satisfied bypasses immediately even during thinking (Bug 66 + #76)', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    face.setState('satisfied', 'read file.js');
    // satisfied bypasses and applies immediately
    assert.strictEqual(face.state, 'satisfied',
      'satisfied should apply immediately');
  });
});

// -- Caffeinated detection (update-driven) --------------------------------

describe('caffeinated detection', () => {
  // Helper: pump enough setState calls to exceed CAFFEINE_THRESHOLD (5 in 10s)
  function pumpStates(face, count = 6) {
    const states = ['coding', 'reading', 'searching', 'executing', 'testing', 'coding', 'reading', 'searching'];
    for (let i = 0; i < count; i++) {
      face.setState(states[i % states.length]);
      // Expire min display so next setState applies immediately
      face.minDisplayUntil = 0;
    }
  }

  test('triggers caffeinated after rapid state changes via update()', () => {
    const face = new ClaudeFace();
    pumpStates(face, 6);
    // Land on an active state that isn't excluded
    face.minDisplayUntil = 0;
    face.setState('coding');
    face.minDisplayUntil = 0; // expire so update's setState can apply
    face.update(16);
    assert.strictEqual(face.state, 'caffeinated');
  });

  test('caffeinated routes through setState (sets minDisplayUntil)', () => {
    const face = new ClaudeFace();
    pumpStates(face, 6);
    face.minDisplayUntil = 0;
    face.setState('coding');
    face.minDisplayUntil = 0;
    const before = Date.now();
    face.update(16);
    assert.strictEqual(face.state, 'caffeinated');
    // minDisplayUntil should be set (2500ms from now)
    assert.ok(face.minDisplayUntil >= before + 2000, 'minDisplayUntil should be set by setState');
  });

  test('caffeinated does NOT trigger on responding (prevents post-Stop oscillation)', () => {
    const face = new ClaudeFace();
    pumpStates(face, 6);
    face.minDisplayUntil = 0;
    face.setState('responding');
    face.minDisplayUntil = 0;
    face.update(16);
    assert.strictEqual(face.state, 'responding');
  });

  test('caffeinated does NOT trigger on waiting', () => {
    const face = new ClaudeFace();
    pumpStates(face, 6);
    face.minDisplayUntil = 0;
    face.setState('waiting');
    face.minDisplayUntil = 0;
    face.update(16);
    assert.strictEqual(face.state, 'waiting');
  });

  test('caffeinated decays back to prevState when timestamps age out', () => {
    const face = new ClaudeFace();
    pumpStates(face, 6);
    face.minDisplayUntil = 0;
    face.setState('executing');
    face.minDisplayUntil = 0;
    face.update(16);
    assert.strictEqual(face.state, 'caffeinated');
    // Simulate timestamps aging out (clear them to mimic 10s passing)
    face.stateChangeTimes = [];
    face.minDisplayUntil = 0;
    face.update(16);
    // Should decay back to prevState (executing was the state before caffeinated)
    assert.notStrictEqual(face.state, 'caffeinated', 'should exit caffeinated after decay');
  });

  test('no isCaffeinated property (dead code removed)', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.hasOwnProperty('isCaffeinated'), false);
  });
});

describe('face.js -- completion states bypass minDisplayUntil (#76)', () => {
  test('completion state (happy) bypasses non-work minDisplayUntil', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    face.minDisplayUntil = Date.now() + 50000;
    face.setState('happy');
    assert.strictEqual(face.state, 'happy',
      'completion state should bypass non-work minDisplayUntil');
  });

  test('completion state (satisfied) queued behind active work -- no bypass', () => {
    const face = new ClaudeFace();
    face.setState('executing');
    face.minDisplayUntil = Date.now() + 50000;
    face.setState('satisfied');
    assert.strictEqual(face.state, 'executing',
      'satisfied should not bypass active work state');
    assert.strictEqual(face.pendingState, 'satisfied');
  });

  test('non-completion state does NOT bypass minDisplayUntil', () => {
    const face = new ClaudeFace();
    face.setState('coding');
    face.minDisplayUntil = Date.now() + 50000;
    face.setState('reading');
    assert.strictEqual(face.state, 'coding',
      'non-completion state should not bypass minDisplayUntil');
  });

  test('pending completion not overwritten by non-completion state', () => {
    const face = new ClaudeFace();
    face.setState('coding');
    face.minDisplayUntil = Date.now() + 50000;
    // Reading goes to pending
    face.setState('reading');
    assert.strictEqual(face.pendingState, 'reading');
    // Happy is buffered behind work (does not apply immediately)
    face.setState('happy');
    assert.strictEqual(face.state, 'coding',
      'happy should not bypass active work state');
    assert.strictEqual(face.pendingState, 'happy',
      'happy queued as most recent pending');
  });
});

// -- Timeline compression (_compressTimeline) --------------------------------

describe('_compressTimeline', () => {
  test('short session with no long gaps returns unchanged times', () => {
    const face = new ClaudeFace();
    const base = Date.now() - 10000;
    face.timeline = [
      { state: 'idle', at: base },
      { state: 'coding', at: base + 2000 },
      { state: 'reading', at: base + 5000 },
    ];
    const now = base + 10000;
    const { entries, displayNow } = face._compressTimeline(now);
    assert.strictEqual(entries.length, 3);
    // No compression -- gaps between entries should be preserved
    assert.strictEqual(entries[1].at - entries[0].at, 2000);
    assert.strictEqual(entries[2].at - entries[1].at, 3000);
    assert.strictEqual(displayNow - entries[2].at, now - face.timeline[2].at);
  });

  test('long sleep gap gets capped to COMPRESS_LOW_CAP', () => {
    const face = new ClaudeFace();
    const base = Date.now() - 7200000; // 2 hours ago
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'sleeping', at: base + 60000 },        // sleep starts at 1min
      { state: 'coding', at: base + 7200000 },         // coding resumes 2hrs later
    ];
    const now = base + 7200000 + 60000; // 1min after resuming
    const { entries, displayNow } = face._compressTimeline(now);
    assert.strictEqual(entries.length, 3);
    // The sleeping gap (7200000 - 60000 = 7140000ms) should be capped to 30s
    const sleepGap = entries[2].at - entries[1].at;
    assert.strictEqual(sleepGap, COMPRESS_LOW_CAP,
      'sleeping gap should be capped to COMPRESS_LOW_CAP');
    // The coding gap before sleep is untouched (60s < 30s cap? no, 60s > 30s but coding isn't low-activity)
    assert.strictEqual(entries[1].at - entries[0].at, 60000,
      'active state gap should not be compressed');
  });

  test('multiple sleep gaps are each independently capped', () => {
    const face = new ClaudeFace();
    const base = Date.now() - 14400000;
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'sleeping', at: base + 60000 },
      { state: 'coding', at: base + 3660000 },           // 1hr sleep
      { state: 'idle', at: base + 3720000 },
      { state: 'coding', at: base + 7320000 },            // 1hr idle
    ];
    const now = base + 7380000;
    const { entries, displayNow } = face._compressTimeline(now);
    // Sleep gap: 3660000 - 60000 = 3600000 -> capped to 30000
    const sleepGap = entries[2].at - entries[1].at;
    assert.strictEqual(sleepGap, COMPRESS_LOW_CAP);
    // Idle gap: 7320000 - 3720000 = 3600000 -> capped to 30000
    const idleGap = entries[4].at - entries[3].at;
    assert.strictEqual(idleGap, COMPRESS_LOW_CAP);
  });

  test('active states are never compressed even with large gaps', () => {
    const face = new ClaudeFace();
    const base = Date.now() - 500000;
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'executing', at: base + 300000 },  // 5min of coding
      { state: 'reading', at: base + 400000 },
    ];
    const now = base + 500000;
    const { entries, displayNow } = face._compressTimeline(now);
    // All gaps preserved exactly
    assert.strictEqual(entries[1].at - entries[0].at, 300000);
    assert.strictEqual(entries[2].at - entries[1].at, 100000);
    assert.strictEqual(displayNow, now, 'no compression means displayNow === now');
  });

  test('mixed sequence: idle->coding->sleep->coding shows coding with proper proportion', () => {
    const face = new ClaudeFace();
    const base = Date.now() - 7500000;
    face.timeline = [
      { state: 'idle', at: base },
      { state: 'coding', at: base + 120000 },          // 2min idle (> cap)
      { state: 'sleeping', at: base + 420000 },         // 5min coding
      { state: 'coding', at: base + 7200000 },          // ~1.9hr sleep
      { state: 'happy', at: base + 7500000 },           // 5min coding
    ];
    const now = base + 7500000;
    const { entries, displayNow } = face._compressTimeline(now);

    // idle gap: 120000 -> capped to 30000
    const idleGap = entries[1].at - entries[0].at;
    assert.strictEqual(idleGap, COMPRESS_LOW_CAP);

    // coding gap: 300000 -> preserved
    const codingGap1 = entries[2].at - entries[1].at;
    assert.strictEqual(codingGap1, 300000);

    // sleep gap: 6780000 -> capped to 30000
    const sleepGap = entries[3].at - entries[2].at;
    assert.strictEqual(sleepGap, COMPRESS_LOW_CAP);

    // coding gap 2: 300000 -> preserved
    const codingGap2 = entries[4].at - entries[3].at;
    assert.strictEqual(codingGap2, 300000);

    // Total compressed duration should be much smaller than original
    const compressedTotal = displayNow - entries[0].at;
    const originalTotal = now - base;
    assert.ok(compressedTotal < originalTotal / 5,
      `compressed (${compressedTotal}) should be much smaller than original (${originalTotal})`);
  });

  test('gaps under COMPRESS_LOW_CAP are not compressed', () => {
    const face = new ClaudeFace();
    const base = Date.now() - 50000;
    face.timeline = [
      { state: 'idle', at: base },
      { state: 'coding', at: base + 20000 },  // 20s idle, under 30s cap
    ];
    const now = base + 50000;
    const { entries, displayNow } = face._compressTimeline(now);
    assert.strictEqual(entries[1].at - entries[0].at, 20000,
      'short idle gap should not be compressed');
  });

  test('LOW_ACTIVITY_STATES contains expected states', () => {
    assert.ok(LOW_ACTIVITY_STATES.has('idle'));
    assert.ok(LOW_ACTIVITY_STATES.has('sleeping'));
    assert.ok(LOW_ACTIVITY_STATES.has('waiting'));
    assert.ok(!LOW_ACTIVITY_STATES.has('coding'));
    assert.ok(!LOW_ACTIVITY_STATES.has('thinking'));
  });

  test('empty/single-entry timeline returns as-is', () => {
    const face = new ClaudeFace();
    face.timeline = [];
    const { entries: e1 } = face._compressTimeline(Date.now());
    assert.strictEqual(e1.length, 0);

    face.timeline = [{ state: 'idle', at: Date.now() }];
    face._timelineDirty = true;
    const { entries: e2 } = face._compressTimeline(Date.now());
    assert.strictEqual(e2.length, 1);
  });
});

// -- Petting system behavioral tests ------------------------------------------

describe('face.js -- petting system', () => {
  test('pet() once sets petTimer to 22 and spawns sparkle particles', () => {
    const face = new ClaudeFace();
    const before = face.particles.particles.length;
    face.pet();
    assert.strictEqual(face.petTimer, 22);
    assert.ok(face.particles.particles.length > before, 'should spawn sparkle particles');
  });

  test('pet() once does not activate petSpamActive', () => {
    const face = new ClaudeFace();
    face.pet();
    assert.strictEqual(face.petSpamActive, false);
  });

  test('8 rapid pet() calls activates petSpamActive', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamActive, true);
  });

  test('8 rapid pet() calls sets petSpamLevel to 1', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
  });

  test('second spam burst within 10s escalates to level 2', () => {
    const face = new ClaudeFace();
    // First burst
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
    // Decay spam so we can re-trigger
    face.petSpamActive = false;
    face.petSpamTimer = 0;
    face.petTimes = [];
    // Second burst (within PET_SPAM_ESCALATE_WINDOW = 10s)
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 2);
  });

  test('third spam burst escalates to level 3', () => {
    const face = new ClaudeFace();
    for (let burst = 0; burst < 3; burst++) {
      for (let i = 0; i < 8; i++) face.pet();
      if (burst < 2) {
        face.petSpamActive = false;
        face.petSpamTimer = 0;
        face.petTimes = [];
      }
    }
    assert.strictEqual(face.petSpamLevel, 3);
  });

  test('spam burst after 10s gap resets to level 1', () => {
    const face = new ClaudeFace();
    // First burst
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
    // Simulate 10s+ gap
    face.petSpamActive = false;
    face.petSpamTimer = 0;
    face.petTimes = [];
    face.petSpamLastAt = Date.now() - 11000;
    // New burst
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
  });

  test('petWiggle amplitude is +/-1 during normal pet', () => {
    const face = new ClaudeFace();
    face.pet();
    face.update(16);
    assert.ok(Math.abs(face.petWiggle) === 1, `expected wiggle ±1, got ${face.petWiggle}`);
  });

  test('petWiggle amplitude is +/-2 during spam', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    face.update(16);
    assert.ok(Math.abs(face.petWiggle) === 2, `expected wiggle ±2 during spam, got ${face.petWiggle}`);
  });

  test('petSpamTimer decrements each update()', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    const initial = face.petSpamTimer;
    face.update(16);
    assert.strictEqual(face.petSpamTimer, initial - 1);
  });

  test('afterglow: petSpamActive becomes false, petAfterglowTimer > 0', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamActive, true);
    // First update: decrement petSpamTimer to 0 (the >0 branch fires)
    face.petSpamTimer = 1;
    face.update(16);
    // petSpamTimer is now 0 but petSpamActive is still true
    // Second update: the else-if branch fires, transitioning to afterglow
    face.update(16);
    assert.strictEqual(face.petSpamActive, false);
    assert.ok(face.petAfterglowTimer > 0, 'afterglow timer should be set');
  });

  test('getMouth returns catMouth during pet', () => {
    const face = new ClaudeFace();
    face.pet();
    const theme = face.getTheme();
    const mouth = face.getMouth(theme, face.frame);
    assert.strictEqual(mouth, mouths.catMouth());
  });

  test('getMouth returns catMouth during afterglow', () => {
    const face = new ClaudeFace();
    face.petAfterglowTimer = 10;
    const theme = face.getTheme();
    const mouth = face.getMouth(theme, face.frame);
    assert.strictEqual(mouth, mouths.catMouth());
  });

  test('pet spam spawns heart particles', () => {
    const face = new ClaudeFace();
    const heartsBefore = face.particles.particles.filter(p => p.style === 'heart').length;
    for (let i = 0; i < 8; i++) face.pet();
    const heartsAfter = face.particles.particles.filter(p => p.style === 'heart').length;
    assert.ok(heartsAfter > heartsBefore, 'should spawn heart particles during spam');
  });
});

// -- Blinking system behavioral tests -----------------------------------------

describe('face.js -- blinking system', () => {
  test('_nextBlink returns value between 2500 and 6000', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 50; i++) {
      const val = face._nextBlink();
      assert.ok(val >= 2500, `blink interval ${val} should be >= 2500`);
      assert.ok(val <= 6000, `blink interval ${val} should be <= 6000`);
    }
  });

  test('blinkTimer decrements via update()', () => {
    const face = new ClaudeFace();
    const before = face.blinkTimer;
    face.update(100);
    assert.strictEqual(face.blinkTimer, before - 100);
  });

  test('blinkFrame becomes 0 when blinkTimer <= 0', () => {
    const face = new ClaudeFace();
    face.blinkTimer = 10;
    face.update(20); // Timer goes to -10, triggers blink
    assert.ok(face.blinkFrame >= 0, 'blinkFrame should be set after timer expires');
  });

  test('blinkFrame progresses 0 -> 1 -> 2 -> -1 over 3 updates', () => {
    const face = new ClaudeFace();
    // Force blink start
    face.blinkTimer = 1;
    face.update(2); // blinkFrame becomes 0, then incremented to 1 in same update
    // Actually, let me trace the logic:
    // blinkTimer -= dt => 1-2 = -1 <= 0 => blinkFrame = 0, blinkTimer = next
    // then blinkFrame >= 0 => blinkFrame++ => 1
    assert.strictEqual(face.blinkFrame, 1);
    face.update(16);
    // blinkFrame >= 0 => blinkFrame++ => 2
    assert.strictEqual(face.blinkFrame, 2);
    face.update(16);
    // blinkFrame >= 0 and >= 3 => blinkFrame = -1
    assert.strictEqual(face.blinkFrame, -1);
  });

  test('next blink is scheduled after completion', () => {
    const face = new ClaudeFace();
    face.blinkTimer = 1;
    face.update(2); // triggers blink
    const newTimer = face.blinkTimer;
    assert.ok(newTimer >= 2500 && newTimer <= 6000, `new timer ${newTimer} should be 2500-6000`);
  });

  test('getEyes returns blink during active blinkFrame', () => {
    const face = new ClaudeFace();
    face.blinkFrame = 0;
    const theme = face.getTheme();
    const result = face.getEyes(theme, face.frame);
    const blink = eyes.blink(theme, face.frame);
    assert.deepStrictEqual(result, blink, 'should return blink eyes during blinkFrame');
  });
});

// -- Pet overrides blink ------------------------------------------------------

describe('face.js -- pet overrides blink', () => {
  test('during petSpamActive, getEyes returns sparkle not blink', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    face.blinkFrame = 0; // force blink active
    const theme = face.getTheme();
    const result = face.getEyes(theme, 10);
    const blink = eyes.blink(theme, 10);
    // Pet spam should override blink
    assert.notDeepStrictEqual(result, blink, 'pet spam should override blink');
  });

  test('petSpamLevel >= 3 returns vibrate eyes', () => {
    const face = new ClaudeFace();
    face.petSpamActive = true;
    face.petSpamLevel = 3;
    const theme = face.getTheme();
    const result = face.getEyes(theme, 0);
    const vibrate = eyes.vibrate(theme, 0);
    assert.deepStrictEqual(result, vibrate, 'level 3 should use vibrate eyes');
  });

  test('petSpamLevel < 3 returns sparkle eyes', () => {
    const face = new ClaudeFace();
    face.petSpamActive = true;
    face.petSpamLevel = 2;
    const theme = face.getTheme();
    const result = face.getEyes(theme, 0);
    const sparkle = eyes.sparkle(theme, 0);
    assert.deepStrictEqual(result, sparkle, 'level 2 should use sparkle eyes');
  });

  test('afterglow returns content eyes', () => {
    const face = new ClaudeFace();
    face.petAfterglowTimer = 10;
    const theme = face.getTheme();
    const result = face.getEyes(theme, 0);
    const content = eyes.content(theme, 0);
    assert.deepStrictEqual(result, content, 'afterglow should use content eyes');
  });

  test('petSpam getMouth: level >= 2 returns grin', () => {
    const face = new ClaudeFace();
    face.petSpamActive = true;
    face.petSpamLevel = 2;
    const theme = face.getTheme();
    assert.strictEqual(face.getMouth(theme, 0), mouths.grin());
  });

  test('petSpam getMouth: level 1 returns wide', () => {
    const face = new ClaudeFace();
    face.petSpamActive = true;
    face.petSpamLevel = 1;
    const theme = face.getTheme();
    assert.strictEqual(face.getMouth(theme, 0), mouths.wide());
  });
});

// -- Session list toggle -------------------------------------------

describe('face.js -- toggleSessionList', () => {
  test('toggleSessionList flips showSessionList', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.showSessionList, false);
    face.toggleSessionList();
    assert.strictEqual(face.showSessionList, true);
    face.toggleSessionList();
    assert.strictEqual(face.showSessionList, false);
  });

  test('toggleSessionList closes help overlay (mutual exclusion)', () => {
    const face = new ClaudeFace();
    face.showHelp = true;
    face.toggleSessionList();
    assert.strictEqual(face.showSessionList, true);
    assert.strictEqual(face.showHelp, false, 'help should be closed when session list opens');
  });

  test('toggleHelp closes session list (mutual exclusion)', () => {
    const face = new ClaudeFace();
    face.showSessionList = true;
    face.toggleHelp();
    assert.strictEqual(face.showHelp, true);
    assert.strictEqual(face.showSessionList, false, 'session list should be closed when help opens');
  });

  test('showSessionList initializes to false', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.showSessionList, false);
  });

  test('sessionListIndex initializes to 0', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.sessionListIndex, 0);
  });

  test('sessionListCount initializes to 0', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.sessionListCount, 0);
  });

  test('sessionListPromote initializes to null', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.sessionListPromote, null);
  });

  test('toggleSessionList resets sessionListIndex and sessionListPromote', () => {
    const face = new ClaudeFace();
    face.sessionListIndex = 5;
    face.sessionListPromote = 2;
    face.toggleSessionList(); // open
    assert.strictEqual(face.showSessionList, true);
    assert.strictEqual(face.sessionListIndex, 0);
    assert.strictEqual(face.sessionListPromote, null);
  });
});

// -- _compressTimeline segment capping (pass 2) ---

describe('_compressTimeline segment capping', () => {
  test('dominant segment among many short ones gets capped to MAX_SEGMENT_BLOCKS', () => {
    const face = new ClaudeFace();
    const base = 100000;
    // Many short active segments + one huge sleep — realistic timeline
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'reading', at: base + 2000 },
      { state: 'coding', at: base + 3000 },
      { state: 'sleeping', at: base + 5000 },   // 60s sleep
      { state: 'coding', at: base + 65000 },
      { state: 'executing', at: base + 66000 },
      { state: 'coding', at: base + 67000 },
      { state: 'testing', at: base + 68000 },
    ];
    const now = base + 69000;
    const { entries, displayNow } = face._compressTimeline(now, 38);
    // Find the sleeping segment and verify it occupies exactly MAX_SEGMENT_BLOCKS
    const sleepIdx = entries.findIndex(e => e.state === 'sleeping');
    const sleepDur = entries[sleepIdx + 1].at - entries[sleepIdx].at;
    const totalDur = displayNow - entries[0].at;
    const sleepBlocks = (sleepDur / totalDur) * 38;
    assert.ok(sleepBlocks <= MAX_SEGMENT_BLOCKS + 0.01,
      `sleeping occupies ${sleepBlocks.toFixed(1)} blocks, expected <= ${MAX_SEGMENT_BLOCKS}`);
  });

  test('barWidth parameter scales the cap correctly', () => {
    const face = new ClaudeFace();
    const base = 100000;
    // 8+ entries so redistribution has room (barWidth/MAX ≈ 8 segments needed)
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'reading', at: base + 1000 },
      { state: 'executing', at: base + 2000 },
      { state: 'sleeping', at: base + 3000 },   // dominant segment
      { state: 'coding', at: base + 80000 },
      { state: 'testing', at: base + 81000 },
      { state: 'reading', at: base + 82000 },
      { state: 'executing', at: base + 83000 },
      { state: 'coding', at: base + 84000 },
    ];
    const now = base + 85000;
    const r20 = face._compressTimeline(now, 20);
    const r38 = face._compressTimeline(now, 38);
    const sleepIdx20 = r20.entries.findIndex(e => e.state === 'sleeping');
    const sleepDur20 = r20.entries[sleepIdx20 + 1].at - r20.entries[sleepIdx20].at;
    const total20 = r20.displayNow - r20.entries[0].at;
    const sleepIdx38 = r38.entries.findIndex(e => e.state === 'sleeping');
    const sleepDur38 = r38.entries[sleepIdx38 + 1].at - r38.entries[sleepIdx38].at;
    const total38 = r38.displayNow - r38.entries[0].at;
    assert.ok((sleepDur20 / total20) * 20 <= MAX_SEGMENT_BLOCKS + 0.01,
      'barWidth=20: sleep blocks should be capped');
    assert.ok((sleepDur38 / total38) * 38 <= MAX_SEGMENT_BLOCKS + 0.01,
      'barWidth=38: sleep blocks should be capped');
  });

  test('fewer than 3 entries skips capping', () => {
    const face = new ClaudeFace();
    const base = 100000;
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'sleeping', at: base + 1000 },
    ];
    const now = base + 200000;
    const { entries, displayNow } = face._compressTimeline(now, 38);
    assert.strictEqual(entries.length, 2);
    // Sleeping is low-activity, so pass 1 compression applies
    assert.ok(displayNow <= now);
  });

  test('all segments equally large — no capping applied (guard fires)', () => {
    const face = new ClaudeFace();
    const base = 100000;
    // 3 equal segments — all exceed cap, but all would be capped → no change
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'executing', at: base + 50000 },
      { state: 'testing', at: base + 100000 },
    ];
    const now = base + 150000;
    const { entries } = face._compressTimeline(now, 38);
    assert.strictEqual(entries.length, 3);
    // Segments should be preserved (all capped = no redistribution possible)
    const dur0 = entries[1].at - entries[0].at;
    const dur1 = entries[2].at - entries[1].at;
    assert.strictEqual(dur0, 50000);
    assert.strictEqual(dur1, 50000);
  });

  test('trailing segment (last state to displayNow) is also capped', () => {
    const face = new ClaudeFace();
    const base = 100000;
    // 8 entries, huge trailing sleep
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'reading', at: base + 1000 },
      { state: 'executing', at: base + 2000 },
      { state: 'coding', at: base + 3000 },
      { state: 'testing', at: base + 4000 },
      { state: 'reading', at: base + 5000 },
      { state: 'executing', at: base + 6000 },
      { state: 'sleeping', at: base + 7000 },
    ];
    const now = base + 100000;  // 93s trailing sleep
    const { entries, displayNow } = face._compressTimeline(now, 38);
    const trailDur = displayNow - entries[entries.length - 1].at;
    const totalDur = displayNow - entries[0].at;
    const trailBlocks = (trailDur / totalDur) * 38;
    assert.ok(trailBlocks <= MAX_SEGMENT_BLOCKS + 0.01,
      `trailing segment occupies ${trailBlocks.toFixed(1)} blocks, expected <= ${MAX_SEGMENT_BLOCKS}`);
  });

  test('pass 2 interacts correctly with pass 1 low-activity compression', () => {
    const face = new ClaudeFace();
    const base = 100000;
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'reading', at: base + 1000 },
      { state: 'idle', at: base + 2000 },
      { state: 'coding', at: base + 120000 },  // 118s idle gap → capped to 30s by pass 1
      { state: 'executing', at: base + 121000 },
      { state: 'testing', at: base + 122000 },
    ];
    const now = base + 123000;
    const { entries } = face._compressTimeline(now, 38);
    assert.strictEqual(entries.length, 6);
    // Pass 1 should have compressed the idle gap
    const idleIdx = entries.findIndex(e => e.state === 'idle');
    const idleGap = entries[idleIdx + 1].at - entries[idleIdx].at;
    assert.ok(idleGap <= COMPRESS_LOW_CAP + 1,
      `idle gap ${idleGap} should be compressed by pass 1`);
  });

  test('barWidth smaller than MAX_SEGMENT_BLOCKS effectively disables capping', () => {
    const face = new ClaudeFace();
    const base = 100000;
    face.timeline = [
      { state: 'coding', at: base },
      { state: 'reading', at: base + 1000 },
      { state: 'sleeping', at: base + 2000 },
      { state: 'coding', at: base + 100000 },
    ];
    const now = base + 101000;
    // barWidth=3: each segment gets at most 3 blocks, MAX=5 can never trigger
    const { entries } = face._compressTimeline(now, 3);
    assert.strictEqual(entries.length, 4);
  });

  test('MAX_SEGMENT_BLOCKS is exported and equals 5', () => {
    assert.strictEqual(MAX_SEGMENT_BLOCKS, 5);
  });
});

// -- New test sections -----------------------------------------------

describe('face.js -- ClaudeFace.pet()', () => {
  test('pet() sets petTimer > 0', () => {
    const face = new ClaudeFace();
    face.petTimer = 0;
    face.pet();
    assert.ok(face.petTimer > 0, `expected petTimer > 0, got ${face.petTimer}`);
  });

  test('pet() sets petWiggle > 0 after update', () => {
    const face = new ClaudeFace();
    face.pet();
    // petWiggle is set during update() based on petTimer
    face.update(66);
    assert.ok(face.petWiggle !== 0, `expected petWiggle !== 0, got ${face.petWiggle}`);
  });

  test('pet() spawns sparkle particles', () => {
    const face = new ClaudeFace();
    const before = face.particles.particles.length;
    face.pet();
    const after = face.particles.particles.length;
    assert.ok(after > before, `expected particles to increase from ${before}, got ${after}`);
  });

  test('pet() adds to petTimes array', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.petTimes.length, 0);
    face.pet();
    assert.ok(face.petTimes.length > 0, 'expected petTimes to have entries');
  });
});

describe('face.js -- ClaudeFace toggle methods', () => {
  test('cycleTheme() increments paletteIndex', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.paletteIndex, 0);
    face.cycleTheme();
    assert.strictEqual(face.paletteIndex, 1);
  });

  test('toggleStats() flips showStats', () => {
    const face = new ClaudeFace();
    const before = face.showStats;
    face.toggleStats();
    assert.strictEqual(face.showStats, !before);
  });

  test('toggleAccessories() flips accessoriesEnabled', () => {
    const face = new ClaudeFace();
    const before = face.accessoriesEnabled;
    face.toggleAccessories();
    assert.strictEqual(face.accessoriesEnabled, !before);
  });

  test('toggleOrbitals() flips showOrbitals', () => {
    const face = new ClaudeFace();
    const before = face.showOrbitals;
    face.toggleOrbitals();
    assert.strictEqual(face.showOrbitals, !before);
  });

  test('toggleHelp() flips showHelp', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.showHelp, false);
    face.toggleHelp();
    assert.strictEqual(face.showHelp, true);
  });

  test('toggleSessionList() flips showSessionList', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.showSessionList, false);
    face.toggleSessionList();
    assert.strictEqual(face.showSessionList, true);
  });
});

describe('face.js -- ClaudeFace.update()', () => {
  test('update() increments frame', () => {
    const face = new ClaudeFace();
    const before = face.frame;
    face.update(66);
    assert.strictEqual(face.frame, before + 1);
  });

  test('update() increments time by dt', () => {
    const face = new ClaudeFace();
    const before = face.time;
    face.update(66);
    assert.strictEqual(face.time, before + 66);
  });

  test('update() decrements petTimer toward 0', () => {
    const face = new ClaudeFace();
    face.petTimer = 5;
    face.update(66);
    assert.strictEqual(face.petTimer, 4);
  });

  test('update() flushes pendingState after minDisplayUntil', () => {
    const face = new ClaudeFace();
    face.setState('coding');
    // Force minDisplayUntil into the past so pending will flush
    face.minDisplayUntil = Date.now() - 1;
    face.pendingState = 'reading';
    face.pendingDetail = 'test.js';
    face.update(66);
    assert.strictEqual(face.state, 'reading');
  });
});

describe('face.js -- ClaudeFace setState error bypass', () => {
  test('error always bypasses min display time', () => {
    const face = new ClaudeFace();
    face.setState('coding');
    // coding has a 6000ms min display time, but error should bypass it
    face.setState('error');
    assert.strictEqual(face.state, 'error');
  });
});

describe('face.js -- ClaudeFace active work bypass', () => {
  test('active work states bypass interruptible states', () => {
    const interruptible = ['idle', 'thinking', 'happy', 'satisfied', 'proud', 'relieved', 'sleeping', 'waiting'];
    const workStates = ['coding', 'reading', 'executing', 'searching', 'testing'];
    for (const inter of interruptible) {
      for (const work of workStates) {
        const face = new ClaudeFace();
        face.state = inter;
        face.lastStateChange = Date.now() - 10000; // ensure completion min show has passed
        face.minDisplayUntil = Date.now() + 60000; // far in the future
        face.setState(work);
        assert.strictEqual(face.state, work,
          `expected ${work} to bypass ${inter}, but state is ${face.state}`);
      }
    }
  });
});

describe('face.js -- ClaudeFace completion buffering', () => {
  test('completion states are buffered during active work states', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const comp of completionStates) {
      const face = new ClaudeFace();
      face.setState('coding');
      // coding is active work with min display time still active
      face.setState(comp);
      // completion should be buffered, not immediately applied
      assert.strictEqual(face.state, 'coding',
        `expected coding to remain during ${comp} buffering, but state is ${face.state}`);
      assert.strictEqual(face.pendingState, comp,
        `expected ${comp} to be pending, but pendingState is ${face.pendingState}`);
    }
  });
});

describe('face.js -- LOW_ACTIVITY_STATES', () => {
  test('contains idle, sleeping, waiting', () => {
    assert.ok(LOW_ACTIVITY_STATES.has('idle'));
    assert.ok(LOW_ACTIVITY_STATES.has('sleeping'));
    assert.ok(LOW_ACTIVITY_STATES.has('waiting'));
  });

  test('does not contain coding or thinking', () => {
    assert.ok(!LOW_ACTIVITY_STATES.has('coding'));
    assert.ok(!LOW_ACTIVITY_STATES.has('thinking'));
  });
});

describe('face.js -- COMPRESS_LOW_CAP and MAX_SEGMENT_BLOCKS', () => {
  test('COMPRESS_LOW_CAP is a positive number', () => {
    assert.strictEqual(typeof COMPRESS_LOW_CAP, 'number');
    assert.ok(COMPRESS_LOW_CAP > 0, `expected positive, got ${COMPRESS_LOW_CAP}`);
  });

  test('MAX_SEGMENT_BLOCKS is a positive number', () => {
    assert.strictEqual(typeof MAX_SEGMENT_BLOCKS, 'number');
    assert.ok(MAX_SEGMENT_BLOCKS > 0, `expected positive, got ${MAX_SEGMENT_BLOCKS}`);
  });
});

describe('face.js -- ClaudeFace._nextBlink()', () => {
  test('returns a number between BLINK_MIN (2500) and BLINK_MAX (6000)', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 100; i++) {
      const val = face._nextBlink();
      assert.ok(val >= 2500, `expected >= 2500, got ${val}`);
      assert.ok(val <= 6000, `expected <= 6000, got ${val}`);
    }
  });
});

describe('face.js -- ClaudeFace sparkline capping', () => {
  test('sparkline (timeline) is initialized and grows as update() runs', () => {
    const face = new ClaudeFace();
    // timeline starts with one entry [{state:'idle', at:...}]
    assert.ok(Array.isArray(face.timeline));
    assert.strictEqual(face.timeline.length, 1);
    // After state changes, timeline grows
    face.minDisplayUntil = 0;
    face.setState('coding');
    assert.ok(face.timeline.length > 1, `expected timeline to grow, got length ${face.timeline.length}`);
    face.minDisplayUntil = 0;
    face.setState('reading');
    assert.ok(face.timeline.length > 2, `expected timeline to grow further, got length ${face.timeline.length}`);
  });
});

// -- workState injection (renderer piggyback for fast tool race condition) ---

describe('face.js -- workState injection simulation', () => {
  // These tests simulate what renderer.js checkState() does when it receives
  // a PostToolUse state file that includes workState/workDetail fields.

  const COMPLETION_STATES = new Set(['happy', 'satisfied', 'proud', 'relieved']);
  const ACTIVE_WORK_STATES = new Set(['executing', 'coding', 'reading', 'searching', 'testing', 'installing', 'committing', 'reviewing', 'subagent', 'responding', 'training']);

  function applyStateWithWorkState(face, stateData) {
    // Mirror the renderer's checkState() injection logic
    if (stateData.workState
        && COMPLETION_STATES.has(stateData.state)
        && !ACTIVE_WORK_STATES.has(face.state)) {
      face.setState(stateData.workState, stateData.workDetail || '');
    }
    face.setState(stateData.state, stateData.detail);
  }

  test('thinking face receives workState=executing then relieved: executing applies, relieved buffers', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    applyStateWithWorkState(face, { state: 'relieved', detail: 'done', workState: 'executing', workDetail: 'ls' });
    assert.strictEqual(face.state, 'executing', 'work state should apply when face was thinking');
    assert.strictEqual(face.stateDetail, 'ls');
    assert.strictEqual(face.pendingState, 'relieved', 'completion should be buffered behind work state');
  });

  test('thinking face receives workState=coding then satisfied: coding applies, satisfied buffers', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    applyStateWithWorkState(face, { state: 'satisfied', detail: 'edited', workState: 'coding', workDetail: 'main.js' });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.pendingState, 'satisfied');
  });

  test('face already executing when completion arrives: workState injection skipped', () => {
    const face = new ClaudeFace();
    face.setState('executing', 'npm test');
    applyStateWithWorkState(face, { state: 'relieved', detail: 'done', workState: 'executing', workDetail: 'npm test' });
    // Should NOT re-inject executing -- face was already in active work state
    assert.strictEqual(face.state, 'executing', 'should stay on existing executing state');
    assert.strictEqual(face.stateDetail, 'npm test');
    assert.strictEqual(face.pendingState, 'relieved');
  });

  test('face in coding when different workState arrives: injection skipped (already active)', () => {
    const face = new ClaudeFace();
    face.setState('coding', 'editing');
    applyStateWithWorkState(face, { state: 'satisfied', detail: 'done', workState: 'executing', workDetail: 'ls' });
    assert.strictEqual(face.state, 'coding', 'should stay on coding, not switch to executing');
    assert.strictEqual(face.pendingState, 'satisfied');
  });

  test('no workState field: behaves like normal setState', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    applyStateWithWorkState(face, { state: 'relieved', detail: 'done' });
    // No workState means no injection -- relieved goes straight in
    // (thinking is not active work, so relieved should apply or buffer per normal rules)
    assert.ok(face.state === 'relieved' || face.pendingState === 'relieved',
      'relieved should either apply or buffer without injection');
  });

  test('error state is not in COMPLETION_STATES: workState injection skipped', () => {
    const face = new ClaudeFace();
    face.setState('thinking');
    applyStateWithWorkState(face, { state: 'error', detail: 'failed', workState: 'executing', workDetail: 'rm -rf' });
    // error bypasses everything via normal setState -- should NOT inject executing first
    assert.strictEqual(face.state, 'error', 'error should apply directly without injection');
  });

  test('idle face receives workState=searching then happy: searching applies', () => {
    const face = new ClaudeFace();
    // idle is not in ACTIVE_WORK_STATES, so injection should fire
    applyStateWithWorkState(face, { state: 'happy', detail: 'found', workState: 'searching', workDetail: 'grep' });
    assert.strictEqual(face.state, 'searching');
    assert.strictEqual(face.pendingState, 'happy');
  });

  test('sleeping face receives workState=reading then proud: reading applies', () => {
    const face = new ClaudeFace();
    face.setState('sleeping');
    face.minDisplayUntil = 0; // expire sleep so states can apply
    applyStateWithWorkState(face, { state: 'proud', detail: 'committed', workState: 'reading', workDetail: 'file.js' });
    assert.strictEqual(face.state, 'reading');
    assert.strictEqual(face.pendingState, 'proud');
  });
});

module.exports = { passed: () => passed, failed: () => failed };
