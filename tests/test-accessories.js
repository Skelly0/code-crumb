#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - accessories.js                            |
// +================================================================+

const assert = require('assert');
const { ACCESSORIES, STATE_ACCESSORIES, getAccessory } = require('../accessories');

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

describe('accessories.js -- ACCESSORIES', () => {
  test('all accessories have non-empty lines array', () => {
    for (const [name, acc] of Object.entries(ACCESSORIES)) {
      assert.ok(Array.isArray(acc.lines), `${name}.lines should be an array`);
      assert.ok(acc.lines.length > 0, `${name}.lines should be non-empty`);
    }
  });

  test('all accessory lines are non-empty strings', () => {
    for (const [name, acc] of Object.entries(ACCESSORIES)) {
      for (let i = 0; i < acc.lines.length; i++) {
        assert.ok(typeof acc.lines[i] === 'string', `${name}.lines[${i}] should be a string`);
        assert.ok(acc.lines[i].length > 0, `${name}.lines[${i}] should be non-empty`);
      }
    }
  });

  test('all accessories have at most 5 lines', () => {
    for (const [name, acc] of Object.entries(ACCESSORIES)) {
      assert.ok(acc.lines.length <= 5, `${name} should have at most 5 lines (has ${acc.lines.length})`);
    }
  });

  test('all accessory lines fit within face width', () => {
    const faceW = 30;
    for (const [name, acc] of Object.entries(ACCESSORIES)) {
      for (let i = 0; i < acc.lines.length; i++) {
        assert.ok(acc.lines[i].length <= faceW,
          `${name}.lines[${i}] is ${acc.lines[i].length} chars, exceeds face width ${faceW}`);
      }
    }
  });

  test('has at least 8 distinct accessories', () => {
    assert.ok(Object.keys(ACCESSORIES).length >= 8,
      `should have at least 8 accessories, has ${Object.keys(ACCESSORIES).length}`);
  });
});

describe('accessories.js -- STATE_ACCESSORIES', () => {
  test('maps at least 5 states to accessories', () => {
    const count = Object.keys(STATE_ACCESSORIES).length;
    assert.ok(count >= 5, `should map at least 5 states, maps ${count}`);
  });

  test('all mapped names exist in ACCESSORIES', () => {
    for (const [state, name] of Object.entries(STATE_ACCESSORIES)) {
      assert.ok(ACCESSORIES[name], `state ${state} maps to "${name}" which does not exist in ACCESSORIES`);
    }
  });

  test('installing maps to hardhat', () => {
    assert.strictEqual(STATE_ACCESSORIES.installing, 'hardhat');
  });

  test('reading has no accessory', () => {
    assert.strictEqual(STATE_ACCESSORIES.reading, undefined);
  });

  test('thinking maps to wizardhat', () => {
    assert.strictEqual(STATE_ACCESSORIES.thinking, 'wizardhat');
  });

  test('coding maps to catears', () => {
    assert.strictEqual(STATE_ACCESSORIES.coding, 'catears');
  });

  test('committing maps to gitpush', () => {
    assert.strictEqual(STATE_ACCESSORIES.committing, 'gitpush');
  });

  test('happy maps to partyhat', () => {
    assert.strictEqual(STATE_ACCESSORIES.happy, 'partyhat');
  });

  test('sleeping maps to nightcap', () => {
    assert.strictEqual(STATE_ACCESSORIES.sleeping, 'nightcap');
  });

  test('idle has no accessory', () => {
    assert.strictEqual(STATE_ACCESSORIES.idle, undefined);
  });
});

describe('accessories.js -- getAccessory', () => {
  test('returns accessory object for mapped state', () => {
    const acc = getAccessory('installing');
    assert.ok(acc);
    assert.ok(Array.isArray(acc.lines));
    assert.ok(acc.lines.length > 0);
  });

  test('returns null for unmapped state', () => {
    assert.strictEqual(getAccessory('idle'), null);
    assert.strictEqual(getAccessory('satisfied'), null);
    assert.strictEqual(getAccessory('relieved'), null);
  });

  test('returns null for unknown state', () => {
    assert.strictEqual(getAccessory('nonexistent'), null);
    assert.strictEqual(getAccessory(''), null);
  });

  test('returns correct accessory for each mapped state', () => {
    for (const [state, name] of Object.entries(STATE_ACCESSORIES)) {
      const acc = getAccessory(state);
      assert.ok(acc, `getAccessory("${state}") should return an accessory`);
      assert.deepStrictEqual(acc, ACCESSORIES[name]);
    }
  });
});

module.exports = { passed: () => passed, failed: () => failed };
