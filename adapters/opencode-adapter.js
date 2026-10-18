#!/usr/bin/env node
'use strict';

// +================================================================+
// |  OpenCode Adapter -- bridges OpenCode events to Code Crumb     |
// |                                                                |
// |  Fed by adapters/opencode-plugin.mjs (see setup.js opencode),  |
// |  one process per event, payload on stdin:                      |
// |    session.created        -> starting                          |
// |    thinking               -> thinking   (a reasoning part)     |
// |    tool.execute.before    -> tool_start (reading/coding/...)   |
// |    tool.execute.after     -> tool_end   (happy/relieved/...)   |
// |    tool.error             -> tool_end with isError             |
// |    permission.asked       -> waiting "allow?"                  |
// |    permission.replied     -> satisfied                         |
// |    question.asked         -> waiting "asking you"              |
// |    question.replied       -> satisfied (answered)              |
// |    session.compacted      -> satisfied "memory compacted"      |
// |    session.idle           -> turn_end (happy, stopped)         |
// |    session.error          -> error, ending the turn            |
// |                                                                |
// |  Plugin payload fields:                                        |
// |    { "type": "...", "sessionId": "ses_1", "tool": "edit",      |
// |      "toolInput": {...}, "output": "...", "error": "..." }     |
// |                                                                |
// |  The older nested spelling is still accepted:                  |
// |    { "session_id": "...", "input": { "tool", "args" },         |
// |      "output": { "error": "..." } }                            |
// |  as is the generic format shared with the other adapters:      |
// |    { "event": "tool_start"|"tool_end"|"turn_end"|"error", ... }|
// +================================================================+

const { runStdinAdapter } = require('./base-adapter');

// -- Event normalisation ------------------------------------------------
// Map OpenCode event types to the generic internal names.

function mapOpenCodeEventType(raw) {
  switch (raw) {
    case 'session.created':        return 'session_start';
    case 'message.part.updated':   return 'message_update';
    case 'thinking':               return 'thinking';
    case 'tool.execute.before':    return 'tool_start';
    case 'tool.execute.after':     return 'tool_end';
    // A tool that throws never reaches tool.execute.after; the plugin
    // reports it from the failed message part instead.
    case 'tool.error':             return 'tool_end';
    case 'session.idle':           return 'turn_end';
    case 'session.error':          return 'error';
    case 'session.compacted':      return 'compacted';
    case 'permission.asked':       return 'permission_ask';
    case 'permission.replied':     return 'permission_reply';
    case 'question.asked':         return 'question_ask';
    case 'question.replied':       return 'question_reply';
    case 'question.rejected':      return 'question_reject';
    default:                       return raw;
  }
}

// OpenCode's own tool names for what Claude Code calls AskUserQuestion and
// Enter/ExitPlanMode, so the shared tables give them the same faces: the
// question tool waits on the user (it read "thinking / question" and the face
// went to sleep while OpenCode asked), and plan_exit asks for approval of the
// plan through the same question service.
const TOOL_ALIASES = {
  question: 'AskUserQuestion',
  plan_exit: 'ExitPlanMode',
  plan_enter: 'EnterPlanMode',
};

// What a dismissed question throws (QuestionRejectedError): the user's
// choice, not a failure.
const DISMISSED_RE = /dismissed this question/i;

// The SDK error names worth telling apart (session.error's errorName).
const ABORTED_RE = /^(MessageAbortedError|AbortError)$/;
const OVERFLOW_NAME = 'ContextOverflowError';

// Only strings are useful as text; an object here used to reach the error
// forensics as "[object Object]" or a raw boolean.
function textField(v) {
  return typeof v === 'string' ? v : '';
}

// OpenCode's built-in tools spell their arguments in camelCase; the shared
// tool->state map, the edited-file tracker and the diff counter read the
// snake_case names. Aliased, `edit` shows "editing a.js", the file lands in
// frequentFiles, and an edit or multiedit gets its "+N -M" (it had none:
// the diff counter found no old_string/new_string).
const ARG_ALIASES = [['filePath', 'file_path'], ['oldString', 'old_string'], ['newString', 'new_string']];

function aliasArgs(input) {
  let out = input;
  for (const [from, to] of ARG_ALIASES) {
    if (!input[to] && typeof input[from] === 'string') {
      if (out === input) out = { ...input };
      out[to] = input[from];
    }
  }
  return out;
}

function normaliseToolInput(raw) {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const out = aliasArgs(input);
  // multiedit: { filePath, edits: [{ filePath, oldString, newString }] }
  if (!Array.isArray(input.edits)) return out;
  return {
    ...out,
    edits: input.edits.map(e => (e && typeof e === 'object' && !Array.isArray(e) ? aliasArgs(e) : e)),
  };
}

function normaliseEvent(data) {
  const rawEvent = data.type || data.event || '';
  const event = mapOpenCodeEventType(rawEvent);

  // Plugin payloads are flat (tool, toolInput, output); the older OpenCode
  // spelling nests them (input.tool, input.args) and the generic format uses
  // tool/tool_input. All three stay supported.
  const opencodeInput = data.input || {};
  const rawTool = data.tool || opencodeInput.tool || data.tool_name || '';
  const toolName = (typeof rawTool === 'string' && TOOL_ALIASES[rawTool]) || rawTool;
  const toolInput = normaliseToolInput(
    data.toolInput || data.tool_input || opencodeInput.args
  );
  const toolOutput = data.output?.content?.[0]?.text
    || data.output?.output
    || textField(data.output)
    || '';
  const stderr = textField(data.error) || textField(data.output?.error);
  const isError = !!(data.error || data.output?.error || data.is_error || data.isError);

  const sessionId = data.sessionId || data.session_id || '';

  // A session.error that names no session belongs to none: a plugin that
  // failed to load, a skill that failed to parse. Drawn, it was a phantom
  // opencode-<pid> session that also took the stats owner and the streak.
  // (The plugin drops these already; this covers any older copy of it.)
  if (rawEvent === 'session.error' && !sessionId && !process.env.CLAUDE_SESSION_ID) {
    return { skip: true };
  }

  // Raw provider model id, when the plugin observed one. Prettified by
  // base-adapter -- this side just carries it.
  const model = data.model || '';

  // Set on a task tool's child session (see the plugin's session.created).
  const parentSession = textField(data.parentSession);

  // How a shell command ended, from the tool's result metadata (see the
  // plugin's shellOutcome): the only place OpenCode 1.18 reports it.
  const exitCode = typeof data.exit === 'number' ? data.exit
    : typeof data.exitCode === 'number' ? data.exitCode : undefined;
  const interrupted = data.interrupted === true;

  return {
    event, toolName, toolInput, toolOutput, isError, stderr, sessionId, model, parentSession,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(interrupted ? { interrupted } : {}),
  };
}

// -- Custom event mapping -----------------------------------------------
// OpenCode has a few event types that don't map to the generic set.

function mapEvent(event, toolName, toolInput, toolOutput, isError, data) {
  if (event === 'session_start') {
    return { state: 'starting', detail: 'session started' };
  }
  if (event === 'thinking') {
    return { state: 'thinking', detail: textField(data.thinking) || 'analyzing' };
  }
  if (event === 'permission_ask') {
    // "allow?" is the detail face.js keys the question particles off.
    return { state: 'waiting', detail: 'allow?' };
  }
  if (event === 'permission_reply') {
    // `answered`: the renderer drops the prompt if it is still queued.
    return { state: 'satisfied', detail: 'got your answer', extra: { answered: true } };
  }
  // "asking" is what face.js keys the question particles off.
  if (event === 'question_ask') {
    return { state: 'waiting', detail: 'asking you' };
  }
  if (event === 'question_reply') {
    return { state: 'satisfied', detail: 'got your answer', extra: { answered: true } };
  }
  if (event === 'question_reject') {
    return { state: 'satisfied', detail: 'question dismissed', extra: { answered: true } };
  }
  if (event === 'compacted') {
    return { state: 'satisfied', detail: 'memory compacted' };
  }
  if (event === 'tool_end' && isError && DISMISSED_RE.test(textField(data.error))) {
    // The question tool (or plan_exit) throws when the user dismisses it:
    // an answer, not a broken streak.
    return { state: 'satisfied', detail: 'question dismissed', extra: { answered: true } };
  }
  if (event === 'tool_end' && data.timedOut === true) {
    // The shell tool killed it; the exit code is null then, never an error
    // the forensics could see.
    return { state: 'error', detail: 'timed out', breakStreak: true };
  }
  // A session.error is the end of the turn (OpenCode sets the session idle
  // right after it), and shown as such, like Claude Code's StopFailure: the
  // error stays on screen through the session.idle that follows (see
  // `turnError` in base-adapter). Two kinds are no failure of the turn:
  //   - an Esc (MessageAbortedError) is the user's choice: `interrupted`,
  //     ending the turn, the streak left alone -- as for Codex's Interrupt
  //   - a context overflow is compacted away and the turn carries on: the
  //     face shows the compaction. Should it be followed straight by the
  //     idle instead (compaction off, or it could not fit), the plugin marks
  //     that idle `overflowFailed`, below.
  if (event === 'error' && (data.type === 'session.error' || data.errorName)) {
    const name = textField(data.errorName);
    if (name === OVERFLOW_NAME) return { state: 'thinking', detail: 'compacting memory' };
    if (ABORTED_RE.test(name)) {
      return { state: 'error', detail: 'interrupted', stopped: true, extra: { turnError: 'interrupted' } };
    }
    const detail = textField(data.error) || textField(data.output?.error) || textField(data.message)
      || 'something went wrong';
    return { state: 'error', detail, stopped: true, breakStreak: true, extra: { turnError: detail } };
  }
  // The idle itself is the failed turn's end: nothing follows to keep it for.
  if (event === 'turn_end' && data.overflowFailed === true) {
    return { state: 'error', detail: 'context too long', stopped: true, breakStreak: true };
  }
  if (event === 'message_update') {
    if (data.is_thinking) {
      return { state: 'thinking', detail: data.thinking || 'analyzing' };
    } else if (data.tools_called) {
      return { state: 'responding', detail: 'generating response' };
    }
    return { state: 'waiting', detail: 'receiving message' };
  }
  if (event === 'error' && !data.message && typeof data.error === 'string') {
    // The generic {event:'error'} format: fall through to the shared error
    // branch (it is the one that breaks the streak), but under a field name
    // that branch actually reads.
    data.message = data.error;
  }
  return null; // Fall through to common handling
}

// -- Main ---------------------------------------------------------------

if (require.main === module) {
  runStdinAdapter({
    defaultModel: 'opencode',
    defaultEditor: 'opencode',
    normaliseEvent,
    mapEvent,
  });
}

module.exports = { normaliseEvent, mapEvent, mapOpenCodeEventType, TOOL_ALIASES };
