#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - animations.js                            |
// +================================================================+

const assert = require('assert');
const { mouths, eyes, gridMouths } = require('../animations');

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

describe('animations.js -- mouths', () => {
  test('all mouth functions return strings', () => {
    for (const [name, fn] of Object.entries(mouths)) {
      const result = fn();
      assert.ok(typeof result === 'string', `mouths.${name}() should return string`);
      assert.ok(result.length > 0, `mouths.${name}() should be non-empty`);
    }
  });

  test('glitch returns varying results', () => {
    const results = new Set();
    for (let i = 0; i < 20; i++) results.add(mouths.glitch());
    assert.ok(results.size > 1, 'glitch mouth should have randomness');
  });
});

describe('animations.js -- eyes', () => {
  const staticEyes = ['open', 'blink', 'halfClose', 'narrowed', 'focused', 'lookLeft', 'lookRight', 'cross', 'wide', 'down', 'echo', 'content'];

  test('static eye functions return correct shape', () => {
    for (const name of staticEyes) {
      const result = eyes[name]();
      assert.ok(result.left, `eyes.${name}() missing left`);
      assert.ok(result.right, `eyes.${name}() missing right`);
      assert.strictEqual(result.left.length, 2, `eyes.${name}().left should have 2 rows`);
      assert.strictEqual(result.right.length, 2, `eyes.${name}().right should have 2 rows`);
    }
  });

  test('animated eye functions return correct shape', () => {
    const animated = ['sparkle', 'spin', 'sleeping', 'waiting', 'intense', 'vibrate', 'pleased'];
    for (const name of animated) {
      const result = eyes[name]({}, 0);
      assert.ok(result.left, `eyes.${name}() missing left`);
      assert.ok(result.right, `eyes.${name}() missing right`);
      assert.strictEqual(result.left.length, 2, `eyes.${name}().left should have 2 rows`);
      assert.strictEqual(result.right.length, 2, `eyes.${name}().right should have 2 rows`);
    }
  });

  test('glitch eyes have randomness', () => {
    const results = new Set();
    for (let i = 0; i < 20; i++) {
      const e = eyes.glitch();
      results.add(JSON.stringify(e));
    }
    assert.ok(results.size > 1, 'glitch eyes should vary');
  });
});

describe('animations.js -- gridMouths', () => {
  const ALL_STATES = [
    'idle', 'thinking', 'coding', 'reading', 'searching', 'executing',
    'happy', 'satisfied', 'proud', 'relieved', 'error', 'sleeping',
    'waiting', 'testing', 'installing', 'caffeinated', 'subagent',
    'committing',
  ];

  test('every state has a grid mouth', () => {
    for (const state of ALL_STATES) {
      assert.ok(typeof gridMouths[state] === 'string', `missing gridMouth for: ${state}`);
    }
  });
});

describe('animations.js -- eye frame variance', () => {
  const theme = {}; // animated eyes don't use theme colors for char selection

  test('sparkle differs between frame 0 and frame 1', () => {
    const a = eyes.sparkle(theme, 0);
    const b = eyes.sparkle(theme, 1);
    assert.notDeepStrictEqual(a, b, 'sparkle should change between frames');
  });

  test('spin differs between frame 0 and frame 1', () => {
    const a = eyes.spin(theme, 0);
    const b = eyes.spin(theme, 1);
    assert.notDeepStrictEqual(a, b, 'spin should change between frames');
  });

  test('waiting differs between frame 0 and frame 40', () => {
    const a = eyes.waiting(theme, 0);
    const b = eyes.waiting(theme, 40);
    assert.notDeepStrictEqual(a, b, 'waiting should drift at frame 40');
  });

  test('vibrate differs between frame 0 and frame 1', () => {
    const a = eyes.vibrate(theme, 0);
    const b = eyes.vibrate(theme, 1);
    assert.notDeepStrictEqual(a, b, 'vibrate should offset between frames');
  });

  test('conducting differs between frame 0 and frame 30', () => {
    const a = eyes.conducting(theme, 0);
    const b = eyes.conducting(theme, 30);
    assert.notDeepStrictEqual(a, b, 'conducting should scan between phases');
  });

  test('pleased differs between frame 0 and frame 2', () => {
    // frame 0: 0 % 50 < 3 => squint; frame 3: 3 % 50 < 3 is false => open
    const a = eyes.pleased(theme, 0);
    const b = eyes.pleased(theme, 3);
    assert.notDeepStrictEqual(a, b, 'pleased should alternate squint/open');
  });

  test('responding differs between frame 0 and frame 2', () => {
    const a = eyes.responding(theme, 0);
    const b = eyes.responding(theme, 2);
    assert.notDeepStrictEqual(a, b, 'responding should alternate');
  });

  test('all animated eye functions still return valid shape at various frames', () => {
    const animated = ['sparkle', 'spin', 'sleeping', 'waiting', 'intense', 'vibrate', 'pleased', 'conducting', 'responding'];
    for (const name of animated) {
      for (const f of [0, 1, 10, 30, 60, 100, 150]) {
        const result = eyes[name](theme, f);
        assert.ok(result.left, `eyes.${name}(f=${f}) missing left`);
        assert.ok(result.right, `eyes.${name}(f=${f}) missing right`);
        assert.strictEqual(result.left.length, 2, `eyes.${name}(f=${f}).left should have 2 rows`);
        assert.strictEqual(result.right.length, 2, `eyes.${name}(f=${f}).right should have 2 rows`);
      }
    }
  });
});

describe('animations.js -- gridMouths count', () => {
  test('gridMouths has entries for all expected states', () => {
    const expectedStates = [
      'idle', 'thinking', 'coding', 'reading', 'searching', 'executing',
      'happy', 'satisfied', 'proud', 'relieved', 'error', 'sleeping',
      'waiting', 'testing', 'installing', 'caffeinated', 'subagent',
      'committing', 'responding', 'starting', 'spawning', 'reviewing', 'ratelimited',
    ];
    for (const state of expectedStates) {
      assert.ok(typeof gridMouths[state] === 'string', `missing gridMouth for: ${state}`);
    }
  });

  test('gridMouths count matches actual keys', () => {
    const keys = Object.keys(gridMouths);
    assert.ok(keys.length >= 23, `expected at least 23 gridMouths, got ${keys.length}`);
  });
});

describe('animations.js -- mouth output consistency', () => {
  test('all mouths return non-empty strings', () => {
    for (const [name, fn] of Object.entries(mouths)) {
      const result = fn();
      assert.ok(typeof result === 'string', `mouths.${name}() should return string`);
      assert.ok(result.length > 0, `mouths.${name}() should be non-empty`);
    }
  });

  test('deterministic mouths return consistent length across calls', () => {
    const deterministic = ['smile', 'neutral', 'wide', 'curious', 'frown', 'smirk', 'ooh', 'determined', 'wavy', 'wait', 'tight', 'dots', 'grin', 'calm', 'catMouth', 'exhale', 'content', 'responding'];
    for (const name of deterministic) {
      const a = mouths[name]();
      const b = mouths[name]();
      assert.strictEqual(a.length, b.length, `mouths.${name}() should have consistent length`);
      assert.strictEqual(a, b, `mouths.${name}() should be deterministic`);
    }
  });
});

module.exports = { passed: () => passed, failed: () => failed };
