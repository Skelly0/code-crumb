#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - shared.js                             |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  safeFilename, PREFS_FILE, loadPrefs, savePrefs, getGitBranch, getIsWorktree,
  charWidth, strWidth, sliceToWidth, sliceFromEndToWidth,
} = require('../shared');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;

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
    assert.strictEqual(safeFilename(''), '_empty');
  });

  test('coerces non-string input', () => {
    assert.strictEqual(safeFilename(12345), '12345');
    assert.strictEqual(safeFilename(null), 'null');
  });

  test('null coerces to non-empty string', () => {
    const result = safeFilename(null);
    assert.ok(result.length > 0);
  });

  test('undefined coerces to non-empty string', () => {
    const result = safeFilename(undefined);
    assert.ok(result.length > 0);
  });
});

describe('shared.js -- preferences persistence', () => {
  let savedPrefs;
  try { savedPrefs = fs.readFileSync(PREFS_FILE, 'utf8'); } catch { savedPrefs = null; }

  try {
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

  } finally {
    // Restore the real prefs even if a test body threw past test().
    try {
      if (savedPrefs !== null) fs.writeFileSync(PREFS_FILE, savedPrefs, 'utf8');
      else fs.unlinkSync(PREFS_FILE);
    } catch {}
  }
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

describe('shared.js -- getIsWorktree', () => {
  test('returns false for a regular git repo (.git is directory)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-crumb-wt-'));
    try {
      fs.mkdirSync(path.join(tmpDir, '.git'));
      assert.strictEqual(getIsWorktree(tmpDir), false);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('returns true when .git is a file (worktree)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-crumb-wt-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '.git'), 'gitdir: /some/path/.git/worktrees/foo\n', 'utf8');
      assert.strictEqual(getIsWorktree(tmpDir), true);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('returns false for the project repo (regular clone)', () => {
    const result = getIsWorktree(path.join(__dirname, '..'));
    assert.strictEqual(result, false);
  });

  test('returns false for non-git directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-crumb-nogit-'));
    try {
      assert.strictEqual(getIsWorktree(tmpDir), false);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });

  test('handles undefined cwd without throwing', () => {
    const result = getIsWorktree(undefined);
    assert.ok(typeof result === 'boolean');
  });
});

describe('shared.js -- path constants', () => {
  const { HOME, STATE_FILE, SESSIONS_DIR, STATS_FILE, PID_FILE, QUIT_FLAG_FILE, TEAMS_DIR, TMUX_FILE } = require('../shared');

  test('HOME is a non-empty string', () => {
    assert.ok(typeof HOME === 'string' && HOME.length > 0);
  });

  test('STATE_FILE is a non-empty string', () => {
    assert.ok(typeof STATE_FILE === 'string' && STATE_FILE.length > 0);
  });

  test('SESSIONS_DIR is a non-empty string', () => {
    assert.ok(typeof SESSIONS_DIR === 'string' && SESSIONS_DIR.length > 0);
  });

  test('STATS_FILE is a non-empty string', () => {
    assert.ok(typeof STATS_FILE === 'string' && STATS_FILE.length > 0);
  });

  test('PID_FILE is a non-empty string', () => {
    assert.ok(typeof PID_FILE === 'string' && PID_FILE.length > 0);
  });

  test('QUIT_FLAG_FILE is a non-empty string', () => {
    assert.ok(typeof QUIT_FLAG_FILE === 'string' && QUIT_FLAG_FILE.length > 0);
  });

  test('TEAMS_DIR is a non-empty string', () => {
    assert.ok(typeof TEAMS_DIR === 'string' && TEAMS_DIR.length > 0);
  });

  test('TMUX_FILE is a non-empty string', () => {
    assert.ok(typeof TMUX_FILE === 'string' && TMUX_FILE.length > 0);
  });
});

describe('shared.js -- safeFilename all special chars', () => {
  test('tabs are replaced with underscore', () => {
    assert.ok(!safeFilename('a\tb').includes('\t'));
    assert.strictEqual(safeFilename('a\tb'), 'a_b');
  });

  test('newlines are replaced with underscore', () => {
    assert.ok(!safeFilename('a\nb').includes('\n'));
    assert.strictEqual(safeFilename('a\nb'), 'a_b');
  });

  test('forward slashes are replaced with underscore', () => {
    assert.strictEqual(safeFilename('a/b'), 'a_b');
  });

  test('backslashes are replaced with underscore', () => {
    assert.strictEqual(safeFilename('a\\b'), 'a_b');
  });

  test('colons are replaced with underscore', () => {
    assert.strictEqual(safeFilename('a:b'), 'a_b');
  });

  test('question marks are replaced with underscore', () => {
    assert.strictEqual(safeFilename('a?b'), 'a_b');
  });

  test('asterisks are replaced with underscore', () => {
    assert.strictEqual(safeFilename('a*b'), 'a_b');
  });

  test('quotes are replaced with underscore', () => {
    assert.strictEqual(safeFilename('a"b'), 'a_b');
    assert.strictEqual(safeFilename("a'b"), 'a_b');
  });
});

describe('shared.js -- getGitBranch walks up parent directories', () => {
  test('finds .git/HEAD in parent directory from subdir', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-crumb-walk-'));
    const subDir = path.join(tmpDir, 'child', 'grandchild');
    try {
      fs.mkdirSync(subDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref: refs/heads/walk-test\n', 'utf8');
      assert.strictEqual(getGitBranch(subDir), 'walk-test');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    }
  });
});

// -- Round 3: wide characters ---------------------------------------------
// Layout is measured in terminal columns. `.length` counted a CJK or emoji
// character as one column (the terminal draws two) and a combining mark as
// one (it draws none), so rows overran or fell short of their boxes.

describe('shared.js -- round 3: wide characters', () => {
  test('ASCII is one column per character (fast path)', () => {
    assert.strictEqual(strWidth(''), 0);
    assert.strictEqual(strWidth('editing foo.js'), 14);
    assert.strictEqual(charWidth(0x41), 1);
    assert.strictEqual(sliceToWidth('abcdef', 3), 'abc');
    assert.strictEqual(sliceToWidth('abc', 10), 'abc');
    assert.strictEqual(sliceFromEndToWidth('abcdef', 3), 'def');
    assert.strictEqual(sliceFromEndToWidth('abcdef', 0), '');
  });

  test('CJK, Hangul, kana and fullwidth forms are two columns', () => {
    assert.strictEqual(strWidth('\u7528\u6237\u767b\u5f55'), 8);  // 用户登录
    assert.strictEqual(strWidth('\u8a2d\u8a08\u66f8.md'), 9);  // 設計書.md
    assert.strictEqual(strWidth('\ud55c\uad6d\uc5b4'), 6);  // 한국어
    assert.strictEqual(strWidth('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8'), 12);  // プロジェクト
    assert.strictEqual(strWidth('\uff21\uff22'), 4);  // fullwidth AB
    assert.strictEqual(charWidth(0x20000), 2);  // CJK Ext. B
  });

  test('default-presentation emoji are two columns, astral and BMP alike', () => {
    assert.strictEqual(strWidth('\ud83d\ude00'), 2);  // 😀 U+1F600
    assert.strictEqual(strWidth('\ud83d\ude80'), 2);  // 🚀 U+1F680
    assert.strictEqual(strWidth('\ud83e\udd16'), 2);  // 🤖 U+1F916
    assert.strictEqual(strWidth('\u2705\u274c\u2b50'), 6);  // ✅ ❌ ⭐
    assert.strictEqual(strWidth('\u231a'), 2);  // ⌚
  });

  test('combining marks, ZWJ, variation selectors and controls are zero columns', () => {
    assert.strictEqual(strWidth('e\u0301'), 1);  // e + combining acute
    assert.strictEqual(strWidth('cafe\u0301 ok'), 7);
    assert.strictEqual(strWidth('\u0915\u094d\u0937'), 2);  // क्ष: virama is a mark
    assert.strictEqual(charWidth(0x200d), 0);
    assert.strictEqual(charWidth(0xfe0f), 0);
    assert.strictEqual(charWidth(0x07), 0);
    assert.strictEqual(charWidth(0x9b), 0);  // C1 CSI
    assert.strictEqual(strWidth('\u2764\ufe0f'), 1);  // text-default heart + VS16
  });

  test('every glyph the app draws itself stays one column', () => {
    // A layout built on these would shift if the table ever made one wide.
    for (const g of ['\u2726', '\u25cf', '\u25cb', '\u2605', '\u2606', '\u229b', '\u2715',
      '\u2387', '\u21b3', '\u2191', '\u2193', '\u23ce', '\u2302', '\u25c4', '\u25b8', '\u2514',
      '\u2500', '\u2502', '\u256d', '\u256e', '\u2570', '\u256f', '\u251c', '\u2524', '\u00b7',
      '\u2026', '\u2588', '\u2593', '\u2592', '\u25e1', '\u25e0', '\u25c6', '\u25c8', '\u25c9',
      '\u29eb', '\u25bc', '\u25b2', '\u2218', '\u00d7']) {
      assert.strictEqual(strWidth(g), 1, `U+${g.codePointAt(0).toString(16)} must stay 1 column`);
    }
  });

  test('sliceToWidth never splits a surrogate pair', () => {
    const s = 'a\ud83d\ude00b';
    for (let w = 0; w <= 5; w++) {
      const out = sliceToWidth(s, w);
      assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(out), `width ${w}: lone high surrogate in ${JSON.stringify(out)}`);
      assert.ok(strWidth(out) <= w, `width ${w}: ${JSON.stringify(out)} overruns`);
    }
    assert.strictEqual(sliceToWidth(s, 3), 'a\ud83d\ude00');
    const tail = sliceFromEndToWidth('x\ud83d\ude00y', 3);
    assert.strictEqual(tail, '\ud83d\ude00y');
  });

  test('a wide character straddling the limit is dropped, not half-drawn', () => {
    assert.strictEqual(sliceToWidth('ab\u7528\u6237', 3), 'ab');  // ab用 would be 4
    assert.strictEqual(sliceToWidth('ab\u7528\u6237', 4), 'ab\u7528');
    assert.strictEqual(sliceToWidth('\u7528\u6237\u767b', 5), '\u7528\u6237');
    assert.strictEqual(sliceFromEndToWidth('\u7528\u6237\u767b', 5), '\u6237\u767b');
    assert.strictEqual(sliceToWidth('\u7528', 1), '');
    assert.strictEqual(sliceToWidth('\u7528', -2), '');
  });

  test('a mark stays with its base character and never leads a tail', () => {
    assert.strictEqual(sliceToWidth('e\u0301x', 1), 'e\u0301');
    assert.strictEqual(sliceFromEndToWidth('ae\u0301', 1), 'e\u0301');
    assert.strictEqual(sliceFromEndToWidth('\u7528e\u0301', 1), 'e\u0301');
  });

  test('non-string input is coerced, never thrown on', () => {
    assert.strictEqual(strWidth(null), 0);
    assert.strictEqual(strWidth(12345), 5);
    assert.strictEqual(sliceToWidth(undefined, 4), '');
    assert.strictEqual(sliceFromEndToWidth(null, 4), '');
  });
});

module.exports = suite;
