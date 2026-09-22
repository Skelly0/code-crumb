#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - state-machine.js                      |
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
  REVIEW_TOOLS,
  stdoutErrorPatterns,
  stderrErrorPatterns,
  falsePositives,
  looksLikeError,
  stripAnsi,
  errorDetail,
  extractExitCode,
  isMergeConflict,
  classifyToolResult,
  diffFromPatch,
  diffFromInput,
  normalizeToolResponse,
  classifyTruncatedInput,
  MILESTONES,
  updateStreak,
  defaultStats,
  MAX_FREQUENT_FILES,
  pruneFrequentFiles,
  topFrequentFiles,
  buildSubagentSessionState,
  classifyForeignSession,
  pruneTopLevelSessions,
  TOP_LEVEL_REGISTRY_MAX,
  TOP_LEVEL_REGISTRY_TTL_MS,
  prettyModelName,
  agentTranscriptPath,
} = require('../state-machine');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;

// -- update-state.js subprocess helpers -------------------------------
// The hook's bookkeeping -- stats counters, orbital files, synthetic
// retirement, the catch path -- has no in-process entry point, so the blocks
// below run the real script against a throwaway home and read what it wrote.

const fsMod = require('fs');
const pathMod = require('path');
const { execFileSync } = require('child_process');
const { makeTempEnv, cleanup, readJSON } = require('./_harness');

const UPDATE_STATE = pathMod.join(__dirname, '..', 'update-state.js');

// Raw stdin. '' is not JSON, so the hook falls into its catch path -- that is
// the only way to reach the fallback handlers.
function runUpdateStateRaw(event, input, env) {
  try {
    execFileSync(process.execPath, [UPDATE_STATE, event], {
      input, env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (e.status !== 0 && e.status !== null) throw e;
  }
}

function runUpdateState(event, inputObj, env) {
  runUpdateStateRaw(event, JSON.stringify(inputObj), env);
}

// Stats blob for an owner session conducting one subagent.
function conductingStats(ownerId, subId, subStartedAt, topLevelSessions = {}) {
  return {
    streak: 0, bestStreak: 0, brokenStreak: 0, brokenStreakAt: 0,
    totalToolCalls: 5, totalErrors: 0,
    records: { longestSession: 0, mostSubagents: 1, mostFilesEdited: 0 },
    session: {
      id: ownerId, start: Date.now() - 60000, toolCalls: 5, filesEdited: [],
      subagentCount: 1, commitCount: 0,
      activeSubagents: [{
        id: subId, description: 'real task', taskDescription: 'real task',
        model: 'haiku', editor: 'claude', startedAt: subStartedAt,
      }],
    },
    recentMilestone: null,
    daily: { date: new Date().toISOString().slice(0, 10), sessionCount: 1, cumulativeMs: 0 },
    frequentFiles: {},
    topLevelSessions,
  };
}

function seedSyntheticOrbital(sessionsDir, subId, ownerId, over = {}) {
  fsMod.mkdirSync(sessionsDir, { recursive: true });
  fsMod.writeFileSync(pathMod.join(sessionsDir, `${subId}.json`), JSON.stringify({
    session_id: subId, state: 'spawning', detail: 'real task',
    timestamp: Date.now(), stopped: false,
    parentSession: ownerId, taskDescription: 'real task', modelName: 'haiku',
    ...over,
  }), 'utf8');
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

  test('MCP tool → state by verb, with "server: tool" detail', () => {
    const r = toolToState('mcp__github__list_repos', {});
    assert.strictEqual(r.state, 'reading');
    assert.strictEqual(r.detail, 'github: list repos');
  });

  test('MCP tool with no tool part', () => {
    const r = toolToState('mcp__server', {});
    assert.strictEqual(r.state, 'executing');
    assert.strictEqual(r.detail, 'server: ');
  });

  test('Unknown tool → thinking with humanized name', () => {
    const r = toolToState('SomeNewTool', {});
    assert.strictEqual(r.state, 'thinking');
    assert.strictEqual(r.detail, 'some new tool');
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
    for (const t of ['task', 'agent', 'subagent', 'spawn_agent', 'delegate', 'codex_agent', 'sessions']) {
      assert.ok(SUBAGENT_TOOLS.test(t), `SUBAGENT_TOOLS should match "${t}"`);
    }
  });

  test('toolToState("Agent") returns subagent state', () => {
    const r = toolToState('Agent', { description: 'fix tests' });
    assert.strictEqual(r.state, 'subagent');
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

  // Updated: the bare "returned N" form was the bug ("Search returned 12 results")
  test('"returned 2" is not an exit code', () => {
    assert.strictEqual(extractExitCode('command returned 2'), null);
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

describe('state-machine.js -- diffFromPatch', () => {
  test('counts added and removed lines in one hunk', () => {
    assert.deepStrictEqual(diffFromPatch([{ lines: ['-a', '-b', '+c', ' ctx'] }]), { added: 1, removed: 2 });
  });

  test('sums across two hunks', () => {
    assert.deepStrictEqual(diffFromPatch([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, lines: [' x', '-y'] },
      { oldStart: 9, oldLines: 1, newStart: 8, newLines: 3, lines: [' z', '+p', '+q'] },
    ]), { added: 2, removed: 1 });
  });

  test('a context-only hunk → zero counts, not null', () => {
    assert.deepStrictEqual(diffFromPatch([{ lines: [' a', ' b'] }]), { added: 0, removed: 0 });
  });

  test('empty array → null', () => {
    assert.strictEqual(diffFromPatch([]), null);
  });

  test('null → null', () => {
    assert.strictEqual(diffFromPatch(null), null);
  });

  test('non-array → null', () => {
    assert.strictEqual(diffFromPatch('nope'), null);
  });

  test('hunk without lines → null', () => {
    assert.strictEqual(diffFromPatch([{}]), null);
  });

  test('hunk whose lines are not an array → null', () => {
    assert.strictEqual(diffFromPatch([{ lines: 'nope' }]), null);
  });

  test('non-string entries inside a hunk are skipped', () => {
    assert.deepStrictEqual(diffFromPatch([{ lines: ['+a', null, 42, '-b'] }]), { added: 1, removed: 1 });
  });

  test('"+++"-prefixed lines still count (hunks carry no file headers)', () => {
    assert.deepStrictEqual(diffFromPatch([{ lines: ['+++ b/a.js', '--- a/a.js'] }]), { added: 1, removed: 1 });
  });
});

describe('state-machine.js -- diffFromInput (fallback)', () => {
  test('counts old_string / new_string lines', () => {
    assert.deepStrictEqual(diffFromInput({ old_string: 'x\ny', new_string: 'x\nz' }), { added: 2, removed: 2 });
  });

  test('accepts the old_str / new_str spelling', () => {
    assert.deepStrictEqual(diffFromInput({ old_str: 'a', new_str: 'b\nc' }), { added: 2, removed: 1 });
  });

  test('Write content counts as added lines', () => {
    assert.deepStrictEqual(diffFromInput({ content: 'a\nb\nc' }), { added: 3, removed: 0 });
  });

  test('NotebookEdit new_source counts as added lines', () => {
    assert.deepStrictEqual(diffFromInput({ new_source: 'a\nb\nc' }), { added: 3, removed: 0 });
  });

  test('MultiEdit sums its edits', () => {
    assert.deepStrictEqual(diffFromInput({
      edits: [
        { old_string: 'a', new_string: 'b\nc' },
        { old_string: 'd\ne', new_string: 'f' },
      ],
    }), { added: 3, removed: 3 });
  });

  test('MultiEdit with junk entries does not throw', () => {
    assert.deepStrictEqual(diffFromInput({ edits: [null, { old_string: 'a' }] }), { added: 0, removed: 1 });
  });

  test('empty edits array → null', () => {
    assert.strictEqual(diffFromInput({ edits: [] }), null);
  });

  test('nothing to count → null', () => {
    assert.strictEqual(diffFromInput({ file_path: '/a.js' }), null);
  });
});

describe('state-machine.js -- exact diff counts from structuredPatch', () => {
  test('a patch beats the input-based estimate', () => {
    const r = classifyToolResult('Edit', {
      file_path: 'a.js', old_string: 'x\ny', new_string: 'x\nz',
    }, {
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' x', '-y', '+z'] }],
    }, false);
    assert.strictEqual(r.state, 'proud');
    assert.deepStrictEqual(r.diffInfo, { added: 1, removed: 1 });
  });

  test('without a patch the input fallback is unchanged', () => {
    const r = classifyToolResult('Edit', {
      file_path: 'a.js', old_string: 'x\ny', new_string: 'x\nz',
    }, {}, false);
    assert.deepStrictEqual(r.diffInfo, { added: 2, removed: 2 });
  });

  test('a malformed patch falls back to the inputs', () => {
    const r = classifyToolResult('Edit', {
      file_path: 'a.js', old_string: 'x\ny', new_string: 'x\nz',
    }, { structuredPatch: [{}] }, false);
    assert.deepStrictEqual(r.diffInfo, { added: 2, removed: 2 });
  });

  test('MultiEdit without a patch sums its edits', () => {
    const r = classifyToolResult('MultiEdit', {
      file_path: 'a.js',
      edits: [
        { old_string: 'a', new_string: 'b\nc' },
        { old_string: 'd\ne', new_string: 'f' },
      ],
    }, {}, false);
    assert.strictEqual(r.state, 'proud');
    assert.deepStrictEqual(r.diffInfo, { added: 3, removed: 3 });
  });

  test('MultiEdit with a patch uses the patch', () => {
    const r = classifyToolResult('MultiEdit', {
      file_path: 'a.js',
      edits: [{ old_string: 'a', new_string: 'b\nc' }],
    }, { structuredPatch: [{ lines: ['-a', '+b', '+c'] }] }, false);
    assert.deepStrictEqual(r.diffInfo, { added: 2, removed: 1 });
  });

  test('NotebookEdit new_source is counted (used to be null)', () => {
    const r = classifyToolResult('NotebookEdit', {
      notebook_path: '/nb.ipynb', new_source: 'a\nb\nc',
    }, {}, false);
    assert.strictEqual(r.state, 'proud');
    assert.deepStrictEqual(r.diffInfo, { added: 3, removed: 0 });
  });

  test('a deletion-only patch reports removals only', () => {
    const r = classifyToolResult('Edit', {
      file_path: 'a.js', old_string: 'x\ny\nz', new_string: 'x',
    }, { structuredPatch: [{ lines: [' x', '-y', '-z'] }] }, false);
    assert.deepStrictEqual(r.diffInfo, { added: 0, removed: 2 });
  });

  test('normalizeToolResponse carries a structuredPatch array through', () => {
    const r = normalizeToolResponse({ tool_response: { structuredPatch: [{ lines: ['+x'] }], stdout: '' } });
    assert.ok(Array.isArray(r.structuredPatch));
    assert.strictEqual(r.structuredPatch[0].lines[0], '+x');
  });

  test('normalizeToolResponse drops a non-array structuredPatch', () => {
    assert.strictEqual(normalizeToolResponse({ tool_response: { structuredPatch: 'junk' } }).structuredPatch, undefined);
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

  // Updated: "returned N" is program output, not an exit status
  test('does not parse "returned 42"', () => {
    assert.strictEqual(extractExitCode('Command returned 42'), null);
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

  // Bug #11 — "return N" (source code) should not match; neither, now, does "returned N"
  test('"return 0" does NOT extract an exit code (source code false positive)', () => {
    assert.strictEqual(extractExitCode('return 0'), null);
  });

  test('"return 42" does NOT extract an exit code (source code false positive)', () => {
    assert.strictEqual(extractExitCode('return 42'), null);
  });

  // Updated: this pinned the "returned N" form that misread program output
  test('"returned 1" no longer extracts an exit code', () => {
    assert.strictEqual(extractExitCode('command returned 1'), null);
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

// -- looksLikeError — per-line warning isolation --------------------------

describe('state-machine.js -- looksLikeError (per-line warning isolation)', () => {
  test('DeprecationWarning on separate line from "tests failed" IS detected', () => {
    assert.ok(looksLikeError(
      '(node:12345) DeprecationWarning: punycode is deprecated\nok 1400 tests\n3 tests failed',
      stdoutErrorPatterns
    ));
  });

  test('ExperimentalWarning on separate line from "FAIL" IS detected', () => {
    assert.ok(looksLikeError(
      '(node:999) ExperimentalWarning: VM Modules\nFAIL src/test.js',
      stdoutErrorPatterns
    ));
  });

  test('warning on separate line from "command not found" IS detected (stderr)', () => {
    assert.ok(looksLikeError(
      'warning: deprecated config\nfatal: command not found',
      stderrErrorPatterns
    ));
  });

  test('"failed with warning about X" on same line is NOT detected (preserved)', () => {
    assert.ok(!looksLikeError('failed with warning about deprecated API', stderrErrorPatterns));
  });

  test('"0 errors, 5 warnings" multi-line still NOT detected', () => {
    assert.ok(!looksLikeError('0 errors, 5 warnings\nBuild complete', stderrErrorPatterns));
  });

  test('npm ERR! on separate line from DeprecationWarning IS detected', () => {
    assert.ok(looksLikeError(
      '(node:123) DeprecationWarning: old API\nnpm ERR! code ELIFECYCLE',
      stdoutErrorPatterns
    ));
  });
});

// -- normalizeToolResponse -------------------------------------------------

describe('state-machine.js -- normalizeToolResponse', () => {
  test('reads tool_result string (Claude Code format)', () => {
    const r = normalizeToolResponse({ tool_result: 'hello world\nExit code: 0' });
    assert.strictEqual(r.stdout, 'hello world\nExit code: 0');
    assert.strictEqual(r.stderr, '');
  });

  test('reads tool_result object with stdout/stderr', () => {
    const r = normalizeToolResponse({ tool_result: { stdout: 'ok', stderr: 'warn' } });
    assert.strictEqual(r.stdout, 'ok');
    assert.strictEqual(r.stderr, 'warn');
  });

  test('falls back to tool_response when tool_result missing', () => {
    const r = normalizeToolResponse({ tool_response: { stdout: 'fallback', stderr: '' } });
    assert.strictEqual(r.stdout, 'fallback');
  });

  test('tool_result takes precedence over tool_response', () => {
    const r = normalizeToolResponse({
      tool_result: 'from result',
      tool_response: { stdout: 'from response' },
    });
    assert.strictEqual(r.stdout, 'from result');
  });

  test('handles content block array', () => {
    const r = normalizeToolResponse({
      tool_result: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ],
    });
    assert.strictEqual(r.stdout, 'line 1\nline 2');
    assert.strictEqual(r.stderr, '');
  });

  test('returns {stdout:"", stderr:""} when both missing', () => {
    const r = normalizeToolResponse({});
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(r.stderr, '');
  });

  test('classifyToolResult detects error via tool_result string with exit code', () => {
    const data = { tool_result: 'lots of test output\nExit code: 1' };
    const toolResponse = normalizeToolResponse(data);
    const result = classifyToolResult('Bash', { command: 'npm test' }, toolResponse, false);
    assert.strictEqual(result.state, 'error');
  });

  test('classifyToolResult detects "tests passed" from tool_result string', () => {
    const data = { tool_result: '42 tests passed\nExit code: 0' };
    const toolResponse = normalizeToolResponse(data);
    const result = classifyToolResult('Bash', { command: 'npm test' }, toolResponse, false);
    assert.strictEqual(result.state, 'relieved');
    assert.ok(result.detail.includes('42'));
  });
});

// -- classifyTruncatedInput -----------------------------------------------

describe('state-machine.js -- classifyTruncatedInput', () => {
  test('PostToolUseFailure always returns error', () => {
    const r = classifyTruncatedInput('PostToolUseFailure', '');
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'tool failed');
  });

  test('PostToolUse with isError flag returns error', () => {
    const r = classifyTruncatedInput('PostToolUse', '{"tool_name":"Bash","isError": true,"tool_response":{"stdout":"stuff...');
    assert.strictEqual(r.state, 'error');
  });

  test('PostToolUse with Exit code: 1 returns error', () => {
    const r = classifyTruncatedInput('PostToolUse', '{"tool_name":"Bash","tool_response":{"stdout":"...lots of output...\\nExit code: 1"}}');
    assert.strictEqual(r.state, 'error');
  });

  test('PostToolUse with Exit code: 0 does NOT return error', () => {
    const r = classifyTruncatedInput('PostToolUse', '{"tool_name":"Bash","tool_response":{"stdout":"...output...\\nExit code: 0"}}');
    assert.notStrictEqual(r.state, 'error');
  });

  test('PostToolUse with Bash tool + npm ERR! returns error', () => {
    const r = classifyTruncatedInput('PostToolUse', '{"tool_name":"Bash","tool_response":{"stdout":"npm ERR! code ELIFECYCLE...');
    assert.strictEqual(r.state, 'error');
  });

  test('PostToolUse with Bash tool + "tests failed" returns error', () => {
    const r = classifyTruncatedInput('PostToolUse', '{"tool_name":"Bash","tool_response":{"stdout":"1400 passed\\n3 tests failed...');
    assert.strictEqual(r.state, 'error');
  });

  test('PostToolUse with Read tool + no error patterns is not error', () => {
    const r = classifyTruncatedInput('PostToolUse', '{"tool_name":"Read","tool_response":{"stdout":"file contents...');
    assert.notStrictEqual(r.state, 'error');
  });

  test('Stop maps to responding', () => {
    const r = classifyTruncatedInput('Stop', '');
    assert.strictEqual(r.state, 'responding');
    assert.strictEqual(r.detail, 'wrapping up');
  });

  test('Notification maps to waiting', () => {
    const r = classifyTruncatedInput('Notification', '');
    assert.strictEqual(r.state, 'waiting');
  });

  test('SessionStart maps to idle', () => {
    const r = classifyTruncatedInput('SessionStart', '');
    assert.strictEqual(r.state, 'idle');
  });

  test('StopFailure maps to error', () => {
    const r = classifyTruncatedInput('StopFailure', '');
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'API error');
  });

  test('PreCompact maps to thinking', () => {
    const r = classifyTruncatedInput('PreCompact', '');
    assert.strictEqual(r.state, 'thinking');
    assert.strictEqual(r.detail, 'compacting memory');
  });

  test('PermissionRequest maps to waiting', () => {
    const r = classifyTruncatedInput('PermissionRequest', '');
    assert.strictEqual(r.state, 'waiting');
    assert.strictEqual(r.detail, 'needs permission');
  });

  test('unknown event falls back to thinking', () => {
    const r = classifyTruncatedInput('SomeNewEvent', '');
    assert.strictEqual(r.state, 'thinking');
    assert.strictEqual(r.detail, 'large input');
  });

  test('empty hookEvent falls back to thinking when no error signals', () => {
    const r = classifyTruncatedInput('', '');
    assert.strictEqual(r.state, 'thinking');
    assert.strictEqual(r.detail, 'large input');
  });

  test('empty hookEvent (adapter path) still detects isError flag', () => {
    const r = classifyTruncatedInput('', '{"tool_name":"Bash","isError": true}');
    assert.strictEqual(r.state, 'error');
  });

  test('empty hookEvent (adapter path) still detects exit code', () => {
    const r = classifyTruncatedInput('', '{"tool_name":"Bash","stdout":"Exit code: 1"}');
    assert.strictEqual(r.state, 'error');
  });

  test('PostToolUse with no error signals falls through to thinking', () => {
    const r = classifyTruncatedInput('PostToolUse', '{"tool_name":"Bash","tool_result":"all good output"}');
    assert.strictEqual(r.state, 'thinking');
    assert.strictEqual(r.detail, 'large input');
  });

  test('SessionEnd maps to responding', () => {
    const r = classifyTruncatedInput('SessionEnd', '');
    assert.strictEqual(r.state, 'responding');
    assert.strictEqual(r.detail, 'session ending');
  });

  test('SubagentStart maps to subagent', () => {
    const r = classifyTruncatedInput('SubagentStart', '');
    assert.strictEqual(r.state, 'subagent');
    assert.strictEqual(r.detail, 'spawning subagent');
  });

  test('SubagentStop maps to happy', () => {
    const r = classifyTruncatedInput('SubagentStop', '');
    assert.strictEqual(r.state, 'happy');
    assert.strictEqual(r.detail, 'subagent done');
  });

  test('Elicitation maps to waiting', () => {
    const r = classifyTruncatedInput('Elicitation', '');
    assert.strictEqual(r.state, 'waiting');
    assert.strictEqual(r.detail, 'needs input');
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
    const subTools = ['Task', 'Agent', 'Subagent', 'spawn_agent', 'delegate', 'codex_agent', 'sessions'];
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
    assert.deepStrictEqual(keys, ['cwd', 'editor', 'gitBranch', 'modelName', 'parentSession', 'sessionId', 'taskDescription']);
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

// -- Bug #111 / Task 12: activeSubagents ageing net --
// Was a 10-minute cleanup (Bug D), which silently dropped every agent that
// ran longer than that. It is now a 4-hour safety net for a missed
// SubagentStop; per-agent liveness is the renderer's job.

describe('update-state.js -- activeSubagents ageing net', () => {
  test('a 3-hour-old agent survives the sweep; a 5-hour-old one does not', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('age-owner');
    try {
      fsMod.mkdirSync(sessionsDir, { recursive: true });
      const stats = conductingStats('age-owner', 'age-owner-sub-young', Date.now() - 3 * 3600000);
      stats.session.activeSubagents.unshift({
        id: 'age-owner-sub-old', description: 'long gone', taskDescription: 'long gone',
        model: 'haiku', editor: 'claude', startedAt: Date.now() - 5 * 3600000,
      });
      fsMod.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');

      runUpdateState('PreToolUse', {
        session_id: 'age-owner', tool_name: 'Read', tool_input: { file_path: 'a.js' },
      }, env);

      const ids = readJSON(statsFile).session.activeSubagents.map(s => s.id);
      // The old 10-minute cut would have taken the 3-hour agent too.
      assert.deepStrictEqual(ids, ['age-owner-sub-young'],
        'only agents past SUBAGENT_MAX_AGE_MS (4h) are swept');
    } finally { cleanup(tmp); }
  });
});

// -- Bug #111: Fallback SubagentStart creates orbital session file (Bug E) --

describe('update-state.js -- fallback SubagentStart creates orbital (Bug E)', () => {
  test('unparseable stdin still writes a spawning orbital under the parent', () => {
    const { tmp, sessionsDir, env } = makeTempEnv('test-session');
    try {
      runUpdateStateRaw('SubagentStart', '', env);

      const files = fsMod.readdirSync(sessionsDir)
        .filter(f => f.startsWith('test-session-sub-') && f.endsWith('.json'));
      assert.strictEqual(files.length, 1, 'the fallback path must create exactly one orbital');
      const sub = readJSON(pathMod.join(sessionsDir, files[0]));
      assert.strictEqual(sub.state, 'spawning');
      assert.strictEqual(sub.parentSession, 'test-session');
      assert.strictEqual(sub.taskDescription, 'subagent');
    } finally { cleanup(tmp); }
  });
});

// -- Bug fix: Stop no longer kills background subagents (Bug #1) --

describe('update-state.js -- Stop handler does not kill active subagents (Bug #1)', () => {
  test('Stop leaves a background subagent running; SessionEnd retires it', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('stop-owner');
    const subFile = pathMod.join(sessionsDir, 'stop-owner-sub-1.json');
    try {
      seedSyntheticOrbital(sessionsDir, 'stop-owner-sub-1', 'stop-owner');
      fsMod.writeFileSync(statsFile, JSON.stringify(conductingStats(
        'stop-owner', 'stop-owner-sub-1', Date.now() - 1000)), 'utf8');

      // End of turn -- the agent may still be working.
      runUpdateState('Stop', { session_id: 'stop-owner' }, env);
      assert.strictEqual(readJSON(subFile).stopped, false,
        'end of turn must not stop a background subagent');
      assert.strictEqual(readJSON(statsFile).session.activeSubagents.length, 1,
        'Stop must not clear activeSubagents');

      // End of session -- now everything goes.
      runUpdateState('SessionEnd', { session_id: 'stop-owner' }, env);
      assert.strictEqual(readJSON(subFile).stopped, true,
        'SessionEnd retires every remaining subagent');
      assert.deepStrictEqual(readJSON(statsFile).session.activeSubagents, [],
        'SessionEnd clears activeSubagents');
    } finally { cleanup(tmp); }
  });
});

// -- Bug fix: mtime touch for active subagents (Bug #3 / Task 12) --
// A legacy synthetic orbital (a SubagentStart that carried no agent_id) has no
// writer of its own: the parent speaks for it. Only the *newest* entry gets the
// parent's tool state written to it, so every earlier one would go stale
// without this mtime touch.
//
// The touch deliberately stops at agent-owned entries (those with an agentId).
// Those orbitals write themselves, and a child kept alive purely by its
// parent's activity is a ghost: composed with grid.js accepting a newer mtime
// on unchanged content, a missed SubagentStop would otherwise keep the orbital
// -- and the main face's conducting hold -- alive for the full 4-hour net.
// (The earlier "newest included" assertion is gone with it: for a legacy
// entry the newest is refreshed by _writeSubagentToolState anyway, so it never
// had teeth once agent-owned entries were the only ones the touch reached.)

describe('update-state.js -- touch active subagent files (Bug #3)', () => {
  // sub-1 is the earlier entry, so the parent never *writes* it
  // (_writeSubagentToolState only targets the newest) -- a refreshed mtime on
  // sub-1 is therefore unambiguous evidence that the touch ran.
  function seedTwoAgedOrbitals(sessionsDir, statsFile, ownerId, opts = {}) {
    seedSyntheticOrbital(sessionsDir, ownerId + '-sub-1', ownerId);
    seedSyntheticOrbital(sessionsDir, ownerId + '-sub-2', ownerId);
    const stats = conductingStats(ownerId, ownerId + '-sub-2', Date.now() - 1000);
    stats.session.activeSubagents.unshift({
      id: ownerId + '-sub-1',
      ...(opts.agentOwned ? { agentId: 'agent-1' } : {}),
      description: 'earlier', taskDescription: 'earlier',
      model: 'haiku', editor: 'claude', startedAt: Date.now() - 2000,
    });
    fsMod.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');
    const old = new Date(Date.now() - 600000);
    for (const n of [1, 2]) {
      const fp = pathMod.join(sessionsDir, `${ownerId}-sub-${n}.json`);
      fsMod.utimesSync(fp, old, old);
    }
  }

  function earlierMtime(sessionsDir, ownerId) {
    return fsMod.statSync(pathMod.join(sessionsDir, `${ownerId}-sub-1.json`)).mtimeMs;
  }

  test('a PreToolUse refreshes an earlier synthetic orbital', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('touch-pre');
    try {
      seedTwoAgedOrbitals(sessionsDir, statsFile, 'touch-pre');
      const since = Date.now() - 2000;
      runUpdateState('PreToolUse', {
        session_id: 'touch-pre', tool_name: 'Read', tool_input: { file_path: 'a.js' },
      }, env);
      const m = earlierMtime(sessionsDir, 'touch-pre');
      assert.ok(m >= since, `sub-1 mtime ${m} was not refreshed (expected >= ${since})`);
    } finally { cleanup(tmp); }
  });

  test('a PostToolUse refreshes an earlier synthetic orbital too', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('touch-post');
    try {
      seedTwoAgedOrbitals(sessionsDir, statsFile, 'touch-post');
      const since = Date.now() - 2000;
      runUpdateState('PostToolUse', {
        session_id: 'touch-post', tool_name: 'Read',
        tool_input: { file_path: 'a.js' }, tool_response: {},
      }, env);
      const m = earlierMtime(sessionsDir, 'touch-post');
      assert.ok(m >= since, `sub-1 mtime ${m} was not refreshed (expected >= ${since})`);
    } finally { cleanup(tmp); }
  });

  test('the touch stops at an agent-owned orbital', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('touch-agent');
    try {
      seedTwoAgedOrbitals(sessionsDir, statsFile, 'touch-agent', { agentOwned: true });
      runUpdateState('PreToolUse', {
        session_id: 'touch-agent', tool_name: 'Read', tool_input: { file_path: 'a.js' },
      }, env);
      const age = Date.now() - earlierMtime(sessionsDir, 'touch-agent');
      assert.ok(age > 60000,
        `an agent-owned orbital writes itself and must not be revived by its `
        + `parent: mtime was refreshed to ${age}ms old`);
    } finally { cleanup(tmp); }
  });

  // _touchSessionFile's own utimesSync behaviour and the agent-write family
  // heartbeat are covered by the tests above plus, behaviourally,
  // tests/test-subagents.js "agent writes heartbeat the parent session file".
});

// -- stripAnsi tests ------------------------------------------------

describe('state-machine.js -- stripAnsi', () => {
  test('strips color codes', () => {
    assert.strictEqual(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
  });

  test('strips bold', () => {
    assert.strictEqual(stripAnsi('\x1b[1mbold\x1b[0m'), 'bold');
  });

  test('empty string returns empty', () => {
    assert.strictEqual(stripAnsi(''), '');
  });

  test('null/undefined returns empty', () => {
    assert.strictEqual(stripAnsi(null), '');
    assert.strictEqual(stripAnsi(undefined), '');
  });

  test('string without ANSI codes passes through unchanged', () => {
    assert.strictEqual(stripAnsi('hello world'), 'hello world');
  });

  test('strips CSI cursor movement sequences', () => {
    assert.strictEqual(stripAnsi('\x1b[2Jcleared'), 'cleared');
    assert.strictEqual(stripAnsi('\x1b[Hmoved'), 'moved');
    assert.strictEqual(stripAnsi('\x1b[Krest of line'), 'rest of line');
  });

  test('strips CSI scroll and erase sequences', () => {
    assert.strictEqual(stripAnsi('\x1b[2Jfoo\x1b[Sbar'), 'foobar');
  });

  test('strips OSC hyperlinks', () => {
    assert.strictEqual(
      stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'),
      'link'
    );
  });

  test('strips OSC title sequences', () => {
    assert.strictEqual(stripAnsi('\x1b]0;My Title\x07content'), 'content');
  });

  test('strips mixed CSI and SGR sequences', () => {
    assert.strictEqual(
      stripAnsi('\x1b[2J\x1b[H\x1b[31mred text\x1b[0m'),
      'red text'
    );
  });
});

// -- toolToState ANSI stripping tests ------------------------------------

describe('state-machine.js -- toolToState ANSI stripping', () => {
  test('strips ANSI from bash command detail', () => {
    const result = toolToState('Bash', { command: '\x1b[32mnpm install\x1b[0m' });
    assert.strictEqual(result.state, 'executing');
    assert.ok(!result.detail.includes('\x1b'), 'detail should not contain ANSI escapes');
    assert.ok(result.detail.includes('npm install'), 'detail should contain clean command text');
  });

  test('strips ANSI from file path detail', () => {
    const result = toolToState('Edit', { file_path: '\x1b[1m/foo/bar.js\x1b[0m' });
    assert.strictEqual(result.state, 'coding');
    assert.ok(!result.detail.includes('\x1b'), 'detail should not contain ANSI escapes');
  });
});

// -- extractExitCode tests -------------------------------------------

describe('state-machine.js -- extractExitCode', () => {
  test('Exit code: 1 returns 1', () => {
    assert.strictEqual(extractExitCode('Exit code: 1'), 1);
  });

  test('Exit code: 0 returns 0', () => {
    assert.strictEqual(extractExitCode('Exit code: 0'), 0);
  });

  test('exited with 127 returns 127', () => {
    assert.strictEqual(extractExitCode('exited with 127'), 127);
  });

  test('exit status: 2 returns 2', () => {
    assert.strictEqual(extractExitCode('exit status: 2'), 2);
  });

  // Updated: "returned N" was the bug, not a supported form
  test('returned 42 returns null', () => {
    assert.strictEqual(extractExitCode('returned 42'), null);
  });

  test('string with no exit code returns null', () => {
    assert.strictEqual(extractExitCode('everything is fine'), null);
  });

  test('empty string returns null', () => {
    assert.strictEqual(extractExitCode(''), null);
  });

  test('with ANSI codes strips them first', () => {
    assert.strictEqual(extractExitCode('\x1b[31mExit code: 1\x1b[0m'), 1);
  });
});

// -- isMergeConflict tests -------------------------------------------

describe('state-machine.js -- isMergeConflict', () => {
  test('CONFLICT (content) returns true', () => {
    assert.strictEqual(isMergeConflict('CONFLICT (content): merge conflict in foo.txt', ''), true);
  });

  test('Automatic merge failed returns true', () => {
    assert.strictEqual(isMergeConflict('Automatic merge failed', ''), true);
  });

  test('fix conflicts and then commit returns true', () => {
    assert.strictEqual(isMergeConflict('fix conflicts and then commit', ''), true);
  });

  test('no conflict text returns false', () => {
    assert.strictEqual(isMergeConflict('All clear, no conflicts', ''), false);
  });

  test('empty strings return false', () => {
    assert.strictEqual(isMergeConflict('', ''), false);
  });

  test('null values do not throw', () => {
    assert.strictEqual(isMergeConflict(null, null), false);
  });
});

// -- errorDetail tests -----------------------------------------------

describe('state-machine.js -- errorDetail', () => {
  test('command not found', () => {
    assert.strictEqual(errorDetail('command not found', ''), 'command not found');
  });

  test('Permission denied', () => {
    assert.strictEqual(errorDetail('Permission denied', ''), 'permission denied');
  });

  test('No such file or directory', () => {
    assert.strictEqual(errorDetail('No such file or directory', ''), 'file not found');
  });

  test('Segmentation fault', () => {
    assert.strictEqual(errorDetail('Segmentation fault', ''), 'segfault!');
  });

  test('ENOENT', () => {
    assert.strictEqual(errorDetail('ENOENT: no such file', ''), 'missing file/path');
  });

  test('syntax error in output', () => {
    assert.strictEqual(errorDetail('line 5: syntax error near unexpected token', ''), 'syntax error');
  });

  test('Cannot find module', () => {
    assert.strictEqual(errorDetail('Cannot find module X', ''), 'missing module');
  });

  test('Traceback (most recent call last)', () => {
    assert.strictEqual(errorDetail('Traceback (most recent call last)', ''), 'exception thrown');
  });

  test('tests failed', () => {
    assert.strictEqual(errorDetail('3 tests failed', ''), 'tests failed');
  });

  test('npm ERR!', () => {
    assert.strictEqual(errorDetail('npm ERR!', ''), 'npm error');
  });

  test('Compilation failed', () => {
    assert.strictEqual(errorDetail('Compilation failed', ''), 'build broke');
  });

  test('unknown error falls back to something went wrong', () => {
    assert.strictEqual(errorDetail('kaboom', ''), 'something went wrong');
  });

  test('merge conflict detected', () => {
    assert.strictEqual(errorDetail('CONFLICT (content): merge conflict in foo.txt', ''), 'merge conflict!');
  });
});

// -- pruneFrequentFiles tests ----------------------------------------

describe('state-machine.js -- pruneFrequentFiles', () => {
  test('returns same object if <= MAX_FREQUENT_FILES entries', () => {
    const files = { 'a.js': 5, 'b.js': 3 };
    const result = pruneFrequentFiles(files);
    assert.deepStrictEqual(result, { 'a.js': 5, 'b.js': 3 });
  });

  test('prunes entries with count < 2', () => {
    const files = {};
    for (let i = 0; i < MAX_FREQUENT_FILES + 5; i++) {
      files[`file${i}.js`] = i < 5 ? 1 : 10;
    }
    const result = pruneFrequentFiles(files);
    // Single-touch files (count 1) should be removed
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(result[`file${i}.js`], undefined);
    }
  });

  test('keeps top MAX_FREQUENT_FILES by count when exceeded', () => {
    const files = {};
    for (let i = 0; i < MAX_FREQUENT_FILES + 10; i++) {
      files[`file${i}.js`] = i + 2; // all >= 2
    }
    const result = pruneFrequentFiles(files);
    assert.ok(Object.keys(result).length <= MAX_FREQUENT_FILES);
  });

  test('null input returns null', () => {
    assert.strictEqual(pruneFrequentFiles(null), null);
  });

  test('empty object returns empty', () => {
    const result = pruneFrequentFiles({});
    assert.deepStrictEqual(result, {});
  });
});

// -- topFrequentFiles tests ------------------------------------------

describe('state-machine.js -- topFrequentFiles', () => {
  test('returns only entries with count >= 3', () => {
    const files = { 'a.js': 5, 'b.js': 2, 'c.js': 3, 'd.js': 1 };
    const result = topFrequentFiles(files);
    assert.deepStrictEqual(result, { 'a.js': 5, 'c.js': 3 });
  });

  test('limits to 10 by default', () => {
    const files = {};
    for (let i = 0; i < 20; i++) {
      files[`file${i}.js`] = i + 3;
    }
    const result = topFrequentFiles(files);
    assert.strictEqual(Object.keys(result).length, 10);
  });

  test('custom limit works', () => {
    const files = {};
    for (let i = 0; i < 10; i++) {
      files[`file${i}.js`] = i + 3;
    }
    const result = topFrequentFiles(files, 3);
    assert.strictEqual(Object.keys(result).length, 3);
  });

  test('null input returns empty object', () => {
    assert.deepStrictEqual(topFrequentFiles(null), {});
  });

  test('empty input returns empty object', () => {
    assert.deepStrictEqual(topFrequentFiles({}), {});
  });
});

// -- buildSubagentSessionState tests ---------------------------------

describe('state-machine.js -- buildSubagentSessionState', () => {
  test('returns null when existing.stopped is true', () => {
    const result = buildSubagentSessionState({ stopped: true }, { id: 's1' }, 'parent1', '/tmp');
    assert.strictEqual(result, null);
  });

  test('preserves existing modelName over sub.model', () => {
    const result = buildSubagentSessionState(
      { modelName: 'sonnet' }, { id: 's1', model: 'haiku' }, 'parent1', '/tmp'
    );
    assert.strictEqual(result.modelName, 'sonnet');
  });

  test('falls back to sub.model when existing.modelName is empty', () => {
    const result = buildSubagentSessionState(
      { modelName: '' }, { id: 's1', model: 'opus' }, 'parent1', '/tmp'
    );
    assert.strictEqual(result.modelName, 'opus');
  });

  test('preserves existing.taskDescription over sub.taskDescription', () => {
    const result = buildSubagentSessionState(
      { taskDescription: 'fix bug' }, { id: 's1', taskDescription: 'new task' }, 'parent1', '/tmp'
    );
    assert.strictEqual(result.taskDescription, 'fix bug');
  });

  test('sets parentSession', () => {
    const result = buildSubagentSessionState(
      {}, { id: 's1' }, 'parent1', '/tmp'
    );
    assert.strictEqual(result.parentSession, 'parent1');
  });

  test('default model is haiku', () => {
    const result = buildSubagentSessionState(
      {}, { id: 's1' }, 'parent1', '/tmp'
    );
    assert.strictEqual(result.modelName, 'haiku');
  });
});

// -- REVIEW_TOOLS tests ----------------------------------------------

describe('state-machine.js -- REVIEW_TOOLS', () => {
  test('diff matches REVIEW_TOOLS', () => {
    assert.ok(REVIEW_TOOLS.test('diff'));
  });

  test('review matches REVIEW_TOOLS', () => {
    assert.ok(REVIEW_TOOLS.test('review'));
  });

  test('compare matches REVIEW_TOOLS', () => {
    assert.ok(REVIEW_TOOLS.test('compare'));
  });

  test('edit does NOT match REVIEW_TOOLS', () => {
    assert.ok(!REVIEW_TOOLS.test('edit'));
  });

  test('bash does NOT match REVIEW_TOOLS', () => {
    assert.ok(!REVIEW_TOOLS.test('bash'));
  });
});

// -- toolToState MCP tools tests -------------------------------------

describe('state-machine.js -- toolToState MCP tools', () => {
  test('mcp__server__tool maps to executing with detail', () => {
    const r = toolToState('mcp__server__tool', {});
    assert.strictEqual(r.state, 'executing');
    assert.strictEqual(r.detail, 'server: tool');
  });

  test('mcp__github__create_pr maps to coding (write verb)', () => {
    const r = toolToState('mcp__github__create_pr', {});
    assert.strictEqual(r.state, 'coding');
  });
});

// -- toolToState unknown tool tests ----------------------------------

describe('state-machine.js -- toolToState unknown tool', () => {
  test('SomeRandomTool maps to thinking state', () => {
    const r = toolToState('SomeRandomTool', {});
    assert.strictEqual(r.state, 'thinking');
  });
});

// -- workState piggyback (PostToolUse includes PreToolUse work state) ------

describe('state-machine.js -- toolToState for workState piggyback', () => {
  test('Bash tool produces executing state (piggybacked on PostToolUse)', () => {
    const r = toolToState('Bash', { command: 'ls' });
    assert.strictEqual(r.state, 'executing');
    assert.ok(r.state !== 'idle' && r.state !== 'thinking',
      'Bash workState should not be idle or thinking');
  });

  test('Edit tool produces coding state', () => {
    const r = toolToState('Edit', { file_path: 'foo.js' });
    assert.strictEqual(r.state, 'coding');
  });

  test('Read tool produces reading state', () => {
    const r = toolToState('Read', { file_path: 'foo.js' });
    assert.strictEqual(r.state, 'reading');
  });

  test('Grep tool produces searching state', () => {
    const r = toolToState('Grep', { pattern: 'foo' });
    assert.strictEqual(r.state, 'searching');
  });

  test('unknown tool produces thinking (excluded from piggyback)', () => {
    const r = toolToState('SomeRandomTool', {});
    assert.strictEqual(r.state, 'thinking');
    // thinking is excluded from workState piggyback in update-state.js
  });
});

// -- Subagent session detection (update-state.js core fix) --
// Legacy path: a host whose subagents report under their own session id while
// the owner is conducting. (Claude Code's agent_id routing is covered by
// tests/test-subagents.js; the parallel-window half of the decision by
// tests/test-adapters.js "parallel sessions vs subagents (#134)".)

describe('update-state.js -- subagent session detection (isKnownSubagent)', () => {
  test('a subagent shows its own tool state and never touches the owner counters', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-A');
    try {
      seedSyntheticOrbital(sessionsDir, 'ownerA-sub-1', 'ownerA');
      fsMod.writeFileSync(statsFile, JSON.stringify(
        conductingStats('ownerA', 'ownerA-sub-1', Date.now() - 1000)), 'utf8');

      runUpdateState('PreToolUse', {
        session_id: 'sub-A', tool_name: 'Edit', tool_input: { file_path: '/w/sub.js' },
      }, env);

      const mine = readJSON(pathMod.join(sessionsDir, 'sub-A.json'));
      assert.strictEqual(mine.state, 'coding',
        'a subagent writes its own tool state -- conducting belongs to the owner');
      assert.notStrictEqual(mine.detail, 'conducting 1');

      const stats = readJSON(statsFile);
      assert.strictEqual(stats.totalToolCalls, 5, 'only the owner bumps the global count');
      assert.deepStrictEqual(stats.session.filesEdited, [],
        'a subagent edit is not an owner edit');
      assert.deepStrictEqual(stats.frequentFiles, {},
        'nor does it enter the owner frequent-files map');
    } finally { cleanup(tmp); }
  });

  test('a subagent commit does not bump the owner commitCount or the streak', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-B');
    try {
      seedSyntheticOrbital(sessionsDir, 'ownerB-sub-1', 'ownerB');
      const stats = conductingStats('ownerB', 'ownerB-sub-1', Date.now() - 1000);
      stats.streak = 4;
      fsMod.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');

      runUpdateState('PostToolUse', {
        session_id: 'sub-B', tool_name: 'Bash',
        tool_input: { command: 'git commit -m "sub work"' }, tool_response: {},
      }, env);

      const mine = readJSON(pathMod.join(sessionsDir, 'sub-B.json'));
      assert.strictEqual(mine.state, 'proud');
      assert.strictEqual(mine.detail, 'committed');
      const after = readJSON(statsFile);
      assert.strictEqual(after.session.commitCount, 0, 'the owner did not commit');
      assert.strictEqual(after.streak, 4,
        'a subagent result must not move the owner streak');
    } finally { cleanup(tmp); }
  });

  test('a subagent Stop leaves the owner session open', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-C');
    try {
      seedSyntheticOrbital(sessionsDir, 'ownerC-sub-1', 'ownerC');
      const stats = conductingStats('ownerC', 'ownerC-sub-1', Date.now() - 1000);
      stats.session.filesEdited = ['a.js', 'b.js'];
      const startBefore = stats.session.start;
      fsMod.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');

      runUpdateState('Stop', { session_id: 'sub-C' }, env);

      const after = readJSON(statsFile);
      assert.strictEqual(after.session.id, 'ownerC', 'the owner keeps the stats session');
      assert.strictEqual(after.session.start, startBefore,
        'a subagent Stop must not close the owner session clock');
      assert.strictEqual(after.records.mostFilesEdited, 0,
        'nor bank the owner files-edited record');
    } finally { cleanup(tmp); }
  });

  test('the synthetic orbital is retired even after tool state changed its face', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-D');
    try {
      // Propagation already moved this synthetic off 'spawning' before the real
      // subagent's first hook arrived: retirement must not require 'spawning'.
      seedSyntheticOrbital(sessionsDir, 'ownerD-sub-1', 'ownerD',
        { state: 'coding', detail: 'edit foo' });
      fsMod.writeFileSync(statsFile, JSON.stringify(
        conductingStats('ownerD', 'ownerD-sub-1', Date.now() - 1000)), 'utf8');

      runUpdateState('PreToolUse', {
        session_id: 'sub-D', tool_name: 'Read', tool_input: { file_path: 'a.js' },
      }, env);

      const synth = readJSON(pathMod.join(sessionsDir, 'ownerD-sub-1.json'));
      assert.strictEqual(synth.stopped, true, 'first contact retires the synthetic');
      assert.strictEqual(synth.state, 'happy');
    } finally { cleanup(tmp); }
  });

  test('a corrupt synthetic does not stop the next one being retired', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-E');
    const CORRUPT = '{"session_id":"ownerE-sub-1","sta';
    try {
      fsMod.mkdirSync(sessionsDir, { recursive: true });
      fsMod.writeFileSync(pathMod.join(sessionsDir, 'ownerE-sub-1.json'), CORRUPT, 'utf8');
      seedSyntheticOrbital(sessionsDir, 'ownerE-sub-2', 'ownerE');
      const stats = conductingStats('ownerE', 'ownerE-sub-2', Date.now() - 1000);
      stats.session.activeSubagents.unshift({
        id: 'ownerE-sub-1', description: 'broken', taskDescription: 'broken',
        model: 'haiku', editor: 'claude', startedAt: Date.now() - 2000,
      });
      fsMod.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');

      runUpdateState('PreToolUse', {
        session_id: 'sub-E', tool_name: 'Read', tool_input: { file_path: 'a.js' },
      }, env);

      assert.strictEqual(readJSON(pathMod.join(sessionsDir, 'ownerE-sub-2.json')).stopped, true,
        'the retirement loop must survive an unreadable synthetic and carry on');
      assert.strictEqual(
        fsMod.readFileSync(pathMod.join(sessionsDir, 'ownerE-sub-1.json'), 'utf8'), CORRUPT,
        'the unreadable file is left exactly as it was');
    } finally { cleanup(tmp); }
  });

  test('retirement takes the oldest live synthetic first', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-F');
    try {
      seedSyntheticOrbital(sessionsDir, 'ownerF-sub-1', 'ownerF');
      seedSyntheticOrbital(sessionsDir, 'ownerF-sub-2', 'ownerF');
      const stats = conductingStats('ownerF', 'ownerF-sub-2', Date.now() - 1000);
      stats.session.activeSubagents.unshift({
        id: 'ownerF-sub-1', description: 'older', taskDescription: 'older',
        model: 'haiku', editor: 'claude', startedAt: Date.now() - 3000,
      });
      fsMod.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');

      runUpdateState('PreToolUse', {
        session_id: 'sub-F', tool_name: 'Read', tool_input: { file_path: 'a.js' },
      }, env);

      assert.strictEqual(readJSON(pathMod.join(sessionsDir, 'ownerF-sub-1.json')).stopped, true,
        'the oldest live synthetic is the one this first contact belongs to');
      assert.strictEqual(readJSON(pathMod.join(sessionsDir, 'ownerF-sub-2.json')).stopped, false,
        'exactly one synthetic is retired per first contact');
    } finally { cleanup(tmp); }
  });

  test('with nobody conducting, a foreign session simply takes over the stats', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-G');
    try {
      const stats = conductingStats('ownerG', 'unused', Date.now());
      stats.session.activeSubagents = [];
      fsMod.mkdirSync(sessionsDir, { recursive: true });
      fsMod.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');

      runUpdateState('PreToolUse', {
        session_id: 'sub-G', tool_name: 'Read', tool_input: { file_path: 'a.js' },
      }, env);

      const after = readJSON(statsFile);
      assert.strictEqual(after.session.id, 'sub-G',
        'no active subagents means no subagent classification');
      assert.strictEqual(after.session.toolCalls, 1, 'so its tool call counts');
      assert.strictEqual(readJSON(pathMod.join(sessionsDir, 'sub-G.json')).parentSession, undefined,
        'and it gets no parentSession stamp');
    } finally { cleanup(tmp); }
  });

  test('a foreign SessionStart while conducting takes the session over', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-H1');
    try {
      seedSyntheticOrbital(sessionsDir, 'ownerH-sub-1', 'ownerH');
      fsMod.writeFileSync(statsFile, JSON.stringify(
        conductingStats('ownerH', 'ownerH-sub-1', Date.now() - 1000)), 'utf8');

      runUpdateState('SessionStart', { session_id: 'sub-H1' }, env);

      const after = readJSON(statsFile);
      assert.strictEqual(after.session.id, 'sub-H1',
        'SessionStart is a lifecycle event -- never rerouted as a subagent hook');
      assert.deepStrictEqual(after.session.activeSubagents, []);
    } finally { cleanup(tmp); }
  });

  test('a foreign PreCompact while conducting is not stamped as a subagent', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('sub-H2');
    try {
      seedSyntheticOrbital(sessionsDir, 'ownerH-sub-1', 'ownerH');
      fsMod.writeFileSync(statsFile, JSON.stringify(
        conductingStats('ownerH', 'ownerH-sub-1', Date.now() - 1000)), 'utf8');

      runUpdateState('PreCompact', { session_id: 'sub-H2', trigger: 'manual' }, env);

      const mine = readJSON(pathMod.join(sessionsDir, 'sub-H2.json'));
      assert.strictEqual(mine.state, 'thinking');
      assert.strictEqual(mine.parentSession, undefined,
        'PreCompact is in LIFECYCLE_EVENTS, so it is never rerouted');
      assert.strictEqual(readJSON(statsFile).session.id, 'sub-H2');
    } finally { cleanup(tmp); }
  });

  // The three per-session interactive events are deliberately kept OUT of
  // LIFECYCLE_EVENTS so that in subagent context they land on the agent's
  // orbital instead of the main face. Each one is asserted separately: they
  // are three independent Set memberships, not one.
  const interactiveCases = [
    ['PermissionRequest', { tool_name: 'Bash' }, 'waiting', 'allow Bash?'],
    ['Elicitation', { mcp_server_name: 'srv' }, 'waiting', 'srv: needs input'],
    ['ElicitationResult', { action: 'decline' }, 'relieved', 'input declined'],
  ];
  for (const [event, payload, state, detail] of interactiveCases) {
    test(`a subagent ${event} routes to its orbital, not the main face`, () => {
      const id = 'sub-I-' + event;
      const { tmp, sessionsDir, statsFile, env } = makeTempEnv(id);
      try {
        seedSyntheticOrbital(sessionsDir, 'ownerI-sub-1', 'ownerI');
        fsMod.writeFileSync(statsFile, JSON.stringify(
          conductingStats('ownerI', 'ownerI-sub-1', Date.now() - 1000)), 'utf8');

        runUpdateState(event, { session_id: id, ...payload }, env);

        const mine = readJSON(pathMod.join(sessionsDir, id + '.json'));
        assert.strictEqual(mine.state, state);
        assert.strictEqual(mine.detail, detail);
        assert.strictEqual(mine.parentSession, 'ownerI',
          `${event} must stay OUT of LIFECYCLE_EVENTS so it lands on the orbital`);
        assert.strictEqual(readJSON(statsFile).session.id, 'ownerI',
          'and it does not reset the conductor session');
      } finally { cleanup(tmp); }
    });
  }
});

// -- New Hook Events (PreCompact, PostCompact, PermissionRequest, etc.) ------

describe('update-state.js -- new hook event handlers', () => {
  const NEW_EVENTS = [
    'PreCompact', 'PostCompact', 'PermissionRequest', 'Setup',
    'Elicitation', 'ElicitationResult', 'ConfigChange',
    'InstructionsLoaded', 'StopFailure',
  ];

  // -- Registration. hooks.json is shipped configuration, not implementation:
  // reading it is reading the artifact, so these stay data assertions.

  test('hooks.json registers all 9 new events', () => {
    const hooks = readJSON(pathMod.join(__dirname, '..', 'hooks', 'hooks.json'));
    for (const event of NEW_EVENTS) {
      assert.ok(hooks.hooks[event], `hooks.json should register ${event}`);
      assert.strictEqual(hooks.hooks[event][0].hooks[0].type, 'command');
      assert.ok(
        hooks.hooks[event][0].hooks[0].command.includes(`update-state.js" ${event}`),
        `${event} command should pass event name as argument`
      );
    }
  });

  test('hooks.json does NOT register WorktreeCreate or WorktreeRemove', () => {
    const hooks = readJSON(pathMod.join(__dirname, '..', 'hooks', 'hooks.json'));
    assert.strictEqual(hooks.hooks.WorktreeCreate, undefined,
      'WorktreeCreate would replace default worktree behavior -- must not be registered');
    assert.strictEqual(hooks.hooks.WorktreeRemove, undefined,
      'WorktreeRemove would replace default worktree behavior -- must not be registered');
  });

  // -- What each handler actually writes ------------------------------

  // One owner session, no subagents: these are plain lifecycle events on the
  // session that owns the stats, with counters already at 5 so "did not
  // inflate the counters" is an assertion and not a tautology.
  function seedOwner(statsFile, id) {
    const stats = conductingStats(id, 'unused', Date.now());
    stats.session.activeSubagents = [];
    stats.streak = 3;
    fsMod.writeFileSync(statsFile, JSON.stringify(stats), 'utf8');
  }

  const cases = [
    ['PreCompact', { trigger: 'manual' }, 'thinking', 'compacting memory'],
    ['PreCompact', {}, 'thinking', 'auto-compacting'],
    ['PostCompact', {}, 'satisfied', 'memory compacted'],
    ['PermissionRequest', { tool_name: 'Bash' }, 'waiting', 'allow Bash?'],
    ['PermissionRequest', {}, 'waiting', 'needs permission'],
    ['Setup', { trigger: 'maintenance' }, 'starting', 'maintenance'],
    ['Setup', {}, 'starting', 'setting up'],
    ['Elicitation', { mcp_server_name: 'a-very-long-mcp-server-name' },
      'waiting', 'a-very-long-mcp-serv: needs input'],
    ['ElicitationResult', { action: 'accept' }, 'satisfied', 'input received'],
    ['ElicitationResult', { action: 'decline' }, 'relieved', 'input declined'],
    ['ElicitationResult', { action: 'cancel' }, 'relieved', 'input cancelled'],
    ['ConfigChange', { file_path: '/a/b/settings.json' }, 'reading', 'config: settings.json'],
    ['InstructionsLoaded', { file_path: '/x/CLAUDE.md' }, 'reading', 'CLAUDE.md'],
    ['StopFailure', { error: 'rate_limit' }, 'error', 'rate limited!'],
    ['StopFailure', { error: 'server_error' }, 'error', 'server error'],
  ];

  let caseNo = 0;
  for (const [event, payload, state, detail] of cases) {
    const id = 'newev-' + (caseNo++);
    test(`${event} ${JSON.stringify(payload)} -> ${state} / ${detail}`, () => {
      const { tmp, stateFile, statsFile, env } = makeTempEnv(id);
      try {
        seedOwner(statsFile, id);
        runUpdateState(event, { session_id: id, ...payload }, env);
        const st = readJSON(stateFile);
        assert.strictEqual(st.state, state);
        assert.strictEqual(st.detail, detail);
        const stats = readJSON(statsFile);
        assert.strictEqual(stats.session.toolCalls, 5,
          'a lifecycle event is not a tool call');
        assert.strictEqual(stats.totalToolCalls, 5,
          'and does not inflate the global count either');
      } finally { cleanup(tmp); }
    });
  }

  test('StopFailure breaks the streak and counts an error', () => {
    const { tmp, statsFile, env } = makeTempEnv('stopfail-1');
    try {
      seedOwner(statsFile, 'stopfail-1');
      runUpdateState('StopFailure', { session_id: 'stopfail-1', error: 'rate_limit' }, env);
      const stats = readJSON(statsFile);
      assert.strictEqual(stats.streak, 0, 'an API failure breaks the streak');
      assert.strictEqual(stats.brokenStreak, 3, 'and remembers what it broke');
      assert.strictEqual(stats.totalErrors, 1);
    } finally { cleanup(tmp); }
  });

  // -- Catch path: unparseable stdin still lands a sane face -----------

  const fallbacks = [
    ['PreCompact', 'thinking', 'compacting memory'],
    ['PostCompact', 'satisfied', 'memory compacted'],
    ['PermissionRequest', 'waiting', 'needs permission'],
    ['Setup', 'starting', 'setting up'],
    ['Elicitation', 'waiting', 'needs input'],
    ['ElicitationResult', 'satisfied', 'input received'],
    ['ConfigChange', 'reading', 'config updated'],
    ['InstructionsLoaded', 'reading', 'loading instructions'],
    ['StopFailure', 'error', 'API error'],
  ];
  for (const [event, state, detail] of fallbacks) {
    test(`empty stdin: ${event} -> ${state} / ${detail}`, () => {
      const { tmp, stateFile, env } = makeTempEnv('fb-' + event);
      try {
        runUpdateStateRaw(event, '', env);
        const st = readJSON(stateFile);
        assert.strictEqual(st.state, state);
        assert.strictEqual(st.detail, detail);
      } finally { cleanup(tmp); }
    });
  }
});

describe('state-machine -- buildSubagentSessionState editor field', () => {
  test('preserves editor from existing session file', () => {
    const built = buildSubagentSessionState(
      { editor: 'opencode', modelName: 'big-pickle' },
      { id: 's1', model: 'haiku', description: 'task' }, 'parent-1', '/tmp');
    assert.strictEqual(built.editor, 'opencode');
  });
  test('falls back to sub.editor then empty', () => {
    const a = buildSubagentSessionState({}, { id: 's1', editor: 'claude', description: 'd' }, 'p', '/tmp');
    assert.strictEqual(a.editor, 'claude');
    const b = buildSubagentSessionState({}, { id: 's1', description: 'd' }, 'p', '/tmp');
    assert.strictEqual(b.editor, '');
  });
});

// -- classifyForeignSession / pruneTopLevelSessions (#134) -----------------

describe('state-machine.js -- classifyForeignSession (#134)', () => {
  test('registry hit → parallel regardless of file age', () => {
    assert.strictEqual(classifyForeignSession({
      registryHit: true, fileBornAt: null, earliestSubagentStart: 1000,
    }), 'parallel');
    assert.strictEqual(classifyForeignSession({
      registryHit: true, fileBornAt: 5000, earliestSubagentStart: 1000,
    }), 'parallel');
  });

  test('session file born before earliest subagent → parallel', () => {
    assert.strictEqual(classifyForeignSession({
      registryHit: false, fileBornAt: 1000, earliestSubagentStart: 2000,
    }), 'parallel');
  });

  test('session file born after earliest subagent → subagent', () => {
    assert.strictEqual(classifyForeignSession({
      registryHit: false, fileBornAt: 3000, earliestSubagentStart: 2000,
    }), 'subagent');
  });

  test('unknown birthtime → subagent (pre-fix behavior, safe fallback)', () => {
    assert.strictEqual(classifyForeignSession({
      registryHit: false, fileBornAt: null, earliestSubagentStart: 2000,
    }), 'subagent');
    assert.strictEqual(classifyForeignSession({
      registryHit: false, fileBornAt: 0, earliestSubagentStart: 2000,
    }), 'subagent');
  });

  test('invalid earliestSubagentStart → subagent', () => {
    assert.strictEqual(classifyForeignSession({
      registryHit: false, fileBornAt: 1000, earliestSubagentStart: 0,
    }), 'subagent');
    assert.strictEqual(classifyForeignSession({
      registryHit: false, fileBornAt: 1000, earliestSubagentStart: null,
    }), 'subagent');
  });
});

describe('state-machine.js -- pruneTopLevelSessions (#134)', () => {
  test('drops entries older than TTL, keeps fresh ones', () => {
    const now = Date.now();
    const reg = { old: now - TOP_LEVEL_REGISTRY_TTL_MS - 1000, fresh: now - 1000 };
    pruneTopLevelSessions(reg, now);
    assert.strictEqual(reg.old, undefined);
    assert.ok(reg.fresh);
  });

  test('caps at TOP_LEVEL_REGISTRY_MAX, dropping oldest first', () => {
    const now = Date.now();
    const reg = {};
    for (let i = 0; i < TOP_LEVEL_REGISTRY_MAX + 10; i++) {
      reg['s' + i] = now - i * 1000; // s0 newest, high indices oldest
    }
    pruneTopLevelSessions(reg, now);
    assert.strictEqual(Object.keys(reg).length, TOP_LEVEL_REGISTRY_MAX);
    assert.ok(reg.s0, 'newest entry survives');
    assert.strictEqual(reg['s' + (TOP_LEVEL_REGISTRY_MAX + 9)], undefined, 'oldest entry dropped');
  });

  test('null registry is safe', () => {
    assert.strictEqual(pruneTopLevelSessions(null, Date.now()), null);
  });

  test('defaultStats includes empty topLevelSessions registry', () => {
    assert.deepStrictEqual(defaultStats().topLevelSessions, {});
  });
});

// -- Parallel session classification wiring (#134) -------------------------
// The registry/birthtime decision table is unit-tested above
// (classifyForeignSession / pruneTopLevelSessions) and the end-to-end
// PreToolUse cases -- registered window, birthtime window, subagent
// regression, stale-stamp healing, teammate exemption, SessionStart
// registration -- live in tests/test-adapters.js "parallel sessions vs
// subagents (#134)". What is left to pin here is the PostToolUse half of the
// propagation guard, which no other test exercises.

describe('update-state.js -- parallel session wiring (#134)', () => {
  test('a parallel window PostToolUse does not paint the subagent orbital', () => {
    const { tmp, sessionsDir, statsFile, env } = makeTempEnv('par-post-1');
    try {
      seedSyntheticOrbital(sessionsDir, 'owner-1-sub-1', 'owner-1');
      fsMod.writeFileSync(statsFile, JSON.stringify(conductingStats(
        'owner-1', 'owner-1-sub-1', Date.now() - 1000,
        { 'par-post-1': Date.now() })), 'utf8');

      runUpdateState('PostToolUse', {
        session_id: 'par-post-1', tool_name: 'Bash',
        tool_input: { command: 'ls' }, tool_response: {},
      }, env);

      const synth = readJSON(pathMod.join(sessionsDir, 'owner-1-sub-1.json'));
      assert.strictEqual(synth.state, 'spawning',
        'an unrelated window result must not land on the subagent orbital');
      assert.strictEqual(synth.stopped, false,
        'nor retire it');

      const mine = readJSON(pathMod.join(sessionsDir, 'par-post-1.json'));
      assert.notStrictEqual(mine.state, 'subagent',
        'the parallel window is not conducting anything');
      assert.strictEqual(readJSON(statsFile).session.id, 'owner-1',
        'and it does not steal the stats session');
    } finally { cleanup(tmp); }
  });
});

// -- Model identity ------------------------------------------------------

describe('state-machine.js -- prettyModelName', () => {
  test('maps the Claude families to their display names', () => {
    const table = [
      ['claude-opus-5', 'Opus'],
      ['claude-sonnet-5', 'Sonnet'],
      ['claude-haiku-4-5-20251001', 'Haiku'],
      ['claude-fable-5-1', 'Fable'],
      ['claude-opus-4-6', 'Opus'],
    ];
    for (const [raw, want] of table) {
      assert.strictEqual(prettyModelName(raw), want, raw);
    }
  });

  test('strips a bracketed context suffix', () => {
    assert.strictEqual(prettyModelName('claude-opus-5[1m]'), 'Opus');
    assert.strictEqual(prettyModelName('claude-sonnet-5[1m]'), 'Sonnet');
  });

  test('strips a vendor prefix', () => {
    assert.strictEqual(prettyModelName('anthropic/claude-opus'), 'Opus');
    assert.strictEqual(prettyModelName('opencode/anthropic/claude-haiku'), 'Haiku');
  });

  test('returns an unrecognised id verbatim rather than inventing a family', () => {
    assert.strictEqual(prettyModelName('gpt-5'), 'gpt-5');
    assert.strictEqual(prettyModelName('deepseek-v3'), 'deepseek-v3');
    assert.strictEqual(prettyModelName('opencode/big-pickle'), 'big-pickle');
  });

  test('never truncates -- producers produce, renderers slice', () => {
    const long = 'some-extremely-long-model-identifier-v2';
    assert.strictEqual(prettyModelName(long), long);
  });

  test('coerces junk to empty string (toText convention)', () => {
    for (const bad of ['', '   ', null, undefined, {}, []]) {
      assert.strictEqual(prettyModelName(bad), '', JSON.stringify(bad));
    }
  });

  test('is case-insensitive about the family', () => {
    assert.strictEqual(prettyModelName('CLAUDE-OPUS-5'), 'Opus');
    assert.strictEqual(prettyModelName('Claude-Sonnet-5'), 'Sonnet');
  });
});

describe('state-machine.js -- agentTranscriptPath', () => {
  const path = require('path');

  test('derives the documented per-agent transcript path', () => {
    const got = agentTranscriptPath('/projects/proj/sess-1.jsonl', 'a123');
    assert.strictEqual(got,
      path.join('/projects/proj', 'sess-1', 'subagents', 'agent-a123.jsonl'));
  });

  test('rejects an agent id that could escape the directory', () => {
    for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '..', 'a b']) {
      assert.strictEqual(agentTranscriptPath('/p/s.jsonl', bad), '', bad);
    }
  });

  test('rejects a transcript path that is not a .jsonl', () => {
    assert.strictEqual(agentTranscriptPath('/p/s.txt', 'a1'), '');
    assert.strictEqual(agentTranscriptPath('/p/s', 'a1'), '');
  });

  test('returns empty for missing or junk arguments', () => {
    assert.strictEqual(agentTranscriptPath('', 'a1'), '');
    assert.strictEqual(agentTranscriptPath('/p/s.jsonl', ''), '');
    assert.strictEqual(agentTranscriptPath(null, null), '');
    assert.strictEqual(agentTranscriptPath({}, []), '');
  });
});

describe('state-machine.js -- buildSubagentSessionState model stickiness', () => {
  test('preserves an existing model', () => {
    const out = buildSubagentSessionState(
      { model: 'Opus' }, { id: 'sub-1' }, 'parent', '/cwd');
    assert.strictEqual(out.model, 'Opus');
  });

  test('omits the key entirely when no model is known', () => {
    const out = buildSubagentSessionState({}, { id: 'sub-1' }, 'parent', '/cwd');
    assert.ok(!('model' in out), 'no empty model key in the ~1KB state file');
  });
});

// -- Shell command intent: arguments are data, not intent -----------------

describe('state-machine.js -- shell intent (pre-tool)', () => {
  const pre = (command) => toolToState('Bash', { command });

  test('a commit whose message names jest is committing, not testing', () => {
    assert.strictEqual(pre('git commit -m "fix jest config"').state, 'committing');
  });
  test('a commit whose message names a spec / npm install is still committing', () => {
    assert.strictEqual(pre("git commit -m 'Add spec for parser'").state, 'committing');
    assert.strictEqual(pre('git add -A && git commit -m "npm install fixes"').state, 'committing');
  });
  test('a Claude-style heredoc commit message is removed whole', () => {
    const cmd = 'git commit -m "$(cat <<\'EOF\'\nRun pytest in CI\n\nFix the build script\nEOF\n)"';
    assert.strictEqual(pre(cmd).state, 'committing');
  });
  test('git commit wins over a test run in the same command line', () => {
    assert.strictEqual(pre('npm test && git commit -m "x"').state, 'committing');
  });
  test('reading a test file is not a test run', () => {
    for (const c of ['cat src/foo.test.js', 'head -50 src/foo.spec.ts', 'tail -f a.test.js',
      'less x.test.js', 'grep -n describe src/foo.test.js', 'rg jest src/', 'git diff src/foo.test.js',
      'git log -- src/foo.test.js', 'cat train.py']) {
      assert.strictEqual(pre(c).state, 'executing', c);
    }
  });
  test('a quoted pattern naming a test tool is not a test run', () => {
    assert.strictEqual(pre('grep -rn "pytest" .').state, 'executing');
    assert.strictEqual(pre('echo "run jest later"').state, 'executing');
  });
  test('real test runs still read as testing', () => {
    for (const c of ['npm test', 'npx jest src/foo.test.js', 'node tests/foo.test.js', 'pytest -x',
      'cd app && npm run test', 'npm test 2>&1 | tail -20', 'node --test', 'FOO=1 npx vitest run',
      'find . -name "*.test.js" | xargs jest']) {
      assert.strictEqual(pre(c).state, 'testing', c);
    }
  });
  test('install / training / push / tag still classify', () => {
    assert.strictEqual(pre('npm install lodash').state, 'installing');
    assert.strictEqual(pre('python train.py --epochs 3').state, 'training');
    assert.strictEqual(pre('git push origin main').state, 'committing');
    assert.strictEqual(pre('git push origin main').detail, 'git push origin main');
    assert.strictEqual(pre('git tag v1.0').state, 'committing');
  });
  test('the detail is still the raw command', () => {
    assert.strictEqual(pre('git commit -m "fix jest"').detail, 'git commit -m "fix jest"');
  });
});

describe('state-machine.js -- shell intent (post-tool)', () => {
  const post = (command, stdout = '') => classifyToolResult('Bash', { command }, { stdout, stderr: '' }, false);

  test('a commit whose message names the build is proud / committed', () => {
    const r = post('git commit -m "Fix the build script"', '[main abc123] Fix the build script');
    assert.strictEqual(r.state, 'proud');
    assert.strictEqual(r.detail, 'committed');
  });
  test('a commit whose message names a spec or tests is proud / committed', () => {
    assert.strictEqual(post('git commit -m "Add spec for parser"').detail, 'committed');
    assert.strictEqual(post("git commit -m 'make tests pass'").detail, 'committed');
    assert.strictEqual(post('npm test && git commit -m "x"').detail, 'committed');
  });
  test('a push whose message-free line names tests is still pushed', () => {
    assert.strictEqual(post('npm test && git push').detail, 'pushed!');
  });
  test('a merge conflict is still an error even when the command also runs a build', () => {
    const r = post('git merge feature && npm run build', 'CONFLICT (content): Merge conflict in a.js\nAutomatic merge failed');
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'merge conflict!');
  });
  test('reading a spec file is not "tests passed"', () => {
    assert.strictEqual(post('cat src/parser.spec.ts', 'describe(...)').detail, 'command succeeded');
  });
  test('real test and build runs keep their details', () => {
    assert.strictEqual(post('npm test', '12 tests passed').detail, '12 tests passed');
    assert.strictEqual(post('npm run build').detail, 'build succeeded');
    assert.strictEqual(post('git pull').detail, 'merged clean');
    assert.strictEqual(post('git status').detail, 'git done');
    assert.strictEqual(post('npm install').detail, 'installed');
  });
});

describe('update-state.js -- commit counting survives a commit message naming the build', () => {
  test('git commit -m "Fix the build script" increments commitCount', () => {
    const { tmp, statsFile, env } = makeTempEnv('commit-count');
    try {
      runUpdateState('PostToolUse', {
        session_id: 'commit-count', tool_name: 'Bash',
        tool_input: { command: 'git commit -m "Fix the build script"' },
        tool_response: { stdout: '[main abc123] Fix the build script', stderr: '' },
      }, env);
      assert.strictEqual(readJSON(statsFile).session.commitCount, 1);
    } finally { cleanup(tmp); }
  });
});

// -- Exit codes are only inferred from a shell's own output -----------------

describe('state-machine.js -- exit code inference', () => {
  test('an MCP result that "returned 12 results" is not an error', () => {
    const r = classifyToolResult('mcp__search__query', {}, { stdout: 'Search returned 12 results', stderr: '' }, false);
    assert.strictEqual(r.state, 'satisfied');
  });
  test('Bash stdout "fib(10) returned 55" is not exit 55', () => {
    const r = classifyToolResult('Bash', { command: 'node fib.js' }, { stdout: 'fib(10) returned 55', stderr: '' }, false);
    assert.strictEqual(r.state, 'relieved');
  });
  test('a non-shell tool mentioning "Exit code: 1" in its content is not an error', () => {
    const r = classifyToolResult('Read', { file_path: 'notes.md' }, { stdout: 'The CI said Exit code: 1', stderr: '' }, false);
    assert.strictEqual(r.state, 'satisfied');
  });
  test('Bash "Exit code 2" / "exited with code 3" / "exit status 4" are still errors', () => {
    for (const [out, code] of [['boom\nExit code 2', 2], ['Process exited with code 3', 3], ['exit status 4', 4]]) {
      assert.strictEqual(extractExitCode(out), code, out);
      const r = classifyToolResult('Bash', { command: 'make' }, { stdout: out, stderr: '' }, false);
      assert.strictEqual(r.state, 'error', out);
    }
  });
  test('extractExitCode anchors: no match inside a word, at most three digits', () => {
    assert.strictEqual(extractExitCode('myexit code: 1'), null);
    assert.strictEqual(extractExitCode('exit code: 12345'), null);
    assert.strictEqual(extractExitCode('Error: Command failed with exit code 1'), 1);
  });
  test('truncated input: a known non-shell tool never infers an exit code', () => {
    const r = classifyTruncatedInput('PostToolUse', '{"tool_name":"mcp__x__search","tool_response":"...\\nexit code: 7 ...');
    assert.notStrictEqual(r.state, 'error');
  });
});

// -- False-positive guards are per line; read-only commands print content ---

describe('state-machine.js -- per-line false-positive guards', () => {
  test('pytest: a real failure is not cancelled by "Captured stderr call"', () => {
    const out = '____ test_x ____\n----- Captured stderr call -----\nboom\n1 failed, 3 passed in 0.2s';
    assert.strictEqual(looksLikeError(out, stdoutErrorPatterns), true);
    const r = classifyToolResult('Bash', { command: 'pytest' }, { stdout: out, stderr: '' }, false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'tests failed');
  });
  test('jest: "1 failed" is not cancelled by "No errors found" on another line', () => {
    const out = 'Tests: 1 failed, 9 passed\nLint: No errors found';
    assert.strictEqual(looksLikeError(out, stdoutErrorPatterns), true);
    assert.strictEqual(classifyToolResult('Bash', { command: 'npm test' }, { stdout: out, stderr: '' }, false).state, 'error');
  });
  test('a guard still cancels an error match on its own line', () => {
    assert.strictEqual(looksLikeError('Tests: 0 failed, 9 passed', stdoutErrorPatterns), false);
    assert.strictEqual(looksLikeError('build: no errors, 0 failed', stderrErrorPatterns), false);
    assert.strictEqual(looksLikeError('src/error.js: saved', stderrErrorPatterns), false);
  });
  test('mixed "2 warnings, 1 error" on one line is still an error', () => {
    assert.strictEqual(looksLikeError('2 warnings, 1 error', stderrErrorPatterns), true);
    assert.strictEqual(looksLikeError('1 warning, 0 errors', stderrErrorPatterns), false);
  });
  test('a multi-line pattern (Node stack trace) is still detected', () => {
    const out = 'at Object.<anonymous> (/x/a.js:1:1)\n    at Module._compile (node:internal)';
    assert.strictEqual(looksLikeError(out, stdoutErrorPatterns), true);
  });
});

describe('state-machine.js -- read-only commands print content, not verdicts', () => {
  test('grep -rn ENOENT src/ is not a "missing file/path" error', () => {
    const r = classifyToolResult('Bash', { command: 'grep -rn ENOENT src/' },
      { stdout: "src/a.js:12:  if (e.code === 'ENOENT') return;", stderr: '' }, false);
    assert.strictEqual(r.state, 'relieved');
  });
  test('cat / git log / piped read-only chains are not errors on scary stdout', () => {
    for (const command of ['cat build.log', 'git log --oneline', 'grep -rn FATAL . | head -5', 'git -C sub show HEAD']) {
      const r = classifyToolResult('Bash', { command }, { stdout: 'FATAL: build failed\n3 failed', stderr: '' }, false);
      assert.notStrictEqual(r.state, 'error', command);
    }
  });
  test('a chain with a real command still gets stdout checks', () => {
    const r = classifyToolResult('Bash', { command: 'cat x && npm run build' }, { stdout: 'Build failed', stderr: '' }, false);
    assert.strictEqual(r.state, 'error');
  });
  test('stderr and exit codes still apply to read-only commands', () => {
    assert.strictEqual(classifyToolResult('Bash', { command: 'cat nope' },
      { stdout: '', stderr: 'cat: /root/x: Permission denied' }, false).state, 'error');
    assert.strictEqual(classifyToolResult('Bash', { command: 'grep x y' },
      { stdout: 'Exit code 2', stderr: '' }, false).state, 'error');
  });
});

module.exports = suite;
