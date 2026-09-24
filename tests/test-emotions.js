#!/usr/bin/env node
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
const { execFileSync } = require('child_process');

const suite = require('./_harness').createSuite();
const { describe, test } = suite;
const { makeTempEnv, cleanup, readJSON } = require('./_harness');

const sm = require('../state-machine');
const shared = require('../shared');
const face = require('../face');
const renderer = require('../renderer');
const grid = require('../grid');
const { STATE_THOUGHTS } = require('../themes');

const ROOT = path.join(__dirname, '..');
const UPDATE_STATE = path.join(ROOT, 'update-state.js');

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
    f.lastStateChange = Date.now() - (face.COMPLETION_MIN_SHOW_MS + 100);
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
    assert.ok(f.minDisplayUntil > Date.now() + 2000, 'proud min display should still be running');
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
    f.lastStateChange = Date.now() - (face.COMPLETION_MIN_SHOW_MS + 100);
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
    const now = Date.now();
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
    const now = Date.now();
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
  test('renderer FRESH_READ_STATES covers every active work and completion state', () => {
    const fr = renderer.FRESH_READ_STATES;
    assert.ok(fr instanceof Set);
    for (const s of shared.ACTIVE_WORK_STATES) assert.ok(fr.has(s), `missing ${s}`);
    for (const s of shared.COMPLETION_STATES) assert.ok(fr.has(s), `missing ${s}`);
    assert.ok(fr.has('thinking'));
  });
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

function runHook(event, payload, env) {
  try {
    execFileSync(process.execPath, [UPDATE_STATE, event], {
      input: JSON.stringify(payload),
      env,
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`update-state.js ${event} failed: ${(e.stderr || '').toString() || e.message}`);
  }
}

// Raw-stdin variant: runHook above JSON-stringifies, so '' arrives as '""'
// and still parses. The catch path only opens for stdin that is not JSON.
function runHookRaw(event, input, env) {
  execFileSync(process.execPath, [UPDATE_STATE, event], {
    input, env, timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
  });
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
        runHookRaw(event, '', env);
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
    const assignments = src.match(/lastNewWriteAt\s*=[^=]/g) || [];
    assert.strictEqual(assignments.length, 4,
      'lastNewWriteAt: declaration, the adoptMain reset, noteNewWrite, and the swap seed');
    const resets = src.match(/lastNewWriteAt\s*=\s*0\s*;/g) || [];
    assert.strictEqual(resets.length, 2, 'the declaration and the adoptMain reset');
    const seeds = src.match(/lastNewWriteAt\s*=\s*ts\s*;/g) || [];
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
    assert.ok(/if \(!isProcessAlive\(lastEditorPid\)\) markMainDead\(\);/.test(RENDERER_SRC));
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

  test('tmux mode uses it', () => {
    assert.ok(/const state = tmuxDisplayState\(data, Date\.now\(\)\);/.test(RENDERER_SRC));
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

module.exports = suite;
