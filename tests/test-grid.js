#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - grid.js                                  |
// +================================================================+

const assert = require('assert');
const { MiniFace, FaceGrid } = require('../grid');
const { gridMouths } = require('../animations');
const { PALETTES } = require('../themes');

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

describe('grid.js -- MiniFace modelName', () => {
  test('default modelName is empty', () => {
    const face = new MiniFace('test-session');
    assert.strictEqual(face.modelName, '');
  });

  test('updateFromFile sets modelName', () => {
    const face = new MiniFace('test-session');
    face.updateFromFile({ state: 'coding', modelName: 'codex' });
    assert.strictEqual(face.modelName, 'codex');
  });

  test('updateFromFile ignores missing modelName', () => {
    const face = new MiniFace('test-session');
    face.updateFromFile({ state: 'coding', modelName: 'o3' });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.modelName, 'o3');
  });
});

describe('grid.js -- MiniFace', () => {
  test('initializes with idle state', () => {
    const face = new MiniFace('test-session');
    assert.strictEqual(face.state, 'idle');
    assert.strictEqual(face.sessionId, 'test-session');
  });

  test('updateFromFile changes state', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js', timestamp: Date.now() });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'editing foo.js');
  });

  test('updateFromFile tracks stopped', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'happy', stopped: true, timestamp: Date.now() });
    assert.ok(face.stopped);
  });

  test('isStale returns false for fresh face', () => {
    const face = new MiniFace('test');
    assert.ok(!face.isStale());
  });

  test('isStale returns true for old stopped face', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 10000;
    assert.ok(face.isStale());
  });

  test('getEyes returns string for all states', () => {
    const states = [
      'idle', 'thinking', 'reading', 'searching', 'coding', 'executing',
      'happy', 'error', 'sleeping', 'waiting', 'testing', 'installing',
      'caffeinated', 'subagent', 'satisfied', 'proud', 'relieved',
    ];
    for (const state of states) {
      const face = new MiniFace('test');
      face.state = state;
      face.blinkFrame = -1;
      const result = face.getEyes();
      assert.ok(typeof result === 'string', `MiniFace.getEyes failed for state: ${state}`);
    }
  });

  test('getMouth returns string for all states', () => {
    const states = Object.keys(gridMouths);
    for (const state of states) {
      const face = new MiniFace('test');
      face.state = state;
      const result = face.getMouth();
      assert.ok(typeof result === 'string', `MiniFace.getMouth failed for state: ${state}`);
    }
  });
});

describe('grid.js -- FaceGrid', () => {
  test('initializes with empty map', () => {
    const grid = new FaceGrid();
    assert.strictEqual(grid.faces.size, 0);
  });

  test('assignLabels handles empty grid', () => {
    const grid = new FaceGrid();
    grid.assignLabels();
    assert.strictEqual(grid.faces.size, 0);
  });

  test('update ticks all faces', () => {
    const grid = new FaceGrid();
    grid.faces.set('a', new MiniFace('a'));
    grid.faces.set('b', new MiniFace('b'));
    grid.update(66);
    assert.strictEqual(grid.frame, 1);
    for (const face of grid.faces.values()) {
      assert.strictEqual(face.frame, 1);
    }
  });
});

describe('grid.js -- FaceGrid cycleTheme/toggleHelp', () => {
  test('cycleTheme increments paletteIndex', () => {
    const grid = new FaceGrid();
    assert.strictEqual(grid.paletteIndex, 0);
    grid.cycleTheme();
    assert.strictEqual(grid.paletteIndex, 1);
  });

  test('cycleTheme wraps around', () => {
    const grid = new FaceGrid();
    for (let i = 0; i < PALETTES.length; i++) grid.cycleTheme();
    assert.strictEqual(grid.paletteIndex, 0);
  });

  test('toggleHelp flips showHelp', () => {
    const grid = new FaceGrid();
    assert.strictEqual(grid.showHelp, false);
    grid.toggleHelp();
    assert.strictEqual(grid.showHelp, true);
    grid.toggleHelp();
    assert.strictEqual(grid.showHelp, false);
  });
});

module.exports = { passed: () => passed, failed: () => failed };
