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
  ];

  test('every state has a grid mouth', () => {
    for (const state of ALL_STATES) {
      assert.ok(typeof gridMouths[state] === 'string', `missing gridMouth for: ${state}`);
    }
  });
});

module.exports = { passed: () => passed, failed: () => failed };
