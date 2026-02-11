#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Test Suite                                          |
// |  Zero-dependency tests using Node.js built-in assert            |
// |                                                                  |
// |  Run: node test.js  or  npm test                                |
// +================================================================+

const assert = require('assert');

// -- Modules under test ----------------------------------------------

const { safeFilename } = require('./shared');
const {
  toolToState,
  stdoutErrorPatterns,
  stderrErrorPatterns,
  falsePositives,
  looksLikeError,
  errorDetail,
  extractExitCode,
  classifyToolResult,
  MILESTONES,
  updateStreak,
  defaultStats,
} = require('./state-machine');
const {
  ClaudeFace, MiniFace, FaceGrid, ParticleSystem,
  lerpColor, dimColor, breathe,
  themes, mouths, eyes, gridMouths,
  COMPLETION_LINGER, TIMELINE_COLORS,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
} = require('./renderer');

// -- Test runner -----------------------------------------------------

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

// ====================================================================
// shared.js
// ====================================================================

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

// ====================================================================
// state-machine.js -- toolToState
// ====================================================================

describe('state-machine.js -- toolToState', () => {
  test('Edit → coding with filename', () => {
    const r = toolToState('Edit', { file_path: '/src/App.tsx' });
    assert.strictEqual(r.state, 'coding');
    assert.strictEqual(r.detail, 'editing App.tsx');
  });

  test('Write → coding (case insensitive)', () => {
    const r = toolToState('WRITE', { path: '/foo/bar.js' });
    assert.strictEqual(r.state, 'coding');
    assert.strictEqual(r.detail, 'editing bar.js');
  });

  test('multiedit → coding', () => {
    assert.strictEqual(toolToState('MultiEdit', {}).state, 'coding');
  });

  test('str_replace → coding', () => {
    assert.strictEqual(toolToState('str_replace', {}).state, 'coding');
  });

  test('create_file → coding', () => {
    assert.strictEqual(toolToState('create_file', {}).state, 'coding');
  });

  test('coding without file path → "writing code"', () => {
    const r = toolToState('Edit', {});
    assert.strictEqual(r.detail, 'writing code');
  });

  test('Bash → executing', () => {
    const r = toolToState('Bash', { command: 'ls -la' });
    assert.strictEqual(r.state, 'executing');
    assert.strictEqual(r.detail, 'ls -la');
  });

  test('Bash with long command → truncated', () => {
    const cmd = 'a'.repeat(50);
    const r = toolToState('Bash', { command: cmd });
    assert.ok(r.detail.endsWith('...'));
    assert.ok(r.detail.length <= 40);
  });

  test('Bash with jest → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'npx jest' }).state, 'testing');
  });

  test('Bash with pytest → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'pytest tests/' }).state, 'testing');
  });

  test('Bash with vitest → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'vitest run' }).state, 'testing');
  });

  test('Bash with npm test → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'npm test' }).state, 'testing');
  });

  test('Bash with npm run test → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'npm run test' }).state, 'testing');
  });

  test('Bash with .test. in command → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'node foo.test.js' }).state, 'testing');
  });

  test('Bash with npm install → installing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'npm install express' }).state, 'installing');
  });

  test('Bash with yarn add → installing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'yarn add lodash' }).state, 'installing');
  });

  test('Bash with pip install → installing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'pip install flask' }).state, 'installing');
  });

  test('Bash with cargo build → installing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'cargo build' }).state, 'installing');
  });

  test('Bash with pnpm add → installing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'pnpm add react' }).state, 'installing');
  });

  test('Bash with bun install → installing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'bun install' }).state, 'installing');
  });

  test('Bash with brew install → installing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'brew install ripgrep' }).state, 'installing');
  });

  test('Bash with apt-get install → installing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'apt-get install curl' }).state, 'installing');
  });

  test('Read → reading with filename', () => {
    const r = toolToState('Read', { file_path: '/src/index.ts' });
    assert.strictEqual(r.state, 'reading');
    assert.strictEqual(r.detail, 'reading index.ts');
  });

  test('View → reading', () => {
    assert.strictEqual(toolToState('View', {}).state, 'reading');
  });

  test('Cat → reading', () => {
    assert.strictEqual(toolToState('Cat', {}).state, 'reading');
  });

  test('Grep → searching with pattern', () => {
    const r = toolToState('Grep', { pattern: 'TODO' });
    assert.strictEqual(r.state, 'searching');
    assert.ok(r.detail.includes('TODO'));
  });

  test('Glob → searching', () => {
    assert.strictEqual(toolToState('Glob', { query: '*.ts' }).state, 'searching');
  });

  test('Search → searching', () => {
    assert.strictEqual(toolToState('Search', {}).state, 'searching');
  });

  test('web_search → searching', () => {
    const r = toolToState('web_search', { query: 'node.js docs' });
    assert.strictEqual(r.state, 'searching');
    assert.ok(r.detail.includes('node.js docs'));
  });

  test('WebFetch → searching', () => {
    assert.strictEqual(toolToState('WebFetch', { url: 'https://example.com' }).state, 'searching');
  });

  test('Task → subagent', () => {
    const r = toolToState('Task', { description: 'explore the codebase' });
    assert.strictEqual(r.state, 'subagent');
    assert.ok(r.detail.includes('explore the codebase'));
  });

  test('Task with long description → truncated', () => {
    const r = toolToState('Task', { description: 'a'.repeat(40) });
    assert.ok(r.detail.endsWith('...'));
    assert.ok(r.detail.length <= 30);
  });

  test('Subagent → subagent', () => {
    assert.strictEqual(toolToState('Subagent', {}).state, 'subagent');
  });

  test('MCP tool → executing with server:tool detail', () => {
    const r = toolToState('mcp__github__list_repos', {});
    assert.strictEqual(r.state, 'executing');
    assert.strictEqual(r.detail, 'github: list_repos');
  });

  test('MCP tool with no tool part', () => {
    const r = toolToState('mcp__server', {});
    assert.strictEqual(r.state, 'executing');
    assert.strictEqual(r.detail, 'server: ');
  });

  test('Unknown tool → thinking', () => {
    const r = toolToState('SomeNewTool', {});
    assert.strictEqual(r.state, 'thinking');
    assert.strictEqual(r.detail, 'SomeNewTool');
  });

  test('Empty tool name → thinking', () => {
    const r = toolToState('', {});
    assert.strictEqual(r.state, 'thinking');
  });
});

// ====================================================================
// state-machine.js -- extractExitCode
// ====================================================================

describe('state-machine.js -- extractExitCode', () => {
  test('"Exit code: 1" → 1', () => {
    assert.strictEqual(extractExitCode('some output\nExit code: 1'), 1);
  });

  test('"exit code: 0" → 0', () => {
    assert.strictEqual(extractExitCode('exit code: 0'), 0);
  });

  test('"exited with 127" → 127', () => {
    assert.strictEqual(extractExitCode('Process exited with 127'), 127);
  });

  test('"returned 2" → 2', () => {
    assert.strictEqual(extractExitCode('command returned 2'), 2);
  });

  test('no match → null', () => {
    assert.strictEqual(extractExitCode('everything is fine'), null);
  });

  test('empty string → null', () => {
    assert.strictEqual(extractExitCode(''), null);
  });
});

// ====================================================================
// state-machine.js -- looksLikeError (stdout patterns)
// ====================================================================

describe('state-machine.js -- looksLikeError (stdout)', () => {
  test('detects "command not found"', () => {
    assert.ok(looksLikeError('bash: foo: command not found', stdoutErrorPatterns));
  });

  test('detects "ENOENT"', () => {
    assert.ok(looksLikeError('Error: ENOENT: no such file', stdoutErrorPatterns));
  });

  test('detects "syntax error"', () => {
    assert.ok(looksLikeError('SyntaxError: syntax error near unexpected token', stdoutErrorPatterns));
  });

  test('detects "segmentation fault"', () => {
    assert.ok(looksLikeError('Segmentation fault (core dumped)', stdoutErrorPatterns));
  });

  test('detects "PANIC"', () => {
    assert.ok(looksLikeError('PANIC: runtime error', stdoutErrorPatterns));
  });

  test('detects Python traceback', () => {
    assert.ok(looksLikeError('Traceback (most recent call last)', stdoutErrorPatterns));
  });

  test('detects "Cannot find module"', () => {
    assert.ok(looksLikeError("Cannot find module 'express'", stdoutErrorPatterns));
  });

  test('detects "ModuleNotFoundError"', () => {
    assert.ok(looksLikeError('ModuleNotFoundError: No module named flask', stdoutErrorPatterns));
  });

  test('detects "build failed"', () => {
    assert.ok(looksLikeError('ERROR: build failed with exit code 1', stdoutErrorPatterns));
  });

  test('detects "tests failed"', () => {
    assert.ok(looksLikeError('3 tests failed', stdoutErrorPatterns));
  });

  test('detects "npm ERR!"', () => {
    assert.ok(looksLikeError('npm ERR! code ERESOLVE', stdoutErrorPatterns));
  });

  test('detects "permission denied"', () => {
    assert.ok(looksLikeError('error: permission denied for /root', stdoutErrorPatterns));
  });

  test('returns false for clean output', () => {
    assert.ok(!looksLikeError('all tests passed', stdoutErrorPatterns));
  });

  test('returns false for empty string', () => {
    assert.ok(!looksLikeError('', stdoutErrorPatterns));
  });

  test('returns false for null/undefined', () => {
    assert.ok(!looksLikeError(null, stdoutErrorPatterns));
    assert.ok(!looksLikeError(undefined, stdoutErrorPatterns));
  });
});

// ====================================================================
// state-machine.js -- looksLikeError (stderr patterns)
// ====================================================================

describe('state-machine.js -- looksLikeError (stderr)', () => {
  test('detects "error:" in stderr', () => {
    assert.ok(looksLikeError('error: compilation failed', stderrErrorPatterns));
  });

  test('detects "fatal"', () => {
    assert.ok(looksLikeError('fatal: not a git repository', stderrErrorPatterns));
  });

  test('detects "failed"', () => {
    assert.ok(looksLikeError('build failed', stderrErrorPatterns));
  });

  test('detects "panic" in stderr', () => {
    assert.ok(looksLikeError('panic: index out of range', stderrErrorPatterns));
  });

  test('returns false for clean stderr', () => {
    assert.ok(!looksLikeError('downloading packages...', stderrErrorPatterns));
  });
});

// ====================================================================
// state-machine.js -- false positive guards
// ====================================================================

describe('state-machine.js -- false positive guards', () => {
  test('"0 errors" is a false positive', () => {
    assert.ok(!looksLikeError('Compiled with 0 errors', stderrErrorPatterns));
  });

  test('"no errors" is a false positive', () => {
    assert.ok(!looksLikeError('Lint complete: no errors found', stderrErrorPatterns));
  });

  test('"error handling" is a false positive', () => {
    assert.ok(!looksLikeError('improved error handling in auth module', stderrErrorPatterns));
  });

  test('"error.js" (filename) is a false positive', () => {
    assert.ok(!looksLikeError('Updated error.js with new messages', stderrErrorPatterns));
  });

  test('"stderr" mention is a false positive', () => {
    assert.ok(!looksLikeError('piped error output to stderr', stderrErrorPatterns));
  });

  test('".error(" (method call) is a false positive', () => {
    assert.ok(!looksLikeError('logger.error (msg)', stderrErrorPatterns));
  });

  test('"error_count: 0" is a false positive', () => {
    assert.ok(!looksLikeError('error_count: 0, warning_count: 3', stderrErrorPatterns));
  });

  test('"errors: 0" is a false positive', () => {
    assert.ok(!looksLikeError('errors: 0', stderrErrorPatterns));
  });

  test('"warning" is a false positive', () => {
    assert.ok(!looksLikeError('failed with warning: deprecated API', stderrErrorPatterns));
  });
});

// ====================================================================
// state-machine.js -- errorDetail
// ====================================================================

describe('state-machine.js -- errorDetail', () => {
  test('maps "command not found"', () => {
    assert.strictEqual(errorDetail('bash: command not found', ''), 'command not found');
  });

  test('maps "permission denied"', () => {
    assert.strictEqual(errorDetail('', 'permission denied'), 'permission denied');
  });

  test('maps "no such file or directory"', () => {
    assert.strictEqual(errorDetail('no such file or directory', ''), 'file not found');
  });

  test('maps "segmentation fault"', () => {
    assert.strictEqual(errorDetail('segmentation fault', ''), 'segfault!');
  });

  test('maps ENOENT', () => {
    assert.strictEqual(errorDetail('ENOENT', ''), 'missing file/path');
  });

  test('maps "syntax error"', () => {
    assert.strictEqual(errorDetail('syntax error near token', ''), 'syntax error');
  });

  test('maps Python traceback', () => {
    assert.strictEqual(errorDetail('Traceback (most recent call last)\n  File...', ''), 'exception thrown');
  });

  test('maps "Cannot find module"', () => {
    assert.strictEqual(errorDetail("Cannot find module 'x'", ''), 'missing module');
  });

  test('maps "ModuleNotFound"', () => {
    assert.strictEqual(errorDetail('', 'ModuleNotFoundError: foo'), 'missing module');
  });

  test('maps "build failed"', () => {
    assert.strictEqual(errorDetail('build failed', ''), 'build broke');
  });

  test('maps "Compilation failed"', () => {
    assert.strictEqual(errorDetail('Compilation failed', ''), 'build broke');
  });

  test('maps "tests failed"', () => {
    assert.strictEqual(errorDetail('3 tests failed', ''), 'tests failed');
  });

  test('maps "npm ERR!"', () => {
    assert.strictEqual(errorDetail('npm ERR! code ERESOLVE', ''), 'npm error');
  });

  test('falls back to "something went wrong"', () => {
    assert.strictEqual(errorDetail('some random error', ''), 'something went wrong');
  });
});

// ====================================================================
// state-machine.js -- classifyToolResult
// ====================================================================

describe('state-machine.js -- classifyToolResult (error detection)', () => {
  test('isError flag → error state', () => {
    const r = classifyToolResult('Bash', {}, { stdout: 'fail', isError: true }, true);
    assert.strictEqual(r.state, 'error');
  });

  test('interrupted → error with "interrupted" detail', () => {
    const r = classifyToolResult('Bash', {}, { interrupted: true }, false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'interrupted');
  });

  test('exit code in stdout → error state', () => {
    const r = classifyToolResult('Bash', {}, { stdout: 'Exit code: 1' }, false);
    assert.strictEqual(r.state, 'error');
  });

  test('exit code 0 → not error', () => {
    const r = classifyToolResult('Bash', { command: 'echo hi' }, { stdout: 'Exit code: 0' }, false);
    assert.notStrictEqual(r.state, 'error');
  });

  test('stderr error pattern → error state', () => {
    const r = classifyToolResult('Bash', { command: 'make' }, { stderr: 'fatal: compilation error' }, false);
    assert.strictEqual(r.state, 'error');
  });

  test('bash stdout error pattern → error state', () => {
    const r = classifyToolResult('Bash', { command: 'make' }, { stdout: 'command not found' }, false);
    assert.strictEqual(r.state, 'error');
  });

  test('non-bash stdout error pattern → NOT error (only bash checks stdout)', () => {
    const r = classifyToolResult('Read', { file_path: '/x' }, { stdout: 'command not found' }, false);
    assert.notStrictEqual(r.state, 'error');
  });

  test('stderr false positive → not error', () => {
    const r = classifyToolResult('Bash', { command: 'echo' }, { stderr: '0 errors, 5 warnings' }, false);
    assert.notStrictEqual(r.state, 'error');
  });
});

describe('state-machine.js -- classifyToolResult (success states)', () => {
  test('Edit success → proud', () => {
    const r = classifyToolResult('Edit', { file_path: '/src/App.tsx' }, {}, false);
    assert.strictEqual(r.state, 'proud');
    assert.strictEqual(r.detail, 'saved App.tsx');
  });

  test('Edit success with diff info', () => {
    const r = classifyToolResult('Edit', {
      file_path: '/src/App.tsx',
      old_string: 'line1\nline2',
      new_string: 'line1\nline2\nline3\nline4',
    }, {}, false);
    assert.strictEqual(r.state, 'proud');
    assert.deepStrictEqual(r.diffInfo, { added: 4, removed: 2 });
  });

  test('Write with content only → diffInfo has added lines', () => {
    const r = classifyToolResult('Write', {
      file_path: '/new.js',
      content: 'a\nb\nc',
    }, {}, false);
    assert.strictEqual(r.state, 'proud');
    assert.deepStrictEqual(r.diffInfo, { added: 3, removed: 0 });
  });

  test('Edit without file_path → "code written"', () => {
    const r = classifyToolResult('Edit', {}, {}, false);
    assert.strictEqual(r.detail, 'code written');
  });

  test('Read success → satisfied', () => {
    const r = classifyToolResult('Read', { file_path: '/src/index.ts' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.strictEqual(r.detail, 'read index.ts');
  });

  test('Grep success → satisfied with pattern', () => {
    const r = classifyToolResult('Grep', { pattern: 'TODO' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.ok(r.detail.includes('TODO'));
  });

  test('Grep with long pattern → truncated', () => {
    const r = classifyToolResult('Grep', { pattern: 'a'.repeat(30) }, {}, false);
    assert.ok(r.detail.includes('...'));
  });

  test('web_search success → satisfied', () => {
    const r = classifyToolResult('web_search', {}, {}, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.strictEqual(r.detail, 'search complete');
  });

  test('Bash test success → relieved with "tests passed"', () => {
    const r = classifyToolResult('Bash', { command: 'npm test' }, { stdout: 'all good' }, false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, 'tests passed');
  });

  test('Bash test success with count → extracts test count', () => {
    const r = classifyToolResult('Bash', { command: 'pytest' }, { stdout: '42 tests passed' }, false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, '42 tests passed');
  });

  test('Bash test with "passing" format', () => {
    const r = classifyToolResult('Bash', { command: 'npx jest' }, { stdout: '15 passing (2s)' }, false);
    assert.strictEqual(r.detail, '15 tests passed');
  });

  test('Bash build success → "build succeeded"', () => {
    const r = classifyToolResult('Bash', { command: 'npm run build' }, {}, false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, 'build succeeded');
  });

  test('Bash git success → "git done"', () => {
    const r = classifyToolResult('Bash', { command: 'git status' }, {}, false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, 'git done');
  });

  test('Bash install success → "installed"', () => {
    const r = classifyToolResult('Bash', { command: 'npm install express' }, {}, false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, 'installed');
  });

  test('Bash generic command → "command succeeded"', () => {
    const r = classifyToolResult('Bash', { command: 'echo hello' }, {}, false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, 'command succeeded');
  });

  test('Unknown tool success → satisfied, "step complete"', () => {
    const r = classifyToolResult('SomeNewTool', {}, {}, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.strictEqual(r.detail, 'step complete');
  });

  test('diffInfo is null for non-edit tools', () => {
    const r = classifyToolResult('Read', { file_path: '/x' }, {}, false);
    assert.strictEqual(r.diffInfo, null);
  });
});

// ====================================================================
// state-machine.js -- updateStreak
// ====================================================================

describe('state-machine.js -- updateStreak', () => {
  test('success increments streak 0 → 1', () => {
    const stats = defaultStats();
    updateStreak(stats, false);
    assert.strictEqual(stats.streak, 1);
  });

  test('consecutive successes increment streak', () => {
    const stats = defaultStats();
    updateStreak(stats, false);
    updateStreak(stats, false);
    updateStreak(stats, false);
    assert.strictEqual(stats.streak, 3);
  });

  test('error resets streak to 0', () => {
    const stats = defaultStats();
    stats.streak = 5;
    updateStreak(stats, true);
    assert.strictEqual(stats.streak, 0);
  });

  test('error sets brokenStreak to previous streak', () => {
    const stats = defaultStats();
    stats.streak = 15;
    updateStreak(stats, true);
    assert.strictEqual(stats.brokenStreak, 15);
  });

  test('error sets brokenStreakAt timestamp', () => {
    const stats = defaultStats();
    stats.streak = 5;
    const before = Date.now();
    updateStreak(stats, true);
    assert.ok(stats.brokenStreakAt >= before);
  });

  test('error increments totalErrors', () => {
    const stats = defaultStats();
    updateStreak(stats, true);
    updateStreak(stats, true);
    assert.strictEqual(stats.totalErrors, 2);
  });

  test('success updates bestStreak', () => {
    const stats = defaultStats();
    for (let i = 0; i < 10; i++) updateStreak(stats, false);
    assert.strictEqual(stats.bestStreak, 10);
  });

  test('bestStreak survives error', () => {
    const stats = defaultStats();
    for (let i = 0; i < 10; i++) updateStreak(stats, false);
    updateStreak(stats, true);
    updateStreak(stats, false);
    assert.strictEqual(stats.bestStreak, 10);
    assert.strictEqual(stats.streak, 1);
  });

  test('milestone at 10', () => {
    const stats = defaultStats();
    for (let i = 0; i < 10; i++) updateStreak(stats, false);
    assert.ok(stats.recentMilestone);
    assert.strictEqual(stats.recentMilestone.value, 10);
    assert.strictEqual(stats.recentMilestone.type, 'streak');
  });

  test('milestone at 25', () => {
    const stats = defaultStats();
    for (let i = 0; i < 25; i++) updateStreak(stats, false);
    assert.strictEqual(stats.recentMilestone.value, 25);
  });

  test('milestone at 50', () => {
    const stats = defaultStats();
    for (let i = 0; i < 50; i++) updateStreak(stats, false);
    assert.strictEqual(stats.recentMilestone.value, 50);
  });

  test('milestone at 100', () => {
    const stats = defaultStats();
    for (let i = 0; i < 100; i++) updateStreak(stats, false);
    assert.strictEqual(stats.recentMilestone.value, 100);
  });

  test('no milestone at 11', () => {
    const stats = defaultStats();
    for (let i = 0; i < 11; i++) updateStreak(stats, false);
    // Last milestone was at 10, not 11
    assert.strictEqual(stats.recentMilestone.value, 10);
  });

  test('no milestone at 9', () => {
    const stats = defaultStats();
    for (let i = 0; i < 9; i++) updateStreak(stats, false);
    assert.strictEqual(stats.recentMilestone, null);
  });
});

// ====================================================================
// state-machine.js -- MILESTONES and defaultStats
// ====================================================================

describe('state-machine.js -- constants and defaults', () => {
  test('MILESTONES contains expected values', () => {
    assert.deepStrictEqual(MILESTONES, [10, 25, 50, 100, 200, 500]);
  });

  test('defaultStats has all required fields', () => {
    const s = defaultStats();
    assert.strictEqual(s.streak, 0);
    assert.strictEqual(s.bestStreak, 0);
    assert.strictEqual(s.brokenStreak, 0);
    assert.strictEqual(s.totalToolCalls, 0);
    assert.strictEqual(s.totalErrors, 0);
    assert.ok(s.records);
    assert.ok(s.session);
    assert.ok(Array.isArray(s.session.filesEdited));
    assert.strictEqual(s.recentMilestone, null);
    assert.ok(s.daily);
    assert.ok(s.frequentFiles);
  });

  test('defaultStats returns fresh object each call', () => {
    const a = defaultStats();
    const b = defaultStats();
    a.streak = 99;
    assert.strictEqual(b.streak, 0);
  });
});

// ====================================================================
// renderer.js -- color utilities
// ====================================================================

describe('renderer.js -- lerpColor', () => {
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
});

describe('renderer.js -- dimColor', () => {
  test('factor=1 → unchanged', () => {
    assert.deepStrictEqual(dimColor([100, 200, 50], 1), [100, 200, 50]);
  });

  test('factor=0 → black', () => {
    assert.deepStrictEqual(dimColor([100, 200, 50], 0), [0, 0, 0]);
  });

  test('factor=0.5 → halved', () => {
    assert.deepStrictEqual(dimColor([100, 200, 50], 0.5), [50, 100, 25]);
  });
});

describe('renderer.js -- breathe', () => {
  test('returns an RGB array', () => {
    const result = breathe([100, 200, 50], 0);
    assert.ok(Array.isArray(result));
    assert.strictEqual(result.length, 3);
  });

  test('result is dimmer than original', () => {
    // At time 0, sin(0) = 0, so t = 0.5, factor = 0.65 + 0.5*0.35 = 0.825
    const result = breathe([100, 200, 50], 0);
    assert.ok(result[0] <= 100);
    assert.ok(result[1] <= 200);
    assert.ok(result[2] <= 50);
  });

  test('oscillates over a period', () => {
    const a = breathe([100, 200, 50], 0);
    const b = breathe([100, 200, 50], 1000); // quarter period
    // These should be different since breathing oscillates
    assert.ok(a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]);
  });
});

// ====================================================================
// renderer.js -- themes
// ====================================================================

describe('renderer.js -- themes', () => {
  const ALL_STATES = [
    'idle', 'thinking', 'coding', 'reading', 'searching', 'executing',
    'happy', 'satisfied', 'proud', 'relieved', 'error', 'sleeping',
    'waiting', 'testing', 'installing', 'caffeinated', 'subagent',
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

  test('every state has a grid mouth', () => {
    for (const state of ALL_STATES) {
      assert.ok(typeof gridMouths[state] === 'string', `missing gridMouth for: ${state}`);
    }
  });
});

// ====================================================================
// renderer.js -- COMPLETION_LINGER
// ====================================================================

describe('renderer.js -- COMPLETION_LINGER', () => {
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

// ====================================================================
// renderer.js -- thought bubble pools
// ====================================================================

describe('renderer.js -- thought bubbles', () => {
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

// ====================================================================
// renderer.js -- mouths
// ====================================================================

describe('renderer.js -- mouths', () => {
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

// ====================================================================
// renderer.js -- eyes
// ====================================================================

describe('renderer.js -- eyes', () => {
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

// ====================================================================
// renderer.js -- ClaudeFace
// ====================================================================

describe('renderer.js -- ClaudeFace constructor', () => {
  test('initializes with idle state', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.state, 'idle');
  });

  test('initializes with zero counters', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.frame, 0);
    assert.strictEqual(face.streak, 0);
    assert.strictEqual(face.toolCallCount, 0);
    assert.strictEqual(face.filesEditedCount, 0);
  });

  test('has a particle system', () => {
    const face = new ClaudeFace();
    assert.ok(face.particles instanceof ParticleSystem);
  });
});

describe('renderer.js -- ClaudeFace._getMinDisplayMs', () => {
  const face = new ClaudeFace();

  test('happy → 5000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('happy'), 5000);
  });

  test('error → 3500ms', () => {
    assert.strictEqual(face._getMinDisplayMs('error'), 3500);
  });

  test('coding → 2500ms', () => {
    assert.strictEqual(face._getMinDisplayMs('coding'), 2500);
  });

  test('reading → 2000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('reading'), 2000);
  });

  test('sleeping → 1000ms', () => {
    assert.strictEqual(face._getMinDisplayMs('sleeping'), 1000);
  });

  test('unknown state → 1000ms default', () => {
    assert.strictEqual(face._getMinDisplayMs('nonexistent'), 1000);
  });
});

describe('renderer.js -- ClaudeFace.setState', () => {
  test('changes state', () => {
    const face = new ClaudeFace();
    face.setState('coding', 'editing App.tsx');
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.stateDetail, 'editing App.tsx');
  });

  test('sets prevState', () => {
    const face = new ClaudeFace();
    face.setState('coding');
    assert.strictEqual(face.prevState, 'idle');
  });

  test('updates timeline', () => {
    const face = new ClaudeFace();
    const initialLen = face.timeline.length;
    face.setState('reading');
    assert.strictEqual(face.timeline.length, initialLen + 1);
    assert.strictEqual(face.timeline[face.timeline.length - 1].state, 'reading');
  });

  test('buffers pending state during min display time', () => {
    const face = new ClaudeFace();
    face.setState('happy'); // min display: 5000ms
    face.setState('coding'); // should be buffered
    assert.strictEqual(face.state, 'happy'); // still happy
    assert.strictEqual(face.pendingState, 'coding');
  });

  test('same state updates detail without changing state', () => {
    const face = new ClaudeFace();
    face.setState('coding', 'editing a.ts');
    face.setState('coding', 'editing b.ts');
    assert.strictEqual(face.stateDetail, 'editing b.ts');
  });

  test('spawns particles on happy', () => {
    const face = new ClaudeFace();
    face.setState('happy');
    assert.ok(face.particles.particles.length > 0);
  });

  test('spawns particles on error', () => {
    const face = new ClaudeFace();
    face.setState('error');
    assert.ok(face.particles.particles.length > 0);
    assert.strictEqual(face.glitchIntensity, 1.0);
  });

  test('fades old particles on state change', () => {
    const face = new ClaudeFace();
    face.particles.spawn(10, 'float');
    const maxBefore = Math.max(...face.particles.particles.map(p => p.life));
    face.setState('coding');
    const maxAfter = Math.max(...face.particles.particles.map(p => p.life));
    assert.ok(maxAfter <= 12); // fadeAll caps at 12
  });
});

describe('renderer.js -- ClaudeFace.setStats', () => {
  test('updates tool call count', () => {
    const face = new ClaudeFace();
    face.setStats({ toolCalls: 42 });
    assert.strictEqual(face.toolCallCount, 42);
  });

  test('updates files edited count', () => {
    const face = new ClaudeFace();
    face.setStats({ filesEdited: 5 });
    assert.strictEqual(face.filesEditedCount, 5);
  });

  test('updates streak data', () => {
    const face = new ClaudeFace();
    face.setStats({ streak: 15, bestStreak: 20 });
    assert.strictEqual(face.streak, 15);
    assert.strictEqual(face.bestStreak, 20);
  });

  test('detects broken streak', () => {
    const face = new ClaudeFace();
    face.setStats({ brokenStreak: 10, brokenStreakAt: Date.now() });
    assert.strictEqual(face.lastBrokenStreak, 10);
    assert.ok(face.glitchIntensity > 0);
  });

  test('detects milestone', () => {
    const face = new ClaudeFace();
    face.setStats({ milestone: { type: 'streak', value: 25, at: Date.now() } });
    assert.ok(face.milestone);
    assert.strictEqual(face.milestone.value, 25);
    assert.strictEqual(face.milestoneShowTime, 180);
  });

  test('ignores duplicate milestone', () => {
    const face = new ClaudeFace();
    const ms = { type: 'streak', value: 25, at: 12345 };
    face.setStats({ milestone: ms });
    const firstShowTime = face.milestoneShowTime;
    face.milestoneShowTime = 50; // simulate some decay
    face.setStats({ milestone: ms }); // same milestone
    assert.strictEqual(face.milestoneShowTime, 50); // not reset
  });

  test('updates daily data', () => {
    const face = new ClaudeFace();
    face.setStats({ dailySessions: 3, dailyCumulativeMs: 3600000 });
    assert.strictEqual(face.dailySessions, 3);
    assert.strictEqual(face.dailyCumulativeMs, 3600000);
  });

  test('updates diffInfo', () => {
    const face = new ClaudeFace();
    face.setStats({ diffInfo: { added: 10, removed: 3 } });
    assert.deepStrictEqual(face.diffInfo, { added: 10, removed: 3 });
  });
});

describe('renderer.js -- ClaudeFace.update', () => {
  test('increments frame counter', () => {
    const face = new ClaudeFace();
    face.update(66);
    assert.strictEqual(face.frame, 1);
    face.update(66);
    assert.strictEqual(face.frame, 2);
  });

  test('accumulates time', () => {
    const face = new ClaudeFace();
    face.update(100);
    face.update(200);
    assert.strictEqual(face.time, 300);
  });

  test('applies pending state after min display time expires', () => {
    const face = new ClaudeFace();
    face.setState('happy');
    face.setState('coding'); // buffered

    // Force minDisplayUntil to be in the past
    face.minDisplayUntil = Date.now() - 1;
    face.update(66);
    assert.strictEqual(face.state, 'coding');
  });

  test('glitch intensity decays', () => {
    const face = new ClaudeFace();
    face.glitchIntensity = 1.0;
    face.update(66);
    assert.ok(face.glitchIntensity < 1.0);
  });

  test('milestone show time decays', () => {
    const face = new ClaudeFace();
    face.milestoneShowTime = 100;
    face.update(66);
    assert.strictEqual(face.milestoneShowTime, 99);
  });

  test('particles are updated', () => {
    const face = new ClaudeFace();
    face.particles.spawn(1, 'float');
    const lifeBefore = face.particles.particles[0].life;
    face.update(66);
    assert.strictEqual(face.particles.particles[0].life, lifeBefore - 1);
  });
});

describe('renderer.js -- ClaudeFace.getTheme', () => {
  test('returns theme for current state', () => {
    const face = new ClaudeFace();
    face.state = 'error';
    const theme = face.getTheme();
    assert.deepStrictEqual(theme, themes.error);
  });

  test('falls back to idle theme for unknown state', () => {
    const face = new ClaudeFace();
    face.state = 'nonexistent';
    const theme = face.getTheme();
    assert.deepStrictEqual(theme, themes.idle);
  });
});

describe('renderer.js -- ClaudeFace.getEyes', () => {
  test('returns eyes for all states', () => {
    const states = [
      'idle', 'thinking', 'coding', 'reading', 'searching',
      'executing', 'happy', 'satisfied', 'proud', 'relieved',
      'error', 'sleeping', 'waiting', 'testing', 'installing',
      'caffeinated', 'subagent',
    ];
    for (const state of states) {
      const face = new ClaudeFace();
      face.state = state;
      face.blinkFrame = -1;
      const theme = face.getTheme();
      const result = face.getEyes(theme, 0);
      assert.ok(result.left, `getEyes failed for state: ${state}`);
      assert.ok(result.right, `getEyes failed for state: ${state}`);
    }
  });

  test('returns blink eyes when blinking', () => {
    const face = new ClaudeFace();
    face.blinkFrame = 1; // mid-blink
    const theme = face.getTheme();
    const result = face.getEyes(theme, 0);
    assert.deepStrictEqual(result, eyes.blink());
  });
});

describe('renderer.js -- ClaudeFace.getMouth', () => {
  test('returns mouth for all states', () => {
    const states = [
      'idle', 'thinking', 'coding', 'reading', 'searching',
      'executing', 'happy', 'satisfied', 'proud', 'relieved',
      'error', 'sleeping', 'waiting', 'testing', 'installing',
      'caffeinated', 'subagent',
    ];
    for (const state of states) {
      const face = new ClaudeFace();
      face.state = state;
      face.glitchIntensity = 0; // prevent random glitch
      const theme = face.getTheme();
      const result = face.getMouth(theme, 0);
      assert.ok(typeof result === 'string', `getMouth failed for state: ${state}`);
    }
  });
});

// ====================================================================
// renderer.js -- ParticleSystem
// ====================================================================

describe('renderer.js -- ParticleSystem', () => {
  test('starts with no particles', () => {
    const ps = new ParticleSystem();
    assert.strictEqual(ps.particles.length, 0);
  });

  test('spawn adds particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    assert.strictEqual(ps.particles.length, 5);
  });

  test('all particle styles can be spawned', () => {
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo'];
    for (const style of styles) {
      const ps = new ParticleSystem();
      ps.spawn(3, style);
      assert.strictEqual(ps.particles.length, 3, `spawn failed for style: ${style}`);
      // Verify structure
      for (const p of ps.particles) {
        assert.ok(typeof p.life === 'number', `particle.life missing for style: ${style}`);
        assert.ok(typeof p.char === 'string', `particle.char missing for style: ${style}`);
        assert.strictEqual(p.style, style);
      }
    }
  });

  test('update decrements particle life', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'float');
    const lifeBefore = ps.particles[0].life;
    ps.update();
    assert.strictEqual(ps.particles[0].life, lifeBefore - 1);
  });

  test('update removes dead particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'glitch'); // short life
    // Force particle to die
    ps.particles[0].life = 1;
    ps.update();
    assert.strictEqual(ps.particles.length, 0);
  });

  test('fadeAll caps particle life', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    // Some particles may have life > 12
    ps.fadeAll(12);
    for (const p of ps.particles) {
      assert.ok(p.life <= 12);
    }
  });

  test('orbit particles move in circles', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'orbit');
    const p = ps.particles[0];
    const angleBefore = p.angle;
    ps.update();
    assert.notStrictEqual(p.angle, angleBefore);
  });
});

// ====================================================================
// renderer.js -- MiniFace
// ====================================================================

describe('renderer.js -- MiniFace', () => {
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
    face.stoppedAt = Date.now() - 10000; // 10s ago
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

// ====================================================================
// renderer.js -- FaceGrid
// ====================================================================

describe('renderer.js -- FaceGrid', () => {
  test('initializes with empty map', () => {
    const grid = new FaceGrid();
    assert.strictEqual(grid.faces.size, 0);
  });

  test('assignLabels handles empty grid', () => {
    const grid = new FaceGrid();
    grid.assignLabels(); // should not throw
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

// ====================================================================
// Results
// ====================================================================

console.log(`\n  ${'='.repeat(40)}`);
if (failed === 0) {
  console.log(`  \x1b[32mAll ${passed} tests passed\x1b[0m`);
} else {
  console.log(`  \x1b[31m${failed} failed\x1b[0m, ${passed} passed`);
}
console.log(`  ${'='.repeat(40)}\n`);

process.exit(failed > 0 ? 1 : 0);
