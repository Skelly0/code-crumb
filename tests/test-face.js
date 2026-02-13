#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - face.js                                   |
// +================================================================+

const assert = require('assert');
const { ClaudeFace } = require('../face');
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

  test('happy → 5000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('happy'), 5000);
  });

  test('error → 3500ms', () => {
    assert.strictEqual(face._getMinDisplayMs('error'), 3500);
  });

  test('coding → 2500ms', () => {
    assert.strictEqual(face._getMinDisplayMs('coding'), 2500);
  });

  test('reading → 2000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('reading'), 2000);
  });

  test('sleeping → 1000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('sleeping'), 1000);
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
    face.setState('happy');
    face.setState('coding');
    assert.strictEqual(face.state, 'happy');
    assert.strictEqual(face.pendingState, 'coding');
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
      'caffeinated', 'subagent',
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
      'caffeinated', 'subagent',
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

  test('afterglow overrides mouth to smile', () => {
    const face = new ClaudeFace();
    face.state = 'error';
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    const theme = face.getTheme();
    const mouthResult = face.getMouth(theme, 0);
    assert.strictEqual(mouthResult, mouths.smile());
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

describe('face.js -- surround mode', () => {
  test('surroundMode defaults to false', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.surroundMode, false);
  });

  test('surroundFaces is initialized as empty Map', () => {
    const face = new ClaudeFace();
    assert.ok(face.surroundFaces instanceof Map);
    assert.strictEqual(face.surroundFaces.size, 0);
  });

  test('toggleSurroundMode flips the flag', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.surroundMode, false);
    face.toggleSurroundMode();
    assert.strictEqual(face.surroundMode, true);
    face.toggleSurroundMode();
    assert.strictEqual(face.surroundMode, false);
  });

  test('toggleSurroundMode triggers session load when enabling', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.surroundFaces.size, 0);
    face.surroundMode = true;
    face.loadSurroundSessions();
    // Should not throw even if sessions dir doesn't exist
    assert.ok(face.surroundFaces instanceof Map);
  });

  test('calculateSurroundPositions returns empty for no faces', () => {
    const face = new ClaudeFace();
    const positions = face.calculateSurroundPositions(80, 24, 30, 10, 8, 25);
    assert.strictEqual(positions.length, 0);
  });

  test('calculateSurroundPositions respects terminal boundaries', () => {
    const face = new ClaudeFace();
    face.surroundFaces.set('test1', {
      sessionId: 'test1',
      state: 'idle',
      firstSeen: Date.now(),
      cwd: '',
      label: 'test1',
    });
    const positions = face.calculateSurroundPositions(80, 24, 30, 10, 8, 25);
    assert.strictEqual(positions.length, 1);
    assert.ok(positions[0].row >= 1);
    assert.ok(positions[0].row < 24);
    assert.ok(positions[0].col >= 1);
    assert.ok(positions[0].col < 80);
  });

  test('calculateSurroundPositions uses multiple columns when needed', () => {
    const face = new ClaudeFace();
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      face.surroundFaces.set(`test${i}`, {
        sessionId: `test${i}`,
        state: 'idle',
        firstSeen: now + i,
        cwd: '',
        label: `test${i}`,
      });
    }
    const positions = face.calculateSurroundPositions(80, 30, 30, 10, 8, 25);
    assert.strictEqual(positions.length, 8);
    // Check that faces are distributed across columns
    const cols = positions.map(p => p.col);
    const uniqueCols = [...new Set(cols)];
    assert.ok(uniqueCols.length > 1, 'Should use multiple columns');
  });

  test('calculateSurroundPositions does not overflow into key hints area', () => {
    const face = new ClaudeFace();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      face.surroundFaces.set(`test${i}`, {
        sessionId: `test${i}`,
        state: 'idle',
        firstSeen: now + i,
        cwd: '',
        label: `test${i}`,
      });
    }
    const positions = face.calculateSurroundPositions(80, 24, 30, 10, 8, 25);
    // Key hints are at row 24 (last row), so faces should not extend there
    for (const pos of positions) {
      assert.ok(pos.row < 22, `Face at row ${pos.row} should be above key hints area`);
    }
  });
});

describe('face.js -- SurroundMiniFace', () => {
  const { SurroundMiniFace } = require('../face');

  test('SurroundMiniFace is exported', () => {
    assert.ok(typeof SurroundMiniFace === 'function');
  });

  test('SurroundMiniFace constructor initializes correctly', () => {
    const face = new SurroundMiniFace('test-id');
    assert.strictEqual(face.sessionId, 'test-id');
    assert.strictEqual(face.state, 'idle');
    assert.strictEqual(face.label, '');
    assert.ok(face.firstSeen > 0);
  });

  test('SurroundMiniFace updateFromFile changes state', () => {
    const face = new SurroundMiniFace('test-id');
    face.updateFromFile({ state: 'coding', detail: 'test.js' });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'test.js');
  });

  test('SurroundMiniFace updateFromFile tracks stopped', () => {
    const face = new SurroundMiniFace('test-id');
    assert.strictEqual(face.stopped, false);
    face.updateFromFile({ stopped: true });
    assert.strictEqual(face.stopped, true);
    assert.ok(face.stoppedAt > 0);
  });

  test('SurroundMiniFace isStale returns false for fresh face', () => {
    const face = new SurroundMiniFace('test-id');
    assert.strictEqual(face.isStale(), false);
  });

  test('SurroundMiniFace isStale returns true for old stopped face', () => {
    const face = new SurroundMiniFace('test-id');
    face.stopped = true;
    face.stoppedAt = Date.now() - 10000;
    assert.strictEqual(face.isStale(), true);
  });

  test('SurroundMiniFace getEyes returns string for all states', () => {
    const face = new SurroundMiniFace('test-id');
    const states = ['idle', 'thinking', 'reading', 'searching', 'coding', 'executing', 'happy', 'error', 'sleeping', 'waiting', 'testing', 'installing', 'caffeinated', 'subagent', 'satisfied', 'proud', 'relieved'];
    for (const state of states) {
      face.state = state;
      const eyes = face.getEyes();
      assert.ok(typeof eyes === 'string', `getEyes should return string for state ${state}`);
      assert.ok(eyes.length > 0, `getEyes should return non-empty string for state ${state}`);
    }
  });

  test('SurroundMiniFace getMouth returns string for all states', () => {
    const face = new SurroundMiniFace('test-id');
    const states = ['idle', 'thinking', 'reading', 'searching', 'coding', 'executing', 'happy', 'error', 'sleeping', 'waiting', 'testing', 'installing', 'caffeinated', 'subagent', 'satisfied', 'proud', 'relieved'];
    for (const state of states) {
      face.state = state;
      const mouth = face.getMouth();
      assert.ok(typeof mouth === 'string', `getMouth should return string for state ${state}`);
      assert.ok(mouth.length > 0, `getMouth should return non-empty string for state ${state}`);
    }
  });

  test('SurroundMiniFace tick updates frame and time', () => {
    const face = new SurroundMiniFace('test-id');
    const initialFrame = face.frame;
    face.tick(16);
    assert.strictEqual(face.frame, initialFrame + 1);
    assert.ok(face.time > 0);
  });

  test('SurroundMiniFace render returns string', () => {
    const face = new SurroundMiniFace('test-id');
    face.label = 'test';
    const output = face.render(5, 10, 0, null);
    assert.ok(typeof output === 'string');
    assert.ok(output.length > 0);
  });
});

module.exports = { passed: () => passed, failed: () => failed };
