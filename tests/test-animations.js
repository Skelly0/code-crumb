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
    const animated = ['sparkle', 'spin', 'sleeping', 'waiting', 'intense', 'vibrate', 'pleased', 'furnace'];
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
    'committing', 'training',
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

  test('furnace differs between frame 0 and frame 20', () => {
    const a = eyes.furnace({}, 0);
    const b = eyes.furnace({}, 20);
    assert.notDeepStrictEqual(a, b, 'furnace should pulse between phases');
  });

  test('all animated eye functions still return valid shape at various frames', () => {
    const animated = ['sparkle', 'spin', 'sleeping', 'waiting', 'intense', 'vibrate', 'pleased', 'conducting', 'responding', 'furnace'];
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
      'committing', 'responding', 'starting', 'spawning', 'reviewing', 'training',
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

describe('animations.js -- sleeping eye special frame', () => {
  test('sleeping returns blink form when frame % 150 > 145', () => {
    const result = eyes.sleeping({}, 146);
    // blink form: left ['  ', '▄▄'], right ['  ', '▄▄']
    assert.deepStrictEqual(result.left[0], '  ', 'sleeping blink left[0] should be empty');
    assert.ok(result.left[1] !== '──', 'sleeping blink left[1] should not be closed line');
  });

  test('sleeping returns normal closed form at frame 100', () => {
    const result = eyes.sleeping({}, 100);
    // normal closed form: left ['  ', '──'], right ['  ', '──']
    assert.deepStrictEqual(result.left[0], '  ', 'sleeping normal left[0] should be empty');
    assert.deepStrictEqual(result.right[0], '  ', 'sleeping normal right[0] should be empty');
  });

  test('sleeping blink and normal forms differ', () => {
    const blink = eyes.sleeping({}, 146);
    const normal = eyes.sleeping({}, 100);
    assert.notDeepStrictEqual(blink, normal, 'blink form should differ from normal closed form');
  });
});

describe('animations.js -- intense eye special frame', () => {
  test('intense returns shifted form when frame % 25 < 2', () => {
    const result = eyes.intense({}, 0);
    // shifted form: left and right differ asymmetrically
    assert.notDeepStrictEqual(result.left, result.right, 'intense shifted form should have asymmetric eyes');
  });

  test('intense returns normal form at frame 5', () => {
    const result = eyes.intense({}, 5);
    // normal form: both eyes are ██/██
    assert.deepStrictEqual(result.left, result.right, 'intense normal form should have symmetric eyes');
  });

  test('intense shifted and normal forms differ', () => {
    const shifted = eyes.intense({}, 0);
    const normal = eyes.intense({}, 5);
    assert.notDeepStrictEqual(shifted, normal, 'shifted and normal forms should differ');
  });
});

describe('animations.js -- conducting eye 6-phase cycle', () => {
  const theme = {};

  test('phase 0 (frame 0) returns open eyes', () => {
    const result = eyes.conducting(theme, 0);
    const expected = eyes.open();
    assert.deepStrictEqual(result, expected, 'phase 0 should return open');
  });

  test('phase 1 (frame 30) returns lookLeft eyes', () => {
    const result = eyes.conducting(theme, 30);
    const expected = eyes.lookLeft();
    assert.deepStrictEqual(result, expected, 'phase 1 should return lookLeft');
  });

  test('phase 2 (frame 60) returns open eyes', () => {
    const result = eyes.conducting(theme, 60);
    const expected = eyes.open();
    assert.deepStrictEqual(result, expected, 'phase 2 should return open');
  });

  test('phase 3 (frame 90) returns lookRight eyes', () => {
    const result = eyes.conducting(theme, 90);
    const expected = eyes.lookRight();
    assert.deepStrictEqual(result, expected, 'phase 3 should return lookRight');
  });

  test('phase 4 (frame 120) returns open eyes', () => {
    const result = eyes.conducting(theme, 120);
    const expected = eyes.open();
    assert.deepStrictEqual(result, expected, 'phase 4 should return open');
  });

  test('phase 5 (frame 150) returns focused eyes', () => {
    const result = eyes.conducting(theme, 150);
    const expected = eyes.focused();
    assert.deepStrictEqual(result, expected, 'phase 5 should return focused');
  });
});

describe('animations.js -- star eye frame variance', () => {
  test('star differs between frame 0 and frame 1', () => {
    const a = eyes.star({}, 0);
    const b = eyes.star({}, 1);
    assert.notDeepStrictEqual(a, b, 'star should change between frames');
  });

  test('star always returns {left: [2], right: [2]} shape', () => {
    for (const f of [0, 1, 2, 3, 10, 50]) {
      const result = eyes.star({}, f);
      assert.ok(result.left, `star(f=${f}) missing left`);
      assert.ok(result.right, `star(f=${f}) missing right`);
      assert.strictEqual(result.left.length, 2, `star(f=${f}).left should have 2 rows`);
      assert.strictEqual(result.right.length, 2, `star(f=${f}).right should have 2 rows`);
    }
  });
});

describe('animations.js -- wink/heart/tired static eyes', () => {
  test('wink returns valid {left:[2], right:[2]} shape', () => {
    const result = eyes.wink();
    assert.strictEqual(result.left.length, 2, 'wink left should have 2 rows');
    assert.strictEqual(result.right.length, 2, 'wink right should have 2 rows');
  });

  test('wink is deterministic', () => {
    const a = eyes.wink();
    const b = eyes.wink();
    assert.deepStrictEqual(a, b, 'wink should return same output each call');
  });

  test('heart returns valid {left:[2], right:[2]} shape', () => {
    const result = eyes.heart();
    assert.strictEqual(result.left.length, 2, 'heart left should have 2 rows');
    assert.strictEqual(result.right.length, 2, 'heart right should have 2 rows');
  });

  test('heart is deterministic', () => {
    const a = eyes.heart();
    const b = eyes.heart();
    assert.deepStrictEqual(a, b, 'heart should return same output each call');
  });

  test('tired returns valid {left:[2], right:[2]} shape', () => {
    const result = eyes.tired();
    assert.strictEqual(result.left.length, 2, 'tired left should have 2 rows');
    assert.strictEqual(result.right.length, 2, 'tired right should have 2 rows');
  });

  test('tired is deterministic', () => {
    const a = eyes.tired();
    const b = eyes.tired();
    assert.deepStrictEqual(a, b, 'tired should return same output each call');
  });
});

describe('animations.js -- furnace mouth randomness', () => {
  test('furnace mouth returns varying results', () => {
    const results = new Set();
    for (let i = 0; i < 20; i++) results.add(mouths.furnace());
    assert.ok(results.size > 1, 'furnace mouth should have randomness');
  });
});

describe('animations.js -- gridMouths all 23 states', () => {
  const ALL_23_STATES = [
    'idle', 'thinking', 'coding', 'reading', 'searching', 'executing',
    'happy', 'satisfied', 'proud', 'relieved', 'error', 'sleeping',
    'waiting', 'testing', 'installing', 'caffeinated', 'subagent',
    'responding', 'starting', 'spawning', 'committing', 'reviewing', 'training',
  ];

  test('every one of the 23 states has a string gridMouth', () => {
    for (const state of ALL_23_STATES) {
      assert.ok(typeof gridMouths[state] === 'string', `gridMouths.${state} should be a string`);
      assert.ok(gridMouths[state].length > 0, `gridMouths.${state} should be non-empty`);
    }
  });

  test('gridMouths covers at least all 23 states', () => {
    const keys = Object.keys(gridMouths);
    assert.ok(keys.length >= 23, `expected gridMouths to have >= 23 keys, got ${keys.length}`);
    for (const state of ALL_23_STATES) {
      assert.ok(keys.includes(state), `gridMouths missing key: ${state}`);
    }
  });
});

module.exports = { passed: () => passed, failed: () => failed };
