#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Test Suite - state-machine.js                      |
// +================================================================+

const assert = require('assert');
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
} = require('../state-machine');

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
    assert.strictEqual(stats.recentMilestone.value, 10);
  });

  test('no milestone at 9', () => {
    const stats = defaultStats();
    for (let i = 0; i < 9; i++) updateStreak(stats, false);
    assert.strictEqual(stats.recentMilestone, null);
  });
});

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

module.exports = { passed: () => passed, failed: () => failed };
