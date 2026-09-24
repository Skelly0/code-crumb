#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Codex Wrapper -- bridges OpenAI Codex CLI to Code Crumb       |
// |                                                                |
// |  Wraps `codex exec --json` and translates its event stream     |
// |  (thread.started, turn.started|completed|failed, error, and    |
// |  item.started|updated|completed carrying typed items) into     |
// |  Code Crumb state file writes.                                 |
// |                                                                |
// |  Use it for headless runs; interactive Codex sessions are      |
// |  covered by the native hooks (node setup.js codex).            |
// |                                                                |
// |  Usage:                                                        |
// |    node adapters/codex-wrapper.js "your prompt here"           |
// |    node adapters/codex-wrapper.js -m gpt-5 "fix the bug"       |
// |                                                                |
// |  All flags before the last argument are passed to codex exec.  |
// +================================================================+

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const {
  writeState, writeSessionState, readStats, writeStats, guardedWriteState,
  initSession, buildExtra, trackEditedFile, creditOwnerSession,
  handleToolStart, handleToolEnd, processJsonlStream, signalExitCode, exitWhenFlushed,
} = require('./base-adapter');
const {
  toolToState, humanizeToolName, updateStreak, pruneFrequentFiles, prettyModelName, toText,
} = require('../state-machine');
const { buildEditorSpawn } = require('../launch');
const shared = require('../shared');
const { withStatsLock, SESSIONS_DIR, safeFilename } = shared;

// -- Session setup -----------------------------------------------------

// thread.started replaces this with the real codex thread id.
let sessionId = process.env.CLAUDE_SESSION_ID || `codex-${process.pid}`;
let threadStarted = false;
let committedAny = false; // a stats cycle has run under the current id
// A real identity: the caller's CLAUDE_SESSION_ID, or codex's own thread id.
function ownsRealId() {
  return threadStarted || !!process.env.CLAUDE_SESSION_ID;
}
const modelName = process.env.CODE_CRUMB_MODEL || 'codex';
const EDITOR = 'codex';
// Real model identity, from the `-m` this wrapper forwards to codex. Filled in
// by main(); '' when the run did not name one (codex then uses its configured
// default, which nothing in the event stream reports).
let codexModel = '';

// The model flag codex takes. Deliberately NOT shared with engmux's
// extractModel: that one strips a vendor prefix and returns an 'engmux'
// sentinel, and neither behaviour is right here.
function extractCodexModel(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-m' || args[i] === '--model') && args[i + 1]) return args[i + 1];
    if (args[i].startsWith('--model=')) return args[i].slice('--model='.length);
  }
  return '';
}

// Every id this process has owned. guardedWriteState refuses to touch a state
// file owned by another live session -- but the placeholder id used before
// thread.started is still us, so that one is taken over rather than going mute.
const ownIds = new Set([sessionId]);

// The last state written: a `reasoning` item thinks without wiping the detail
// line, and the exit handler stops the session where it stands.
let lastState = null;
let lastDetail = '';
let turnOutcome = null; // 'completed' | 'failed' once the turn ends

let lastPromptAt = 0; // attention stamp: set on thread/turn start, carried on every write

// A failed codex turn always ends in `turn.failed`, and only that breaks the
// streak. A top-level `error` on its own is not a failure: codex 0.146 emits
// one for every retryable stream error ("Reconnecting... 1/5", will_retry in
// the app-server protocol) and then carries on, so breaking the streak there
// zeroed it on turns that went on to complete. The per-turn flag still guards
// against counting one failure twice.
let streakBrokenThisTurn = false;
let finished = false; // set once by finishSession

// Set once codex's own native hooks (node setup.js codex) are seen writing
// this session. The wrapper then stops writing what the hooks already report
// (see hooksAreLive), or every run was two sessions -- double the tool
// calls, the daily sessions and the streak.
let hooksLive = false;
const WRAPPER_START = Date.now();

// How long after codex exits the wrapper waits for its stdout to close.
const EXIT_GRACE_MS = 3000;

function breakStreak(stats) {
  if (streakBrokenThisTurn) return;
  streakBrokenThisTurn = true;
  updateStreak(stats, true);
}

// Error messages from codex can be a whole JSON blob; the status line is one row.
function shortText(text, max = 60) {
  const s = String(text || '').replace(/[\r\n]+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

// -- Item classification -----------------------------------------------

// Map one Codex thread item to a Code Crumb tool event. `phase` is 'started'
// (item.started / item.updated) or 'completed'. Returns null when the item has
// nothing to show, otherwise any of:
//   toolName / toolInput   - classified by the shared tool tables
//   toolResponse           - the completion payload for those tables
//   state / detail         - an explicit override; a missing detail means
//                            "keep whatever is on screen"
//   filePaths              - every path an edit touched (stats tracking)
function classifyItem(item, phase) {
  if (!item || typeof item !== 'object') return null;
  const type = item.type || '';
  if (!type) return null;
  const done = phase === 'completed';
  const status = item.status || '';

  switch (type) {
    // Shell commands: the Bash tables split these into executing / testing /
    // installing / committing by the command text.
    case 'command_execution': {
      const command = item.command || '';
      if (!done) return { toolName: 'Bash', toolInput: { command } };
      if (status === 'declined') return { state: 'relieved', detail: 'command declined' };
      return {
        toolName: 'Bash',
        toolInput: { command },
        toolResponse: {
          stdout: item.aggregated_output || '',
          stderr: '',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : undefined,
          isError: status === 'failed',
        },
      };
    }

    // Patches: changes[] is {path, kind: add|delete|update}
    case 'file_change': {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map(c => (c && typeof c.path === 'string') ? c.path : '')
        .filter(Boolean);
      const first = paths[0] || '';
      const toolInput = { file_path: first };
      if (!done) return { toolName: 'Edit', toolInput, filePaths: paths };
      if (status === 'failed') {
        return {
          toolName: 'Edit', toolInput, state: 'error', detail: 'edit failed',
          toolResponse: { stdout: '', stderr: 'edit failed', isError: true },
        };
      }
      const detail = paths.length > 1
        ? `saved ${paths.length} files`
        : (first ? `saved ${path.basename(first)}` : 'code written');
      return {
        toolName: 'Edit', toolInput, state: 'proud', detail,
        toolResponse: { stdout: '', stderr: '' },
      };
    }

    // MCP calls go through the mcp__server__tool verb classifier
    case 'mcp_tool_call': {
      const server = item.server || 'external';
      const toolName = `mcp__${server}__${item.tool || ''}`;
      const toolInput = (item.arguments && typeof item.arguments === 'object') ? item.arguments : {};
      if (!done) return { toolName, toolInput };
      const failed = status === 'failed' || item.error != null;
      return {
        toolName, toolInput,
        toolResponse: {
          stdout: typeof item.result === 'string' ? item.result : '',
          stderr: failed ? shortText(item.error || 'tool failed') : '',
          isError: failed,
        },
      };
    }

    case 'web_search': {
      const toolInput = { query: item.query || '' };
      if (!done) return { toolName: 'WebSearch', toolInput };
      return { toolName: 'WebSearch', toolInput, toolResponse: { stdout: '', stderr: '' } };
    }

    // Codex's own delegation items -- the Task face
    case 'collab_tool_call':
    case 'collab_agent_tool_call': {
      const toolInput = { description: 'delegating' };
      if (!done) return { toolName: 'Task', toolInput };
      return { toolName: 'Task', toolInput, toolResponse: { stdout: '', stderr: '' } };
    }

    case 'todo_list':
    case 'plan_update': {
      if (!done) return { toolName: 'TodoWrite', toolInput: {} };
      return {
        toolName: 'TodoWrite', toolInput: {}, toolResponse: { stdout: '', stderr: '' },
        state: 'satisfied', detail: 'plan updated',
      };
    }

    case 'context_compaction':
      return done
        ? { state: 'satisfied', detail: 'memory compacted' }
        : { state: 'thinking', detail: 'compacting memory' };

    // Thinking out loud: keep the detail line as it is
    case 'reasoning':
      return { state: 'thinking' };

    case 'agent_message':
      return { state: 'responding', detail: '' };

    // Codex reports warnings as error items ("Skill descriptions were
    // shortened", "clamping SessionEnd hook timeout"): diagnostics about the
    // run, not the turn failing. A real failure arrives as the top-level
    // `error` event and `turn.failed`.
    case 'error':
      return null;

    // image_generation, image_view, dynamic_tool_call and anything codex adds
    // later: say what it is rather than showing a raw identifier.
    default: {
      const toolInput = {};
      if (!done) {
        return { toolName: type, toolInput, state: 'executing', detail: humanizeToolName(type) || 'working' };
      }
      return {
        toolName: type, toolInput, toolResponse: { stdout: '', stderr: '' },
        state: 'satisfied', detail: 'done',
      };
    }
  }
}

// -- State writing -----------------------------------------------------

// Global state write that survives the placeholder -> thread id handover.
function writeGlobal(state, detail, extra) {
  try {
    const existing = JSON.parse(fs.readFileSync(shared.STATE_FILE, 'utf8'));
    if (existing.sessionId && existing.sessionId !== sessionId && ownIds.has(existing.sessionId)) {
      writeState(state, detail, extra);
      return;
    }
  } catch {}
  guardedWriteState(sessionId, state, detail, extra);
}

// One stats read -> mutate -> write cycle plus the state files it implies.
// `decide(stats)` returns { state, detail, stopped, turnEnded, diffInfo } or
// null; a missing detail keeps the one already on screen.
//
// `stopped` is the SESSION ending (the wrapper exiting) and goes to both
// files. `turnEnded` is a turn ending: `stopped` on the global file (tmux and
// the ownership guard), `turnEnded` on the session file -- `stopped` there
// would retire the orbital and drop the session from the main-face policy.
function commit(decide) {
  committedAny = true;
  withStatsLock(() => {
    const stats = readStats();
    initSession(stats, sessionId);
    const out = decide(stats);
    if (out && out.state) {
      const detail = out.detail === undefined ? lastDetail : out.detail;
      // A turn or session end folds this session's time into today's total.
      if (out.stopped || out.turnEnded) creditOwnerSession(stats);
      const extra = { ...buildExtra(stats, sessionId, modelName, EDITOR, codexModel), pid: process.pid };
      if (out.diffInfo) extra.diffInfo = out.diffInfo;
      if (out.stopped || out.turnEnded) extra.stopped = true;
      if (lastPromptAt) extra.lastPromptAt = lastPromptAt;
      writeGlobal(out.state, detail, extra);
      const sessionExtra = { ...extra };
      if (!out.stopped) delete sessionExtra.stopped;
      if (out.turnEnded && !out.stopped) sessionExtra.turnEnded = true;
      writeSessionState(sessionId, out.state, detail, !!out.stopped, sessionExtra);
      lastState = out.state;
      lastDetail = detail;
    }
    pruneFrequentFiles(stats.frequentFiles);
    writeStats(stats);
  });
}

// countTool is false for item.updated: the same tool must not be counted twice.
function applyItem(item, phase, countTool) {
  const c = classifyItem(item, phase);
  if (!c) return;
  commit((stats) => {
    let state = c.state;
    let detail = c.detail;
    let diffInfo = null;
    if (c.toolName) {
      if (phase === 'completed') {
        const response = c.toolResponse || {};
        const result = handleToolEnd(stats, c.toolName, c.toolInput, response, !!response.isError);
        state = state || result.state;
        if (detail === undefined) detail = result.detail;
        diffInfo = result.diffInfo;
      } else if (countTool) {
        const result = handleToolStart(stats, c.toolName, c.toolInput);
        state = state || result.state;
        if (detail === undefined) detail = result.detail;
        // handleToolStart only tracks the first path; a patch can touch many.
        for (const fp of (c.filePaths || []).slice(1)) {
          trackEditedFile(stats, c.toolName, { file_path: fp });
        }
      } else {
        const result = toolToState(c.toolName, c.toolInput);
        state = state || result.state;
        if (detail === undefined) detail = result.detail;
      }
    }
    return { state: state || 'thinking', detail, diffInfo };
  });
}

// -- JSONL event dispatcher --------------------------------------------

// Whether codex's native hooks are writing this session too. They write the
// same file (same id) with the editor tag `codex` and never this process's
// pid -- a hook's pid is codex's (Unix) or absent (win32) -- so a hook write
// newer than this wrapper is proof. Checked before each write until seen.
function hooksAreLive() {
  if (!threadStarted) return false;
  try {
    const f = JSON.parse(fs.readFileSync(
      path.join(SESSIONS_DIR, safeFilename(sessionId) + '.json'), 'utf8'));
    if (!hooksLive && f && f.editor === 'codex' && f.pid !== process.pid
        && (f.timestamp || 0) >= WRAPPER_START) hooksLive = true;
    // Follow what the hooks last wrote, so the run's final frame (see
    // closeOutcome) is their state, carrying their attention stamp and model,
    // and not whatever this wrapper wrote before it went quiet.
    if (hooksLive && f && typeof f.state === 'string') {
      lastState = f.state;
      lastDetail = typeof f.detail === 'string' ? f.detail : '';
      if (f.lastPromptAt) lastPromptAt = f.lastPromptAt;
      if (typeof f.model === 'string' && f.model) codexModel = f.model;
    }
  } catch {}
  return hooksLive;
}

// With the hooks live, they report the turn and every tool more precisely
// than the event stream does. What they never see stays the wrapper's: a
// failed turn (codex runs no Stop for one), a retry notice, and the end of
// the run (finishSession).
const HOOK_COVERED = new Set(['thread.started', 'turn.started', 'turn.completed',
  'item.started', 'item.updated', 'item.completed']);

function handleEvent(event) {
  // After the session-ending write, nothing may write a live state again:
  // codex keeps printing while it shuts down after a forwarded signal, and a
  // late item (or a late thread.started, which minted a brand-new live
  // session) used to overwrite the retirement.
  if (finished) return;
  try {
    const type = (event && event.type) || '';
    if (type === 'thread.started' && event.thread_id) {
      sessionId = toText(event.thread_id) || sessionId;
      ownIds.add(sessionId);
      threadStarted = true;
    }
    if (HOOK_COVERED.has(type) && hooksAreLive()) {
      if (type === 'turn.started') streakBrokenThisTurn = false;
      if (type === 'turn.completed') turnOutcome = 'completed';
      return;
    }

    if (type === 'thread.started') {
      // The codex thread id is the session identity; before it arrives the
      // wrapper only owns the global state file, so no orphan orbital is left.
      // The id was taken above: the bare thread id, which is also the
      // `session_id` codex's native hooks carry, so a run the hooks see too is
      // one session, not two (the placeholder stays editor-prefixed).
      threadStarted = true;
      lastPromptAt = Date.now();
      commit(() => ({ state: 'starting', detail: 'codex is waking up' }));
    }
    else if (type === 'turn.started') {
      streakBrokenThisTurn = false;
      lastPromptAt = Date.now();
      commit(() => ({ state: 'thinking', detail: 'reading your message' }));
    }
    else if (type === 'turn.completed') {
      turnOutcome = 'completed';
      commit(() => ({ state: 'responding', detail: 'wrapping up', turnEnded: true }));
    }
    else if (type === 'turn.failed') {
      turnOutcome = 'failed';
      const err = event.error;
      const message = typeof err === 'string' ? err : (err && (err.message || err.type));
      const detail = shortText(message) || 'turn failed';
      commit((stats) => {
        breakStreak(stats);
        return { state: 'error', detail, turnEnded: true };
      });
    }
    else if (type === 'error') {
      // Shown, but not counted: see streakBrokenThisTurn.
      const detail = shortText(event.message) || 'something went wrong';
      commit(() => ({ state: 'error', detail }));
    }
    else if (type === 'item.started') applyItem(event.item, 'started', true);
    else if (type === 'item.updated') applyItem(event.item, 'started', false);
    else if (type === 'item.completed') applyItem(event.item, 'completed', true);
  } catch {
    // Silent failure -- a broken face must not break the wrapper
  }
}

// -- Ending the session ------------------------------------------------

// The final frame and exit code when codex closes. Pure, so every branch is
// testable without a real codex or a real signal.
//   code / signal - what the child's 'close' reported
//   caught        - a signal the WRAPPER received (Ctrl+C, a kill), or null
// A child killed by a signal reports code null: `code || 0` used to read that
// as success and leave the last work face standing.
function closeOutcome({ code, signal, caught, turnOutcome: outcome, lastState: ls, lastDetail: ld }) {
  const sig = caught || signal || null;
  if (sig) {
    return {
      state: 'error',
      detail: sig === 'SIGINT' ? 'interrupted' : `codex killed (${sig})`,
      stopped: true,
      exitCode: signalExitCode(sig),
    };
  }
  if (code && outcome !== 'failed') {
    return { state: 'error', detail: `codex exited ${code}`, stopped: true, exitCode: code };
  }
  return {
    state: ls || 'responding',
    detail: ls ? ld : 'codex finished',
    stopped: true,
    exitCode: code || 0,
  };
}

// The session-ending write happens exactly once, whichever of 'close' or a
// caught signal gets there first (`finished` is declared with the other
// module state, above handleEvent, which also reads it).
function finishSession(outcome) {
  if (finished) return false;
  finished = true;
  try {
    if (hooksLive) hooksAreLive();   // the hooks' latest frame, stamp and model
    if (!ownsRealId() && !committedAny) {
      // Codex ended (or was interrupted) before saying anything: the id is
      // still the placeholder, which must not become a session of its own --
      // a full commit counted it in daily.sessionCount and left an orbital.
      writeGlobal(outcome.state, outcome.detail, {
        sessionId, modelName, ...(codexModel ? { model: codexModel } : {}),
        editor: EDITOR, pid: process.pid, stopped: true,
      });
    } else {
      commit(() => ({ state: outcome.state, detail: outcome.detail, stopped: true }));
    }
  } catch {}
  return true;
}

// -- Main: spawn codex exec --json and parse JSONL -------------------

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node codex-wrapper.js [codex-flags] "your prompt"');
    console.error('  Wraps `codex exec --json` and shows Code Crumb reactions.');
    process.exit(1);
  }

  // A first frame before codex answers. No stats cycle and no session file:
  // the identity is a placeholder until thread.started and must not count as
  // a session of its own.
  codexModel = prettyModelName(extractCodexModel(args));

  writeGlobal('thinking', 'starting codex...', {
    sessionId, modelName, ...(codexModel ? { model: codexModel } : {}),
    editor: EDITOR, pid: process.pid,
  });
  lastState = 'thinking';
  lastDetail = 'starting codex...';

  // On Windows `codex` is a .cmd shim and Node refuses to spawn it without a
  // shell; buildEditorSpawn knows the rule. Its default stdio is 'inherit',
  // which this wrapper cannot use -- it has to read stdout.
  const spec = buildEditorSpawn(process.platform, 'codex', ['exec', '--json', ...args]);
  const codex = spawn(spec.cmd, spec.args, {
    ...spec.opts,
    stdio: ['inherit', 'pipe', 'inherit'],
  });

  processJsonlStream(codex.stdout, handleEvent);

  // Also pass through to our stdout so user sees output
  codex.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
  });

  codex.on('error', (err) => {
    console.error('Failed to start codex:', err.message);
    console.error('Make sure the Codex CLI is installed: https://github.com/openai/codex');
    process.exit(1);
  });

  // A caught signal (Ctrl+C, a kill) used to end the wrapper before 'close'
  // ever fired: no final write, and the orbital stood on its last work face
  // until it went stale. Now the session is retired at once, the signal is
  // passed on to codex, and 'close' exits 128+N when codex goes. If codex
  // ignores it, a short grace timer exits anyway; a second signal exits now.
  let caught = null;
  const onSignal = (sig) => {
    if (caught) process.exit(signalExitCode(caught));
    caught = sig;
    finishSession(closeOutcome({ code: null, signal: null, caught: sig }));
    try { codex.kill(sig); } catch {}
    setTimeout(() => process.exit(signalExitCode(sig)), 2000).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => onSignal(sig));

  // 'close', not 'exit': exit fires while stdout may still hold buffered
  // JSONL, so the last events of a turn (turn.completed included) could be
  // lost to the process.exit below.
  let closed = false;
  const onClose = (code, signal) => {
    if (closed) return;
    closed = true;
    if (hooksLive) hooksAreLive();   // end on the hooks' latest frame
    // The stream already said how the turn ended; exiting only stops the
    // session. A non-zero exit with no failure reported is the crash case,
    // and a signal (ours or anyone's) is an interruption.
    const outcome = closeOutcome({ code, signal, caught, turnOutcome, lastState, lastDetail });
    finishSession(outcome);
    exitWhenFlushed(outcome.exitCode);
  };
  codex.on('close', onClose);
  // But 'close' waits for every holder of the stdout pipe, and anything codex
  // (or a shell shim in front of it) leaves running in the background keeps
  // it open: the wrapper then sat blocking the user's terminal, the session
  // unretired, for as long as that process lived. Once codex itself has
  // exited, a short grace drains what is buffered and then ends the run.
  codex.on('exit', (code, signal) => {
    setTimeout(() => onClose(code, signal), EXIT_GRACE_MS).unref();
  });
}

if (require.main === module) {
  main();
}

module.exports = { classifyItem, handleEvent, closeOutcome };
