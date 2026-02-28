#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - themes.js                               |
// +================================================================+

const assert = require('assert');
const {
  lerpColor, dimColor, breathe,
  themes, COMPLETION_LINGER, TIMELINE_COLORS, SPARKLINE_BLOCKS,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
  PALETTES, PALETTE_NAMES,
  setNoColor, isNoColor, ansi, BREATH_PERIOD,
} = require('../themes');

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

describe('themes.js -- lerpColor', () => {
  test('t=0 → returns color a', () => {
    assert.deepStrictEqual(lerpColor([0, 0, 0], [255, 255, 255], 0), [0, 0, 0]);
  });

  test('t=1 → returns color b', () => {
    assert.deepStrictEqual(lerpColor([0, 0, 0], [255, 255, 255], 1), [255, 255, 255]);
  });

  test('t=0.5 → midpoint', () => {
    assert.deepStrictEqual(lerpColor([0, 0, 0], [200, 100, 50], 0.5), [100, 50, 25]);
  });

  test('works with same color', () => {
    assert.deepStrictEqual(lerpColor([100, 100, 100], [100, 100, 100], 0.7), [100, 100, 100]);
  });

  test('clamps t > 1 to 1 (returns target color)', () => {
    assert.deepStrictEqual(lerpColor([0, 0, 0], [255, 128, 64], 2), [255, 128, 64]);
  });

  test('clamps t < 0 to 0 (returns source color)', () => {
    assert.deepStrictEqual(lerpColor([10, 20, 30], [255, 255, 255], -1), [10, 20, 30]);
  });
});

describe('themes.js -- dimColor', () => {
  test('factor=1 → unchanged', () => {
    assert.deepStrictEqual(dimColor([100, 200, 50], 1), [100, 200, 50]);
  });

  test('factor=0 → black', () => {
    assert.deepStrictEqual(dimColor([100, 200, 50], 0), [0, 0, 0]);
  });

  test('factor=0.5 → halved', () => {
    assert.deepStrictEqual(dimColor([100, 200, 50], 0.5), [50, 100, 25]);
  });

  test('clamps factor > 1 to 1 (returns original color)', () => {
    assert.deepStrictEqual(dimColor([100, 200, 50], 2), [100, 200, 50]);
  });

  test('clamps factor < 0 to 0 (returns black)', () => {
    assert.deepStrictEqual(dimColor([100, 200, 50], -1), [0, 0, 0]);
  });
});

describe('themes.js -- breathe', () => {
  test('returns an RGB array', () => {
    const result = breathe([100, 200, 50], 0);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 3);
  });

  test('result is dimmer than original', () => {
    const result = breathe([100, 200, 50], 0);
    assert.ok(result[0] <= 100);
    assert.ok(result[1] <= 200);
    assert.ok(result[2] <= 50);
  });

  test('oscillates over a period', () => {
    const a = breathe([100, 200, 50], 0);
    const b = breathe([100, 200, 50], 1000);
    assert.ok(a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]);
  });
});

describe('themes.js -- themes', () => {
  const ALL_STATES = [
    'idle', 'thinking', 'coding', 'reading', 'searching', 'executing',
    'happy', 'satisfied', 'proud', 'relieved', 'error', 'sleeping',
    'waiting', 'testing', 'installing', 'caffeinated', 'subagent',
    'spawning', 'committing', 'reviewing', 'ratelimited',
  ];

  test('every state has a theme', () => {
    for (const state of ALL_STATES) {
      assert.ok(themes[state], `missing theme for state: ${state}`);
    }
  });

  test('every theme has required color arrays', () => {
    for (const state of ALL_STATES) {
      const theme = themes[state];
      for (const key of ['border', 'eye', 'mouth', 'accent', 'label']) {
        assert.ok(Array.isArray(theme[key]), `${state}.${key} should be an array`);
        assert.strictEqual(theme[key].length, 3, `${state}.${key} should have 3 elements`);
      }
    }
  });

  test('every theme has status string and emoji', () => {
    for (const state of ALL_STATES) {
      const theme = themes[state];
      assert.ok(typeof theme.status === 'string', `${state}.status should be a string`);
      assert.ok(typeof theme.emoji === 'string', `${state}.emoji should be a string`);
    }
  });

  test('every state has a timeline color', () => {
    for (const state of ALL_STATES) {
      assert.ok(TIMELINE_COLORS[state], `missing timeline color for: ${state}`);
      assert.strictEqual(TIMELINE_COLORS[state].length, 3);
    }
  });
});

describe('themes.js -- COMPLETION_LINGER', () => {
  test('happy lingers longest', () => {
    assert.ok(COMPLETION_LINGER.happy > COMPLETION_LINGER.proud);
    assert.ok(COMPLETION_LINGER.happy > COMPLETION_LINGER.satisfied);
    assert.ok(COMPLETION_LINGER.happy > COMPLETION_LINGER.relieved);
  });

  test('all linger values are positive', () => {
    for (const [state, ms] of Object.entries(COMPLETION_LINGER)) {
      assert.ok(ms > 0, `${state} should have positive linger time`);
    }
  });
});

describe('themes.js -- thought bubbles', () => {
  test('IDLE_THOUGHTS is non-empty', () => {
    assert.ok(IDLE_THOUGHTS.length > 0);
  });

  test('THINKING_THOUGHTS is non-empty', () => {
    assert.ok(THINKING_THOUGHTS.length > 0);
  });

  test('COMPLETION_THOUGHTS is non-empty', () => {
    assert.ok(COMPLETION_THOUGHTS.length > 0);
  });

  test('STATE_THOUGHTS covers active states', () => {
    const expected = ['coding', 'reading', 'searching', 'executing', 'testing', 'installing', 'subagent', 'error'];
    for (const state of expected) {
      assert.ok(STATE_THOUGHTS[state], `missing STATE_THOUGHTS for: ${state}`);
      assert.ok(STATE_THOUGHTS[state].length > 0, `STATE_THOUGHTS.${state} should be non-empty`);
    }
  });

  test('all thought strings are non-empty', () => {
    for (const t of IDLE_THOUGHTS) assert.ok(t.length > 0);
    for (const t of THINKING_THOUGHTS) assert.ok(t.length > 0);
    for (const t of COMPLETION_THOUGHTS) assert.ok(t.length > 0);
    for (const [, arr] of Object.entries(STATE_THOUGHTS)) {
      for (const t of arr) assert.ok(t.length > 0);
    }
  });
});

describe('themes.js -- SPARKLINE_BLOCKS', () => {
  test('contains 7 Unicode block characters', () => {
    assert.strictEqual(SPARKLINE_BLOCKS.length, 7);
  });

  test('characters are ascending block elements', () => {
    for (let i = 0; i < SPARKLINE_BLOCKS.length; i++) {
      assert.strictEqual(SPARKLINE_BLOCKS.charCodeAt(i), 0x2581 + i);
    }
  });
});

describe('themes.js -- PALETTES', () => {
  const ALL_STATES = [
    'idle', 'thinking', 'coding', 'reading', 'searching', 'executing',
    'happy', 'satisfied', 'proud', 'relieved', 'error', 'sleeping',
    'waiting', 'testing', 'installing', 'caffeinated', 'subagent',
    'spawning', 'committing', 'reviewing', 'ratelimited',
  ];

  test('PALETTES has 6 entries', () => {
    assert.strictEqual(PALETTES.length, 6);
  });

  test('PALETTE_NAMES matches palette names', () => {
    assert.deepStrictEqual(PALETTE_NAMES, ['default', 'neon', 'pastel', 'mono', 'sunset', 'highcontrast']);
  });

  test('all palette names are unique', () => {
    const names = PALETTES.map(p => p.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  test('every palette has all 19 states in themes', () => {
    for (const palette of PALETTES) {
      for (const state of ALL_STATES) {
        assert.ok(palette.themes[state], `${palette.name}: missing theme for state: ${state}`);
      }
    }
  });

  test('every palette theme has correct color shape', () => {
    for (const palette of PALETTES) {
      for (const state of ALL_STATES) {
        const theme = palette.themes[state];
        for (const key of ['border', 'eye', 'mouth', 'accent', 'label']) {
          assert.ok(Array.isArray(theme[key]), `${palette.name}.${state}.${key} should be array`);
          assert.strictEqual(theme[key].length, 3, `${palette.name}.${state}.${key} should have 3 elements`);
        }
        assert.ok(typeof theme.status === 'string', `${palette.name}.${state}.status should be string`);
        assert.ok(typeof theme.emoji === 'string', `${palette.name}.${state}.emoji should be string`);
      }
    }
  });

  test('status and emoji are consistent across all palettes', () => {
    for (const state of ALL_STATES) {
      const defaultTheme = PALETTES[0].themes[state];
      for (let i = 1; i < PALETTES.length; i++) {
        const theme = PALETTES[i].themes[state];
        assert.strictEqual(theme.status, defaultTheme.status,
          `${PALETTES[i].name}.${state}.status should match default`);
        assert.strictEqual(theme.emoji, defaultTheme.emoji,
          `${PALETTES[i].name}.${state}.emoji should match default`);
      }
    }
  });

  test('every palette has all 19 timeline colors', () => {
    for (const palette of PALETTES) {
      for (const state of ALL_STATES) {
        assert.ok(palette.timelineColors[state],
          `${palette.name}: missing timelineColor for: ${state}`);
        assert.strictEqual(palette.timelineColors[state].length, 3);
      }
    }
  });

  test('default palette references existing themes/TIMELINE_COLORS', () => {
    assert.strictEqual(PALETTES[0].themes, themes);
    assert.strictEqual(PALETTES[0].timelineColors, TIMELINE_COLORS);
  });

  test('non-default palettes have different border colors than default', () => {
    for (let i = 1; i < PALETTES.length; i++) {
      const defBorder = PALETTES[0].themes.idle.border;
      const palBorder = PALETTES[i].themes.idle.border;
      const same = defBorder[0] === palBorder[0] && defBorder[1] === palBorder[1] && defBorder[2] === palBorder[2];
      assert.ok(!same, `${PALETTES[i].name} idle border should differ from default`);
    }
  });
});

describe('themes.js -- setNoColor / isNoColor', () => {
  // Save and restore noColor state to avoid polluting other tests
  const savedNoColor = isNoColor();

  test('default state is false', () => {
    setNoColor(false);
    assert.strictEqual(isNoColor(), false);
  });

  test('setNoColor(true) activates no-color mode', () => {
    setNoColor(true);
    assert.strictEqual(isNoColor(), true);
  });

  test('setNoColor(false) reverts to color mode', () => {
    setNoColor(true);
    setNoColor(false);
    assert.strictEqual(isNoColor(), false);
  });

  test('coerces falsy values to false', () => {
    setNoColor(0);
    assert.strictEqual(isNoColor(), false);
    setNoColor('');
    assert.strictEqual(isNoColor(), false);
  });

  test('coerces truthy values to true', () => {
    setNoColor(1);
    assert.strictEqual(isNoColor(), true);
    setNoColor('yes');
    assert.strictEqual(isNoColor(), true);
  });

  test('ansi.fg returns empty string when noColor active', () => {
    setNoColor(true);
    assert.strictEqual(ansi.fg(255, 0, 0), '');
    setNoColor(false);
  });

  test('ansi.fg returns ANSI escape when noColor inactive', () => {
    setNoColor(false);
    const result = ansi.fg(255, 0, 0);
    assert.ok(result.length > 0, 'should return non-empty ANSI string');
    assert.ok(result.includes('38;2;255;0;0'), 'should contain RGB values');
  });

  test('ansi.reset returns empty string when noColor active', () => {
    setNoColor(true);
    assert.strictEqual(ansi.reset, '');
    setNoColor(false);
  });

  // Restore
  setNoColor(savedNoColor);
});

describe('themes.js -- BREATH_PERIOD', () => {
  test('equals 4000', () => {
    assert.strictEqual(BREATH_PERIOD, 4000);
  });
});

module.exports = { passed: () => passed, failed: () => failed };
