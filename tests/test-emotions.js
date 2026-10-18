'use strict';

// +================================================================+
// |  Code Crumb Test Suite - Emotion fidelity                      |
// |                                                                |
// |  The contract for "the face shows the right feeling, for the   |
// |  right tool, for long enough to be seen":                      |
// |    - current Claude Code tool names map to specific states     |
// |    - tool results carry interrupted/isError/exitCode through   |
// |    - completion faces get a guaranteed on-screen window        |
// |    - work that arrives during that window is not lost          |
// |    - every state has eyes, thoughts, and a hook that reaches it|
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;
const { makeTempEnv, cleanup, readJSON, runUpdateState } = require('./_harness');

const sm = require('../lib/state-machine');
const shared = require('../lib/shared');
const face = require('../lib/face');
const renderer = require('../renderer');
const grid = require('../lib/grid');
const { STATE_THOUGHTS } = require('../lib/themes');

const ROOT = path.join(__dirname, '..');

// -- Tool -> state mapping ----------------------------------------------

describe('emotions -- current Claude Code tools map to specific states', () => {
  // [tool, input, preState, preDetail, postState, postDetail]
  // preDetail/postDetail: exact string, or RegExp to match.
  const table = [
    ['NotebookEdit', { notebook_path: '/n/nb.ipynb' }, 'coding', 'editing nb.ipynb', 'proud', 'saved nb.ipynb'],
    ['NotebookRead', { notebook_path: '/n/nb.ipynb' }, 'reading', 'reading nb.ipynb', 'satisfied', 'read nb.ipynb'],
    ['LS', { path: '/some/dir' }, 'searching', 'listing dir', 'satisfied', /got it|found/],
    ['ToolSearch', { query: 'select:Foo' }, 'searching', 'looking for "select:Foo"', 'satisfied', /found|got it/],
    ['KillShell', {}, 'executing', 'kill shell', 'relieved', 'kill shell done'],
    ['BashOutput', {}, 'executing', 'bash output', 'relieved', 'bash output done'],
    ['EnterWorktree', {}, 'executing', 'enter worktree', 'relieved', 'enter worktree done'],
    ['AskUserQuestion', {}, 'waiting', 'asking you', 'satisfied', 'got your answer'],
    ['Skill', { skill: 'brainstorming' }, 'reading', 'skill: brainstorming', 'satisfied', 'skill loaded'],
    ['Skill', {}, 'reading', 'loading a skill', 'satisfied', 'skill loaded'],
    ['TodoWrite', {}, 'thinking', 'planning', 'satisfied', 'planned'],
    ['EnterPlanMode', {}, 'thinking', 'planning', 'satisfied', 'planned'],
    ['ExitPlanMode', {}, 'thinking', 'planning', 'satisfied', 'planned'],
    ['CronCreate', {}, 'thinking', 'scheduling', 'satisfied', 'scheduled'],
    ['ScheduleWakeup', {}, 'thinking', 'scheduling', 'satisfied', 'scheduled'],
    ['Agent', { description: 'Audit tests' }, 'subagent', 'Audit tests', 'happy', 'agent done'],
    ['Task', {}, 'subagent', 'spawning subagent', 'happy', 'agent done'],
    ['Workflow', {}, 'subagent', 'orchestrating', 'happy', 'agent done'],
    ['TaskOutput', {}, 'subagent', 'checking on agents', 'happy', 'agent done'],
    ['SendMessage', {}, 'subagent', 'messaging an agent', 'satisfied', 'message sent'],
    ['ListAgents', {}, 'subagent', 'checking on agents', 'satisfied', 'checked in'],
    ['Monitor', {}, 'subagent', 'checking on agents', 'satisfied', 'checked in'],
    ['TaskStop', {}, 'subagent', 'checking on agents', 'satisfied', 'checked in'],
    ['ReportFindings', {}, 'reviewing', 'report findings', 'satisfied', 'reviewed'],
    ['Artifact', {}, 'coding', 'publishing', 'proud', 'published'],
    ['SendUserFile', {}, 'coding', 'sending a file', 'proud', 'sent'],
    ['ReadMcpResourceTool', {}, 'reading', 'reading', 'satisfied', 'got it'],
    ['ListMcpResourcesTool', {}, 'reading', 'reading', 'satisfied', 'got it'],
    ['SomeFutureTool', {}, 'thinking', 'some future tool', 'satisfied', 'step complete'],
    ['mcp__google_workspace__read_sheet_values', {}, 'reading', 'google workspace: read sheet values', 'satisfied', 'google workspace done'],
    ['mcp__plugin_github_github__create_pull_request', {}, 'coding', 'github: create pull request', 'satisfied', 'github done'],
    ['mcp__plugin_github_github__search_code', {}, 'searching', 'github: search code', 'satisfied', 'github done'],
    ['mcp__claude-in-chrome__navigate', {}, 'executing', 'claude-in-chrome: navigate', 'satisfied', 'claude-in-chrome done'],
    ['mcp__plugin_telegram_telegram__reply', {}, 'executing', 'telegram: reply', 'satisfied', 'telegram done'],
  ];

  function matches(actual, expected) {
    return expected instanceof RegExp ? expected.test(actual) : actual === expected;
  }

  for (const [tool, input, preState, preDetail, postState, postDetail] of table) {
    test(`${tool} -> pre ${preState} / post ${postState}`, () => {
      const pre = sm.toolToState(tool, input);
      assert.strictEqual(pre.state, preState, `pre state for ${tool}`);
      assert.ok(matches(pre.detail, preDetail), `pre detail for ${tool}: got ${JSON.stringify(pre.detail)}`);
      const post = sm.classifyToolResult(tool, input, { stdout: '', stderr: '' }, false);
      assert.strictEqual(post.state, postState, `post state for ${tool}`);
      assert.ok(matches(post.detail, postDetail), `post detail for ${tool}: got ${JSON.stringify(post.detail)}`);
    });
  }

  test('patch is an edit tool, not a review tool (REVIEW_TOOLS order was unreachable)', () => {
    assert.strictEqual(sm.REVIEW_TOOLS.test('patch'), false);
    assert.strictEqual(sm.toolToState('patch', {}).state, 'coding');
  });

  test('AskUserQuestion is recognised by an exported ASK_TOOLS pattern', () => {
    assert.ok(sm.ASK_TOOLS.test('AskUserQuestion'));
    assert.ok(!sm.ASK_TOOLS.test('Read'));
  });
});

describe('emotions -- humanizeToolName', () => {
  test('splits camelCase into lowercase words', () => {
    assert.strictEqual(sm.humanizeToolName('AskUserQuestion'), 'ask user question');
  });
  test('turns underscores and dashes into spaces', () => {
    assert.strictEqual(sm.humanizeToolName('kill-shell'), 'kill shell');
    assert.strictEqual(sm.humanizeToolName('read_sheet_values'), 'read sheet values');
  });
  test('drops the mcp__ prefix', () => {
    assert.strictEqual(sm.humanizeToolName('mcp__foo__bar_baz'), 'foo bar baz');
  });
  test('handles empty and non-string input', () => {
    assert.strictEqual(sm.humanizeToolName(''), '');
    assert.strictEqual(sm.humanizeToolName(undefined), '');
    assert.strictEqual(sm.humanizeToolName(42), '42');
  });
});

describe('emotions -- non-string tool inputs never throw', () => {
  test('Bash with an object command', () => {
    const r = sm.toolToState('Bash', { command: { a: 1 } });
    assert.strictEqual(r.state, 'executing');
    assert.strictEqual(r.detail, 'running command');
  });
  test('WebFetch with a numeric url', () => {
    const r = sm.toolToState('WebFetch', { url: 42 });
    assert.strictEqual(r.state, 'searching');
    assert.strictEqual(r.detail, 'searching "42"');
  });
  test('Agent with an array description', () => {
    const r = sm.toolToState('Agent', { description: ['x', 'y'] });
    assert.strictEqual(r.state, 'subagent');
    assert.strictEqual(r.detail, 'spawning subagent');
  });
  test('Grep with a null pattern', () => {
    const r = sm.toolToState('Grep', { pattern: null });
    assert.strictEqual(r.state, 'searching');
    assert.strictEqual(r.detail, 'searching');
  });
  test('Edit with an object file_path', () => {
    const r = sm.toolToState('Edit', { file_path: { nope: true } });
    assert.strictEqual(r.state, 'coding');
    assert.strictEqual(r.detail, 'writing code');
  });
  test('classifyToolResult with an object command', () => {
    const r = sm.classifyToolResult('Bash', { command: { a: 1 } }, { stdout: 'ok', stderr: '' }, false);
    assert.strictEqual(r.state, 'relieved');
  });
});

// -- Review round 5: shell commands name the right feeling ------------------

describe('emotions -- review round 5: shell commands map to specific states', () => {
  // [command, preState, postDetail] for a successful run printing "ok"
  const table = [
    ['./gradlew test', 'testing', 'tests passed'],
    ['gradlew.bat test', 'testing', 'tests passed'],
    ['./mvnw test', 'testing', 'tests passed'],
    ['mvnw verify', 'testing', 'tests passed'],
    ['node tests/run.js', 'testing', 'tests passed'],
    ['node test/index.js', 'testing', 'tests passed'],
    ['make lint', 'executing', 'make lint done'],
    ['make clean', 'executing', 'make clean done'],
    ['make format', 'executing', 'make format done'],
    ['make', 'executing', 'build succeeded'],
    ['cargo build', 'executing', 'build succeeded'],
    ['git -C ../app commit -m "wip"', 'committing', 'committed'],
    ['git --no-pager commit -m x', 'committing', 'committed'],
    ['git -c core.hooksPath=/dev/null push', 'committing', 'pushed!'],
    ['git --git-dir=.git commit -m x', 'committing', 'committed'],
  ];
  for (const [command, preState, postDetail] of table) {
    test(`${command} -> pre ${preState} / post "${postDetail}"`, () => {
      assert.strictEqual(sm.toolToState('Bash', { command }).state, preState);
      assert.strictEqual(sm.classifyToolResult('Bash', { command }, { stdout: 'ok', stderr: '' }, false).detail, postDetail);
    });
  }

  test('a background Bash is launched, and carries no verdict', () => {
    const norm = sm.normalizeToolResponse({ tool_response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } });
    const r = sm.classifyToolResult('Bash', { command: 'npm test', run_in_background: true }, norm, false);
    assert.deepStrictEqual([r.state, r.detail, r.neutral], ['satisfied', 'launched in background', true]);
  });

  test('a success the host vouched for keeps its reward face', () => {
    // [command, stdout] -- each read as an error before trustSuccess
    const rows = [
      ['git commit -m "fix syntax error in config loader"', '[fix 9f8e7d6] fix syntax error in config loader', 'committed'],
      ['npm test', '  loader\n    reports permission denied\n  1 passing', '1 tests passed'],
      ['git branch -vv', '* main 1a2b3c4 Fix permission denied on Windows', 'git done'],
    ];
    for (const [command, stdout, detail] of rows) {
      const r = sm.classifyToolResult('Bash', { command }, { stdout, stderr: '' }, false, { trustSuccess: true });
      assert.strictEqual(r.detail, detail, command);
    }
  });
});

// -- Result -> emotion -------------------------------------------------

describe('emotions -- normalizeToolResponse keeps the signals that mean trouble', () => {
  test('passes interrupted through', () => {
    const r = sm.normalizeToolResponse({ tool_response: { stdout: '', stderr: '', interrupted: true } });
    assert.strictEqual(r.interrupted, true);
  });
  test('passes isError through', () => {
    const r = sm.normalizeToolResponse({ tool_response: { stdout: 'x', isError: true } });
    assert.strictEqual(r.isError, true);
  });
  test('maps is_error (MCP style) to isError', () => {
    const r = sm.normalizeToolResponse({ tool_response: { stdout: 'x', is_error: true } });
    assert.strictEqual(r.isError, true);
  });
  test('passes a numeric exitCode through (exitCode or exit_code)', () => {
    assert.strictEqual(sm.normalizeToolResponse({ tool_response: { stdout: '', exitCode: 2 } }).exitCode, 2);
    assert.strictEqual(sm.normalizeToolResponse({ tool_response: { stdout: '', exit_code: 3 } }).exitCode, 3);
  });
  test('coerces non-string stdout/stderr to strings', () => {
    const r = sm.normalizeToolResponse({ tool_response: { stdout: 123, stderr: { a: 1 } } });
    assert.strictEqual(typeof r.stdout, 'string');
    assert.strictEqual(typeof r.stderr, 'string');
    assert.strictEqual(r.stdout, '123');
  });
  test('plain stdout/stderr objects gain no extra keys', () => {
    const r = sm.normalizeToolResponse({ tool_response: { stdout: 'a', stderr: 'b' } });
    assert.deepStrictEqual(r, { stdout: 'a', stderr: 'b' });
  });
});

describe('emotions -- interrupted and failed commands read as errors', () => {
  test('Esc-interrupted Bash is an error, not relieved (end to end)', () => {
    const norm = sm.normalizeToolResponse({ tool_response: { stdout: '', stderr: '', interrupted: true } });
    const r = sm.classifyToolResult('Bash', { command: 'sleep 100' }, norm, false);
    assert.strictEqual(r.state, 'error');
    assert.strictEqual(r.detail, 'interrupted');
  });
  test('numeric non-zero exitCode is an error', () => {
    const r = sm.classifyToolResult('Bash', { command: 'ls' }, { stdout: '', stderr: '', exitCode: 2 }, false);
    assert.strictEqual(r.state, 'error');
    assert.ok(/exit 2|something went wrong/.test(r.detail), r.detail);
  });
  test('exitCode 0 is still a success', () => {
    const r = sm.classifyToolResult('Bash', { command: 'ls' }, { stdout: 'ok', stderr: '', exitCode: 0 }, false);
    assert.strictEqual(r.state, 'relieved');
  });
  test('is_error from an MCP result is an error (end to end)', () => {
    const norm = sm.normalizeToolResponse({ tool_response: { stdout: 'boom', is_error: true } });
    const r = sm.classifyToolResult('mcp__x__y', {}, norm, false);
    assert.strictEqual(r.state, 'error');
  });
});

describe('emotions -- truncated-input event map covers every non-tool hook', () => {
  test('UserPromptSubmit -> thinking', () => {
    const r = sm.classifyTruncatedInput('UserPromptSubmit', '');
    assert.strictEqual(r.state, 'thinking');
    assert.strictEqual(r.detail, 'reading your message');
  });
  test('TeammateIdle -> waiting', () => {
    assert.strictEqual(sm.classifyTruncatedInput('TeammateIdle', '').state, 'waiting');
  });
  test('TaskCompleted -> happy', () => {
    assert.strictEqual(sm.classifyTruncatedInput('TaskCompleted', '').state, 'happy');
  });
});

// -- Linger rules ------------------------------------------------------

describe('emotions -- timing constants live in one exported table', () => {
  test('COMPLETION_MIN_SHOW_MS is 1800', () => {
    assert.strictEqual(face.COMPLETION_MIN_SHOW_MS, 1800);
  });
  test('MIN_DISPLAY_MS has every work state short and every reward state long', () => {
    const t = face.MIN_DISPLAY_MS;
    assert.strictEqual(t.coding, 1500);
    assert.strictEqual(t.reading, 1200);
    assert.strictEqual(t.executing, 1200);
    assert.strictEqual(t.happy, 4000);
    assert.strictEqual(t.error, 4000);
    for (const s of face.ACTIVE_WORK_STATES) {
      // responding keeps its 3s minimum on purpose (#67): it is the "final
      // answer" beat after Stop, not a tool that gets refreshed by events.
      if (s === 'responding') continue;
      assert.ok(t[s] <= 2500, `${s} min display should be short, got ${t[s]}`);
    }
    assert.strictEqual(t.responding, 3000);
  });
  test('_getMinDisplayMs reads the table', () => {
    const f = new face.ClaudeFace();
    assert.strictEqual(f._getMinDisplayMs('coding'), face.MIN_DISPLAY_MS.coding);
    assert.strictEqual(f._getMinDisplayMs('nonexistent'), 1000);
  });
});

describe('emotions -- a completion face keeps the screen for its guaranteed window', () => {
  function fresh(state) {
    const f = new face.ClaudeFace();
    f.setState(state);
    return f;
  }
  function pastWindow(f) {
    f.lastStateChange = f.now() - (face.COMPLETION_MIN_SHOW_MS + 100);
  }

  test('a newer completion inside the window is buffered, not shown', () => {
    const f = fresh('proud');
    f.setState('satisfied');
    assert.strictEqual(f.state, 'proud');
    assert.strictEqual(f.pendingState, 'satisfied');
  });
  test('a newer completion after the window replaces the old one', () => {
    const f = fresh('proud');
    pastWindow(f);
    f.setState('satisfied');
    assert.strictEqual(f.state, 'satisfied');
  });
  test('the newest completion wins the pending slot', () => {
    const f = fresh('proud');
    f.setState('satisfied');
    f.setState('happy');
    assert.strictEqual(f.pendingState, 'happy');
  });
  test('a pending completion flushes once the window passes, before its full min display', () => {
    const f = fresh('proud');
    f.setState('satisfied');
    assert.ok(f.minDisplayUntil > f.now() + 2000, 'proud min display should still be running');
    pastWindow(f);
    f.update(66);
    assert.strictEqual(f.state, 'satisfied');
    assert.strictEqual(f.pendingState, null);
  });
  test('work inside the window is buffered', () => {
    const f = fresh('proud');
    f.setState('reading');
    assert.strictEqual(f.state, 'proud');
    assert.strictEqual(f.pendingState, 'reading');
  });
  test('work after the window bypasses the completion', () => {
    const f = fresh('proud');
    pastWindow(f);
    f.setState('coding');
    assert.strictEqual(f.state, 'coding');
  });
  test('error always preempts, even inside the window', () => {
    const f = fresh('proud');
    f.setState('error', 'boom');
    assert.strictEqual(f.state, 'error');
  });
});

describe('emotions -- work that arrives while a completion is pending is not lost', () => {
  function pastWindow(f) {
    f.lastStateChange = f.now() - (face.COMPLETION_MIN_SHOW_MS + 100);
  }

  test('the work is remembered alongside the pending completion', () => {
    const f = new face.ClaudeFace();
    f.setState('proud');
    f.setState('satisfied');
    f.setState('reading', 'reading foo.js');
    assert.strictEqual(f.pendingState, 'satisfied', 'completion stays queued');
    assert.ok(f.pendingWork && f.pendingWork.state === 'reading', 'work is remembered');
    assert.strictEqual(f.pendingWork.detail, 'reading foo.js');
  });
  test('the remembered work resumes after the completion has had its window', () => {
    const f = new face.ClaudeFace();
    f.setState('proud');
    f.setState('satisfied');
    f.setState('reading', 'reading foo.js');
    pastWindow(f);
    f.update(66);
    assert.strictEqual(f.state, 'satisfied');
    assert.strictEqual(f.pendingState, 'reading', 'work promoted to pending');
    pastWindow(f);
    f.update(66);
    assert.strictEqual(f.state, 'reading');
    assert.strictEqual(f.stateDetail, 'reading foo.js');
    assert.strictEqual(f.pendingWork, null);
  });
  test('the newest work replaces older remembered work', () => {
    const f = new face.ClaudeFace();
    f.setState('proud');
    f.setState('satisfied');
    f.setState('reading');
    f.setState('coding');
    assert.strictEqual(f.pendingWork.state, 'coding');
  });
  test('a completion arriving clears remembered work (its tool is finished)', () => {
    const f = new face.ClaudeFace();
    f.setState('proud');
    f.setState('reading');
    assert.strictEqual(f.pendingState, 'reading');
    f.setState('satisfied');
    assert.strictEqual(f.pendingState, 'satisfied');
    assert.strictEqual(f.pendingWork, null);
  });
  test('applying any state directly clears remembered work', () => {
    const f = new face.ClaudeFace();
    f.setState('proud');
    f.setState('satisfied');
    f.setState('reading');
    f.setState('error');
    assert.strictEqual(f.state, 'error');
    assert.strictEqual(f.pendingWork, null);
  });
});

describe('emotions -- forceState', () => {
  test('applies immediately with the given min display and records the change', () => {
    const f = new face.ClaudeFace();
    f.setState('coding');
    f.setState('proud');           // buffered behind coding
    const before = f.stateChangeTimes.length;
    const now = f.now();
    f.forceState('responding', 'wrapping up', 3000);
    assert.strictEqual(f.state, 'responding');
    assert.strictEqual(f.stateDetail, 'wrapping up');
    assert.strictEqual(f.prevState, 'coding');
    assert.ok(Math.abs(f.minDisplayUntil - (now + 3000)) < 100);
    assert.strictEqual(f.pendingState, null);
    assert.strictEqual(f.pendingWork, null);
    assert.strictEqual(f.stateChangeTimes.length, before + 1);
    assert.strictEqual(f.timeline[f.timeline.length - 1].state, 'responding');
  });
  test('defaults the min display to the state table', () => {
    const f = new face.ClaudeFace();
    const now = f.now();
    f.forceState('responding');
    assert.ok(Math.abs(f.minDisplayUntil - (now + face.MIN_DISPLAY_MS.responding)) < 100);
  });
});

describe('emotions -- state sets are defined once', () => {
  test('face, renderer and grid share the shared.js sets', () => {
    assert.ok(shared.ACTIVE_WORK_STATES instanceof Set);
    assert.ok(shared.COMPLETION_STATES instanceof Set);
    assert.ok(shared.INTERRUPTIBLE_STATES instanceof Set);
    assert.strictEqual(face.ACTIVE_WORK_STATES, shared.ACTIVE_WORK_STATES);
    assert.strictEqual(face.COMPLETION_STATES, shared.COMPLETION_STATES);
    assert.strictEqual(renderer.ACTIVE_WORK_STATES, shared.ACTIVE_WORK_STATES);
    assert.strictEqual(renderer.COMPLETION_STATES, shared.COMPLETION_STATES);
    assert.strictEqual(grid.ACTIVE_WORK_STATES, shared.ACTIVE_WORK_STATES);
  });
  // (FRESH_READ_STATES went with the renderer's fresh-read block: see
  // "Review round 5 (renderer)" below for why that block had to go.)
});

// -- Display coverage ----------------------------------------------------

describe('emotions -- particles react to the new details', () => {
  test('asking the user spawns question particles', () => {
    const f = new face.ClaudeFace();
    f.setState('waiting', 'asking you');
    assert.ok(f.particles.particles.some(p => p.style === 'question'));
  });
  test('responding spawns echo particles', () => {
    const f = new face.ClaudeFace();
    f.setState('responding');
    assert.ok(f.particles.particles.some(p => p.style === 'echo'));
  });
});

describe('emotions -- every state has distinct orbital eyes', () => {
  const idle = (() => {
    const m = new grid.MiniFace('eyes-idle');
    m.blinkFrame = -1; m.frame = 0; m.state = 'idle';
    return m.getEyes();
  })();
  for (const s of ['starting', 'spawning', 'reviewing', 'training']) {
    test(`${s} orbital eyes differ from idle`, () => {
      const m = new grid.MiniFace('eyes-' + s);
      m.blinkFrame = -1; m.frame = 0; m.state = s;
      assert.notStrictEqual(m.getEyes(), idle);
    });
  }
});

describe('emotions -- thought pools exist for the quieter states', () => {
  for (const s of ['reviewing', 'responding', 'starting', 'spawning', 'caffeinated']) {
    test(`STATE_THOUGHTS.${s} is a non-empty pool`, () => {
      assert.ok(Array.isArray(STATE_THOUGHTS[s]) && STATE_THOUGHTS[s].length > 0);
    });
  }
});

// -- Hook plumbing -------------------------------------------------------

// Strict: a failing hook throws with its stderr instead of being tolerated.
// An object payload is JSON-encoded; a string ('' included) goes to stdin raw,
// and only stdin that is not JSON opens the catch path.
function runHook(event, input, env) {
  runUpdateState(event, input, env, { strict: true });
}

describe('emotions -- UserPromptSubmit tells the face Claude has started thinking', () => {
  test('hooks.json registers UserPromptSubmit', () => {
    const hooks = readJSON(path.join(ROOT, 'hooks', 'hooks.json')).hooks;
    assert.ok(hooks.UserPromptSubmit, 'missing UserPromptSubmit block');
    assert.ok(hooks.UserPromptSubmit[0].hooks[0].command.includes('update-state.js'));
  });
  test('setup.js installs UserPromptSubmit', () => {
    const setup = require('../setup');
    assert.ok(setup.HOOK_EVENTS.includes('UserPromptSubmit'),
      'the installer event list must carry UserPromptSubmit');
    const built = setup.buildFaceHooks('/somewhere/update-state.js');
    assert.ok(built.UserPromptSubmit, 'settings.json block missing UserPromptSubmit');
    assert.strictEqual(built.UserPromptSubmit[0].hooks[0].type, 'command');
    assert.ok(built.UserPromptSubmit[0].hooks[0].command.includes('update-state.js" UserPromptSubmit'),
      'the installed command must pass the event name through');
  });
  test('writes thinking / reading your message', () => {
    const { tmp, stateFile, env } = makeTempEnv('ups-1');
    try {
      runHook('UserPromptSubmit', { session_id: 'ups-1', prompt: 'hello' }, env);
      const st = readJSON(stateFile);
      assert.strictEqual(st.state, 'thinking');
      assert.strictEqual(st.detail, 'reading your message');
      assert.ok(!st.stopped, 'a prompt means the session is active again');
    } finally { cleanup(tmp); }
  });
  test('clears the stopped flag left by Stop', () => {
    const { tmp, stateFile, env } = makeTempEnv('ups-2');
    try {
      runHook('Stop', { session_id: 'ups-2' }, env);
      assert.strictEqual(readJSON(stateFile).stopped, true);
      runHook('UserPromptSubmit', { session_id: 'ups-2', prompt: 'again' }, env);
      const st = readJSON(stateFile);
      assert.strictEqual(st.state, 'thinking');
      assert.ok(!st.stopped);
    } finally { cleanup(tmp); }
  });
});

describe('emotions -- Notification types get distinct faces', () => {
  const cases = [
    ['permission_prompt', 'waiting', 'allow?'],
    ['idle_prompt', 'waiting', 'waiting for you'],
    ['elicitation_dialog', 'waiting', 'needs input'],
    ['auth_success', 'satisfied', 'signed in'],
    [undefined, 'waiting', 'needs attention'],
  ];
  for (const [type, state, detail] of cases) {
    test(`${type || '(none)'} -> ${state} / ${detail}`, () => {
      const { tmp, stateFile, env } = makeTempEnv('notif-' + (type || 'none'));
      try {
        const payload = { session_id: 'notif-' + (type || 'none'), message: 'x' };
        if (type) payload.notification_type = type;
        runHook('Notification', payload, env);
        const st = readJSON(stateFile);
        assert.strictEqual(st.state, state);
        assert.strictEqual(st.detail, detail);
      } finally { cleanup(tmp); }
    });
  }
});

describe('emotions -- an edit diff is counted from structuredPatch', () => {
  test('a same-length replacement reports +1 -1, not +2 -2', () => {
    const { tmp, stateFile, env } = makeTempEnv('diff-1');
    try {
      runHook('PostToolUse', {
        session_id: 'diff-1',
        tool_name: 'Edit',
        tool_input: { file_path: 'a.js', old_string: 'x\ny', new_string: 'x\nz' },
        tool_response: {
          filePath: 'a.js',
          structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' x', '-y', '+z'] }],
        },
      }, env);
      const st = readJSON(stateFile);
      assert.strictEqual(st.state, 'proud');
      assert.deepStrictEqual(st.diffInfo, { added: 1, removed: 1 });
      assert.ok(!('structuredPatch' in st), 'the patch itself must never be persisted');
    } finally { cleanup(tmp); }
  });

  test('without a patch the input-based fallback still fires', () => {
    const { tmp, stateFile, env } = makeTempEnv('diff-2');
    try {
      runHook('PostToolUse', {
        session_id: 'diff-2',
        tool_name: 'Edit',
        tool_input: { file_path: 'a.js', old_string: 'x\ny', new_string: 'x\nz' },
        tool_response: { filePath: 'a.js' },
      }, env);
      const st = readJSON(stateFile);
      assert.deepStrictEqual(st.diffInfo, { added: 2, removed: 2 });
    } finally { cleanup(tmp); }
  });
});

describe('emotions -- catch-path parity for team events', () => {
  // Unparseable stdin must still land the same face the try path would.
  const cases = [
    ['TeammateIdle', 'waiting', 'teammate idle'],
    ['TaskCompleted', 'happy', 'task done'],
    ['UserPromptSubmit', 'thinking', 'reading your message'],
  ];
  for (const [event, state, detail] of cases) {
    test(`empty stdin: ${event} -> ${state} / ${detail}`, () => {
      const { tmp, stateFile, env } = makeTempEnv('catch-' + event);
      try {
        runHook(event, '', env);
        const st = readJSON(stateFile);
        assert.strictEqual(st.state, state);
        assert.strictEqual(st.detail, detail);
      } finally { cleanup(tmp); }
    });
  }
});

// -- The renderer's timeout cascade -------------------------------------

const {
  idleCascade, buildTitle, noteNewWrite, LONG_TOOL_HOLD_MS, WAIT_HOLD_STALE_MS,
  IDLE_TIMEOUT, THINKING_TIMEOUT, SLEEP_TIMEOUT,
} = require('../renderer');

describe('emotions -- a long-running tool keeps its face', () => {
  test('executing is held while the file still says executing', () => {
    assert.strictEqual(idleCascade({ state: 'executing', sinceChangeMs: 30000, sessionActive: true, lingerMs: 0, fileState: 'executing' }), null);
  });

  test('executing degrades to thinking once the file names something else', () => {
    assert.strictEqual(idleCascade({ state: 'executing', sinceChangeMs: 9000, sessionActive: true, lingerMs: 0, fileState: 'relieved' }), 'thinking');
  });

  test('the hold has a cap', () => {
    assert.strictEqual(idleCascade({ state: 'executing', sinceChangeMs: LONG_TOOL_HOLD_MS + 1, sessionActive: true, lingerMs: 0, fileState: 'executing' }), 'thinking');
  });

  test('a stopped session is never held', () => {
    assert.strictEqual(idleCascade({ state: 'executing', sinceChangeMs: 9000, sessionActive: false, lingerMs: 0, fileState: 'executing' }), 'idle');
  });

  test('subagent work is held too', () => {
    assert.strictEqual(idleCascade({ state: 'subagent', sinceChangeMs: 120000, sessionActive: true, lingerMs: 0, fileState: 'subagent' }), null);
  });

  test('responding is never held -- it is a post-turn state, not a tool', () => {
    assert.strictEqual(idleCascade({ state: 'responding', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: true, lingerMs: 0, fileState: 'responding' }), 'thinking');
  });

  test('work still degrades before IDLE_TIMEOUT is reached (nothing changes early)', () => {
    assert.strictEqual(idleCascade({ state: 'coding', sinceChangeMs: 1000, sessionActive: true, lingerMs: 0, fileState: 'relieved' }), null);
  });
});

describe('emotions -- the timeout cascade keeps its pre-existing branches', () => {
  test('starting -> idle after 2.5s', () => {
    assert.strictEqual(idleCascade({ state: 'starting', sinceChangeMs: 2600, sessionActive: true, lingerMs: 0, fileState: 'starting' }), 'idle');
    assert.strictEqual(idleCascade({ state: 'starting', sinceChangeMs: 2400, sessionActive: true, lingerMs: 0, fileState: 'starting' }), null);
  });

  test('responding -> happy once the session ended', () => {
    assert.strictEqual(idleCascade({ state: 'responding', sinceChangeMs: 0, sessionActive: false, lingerMs: 0, fileState: 'responding' }), 'happy');
  });

  test('completion linger -> thinking while active, idle when stopped', () => {
    assert.strictEqual(idleCascade({ state: 'happy', sinceChangeMs: 5001, sessionActive: true, lingerMs: 5000, fileState: 'happy' }), 'thinking');
    assert.strictEqual(idleCascade({ state: 'happy', sinceChangeMs: 5001, sessionActive: false, lingerMs: 5000, fileState: 'happy' }), 'idle');
  });

  test('a completion inside its linger holds', () => {
    assert.strictEqual(idleCascade({ state: 'happy', sinceChangeMs: 4999, sessionActive: true, lingerMs: 5000, fileState: 'happy' }), null);
  });

  test('thinking -> idle after THINKING_TIMEOUT when active, IDLE_TIMEOUT when stopped', () => {
    assert.strictEqual(idleCascade({ state: 'thinking', sinceChangeMs: THINKING_TIMEOUT + 1, sessionActive: true, lingerMs: 0, fileState: 'thinking' }), 'idle');
    assert.strictEqual(idleCascade({ state: 'thinking', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: false, lingerMs: 0, fileState: 'thinking' }), 'idle');
    assert.strictEqual(idleCascade({ state: 'thinking', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: true, lingerMs: 0, fileState: 'thinking' }), null);
  });

  test('idle -> sleeping after SLEEP_TIMEOUT; sleeping holds', () => {
    assert.strictEqual(idleCascade({ state: 'idle', sinceChangeMs: SLEEP_TIMEOUT + 1, sessionActive: false, lingerMs: 0, fileState: 'idle' }), 'sleeping');
    assert.strictEqual(idleCascade({ state: 'idle', sinceChangeMs: SLEEP_TIMEOUT - 1, sessionActive: false, lingerMs: 0, fileState: 'idle' }), null);
    assert.strictEqual(idleCascade({ state: 'sleeping', sinceChangeMs: 999999, sessionActive: false, lingerMs: 0, fileState: 'idle' }), null);
  });

  test('waiting and error degrade like any other non-work state', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: true, lingerMs: 0, fileState: 'thinking' }), 'thinking');
    assert.strictEqual(idleCascade({ state: 'error', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: false, lingerMs: 0, fileState: 'error' }), 'idle');
    assert.strictEqual(idleCascade({ state: 'error', sinceChangeMs: IDLE_TIMEOUT - 1, sessionActive: false, lingerMs: 0, fileState: 'error' }), null);
  });

  // _executeSwap is a closure inside runUnifiedMode(), so this is a source-level
  // check: every path that changes which session is main must clear the file
  // state the hold is keyed on, or a promoted face inherits the old main's tool.
  test('every path that changes the main session clears lastAppliedState', () => {
    // There is now exactly one such path: adoptMain. The swap frame and the
    // policy's first pick both go through it, so clearing the per-session
    // trackers once there covers every route.
    const src = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
    const start = src.indexOf('function adoptMain(newId)');
    assert.ok(start > 0, 'adoptMain should be the single adoption path');
    const body = src.slice(start, src.indexOf('\n  }\n', start));
    assert.ok(body.includes('mainSessionId = newId;'), 'adoptMain should adopt the new session id');
    assert.ok(body.includes('lastAppliedState = null;'),
      'adoptMain must clear lastAppliedState when it changes the main session');
    // The old direct assignment sites are gone.
    assert.ok(!src.includes('mainSessionId = stateData.sessionId'));
    assert.ok(!src.includes('mainSessionId = incomingId'));
  });

  test('the renderer still exports the timeout constants it cascades on', () => {
    assert.strictEqual(IDLE_TIMEOUT, 8000);
    assert.strictEqual(THINKING_TIMEOUT, 45000);
    assert.strictEqual(SLEEP_TIMEOUT, 60000);
    assert.strictEqual(LONG_TOOL_HOLD_MS, 600000);
  });
});

describe('emotions -- waiting on the user is held, not degraded', () => {
  test('waiting is held forever while the file still says waiting', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 600000, sessionActive: false, lingerMs: 0, fileState: 'waiting' }), null);
  });

  test('the hold ignores sessionActive -- idle_prompt arrives after Stop', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: true, lingerMs: 0, fileState: 'waiting' }), null);
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: false, lingerMs: 0, fileState: 'waiting' }), null);
  });

  test('the hold has no cap on how long the face has shown', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: LONG_TOOL_HOLD_MS * 2, sessionActive: true, lingerMs: 0, fileState: 'waiting', fileAgeMs: 1000 }), null);
  });

  test('waiting still degrades once the file names something else', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 9000, sessionActive: true, lingerMs: 0, fileState: 'thinking' }), 'thinking');
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 9000, sessionActive: false, lingerMs: 0, fileState: 'thinking' }), 'idle');
  });

  test('a completion linger still wins over the waiting hold', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 5001, sessionActive: true, lingerMs: 5000, fileState: 'waiting' }), 'thinking');
  });
});

describe('emotions -- the waiting hold is bounded by state-file staleness', () => {
  // The hold cannot lean on the crash machinery: on win32 no `pid` is written,
  // so `editorDead` never arms and `lastStopped` can never flip if the user
  // hard-closes a terminal sitting on a permission prompt. Staleness of the
  // state file is the one signal available on every platform.
  const fresh = 60000;
  const stale = WAIT_HOLD_STALE_MS + 1;

  test('a fresh state file keeps the wait held', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 600000, sessionActive: true, lingerMs: 0, fileState: 'waiting', fileAgeMs: fresh }), null);
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 600000, sessionActive: false, lingerMs: 0, fileState: 'waiting', fileAgeMs: fresh }), null);
  });

  test('a stale state file degrades the wait to idle', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 600000, sessionActive: true, lingerMs: 0, fileState: 'waiting', fileAgeMs: stale }), 'idle');
  });

  test('it degrades to idle even while the session looks active -- nothing is running', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 600000, sessionActive: false, lingerMs: 0, fileState: 'waiting', fileAgeMs: stale }), 'idle');
  });

  test('the boundary itself still holds', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 600000, sessionActive: true, lingerMs: 0, fileState: 'waiting', fileAgeMs: WAIT_HOLD_STALE_MS }), null);
  });

  test('an omitted fileAgeMs is treated as fresh', () => {
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: 600000, sessionActive: true, lingerMs: 0, fileState: 'waiting' }), null);
  });

  test('the long-tool hold is untouched -- it has its own cap', () => {
    // A stale file does not shorten the work hold; only LONG_TOOL_HOLD_MS does.
    assert.strictEqual(idleCascade({ state: 'executing', sinceChangeMs: 30000, sessionActive: true, lingerMs: 0, fileState: 'executing', fileAgeMs: stale }), null);
    assert.strictEqual(idleCascade({ state: 'executing', sinceChangeMs: LONG_TOOL_HOLD_MS + 1, sessionActive: true, lingerMs: 0, fileState: 'executing', fileAgeMs: 0 }), 'thinking');
  });

  test('WAIT_HOLD_STALE_MS is exported and generous enough for a human pause', () => {
    assert.strictEqual(WAIT_HOLD_STALE_MS, 1800000);
    assert.ok(WAIT_HOLD_STALE_MS > LONG_TOOL_HOLD_MS,
      'the wait bound must outlast the longest sanctioned work hold');
  });

});

// The bound above is only as good as the clock it is keyed on. The first
// version keyed it on `lastMainUpdate`, which the renderer refreshes on every
// READ -- and it re-reads the unchanged state file every 2s (`forceRead`), so
// the age never exceeded ~2s and the bound could never fire. `noteNewWrite` is
// the clock, factored out precisely so that failure mode is testable without a
// live renderer.
describe('emotions -- the write clock behind the waiting bound', () => {
  test('a newer write timestamp advances the stamp', () => {
    assert.strictEqual(noteNewWrite(2000, 1000, 50000, 40000), 50000);
  });

  test('an unchanged timestamp does NOT advance the stamp -- this is the forced re-read', () => {
    assert.strictEqual(noteNewWrite(1000, 1000, 50000, 40000), 40000);
  });

  test('an out-of-order (older) write does not advance the stamp', () => {
    assert.strictEqual(noteNewWrite(500, 1000, 50000, 40000), 40000);
  });

  test('before the first write the stamp stays unset', () => {
    assert.strictEqual(noteNewWrite(0, 0, 50000, 0), 0);
  });

  // This is the round-1 defect, reproduced against the real functions: drive
  // the exact loop the renderer runs against an unchanged file, then feed the
  // resulting age to the real idleCascade.
  test('a crashed editor: 30 min of 2s forced re-reads let the bound fire', () => {
    const ts = 1000;           // the state file never changes again
    let stamp = 0;
    let now = 0;
    stamp = noteNewWrite(ts, 0, now, stamp);   // the last real write
    const firstStamp = stamp;
    // 1800 forced re-reads, 2s apart -- one hour of a hard-closed terminal.
    for (let i = 0; i < 1800; i++) {
      now += 2000;
      stamp = noteNewWrite(ts, ts, now, stamp);
    }
    assert.strictEqual(stamp, firstStamp, 'forced re-reads must not move the clock');
    const age = now - stamp;
    assert.ok(age > WAIT_HOLD_STALE_MS, `age ${age} should exceed the bound`);
    assert.strictEqual(
      idleCascade({ state: 'waiting', sinceChangeMs: age, sessionActive: true, lingerMs: 0, fileState: 'waiting', fileAgeMs: age }),
      'idle', 'the bound must actually fire for a crashed editor');
  });

  // The converse: a live editor keeps the hold alive indefinitely.
  test('a live editor: a new write every 30s holds the wait for an hour', () => {
    let ts = 1000;
    let stamp = 0;
    let now = 0;
    stamp = noteNewWrite(ts, 0, now, stamp);
    let prevTs = ts;
    for (let i = 0; i < 120; i++) {          // 120 x 30s = 1 hour
      for (let r = 0; r < 15; r++) {          // 15 forced re-reads between writes
        now += 2000;
        stamp = noteNewWrite(ts, prevTs, now, stamp);
      }
      prevTs = ts;
      ts += 30000;
      now += 0;
      stamp = noteNewWrite(ts, prevTs, now, stamp);
      const age = now - stamp;
      assert.ok(age <= WAIT_HOLD_STALE_MS, `age ${age} should stay inside the bound`);
      assert.strictEqual(
        idleCascade({ state: 'waiting', sinceChangeMs: now, sessionActive: true, lingerMs: 0, fileState: 'waiting', fileAgeMs: age }),
        null, 'a live editor must keep the wait held');
    }
  });

  test('a fresh write resets the clock after it has gone stale', () => {
    const args = { state: 'waiting', sinceChangeMs: 600000, sessionActive: true, lingerMs: 0, fileState: 'waiting' };
    let stamp = noteNewWrite(1000, 0, 0, 0);
    let now = WAIT_HOLD_STALE_MS + 5000;
    assert.strictEqual(idleCascade({ ...args, fileAgeMs: now - stamp }), 'idle');
    // The editor comes back and writes a genuinely newer timestamp.
    stamp = noteNewWrite(2000, 1000, now, stamp);
    assert.strictEqual(stamp, now, 'a real write must move the clock');
    assert.strictEqual(idleCascade({ ...args, fileAgeMs: now - stamp }), null);
  });

  // Source-level guard with teeth: the round-1 bug was not a missing string,
  // it was the clock being refreshed somewhere else. Pin the wiring.
  test('the renderer keys the bound on the write clock, never on the read marker', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
    assert.ok(!/fileAgeMs:\s*now - (lastMainUpdate|lastForceReadTime)/.test(src),
      'a read marker is refreshed by every forced re-read -- it must not key the bound');
    assert.ok(/lastNewWriteAt = noteNewWrite\(/.test(src),
      'the write clock should be advanced through noteNewWrite');
    // Declaration, adoptMain's per-session reset, and exactly one advancing
    // assignment. A second *advancing* site is how the read-path refresh would
    // creep back in; a reset to 0 cannot fake freshness, it can only forget.
    // `\s*=[^=]` so that a whitespace-free `lastNewWriteAt= Date.now()` cannot
    // sneak past, and so a comparison (`==`/`===`) is not miscounted.
    // The one other site is _executeSwap seeding the clock from the adopted
    // write's own JSON timestamp -- the write's age, not a read marker.
    // (Round 6: the clock is monotonic, so "none yet" is null -- that clock
    // can read 0 -- and the seed carries the write's age onto it.)
    const assignments = src.match(/lastNewWriteAt\s*=[^=]/g) || [];
    assert.strictEqual(assignments.length, 4,
      'lastNewWriteAt: declaration, the adoptMain reset, noteNewWrite, and the swap seed');
    const resets = src.match(/lastNewWriteAt\s*=\s*null\s*;/g) || [];
    assert.strictEqual(resets.length, 2, 'the declaration and the adoptMain reset');
    const seeds = src.match(/lastNewWriteAt\s*=\s*ts <= wallNow \? monoNow\(\) - \(wallNow - ts\)/g) || [];
    assert.strictEqual(seeds.length, 1, 'the swap seeds from the write timestamp');
    assert.strictEqual(assignments.length - resets.length - seeds.length, 1,
      'only noteNewWrite may move the write clock forward');
  });
});

describe('emotions -- the terminal title flashes for a long wait', () => {
  test('the calm title names the model and its status', () => {
    assert.strictEqual(buildTitle('claude', 'waiting', false),
      '\x1b]0;Code Crumb \u00b7 claude is waiting\x07');
  });

  test('the flashing title shouts for the user', () => {
    const flashed = buildTitle('claude', 'waiting', true);
    assert.ok(flashed.includes('WAITING FOR YOU'), 'flashed title should shout');
    assert.ok(flashed.startsWith('\x1b]0;') && flashed.endsWith('\x07'), 'flashed title should still be an OSC 0 sequence');
  });

  test('the two titles differ, so a title change alone is a new frame', () => {
    assert.notStrictEqual(buildTitle('codex', 'thinking', false), buildTitle('codex', 'thinking', true));
  });

  test('the frame dedupe key includes the title', () => {
    const src = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
    assert.ok(/const frameKey = _title \+ out;/.test(src),
      'the frame loop should dedupe on title + output, not output alone');
    assert.ok(!/if \(out === prevFrame\)/.test(src),
      'the old output-only dedupe should be gone');
  });
});

// -- Renderer fixes (Sep 2026 renderer review) ---------------------------

const RENDERER_SRC = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

describe('emotions -- an error face is never rescued away', () => {
  const { needsRescue, RESCUE_EXCLUDE } = renderer;

  test('error is excluded from the stopped/dead rescue', () => {
    assert.ok(RESCUE_EXCLUDE.has('error'));
    // The repro: a late PostToolUseFailure after Stop writes error + turnEnded.
    assert.strictEqual(needsRescue({ state: 'error' }, true, false), false);
    assert.strictEqual(needsRescue({ state: 'error' }, false, true), false);
  });

  test('the rescue still fires for work states and thinking once the turn is over', () => {
    for (const s of ['coding', 'executing', 'thinking', 'waiting', 'subagent']) {
      assert.strictEqual(needsRescue({ state: s }, true, false), true, `${s} after Stop`);
      assert.strictEqual(needsRescue({ state: s }, false, true), true, `${s} after editor death`);
    }
    assert.strictEqual(needsRescue({ state: 'coding' }, false, false), false, 'a live turn is never rescued');
  });

  test('a non-active error decays to idle after IDLE_TIMEOUT, not before', () => {
    assert.strictEqual(idleCascade({ state: 'error', sinceChangeMs: IDLE_TIMEOUT - 1, sessionActive: false, lingerMs: 0, fileState: 'error' }), null);
    assert.strictEqual(idleCascade({ state: 'error', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: false, lingerMs: 0, fileState: 'error' }), 'idle');
  });
});

describe('emotions -- a dead editor stays dead after the center moves away', () => {
  const { policySessions, pickMainSession } = renderer;
  const mk = (id, ts, extra = {}) => ({
    sessionId: id, parentSession: null, isTeammate: false, stopped: false,
    isStale: () => false, lastPromptAt: 0, lastUpdate: ts, _lastDataTimestamp: ts, ...extra,
  });

  test('the main is projected stopped while editorDead is set', () => {
    const s = policySessions([mk('A', 100)], { mainId: 'A', editorDead: true, deadSessions: new Map() });
    assert.strictEqual(s[0].stopped, true);
  });

  test('after adoptMain cleared editorDead, the recorded death still projects stopped', () => {
    const dead = new Map([['A', 100]]);
    const faces = [mk('A', 100, { lastPromptAt: 50 }), mk('B', 90, { lastPromptAt: 10 })];
    const sessions = policySessions(faces, { mainId: 'B', editorDead: false, deadSessions: dead });
    assert.strictEqual(sessions.find(x => x.id === 'A').stopped, true);
    // A has the higher attention; without the record it would win the center back.
    assert.strictEqual(pickMainSession({ sessions, currentId: 'B', pinnedId: null }).mainId, 'B');
    assert.ok(dead.has('A'), 'the record survives while no newer write arrives');
  });

  test('a newer write from the dead session (a resumed editor) revives it', () => {
    const dead = new Map([['A', 100]]);
    const faces = [mk('A', 101, { lastPromptAt: 50 }), mk('B', 90, { lastPromptAt: 10 })];
    const sessions = policySessions(faces, { mainId: 'B', editorDead: false, deadSessions: dead });
    assert.strictEqual(sessions.find(x => x.id === 'A').stopped, false);
    assert.ok(!dead.has('A'), 'the death record is dropped');
    assert.strictEqual(pickMainSession({ sessions, currentId: 'B', pinnedId: null }).mainId, 'A');
  });

  test('records for sessions whose file vanished are pruned', () => {
    const dead = new Map([['gone', 5], ['A', 100]]);
    policySessions([mk('A', 100)], { mainId: 'A', editorDead: false, deadSessions: dead });
    assert.ok(!dead.has('gone'));
    assert.ok(dead.has('A'));
  });

  test('other fields pass through unchanged', () => {
    const s = policySessions([mk('C', 7, { parentSession: 'A', isTeammate: true, lastPromptAt: 3, stopped: true, isStale: () => true })],
      { mainId: 'A', editorDead: false, deadSessions: new Map() });
    assert.deepStrictEqual(s[0], { id: 'C', parentSession: 'A', isTeammate: true, stopped: true, stale: true, attentionAt: 3, lastUpdate: 7 });
  });

  // Source lint: the tracker lives inside runUnifiedMode's closure, which the
  // suite cannot drive without spawning a TTY renderer.
  test('source: death detection records the session, and a newer write clears it', () => {
    // (Round 6 gates the inner test on the turn not being over: `!(...) && `.)
    assert.ok(/!isProcessAlive\(lastEditorPid\)\) markMainDead\(\);/.test(RENDERER_SRC));
    assert.ok(/deadSessions\.set\(mainSessionId, lastAppliedTimestamp\)/.test(RENDERER_SRC));
    assert.ok(/policySessions\(orbital\.faces\.values\(\),/.test(RENDERER_SRC));
  });
});

// Source lint: these three live in runUnifiedMode's closure and have no
// runtime observable short of a spawned TTY renderer (the scratchpad repros
// s1_startup / s5_resume cover them end to end).
describe('emotions -- renderer closure fixes (source lint)', () => {
  test('a startup-gated write is recorded as applied, not just skipped', () => {
    assert.ok(/if \(gate === 'record'\) \{[\s\S]{0,700}?lastAppliedTimestamp = ts;\s*lastAppliedState = stateData\.state;[\s\S]{0,400}?\}\s*return;/.test(RENDERER_SRC));
  });

  test('a newer write under a new pid retires the armed pid and clears editorDead', () => {
    assert.ok(/stateData\.pid && lastEditorPid && stateData\.pid !== lastEditorPid\s*&& isNewerWrite\(ts, lastAppliedTimestamp, now\)\) \{\s*lastEditorPid = 0;\s*editorDead = false;/.test(RENDERER_SRC));
  });

  test('resize runs the swap only while it is still pending', () => {
    assert.ok(/if \(swapTransition\.swapPending\(\)\) _executeSwap\(\);/.test(RENDERER_SRC));
  });

  test('the status-line subagent count is the main session’s live children', () => {
    assert.ok(/face\.subagentCount = \(minimal \|\| editorDead\) \? 0 : orbital\.liveChildCount\(\);/.test(RENDERER_SRC));
    assert.ok(!/face\.subagentCount = orbital\.getSortedFaces\(\)\.length/.test(RENDERER_SRC));
  });

  test('stdin chunks are split into keys before dispatch', () => {
    assert.ok(/for \(const key of splitKeys\(chunk\)\) handleKey\(key\);/.test(RENDERER_SRC));
  });
});

describe('emotions -- splitKeys tokenizes a stdin chunk', () => {
  const { splitKeys } = renderer;
  const ESC = '\u001b';

  test('a held arrow key yields one token per press', () => {
    assert.deepStrictEqual(splitKeys(`${ESC}[B${ESC}[B`), [`${ESC}[B`, `${ESC}[B`]);
    assert.deepStrictEqual(splitKeys(`${ESC}[A${ESC}[A${ESC}[A`), [`${ESC}[A`, `${ESC}[A`, `${ESC}[A`]);
  });

  test('plain characters split one per key', () => {
    assert.deepStrictEqual(splitKeys('qq'), ['q', 'q']);
    assert.deepStrictEqual(splitKeys('jk\r'), ['j', 'k', '\r']);
    assert.deepStrictEqual(splitKeys('\u0003'), ['\u0003']);
  });

  test('CSI with parameters stays whole, and its final byte is not a key', () => {
    assert.deepStrictEqual(splitKeys(`${ESC}[1;5Aq`), [`${ESC}[1;5A`, 'q']);
    assert.deepStrictEqual(splitKeys(`${ESC}[2~`), [`${ESC}[2~`]);
  });

  test('SS3 arrows stay whole', () => {
    assert.deepStrictEqual(splitKeys(`${ESC}OB${ESC}OA`), [`${ESC}OB`, `${ESC}OA`]);
  });

  test('a lone or truncated escape does not swallow what follows', () => {
    assert.deepStrictEqual(splitKeys(ESC), [ESC]);
    assert.deepStrictEqual(splitKeys(`${ESC}[`), [`${ESC}[`]);
    assert.deepStrictEqual(splitKeys(`${ESC}O`), [ESC, 'O']);
  });

  test('astral characters are one key, and junk input yields nothing', () => {
    assert.deepStrictEqual(splitKeys('😀q'), ['😀', 'q']);
    assert.deepStrictEqual(splitKeys(''), []);
    assert.deepStrictEqual(splitKeys(null), []);
  });
});

describe('emotions -- tmux mode decays like the face does', () => {
  const { tmuxDisplayState, THINKING_TIMEOUT } = renderer;
  const NOW = 10000000;
  const at = (ageMs) => NOW - ageMs;
  // [label, data, expected]
  const table = [
    ['fresh work shows', { state: 'coding', timestamp: at(1000) }, 'coding'],
    ['a running tool is held past the thinking timeout', { state: 'executing', timestamp: at(THINKING_TIMEOUT + 1000) }, 'executing'],
    ['a tool silent past LONG_TOOL_HOLD_MS rests', { state: 'executing', timestamp: at(LONG_TOOL_HOLD_MS + 1) }, 'idle'],
    ['thinking silent past THINKING_TIMEOUT rests', { state: 'thinking', timestamp: at(THINKING_TIMEOUT + 1) }, 'idle'],
    ['responding is not a tool', { state: 'responding', timestamp: at(THINKING_TIMEOUT + 1) }, 'idle'],
    ['a finished turn keeps its face briefly', { state: 'responding', stopped: true, timestamp: at(2000) }, 'responding'],
    ['a finished turn rests after IDLE_TIMEOUT', { state: 'responding', stopped: true, timestamp: at(IDLE_TIMEOUT + 1) }, 'idle'],
    ['a stopped late completion rests too', { state: 'happy', stopped: true, timestamp: at(IDLE_TIMEOUT + 1) }, 'idle'],
    ['waiting is held after Stop', { state: 'waiting', stopped: true, timestamp: at(600000) }, 'waiting'],
    ['waiting ends at the silence bound', { state: 'waiting', timestamp: at(WAIT_HOLD_STALE_MS + 1) }, 'idle'],
    ['no timestamp is treated as fresh', { state: 'coding' }, 'coding'],
    ['no state reads as idle', {}, 'idle'],
  ];
  for (const [label, data, expected] of table) {
    test(label, () => assert.strictEqual(tmuxDisplayState(data, NOW), expected));
  }

  // Was a source grep for the call; tmux mode's line is now a pure function.
  test('tmux mode uses it', () => {
    const { tmuxStatusLine } = renderer;
    const none = () => '';
    assert.ok(tmuxStatusLine({ state: 'executing', timestamp: at(LONG_TOOL_HOLD_MS + 1) }, NOW, none)
      .includes(renderer.PALETTES[0].themes.idle.status), 'the decayed state is what the line says');
    assert.ok(tmuxStatusLine({ state: 'executing', timestamp: at(1000) }, NOW, none)
      .includes(renderer.PALETTES[0].themes.executing.status));
  });
});

describe('emotions -- the startup gate never replays an old write', () => {
  const { startupGate } = renderer;
  const START = 10000000;
  // [label, ts, stopped, now, expected]
  const table = [
    ['a fresh live write at boot applies', START - 2000, false, START + 1000, 'apply'],
    ['a finished turn at boot is recorded', START - 2000, true, START + 1000, 'record'],
    ['a live write 30s older than boot is recorded', START - 30000, false, START + 1000, 'record'],
    ['after the window a fresh write applies', START + 6000, false, START + 7000, 'apply'],
    ['after the window a 30s-older write applies', START - 30000, false, START + 7000, 'apply'],
    ['after the window a 3-minute-older write is skipped', START - 180000, false, START + 7000, 'skip'],
    ['no timestamp applies at boot', 0, false, START + 1000, 'apply'],
  ];
  for (const [label, ts, stopped, now, expected] of table) {
    test(label, () => assert.strictEqual(startupGate(ts, stopped, now, START), expected));
  }
  // The regression: a write recorded at boot must not read as new after the
  // window, which the renderer checks with `ts > lastAppliedTimestamp`. The
  // gate says 'apply' for it post-window, so the record is what stops it.
  test('a write recorded at boot is the one later reads would re-apply', () => {
    const ts = START - 30000;
    assert.strictEqual(startupGate(ts, false, START + 1000, START), 'record');
    assert.strictEqual(startupGate(ts, false, START + 7000, START), 'apply');
  });
});

// -- Review round 5 (renderer) ------------------------------------------------
// Each test below was run against the pre-fix sources first and failed there.
// Most drive the real runtime through runUnifiedMode's seams -- a fake
// fs.watch, a fake scheduler that moves both clocks, a temp sessions folder --
// i.e. the closure the older source greps could only look at.

const os = require('os');
const { ansi } = require('../lib/themes');

// Both clocks, faked in lockstep: Date.now() (wall) and the face's monotonic
// one. `stepWall` moves only the wall clock, as NTP or a resumed VM does.
// (The pre-fix face read Date.now() for everything, so the same test drives
// it too -- and shows the freeze.)
function withClocks(fn) {
  const realNow = Date.now;
  let wall = realNow();
  let mono = 5000;
  Date.now = () => wall;
  if (face._setClock) face._setClock(() => mono);
  try {
    return fn({
      advance(ms) { wall += ms; mono += ms; },
      stepWall(ms) { wall += ms; },
      frames(f, ms) { for (let t = 0; t < ms; t += 66) { wall += 66; mono += 66; f.update(66); } },
      get wall() { return wall; },
    });
  } finally {
    Date.now = realNow;
    if (face._setClock) face._setClock(null);
  }
}

// A live runtime with everything that touches the outside world faked:
// fs.watch (h.handles, fire with h.handles[i].cb), the timers (h.runFor runs
// them in order, moving both clocks to each; `granularity` rounds every
// firing up to a timer tick, as Windows' 15.6ms one does), and the output
// (h.writes). The async ring loader is stubbed -- its callbacks would land
// after the test -- so tests call h.load() for a synchronous one.
function r5Runtime({ granularity = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crumb-r5-'));
  const realNow = Date.now;
  let wall = realNow();
  let mono = 1000;
  Date.now = () => wall;
  face._setClock(() => mono);
  const timers = [];
  let seq = 0;
  const schedule = (fn, ms) => {
    const t = { fn, due: mono + Math.max(0, ms || 0), seq: ++seq, live: true };
    timers.push(t);
    return t;
  };
  const cancel = (t) => { if (t) t.live = false; };
  const writes = [];
  const handles = [];
  const watch = (d, cb) => {
    const w = {
      dir: d, cb, closed: false, onError: null,
      on(ev, f) { if (ev === 'error') w.onError = f; return w; },
      close() { w.closed = true; },
    };
    handles.push(w);
    return w;
  };
  let exitCode = null;
  let rt;
  try {
    rt = renderer.runUnifiedMode({
      sessionsDir: dir, watch, schedule, cancel,
      write: (s) => { writes.push(s); }, exit: (c) => { exitCode = c; },
      installHandlers: false, start: false,
    });
  } catch (e) {
    Date.now = realNow;
    face._setClock(null);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  rt.orbital.loadSessionsAsync = () => {};
  const h = {
    rt, dir, writes, handles, timers, loopRuns: 0,
    get exitCode() { return exitCode; },
    get wall() { return wall; },
    get mono() { return mono; },
    advance(ms) { wall += ms; mono += ms; },
    stepWall(ms) { wall += ms; },
    file(id) { return path.join(dir, id + '.json'); },
    write(id, obj) {
      shared.writeJsonAtomic(h.file(id), { session_id: id, sessionId: id, editor: 'claude', timestamp: wall, ...obj });
    },
    load() { rt.orbital.loadSessions(null); },
    event(name) { handles[handles.length - 1].cb('change', name); },
    pending(fn) { return timers.filter(t => t.live && (!fn || t.fn === fn)); },
    runFor(ms) {
      const end = mono + ms;
      for (;;) {
        let next = null;
        for (const t of timers) {
          if (t.live && (!next || t.due < next.due || (t.due === next.due && t.seq < next.seq))) next = t;
        }
        if (!next) break;
        let at = Math.max(next.due, mono);
        if (granularity) at = Math.ceil(at / granularity - 1e-9) * granularity;
        if (at > end) break;
        wall += at - mono;
        mono = at;
        next.live = false;
        timers.splice(timers.indexOf(next), 1);
        if (next.fn === rt.loop) h.loopRuns++;
        next.fn();
      }
      wall += end - mono;
      mono = end;
    },
    titles() { return writes.join('').match(/\u001b\]0;[^\u0007]*\u0007/g) || []; },
    // Hand the real clocks back while a test awaits something real (a child
    // process exiting) -- every later test in the file runs meanwhile, and
    // fakes and restores the clocks itself -- then take them again.
    suspend() { Date.now = realNow; face._setClock(null); },
    resume() { Date.now = () => wall; face._setClock(() => mono); },
    done() {
      try { rt.dispose(); } catch {}
      Date.now = realNow;
      face._setClock(null);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

// Start a session `S` that the policy will pick as main, after the boot window.
function r5Session(h, data) {
  h.advance(6000);
  h.write('S', { lastPromptAt: h.wall - 10, ...data });
  h.load();
  h.rt.checkState();
  assert.strictEqual(h.rt.mainSession(), 'S', 'precondition: S is the main session');
}

describe('review round 5 -- one self-healing watcher on the sessions folder', () => {
  const { createDirWatcher, isPlainBasename } = renderer;
  const STORM = '\\\\?\\C:\\Users\\me\\.code-crumb-sessions';

  function fakeFs() {
    const st = { present: true, blocked: false, mkdirs: 0, handles: [], timers: [], ino: 1 };
    st.exists = () => st.present;
    st.mkdir = () => { st.mkdirs++; st.present = true; st.ino++; };
    st.stat = () => {
      if (!st.present) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      return { dev: 7, ino: st.ino };
    };
    st.watch = (dir, cb) => {
      if (st.blocked || !st.present) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
      const w = {
        cb, closed: false, onError: null,
        on(ev, f) { if (ev === 'error') w.onError = f; return w; },
        close() { w.closed = true; },
      };
      st.handles.push(w);
      return w;
    };
    st.schedule = (fn, ms) => { const t = { fn, ms, live: true }; st.timers.push(t); return t; };
    st.cancel = (t) => { t.live = false; };
    st.live = () => st.timers.filter(t => t.live);
    st.fire = () => { const t = st.live()[0]; if (t) { t.live = false; t.fn(); } return t; };
    return st;
  }
  function make(st) {
    const out = { events: [], reopened: 0 };
    out.w = createDirWatcher({
      dir: '/s', exists: st.exists, mkdir: st.mkdir, watch: st.watch, stat: st.stat,
      schedule: st.schedule, cancel: st.cancel,
      onEvent: (e, f) => out.events.push([e, f]), onReopen: () => { out.reopened++; },
    });
    return out;
  }

  test('a plain file event passes straight through', () => {
    const st = fakeFs();
    const m = make(st);
    st.handles[0].cb('change', 'a.json');
    st.handles[0].cb('rename', null);
    assert.deepStrictEqual(m.events, [['change', 'a.json'], ['rename', null]]);
    assert.strictEqual(st.handles[0].closed, false);
  });

  test('the win32 storm: an event naming the folder itself closes the handle on the first one', () => {
    const st = fakeFs();
    const m = make(st);
    for (let i = 0; i < 10000; i++) st.handles[0].cb('rename', STORM);
    assert.strictEqual(m.events.length, 0, 'none of the storm reaches the renderer');
    assert.strictEqual(st.handles[0].closed, true);
    assert.strictEqual(st.live().length, 1, 'one re-open is scheduled, not one per event');
    assert.strictEqual(st.live()[0].ms, 500);
  });

  test('it re-opens once the folder is back -- creating it if need be -- and says so', () => {
    const st = fakeFs();
    const m = make(st);
    st.present = false;
    st.handles[0].cb('rename', STORM);
    st.fire();
    assert.strictEqual(st.mkdirs, 1, 'the folder is created again (the hooks would anyway)');
    assert.strictEqual(st.handles.length, 2);
    assert.strictEqual(m.reopened, 1, 'the caller hears about it: events were missed');
    st.handles[1].cb('change', 'b.json');
    assert.deepStrictEqual(m.events, [['change', 'b.json']]);
    st.handles[0].cb('change', 'late.json');
    assert.strictEqual(m.events.length, 1, 'a late event from the closed handle is ignored');
  });

  test('a rename that leaves no folder behind closes it too (a platform that names the folder itself)', () => {
    const st = fakeFs();
    make(st);
    st.present = false;
    st.handles[0].cb('rename', '.code-crumb-sessions');
    assert.strictEqual(st.handles[0].closed, true);
  });

  test('an error event closes and re-opens', () => {
    const st = fakeFs();
    const m = make(st);
    st.handles[0].onError(new Error('EPERM'));
    assert.strictEqual(st.handles[0].closed, true);
    st.fire();
    assert.strictEqual(st.handles.length, 2);
    assert.strictEqual(m.reopened, 1);
  });

  test('the backoff doubles while the folder cannot be watched, is capped, and resets once healthy', () => {
    const st = fakeFs();
    make(st);
    st.blocked = true;
    st.handles[0].cb('rename', STORM);
    const delays = [];
    for (let i = 0; i < 6; i++) { delays.push(st.live()[0].ms); st.fire(); }
    assert.deepStrictEqual(delays, [500, 1000, 2000, 4000, 8000, 8000]);
    st.blocked = false;
    st.fire();
    assert.strictEqual(st.handles.length, 2, 'open again');
    st.handles[1].cb('change', 'x.json');
    st.handles[1].cb('rename', STORM);
    assert.strictEqual(st.live()[0].ms, 500, 'a healthy event starts the backoff afresh');
  });

  test('check() notices a folder that vanished without a word, and close() cancels a re-open', () => {
    const st = fakeFs();
    const m = make(st);
    m.w.check();
    assert.strictEqual(st.handles[0].closed, false, 'nothing to do while healthy');
    st.present = false;
    m.w.check();
    assert.strictEqual(st.handles[0].closed, true);
    assert.strictEqual(st.live().length, 1);
    m.w.close();
    assert.strictEqual(st.live().length, 0, 'no re-open after close');
  });

  test('a plain basename is a file in the folder; anything with a separator is not', () => {
    assert.strictEqual(isPlainBasename('abc.json'), true);
    assert.strictEqual(isPlainBasename('x.json.123.tmp'), true);
    for (const bad of [STORM, 'C:\\x\\y', '/tmp/s', 'a/b', '', '.', '..']) {
      assert.strictEqual(isPlainBasename(bad), false, bad);
    }
  });

  test('the renderer keeps one handle and fans every event out to the face and the ring', () => {
    const h = r5Runtime();
    try {
      assert.strictEqual(h.handles.length, 1, 'one fs.watch on the sessions folder (there were two)');
      let ringLoads = 0;
      h.rt.orbital.loadSessionsAsync = () => { ringLoads++; };
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.advance(2000);
      h.write('S', { state: 'reading', detail: 'read b.js' });
      h.event('S.json');
      assert.strictEqual(h.rt.face.state, 'reading', 'the main file event re-read it at once');
      for (let i = 0; i < 5; i++) h.event('other.json');
      h.runFor(100);
      assert.strictEqual(ringLoads, 1, 'one ring reload for the burst, 80ms after its first event');
    } finally { h.done(); }
  });

  test('deleting the folder under the renderer costs one event, and the new folder is watched', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      fs.rmSync(h.dir, { recursive: true, force: true });
      for (let i = 0; i < 1000; i++) h.handles[0].cb('rename', STORM);
      assert.strictEqual(h.handles[0].closed, true, 'the storming handle is closed');
      h.runFor(600);
      assert.strictEqual(h.handles.length, 2, 're-opened after the backoff');
      assert.ok(fs.existsSync(h.dir), 'on a recreated folder');
      assert.strictEqual(h.rt.trackers().watching, true);
      h.write('S', { state: 'reading', detail: 'read c.js' });
      h.advance(1600);
      h.event('S.json');
      assert.strictEqual(h.rt.face.state, 'reading', 'the face follows its file again');
    } finally { h.done(); }
  });
});

describe('review round 5 -- an allowed permission prompt is the tool, running', () => {
  const { permissionAnswered, isUnconfirmedPermission, PERMISSION_CONFIRM_MS, tmuxDisplayState, readState } = renderer;
  const T = 50000000;
  const wait = (extra = {}) => ({
    state: 'waiting', detail: 'allow Bash?', timestamp: T, waitKind: 'permission',
    waitConfirmed: false, editor: 'claude', permState: 'testing', permDetail: 'npm test', ...extra,
  });

  test('PERMISSION_CONFIRM_MS covers the 6s Notification timer with slack', () => {
    assert.strictEqual(PERMISSION_CONFIRM_MS, 8000);
  });

  // [label, write, ageMs, expected]
  const table = [
    ['an unconfirmed Claude Code wait 8s old was answered', wait(), 8000, true],
    ['not before the window', wait(), 7999, false],
    ['a confirmed wait is still a wait', wait({ waitConfirmed: true }), 60000, false],
    ['a write that does not say is still a wait (older hooks)', wait({ waitConfirmed: null }), 60000, false],
    ['no waitKind: an older hook', wait({ waitKind: '' }), 60000, false],
    ['codex has no Notification hook', wait({ editor: 'codex' }), 60000, false],
    ['opencode either', wait({ editor: 'opencode' }), 60000, false],
    ['no tool to show', wait({ permState: null }), 60000, false],
    ['responding is no tool', wait({ permState: 'responding' }), 60000, false],
    ['not a wait any more', wait({ state: 'relieved' }), 60000, false],
    ['no timestamp', wait({ timestamp: 0 }), 60000, false],
  ];
  for (const [label, w, age, expected] of table) {
    test(label, () => assert.strictEqual(permissionAnswered(w, (w.timestamp || T) + age), expected));
  }
  test('the shape check is the same minus the clock', () => {
    assert.strictEqual(isUnconfirmedPermission(wait()), true);
    assert.strictEqual(isUnconfirmedPermission(wait({ waitConfirmed: true })), false);
  });

  test('readState passes the contract through its sanitisers', () => {
    const t = makeTempEnv();
    try {
      const fp = path.join(t.tmp, 's.json');
      fs.writeFileSync(fp, JSON.stringify({
        state: 'waiting', timestamp: 5, waitKind: 'permission', waitConfirmed: false,
        permState: 'testing', permDetail: 'npm\ntest\u001b[2J', editor: 'claude',
      }));
      let s = readState(fp);
      assert.strictEqual(s.waitKind, 'permission');
      assert.strictEqual(s.waitConfirmed, false);
      assert.strictEqual(s.permState, 'testing');
      assert.strictEqual(s.permDetail, 'npm test[2J', 'one line, no control characters');
      fs.writeFileSync(fp, JSON.stringify({ state: 'waiting', timestamp: 5, waitConfirmed: 'false', permState: '__proto__', waitKind: { x: 1 } }));
      s = readState(fp);
      assert.strictEqual(s.waitConfirmed, null, 'a boolean or nothing');
      assert.strictEqual(s.permState, null, 'a known state or nothing');
      assert.strictEqual(s.waitKind, '');
    } finally { cleanup(t.tmp); }
  });

  test('tmux mode reads an answered prompt as its tool', () => {
    assert.strictEqual(tmuxDisplayState(wait(), T + 9000), 'testing');
    assert.strictEqual(tmuxDisplayState(wait({ waitConfirmed: true }), T + 9000), 'waiting');
    assert.strictEqual(tmuxDisplayState(wait({ editor: 'codex' }), T + 9000), 'waiting');
    assert.strictEqual(tmuxDisplayState(wait(), T + 7000), 'waiting');
  });

  function permWait(h, extra = {}) {
    h.write('S', {
      state: 'waiting', detail: 'allow Bash?', waitingOn: 'Bash:abc', waitKind: 'permission',
      waitConfirmed: false, permState: 'testing', permDetail: 'npm test', ...extra,
    });
    h.event('S.json');
  }

  test('the runtime: allowed, the 2-minute test run shows as the test run, then its result', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'testing', detail: 'npm test' });
      const preTs = h.wall;
      h.rt.loop();
      h.runFor(1500);
      permWait(h);
      assert.strictEqual(h.rt.face.state, 'waiting', 'the prompt is shown');
      h.runFor(7500);
      assert.strictEqual(h.rt.face.state, 'waiting', 'still inside the confirmation window');
      h.runFor(1000);
      assert.strictEqual(h.rt.face.state, 'testing', 'unconfirmed after 8s: allowed, and running');
      assert.strictEqual(h.rt.face.stateDetail, 'npm test');
      h.writes.length = 0;
      h.runFor(120000);
      assert.strictEqual(h.rt.face.state, 'testing', 'the long-tool hold keeps it');
      assert.ok(/still running/.test(h.rt.face.displayDetail(36)), h.rt.face.displayDetail(36));
      assert.ok(!h.titles().some(t => t.includes('WAITING FOR YOU')), 'the title never shouted');
      h.write('S', { state: 'relieved', detail: 'tests passed', answered: true, workState: 'testing', workSince: preTs });
      h.event('S.json');
      assert.strictEqual(h.rt.face.state, 'relieved', 'the PostToolUse lands as usual');
    } finally { h.done(); }
  });

  test('the runtime: a prompt its Notification confirmed keeps waiting, and escalates', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'testing', detail: 'npm test' });
      h.rt.loop();
      h.runFor(1500);
      permWait(h);
      h.runFor(6000);
      permWait(h, { waitConfirmed: true });
      h.runFor(3000);
      assert.strictEqual(h.rt.face.state, 'waiting');
      h.runFor(31000);
      assert.strictEqual(h.rt.face.state, 'waiting');
      assert.strictEqual(h.rt.face.waitEscalated(), true);
      assert.ok(h.titles().some(t => t.includes('WAITING FOR YOU')), 'the title flashes as before');
    } finally { h.done(); }
  });

  for (const [label, extra] of [
    ['another editor', { editor: 'codex' }],
    ['an older hook without the fields', { waitKind: undefined, waitConfirmed: undefined, permState: undefined }],
  ]) {
    test(`the runtime: ${label} keeps waiting exactly as before`, () => {
      const h = r5Runtime();
      try {
        r5Session(h, { state: 'testing', detail: 'npm test', editor: extra.editor || 'claude' });
        h.rt.loop();
        h.runFor(1500);
        permWait(h, extra);
        h.runFor(40000);
        assert.strictEqual(h.rt.face.state, 'waiting');
        assert.strictEqual(h.rt.face.waitEscalated(), true);
      } finally { h.done(); }
    });
  }

  test('the runtime: a session swapped in on an allowed prompt arrives as its tool', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.rt.loop();
      h.runFor(500);
      h.write('B', {
        state: 'waiting', detail: 'allow Bash?', waitingOn: 'Bash:x', waitKind: 'permission',
        waitConfirmed: false, permState: 'executing', permDetail: 'make', timestamp: h.wall - 20000,
        lastPromptAt: h.wall,
      });
      h.load();
      h.writes.length = 0;
      h.runFor(2000);
      assert.strictEqual(h.rt.mainSession(), 'B');
      assert.strictEqual(h.rt.face.state, 'executing');
      assert.strictEqual(h.rt.face.stateDetail, 'make');
      assert.ok(!h.titles().some(t => t.includes('WAITING FOR YOU')));
    } finally { h.done(); }
  });
});

describe('review round 5 -- a repeated reward drops the finished tool queued behind it', () => {
  test('two quick Reads: the second Read never comes back after its own reward', () => {
    withClocks((c) => {
      const f = new face.ClaudeFace();
      f.forceState('thinking', '');
      f.setState('reading', 'a.js');
      c.frames(f, 1500);
      f.setState('satisfied', 'read a.js');
      c.frames(f, 300);
      f.setState('reading', 'b.js');
      assert.strictEqual(f.pendingState, 'reading', 'precondition: queued inside the reward window');
      c.frames(f, 300);
      f.setState('satisfied', 'read b.js');
      assert.strictEqual(f.pendingState, null, 'the finished Read is dropped');
      let shown = false;
      for (let i = 0; i < 60; i++) { c.frames(f, 66); if (f.state === 'reading') shown = true; }
      assert.ok(!shown, 'reading b.js was drawn for a tool that had finished');
      assert.strictEqual(f.state, 'satisfied');
    });
  });

  test('a queued prompt survives the repeated reward; a queued newer reward does too', () => {
    const f = new face.ClaudeFace();
    f.setState('satisfied', 'read a.js');
    f.setState('waiting', 'allow?');
    assert.strictEqual(f.pendingState, 'waiting');
    f.setState('satisfied', 'read b.js');
    assert.strictEqual(f.pendingState, 'waiting', 'a prompt is no tool and still wants an answer');
    const g = new face.ClaudeFace();
    g.setState('satisfied', 'read a.js');
    g.setState('proud', 'saved b.js');
    g.setState('satisfied', 'read c.js');
    assert.strictEqual(g.pendingState, 'proud');
  });

  test('work remembered behind a queued reward goes with it; a remembered prompt stays', () => {
    const f = new face.ClaudeFace();
    f.setState('happy', 'agent done');
    f.setState('satisfied', 'read a.js');        // queued newer reward
    f.setState('reading', 'b.js');               // remembered behind it
    assert.deepStrictEqual(f.pendingWork, { state: 'reading', detail: 'b.js' });
    f.setState('happy', 'agent done');           // that tool, finished
    assert.strictEqual(f.pendingWork, null);
    const g = new face.ClaudeFace();
    g.setState('happy', 'agent done');
    g.setState('satisfied', 'read a.js');
    g.setState('waiting', 'allow?');
    g.setState('happy', 'agent done');
    assert.deepStrictEqual(g.pendingWork, { state: 'waiting', detail: 'allow?' });
  });
});

describe('review round 5 -- a wall clock stepped back freezes nothing', () => {
  const { startupGate } = renderer;

  test('the face: an hour back, the reward window still closes and the next tool shows', () => {
    withClocks((c) => {
      const f = new face.ClaudeFace();
      f.forceState('coding', 'edit a.js');
      c.advance(2000);
      f.setState('happy', 'agent done');
      c.advance(500);
      c.stepWall(-3600000);
      f.setState('coding', 'edit b.js');
      assert.strictEqual(f.pendingState, 'coding', 'queued inside the reward window');
      c.frames(f, 3000);
      assert.strictEqual(f.state, 'coding', 'the window closed on time');
      assert.strictEqual(f.stateDetail, 'edit b.js');
    });
  });

  test('the face: a tool that outlives the step still counts up', () => {
    withClocks((c) => {
      const f = new face.ClaudeFace();
      f.forceState('executing', 'npm test');
      c.advance(1000);
      c.stepWall(-3600000);
      c.frames(f, 9000);
      assert.ok(/still running \u2026 10s/.test(f.displayDetail(60)), f.displayDetail(60));
    });
  });

  test('the face: the caffeine window is monotonic too', () => {
    withClocks((c) => {
      const f = new face.ClaudeFace();
      for (const s of ['reading', 'coding', 'searching', 'reading', 'coding']) {
        f.forceState(s, 'x');
        c.advance(100);
      }
      c.stepWall(3600000);   // forward: the burst is still 0.5s old
      f.minDisplayUntil = 0;
      f.update(66);
      assert.strictEqual(f.state, 'caffeinated');
    });
  });

  test('startupGate: the boot window is the monotonic uptime, not the wall clock', () => {
    // Up 10 minutes, stepped back 10: by the wall clock it has "just started",
    // and every turn end was recorded instead of shown.
    const START = 1e12;
    assert.strictEqual(startupGate(START - 50, true, START, START, 600000), 'apply');
    // The renderer hands over the start re-expressed on today's wall clock
    // (now - uptime), so a bigger step cannot make every fresh write look
    // older than the renderer either. Up 10 minutes, stepped back 20:
    const now = START + 600000 - 1200000;
    assert.strictEqual(startupGate(now - 50, false, now, now - 600000, 600000), 'apply',
      'every live write was recorded for as long as the step');
    // Up an hour, stepped back two: the start, on today's wall clock.
    const now2 = START + 3600000 - 7200000;
    assert.strictEqual(startupGate(now2 - 50, false, now2, now2 - 3600000, 3600000), 'apply');
    assert.strictEqual(startupGate(now2 - 50, true, now2, now2 - 3600000, 3600000), 'apply');
  });

  test('startupGate: a turn that ends after the renderer started is shown, even at boot', () => {
    const START = 1e12;
    assert.strictEqual(startupGate(START + 1500, true, START + 2000, START, 2000), 'apply',
      'a StopFailure at t+2s was recorded, and its error rescued into done!');
    assert.strictEqual(startupGate(START - 100, true, START + 1000, START, 1000), 'record',
      'one that ended before the start is still not resurrected');
    assert.strictEqual(startupGate(0, true, START + 1000, START, 1000), 'record');
  });

  test('the runtime: writes made after the step are read, shown and timed out as usual', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.rt.loop();
      h.runFor(2000);
      assert.strictEqual(h.rt.face.state, 'coding');
      const m = fs.statSync(h.file('S')).mtimeMs;
      h.stepWall(-3600000);
      h.write('S', { state: 'satisfied', detail: 'read b.js' });
      // The OS stamps the file with the stepped clock too: an OLDER mtime.
      const old = new Date(m - 3600000);
      fs.utimesSync(h.file('S'), old, old);
      h.runFor(2500);
      assert.strictEqual(h.rt.face.state, 'satisfied', 'the write after the step was read');
      h.runFor(8000);
      assert.strictEqual(h.rt.face.state, 'thinking', 'and its linger ran out on time');
    } finally { h.done(); }
  });

  test('the runtime: a swapped-in tool keeps its age on the face clock', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.rt.loop();
      h.runFor(500);
      h.write('B', { state: 'executing', detail: 'make', timestamp: h.wall - 30000, lastPromptAt: h.wall });
      h.load();
      h.runFor(2000);
      assert.strictEqual(h.rt.mainSession(), 'B');
      assert.strictEqual(h.rt.face.state, 'executing');
      const held = h.rt.face.heldMs();
      assert.ok(held >= 30000 && held < 34000, `held ${held}ms`);
    } finally { h.done(); }
  });
});

describe('review round 5 -- text from a state file never reaches the terminal raw', () => {
  const { readState } = renderer;
  const EVIL = 'x\u001b]0;owned\u0007\n\u001b[2J.js';

  function readObj(obj) {
    const t = makeTempEnv();
    try {
      const fp = path.join(t.tmp, 's.json');
      fs.writeFileSync(fp, JSON.stringify(obj));
      return readState(fp);
    } finally { cleanup(t.tmp); }
  }

  test('frequentFiles keys are one printable line before the idle thought prints one', () => {
    const s = readObj({ state: 'idle', timestamp: 5, frequentFiles: { [EVIL]: 7 } });
    const keys = Object.keys(s.frequentFiles);
    assert.strictEqual(keys.length, 1);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(keys[0]), JSON.stringify(keys[0]));
    const f = new face.ClaudeFace();
    f.accessoriesEnabled = false;
    f.forceState('idle', '');
    f.setStats(s);
    let frame = null;
    for (let i = 0; i < 400 && !frame; i++) {
      f.thoughtIndex = i;
      f._updateThought();
      if (f.thoughtText.includes('back to')) frame = f.render();
    }
    assert.ok(frame, 'the thought was drawn');
    assert.ok(!frame.includes('\u001b]0;owned'), 'no OSC title from a file name');
    assert.ok(!frame.includes('\u001b[2J'), 'no clear-screen from a file name');
  });

  test('a key with nothing printable left, or a count that is no number, is dropped', () => {
    const t = makeTempEnv();
    try {
      const fp = path.join(t.tmp, 's.json');
      // Raw JSON: an object literal's `__proto__` would set a prototype, not a key.
      fs.writeFileSync(fp, '{"state":"idle","timestamp":5,"frequentFiles":'
        + '{"\\u001b\\u0007\\n":9,"a.js":"x\\u001b[2J","b.js":4,"__proto__":3}}');
      const s = readState(fp);
      assert.deepStrictEqual(Object.keys(s.frequentFiles).sort(), ['__proto__', 'b.js']);
      assert.strictEqual(s.frequentFiles.__proto__, 3, '__proto__ is just a file name');
    } finally { cleanup(t.tmp); }
  });

  test('a milestone must be a known type with a positive integer value', () => {
    const at = Date.now();
    for (const bad of [{ type: 'streak', value: -100, at }, { type: 'streak', value: 'x\u001b]0;owned\u0007', at },
      { type: 'streak', value: 2.5, at }, { type: 'other', value: 25, at }, { type: 'streak', value: 25 }, 'x', [1]]) {
      assert.strictEqual(readObj({ state: 'happy', timestamp: 5, milestone: bad }).milestone, null, JSON.stringify(bad));
    }
    assert.deepStrictEqual(readObj({ state: 'happy', timestamp: 5, milestone: { type: 'streak', value: 25, at } }).milestone,
      { type: 'streak', value: 25, at });
  });

  test('a hostile milestone handed to the face directly cannot break render()', () => {
    for (const value of [-100, 'x\u001b]0;owned\u0007']) {
      const f = new face.ClaudeFace();
      f.forceState('happy', 'done');
      f.setStats({ milestone: { type: 'streak', value, at: Date.now() } });
      const out = f.render();
      assert.ok(!out.includes('\u001b]0;owned'));
    }
  });

  test('counters are numbers, or 0', () => {
    const s = readObj({ state: 'idle', timestamp: 5, toolCalls: 'x\u001b[2J', streak: '9', filesEdited: 3,
      diffInfo: { added: '1\u001b[2J', removed: 2 } });
    assert.strictEqual(s.toolCalls, 0);
    assert.strictEqual(s.streak, 0);
    assert.strictEqual(s.filesEdited, 3);
    assert.deepStrictEqual(s.diffInfo, { added: 0, removed: 2 });
  });
});

describe('review round 5 -- a failed read is not data', () => {
  const { readState } = renderer;

  test('readState marks every non-read as failed, and a good read as not', () => {
    const t = makeTempEnv();
    try {
      const fp = path.join(t.tmp, 's.json');
      assert.strictEqual(readState(path.join(t.tmp, 'missing.json')).failed, true);
      for (const raw of ['', '   ', '{"state":"cod', 'null', '[1,2]', '7']) {
        fs.writeFileSync(fp, raw);
        const s = readState(fp);
        assert.strictEqual(s.failed, true, JSON.stringify(raw));
        assert.strictEqual(s.state, 'idle', 'still idle for callers that only look at that');
      }
      fs.writeFileSync(fp, JSON.stringify({ state: 'coding', timestamp: 5 }));
      assert.ok(!readState(fp).failed);
    } finally { cleanup(t.tmp); }
  });

  test('the runtime: a torn read between turns leaves the turn over', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.advance(2100);
      h.write('S', { state: 'idle', detail: 'between turns', turnEnded: true });
      h.rt.checkState();
      assert.strictEqual(h.rt.trackers().lastStopped, true, 'precondition: the turn is over');
      h.advance(2100);
      fs.writeFileSync(h.file('S'), '{"state":"coding","timesta');   // torn
      h.rt.checkState();
      const tr = h.rt.trackers();
      assert.strictEqual(tr.lastStopped, true, 'a torn read made the session active again');
      assert.strictEqual(tr.lastAppliedState, 'responding');
    } finally { h.done(); }
  });
});

describe('review round 5 -- tmux mode names the session\'s own branch', () => {
  const { tmuxStatusLine } = renderer;
  test('no gitBranch in the write: the branch of the write\'s cwd, never the tmux process\'s', () => {
    const asked = [];
    const branchOf = (cwd) => { asked.push(cwd); return cwd === '/repo' ? 'feature-x' : 'WRONG'; };
    const line = tmuxStatusLine({ state: 'coding', timestamp: 0, cwd: '/repo' }, 1, branchOf);
    assert.ok(line.includes('[feature-x]'), line);
    assert.deepStrictEqual(asked, ['/repo']);
  });
  test('no cwd, no branch -- and a gitBranch in the write needs no lookup', () => {
    const asked = [];
    const branchOf = (cwd) => { asked.push(cwd); return 'WRONG'; };
    assert.ok(!tmuxStatusLine({ state: 'coding', timestamp: 0 }, 1, branchOf).includes('['
      + 'WRONG'), 'no lookup without a cwd');
    assert.ok(tmuxStatusLine({ state: 'coding', timestamp: 0, gitBranch: 'main', cwd: '/r' }, 1, branchOf).includes('[main]'));
    assert.deepStrictEqual(asked, []);
  });
});

describe('review round 5 -- quitting and crashing put the terminal back', () => {
  const PID = path.join(shared.HOME, '.code-crumb.pid');

  test('the restore resets the title (empty OSC 0, then the title stack pop)', () => {
    const r = renderer.TERMINAL_RESTORE;
    assert.ok(r.includes('\u001b]0;\u0007'), 'an empty title: Windows Terminal shows the profile title again');
    assert.ok(r.includes('\u001b[23;0t'), 'XTPOPTITLE where there is a title stack');
    assert.ok(r.includes(ansi.show), 'the cursor comes back');
    assert.ok(r.indexOf('\u001b]0;\u0007') < r.indexOf('\u001b[23;0t'), 'the pop wins where it is understood');
  });

  test('cleanup writes it, writes the quit flag and exits 0', () => {
    const h = r5Runtime();
    try {
      h.rt.cleanup();
      assert.strictEqual(h.exitCode, 0);
      assert.ok(h.writes[h.writes.length - 1].includes(renderer.TITLE_RESET));
      assert.ok(fs.existsSync(shared.QUIT_FLAG_FILE), 'a quit is a quit');
    } finally {
      try { fs.unlinkSync(shared.QUIT_FLAG_FILE); } catch {}
      h.done();
    }
  });

  test('a crash restores the terminal and drops the PID file, but never writes the quit flag', () => {
    const h = r5Runtime();
    const realErr = process.stderr.write;
    let err = '';
    try {
      fs.writeFileSync(PID, '12345');
      try { fs.unlinkSync(shared.QUIT_FLAG_FILE); } catch {}
      process.stderr.write = (s) => { err += s; return true; };
      h.rt.crash(new Error('r5 boom'));
      process.stderr.write = realErr;
      assert.strictEqual(h.exitCode, 1);
      assert.ok(h.writes[h.writes.length - 1].includes(renderer.TERMINAL_RESTORE));
      assert.ok(!fs.existsSync(PID), 'a dead renderer must not look alive');
      assert.ok(!fs.existsSync(shared.QUIT_FLAG_FILE), 'autolaunch must be free to bring it back');
      assert.ok(err.includes('r5 boom'));
    } finally {
      process.stderr.write = realErr;
      try { fs.unlinkSync(PID); } catch {}
      h.done();
    }
  });

  test('the frame loop survives a throw in face.update or the session list', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.rt.face.update = () => { throw new Error('update'); };
      h.rt.orbital.getSortedFaces = () => { throw new Error('list'); };
      h.rt.face.showSessionList = true;
      h.rt.loop();
      assert.strictEqual(h.pending(h.rt.loop).length, 1, 'the next frame is still scheduled');
    } finally { h.done(); }
  });

  for (const how of ['throw', 'reject']) {
    test(`a real renderer that dies by ${how === 'throw' ? 'an uncaught exception' : 'an unhandled rejection'} exits 1, terminal restored`, () => {
      const t = makeTempEnv();
      try {
        const pidFile = path.join(t.tmp, '.code-crumb.pid');
        const script = [
          `const r = require(${JSON.stringify(path.join(ROOT, 'renderer.js'))});`,
          `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
          'r.runUnifiedMode();',
          how === 'throw'
            ? "setTimeout(() => { throw new Error('r5-crash'); }, 300);"
            : "setTimeout(() => { Promise.reject(new Error('r5-crash')); }, 300);",
        ].join('\n');
        const res = require('child_process').spawnSync(process.execPath, ['-e', script], {
          env: t.env, encoding: 'utf8', timeout: 20000,
        });
        assert.strictEqual(res.status, 1, `exit ${res.status}, stderr: ${res.stderr}`);
        assert.ok(res.stdout.includes(renderer.TERMINAL_RESTORE), 'cursor, screen and title restored');
        assert.ok(res.stderr.includes('r5-crash'), 'and the error is reported');
        assert.ok(!fs.existsSync(pidFile), 'the PID file is gone');
        assert.ok(!fs.existsSync(path.join(t.tmp, '.code-crumb-quit')), 'no quit flag');
      } finally { cleanup(t.tmp); }
    });
  }
});

describe('review round 5 -- no fresh-read block: a turn end between forced reads waits for one', () => {
  // Coarse mtimes (FAT, some network shares): the next write keeps the mtime,
  // so only the forced read every 2s sees it. The fresh-read block used to
  // see a thinking face's turn end first, stamp it applied without showing it,
  // and leave the rescue to turn the turn into "done!".
  // Whole seconds, so the pinned mtime reads back exactly.
  function pinMtime(h) {
    const t = new Date(Math.floor(fs.statSync(h.file('S')).mtimeMs / 1000) * 1000);
    fs.utimesSync(h.file('S'), t, t);
    return t;
  }

  test('a StopFailure right after thinking shows its error', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'thinking', detail: 'reading your message' });
      const m = pinMtime(h);
      h.advance(2050);
      h.rt.checkState();                         // the forced read
      h.advance(50);
      h.write('S', { state: 'error', detail: 'API error', turnEnded: true });
      fs.utimesSync(h.file('S'), m, m);
      h.advance(500);
      h.rt.checkState();                         // not forced, mtime unchanged
      assert.strictEqual(h.rt.face.state, 'thinking', 'not seen yet');
      h.advance(1500);
      h.rt.checkState();                         // forced
      assert.strictEqual(h.rt.face.state, 'error');
      assert.strictEqual(h.rt.face.stateDetail, 'API error');
    } finally { h.done(); }
  });

  test('a Stop the mtime check missed is still rescued into responding -> happy', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'executing', detail: 'npm test' });
      const m = pinMtime(h);
      h.advance(2050);
      h.rt.checkState();
      h.advance(50);
      h.write('S', { state: 'idle', detail: 'between turns', turnEnded: true });
      fs.utimesSync(h.file('S'), m, m);
      h.advance(500);
      h.rt.checkState();
      assert.strictEqual(h.rt.face.state, 'executing', 'not seen yet');
      h.advance(1500);
      h.rt.checkState();
      assert.strictEqual(h.rt.face.state, 'responding');
      h.advance(3100);
      h.rt.checkState();
      assert.strictEqual(h.rt.face.state, 'happy');
    } finally { h.done(); }
  });
});

describe('review round 5 -- frames on deadlines, and a resting face at low power', () => {
  const { nextFrameDeadline, canRestLowPower, FRAME_INTERVAL_MS, LOW_POWER_FRAME_MS, LOW_POWER_FPS } = renderer;

  test('nextFrameDeadline: a late frame is made up, a lost second is not burst through', () => {
    assert.strictEqual(nextFrameDeadline(1000, 1000, 50), 1050);
    assert.strictEqual(nextFrameDeadline(1000, 1060, 50), 1050, 'late by less than a frame: due at once');
    assert.strictEqual(nextFrameDeadline(1000, 1101, 50), 1101, 'behind by more: start again from now');
    assert.strictEqual(LOW_POWER_FPS, 4);
    assert.strictEqual(LOW_POWER_FRAME_MS, 250);
    assert.ok(Math.abs(FRAME_INTERVAL_MS - 1000 / 15) < 1e-9);
  });

  test('canRestLowPower: only a resting face with nothing else moving', () => {
    const base = () => {
      const f = new face.ClaudeFace();
      f.state = 'idle';
      f.particles.particles.length = 0;
      f.blinkFrame = -1;
      return f;
    };
    let f = base();
    assert.strictEqual(canRestLowPower(f), true);
    f.particles.spawn(2, 'float');
    assert.strictEqual(canRestLowPower(f), true, 'its own slow drift does not count');
    f.state = 'sleeping';
    f.particles.spawn(1, 'zzz');
    assert.strictEqual(canRestLowPower(f), true);
    const no = [
      ['busy state', (g) => { g.state = 'coding'; }],
      ['waiting', (g) => { g.state = 'waiting'; }],
      ['something queued', (g) => { g.pendingState = 'reading'; }],
      ['a sparkle', (g) => { g.particles.spawn(1, 'sparkle'); }],
      ['help open', (g) => { g.showHelp = true; }],
      ['list open', (g) => { g.showSessionList = true; }],
      ['being petted', (g) => { g.petTimer = 5; }],
      ['afterglow', (g) => { g.petAfterglowTimer = 5; }],
      ['blinking', (g) => { g.blinkFrame = 1; }],
      ['glitching', (g) => { g.glitchIntensity = 0.2; }],
    ];
    for (const [label, mut] of no) {
      f = base();
      mut(f);
      assert.strictEqual(canRestLowPower(f), false, label);
    }
    assert.strictEqual(canRestLowPower(base(), { transitionActive: true }), false, 'a swap');
    assert.strictEqual(canRestLowPower(base(), { orbitalsBusy: true }), false, 'a busy orbital');
  });

  test('15 frames a second on a 15.6ms timer tick (re-arming 66ms after each frame gave ~13)', () => {
    const h = r5Runtime({ granularity: 15.625 });
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.rt.loop();
      h.loopRuns = 0;
      h.runFor(3000);
      assert.ok(h.loopRuns >= 44 && h.loopRuns <= 46, `${h.loopRuns} frames in 3s`);
    } finally { h.done(); }
  });

  test('a resting face drops to ~4 fps, and an event, a key or a resize wakes it at once', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'idle', detail: '' });
      h.rt.loop();
      h.runFor(5000);
      assert.strictEqual(h.rt.face.state, 'idle');
      h.loopRuns = 0;
      h.runFor(10000);
      assert.ok(h.loopRuns < 75, `${h.loopRuns} frames in 10s at rest (150 at full rate)`);
      for (const [label, poke] of [
        ['a watcher event', () => h.event('other.json')],
        ['a key', () => { h.rt.onKeys('h'); h.rt.onKeys('x'); }],
        ['a resize', () => h.rt.onResize()],
      ]) {
        h.runFor(2000);
        let guard = 0;
        while (h.rt.trackers().frameInterval !== LOW_POWER_FRAME_MS && guard++ < 50) h.runFor(250);
        assert.strictEqual(h.rt.trackers().frameInterval, LOW_POWER_FRAME_MS, `${label}: resting first`);
        poke();
        const next = h.pending(h.rt.loop);
        assert.strictEqual(next.length, 1, label);
        assert.strictEqual(next[0].due, h.mono, `${label} draws the next frame now`);
      }
    } finally { h.done(); }
  });
});

// -- Review round 6 (renderer) ------------------------------------------------
// Each test below was run against the pre-fix sources first and failed there.

// A write the renderer can tell from the last one by its mtime. These tests
// write faster than the filesystem's timestamp tick (a jiffy on Linux), and a
// file rewritten inside one keeps its mtime -- the change is then seen only
// by the next forced read, up to 2s later.
function r6Write(h, id, data) {
  h.write(id, data);
  const t = new Date(h.wall);
  fs.utimesSync(h.file(id), t, t);
}

// The loop's state poll, coarsely: whole seconds of face time, then a read.
// (31 minutes of real frames would be ~28,000 renders.)
function r6Tick(h, ms) {
  for (let t = 0; t < ms; t += 1000) {
    h.advance(1000);
    h.rt.face.update(1000);
    h.rt.checkState();
  }
}

describe('review round 6 -- an open prompt stays on the face until it is answered', () => {
  const PROMPT = { waitingOn: 'Bash:abc', waitKind: 'permission', permState: 'testing', permDetail: 'npm test' };
  function say(h, data) {
    r6Write(h, 'S', data);
    h.event('S.json');
  }

  test('a background agent finishing while the prompt is open: the reward shows, then the prompt again', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'thinking', detail: 'reading your message' });
      h.rt.loop();
      h.runFor(2000);
      say(h, { state: 'waiting', detail: 'allow Bash?', ...PROMPT, waitConfirmed: false });
      h.runFor(6000);
      say(h, { state: 'waiting', detail: 'allow Bash?', ...PROMPT, waitConfirmed: true });
      h.runFor(1000);
      assert.strictEqual(h.rt.face.state, 'waiting', 'precondition: a confirmed prompt');
      // SubagentStop: update-state keeps the wait fields on the write.
      say(h, { state: 'happy', detail: 'subagent done', ...PROMPT, waitConfirmed: true });
      assert.strictEqual(h.rt.face.state, 'happy', 'the reward may show');
      h.runFor(3000);
      assert.strictEqual(h.rt.face.state, 'waiting', 'the face decayed instead of asking again');
      assert.strictEqual(h.rt.face.stateDetail, 'allow Bash?', 'with the prompt\u2019s own detail');
      h.writes.length = 0;
      h.runFor(60000);
      assert.strictEqual(h.rt.face.state, 'waiting', 'held while unanswered');
      assert.strictEqual(h.rt.face.waitEscalated(), true);
      assert.ok(h.titles().some(t => t.includes('WAITING FOR YOU')), 'the title flashes');
      // The answer ends it for good.
      say(h, { state: 'relieved', detail: 'tests passed', answered: true });
      assert.strictEqual(h.rt.face.state, 'relieved');
      let asked = false;
      for (let i = 0; i < 40; i++) { h.runFor(500); if (h.rt.face.state === 'waiting') asked = true; }
      assert.ok(!asked, 'an answered prompt never comes back');
    } finally { h.done(); }
  });

  test('another editor: a parallel tool\u2019s write over the prompt does not end it', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'thinking', detail: 'x', editor: 'codex' });
      h.rt.loop();
      h.runFor(2000);
      say(h, { state: 'waiting', detail: 'allow Bash?', waitingOn: 'k1', editor: 'codex' });
      h.runFor(2000);
      say(h, { state: 'satisfied', detail: 'read a.js', waitingOn: 'k1', editor: 'codex' });
      h.runFor(5000);
      assert.strictEqual(h.rt.face.state, 'waiting');
      assert.strictEqual(h.rt.face.stateDetail, 'allow Bash?');
      h.runFor(40000);
      assert.strictEqual(h.rt.face.state, 'waiting');
      assert.strictEqual(h.rt.face.waitEscalated(), true);
    } finally { h.done(); }
  });

  test('an allowed prompt still turns into its tool when a parallel write carries the wait on', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'testing', detail: 'npm test' });
      h.rt.loop();
      h.runFor(1500);
      say(h, { state: 'waiting', detail: 'allow Bash?', ...PROMPT, waitConfirmed: false });
      h.runFor(3000);
      say(h, { state: 'satisfied', detail: 'read a.js', ...PROMPT, waitConfirmed: false });
      h.runFor(6000);
      assert.strictEqual(h.rt.face.state, 'testing', 'unconfirmed 8s on: allowed, and running');
      assert.strictEqual(h.rt.face.stateDetail, 'npm test');
      h.writes.length = 0;
      h.runFor(60000);
      assert.strictEqual(h.rt.face.state, 'testing', 'the long-tool hold keeps it');
      assert.ok(!h.titles().some(t => t.includes('WAITING FOR YOU')), 'the title never shouted');
    } finally { h.done(); }
  });
});

describe('review round 6 -- an editor that dies between turns is never given a "done!"', () => {
  const { spawn } = require('child_process');

  test('a wait after the turn (turnOver) stays a wait when the armed editor goes away', () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const pid = child.pid;
    const h = r5Runtime();
    const settle = () => {
      h.done();
      grid._pidStartCache.delete(pid);
      try { child.kill('SIGKILL'); } catch {}
    };
    try {
      // The editor started before any of its writes, so its pid arms.
      grid._pidStartCache.set(pid, { value: h.wall - 60000, resolvedAt: h.wall });
      r5Session(h, { state: 'coding', detail: 'edit a.js', pid });
      h.advance(2600);
      h.rt.checkState();
      r6Write(h, 'S', { state: 'idle', detail: 'between turns', turnEnded: true, pid });
      r6Tick(h, 20000);
      // The idle_prompt notification after Stop: waiting, with turnOver.
      r6Write(h, 'S', { state: 'waiting', detail: 'waiting for you', turnOver: true, pid });
      r6Tick(h, 3000);
      assert.strictEqual(h.rt.face.state, 'waiting', 'precondition');
      h.suspend();
    } catch (e) { settle(); throw e; }
    return new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); })
      .then(() => {
        h.resume();
        r6Tick(h, 4000);
        assert.strictEqual(h.rt.trackers().editorDead, false, 'turnOver is never rescued');
        assert.strictEqual(h.rt.face.state, 'waiting');
        assert.strictEqual(h.rt.face.stateDetail, 'waiting for you');
        // Control: the same dead pid during a live turn is still caught.
        r6Write(h, 'S', { state: 'coding', detail: 'edit b.js', pid });
        r6Tick(h, 3000);
        assert.strictEqual(h.rt.trackers().editorDead, true, 'the pid was armed all along');
      })
      .finally(settle);
  });
});

describe('review round 6 -- a renderer started on an open prompt shows it', () => {
  const { startupGate } = renderer;
  const START = 10000000;
  // [label, ts, stopped, now, waiting, expected]
  const table = [
    ['a live wait 20s older than boot applies', START - 20000, false, START + 1000, true, 'apply'],
    ['so does one 29 minutes older', START - WAIT_HOLD_STALE_MS + 60000, false, START + 1000, true, 'apply'],
    ['one past the silence bound is recorded', START - WAIT_HOLD_STALE_MS - 2000, false, START + 1000, true, 'record'],
    ['a wait on a finished turn is still recorded', START - 20000, true, START + 1000, true, 'record'],
    ['any other live write 20s older is still recorded', START - 20000, false, START + 1000, false, 'record'],
    ['after the window, an open wait is not skipped', START - 180000, false, START + 7000, true, 'apply'],
    ['after the window, anything else that old still is', START - 180000, false, START + 7000, false, 'skip'],
  ];
  for (const [label, ts, stopped, now, waiting, expected] of table) {
    test(label, () => assert.strictEqual(startupGate(ts, stopped, now, START, now - START, waiting), expected));
  }

  test('the runtime: the prompt is shown at boot and held', () => {
    const h = r5Runtime();
    try {
      h.write('S', { state: 'waiting', detail: 'allow Bash?', waitingOn: 'k1', editor: 'codex',
        timestamp: h.wall - 20000, lastPromptAt: h.wall - 25000 });
      h.load();
      h.rt.checkState();
      assert.strictEqual(h.rt.mainSession(), 'S');
      h.rt.loop();
      h.runFor(2000);
      assert.strictEqual(h.rt.face.state, 'waiting', 'recorded at boot and never shown');
      assert.strictEqual(h.rt.face.stateDetail, 'allow Bash?');
      h.runFor(70000);
      assert.strictEqual(h.rt.face.state, 'waiting');
    } finally { h.done(); }
  });

  test('the runtime: its silence bound counts from the write, not from the boot', () => {
    const h = r5Runtime();
    try {
      h.write('S', { state: 'waiting', detail: 'allow Bash?', waitingOn: 'k1', editor: 'codex',
        timestamp: h.wall - (WAIT_HOLD_STALE_MS - 60000), lastPromptAt: h.wall - WAIT_HOLD_STALE_MS });
      h.load();
      h.rt.checkState();
      r6Tick(h, 2000);
      assert.strictEqual(h.rt.face.state, 'waiting', 'shown at boot');
      r6Tick(h, 90000);
      assert.notStrictEqual(h.rt.face.state, 'waiting', '30 minutes after the write, not after the boot');
    } finally { h.done(); }
  });
});

describe('review round 6 -- the help overlay opens only where it can be drawn', () => {
  function withSize(cols, rows, fn) {
    const oc = process.stdout.columns;
    const or = process.stdout.rows;
    process.stdout.columns = cols;
    process.stdout.rows = rows;
    try { return fn(); } finally { process.stdout.columns = oc; process.stdout.rows = or; }
  }

  test('below the face minimum `h` does nothing, so the next key is not swallowed', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'idle', detail: '' });
      withSize(36, 18, () => {
        const stats = h.rt.face.showStats;
        h.rt.onKeys('h');
        assert.strictEqual(h.rt.face.showHelp, false, 'open, and drawn nowhere');
        h.rt.onKeys('?');
        assert.strictEqual(h.rt.face.showHelp, false);
        h.rt.onKeys('s');
        assert.notStrictEqual(h.rt.face.showStats, stats, '`s` was eaten closing an invisible overlay');
        h.rt.onKeys('s');
      });
      withSize(38, 20, () => {
        h.rt.onKeys('h');
        assert.strictEqual(h.rt.face.showHelp, true, 'at the minimum it opens');
        assert.ok(h.rt.face.render().includes('Keybindings'), 'and is drawn');
        h.rt.onKeys('x');
      });
    } finally { h.done(); }
  });

  test('a shrink below the minimum closes it (and the face may rest again)', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'idle', detail: '' });
      withSize(100, 40, () => h.rt.onKeys('h'));
      assert.strictEqual(h.rt.face.showHelp, true);
      withSize(36, 18, () => h.rt.onResize());
      assert.strictEqual(h.rt.face.showHelp, false, 'left open and invisible');
    } finally { h.done(); }
  });
});

describe('review round 6 -- application-mode (SS3) arrows move through the session list', () => {
  test('ESC O B / ESC O A navigate instead of closing the list', () => {
    const oc = process.stdout.columns;
    const or = process.stdout.rows;
    process.stdout.columns = 100;
    process.stdout.rows = 40;
    const h = r5Runtime();
    try {
      h.advance(6000);
      h.write('A', { state: 'coding', lastPromptAt: h.wall - 10 });
      h.write('B', { state: 'reading', lastPromptAt: h.wall - 5000 });
      h.write('C', { state: 'testing', lastPromptAt: h.wall - 9000 });
      h.load();
      h.rt.checkState();
      h.rt.onKeys('l');
      h.rt.loop();
      assert.deepStrictEqual(h.rt.face.sessionListIds, ['A', 'B', 'C']);
      h.rt.onKeys('\u001bOB');
      assert.strictEqual(h.rt.face.showSessionList, true, 'an SS3 down closed the list');
      assert.strictEqual(h.rt.face.sessionListSelectedId, 'B');
      h.rt.onKeys('\u001bOB\u001bOB');
      assert.strictEqual(h.rt.face.sessionListSelectedId, 'C');
      h.rt.onKeys('\u001bOA');
      assert.strictEqual(h.rt.face.sessionListSelectedId, 'B');
      assert.strictEqual(h.rt.face.showSessionList, true);
    } finally {
      process.stdout.columns = oc;
      process.stdout.rows = or;
      h.done();
    }
  });
});

describe('review round 6 -- the wait\'s silence bound is measured on the monotonic clock', () => {
  for (const [label, step] of [['back', -2 * 3600000], ['forward', 2 * 3600000]]) {
    test(`the wall clock stepped ${label} two hours neither stretches nor cuts the 30 minutes`, () => {
      const h = r5Runtime();
      try {
        r5Session(h, { state: 'waiting', detail: 'allow Bash?', waitingOn: 'k1', editor: 'codex' });
        r6Tick(h, 2000);
        assert.strictEqual(h.rt.face.state, 'waiting', 'precondition');
        h.stepWall(step);
        r6Tick(h, 60000);
        assert.strictEqual(h.rt.face.state, 'waiting', 'a minute after the step');
        r6Tick(h, WAIT_HOLD_STALE_MS);
        assert.notStrictEqual(h.rt.face.state, 'waiting', 'still shouting 31 minutes into the silence');
      } finally { h.done(); }
    });
  }

  test('a face swapped in on a wait: the bound is seeded with the write\'s age, and survives a step', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.rt.loop();
      h.runFor(500);
      h.write('B', { state: 'waiting', detail: 'allow Bash?', waitingOn: 'k1', editor: 'codex',
        timestamp: h.wall - 60000, lastPromptAt: h.wall });
      h.load();
      h.runFor(2000);
      assert.strictEqual(h.rt.mainSession(), 'B');
      assert.strictEqual(h.rt.face.state, 'waiting', 'precondition');
      h.stepWall(-2 * 3600000);
      r6Tick(h, WAIT_HOLD_STALE_MS - 60000);
      assert.notStrictEqual(h.rt.face.state, 'waiting', 'the swap seeded a wall-clock stamp');
    } finally { h.done(); }
  });
});

describe('review round 6 -- the watcher hears the folder replaced under it', () => {
  const { createDirWatcher } = renderer;
  function fake() {
    const st = { ino: 1, handles: [], timers: [] };
    st.stat = () => ({ dev: 7, ino: st.ino });
    st.watch = (dir, cb) => {
      const w = { cb, closed: false, on() { return w; }, close() { w.closed = true; } };
      st.handles.push(w);
      return w;
    };
    st.schedule = (fn, ms) => { const t = { fn, ms, live: true }; st.timers.push(t); return t; };
    st.cancel = (t) => { t.live = false; };
    st.live = () => st.timers.filter(t => t.live);
    const out = { events: [], reopened: 0 };
    out.w = createDirWatcher({
      dir: '/home/me/.code-crumb-sessions', exists: () => true, stat: st.stat, mkdir: () => {},
      watch: st.watch, schedule: st.schedule, cancel: st.cancel,
      onEvent: (e, f) => out.events.push([e, f]), onReopen: () => { out.reopened++; },
    });
    return { st, out };
  }

  test('Linux names the deleted folder itself: re-open, though it exists again by then', () => {
    const { st, out } = fake();
    // A change to the folder's own attributes names it too, and is no break.
    st.handles[0].cb('change', '.code-crumb-sessions');
    assert.strictEqual(st.handles[0].closed, false);
    st.ino = 2;   // deleted, and recreated by a hook before the event is handled
    st.handles[0].cb('rename', '.code-crumb-sessions');
    assert.strictEqual(st.handles[0].closed, true, 'the handle on the dead folder was kept');
    assert.strictEqual(out.events.length, 1, 'only the attribute change got through');
    const t = st.live()[0];
    t.live = false;
    t.fn();
    assert.strictEqual(st.handles.length, 2);
    assert.strictEqual(out.reopened, 1, 'the caller re-reads what it missed');
  });

  test('check() notices a folder replaced without a word (same path, new inode)', () => {
    const { st, out } = fake();
    out.w.check();
    assert.strictEqual(st.handles[0].closed, false, 'nothing to do while healthy');
    st.ino = 2;
    out.w.check();
    assert.strictEqual(st.handles[0].closed, true, 'check() only asked whether the path exists');
    assert.strictEqual(st.live().length, 1, 'a re-open is scheduled');
  });
});

describe('review round 6 -- the loop wakes for a change the trailing watcher read brings in', () => {
  const { LOW_POWER_FRAME_MS, FRAME_INTERVAL_MS } = renderer;
  test('a write folded into the 50ms throttle is drawn at once, not at the next low-power frame', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'idle', detail: '' });
      h.rt.face.blinkTimer = Infinity;    // a blink (random) keeps a frame off low power
      h.rt.loop();
      h.runFor(5000);
      assert.strictEqual(h.rt.trackers().frameInterval, LOW_POWER_FRAME_MS, 'precondition: resting');
      h.event('S.json');                 // read at once (nothing new), wakes a frame
      h.runFor(10);
      assert.strictEqual(h.rt.trackers().frameInterval, LOW_POWER_FRAME_MS, 'resting again');
      r6Write(h, 'S', { state: 'coding', detail: 'edit a.js' });
      h.event('S.json');                 // inside the window: folded into the trailing read
      h.runFor(60);
      assert.strictEqual(h.rt.face.state, 'coding', 'the trailing read applied it');
      assert.strictEqual(h.rt.trackers().frameInterval, FRAME_INTERVAL_MS, 'no frame has drawn it yet');
    } finally { h.done(); }
  });
});

describe('review round 6 -- the cascade never clears a state queued for the next frame', () => {
  test('a wait queued behind "wrapping up" is not cleared by responding -> done!', () => {
    const h = r5Runtime();
    try {
      r5Session(h, { state: 'coding', detail: 'edit a.js' });
      h.advance(2100);
      r6Write(h, 'S', { state: 'idle', detail: 'between turns', turnEnded: true });
      h.rt.checkState();
      assert.strictEqual(h.rt.face.state, 'responding', 'precondition');
      h.advance(500);
      r6Write(h, 'S', { state: 'waiting', detail: 'waiting for you', turnOver: true });
      h.rt.checkState();
      assert.strictEqual(h.rt.face.pendingState, 'waiting', 'precondition: queued');
      h.advance(2600);                    // responding's 3s are up, no frame yet
      h.rt.checkState();
      h.rt.face.update(66);
      assert.strictEqual(h.rt.face.state, 'waiting', 'the cascade\u2019s happy wiped the queued wait');
      assert.strictEqual(h.rt.face.stateDetail, 'waiting for you');
    } finally { h.done(); }
  });
});

module.exports = suite;
