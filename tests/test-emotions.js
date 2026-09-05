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

describe('emotions -- UserPromptSubmit tells the face Claude has started thinking', () => {
  test('hooks.json registers UserPromptSubmit', () => {
    const hooks = readJSON(path.join(ROOT, 'hooks', 'hooks.json')).hooks;
    assert.ok(hooks.UserPromptSubmit, 'missing UserPromptSubmit block');
    assert.ok(hooks.UserPromptSubmit[0].hooks[0].command.includes('update-state.js'));
  });
  test('setup.js installs UserPromptSubmit', () => {
    const src = fs.readFileSync(path.join(ROOT, 'setup.js'), 'utf8');
    assert.ok(src.includes("'UserPromptSubmit'"));
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
  test('update-state.js fallback chain handles TeammateIdle and TaskCompleted', () => {
    const src = fs.readFileSync(UPDATE_STATE, 'utf8');
    const catchPath = src.slice(src.indexOf("let fallbackState = 'thinking'"));
    assert.ok(catchPath.includes("hookEvent === 'TeammateIdle'"), 'TeammateIdle missing from catch path');
    assert.ok(catchPath.includes("hookEvent === 'TaskCompleted'"), 'TaskCompleted missing from catch path');
    assert.ok(catchPath.includes("hookEvent === 'UserPromptSubmit'"), 'UserPromptSubmit missing from catch path');
  });
});

// -- The renderer's timeout cascade -------------------------------------

const {
  idleCascade, LONG_TOOL_HOLD_MS, IDLE_TIMEOUT, THINKING_TIMEOUT, SLEEP_TIMEOUT,
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
    assert.strictEqual(idleCascade({ state: 'waiting', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: true, lingerMs: 0, fileState: 'waiting' }), 'thinking');
    assert.strictEqual(idleCascade({ state: 'error', sinceChangeMs: IDLE_TIMEOUT + 1, sessionActive: false, lingerMs: 0, fileState: 'error' }), 'idle');
    assert.strictEqual(idleCascade({ state: 'error', sinceChangeMs: IDLE_TIMEOUT - 1, sessionActive: false, lingerMs: 0, fileState: 'error' }), null);
  });

  test('the renderer still exports the timeout constants it cascades on', () => {
    assert.strictEqual(IDLE_TIMEOUT, 8000);
    assert.strictEqual(THINKING_TIMEOUT, 45000);
    assert.strictEqual(SLEEP_TIMEOUT, 60000);
    assert.strictEqual(LONG_TOOL_HOLD_MS, 600000);
  });
});

module.exports = suite;
