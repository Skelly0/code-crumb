'use strict';

// +================================================================+
// |  Lifecycle tests: lib/wait.js and lib/carry.js                 |
// |                                                                |
// |  The permission-wait lifecycle and the session-file carry      |
// |  (the session's and the turn's tombstones, the open wait, the  |
// |  sticky fields) as pure tables -- and, end to end, that the    |
// |  hook's main path and its >1 MB fallback, which both write     |
// |  through them now, keep the same facts.                        |
// +================================================================+

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { createSuite, makeTempEnv, cleanup, readJSON, runUpdateState } = require('./_harness');
const suite = createSuite();
const { describe, test } = suite;

const wait = require('../lib/wait');
const carry = require('../lib/carry');
const { safeFilename } = require('../lib/shared');

const { PERMISSION_CONFIRM_MS } = wait;
const T = 1700000000000;

// A Claude Code permission prompt as PermissionRequest writes it.
const asked = (over = {}) => ({
  state: 'waiting', detail: 'allow Bash?', editor: 'claude', timestamp: T,
  waitingOn: 'Bash:abc:12', waitKind: 'permission', waitConfirmed: false,
  permState: 'testing', permDetail: 'npm test', waitAskedAt: T,
  ...over,
});

// -- lib/wait.js -----------------------------------------------------------

describe('lib/wait.js -- asking', () => {
  test('toolCallKey names a call by its tool and input, as update-state.js always did', () => {
    const k = wait.toolCallKey('Bash', { command: 'npm test' });
    assert.match(k, /^Bash:[0-9a-z]+:\d+$/);
    assert.strictEqual(k, wait.toolCallKey('Bash', { command: 'npm test' }), 'stable');
    assert.notStrictEqual(k, wait.toolCallKey('Bash', { command: 'npm ci' }), 'another call');
    assert.notStrictEqual(k, wait.toolCallKey('Read', { command: 'npm test' }), 'another tool');
    const empty = (5381).toString(36);   // the digest of no text at all
    assert.strictEqual(wait.toolCallKey(null, undefined), `:${empty}:0`);
    assert.ok(wait.toolCallKey(true, {}).startsWith('true:'), 'a boolean name reads as toText does');
    const cyclic = {}; cyclic.self = cyclic;
    assert.strictEqual(wait.toolCallKey('X', cyclic), `X:${empty}:0`, 'an input that cannot be serialised never throws');
  });

  test('notifyEnabled is Claude Code\'s own parse of the switch', () => {
    for (const v of [undefined, '', '0', 'false', 'no', 'off', ' 2 ']) assert.strictEqual(wait.notifyEnabled(v), true, String(v));
    for (const v of ['1', 'true', 'TRUE', ' on ', 'Yes']) assert.strictEqual(wait.notifyEnabled(v), false, v);
  });

  test('askFields: an unconfirmed wait for Claude Code with its notification on, nothing otherwise', () => {
    const work = { state: 'testing', detail: 'npm test' };
    assert.deepStrictEqual(wait.askFields({ editor: 'claude', notify: true, work, askedAt: 5 }), {
      waitKind: 'permission', waitConfirmed: false, permState: 'testing', permDetail: 'npm test', waitAskedAt: 5,
    });
    assert.strictEqual(wait.askFields({ editor: 'codex', notify: true, work, askedAt: 5 }), null, 'Codex: nothing confirms it');
    assert.strictEqual(wait.askFields({ editor: 'claude', notify: false, work, askedAt: 5 }), null, 'notification off');
  });
});

describe('lib/wait.js -- reading a write', () => {
  test('the asking write, a write carrying it on, and the orbital\'s looser test', () => {
    assert.strictEqual(wait.isUnconfirmedPermission(asked()), true);
    assert.strictEqual(wait.isUnconfirmedPermission(asked({ waitConfirmed: true })), false);
    assert.strictEqual(wait.isUnconfirmedPermission(asked({ waitConfirmed: undefined })), false, 'must be an explicit false');
    assert.strictEqual(wait.isUnconfirmedPermission(asked({ editor: 'codex' })), false);
    assert.strictEqual(wait.isUnconfirmedPermission(asked({ permState: 'happy' })), false, 'no tool face to turn into');
    assert.strictEqual(wait.isUnconfirmedPermission(asked({ state: 'reading' })), false, 'not the asking write');
    assert.strictEqual(wait.carriesUnconfirmedPermission(asked({ state: 'reading' })), true, 'a parallel tool carries it on');
    assert.strictEqual(wait.carriesUnconfirmedPermission(asked({ state: 'reading', waitingOn: undefined })), false);
    // The orbital takes any tool face (it shows an unknown one as executing)
    // and is told the editor it inferred for a legacy file.
    assert.strictEqual(wait.isUnconfirmedAsk(asked({ permState: 'happy' })), true);
    assert.strictEqual(wait.isUnconfirmedAsk(asked({ editor: undefined }), 'claude'), true);
    assert.strictEqual(wait.isUnconfirmedAsk(asked(), 'codex'), false);
  });

  test('allowed exactly PERMISSION_CONFIRM_MS after its own write, never before or without a timestamp', () => {
    assert.strictEqual(wait.permissionAnswered(asked(), T + PERMISSION_CONFIRM_MS - 1), false);
    assert.strictEqual(wait.permissionAnswered(asked(), T + PERMISSION_CONFIRM_MS), true);
    assert.strictEqual(wait.permissionAnswered(asked({ timestamp: 0 }), T + 3600000), false);
    assert.strictEqual(wait.permissionAnswered(asked({ waitConfirmed: true }), T + 3600000), false, 'a confirmed dialog is open');
  });

  test('waitPhase places every write in the lifecycle', () => {
    const later = T + PERMISSION_CONFIRM_MS;
    for (const [w, now, phase] of [
      [null, T, 'none'],
      [{ state: 'reading' }, T, 'none'],
      [{ state: 'waiting', detail: 'waiting for you' }, T, 'none'],    // an idle_prompt is no permission wait
      [asked(), T, 'asked'],
      [asked(), later, 'allowed'],
      [asked({ waitingOn: undefined }), later, 'allowed'],             // a sanitised read that lost waitingOn
      [asked({ waitConfirmed: true }), later, 'confirmed'],
      [{ state: 'waiting', waitingOn: 'Bash:x:1' }, later, 'open'],    // Codex, or the notification off
      [asked({ editor: 'codex' }), later, 'open'],
      [asked({ permState: 'happy' }), later, 'open'],
      [asked({ state: 'reading' }), T, 'asked'],                       // carried on by a parallel tool
    ]) assert.strictEqual(wait.waitPhase(w, now), phase, JSON.stringify(w));
  });
});

describe('lib/wait.js -- carrying and answering', () => {
  const carry1 = (prev, over = {}) => wait.carryWait(prev, { toolEnd: false, callKey: '', closes: false, answered: false, asks: false, dropOwn: false, fields: {}, ...over });

  test('every write that is no answer carries the wait on, whole', () => {
    const out = carry1(asked());
    assert.deepStrictEqual(Object.keys(out).sort(), [...wait.WAIT_FIELDS].sort());
    assert.strictEqual(out.waitingOn, 'Bash:abc:12');
  });

  test('only the waited call\'s own end answers it; another call\'s end carries it', () => {
    assert.deepStrictEqual(carry1(asked(), { toolEnd: true, callKey: 'Bash:abc:12' }), { answered: true });
    assert.strictEqual(carry1(asked(), { toolEnd: true, callKey: 'Read:zz:3' }).waitingOn, 'Bash:abc:12');
    assert.strictEqual(carry1(asked(), { toolEnd: true, callKey: '' }).waitingOn, 'Bash:abc:12', 'no key (the parsed-then-threw path) answers nothing');
  });

  test('an answer, the turn\'s end, a new prompt or the own wait found allowed drop it', () => {
    for (const over of [{ answered: true }, { closes: true }, { asks: true }, { dropOwn: true }, { fields: { waitingOn: 'Other:1:1' } }]) {
      assert.deepStrictEqual(carry1(asked(), over), {}, JSON.stringify(over));
    }
    assert.deepStrictEqual(carry1({ state: 'reading' }), {}, 'nothing to carry');
    assert.deepStrictEqual(carry1(null), {});
  });

  test('a field the write set itself is never overwritten', () => {
    const out = carry1(asked(), { fields: { waitConfirmed: true, waitKind: 'permission' } });
    assert.strictEqual(out.waitConfirmed, undefined);
    assert.strictEqual(out.waitingOn, 'Bash:abc:12');
  });

  test('a denial answers its own call, or anything when nothing is pending', () => {
    assert.strictEqual(wait.deniedAnswers(asked(), 'Bash:abc:12'), true);
    assert.strictEqual(wait.deniedAnswers(asked(), 'Read:zz:3'), false, 'a wait on another call stays');
    assert.strictEqual(wait.deniedAnswers({ state: 'thinking' }, 'Read:zz:3'), true);
    assert.strictEqual(wait.deniedAnswers(null, 'x'), true);
  });
});

describe('lib/wait.js -- confirming and standing in', () => {
  test('an agent\'s wait is confirmed only when it is an open, unconfirmed prompt old enough', () => {
    const agent = (over) => asked({ syncAt: T, eventAt: T + 4000, ...over });
    const old = T + wait.PERMISSION_CONFIRM_MIN_AGE_MS;
    assert.strictEqual(wait.agentWaitVerdict(agent(), old), 'confirm');
    assert.strictEqual(wait.agentWaitVerdict(agent(), old - 1), null, 'too young to be the one');
    assert.strictEqual(wait.agentWaitVerdict(agent({ syncAt: undefined }), old), null, 'eventAt when there is no syncAt');
    assert.strictEqual(wait.agentWaitVerdict(agent({ waitConfirmed: true }), T), 'confirmed');
    for (const over of [{ stopped: true }, { state: 'reading' }, { waitKind: undefined }, { waitConfirmed: undefined }]) {
      assert.strictEqual(wait.agentWaitVerdict(agent(over), old), null, JSON.stringify(over));
    }
    assert.strictEqual(wait.agentWaitVerdict(null, old), null);
  });

  test('the session\'s own prompt: confirmed, its own detail and tool face kept', () => {
    const r = wait.notificationWait(asked(), [], T + 6000);
    assert.strictEqual(r.waitingOn, 'Bash:abc:12');
    assert.strictEqual(r.detail, 'allow Bash?');
    assert.deepStrictEqual(r.fields, { waitKind: 'permission', waitConfirmed: true, permState: 'testing', permDetail: 'npm test' });
    assert.strictEqual(r.dropOwn, false);
    // However late the hook ran: nobody else claims this notification.
    assert.strictEqual(wait.notificationWait(asked(), [], T + 60000).waitingOn, 'Bash:abc:12');
  });

  test('an agent asking while the own prompt was allowed long ago: stand in, back to the running tool', () => {
    const r = wait.notificationWait(asked(), ['S-agent-a1'], T + PERMISSION_CONFIRM_MS);
    assert.strictEqual(r.waitingOn, null);
    assert.strictEqual(r.detail, null);
    assert.strictEqual(r.dropOwn, true);
    assert.deepStrictEqual(r.fields.waitForAgents, ['S-agent-a1']);
    assert.deepStrictEqual(r.fields.waitPrev, { state: 'testing', detail: 'npm test' });
  });

  test('stand-ins merge (never replace) and cap; a working parent remembers what it showed', () => {
    const many = Array.from({ length: 12 }, (_, i) => `S-agent-a${i}`);
    const holding = { state: 'waiting', waitForAgents: ['S-agent-old'], waitPrev: { state: 'coding', detail: 'a.js' } };
    const r = wait.notificationWait(holding, many, T);
    assert.strictEqual(r.fields.waitForAgents.length, wait.MAX_STAND_IN);
    assert.strictEqual(r.fields.waitForAgents[0], 'S-agent-old', 'the first agent is not forgotten');
    assert.deepStrictEqual(r.fields.waitPrev, { state: 'coding', detail: 'a.js' });
    const working = wait.notificationWait({ state: 'reading', detail: 'b.js' }, ['S-agent-a1'], T);
    assert.deepStrictEqual(working.fields.waitPrev, { state: 'reading', detail: 'b.js' });
    // An agent's own file stands in for nobody.
    assert.strictEqual(wait.notificationWait(holding, [], T, { standIn: false }).fields.waitForAgents, undefined);
  });

  test('releasing a stand-in: minus one agent while others ask, else back, answered, with no wait fields', () => {
    const s = { state: 'waiting', detail: 'allow?', timestamp: T, waitForAgents: ['A', 'B'],
      waitPrev: { state: 'coding', detail: 'x.js' }, waitKind: 'permission', waitConfirmed: true };
    const one = wait.releaseStandIn(s, 'A', T + 5);
    assert.deepStrictEqual(one.waitForAgents, ['B']);
    assert.strictEqual(one.timestamp, T, 'nothing to redraw yet');
    const both = wait.releaseStandIn(one, 'B', T + 9);
    assert.deepStrictEqual([both.state, both.detail, both.answered, both.timestamp], ['coding', 'x.js', true, T + 9]);
    for (const f of [...wait.WAIT_FIELDS, ...wait.STAND_IN_FIELDS]) assert.ok(!(f in both), f);
    assert.deepStrictEqual([wait.releaseStandIn({ ...s, waitForAgents: ['A'], waitPrev: undefined }, 'A', T).state],
      ['subagent'], 'no waitPrev: conducting');
    assert.strictEqual(wait.releaseStandIn(s, 'C', T), null, 'not standing in for that agent');
    assert.strictEqual(wait.releaseStandIn({ ...s, state: 'coding' }, 'A', T), null, 'no longer waiting');
  });
});

describe('lib/wait.js -- one prompt, start to finish', () => {
  // The lifecycle diagram at the top of lib/wait.js, walked through the
  // functions the hook and the readers call, in order.
  test('asked -> carried by a parallel tool -> confirmed -> answered by its own call', () => {
    const key = wait.toolCallKey('Bash', { command: 'npm test' });
    const ask = { state: 'waiting', editor: 'claude', timestamp: T, waitingOn: key,
      ...wait.askFields({ editor: 'claude', notify: true, work: { state: 'testing', detail: 'npm test' }, askedAt: T }) };
    assert.strictEqual(wait.waitPhase(ask, T + 1000), 'asked');
    const parallel = { state: 'reading', editor: 'claude', timestamp: T + 2000,
      ...wait.carryWait(ask, { toolEnd: true, callKey: wait.toolCallKey('Read', { file_path: 'a' }), fields: {} }) };
    assert.strictEqual(wait.waitPhase(parallel, T + 2000), 'asked', 'still asked under a parallel tool');
    const note = wait.notificationWait(parallel, [], T + 6000);
    const confirmed = { state: 'waiting', editor: 'claude', timestamp: T + 6000, waitingOn: note.waitingOn, ...note.fields };
    assert.strictEqual(wait.waitPhase(confirmed, T + 60000), 'confirmed', 'a confirmed dialog is never inferred allowed');
    assert.deepStrictEqual(wait.carryWait(confirmed, { toolEnd: true, callKey: key, fields: {} }), { answered: true });
  });
});

// -- lib/carry.js ----------------------------------------------------------

// Every event update-state.js handles, and Codex's Interrupt.
const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Notification', 'UserPromptSubmit',
  'TeammateIdle', 'TaskCompleted', 'SubagentStart', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact',
  'PostCompact', 'PermissionRequest', 'PermissionDenied', 'Setup', 'Elicitation', 'ElicitationResult',
  'ConfigChange', 'InstructionsLoaded', 'StopFailure', 'PostModelSwitch', 'Interrupt'];
const next = (prev, over = {}) => carry.nextSessionFile(prev, {
  event: 'PostToolUse', agentId: '', isAgent: false, state: 'relieved', detail: 'done', fields: {}, callKey: '', ...over,
});

describe('lib/carry.js -- what a write ends', () => {
  test('writeEnds: SessionEnd the session, the session\'s own Stop the turn, a failure the turn', () => {
    assert.strictEqual(carry.writeEnds('SessionEnd', '', false), 'session');
    assert.strictEqual(carry.writeEnds('Stop', '', false), 'turn');
    assert.strictEqual(carry.writeEnds('Stop', 'a1', true), null, 'an agent\'s Stop is its own turn');
    assert.strictEqual(carry.writeEnds('StopFailure', '', false), 'failed');
    assert.strictEqual(carry.writeEnds('Interrupt', '', false), 'failed');
    assert.strictEqual(carry.writeEnds('StopFailure', 'a1', false), null, 'an agent\'s failure ends nothing of the parent\'s');
    for (const e of EVENTS.filter(x => !['SessionEnd', 'Stop', 'StopFailure', 'Interrupt'].includes(x))) {
      assert.strictEqual(carry.writeEnds(e, '', false), null, e);
    }
  });

  test('Stop leaves the window idle between turns; a failure keeps its face; neither writes the tombstone', () => {
    const stop = next({ state: 'coding', turnOver: true }, { event: 'Stop', state: 'responding', detail: 'wrapping up', fields: { stopped: true } });
    assert.deepStrictEqual([stop.state, stop.detail, stop.stopped, stop.fields.turnEnded, stop.fields.turnOver, stop.fields.stopped],
      ['idle', 'between turns', false, true, undefined, undefined]);
    const fail = next({ state: 'coding' }, { event: 'StopFailure', state: 'error', detail: 'rate limited!' });
    assert.deepStrictEqual([fail.state, fail.stopped, fail.fields.turnEnded], ['error', false, true]);
    const end = next({ state: 'idle', turnEnded: true }, { event: 'SessionEnd', state: 'happy', detail: 'bye' });
    assert.deepStrictEqual([end.stopped, end.fields.stopped], [true, true]);
  });
});

describe('lib/carry.js -- the tombstones', () => {
  test('a session\'s tombstone survives exactly the events that echo a finished turn', () => {
    for (const event of EVENTS) {
      if (event === 'SessionEnd') continue;   // writes its own
      const out = next({ state: 'happy', stopped: true }, { event, state: 'happy' });
      assert.strictEqual(out.stopped, carry.echoesTurnEnd(event, ''), event);
      assert.strictEqual(!!out.fields.stopped, out.stopped, `${event}: the field matches`);
    }
    // The ones that matter, named: late echoes keep it, the session starting again clears it.
    for (const e of ['SubagentStop', 'TaskCompleted', 'PostToolUse', 'PostCompact', 'PreCompact', 'Notification']) {
      assert.strictEqual(next({ stopped: true }, { event: e }).stopped, true, e);
    }
    for (const e of ['PreToolUse', 'UserPromptSubmit', 'SessionStart']) {
      assert.strictEqual(next({ stopped: true }, { event: e }).stopped, false, e);
    }
    // Nothing but SessionEnd writes one.
    for (const event of EVENTS.filter(e => e !== 'SessionEnd')) {
      assert.strictEqual(next(null, { event, fields: { stopped: true } }).stopped, false, event);
    }
  });

  test('a finished turn survives its echoes, as turnEnded only on a face the renderer may celebrate', () => {
    assert.strictEqual(next({ turnEnded: true }, { event: 'PostToolUse', state: 'relieved' }).fields.turnEnded, true);
    assert.strictEqual(next({ turnEnded: true }, { event: 'PostToolUseFailure', state: 'error' }).fields.turnEnded, true);
    const w = next({ turnEnded: true }, { event: 'Notification', state: 'waiting' });
    assert.deepStrictEqual([w.fields.turnEnded, w.fields.turnOver], [undefined, true], 'a wait carries turnOver');
    const back = next({ turnOver: true }, { event: 'SubagentStop', state: 'happy' });
    assert.strictEqual(back.fields.turnEnded, true, 'the next reward turns it back into turnEnded');
    assert.strictEqual(next({ turnEnded: true }, { event: 'PreCompact', state: 'thinking' }).fields.turnOver, true, 'ambient');
    for (const e of ['PreToolUse', 'UserPromptSubmit', 'SubagentStart']) {
      const o = next({ turnEnded: true }, { event: e, state: 'thinking' });
      assert.ok(!o.fields.turnEnded && !o.fields.turnOver, `${e} opens a new turn`);
    }
    // An agent's StopFailure on the parent's file is an echo, not a close.
    assert.strictEqual(next({ turnEnded: true }, { event: 'StopFailure', agentId: 'a1', state: 'error' }).fields.turnEnded, true);
    // An ended session does not also carry a turn end.
    const o = next({ stopped: true, turnEnded: true }, { event: 'SubagentStop', state: 'happy' });
    assert.deepStrictEqual([o.stopped, o.fields.turnEnded], [true, undefined]);
  });
});

describe('lib/carry.js -- the rest of the carry', () => {
  test('an open wait rides along, and its own call\'s end answers it', () => {
    const p = asked({ state: 'waiting' });
    assert.strictEqual(next(p, { event: 'PostToolUse', callKey: 'Read:z:1' }).fields.waitingOn, 'Bash:abc:12');
    const a = next(p, { event: 'PostToolUse', callKey: 'Bash:abc:12' });
    assert.deepStrictEqual([a.fields.answered, a.fields.waitingOn], [true, undefined]);
    assert.strictEqual(next(p, { event: 'Stop' }).fields.waitingOn, undefined, 'the turn\'s end clears it');
    assert.strictEqual(next(p, { event: 'Notification', dropOwnWait: true }).fields.waitingOn, undefined);
  });

  test('sticky fields are kept unless the write sets its own; workSince names an unseen Pre', () => {
    const prev = { lastPromptAt: 5, model: 'Opus', firstSeenAt: 3, parentSession: 'P', state: 'testing', timestamp: 99 };
    const o = next(prev, { fields: { model: 'Fable', workState: 'testing' } });
    assert.deepStrictEqual([o.fields.lastPromptAt, o.fields.model, o.fields.firstSeenAt, o.fields.parentSession, o.fields.workSince],
      [5, 'Fable', 3, 'P', 99]);
    assert.strictEqual(next({ ...prev, state: 'reading' }, { fields: { workState: 'testing' } }).fields.workSince, undefined);
    assert.deepStrictEqual(next(null, { fields: { a: 1 } }).fields, { a: 1 }, 'nothing before, nothing carried');
  });

  test('stopsGlobal: what ends something, and an echo while the turn is still over -- never a wait', () => {
    const w = (over) => ({ event: 'SubagentStop', agentId: '', isAgent: false, state: 'happy', globalOwnStop: false, ...over });
    assert.strictEqual(carry.stopsGlobal(null, w({ event: 'Stop' })), true);
    assert.strictEqual(carry.stopsGlobal(null, w({ event: 'StopFailure' })), true);
    assert.strictEqual(carry.stopsGlobal(null, w()), false, 'nothing says the turn is over');
    assert.strictEqual(carry.stopsGlobal(null, w({ globalOwnStop: true })), true);
    assert.strictEqual(carry.stopsGlobal({ turnOver: true }, w()), true, 'the session file remembers what a wait cleared');
    assert.strictEqual(carry.stopsGlobal({ turnEnded: true }, w({ state: 'waiting' })), false);
    assert.strictEqual(carry.stopsGlobal({ turnEnded: true }, w({ event: 'UserPromptSubmit' })), false, 'a new turn');
    assert.strictEqual(carry.stopsGlobal({ turnEnded: true }, w({ isAgent: true })), false, 'an agent writes no global');
  });
});

// -- Both write paths agree --------------------------------------------------

// The >1 MB fallback used to keep its own copy of the carry rules, and every
// round found them drifted: it dropped a session's `stopped`, an open
// permission prompt, a finished turn. Both paths now write through
// nextSessionFile; this drives the real hook down each with the same events
// and compares the facts the carry is responsible for.
describe('both write paths keep the same facts (end to end)', () => {
  const huge = 'x'.repeat(1100000);
  const fileOf = (t, id) => path.join(t.sessionsDir, safeFilename(id) + '.json');
  const facts = (s) => ({
    stopped: !!s.stopped,
    turnOver: !!(s.turnEnded || s.turnOver),
    waitingOn: s.waitingOn || null,
    waitKind: s.waitKind || null,
    waitConfirmed: s.waitConfirmed === undefined ? null : s.waitConfirmed,
    answered: !!s.answered,
    lastPromptAt: typeof s.lastPromptAt === 'number',
    firstSeenAt: typeof s.firstSeenAt === 'number',
  });
  // A probe's two shapes: the payload as sent, and the same event padded
  // past 1 MB (padding after tool_input, as Claude Code serialises a result).
  const post = (id, command, tool = 'Bash') => (pad) => JSON.stringify({
    session_id: id, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: { command },
    tool_response: { stdout: pad ? huge : 'ok', stderr: '' }, tool_use_id: 'toolu_' + command.length,
  });
  const lifecycle = (id, event, extra = {}) => (pad) => JSON.stringify({
    session_id: id, hook_event_name: event, ...extra, ...(pad ? { padding: huge } : {}),
  });
  const SCENARIOS = [
    // [name, setup events, probe event, probe payload]
    ['a late tool end after Stop keeps the finished turn',
      (id) => [['SessionStart', { session_id: id, source: 'startup' }], ['UserPromptSubmit', { session_id: id, prompt: 'go' }],
        ['Stop', { session_id: id }]], 'PostToolUse', (id) => post(id, 'cat log.txt')],
    ['an echo after SessionEnd keeps the tombstone',
      (id) => [['SessionStart', { session_id: id, source: 'startup' }], ['UserPromptSubmit', { session_id: id, prompt: 'go' }],
        ['Stop', { session_id: id }], ['SessionEnd', { session_id: id, reason: 'clear' }]],
      'TaskCompleted', (id) => lifecycle(id, 'TaskCompleted', { task_subject: 'late' })],
    ['a parallel tool\'s result keeps the open prompt',
      (id) => [['UserPromptSubmit', { session_id: id, prompt: 'go' }],
        ['PermissionRequest', { session_id: id, tool_name: 'Bash', tool_input: { command: 'npm test' } }]],
      'PostToolUse', (id) => post(id, 'ls src', 'Bash')],
    ['the waited call\'s own result answers the prompt',
      (id) => [['UserPromptSubmit', { session_id: id, prompt: 'go' }],
        ['PermissionRequest', { session_id: id, tool_name: 'Bash', tool_input: { command: 'npm test' } }]],
      'PostToolUse', (id) => post(id, 'npm test', 'Bash')],
  ];

  for (const [name, setup, probeEvent, probe] of SCENARIOS) {
    test(name + ', whichever path writes it', () => {
      const id = 'both-' + name.replace(/[^a-z]+/gi, '-').slice(0, 30);
      const results = [];
      for (const pad of [false, true]) {
        const t = makeTempEnv(id);
        try {
          for (const [event, payload] of setup(id)) runUpdateState(event, payload, t.env);
          runUpdateState(probeEvent, probe(id)(pad), t.env);
          results.push(facts(readJSON(fileOf(t, id))));
        } finally { cleanup(t.tmp); }
      }
      assert.deepStrictEqual(results[1], results[0], 'the >1 MB path carries what the main path carries');
    });
  }

  // The face too: a huge successful result showed "large input".
  test('a successful tool end shows its own success face, whichever path writes it', () => {
    for (const [tool, command] of [['Bash', 'npm test'], ['mcp__playwright__browser_take_screenshot', '']]) {
      const id = 'both-face-' + tool.length;
      const faces = [];
      for (const pad of [false, true]) {
        const t = makeTempEnv(id);
        try {
          runUpdateState('UserPromptSubmit', { session_id: id, prompt: 'go' }, t.env);
          runUpdateState('PreToolUse', { session_id: id, tool_name: tool, tool_input: { command } }, t.env);
          runUpdateState('PostToolUse', post(id, command, tool)(pad), t.env);
          const s = readJSON(fileOf(t, id));
          faces.push([s.state, s.detail]);
        } finally { cleanup(t.tmp); }
      }
      assert.notStrictEqual(faces[1][1], 'large input', tool);
      assert.deepStrictEqual(faces[1], faces[0], tool);
    }
  });
});

module.exports = suite;
