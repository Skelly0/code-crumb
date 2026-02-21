#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - launch.js                                  |
// |  Tests for CLI argument parsing, editor resolution, and         |
// |  platform-specific renderer command construction.               |
// +================================================================+

const assert = require('assert');
const path = require('path');
const { parseArgs, resolveEditor, buildRendererCommands, WINDOW_TITLE } = require('../launch');

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

// -- parseArgs ------------------------------------------------------------

describe('launch.js -- parseArgs defaults', () => {
  test('defaults to claude with no args', () => {
    const { editorName, editorArgs } = parseArgs([]);
    assert.strictEqual(editorName, 'claude');
    assert.deepStrictEqual(editorArgs, []);
  });

  test('defaults to claude when --editor is absent', () => {
    const { editorName, editorArgs } = parseArgs(['-p', 'fix bug']);
    assert.strictEqual(editorName, 'claude');
    assert.deepStrictEqual(editorArgs, ['-p', 'fix bug']);
  });
});

describe('launch.js -- parseArgs --editor flag', () => {
  test('parses --editor codex', () => {
    const { editorName, editorArgs } = parseArgs(['--editor', 'codex']);
    assert.strictEqual(editorName, 'codex');
    assert.deepStrictEqual(editorArgs, []);
  });

  test('parses --editor opencode with passthrough args', () => {
    const { editorName, editorArgs } = parseArgs(['--editor', 'opencode', '-p', 'hello']);
    assert.strictEqual(editorName, 'opencode');
    assert.deepStrictEqual(editorArgs, ['-p', 'hello']);
  });

  test('lowercases editor name', () => {
    const { editorName } = parseArgs(['--editor', 'CLAUDE']);
    assert.strictEqual(editorName, 'claude');
  });

  test('handles --editor at end with no value', () => {
    const { editorName } = parseArgs(['--editor']);
    assert.strictEqual(editorName, 'claude');
  });

  test('strips --editor and its value from passthrough args', () => {
    const { editorArgs } = parseArgs(['--dangerously-skip-permissions', '--editor', 'codex', '-p', 'fix']);
    assert.deepStrictEqual(editorArgs, ['--dangerously-skip-permissions', '-p', 'fix']);
  });

  test('handles --editor as first arg with trailing args', () => {
    const { editorName, editorArgs } = parseArgs(['--editor', 'pi', 'some', 'prompt']);
    assert.strictEqual(editorName, 'pi');
    assert.deepStrictEqual(editorArgs, ['some', 'prompt']);
  });
});

// -- resolveEditor --------------------------------------------------------

describe('launch.js -- resolveEditor claude variants', () => {
  const baseDir = '/fake/project';

  test('claude resolves to claude command', () => {
    const result = resolveEditor('claude', ['-p', 'hi'], baseDir);
    assert.strictEqual(result.cmd, 'claude');
    assert.deepStrictEqual(result.args, ['-p', 'hi']);
  });

  test('claude-code resolves to claude command', () => {
    const result = resolveEditor('claude-code', [], baseDir);
    assert.strictEqual(result.cmd, 'claude');
  });

  test('unknown editor defaults to claude', () => {
    const result = resolveEditor('unknown-editor', ['arg'], baseDir);
    assert.strictEqual(result.cmd, 'claude');
    assert.deepStrictEqual(result.args, ['arg']);
  });
});

describe('launch.js -- resolveEditor codex variants', () => {
  const baseDir = '/fake/project';

  test('codex resolves to node with wrapper path', () => {
    const result = resolveEditor('codex', ['--flag'], baseDir);
    assert.strictEqual(result.cmd, 'node');
    assert.ok(result.args[0].includes('codex-wrapper.js'), 'first arg should be codex wrapper path');
    assert.ok(result.args[0].includes('adapters'), 'wrapper path should include adapters dir');
    assert.deepStrictEqual(result.args.slice(1), ['--flag']);
  });

  test('openai resolves same as codex', () => {
    const result = resolveEditor('openai', [], baseDir);
    assert.strictEqual(result.cmd, 'node');
    assert.ok(result.args[0].includes('codex-wrapper.js'));
  });

  test('codex wrapper path uses adapters subdirectory', () => {
    const result = resolveEditor('codex', [], baseDir);
    const expected = path.resolve(baseDir, 'adapters', 'codex-wrapper.js');
    assert.strictEqual(result.args[0], expected);
  });
});

describe('launch.js -- resolveEditor opencode', () => {
  test('opencode resolves to opencode command', () => {
    const result = resolveEditor('opencode', ['-m', 'kimi'], '/x');
    assert.strictEqual(result.cmd, 'opencode');
    assert.deepStrictEqual(result.args, ['-m', 'kimi']);
  });
});

describe('launch.js -- resolveEditor openclaw variants', () => {
  test('openclaw resolves to openclaw command', () => {
    const result = resolveEditor('openclaw', [], '/x');
    assert.strictEqual(result.cmd, 'openclaw');
  });

  test('claw resolves to openclaw command', () => {
    const result = resolveEditor('claw', ['arg'], '/x');
    assert.strictEqual(result.cmd, 'openclaw');
    assert.deepStrictEqual(result.args, ['arg']);
  });

  test('pi resolves to openclaw command', () => {
    const result = resolveEditor('pi', [], '/x');
    assert.strictEqual(result.cmd, 'openclaw');
  });
});

describe('launch.js -- resolveEditor passthrough', () => {
  test('all editor args are passed through', () => {
    const args = ['--dangerously-skip-permissions', '-p', 'fix the bug', '--verbose'];
    const result = resolveEditor('claude', args, '/x');
    assert.deepStrictEqual(result.args, args);
  });

  test('empty args produce empty args array', () => {
    const result = resolveEditor('opencode', [], '/x');
    assert.deepStrictEqual(result.args, []);
  });
});

// -- buildRendererCommands ------------------------------------------------

describe('launch.js -- buildRendererCommands win32', () => {
  const rendererArgs = ['/path/to/renderer.js'];
  const title = 'Code Crumb';

  test('returns wt and cmd fallback entries', () => {
    const cmds = buildRendererCommands('win32', rendererArgs, title);
    assert.ok(cmds.wt, 'should have wt entry');
    assert.ok(cmds.cmd, 'should have cmd entry');
  });

  test('wt command includes window title and node', () => {
    const cmds = buildRendererCommands('win32', rendererArgs, title);
    assert.strictEqual(cmds.wt.cmd, 'wt');
    assert.ok(cmds.wt.args.includes('--title'));
    assert.ok(cmds.wt.args.includes(title));
    assert.ok(cmds.wt.args.includes('node'));
    assert.ok(cmds.wt.args.includes(rendererArgs[0]));
  });

  test('cmd fallback uses start command', () => {
    const cmds = buildRendererCommands('win32', rendererArgs, title);
    assert.strictEqual(cmds.cmd.cmd, 'cmd');
    assert.ok(cmds.cmd.args.includes('/c'));
    assert.ok(cmds.cmd.args.includes('start'));
    assert.ok(cmds.cmd.args.includes('node'));
  });

  test('wt opts include shell: true and detached: true', () => {
    const cmds = buildRendererCommands('win32', rendererArgs, title);
    assert.strictEqual(cmds.wt.opts.shell, true);
    assert.strictEqual(cmds.wt.opts.detached, true);
    assert.strictEqual(cmds.wt.opts.stdio, 'ignore');
  });

  test('cmd opts include detached: true', () => {
    const cmds = buildRendererCommands('win32', rendererArgs, title);
    assert.strictEqual(cmds.cmd.opts.detached, true);
    assert.strictEqual(cmds.cmd.opts.stdio, 'ignore');
  });
});

describe('launch.js -- buildRendererCommands darwin', () => {
  const rendererArgs = ['/path/to/renderer.js'];
  const title = 'Code Crumb';

  test('returns osascript entry', () => {
    const cmds = buildRendererCommands('darwin', rendererArgs, title);
    assert.ok(cmds.osascript, 'should have osascript entry');
  });

  test('osascript command uses AppleScript to launch Terminal', () => {
    const cmds = buildRendererCommands('darwin', rendererArgs, title);
    assert.strictEqual(cmds.osascript.cmd, 'osascript');
    const script = cmds.osascript.args[1];
    assert.ok(script.includes('tell application "Terminal"'), 'should reference Terminal.app');
    assert.ok(script.includes('node'), 'should include node command');
    assert.ok(script.includes(rendererArgs[0]), 'should include renderer path');
  });

  test('escapes single quotes in renderer path', () => {
    const tricky = ["/path/it's/renderer.js"];
    const cmds = buildRendererCommands('darwin', tricky, title);
    const script = cmds.osascript.args[1];
    assert.ok(!script.includes("it's/"), 'raw single quote should be escaped');
    assert.ok(script.includes("it"), 'path content should still be present');
  });

  test('osascript opts include detached: true', () => {
    const cmds = buildRendererCommands('darwin', rendererArgs, title);
    assert.strictEqual(cmds.osascript.opts.detached, true);
    assert.strictEqual(cmds.osascript.opts.stdio, 'ignore');
  });
});

describe('launch.js -- buildRendererCommands linux', () => {
  const rendererArgs = ['/path/to/renderer.js'];
  const title = 'Code Crumb';

  test('returns four terminal fallback entries', () => {
    const cmds = buildRendererCommands('linux', rendererArgs, title);
    const keys = Object.keys(cmds);
    assert.strictEqual(keys.length, 4);
    assert.ok(keys.includes('gnome-terminal'));
    assert.ok(keys.includes('konsole'));
    assert.ok(keys.includes('xfce4-terminal'));
    assert.ok(keys.includes('xterm'));
  });

  test('gnome-terminal uses -- separator', () => {
    const cmds = buildRendererCommands('linux', rendererArgs, title);
    const args = cmds['gnome-terminal'].args;
    assert.ok(args.includes('--'), 'gnome-terminal should use -- separator');
    assert.ok(args.includes('node'));
    assert.ok(args.includes(rendererArgs[0]));
  });

  test('konsole uses --new-tab -e', () => {
    const cmds = buildRendererCommands('linux', rendererArgs, title);
    const args = cmds.konsole.args;
    assert.ok(args.includes('--new-tab'));
    assert.ok(args.includes('-e'));
    assert.ok(args.includes('node'));
  });

  test('xterm uses -T for title and -e for execute', () => {
    const cmds = buildRendererCommands('linux', rendererArgs, title);
    const args = cmds.xterm.args;
    assert.ok(args.includes('-T'));
    assert.ok(args.includes(title));
    assert.ok(args.includes('-e'));
  });

  test('gnome-terminal, xfce4-terminal, and xterm include window title', () => {
    const cmds = buildRendererCommands('linux', rendererArgs, title);
    for (const key of ['gnome-terminal', 'xfce4-terminal', 'xterm']) {
      const args = cmds[key].args;
      const hasTitle = args.some(a => typeof a === 'string' && a.includes(title));
      assert.ok(hasTitle, `${key} should include window title`);
    }
  });

  test('konsole does not set a custom title (uses terminal default)', () => {
    const cmds = buildRendererCommands('linux', rendererArgs, title);
    const args = cmds.konsole.args;
    const hasTitle = args.some(a => typeof a === 'string' && a.includes(title));
    assert.ok(!hasTitle, 'konsole args should not contain custom title');
  });

  test('all linux entries include renderer path', () => {
    const cmds = buildRendererCommands('linux', rendererArgs, title);
    for (const key of Object.keys(cmds)) {
      const args = cmds[key].args;
      const hasPath = args.some(a => typeof a === 'string' && a.includes(rendererArgs[0]));
      assert.ok(hasPath, `${key} should include renderer path`);
    }
  });
});

// -- WINDOW_TITLE ---------------------------------------------------------

describe('launch.js -- WINDOW_TITLE constant', () => {
  test('WINDOW_TITLE is "Code Crumb"', () => {
    assert.strictEqual(WINDOW_TITLE, 'Code Crumb');
  });
});

// -- Integration: parseArgs + resolveEditor -------------------------------

describe('launch.js -- parseArgs + resolveEditor integration', () => {
  const baseDir = '/project';

  test('full pipeline: --editor codex -p "fix bug"', () => {
    const { editorName, editorArgs } = parseArgs(['--editor', 'codex', '-p', 'fix bug']);
    const { cmd, args } = resolveEditor(editorName, editorArgs, baseDir);
    assert.strictEqual(cmd, 'node');
    assert.ok(args[0].includes('codex-wrapper.js'));
    assert.deepStrictEqual(args.slice(1), ['-p', 'fix bug']);
  });

  test('full pipeline: no flags defaults to claude with all args passed', () => {
    const { editorName, editorArgs } = parseArgs(['--dangerously-skip-permissions']);
    const { cmd, args } = resolveEditor(editorName, editorArgs, baseDir);
    assert.strictEqual(cmd, 'claude');
    assert.deepStrictEqual(args, ['--dangerously-skip-permissions']);
  });

  test('full pipeline: --editor pi with prompt', () => {
    const { editorName, editorArgs } = parseArgs(['--editor', 'pi', 'do stuff']);
    const { cmd, args } = resolveEditor(editorName, editorArgs, baseDir);
    assert.strictEqual(cmd, 'openclaw');
    assert.deepStrictEqual(args, ['do stuff']);
  });
});

module.exports = { passed: () => passed, failed: () => failed };
