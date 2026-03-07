#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - state-machine.js                         |
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
  stripAnsi,
  errorDetail,
  extractExitCode,
  isMergeConflict,
  classifyToolResult,
  MILESTONES,
  updateStreak,
  defaultStats,
  MAX_FREQUENT_FILES,
  pruneFrequentFiles,
  topFrequentFiles,
  buildSubagentSessionState,
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

  test('Bash with node test.js → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'node test.js' }).state, 'testing');
  });

  test('Bash with node --test → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'node --test src/' }).state, 'testing');
  });

  test('Bash with make test → testing', () => {
    assert.strictEqual(toolToState('Bash', { command: 'make test' }).state, 'testing');
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

  test('Bash with python train.py → training', () => {
    assert.strictEqual(toolToState('Bash', { command: 'python train.py' }).state, 'training');
  });

  test('Bash with torchrun → training', () => {
    assert.strictEqual(toolToState('Bash', { command: 'torchrun --nproc_per_node=4 train.py' }).state, 'training');
  });

  test('Bash with accelerate launch → training', () => {
    assert.strictEqual(toolToState('Bash', { command: 'accelerate launch train.py' }).state, 'training');
  });

  test('Bash with deepspeed → training', () => {
    assert.strictEqual(toolToState('Bash', { command: 'deepspeed train.py --epochs 10' }).state, 'training');
  });

  test('Bash with unsloth → training', () => {
    assert.strictEqual(toolToState('Bash', { command: 'unsloth finetune model' }).state, 'training');
  });

  test('Bash with --epochs flag → training', () => {
    assert.strictEqual(toolToState('Bash', { command: 'python main.py --epochs 100 --batch-size 32' }).state, 'training');
  });

  test('Bash with python finetune → training', () => {
    assert.strictEqual(toolToState('Bash', { command: 'python3 finetune.py --lr 0.001' }).state, 'training');
  });

  test('Bash with nohup train → training', () => {
    assert.strictEqual(toolToState('Bash', { command: 'nohup python train.py &' }).state, 'training');
  });

  test('Bash with plain python does not → training', () => {
    assert.notStrictEqual(toolToState('Bash', { command: 'python app.py' }).state, 'training');
  });

  test('torchrun --version does not → training', () => {
    assert.notStrictEqual(toolToState('Bash', { command: 'torchrun --version' }).state, 'training');
  });

  test('accelerate config does not → training', () => {
    assert.notStrictEqual(toolToState('Bash', { command: 'accelerate config' }).state, 'training');
  });

  test('python train_test_split.py does not → training', () => {
    assert.notStrictEqual(toolToState('Bash', { command: 'python train_test_split.py' }).state, 'training');
  });

  test('python eval.py --batch-size does not → training', () => {
    assert.notStrictEqual(toolToState('Bash', { command: 'python eval.py --batch-size 32' }).state, 'training');
  });

  test('Bash with git commit → committing', () => {
    const r = toolToState('Bash', { command: 'git commit -m "feat: add thing"' });
    assert.strictEqual(r.state, 'committing');
  });

  test('Bash with git push → committing (pushing to remote)', () => {
    const r = toolToState('Bash', { command: 'git push -u origin main' });
    assert.strictEqual(r.state, 'committing');
    assert.ok(r.detail.includes('push') || r.detail.includes('origin'), `detail should describe push, got: ${r.detail}`);
  });

  test('Bash with git tag → committing (tagging release)', () => {
    const r = toolToState('Bash', { command: 'git tag v1.2.0' });
    assert.strictEqual(r.state, 'committing');
  });

  test('git commit does not match git status', () => {
    const r = toolToState('Bash', { command: 'git status' });
    assert.notStrictEqual(r.state, 'committing');
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

  test('WebSearch → searching', () => {
    const r = toolToState('WebSearch', { query: 'node.js docs' });
    assert.strictEqual(r.state, 'searching');
    assert.ok(r.detail.includes('node.js docs'));
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

  test('detects "cargo error"', () => {
    assert.ok(looksLikeError('cargo error: could not compile `myproject`', stdoutErrorPatterns));
  });

  test('detects rustc compiler error', () => {
    assert.ok(looksLikeError('rustc error[E0308]: mismatched types', stdoutErrorPatterns));
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

  test('Read tool with stderr "error" → satisfied, not error (read-only gate)', () => {
    const r = classifyToolResult('Read', { file_path: '/src/errors.ts' }, { stderr: 'found error in output' }, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.notStrictEqual(r.state, 'error');
  });

  test('Grep tool with stderr "error" → satisfied, not error (read-only gate)', () => {
    const r = classifyToolResult('Grep', { pattern: 'error' }, { stderr: 'error pattern matched' }, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.notStrictEqual(r.state, 'error');
  });

  test('Bash tool with stderr "error" → still error (not gated)', () => {
    const r = classifyToolResult('Bash', { command: 'make' }, { stderr: 'fatal error occurred' }, false);
    assert.strictEqual(r.state, 'error');
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

  test('defaultStats session has commitCount field', () => {
    const s = defaultStats();
    assert.strictEqual(s.session.commitCount, 0);
  });
});

describe('state-machine.js -- isMergeConflict', () => {
  test('detects CONFLICT (content): in stdout', () => {
    assert.ok(isMergeConflict('CONFLICT (content): Merge conflict in src/app.js', ''));
  });

  test('detects CONFLICT (modify/delete): in stdout', () => {
    assert.ok(isMergeConflict('CONFLICT (modify/delete): file.txt deleted', ''));
  });

  test('detects "Automatic merge failed"', () => {
    assert.ok(isMergeConflict('', 'Automatic merge failed; fix conflicts and then commit the result.'));
  });

  test('detects "fix conflicts and then commit" in stdout', () => {
    assert.ok(isMergeConflict('fix conflicts and then commit the result.', ''));
  });

  test('clean merge does not trigger', () => {
    assert.ok(!isMergeConflict('Merge made by the recursive strategy.', ''));
  });

  test('empty strings do not trigger', () => {
    assert.ok(!isMergeConflict('', ''));
  });

  test('CONFLICT word alone does not trigger', () => {
    // Bare CONFLICT should not match isMergeConflict or looksLikeError (pattern requires git format)
    assert.ok(!isMergeConflict('CONFLICT without parens', ''));
    assert.ok(!looksLikeError('CONFLICT without parens', stdoutErrorPatterns));
  });
});

describe('state-machine.js -- classifyToolResult (CONFLICT false positive)', () => {
  test('bash test output containing bare CONFLICT does not trigger error', () => {
    const r = classifyToolResult('Bash',
      { command: 'npm test' },
      { stdout: 'PASS test/conflict-resolver.test.js\n  ✓ CONFLICT resolution works (5ms)\n\nTests: 1 passed, 1 total' },
      false);
    assert.notStrictEqual(r.state, 'error');
  });

  test('real git merge CONFLICT still triggers error via looksLikeError', () => {
    assert.ok(looksLikeError('CONFLICT (content): Merge conflict in foo.js', stdoutErrorPatterns));
  });

  test('successful git merge does not trigger error (Fix #94)', () => {
    assert.ok(!looksLikeError('Merge made by the recursive strategy.\n 3 files changed', stdoutErrorPatterns));
  });

  test('git already up to date does not trigger error (Fix #94)', () => {
    assert.ok(!looksLikeError('Already up to date.', stdoutErrorPatterns));
  });

  test('past-tense conflicts resolved does not trigger error (Fix #94)', () => {
    assert.ok(!looksLikeError('3 conflicts resolved, rebasing continues', stdoutErrorPatterns));
  });
});

describe('state-machine.js -- classifyToolResult (git operations)', () => {
  test('git push → proud with "pushed!"', () => {
    const r = classifyToolResult('Bash', { command: 'git push origin main' }, {}, false);
    assert.strictEqual(r.state, 'proud');
    assert.strictEqual(r.detail, 'pushed!');
  });

  test('git commit → proud with "committed"', () => {
    const r = classifyToolResult('Bash', { command: 'git commit -m "fix bug"' }, {}, false);
    assert.strictEqual(r.state, 'proud');
    assert.strictEqual(r.detail, 'committed');
  });

  test('git merge → satisfied with "merged clean"', () => {
    const r = classifyToolResult('Bash', { command: 'git merge feature-branch' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.strictEqual(r.detail, 'merged clean');
  });

  test('git pull → satisfied with "merged clean"', () => {
    const r = classifyToolResult('Bash', { command: 'git pull origin main' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.strictEqual(r.detail, 'merged clean');
  });

  test('git rebase → satisfied with "merged clean"', () => {
    const r = classifyToolResult('Bash', { command: 'git rebase main' }, {}, false);
    assert.strictEqual(r.state, 'satisfied');
    assert.strictEqual(r.detail, 'merged clean');
  });

  test('git status (generic) → relieved with "git done"', () => {
    const r = classifyToolResult('Bash', { command: 'git status' }, {}, false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, 'git done');
  });

  test('git merge with conflict stdout → error', () => {
    const r = classifyToolResult('Bash',
      { command: 'git merge feature' },
      { stdout: 'CONFLICT (content): Merge conflict in src/app.js\nAutomatic merge failed; fix conflicts and then commit the result.' },
      false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'merge conflict!');
  });

  test('git push with conflict in stderr → error', () => {
    const r = classifyToolResult('Bash',
      { command: 'git merge other' },
      { stderr: 'Automatic merge failed; fix conflicts and then commit the result.' },
      false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'merge conflict!');
  });
});

describe('state-machine.js -- looksLikeError (git merge conflicts)', () => {
  test('CONFLICT (content) in stdout triggers error', () => {
    assert.ok(looksLikeError('CONFLICT (content): Merge conflict in foo.js', stdoutErrorPatterns));
  });

  test('Automatic merge failed in stdout triggers error', () => {
    assert.ok(looksLikeError('Automatic merge failed; fix conflicts and then commit the result.', stdoutErrorPatterns));
  });

  test('"fix conflicts and then commit" triggers error', () => {
    assert.ok(looksLikeError('fix conflicts and then commit the result.', stdoutErrorPatterns));
  });

  test('"no conflicts" is a false positive', () => {
    assert.ok(!looksLikeError('Merge succeeded with no conflicts.', stdoutErrorPatterns));
  });
});

describe('state-machine.js -- classifyToolResult (rate-limit-like text falls through to error)', () => {
  test('Read tool with "throttle.js" content → satisfied (not error)', () => {
    const r = classifyToolResult('Read', { file_path: '/throttle.js' },
      { stdout: 'export function throttle(fn) { return fn; }' }, false);
    assert.strictEqual(r.state, 'satisfied');
  });

  test('Search results with "capacity" → satisfied (not error)', () => {
    const r = classifyToolResult('Grep', { pattern: 'capacity' },
      { stdout: 'disk capacity is at 80%' }, false);
    assert.strictEqual(r.state, 'satisfied');
  });

  test('Bash with rate limit + isError → error', () => {
    const r = classifyToolResult('Bash', { command: 'curl api' },
      { stdout: 'rate limit exceeded', isError: true }, true);
    assert.strictEqual(r.state, 'error');
  });

  test('successful Bash with rate-limit-like text → relieved (not error)', () => {
    const r = classifyToolResult('Bash', { command: 'echo test' },
      { stdout: 'implemented rate limit handling' }, false);
    assert.strictEqual(r.state, 'relieved');
  });

  test('Edit tool with rate-limit-like content → proud (not error)', () => {
    const r = classifyToolResult('Edit', { file_path: '/src/api.ts' },
      { stdout: 'added rate limit retry logic' }, false);
    assert.strictEqual(r.state, 'proud');
  });
});

// ================================================================
// pruneFrequentFiles
// ================================================================

describe('state-machine.js -- pruneFrequentFiles', () => {
  test('no-ops on empty object', () => {
    const ff = {};
    pruneFrequentFiles(ff);
    assert.deepStrictEqual(ff, {});
  });

  test('returns null/undefined unchanged', () => {
    assert.strictEqual(pruneFrequentFiles(null), null);
    assert.strictEqual(pruneFrequentFiles(undefined), undefined);
  });

  test('does not prune when under cap', () => {
    const ff = { 'a.js': 1, 'b.js': 5, 'c.js': 1, 'd.js': 3 };
    pruneFrequentFiles(ff);
    assert.strictEqual(Object.keys(ff).length, 4);
    assert.strictEqual(ff['a.js'], 1);
    assert.strictEqual(ff['b.js'], 5);
  });

  test('removes count < 2 entries when over cap', () => {
    const ff = {};
    for (let i = 0; i < 55; i++) {
      ff[`file${i}.js`] = i < 5 ? 1 : i + 2; // 5 entries with count=1
    }
    pruneFrequentFiles(ff);
    // count=1 entries should be filtered out
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(ff[`file${i}.js`], undefined);
    }
    assert.strictEqual(Object.keys(ff).length, MAX_FREQUENT_FILES);
  });

  test('caps at MAX_FREQUENT_FILES when over limit', () => {
    const ff = {};
    for (let i = 0; i < 100; i++) {
      ff[`file${i}.js`] = i + 2; // all count >= 2
    }
    pruneFrequentFiles(ff);
    assert.strictEqual(Object.keys(ff).length, MAX_FREQUENT_FILES);
  });

  test('keeps highest-count entries when pruning', () => {
    const ff = {};
    for (let i = 0; i < 60; i++) {
      ff[`file${i}.js`] = i + 2;
    }
    pruneFrequentFiles(ff);
    // file59.js (count=61) should survive, file0.js (count=2) should not
    assert.strictEqual(ff['file59.js'], 61);
    assert.strictEqual(ff['file0.js'], undefined);
  });

  test('under-cap object is not truncated', () => {
    const ff = {};
    for (let i = 0; i < 30; i++) {
      ff[`file${i}.js`] = i + 5;
    }
    pruneFrequentFiles(ff);
    assert.strictEqual(Object.keys(ff).length, 30);
  });

  test('mutates in-place and returns same reference', () => {
    const ff = { 'a.js': 1 };
    const result = pruneFrequentFiles(ff);
    assert.strictEqual(result, ff);
  });

  test('MAX_FREQUENT_FILES is 50', () => {
    assert.strictEqual(MAX_FREQUENT_FILES, 50);
  });
});

// ================================================================
// topFrequentFiles
// ================================================================

describe('state-machine.js -- topFrequentFiles', () => {
  test('returns empty object for null/undefined', () => {
    assert.deepStrictEqual(topFrequentFiles(null), {});
    assert.deepStrictEqual(topFrequentFiles(undefined), {});
  });

  test('filters entries below count 3', () => {
    const ff = { 'a.js': 1, 'b.js': 2, 'c.js': 3, 'd.js': 10 };
    const result = topFrequentFiles(ff);
    assert.strictEqual(result['a.js'], undefined);
    assert.strictEqual(result['b.js'], undefined);
    assert.strictEqual(result['c.js'], 3);
    assert.strictEqual(result['d.js'], 10);
  });

  test('caps at default limit of 10', () => {
    const ff = {};
    for (let i = 0; i < 50; i++) {
      ff[`file${i}.js`] = i + 3;
    }
    const result = topFrequentFiles(ff);
    assert.strictEqual(Object.keys(result).length, 10);
  });

  test('returns a new object (does not mutate input)', () => {
    const ff = { 'a.js': 5 };
    const result = topFrequentFiles(ff);
    assert.notStrictEqual(result, ff);
  });

  test('respects custom limit parameter', () => {
    const ff = { 'a.js': 5, 'b.js': 10, 'c.js': 3 };
    const result = topFrequentFiles(ff, 2);
    assert.strictEqual(Object.keys(result).length, 2);
    assert.strictEqual(result['b.js'], 10);
    assert.strictEqual(result['a.js'], 5);
  });

  test('returns empty object for empty input', () => {
    assert.deepStrictEqual(topFrequentFiles({}), {});
  });
});

// -- errorDetail direct unit tests ------------------------------------

describe('state-machine.js -- errorDetail', () => {
  test('detects merge conflict', () => {
    assert.strictEqual(errorDetail('CONFLICT (content): Merge conflict in foo.js', ''), 'merge conflict!');
  });

  test('detects command not found', () => {
    assert.strictEqual(errorDetail('bash: foo: command not found', ''), 'command not found');
  });

  test('detects permission denied', () => {
    assert.strictEqual(errorDetail('', 'Permission denied (publickey)'), 'permission denied');
  });

  test('detects file not found', () => {
    assert.strictEqual(errorDetail('No such file or directory: /tmp/missing', ''), 'file not found');
  });

  test('detects segfault', () => {
    assert.strictEqual(errorDetail('Segmentation fault (core dumped)', ''), 'segfault!');
  });

  test('detects ENOENT', () => {
    assert.strictEqual(errorDetail('', 'Error: ENOENT: no such file'), 'missing file/path');
  });

  test('detects syntax error', () => {
    assert.strictEqual(errorDetail('  File "x.py", line 5\n    syntax error near token', ''), 'syntax error');
  });

  test('detects traceback (Python)', () => {
    assert.strictEqual(errorDetail('Traceback (most recent call last):\n  File "x.py"', ''), 'exception thrown');
  });

  test('detects missing module', () => {
    assert.strictEqual(errorDetail('Cannot find module \'express\'', ''), 'missing module');
  });

  test('detects build failed', () => {
    assert.strictEqual(errorDetail('', 'Compilation failed with 3 errors'), 'build broke');
  });

  test('detects tests failed', () => {
    assert.strictEqual(errorDetail('5 tests failed', ''), 'tests failed');
  });

  test('detects npm error', () => {
    assert.strictEqual(errorDetail('npm ERR! code E404', ''), 'npm error');
  });

  test('falls back to something went wrong', () => {
    assert.strictEqual(errorDetail('some unknown output', 'some unknown error'), 'something went wrong');
  });

  test('handles empty inputs', () => {
    assert.strictEqual(errorDetail('', ''), 'something went wrong');
  });

  test('handles null/undefined inputs', () => {
    assert.strictEqual(errorDetail(null, null), 'something went wrong');
    assert.strictEqual(errorDetail(undefined, undefined), 'something went wrong');
  });
});

// -- extractExitCode edge cases ---------------------------------------

describe('state-machine.js -- extractExitCode edge cases', () => {
  test('parses "exited with 1"', () => {
    assert.strictEqual(extractExitCode('Process exited with 1'), 1);
  });

  test('parses "returned 42"', () => {
    assert.strictEqual(extractExitCode('Command returned 42'), 42);
  });

  test('parses "Exit code: 137"', () => {
    assert.strictEqual(extractExitCode('Exit code: 137'), 137);
  });

  test('parses "exit code=0" as 0', () => {
    assert.strictEqual(extractExitCode('exit code=0'), 0);
  });

  test('returns null when no match', () => {
    assert.strictEqual(extractExitCode('all good'), null);
  });

  test('returns null for empty string', () => {
    assert.strictEqual(extractExitCode(''), null);
  });

  test('takes first code when multiple present', () => {
    const result = extractExitCode('exited with 1 then exited with 2');
    assert.strictEqual(result, 1);
  });

  // Bug #11 — "return N" (source code) should not match; "returned N" still should
  test('"return 0" does NOT extract an exit code (source code false positive)', () => {
    assert.strictEqual(extractExitCode('return 0'), null);
  });

  test('"return 42" does NOT extract an exit code (source code false positive)', () => {
    assert.strictEqual(extractExitCode('return 42'), null);
  });

  test('"returned 1" still extracts exit code 1', () => {
    assert.strictEqual(extractExitCode('command returned 1'), 1);
  });

  test('"exit status: 1" extracts exit code 1', () => {
    assert.strictEqual(extractExitCode('exit status: 1'), 1);
  });
});

// -- looksLikeError — warning/error mixed output (Bug #3) -------------

describe('state-machine.js -- looksLikeError (warning+error mixed output)', () => {
  test('"2 warnings, 1 error: compilation failed" IS detected as error', () => {
    assert.ok(looksLikeError('2 warnings, 1 error: compilation failed', stderrErrorPatterns));
  });

  test('"1 warning, 1 error" IS detected as error', () => {
    assert.ok(looksLikeError('1 warning, 1 error', stderrErrorPatterns));
  });

  test('"warning: deprecated API" is NOT detected as error (pure warning)', () => {
    assert.ok(!looksLikeError('warning: deprecated API', stderrErrorPatterns));
  });

  test('"0 errors, 3 warnings" is NOT detected as error (zero errors)', () => {
    assert.ok(!looksLikeError('0 errors, 3 warnings', stderrErrorPatterns));
  });
});

// -- Sticky field preservation (update-state.js session file logic) --------

describe('state-machine.js -- sticky field preservation', () => {
  // Mirrors the STICKY_FIELDS loop from update-state.js
  const STICKY_FIELDS = ['taskDescription', 'parentSession', 'isTeammate', 'teamName', 'teammateName'];

  function preserveStickyFields(existing, extra) {
    for (const field of STICKY_FIELDS) {
      if (existing[field] && !extra[field]) {
        extra[field] = existing[field];
      }
    }
  }

  test('parentSession preserved when extra lacks it', () => {
    const existing = { parentSession: 'session-main' };
    const extra = {};
    preserveStickyFields(existing, extra);
    assert.strictEqual(extra.parentSession, 'session-main');
  });

  test('parentSession NOT overridden when extra explicitly sets it', () => {
    const existing = { parentSession: 'session-old' };
    const extra = { parentSession: 'session-new' };
    preserveStickyFields(existing, extra);
    assert.strictEqual(extra.parentSession, 'session-new');
  });

  test('isTeammate, teamName, teammateName preserved', () => {
    const existing = { isTeammate: true, teamName: 'alpha', teammateName: 'scout' };
    const extra = {};
    preserveStickyFields(existing, extra);
    assert.strictEqual(extra.isTeammate, true);
    assert.strictEqual(extra.teamName, 'alpha');
    assert.strictEqual(extra.teammateName, 'scout');
  });

  test('all sticky fields preserved in a single pass', () => {
    const existing = {
      taskDescription: 'fix bug',
      parentSession: 'sess-A',
      isTeammate: true,
      teamName: 'beta',
      teammateName: 'builder',
    };
    const extra = {};
    preserveStickyFields(existing, extra);
    for (const field of STICKY_FIELDS) {
      assert.strictEqual(extra[field], existing[field], `${field} should be preserved`);
    }
  });

  test('empty/falsy existing values not carried forward', () => {
    const existing = { parentSession: '', isTeammate: false, teamName: null, taskDescription: undefined };
    const extra = {};
    preserveStickyFields(existing, extra);
    assert.strictEqual(extra.parentSession, undefined, 'empty string should not be carried');
    assert.strictEqual(extra.isTeammate, undefined, 'false should not be carried');
    assert.strictEqual(extra.teamName, undefined, 'null should not be carried');
    assert.strictEqual(extra.taskDescription, undefined, 'undefined should not be carried');
  });
});

// -- Subagent tool state propagation (update-state.js logic) ----------------

describe('state-machine.js -- subagent tool state propagation', () => {
  test('preserves sticky fields from existing session', () => {
    const existing = {
      modelName: 'sonnet',
      cwd: '/repo',
      gitBranch: 'main',
      taskDescription: 'fix bug',
    };
    const sub = { id: 'sub-1', model: 'haiku', description: 'search code' };
    const result = buildSubagentSessionState(existing, sub, 'parent-sess', '/fallback');
    // state/detail are NOT in the return -- they're passed positionally to writeSessionState
    assert.strictEqual(result.modelName, 'sonnet'); // preserved from existing
    assert.strictEqual(result.taskDescription, 'fix bug'); // preserved from existing
    assert.strictEqual(result.parentSession, 'parent-sess');
    assert.strictEqual(result.cwd, '/repo');
  });

  test('returns null for stopped subagent session', () => {
    const existing = { stopped: true, modelName: 'haiku' };
    const sub = { id: 'sub-1', model: 'haiku', description: 'task' };
    const result = buildSubagentSessionState(existing, sub, 'parent', '/cwd');
    assert.strictEqual(result, null);
  });

  test('falls back to sub.model when existing has no modelName', () => {
    const result = buildSubagentSessionState({}, { id: 'sub-1', model: 'sonnet', description: 'task' }, 'parent', '/cwd');
    assert.strictEqual(result.modelName, 'sonnet');
  });

  test('falls back to "haiku" when neither existing nor sub has model', () => {
    const result = buildSubagentSessionState({}, { id: 'sub-1', description: 'task' }, 'parent', '/cwd');
    assert.strictEqual(result.modelName, 'haiku');
  });

  test('uses defaultCwd when existing has no cwd', () => {
    const result = buildSubagentSessionState({}, { id: 'sub-1', description: 'task' }, 'parent', '/my/cwd');
    assert.strictEqual(result.cwd, '/my/cwd');
  });

  test('taskDescription fallback: existing > sub.taskDescription > sub.description', () => {
    // existing.taskDescription wins
    const r1 = buildSubagentSessionState(
      { taskDescription: 'from-existing' },
      { id: 'sub-1', taskDescription: 'from-sub-task', description: 'from-sub-desc' },
      'p', '/cwd'
    );
    assert.strictEqual(r1.taskDescription, 'from-existing');

    // sub.taskDescription next
    const r2 = buildSubagentSessionState(
      {},
      { id: 'sub-1', taskDescription: 'from-sub-task', description: 'from-sub-desc' },
      'p', '/cwd'
    );
    assert.strictEqual(r2.taskDescription, 'from-sub-task');

    // sub.description last
    const r3 = buildSubagentSessionState(
      {},
      { id: 'sub-1', description: 'from-sub-desc' },
      'p', '/cwd'
    );
    assert.strictEqual(r3.taskDescription, 'from-sub-desc');
  });

  test('non-subagent tools should trigger propagation', () => {
    const normalTools = ['Edit', 'Read', 'Bash', 'Grep', 'Write', 'Glob'];
    for (const tool of normalTools) {
      assert.ok(!SUBAGENT_TOOLS.test(tool), `${tool} should NOT be a subagent tool`);
    }
  });

  test('subagent tools should NOT trigger propagation', () => {
    const subTools = ['Task', 'Subagent', 'spawn_agent', 'delegate', 'codex_agent', 'sessions'];
    for (const tool of subTools) {
      assert.ok(SUBAGENT_TOOLS.test(tool), `${tool} SHOULD be a subagent tool`);
    }
  });

  test('fresh subagent (empty existing) uses all fallbacks', () => {
    const sub = { id: 'sub-1', model: 'opus', taskDescription: 'fix tests', description: 'fallback desc' };
    const result = buildSubagentSessionState({}, sub, 'parent-1', '/default/cwd');
    assert.strictEqual(result.sessionId, 'sub-1');
    assert.strictEqual(result.modelName, 'opus');
    assert.strictEqual(result.cwd, '/default/cwd');
    assert.strictEqual(result.gitBranch, '');
    assert.strictEqual(result.taskDescription, 'fix tests');
    assert.strictEqual(result.parentSession, 'parent-1');
  });

  test('all output fields are present', () => {
    const result = buildSubagentSessionState({}, { id: 's1', description: 'd' }, 'p', '/c');
    const keys = Object.keys(result).sort();
    assert.deepStrictEqual(keys, ['cwd', 'gitBranch', 'modelName', 'parentSession', 'sessionId', 'taskDescription']);
  });
});

// ================================================================
// stripAnsi
// ================================================================

describe('state-machine.js -- stripAnsi', () => {
  test('strips color codes', () => {
    assert.strictEqual(stripAnsi('\x1b[31m3 failed\x1b[0m'), '3 failed');
  });

  test('strips bold/reset codes', () => {
    assert.strictEqual(stripAnsi('\x1b[1mBOLD\x1b[0m'), 'BOLD');
  });

  test('strips compound codes (e.g. 38;5;196)', () => {
    assert.strictEqual(stripAnsi('\x1b[38;5;196mred\x1b[0m'), 'red');
  });

  test('returns empty string for null/undefined', () => {
    assert.strictEqual(stripAnsi(null), '');
    assert.strictEqual(stripAnsi(undefined), '');
  });

  test('passes through plain text unchanged', () => {
    assert.strictEqual(stripAnsi('hello world'), 'hello world');
  });
});

// ================================================================
// ANSI-aware error detection (Bug: "3 failed" with ANSI codes)
// ================================================================

describe('state-machine.js -- looksLikeError (ANSI + numeric failure patterns)', () => {
  test('"3 failed" detected as error', () => {
    assert.ok(looksLikeError('3 failed, 42 passed', stdoutErrorPatterns));
  });

  test('"3 failing" detected as error (mocha format)', () => {
    assert.ok(looksLikeError('3 failing', stdoutErrorPatterns));
  });

  test('ANSI-wrapped "3 failed" detected as error', () => {
    assert.ok(looksLikeError('\x1b[31m3 failed\x1b[0m, 42 passed', stdoutErrorPatterns));
  });

  test('"FAIL\\t..." (Go test output) detected as error', () => {
    assert.ok(looksLikeError('FAIL\tgithub.com/pkg/foo\t0.5s', stdoutErrorPatterns));
  });

  test('"# fail 3" (TAP format) detected as error', () => {
    assert.ok(looksLikeError('# fail 3', stdoutErrorPatterns));
  });

  test('"# fail 0" (TAP format, all passed) is NOT an error', () => {
    assert.ok(!looksLikeError('# fail 0', stdoutErrorPatterns));
  });

  test('ANSI-wrapped "3 failing" detected as error (mocha)', () => {
    assert.ok(looksLikeError('\x1b[31m3 failing\x1b[0m', stdoutErrorPatterns));
  });

  test('ANSI-wrapped "0 failing" is NOT an error', () => {
    assert.ok(!looksLikeError('\x1b[32m0 failing\x1b[0m', stdoutErrorPatterns));
  });

  test('ANSI-wrapped Go "FAIL" detected as error', () => {
    assert.ok(looksLikeError('\x1b[31mFAIL\x1b[0m\tgithub.com/pkg/foo\t0.5s', stdoutErrorPatterns));
  });

  test('ANSI-wrapped TAP "# fail 3" detected as error', () => {
    assert.ok(looksLikeError('\x1b[31m# fail 3\x1b[0m', stdoutErrorPatterns));
  });

  test('"0 failed" is NOT an error (false positive guard)', () => {
    assert.ok(!looksLikeError('0 failed, 42 passed', stdoutErrorPatterns));
  });

  test('ANSI-wrapped "0 failed" is NOT an error', () => {
    assert.ok(!looksLikeError('\x1b[32m0 failed\x1b[0m, 42 passed', stdoutErrorPatterns));
  });
});

describe('state-machine.js -- classifyToolResult (ANSI test failure detection)', () => {
  test('npm test with "3 failed" in stdout → error', () => {
    const r = classifyToolResult('Bash',
      { command: 'npm test' },
      { stdout: '3 failed, 42 passed' },
      false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'tests failed');
  });

  test('npm test with ANSI "3 failed" in stdout → error', () => {
    const r = classifyToolResult('Bash',
      { command: 'npm test' },
      { stdout: '\x1b[31m3 failed\x1b[0m, 42 passed' },
      false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'tests failed');
  });

  test('npm test with "0 failed" in stdout → relieved (not error)', () => {
    const r = classifyToolResult('Bash',
      { command: 'npm test' },
      { stdout: '0 failed, 42 passed' },
      false);
    assert.strictEqual(r.state, 'relieved');
    assert.ok(r.detail.includes('tests passed'));
  });

  test('npm test with "3 failing" (mocha) → error with "tests failed"', () => {
    const r = classifyToolResult('Bash',
      { command: 'npm test' },
      { stdout: '3 failing' },
      false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'tests failed');
  });

  test('Go "FAIL\\t..." in stdout → error with "tests failed"', () => {
    const r = classifyToolResult('Bash',
      { command: 'go test ./...' },
      { stdout: 'FAIL\tgithub.com/pkg/foo\t0.5s' },
      false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'tests failed');
  });

  test('ANSI-wrapped test count extracted on success path', () => {
    const r = classifyToolResult('Bash',
      { command: 'npm test' },
      { stdout: '\x1b[32m42 tests passed\x1b[0m' },
      false);
    assert.strictEqual(r.state, 'relieved');
    assert.strictEqual(r.detail, '42 tests passed');
  });

  test('ANSI-wrapped merge conflict detected through classifyToolResult', () => {
    const r = classifyToolResult('Bash',
      { command: 'git merge feature' },
      { stdout: '\x1b[31mCONFLICT (content):\x1b[0m Merge conflict in foo.js' },
      false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'merge conflict!');
  });
});

describe('state-machine.js -- errorDetail (ANSI-aware)', () => {
  test('ANSI-wrapped "3 failed" → "tests failed"', () => {
    assert.strictEqual(errorDetail('\x1b[31m3 failed\x1b[0m, 42 passed', ''), 'tests failed');
  });

  test('ANSI-wrapped "build failed" → "build broke"', () => {
    assert.strictEqual(errorDetail('\x1b[31mbuild failed\x1b[0m', ''), 'build broke');
  });

  test('ANSI-wrapped "Error:" in stdout → "exception thrown"', () => {
    assert.strictEqual(errorDetail('\x1b[31mError:\x1b[0m something broke', ''), 'exception thrown');
  });

  test('"Error:" in stderr also triggers "exception thrown"', () => {
    assert.strictEqual(errorDetail('', '\x1b[31mError:\x1b[0m stack trace here'), 'exception thrown');
  });

  test('"3 failing" (mocha) → "tests failed"', () => {
    assert.strictEqual(errorDetail('3 failing', ''), 'tests failed');
  });

  test('Go "FAIL\\t..." → "tests failed"', () => {
    assert.strictEqual(errorDetail('FAIL\tgithub.com/pkg/foo\t0.5s', ''), 'tests failed');
  });

  test('TAP "# fail 3" → "tests failed"', () => {
    assert.strictEqual(errorDetail('# fail 3', ''), 'tests failed');
  });

  test('"ModuleNotFoundError: foo" → "missing module" (not "exception thrown")', () => {
    assert.strictEqual(errorDetail('ModuleNotFoundError: foo', ''), 'missing module');
  });
});

describe('state-machine.js -- isMergeConflict (ANSI-aware)', () => {
  test('ANSI-wrapped "CONFLICT (content):" detected', () => {
    assert.ok(isMergeConflict('\x1b[31mCONFLICT (content):\x1b[0m Merge conflict in foo.js', ''));
  });

  test('ANSI-wrapped "Automatic merge failed" detected', () => {
    assert.ok(isMergeConflict('', '\x1b[31mAutomatic merge failed\x1b[0m'));
  });
});

describe('state-machine.js -- extractExitCode (ANSI-aware)', () => {
  test('ANSI-wrapped "Exit code: 1" → 1', () => {
    assert.strictEqual(extractExitCode('\x1b[31mExit code: 1\x1b[0m'), 1);
  });
});

// -- Bug #111: activeSubagents cleanup timeout (Bug D) --

describe('update-state.js -- activeSubagents cleanup uses 10-minute timeout (Bug D)', () => {
  test('cleanup timeout is 600000ms (10 minutes), not 180000ms (3 minutes)', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    assert.ok(
      src.includes('sub => Date.now() - sub.startedAt < 600000'),
      'activeSubagents cleanup should use 600000ms (10 min) timeout'
    );
    assert.ok(
      !src.includes('sub => Date.now() - sub.startedAt < 180000'),
      'activeSubagents cleanup should NOT use 180000ms (3 min) timeout'
    );
  });
});

// -- Bug #111: Fallback SubagentStart creates orbital session file (Bug E) --

describe('update-state.js -- fallback SubagentStart creates orbital (Bug E)', () => {
  test('fallback SubagentStart path writes a session file', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    // The fallback handler for SubagentStart should call writeSessionState
    // to create the orbital session file even when stdin is malformed
    assert.ok(
      src.includes("} else if (hookEvent === 'SubagentStart')"),
      'update-state.js should have a fallback handler for SubagentStart'
    );
    // Verify it calls writeSessionState in that block
    const subagentStartBlock = src.split("} else if (hookEvent === 'SubagentStart')")[1];
    assert.ok(subagentStartBlock,
      'SubagentStart fallback block should exist');
    // The writeSessionState call should come before the next else-if
    const blockContent = subagentStartBlock.split('} else if')[0];
    assert.ok(
      blockContent.includes('writeSessionState(subId,'),
      'fallback SubagentStart should call writeSessionState to create orbital file'
    );
  });

  test('fallback SubagentStart includes parentSession and taskDescription', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    const subagentStartBlock = src.split("} else if (hookEvent === 'SubagentStart')")[1];
    const blockContent = subagentStartBlock.split('} else if')[0];
    assert.ok(blockContent.includes('parentSession:'),
      'fallback SubagentStart should include parentSession in session data');
    assert.ok(blockContent.includes('taskDescription:'),
      'fallback SubagentStart should include taskDescription in session data');
  });
});

// -- Bug fix: Stop no longer kills background subagents (Bug #1) --

describe('update-state.js -- Stop handler does not kill active subagents (Bug #1)', () => {
  test('Stop handler does not write stopped:true to subagent sessions', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    // Find the Stop handler block
    const stopBlock = src.split("hookEvent === 'Stop'")[1];
    const stopContent = stopBlock.split("else if (hookEvent ===")[0];
    // Should NOT contain the bulk subagent cleanup loop
    assert.ok(
      !stopContent.includes("for (const sub of stats.session.activeSubagents)"),
      'Stop handler must not iterate activeSubagents to write stopped sessions'
    );
    assert.ok(
      !stopContent.includes("stats.session.activeSubagents = []"),
      'Stop handler must not clear activeSubagents array'
    );
  });

  test('SessionEnd handler still cleans up active subagents', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    // Find the SessionEnd handler block
    const sessionEndBlock = src.split("hookEvent === 'SessionEnd'")[1];
    const sessionEndContent = sessionEndBlock.split("else {")[0];
    assert.ok(
      sessionEndContent.includes("for (const sub of stats.session.activeSubagents)"),
      'SessionEnd handler must iterate activeSubagents to clean up'
    );
    assert.ok(
      sessionEndContent.includes("stats.session.activeSubagents = []"),
      'SessionEnd handler must clear activeSubagents array'
    );
  });
});

// -- Bug fix: mtime touch for earlier subagents (Bug #3) --

describe('update-state.js -- touch earlier subagent files (Bug #3)', () => {
  test('_touchEarlierSubagents helper exists', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    assert.ok(
      src.includes('function _touchEarlierSubagents('),
      'should define _touchEarlierSubagents helper'
    );
  });

  test('PreToolUse calls _touchEarlierSubagents after _writeSubagentToolState', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    // Find PreToolUse block
    const preBlock = src.split("hookEvent === 'PreToolUse'")[1];
    const preContent = preBlock.split("hookEvent === 'PostToolUse'")[0];
    const writeIdx = preContent.indexOf('_writeSubagentToolState(latest');
    const touchIdx = preContent.indexOf('_touchEarlierSubagents(');
    assert.ok(writeIdx >= 0, 'PreToolUse should call _writeSubagentToolState');
    assert.ok(touchIdx >= 0, 'PreToolUse should call _touchEarlierSubagents');
    assert.ok(touchIdx > writeIdx, '_touchEarlierSubagents should come after _writeSubagentToolState');
  });

  test('PostToolUse calls _touchEarlierSubagents after _writeSubagentToolState', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    // Find PostToolUse block
    const postBlock = src.split("hookEvent === 'PostToolUse'")[1];
    const postContent = postBlock.split("hookEvent === 'Stop'")[0];
    const writeIdx = postContent.indexOf('_writeSubagentToolState(latest');
    const touchIdx = postContent.indexOf('_touchEarlierSubagents(');
    assert.ok(writeIdx >= 0, 'PostToolUse should call _writeSubagentToolState');
    assert.ok(touchIdx >= 0, 'PostToolUse should call _touchEarlierSubagents');
    assert.ok(touchIdx > writeIdx, '_touchEarlierSubagents should come after _writeSubagentToolState');
  });

  test('_touchEarlierSubagents uses fs.utimesSync', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'update-state.js'), 'utf8'
    );
    const helperStart = src.indexOf('function _touchEarlierSubagents(');
    const helperEnd = src.indexOf('\n\n', helperStart);
    const helperBody = src.slice(helperStart, helperEnd);
    assert.ok(helperBody.includes('fs.utimesSync'), 'should use fs.utimesSync to refresh mtime');
    assert.ok(helperBody.includes('length - 1'), 'should iterate up to length - 1 (skip latest)');
  });
});

module.exports = { passed: () => passed, failed: () => failed };
