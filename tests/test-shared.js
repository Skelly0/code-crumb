#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Test Suite - shared.js                              |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const { safeFilename, PREFS_FILE, loadPrefs, savePrefs } = require('../shared');

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

describe('shared.js -- safeFilename', () => {
  test('leaves alphanumeric unchanged', () => {
    assert.strictEqual(safeFilename('abc123'), 'abc123');
  });

  test('allows hyphens and underscores', () => {
    assert.strictEqual(safeFilename('my-session_01'), 'my-session_01');
  });

  test('replaces special characters with underscore', () => {
    assert.strictEqual(safeFilename('a/b\\c:d'), 'a_b_c_d');
  });

  test('replaces dots and spaces', () => {
    assert.strictEqual(safeFilename('file name.json'), 'file_name_json');
  });

  test('truncates to 64 characters', () => {
    const long = 'a'.repeat(100);
    assert.strictEqual(safeFilename(long).length, 64);
  });

  test('handles empty string', () => {
    assert.strictEqual(safeFilename(''), '');
  });

  test('coerces non-string input', () => {
    assert.strictEqual(safeFilename(12345), '12345');
    assert.strictEqual(safeFilename(null), 'null');
  });
});

describe('shared.js -- preferences persistence', () => {
  let savedPrefs;
  try { savedPrefs = fs.readFileSync(PREFS_FILE, 'utf8'); } catch { savedPrefs = null; }

  test('PREFS_FILE is a non-empty string', () => {
    assert.ok(typeof PREFS_FILE === 'string');
    assert.ok(PREFS_FILE.length > 0);
    assert.ok(PREFS_FILE.includes('.claude-face-prefs'));
  });

  test('loadPrefs returns an object', () => {
    const prefs = loadPrefs();
    assert.ok(typeof prefs === 'object');
    assert.ok(prefs !== null);
  });

  test('savePrefs and loadPrefs roundtrip', () => {
    savePrefs({ paletteIndex: 3, accessoriesEnabled: false, showStats: false });
    const prefs = loadPrefs();
    assert.strictEqual(prefs.paletteIndex, 3);
    assert.strictEqual(prefs.accessoriesEnabled, false);
    assert.strictEqual(prefs.showStats, false);
  });

  test('savePrefs merges with existing prefs', () => {
    savePrefs({ paletteIndex: 2 });
    savePrefs({ accessoriesEnabled: true });
    const prefs = loadPrefs();
    assert.strictEqual(prefs.paletteIndex, 2);
    assert.strictEqual(prefs.accessoriesEnabled, true);
  });

  test('loadPrefs returns {} for corrupt file', () => {
    fs.writeFileSync(PREFS_FILE, '{broken json!!!', 'utf8');
    const prefs = loadPrefs();
    assert.deepStrictEqual(prefs, {});
  });

  test('loadPrefs returns {} for empty file', () => {
    fs.writeFileSync(PREFS_FILE, '', 'utf8');
    const prefs = loadPrefs();
    assert.deepStrictEqual(prefs, {});
  });

  try {
    if (savedPrefs !== null) fs.writeFileSync(PREFS_FILE, savedPrefs, 'utf8');
    else fs.unlinkSync(PREFS_FILE);
  } catch {}
});

module.exports = { passed: () => passed, failed: () => failed };
