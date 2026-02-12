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
  EDIT_TOOLS,
  BASH_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  WEB_TOOLS,
  SUBAGENT_TOOLS,
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
  lerpColor, dimColor, breathe,
  themes, COMPLETION_LINGER, TIMELINE_COLORS, SPARKLINE_BLOCKS,
  IDLE_THOUGHTS, THINKING_THOUGHTS, COMPLETION_THOUGHTS, STATE_THOUGHTS,
  PALETTES, PALETTE_NAMES,
} = require('./themes');
const { mouths, eyes, gridMouths } = require('./animations');
const { ParticleSystem } = require('./particles');
const { ClaudeFace } = require('./face');
const { MiniFace, FaceGrid } = require('./grid');
const { ACCESSORIES, STATE_ACCESSORIES, getAccessory } = require('./accessories');

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
// state-machine.js -- toolToState (Codex CLI tool names)
// ====================================================================

describe('state-machine.js -- toolToState (Codex CLI)', () => {
  test('shell → executing', () => {
    const r = toolToState('shell', { command: 'ls -la' });
    assert.strictEqual(r.state, 'executing');
  });

  test('shell with test command → testing', () => {
    assert.strictEqual(toolToState('shell', { command: 'npx jest' }).state, 'testing');
  });

  test('shell with install → installing', () => {
    assert.strictEqual(toolToState('shell', { command: 'npm install express' }).state, 'installing');
  });

  test('apply_diff → coding', () => {
    const r = toolToState('apply_diff', { target_file: '/src/index.ts' });
    assert.strictEqual(r.state, 'coding');
    assert.ok(r.detail.includes('index.ts'));
  });

  test('apply_patch → coding', () => {
    assert.strictEqual(toolToState('apply_patch', {}).state, 'coding');
  });

  test('file_edit → coding', () => {
    const r = toolToState('file_edit', { path: '/src/app.js' });
    assert.strictEqual(r.state, 'coding');
    assert.ok(r.detail.includes('app.js'));
  });

  test('file_read → reading', () => {
    const r = toolToState('file_read', { file_path: '/README.md' });
    assert.strictEqual(r.state, 'reading');
    assert.ok(r.detail.includes('README.md'));
  });

  test('list_dir → searching', () => {
    assert.strictEqual(toolToState('list_dir', {}).state, 'searching');
  });

  test('search_files → searching', () => {
    const r = toolToState('search_files', { search_term: 'TODO' });
    assert.strictEqual(r.state, 'searching');
    assert.ok(r.detail.includes('TODO'));
  });

  test('codex_agent → subagent', () => {
    assert.strictEqual(toolToState('codex_agent', {}).state, 'subagent');
  });
});

// ====================================================================
// state-machine.js -- toolToState (OpenCode tool names)
// ====================================================================

describe('state-machine.js -- toolToState (OpenCode)', () => {
  test('write_file → coding', () => {
    const r = toolToState('write_file', { file_path: '/src/main.go' });
    assert.strictEqual(r.state, 'coding');
    assert.ok(r.detail.includes('main.go'));
  });

  test('terminal → executing', () => {
    const r = toolToState('terminal', { command: 'go build' });
    assert.strictEqual(r.state, 'executing');
  });

  test('terminal with test → testing', () => {
    assert.strictEqual(toolToState('terminal', { command: 'pytest tests/' }).state, 'testing');
  });

  test('read_file → reading', () => {
    const r = toolToState('read_file', { file_path: '/go.mod' });
    assert.strictEqual(r.state, 'reading');
    assert.ok(r.detail.includes('go.mod'));
  });

  test('list_files → searching', () => {
    assert.strictEqual(toolToState('list_files', {}).state, 'searching');
  });

  test('find_files → searching', () => {
    assert.strictEqual(toolToState('find_files', { pattern: '*.go' }).state, 'searching');
  });

  test('codebase_search → searching', () => {
    const r = toolToState('codebase_search', { query: 'handleRequest' });
    assert.strictEqual(r.state, 'searching');
    assert.ok(r.detail.includes('handleRequest'));
  });

  test('browser → searching', () => {
    const r = toolToState('browser', { url: 'https://docs.go.dev' });
    assert.strictEqual(r.state, 'searching');
  });

  test('execute → executing', () => {
    assert.strictEqual(toolToState('execute', { command: 'make' }).state, 'executing');
  });

  test('spawn_agent → subagent', () => {
    assert.strictEqual(toolToState('spawn_agent', { prompt: 'fix tests' }).state, 'subagent');
  });
});

// ====================================================================
// state-machine.js -- toolToState (OpenClaw / Pi tool names)
// ====================================================================

describe('state-machine.js -- toolToState (OpenClaw / Pi)', () => {
  test('edit → coding', () => {
    const r = toolToState('edit', { file_path: '/src/main.ts' });
    assert.strictEqual(r.state, 'coding');
    assert.ok(r.detail.includes('main.ts'));
  });

  test('write → coding (Pi core tool)', () => {
    const r = toolToState('write', { file_path: '/src/app.js' });
    assert.strictEqual(r.state, 'coding');
    assert.ok(r.detail.includes('app.js'));
  });

  test('read → reading (Pi core tool)', () => {
    const r = toolToState('read', { file_path: '/package.json' });
    assert.strictEqual(r.state, 'reading');
    assert.ok(r.detail.includes('package.json'));
  });

  test('bash → executing (Pi core tool)', () => {
    const r = toolToState('bash', { command: 'ls -la' });
    assert.strictEqual(r.state, 'executing');
  });

  test('exec → executing (OpenClaw replacement for bash)', () => {
    const r = toolToState('exec', { command: 'npm run build' });
    assert.strictEqual(r.state, 'executing');
  });

  test('process → executing (OpenClaw tool)', () => {
    const r = toolToState('process', { command: 'node server.js' });
    assert.strictEqual(r.state, 'executing');
  });

  test('process with test command → testing', () => {
    assert.strictEqual(toolToState('process', { command: 'npx jest' }).state, 'testing');
  });

  test('process with install → installing', () => {
    assert.strictEqual(toolToState('process', { command: 'pnpm install' }).state, 'installing');
  });

  test('canvas → searching (OpenClaw web tool)', () => {
    const r = toolToState('canvas', { url: 'https://example.com' });
    assert.strictEqual(r.state, 'searching');
  });

  test('sessions → subagent (OpenClaw tool)', () => {
    const r = toolToState('sessions', { prompt: 'run analysis' });
    assert.strictEqual(r.state, 'subagent');
  });
});

// ====================================================================
// state-machine.js -- tool pattern constants
// ====================================================================

describe('state-machine.js -- tool pattern constants', () => {
  test('EDIT_TOOLS matches Claude Code tools', () => {
    for (const t of ['edit', 'multiedit', 'write', 'str_replace', 'create_file']) {
      assert.ok(EDIT_TOOLS.test(t), `EDIT_TOOLS should match "${t}"`);
    }
  });

  test('EDIT_TOOLS matches Codex tools', () => {
    for (const t of ['apply_diff', 'apply_patch', 'file_edit', 'code_edit']) {
      assert.ok(EDIT_TOOLS.test(t), `EDIT_TOOLS should match "${t}"`);
    }
  });

  test('EDIT_TOOLS matches OpenCode tools', () => {
    for (const t of ['write_file', 'create_file_with_contents', 'insert_text', 'replace_text', 'patch']) {
      assert.ok(EDIT_TOOLS.test(t), `EDIT_TOOLS should match "${t}"`);
    }
  });

  test('BASH_TOOLS matches all shell variants', () => {
    for (const t of ['bash', 'shell', 'terminal', 'execute', 'run_command', 'run', 'exec', 'process']) {
      assert.ok(BASH_TOOLS.test(t), `BASH_TOOLS should match "${t}"`);
    }
  });

  test('READ_TOOLS matches all read variants', () => {
    for (const t of ['read', 'view', 'cat', 'file_read', 'read_file', 'get_file_contents', 'open_file']) {
      assert.ok(READ_TOOLS.test(t), `READ_TOOLS should match "${t}"`);
    }
  });

  test('SEARCH_TOOLS matches all search variants', () => {
    for (const t of ['grep', 'glob', 'search', 'ripgrep', 'find', 'list', 'search_files', 'list_files', 'list_dir', 'find_files', 'file_search', 'codebase_search']) {
      assert.ok(SEARCH_TOOLS.test(t), `SEARCH_TOOLS should match "${t}"`);
    }
  });

  test('WEB_TOOLS matches all web variants', () => {
    for (const t of ['web_search', 'web_fetch', 'fetch', 'webfetch', 'browser', 'browse', 'http_request', 'curl', 'canvas']) {
      assert.ok(WEB_TOOLS.test(t), `WEB_TOOLS should match "${t}"`);
    }
  });

  test('SUBAGENT_TOOLS matches all subagent variants', () => {
    for (const t of ['task', 'subagent', 'spawn_agent', 'delegate', 'codex_agent', 'sessions']) {
      assert.ok(SUBAGENT_TOOLS.test(t), `SUBAGENT_TOOLS should match "${t}"`);
    }
  });

  test('Patterns are case-insensitive', () => {
    assert.ok(EDIT_TOOLS.test('APPLY_DIFF'));
    assert.ok(BASH_TOOLS.test('Shell'));
    assert.ok(READ_TOOLS.test('FILE_READ'));
    assert.ok(SEARCH_TOOLS.test('Codebase_Search'));
  });

  test('Patterns do not match partial strings', () => {
    assert.ok(!EDIT_TOOLS.test('my_edit_tool'));
    assert.ok(!BASH_TOOLS.test('bash_extended'));
    assert.ok(!READ_TOOLS.test('unread'));
  });
});

// ====================================================================
// state-machine.js -- classifyToolResult (Codex/OpenCode tools)
// ====================================================================

describe('state-machine.js -- classifyToolResult (multi-editor)', () => {
  test('apply_diff success → proud', () => {
    const r = classifyToolResult('apply_diff', { target_file: '/src/app.ts' }, {}, false);
    assert.strictEqual(r.state, 'proud');
    assert.ok(r.detail.includes('app.ts'));
  });

  test('file_read success → satisfied', () => {
    const r = classifyToolResult('file_read', { file_path: '/go.mod' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.ok(r.detail.includes('go.mod'));
  });

  test('shell success → relieved', () => {
    const r = classifyToolResult('shell', { command: 'echo hello' }, {}, false);
    assert.strictEqual(r.state, 'relieved');
  });

  test('shell with test → relieved with test detail', () => {
    const r = classifyToolResult('shell', { command: 'npm test' }, { stdout: '42 tests passed' }, false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, '42 tests passed');
  });

  test('shell error detected via stdout', () => {
    const r = classifyToolResult('shell', { command: 'bad' }, { stdout: 'command not found' }, false);
    assert.strictEqual(r.state, 'error');
  });

  test('terminal error detected via stderr', () => {
    const r = classifyToolResult('terminal', { command: 'go build' }, { stderr: 'fatal error' }, false);
    assert.strictEqual(r.state, 'error');
  });

  test('search_files success → satisfied', () => {
    const r = classifyToolResult('search_files', { search_term: 'TODO' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
  });

  test('browser success → satisfied', () => {
    const r = classifyToolResult('browser', { url: 'https://docs.go.dev' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
  });

  test('target_file field used for file path (Codex)', () => {
    const r = classifyToolResult('apply_diff', { target_file: '/src/main.rs' }, {}, false);
    assert.strictEqual(r.detail, 'saved main.rs');
  });

  test('cmd field used for command (generic)', () => {
    const r = toolToState('shell', { cmd: 'npm test' });
    assert.strictEqual(r.state, 'testing');
  });

  test('process success → relieved (OpenClaw)', () => {
    const r = classifyToolResult('process', { command: 'node build.js' }, {}, false);
    assert.strictEqual(r.state, 'relieved');
  });

  test('process error via stderr (OpenClaw)', () => {
    const r = classifyToolResult('process', { command: 'bun build' }, { stderr: 'fatal error' }, false);
    assert.strictEqual(r.state, 'error');
  });

  test('canvas success → satisfied (OpenClaw)', () => {
    const r = classifyToolResult('canvas', { url: 'https://example.com' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
  });

  test('sessions success → satisfied (OpenClaw)', () => {
    const r = classifyToolResult('sessions', { prompt: 'analyze' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
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

  test('updates modelName from state data', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.modelName, 'claude'); // default
    face.setStats({ modelName: 'codex' });
    assert.strictEqual(face.modelName, 'codex');
  });

  test('modelName ignores empty string', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'kimi-k2.5' });
    face.setStats({ modelName: '' }); // empty should not override
    assert.strictEqual(face.modelName, 'kimi-k2.5');
  });

  test('modelName updates to different values', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'o3' });
    assert.strictEqual(face.modelName, 'o3');
    face.setStats({ modelName: 'gpt-4.1' });
    assert.strictEqual(face.modelName, 'gpt-4.1');
  });
});

// ====================================================================
// renderer.js -- ClaudeFace modelName in rendering
// ====================================================================

describe('renderer.js -- ClaudeFace modelName', () => {
  test('default modelName is "claude"', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.modelName, 'claude');
  });

  test('modelName can be set via setStats', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'codex' });
    assert.strictEqual(face.modelName, 'codex');
  });

  test('modelName persists across multiple setStats calls', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'kimi-k2.5' });
    face.setStats({ toolCalls: 5 }); // no modelName in this call
    assert.strictEqual(face.modelName, 'kimi-k2.5');
  });

  test('modelName supports hyphenated names', () => {
    const face = new ClaudeFace();
    face.setStats({ modelName: 'gpt-4.1-mini' });
    assert.strictEqual(face.modelName, 'gpt-4.1-mini');
  });
});

// ====================================================================
// grid.js -- MiniFace modelName
// ====================================================================

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
    face.updateFromFile({ state: 'reading' }); // no modelName
    assert.strictEqual(face.modelName, 'o3');
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
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo', 'heart'];
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
// renderer.js -- SPARKLINE_BLOCKS
// ====================================================================

describe('renderer.js -- SPARKLINE_BLOCKS', () => {
  test('contains 7 Unicode block characters', () => {
    assert.strictEqual(SPARKLINE_BLOCKS.length, 7);
  });

  test('characters are ascending block elements', () => {
    // U+2581 through U+2587
    for (let i = 0; i < SPARKLINE_BLOCKS.length; i++) {
      assert.strictEqual(SPARKLINE_BLOCKS.charCodeAt(i), 0x2581 + i);
    }
  });
});

// ====================================================================
// renderer.js -- ClaudeFace._buildSparkline
// ====================================================================

describe('renderer.js -- ClaudeFace._buildSparkline', () => {
  test('returns null with fewer than 3 timeline entries', () => {
    const face = new ClaudeFace();
    // Default timeline has 1 entry (idle)
    assert.strictEqual(face._buildSparkline(10, Date.now()), null);
    face.timeline.push({ state: 'coding', at: Date.now() });
    assert.strictEqual(face._buildSparkline(10, Date.now()), null);
  });

  test('returns null when session duration < 2000ms', () => {
    const face = new ClaudeFace();
    const now = Date.now();
    face.timeline = [
      { state: 'idle', at: now },
      { state: 'coding', at: now + 500 },
      { state: 'reading', at: now + 1000 },
    ];
    assert.strictEqual(face._buildSparkline(10, now + 1500), null);
  });

  test('returns array of correct length', () => {
    const face = new ClaudeFace();
    const now = Date.now();
    face.timeline = [
      { state: 'idle', at: now - 10000 },
      { state: 'coding', at: now - 8000 },
      { state: 'reading', at: now - 5000 },
    ];
    const buckets = face._buildSparkline(20, now);
    assert.ok(Array.isArray(buckets));
    assert.strictEqual(buckets.length, 20);
  });

  test('counts state transitions in correct buckets', () => {
    const face = new ClaudeFace();
    const start = Date.now() - 10000;
    face.timeline = [
      { state: 'idle', at: start },
      { state: 'coding', at: start + 1000 },
      { state: 'reading', at: start + 1500 },
      { state: 'executing', at: start + 8000 },
    ];
    // 10 buckets over 10000ms = 1000ms per bucket
    const buckets = face._buildSparkline(10, start + 10000);
    // Transition at 1000ms -> bucket 1, at 1500ms -> bucket 1, at 8000ms -> bucket 8
    assert.strictEqual(buckets[1], 2);
    assert.strictEqual(buckets[8], 1);
    assert.strictEqual(buckets[0], 0);
    assert.strictEqual(buckets[5], 0);
  });

  test('total transitions equals timeline length minus 1', () => {
    const face = new ClaudeFace();
    const start = Date.now() - 20000;
    face.timeline = [
      { state: 'idle', at: start },
      { state: 'coding', at: start + 2000 },
      { state: 'reading', at: start + 5000 },
      { state: 'executing', at: start + 9000 },
      { state: 'happy', at: start + 15000 },
    ];
    const buckets = face._buildSparkline(10, start + 20000);
    const total = buckets.reduce((sum, b) => sum + b, 0);
    assert.strictEqual(total, 4); // 5 entries - 1 (first entry is anchor)
  });

  test('clamps last-bucket transitions correctly', () => {
    const face = new ClaudeFace();
    const start = Date.now() - 5000;
    face.timeline = [
      { state: 'idle', at: start },
      { state: 'coding', at: start + 4999 },
      { state: 'reading', at: start + 4999 },
    ];
    const buckets = face._buildSparkline(5, start + 5000);
    // Both transitions near the end should land in the last bucket (idx 4)
    assert.strictEqual(buckets[4], 2);
  });
});

// ====================================================================
// themes.js -- PALETTES
// ====================================================================

describe('themes.js -- PALETTES', () => {
  const ALL_STATES = [
    'idle', 'thinking', 'coding', 'reading', 'searching', 'executing',
    'happy', 'satisfied', 'proud', 'relieved', 'error', 'sleeping',
    'waiting', 'testing', 'installing', 'caffeinated', 'subagent',
  ];

  test('PALETTES has 5 entries', () => {
    assert.strictEqual(PALETTES.length, 5);
  });

  test('PALETTE_NAMES matches palette names', () => {
    assert.deepStrictEqual(PALETTE_NAMES, ['default', 'neon', 'pastel', 'mono', 'sunset']);
  });

  test('all palette names are unique', () => {
    const names = PALETTES.map(p => p.name);
    assert.strictEqual(new Set(names).size, names.length);
  });

  test('every palette has all 17 states in themes', () => {
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

  test('every palette has all 17 timeline colors', () => {
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

// ====================================================================
// face.js -- pet interaction
// ====================================================================

describe('face.js -- pet()', () => {
  test('spawns sparkle particles', () => {
    const face = new ClaudeFace();
    face.pet();
    assert.ok(face.particles.particles.length >= 15);
    assert.strictEqual(face.particles.particles[0].style, 'sparkle');
  });

  test('sets petTimer to 22', () => {
    const face = new ClaudeFace();
    face.pet();
    assert.strictEqual(face.petTimer, 22);
  });

  test('does NOT change state', () => {
    const face = new ClaudeFace();
    face.setState('coding');
    face.minDisplayUntil = 0; // allow state changes
    face.pet();
    assert.strictEqual(face.state, 'coding');
  });

  test('wiggle alternates then decays to 0', () => {
    const face = new ClaudeFace();
    face.pet();
    const wiggles = [];
    for (let i = 0; i < 25; i++) {
      face.update(66);
      wiggles.push(face.petWiggle);
    }
    // Should have non-zero wiggles early on
    assert.ok(wiggles.slice(0, 5).some(w => w !== 0));
    // Should decay to 0
    assert.strictEqual(wiggles[wiggles.length - 1], 0);
  });

  test('wiggle alternates between +1 and -1', () => {
    const face = new ClaudeFace();
    face.pet();
    face.update(66);
    const w1 = face.petWiggle;
    face.update(66);
    const w2 = face.petWiggle;
    assert.ok((w1 === 1 && w2 === -1) || (w1 === -1 && w2 === 1),
      'wiggle should alternate between +1 and -1');
  });
});

// ====================================================================
// face.js -- pet spam easter egg
// ====================================================================

describe('face.js -- pet spam easter egg', () => {
  test('tracks pet timestamps', () => {
    const face = new ClaudeFace();
    face.pet();
    face.pet();
    assert.strictEqual(face.petTimes.length, 2);
  });

  test('activates after 8 rapid pets', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.petSpamActive);
  });

  test('does NOT activate below threshold', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 7; i++) face.pet();
    assert.ok(!face.petSpamActive);
  });

  test('spawns heart particles on activation', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    const hearts = face.particles.particles.filter(p => p.style === 'heart');
    assert.ok(hearts.length >= 30);
  });

  test('spawns sparkles (not hearts) below threshold', () => {
    const face = new ClaudeFace();
    face.pet();
    const hearts = face.particles.particles.filter(p => p.style === 'heart');
    const sparkles = face.particles.particles.filter(p => p.style === 'sparkle');
    assert.strictEqual(hearts.length, 0);
    assert.ok(sparkles.length >= 15);
  });

  test('wiggle amplitude is 2 during pet spam', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    face.update(66);
    assert.ok(Math.abs(face.petWiggle) === 2);
  });

  test('deactivates after timer expires', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.petSpamActive);
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(!face.petSpamActive);
  });

  test('sets special thought text on activation', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.thoughtText.length > 0);
  });

  test('spawns continuous heart particles while active', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    // Run a few frames to trigger continuous spawning (every 3rd frame)
    for (let i = 0; i < 6; i++) face.update(66);
    const heartsAfter = face.particles.particles.filter(p => p.style === 'heart').length;
    assert.ok(heartsAfter > 0);
  });

  test('filters out old pet timestamps outside window', () => {
    const face = new ClaudeFace();
    face.petTimes = [Date.now() - 3000, Date.now() - 2500];
    face.pet();
    assert.strictEqual(face.petTimes.length, 1);
  });

  test('re-triggering during active spam extends timer', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 10; i++) face.update(66);
    face.pet();
    assert.ok(face.petSpamActive);
    assert.strictEqual(face.petSpamTimer, 45);
  });
});

// ====================================================================
// face.js -- pet spam escalation
// ====================================================================

describe('face.js -- pet spam escalation', () => {
  test('first trigger sets level 1', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
  });

  test('re-trigger within 10s escalates to level 2', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    // Let the spam timer expire → afterglow
    for (let i = 0; i < 50; i++) face.update(66);
    // Trigger again within 10s window
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 2);
  });

  test('third re-trigger reaches level 3', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 3);
  });

  test('level caps at 3', () => {
    const face = new ClaudeFace();
    for (let round = 0; round < 6; round++) {
      for (let i = 0; i < 8; i++) face.pet();
      for (let i = 0; i < 50; i++) face.update(66);
    }
    assert.ok(face.petSpamLevel <= 3);
  });

  test('level resets after 10s gap', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
    // Simulate 10s passing
    face.petSpamLastAt = Date.now() - 11000;
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1); // reset, not 2
  });

  test('level 3 thought cycling is faster (200ms interval)', () => {
    const face = new ClaudeFace();
    // Get to level 3
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 3);
    // At level 3, thoughts should cycle rapidly
    const thoughts = new Set();
    for (let i = 0; i < 30; i++) {
      face.update(66); // 66ms per frame
      thoughts.add(face.thoughtText);
    }
    // Should have seen multiple different thoughts in ~2 seconds
    assert.ok(thoughts.size > 1, 'level 3 thoughts should cycle rapidly');
  });

  test('eyes override to sparkle during L1-2 spam (even in error state)', () => {
    const face = new ClaudeFace();
    face.state = 'error'; // normally cross eyes
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.petSpamActive);
    const theme = face.getTheme();
    const eyeResult = face.getEyes(theme, 0);
    const sparkleEyes = eyes.sparkle(theme, 0);
    assert.deepStrictEqual(eyeResult, sparkleEyes);
  });

  test('eyes override to vibrate during L3 spam', () => {
    const face = new ClaudeFace();
    face.state = 'idle';
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 3);
    const theme = face.getTheme();
    const eyeResult = face.getEyes(theme, 0);
    const vibrateEyes = eyes.vibrate(theme, 0);
    assert.deepStrictEqual(eyeResult, vibrateEyes);
  });

  test('mouth override to wide at L1, grin at L2+', () => {
    const face = new ClaudeFace();
    face.state = 'error'; // normally frown
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 1);
    const theme = face.getTheme();
    assert.strictEqual(face.getMouth(theme, 0), mouths.wide());
    // Escalate to L2
    for (let i = 0; i < 50; i++) face.update(66);
    for (let i = 0; i < 8; i++) face.pet();
    assert.strictEqual(face.petSpamLevel, 2);
    assert.strictEqual(face.getMouth(theme, 0), mouths.grin());
  });
});

// ====================================================================
// face.js -- pet afterglow
// ====================================================================

describe('face.js -- pet afterglow', () => {
  test('afterglow activates when pet spam expires', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    // Run until spam timer expires (45 frames + 1 to trigger transition)
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(!face.petSpamActive);
    assert.ok(face.petAfterglowTimer > 0);
  });

  test('afterglow timer is 30 frames (~2s)', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    // Timer was set to 30 then decremented a few frames
    assert.ok(face.petAfterglowTimer > 0 && face.petAfterglowTimer <= 30);
  });

  test('afterglow overrides eyes to content', () => {
    const face = new ClaudeFace();
    face.state = 'coding'; // normally focused eyes
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    face.blinkFrame = -1;
    const theme = face.getTheme();
    const eyeResult = face.getEyes(theme, 0);
    const contentEyes = eyes.content(theme, 0);
    assert.deepStrictEqual(eyeResult, contentEyes);
  });

  test('afterglow overrides mouth to smile', () => {
    const face = new ClaudeFace();
    face.state = 'error'; // normally frown
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    const theme = face.getTheme();
    const mouthResult = face.getMouth(theme, 0);
    assert.strictEqual(mouthResult, mouths.smile());
  });

  test('afterglow shows calm thought text', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    const calmThoughts = ['...', 'mmmm', 'purrrr', 'so warm', '\u25e1\u25e1\u25e1'];
    assert.ok(calmThoughts.includes(face.thoughtText),
      `expected afterglow thought, got: "${face.thoughtText}"`);
  });

  test('afterglow spawns lazy hearts', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    // Clear existing hearts to isolate lazy ones
    face.particles.particles = face.particles.particles.filter(p => p.style !== 'heart');
    // Run 20+ frames to trigger lazy heart spawn (every 20th frame)
    for (let i = 0; i < 25; i++) face.update(66);
    const lazyHearts = face.particles.particles.filter(p => p.style === 'heart');
    assert.ok(lazyHearts.length >= 1, 'should spawn lazy hearts during afterglow');
  });

  test('afterglow fully expires back to normal', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    // Run through spam (45 frames) + afterglow (30 frames) + buffer
    for (let i = 0; i < 90; i++) face.update(66);
    assert.ok(!face.petSpamActive);
    assert.strictEqual(face.petAfterglowTimer, 0);
  });

  test('new pet spam cancels afterglow', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < 8; i++) face.pet();
    for (let i = 0; i < 50; i++) face.update(66);
    assert.ok(face.petAfterglowTimer > 0);
    // Trigger pet spam again during afterglow
    for (let i = 0; i < 8; i++) face.pet();
    assert.ok(face.petSpamActive);
    assert.strictEqual(face.petAfterglowTimer, 0);
  });
});

// ====================================================================
// face.js -- cycleTheme
// ====================================================================

describe('face.js -- cycleTheme()', () => {
  test('increments paletteIndex', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.paletteIndex, 0);
    face.cycleTheme();
    assert.strictEqual(face.paletteIndex, 1);
  });

  test('wraps around to 0', () => {
    const face = new ClaudeFace();
    for (let i = 0; i < PALETTES.length; i++) face.cycleTheme();
    assert.strictEqual(face.paletteIndex, 0);
  });

  test('getTheme returns different colors per palette', () => {
    const face = new ClaudeFace();
    face.state = 'idle';
    const defaultTheme = face.getTheme();
    face.cycleTheme(); // now neon
    const neonTheme = face.getTheme();
    const sameBorder = defaultTheme.border[0] === neonTheme.border[0] &&
                       defaultTheme.border[1] === neonTheme.border[1] &&
                       defaultTheme.border[2] === neonTheme.border[2];
    assert.ok(!sameBorder, 'neon theme should have different idle border colors');
  });

  test('getTimelineColors returns palette-specific colors', () => {
    const face = new ClaudeFace();
    const defColors = face.getTimelineColors();
    face.cycleTheme();
    const neonColors = face.getTimelineColors();
    assert.notDeepStrictEqual(defColors.idle, neonColors.idle);
  });
});

// ====================================================================
// face.js -- toggleStats / toggleHelp
// ====================================================================

describe('face.js -- toggleStats()', () => {
  test('starts true, toggles to false', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.showStats, true);
    face.toggleStats();
    assert.strictEqual(face.showStats, false);
  });

  test('double toggle returns to original', () => {
    const face = new ClaudeFace();
    face.toggleStats();
    face.toggleStats();
    assert.strictEqual(face.showStats, true);
  });
});

describe('face.js -- toggleHelp()', () => {
  test('starts false, toggles to true', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.showHelp, false);
    face.toggleHelp();
    assert.strictEqual(face.showHelp, true);
  });

  test('double toggle returns to original', () => {
    const face = new ClaudeFace();
    face.toggleHelp();
    face.toggleHelp();
    assert.strictEqual(face.showHelp, false);
  });
});

// ====================================================================
// grid.js -- FaceGrid theme/help
// ====================================================================

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

// ====================================================================
// accessories.js -- ACCESSORIES
// ====================================================================

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

  test('all accessories have at most 3 lines', () => {
    for (const [name, acc] of Object.entries(ACCESSORIES)) {
      assert.ok(acc.lines.length <= 3, `${name} should have at most 3 lines (has ${acc.lines.length})`);
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

// ====================================================================
// accessories.js -- STATE_ACCESSORIES
// ====================================================================

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

  test('reading maps to glasses', () => {
    assert.strictEqual(STATE_ACCESSORIES.reading, 'glasses');
  });

  test('thinking maps to wizardhat', () => {
    assert.strictEqual(STATE_ACCESSORIES.thinking, 'wizardhat');
  });

  test('coding maps to headphones', () => {
    assert.strictEqual(STATE_ACCESSORIES.coding, 'headphones');
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

// ====================================================================
// accessories.js -- getAccessory
// ====================================================================

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

// ====================================================================
// face.js -- accessories toggle
// ====================================================================

describe('face.js -- accessories', () => {
  test('accessoriesEnabled defaults to true', () => {
    const face = new ClaudeFace();
    assert.strictEqual(face.accessoriesEnabled, true);
  });

  test('toggleAccessories flips the flag', () => {
    const face = new ClaudeFace();
    face.toggleAccessories();
    assert.strictEqual(face.accessoriesEnabled, false);
    face.toggleAccessories();
    assert.strictEqual(face.accessoriesEnabled, true);
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
