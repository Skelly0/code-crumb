#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - transition.js                          |
// +================================================================+

const assert = require('assert');
const {
  SwapTransition,
  DISSOLVE_FRAMES,
  MATERIALIZE_FRAMES,
  TOTAL_FRAMES,
  DIM_MIN,
  DIM_MAX,
} = require('../transition');

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

describe('transition.js -- SwapTransition constructor', () => {
  test('defaults to inactive', () => {
    const t = new SwapTransition();
    assert.strictEqual(t.active, false);
    assert.strictEqual(t.phase, 'idle');
    assert.strictEqual(t.frame, 0);
  });

  test('fromId and toId default to null', () => {
    const t = new SwapTransition();
    assert.strictEqual(t.fromId, null);
    assert.strictEqual(t.toId, null);
  });
});

describe('transition.js -- start()', () => {
  test('activates and stores IDs', () => {
    const t = new SwapTransition();
    t.start('old-session', 'new-session');
    assert.strictEqual(t.active, true);
    assert.strictEqual(t.fromId, 'old-session');
    assert.strictEqual(t.toId, 'new-session');
    assert.strictEqual(t.phase, 'dissolve');
    assert.strictEqual(t.frame, 0);
  });

  test('double-start resets frame counter', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    t.tick(); t.tick(); t.tick();
    assert.ok(t.frame > 0);
    t.start('c', 'd');
    assert.strictEqual(t.frame, 0);
    assert.strictEqual(t.fromId, 'c');
    assert.strictEqual(t.toId, 'd');
  });
});

describe('transition.js -- tick() phase progression', () => {
  test('dissolve phase lasts DISSOLVE_FRAMES ticks', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    for (let i = 0; i < DISSOLVE_FRAMES; i++) {
      const result = t.tick();
      assert.strictEqual(result.phase, 'dissolve');
      assert.strictEqual(result.done, false);
    }
  });

  test('swap phase at frame DISSOLVE_FRAMES + 1', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    for (let i = 0; i < DISSOLVE_FRAMES; i++) t.tick();
    const result = t.tick();
    assert.strictEqual(result.phase, 'swap');
    assert.strictEqual(result.done, false);
  });

  test('materialize phase lasts MATERIALIZE_FRAMES ticks', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    // dissolve + swap
    for (let i = 0; i <= DISSOLVE_FRAMES; i++) t.tick();
    for (let i = 0; i < MATERIALIZE_FRAMES; i++) {
      const result = t.tick();
      assert.strictEqual(result.phase, 'materialize');
      assert.strictEqual(result.done, false);
    }
  });

  test('last visual frame is materialize', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    let result;
    for (let i = 0; i < TOTAL_FRAMES; i++) {
      result = t.tick();
    }
    // Frame TOTAL_FRAMES is the last materialize frame
    assert.strictEqual(result.phase, 'materialize');
    assert.strictEqual(result.done, false);
  });

  test('done fires one tick after TOTAL_FRAMES', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    for (let i = 0; i < TOTAL_FRAMES; i++) t.tick();
    const result = t.tick(); // tick TOTAL_FRAMES + 1
    assert.strictEqual(result.phase, 'done');
    assert.strictEqual(result.done, true);
    assert.strictEqual(t.active, false);
  });

  test('dissolve progress goes 0 to 1', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    const first = t.tick();
    assert.ok(first.progress > 0);
    assert.ok(first.progress <= 1);
    // Tick through rest of dissolve
    let last;
    for (let i = 1; i < DISSOLVE_FRAMES; i++) last = t.tick();
    assert.strictEqual(last.progress, 1);
  });

  test('materialize progress goes 0 to 1', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    for (let i = 0; i <= DISSOLVE_FRAMES; i++) t.tick(); // dissolve + swap
    const first = t.tick();
    assert.ok(first.progress > 0);
    let last;
    for (let i = 1; i < MATERIALIZE_FRAMES; i++) last = t.tick();
    assert.strictEqual(last.progress, 1);
  });
});

describe('transition.js -- tick() when inactive', () => {
  test('returns idle/done when not started', () => {
    const t = new SwapTransition();
    const result = t.tick();
    assert.strictEqual(result.phase, 'idle');
    assert.strictEqual(result.done, true);
  });

  test('returns idle/done after animation completes', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    for (let i = 0; i <= TOTAL_FRAMES; i++) t.tick(); // TOTAL_FRAMES+1 to reach done
    const result = t.tick(); // now inactive
    assert.strictEqual(result.phase, 'idle');
    assert.strictEqual(result.done, true);
  });
});

describe('transition.js -- dimFactor()', () => {
  test('returns 1.0 when inactive', () => {
    const t = new SwapTransition();
    assert.strictEqual(t.dimFactor(), DIM_MAX);
  });

  test('dissolve: starts near 1.0 and ends near DIM_MIN', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    t.tick(); // frame 1
    const first = t.dimFactor();
    assert.ok(first < DIM_MAX);
    assert.ok(first > DIM_MIN);
    for (let i = 1; i < DISSOLVE_FRAMES; i++) t.tick();
    const last = t.dimFactor();
    assert.ok(Math.abs(last - DIM_MIN) < 0.01);
  });

  test('swap phase: returns DIM_MIN', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    for (let i = 0; i < DISSOLVE_FRAMES; i++) t.tick();
    t.tick(); // swap frame
    assert.strictEqual(t.dimFactor(), DIM_MIN);
  });

  test('materialize: starts near DIM_MIN and ends near 1.0', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    for (let i = 0; i <= DISSOLVE_FRAMES; i++) t.tick(); // dissolve + swap
    t.tick(); // first materialize frame
    const first = t.dimFactor();
    assert.ok(first > DIM_MIN);
    assert.ok(first < DIM_MAX);
    for (let i = 1; i < MATERIALIZE_FRAMES; i++) t.tick();
    const last = t.dimFactor();
    assert.ok(Math.abs(last - DIM_MAX) < 0.01);
  });

  test('full curve: 1.0 -> 0.15 -> 0.15 -> 1.0', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    // Before any tick
    const initial = t.dimFactor();
    assert.ok(initial >= DIM_MAX - 0.01);
    // End of dissolve
    for (let i = 0; i < DISSOLVE_FRAMES; i++) t.tick();
    assert.ok(Math.abs(t.dimFactor() - DIM_MIN) < 0.01);
    // Swap
    t.tick();
    assert.strictEqual(t.dimFactor(), DIM_MIN);
    // End of materialize
    for (let i = 0; i < MATERIALIZE_FRAMES; i++) t.tick();
    assert.ok(Math.abs(t.dimFactor() - DIM_MAX) < 0.01);
  });
});

describe('transition.js -- cancel()', () => {
  test('deactivates and resets state', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    t.tick(); t.tick();
    t.cancel();
    assert.strictEqual(t.active, false);
    assert.strictEqual(t.phase, 'idle');
    assert.strictEqual(t.frame, 0);
    assert.strictEqual(t.fromId, null);
    assert.strictEqual(t.toId, null);
  });

  test('cancel when inactive is a no-op', () => {
    const t = new SwapTransition();
    t.cancel(); // should not throw
    assert.strictEqual(t.active, false);
  });

  test('dimFactor returns 1.0 after cancel', () => {
    const t = new SwapTransition();
    t.start('a', 'b');
    t.tick(); t.tick(); t.tick();
    t.cancel();
    assert.strictEqual(t.dimFactor(), DIM_MAX);
  });
});

describe('transition.js -- constants', () => {
  test('TOTAL_FRAMES = DISSOLVE + 1 + MATERIALIZE', () => {
    assert.strictEqual(TOTAL_FRAMES, DISSOLVE_FRAMES + 1 + MATERIALIZE_FRAMES);
  });

  test('DIM_MIN < DIM_MAX', () => {
    assert.ok(DIM_MIN < DIM_MAX);
  });

  test('DISSOLVE_FRAMES is positive', () => {
    assert.ok(DISSOLVE_FRAMES > 0);
  });

  test('MATERIALIZE_FRAMES is positive', () => {
    assert.ok(MATERIALIZE_FRAMES > 0);
  });
});

module.exports = { passed: () => passed, failed: () => failed };
