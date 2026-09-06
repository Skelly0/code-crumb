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
  initSession, buildExtra, trackEditedFile,
  handleToolStart, handleToolEnd, processJsonlStream,
} = require('./base-adapter');
const {
  toolToState, humanizeToolName, updateStreak, pruneFrequentFiles,
} = require('../state-machine');
const { buildEditorSpawn } = require('../launch');
const shared = require('../shared');

// Task 4 adds withStatsLock to shared.js; until it lands the stats cycles run
// unlocked, exactly as they did before.
const withStatsLock = shared.withStatsLock || ((fn) => fn());

// -- Session setup -----------------------------------------------------

// thread.started replaces this with the real codex thread id.
let sessionId = process.env.CLAUDE_SESSION_ID || `codex-${process.pid}`;
const modelName = process.env.CODE_CRUMB_MODEL || 'codex';
const EDITOR = 'codex';

// Every id this process has owned. guardedWriteState refuses to touch a state
// file owned by another live session -- but the placeholder id used before
// thread.started is still us, so that one is taken over rather than going mute.
const ownIds = new Set([sessionId]);

// The last state written: a `reasoning` item thinks without wiping the detail
// line, and the exit handler stops the session where it stands.
let lastState = null;
let lastDetail = '';
let turnOutcome = null; // 'completed' | 'failed' once the turn ends

// A failed codex turn emits BOTH a top-level `error` and a `turn.failed`.
// Breaking the streak on each would leave brokenStreak at 0 -- the face reads
// that as "no streak was lost" and skips the reaction -- and would count the
// same failure twice in totalErrors. So the streak breaks at most once per
// turn; a standalone `error` with no turn.failed still breaks it.
let streakBrokenThisTurn = false;

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
// `decide(stats)` returns { state, detail, stopped, diffInfo } or null; a
// missing detail keeps the one already on screen.
function commit(decide) {
  withStatsLock(() => {
    const stats = readStats();
    initSession(stats, sessionId);
    const out = decide(stats);
    if (out && out.state) {
      const detail = out.detail === undefined ? lastDetail : out.detail;
      const extra = { ...buildExtra(stats, sessionId, modelName, EDITOR), pid: process.pid };
      if (out.diffInfo) extra.diffInfo = out.diffInfo;
      if (out.stopped) extra.stopped = true;
      writeGlobal(out.state, detail, extra);
      writeSessionState(sessionId, out.state, detail, !!out.stopped, extra);
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

function handleEvent(event) {
  try {
    const type = (event && event.type) || '';

    if (type === 'thread.started') {
      // The codex thread id is the session identity; before it arrives the
      // wrapper only owns the global state file, so no orphan orbital is left.
      if (event.thread_id) {
        sessionId = `codex-${event.thread_id}`;
        ownIds.add(sessionId);
      }
      commit(() => ({ state: 'starting', detail: 'codex is waking up' }));
    }
    else if (type === 'turn.started') {
      streakBrokenThisTurn = false;
      commit(() => ({ state: 'thinking', detail: 'reading your message' }));
    }
    else if (type === 'turn.completed') {
      turnOutcome = 'completed';
      commit(() => ({ state: 'responding', detail: 'wrapping up', stopped: true }));
    }
    else if (type === 'turn.failed') {
      turnOutcome = 'failed';
      const err = event.error;
      const message = typeof err === 'string' ? err : (err && (err.message || err.type));
      const detail = shortText(message) || 'turn failed';
      commit((stats) => {
        breakStreak(stats);
        return { state: 'error', detail, stopped: true };
      });
    }
    else if (type === 'error') {
      const detail = shortText(event.message) || 'something went wrong';
      commit((stats) => {
        breakStreak(stats);
        return { state: 'error', detail };
      });
    }
    else if (type === 'item.started') applyItem(event.item, 'started', true);
    else if (type === 'item.updated') applyItem(event.item, 'started', false);
    else if (type === 'item.completed') applyItem(event.item, 'completed', true);
  } catch {
    // Silent failure -- a broken face must not break the wrapper
  }
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
  writeGlobal('thinking', 'starting codex...', {
    sessionId, modelName, editor: EDITOR, pid: process.pid,
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

  // 'close', not 'exit': exit fires while stdout may still hold buffered
  // JSONL, so the last events of a turn (turn.completed included) could be
  // lost to the process.exit below.
  codex.on('close', (code) => {
    // The stream already said how the turn ended; exiting only stops the
    // session. A non-zero exit with no failure reported is the crash case.
    commit(() => {
      if (code && turnOutcome !== 'failed') {
        return { state: 'error', detail: `codex exited ${code}`, stopped: true };
      }
      return {
        state: lastState || 'responding',
        detail: lastState ? lastDetail : 'codex finished',
        stopped: true,
      };
    });
    process.exit(code || 0);
  });
}

if (require.main === module) {
  main();
}

module.exports = { classifyItem, handleEvent };
