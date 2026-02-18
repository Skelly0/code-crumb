#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - shared.js                                  |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeFilename, PREFS_FILE, loadPrefs, savePrefs, getGitBranch } = require('../shared');

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
    assert.ok(PREFS_FILE.includes('.code-crumb-prefs'));
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

describe('shared.js -- getGitBranch', () => {
  test('reads branch name from a fake .git/HEAD', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-crumb-git-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/my-feature\n', 'utf8');
      assert.strictEqual(getGitBranch(tmpDir), 'my-feature');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('returns short SHA for detached HEAD', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-crumb-git-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'abc1234def5678\n', 'utf8');
      assert.strictEqual(getGitBranch(tmpDir), 'abc1234');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('returns a string for the project repo', () => {
    // __dirname is inside the project, which is a git repo
    const branch = getGitBranch(path.join(__dirname, '..'));
    assert.ok(typeof branch === 'string', 'expected a branch name string');
    assert.ok(branch.length > 0, 'branch name should be non-empty');
  });

  test('handles undefined cwd gracefully', () => {
    // Falls back to process.cwd() — should not throw
    const result = getGitBranch(undefined);
    assert.ok(result === null || typeof result === 'string');
  });

  test('returns null or string for filesystem root (never throws)', () => {
    const root = path.parse(os.homedir()).root;
    const result = getGitBranch(root);
    assert.ok(result === null || typeof result === 'string');
  });
});

module.exports = { passed: () => passed, failed: () => failed };
