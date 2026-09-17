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
// |    session.idle           -> turn_end (happy, stopped)         |
// |    session.error          -> error                             |
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
    case 'permission.asked':       return 'permission_ask';
    case 'permission.replied':     return 'permission_reply';
    default:                       return raw;
  }
}

// Only strings are useful as text; an object here used to reach the error
// forensics as "[object Object]" or a raw boolean.
function textField(v) {
  return typeof v === 'string' ? v : '';
}

// OpenCode's built-in tools name their file argument `filePath`; the shared
// tool->state map and the edited-file tracker read `file_path`. Alias it so
// `edit` shows "editing a.js" and the file lands in frequentFiles.
function normaliseToolInput(raw) {
  const input = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  if (!input.file_path && typeof input.filePath === 'string') {
    return { ...input, file_path: input.filePath };
  }
  return input;
}

function normaliseEvent(data) {
  const rawEvent = data.type || data.event || '';
  const event = mapOpenCodeEventType(rawEvent);

  // Plugin payloads are flat (tool, toolInput, output); the older OpenCode
  // spelling nests them (input.tool, input.args) and the generic format uses
  // tool/tool_input. All three stay supported.
  const opencodeInput = data.input || {};
  const toolName = data.tool || opencodeInput.tool || data.tool_name || '';
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

  // Raw provider model id, when the plugin observed one. Prettified by
  // base-adapter -- this side just carries it.
  const model = data.model || '';

  return { event, toolName, toolInput, toolOutput, isError, stderr, sessionId, model };
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
    return { state: 'satisfied', detail: 'got your answer' };
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
    // Fall through to the shared error branch (it is the one that breaks the
    // streak), but under a field name that branch actually reads.
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

module.exports = { normaliseEvent, mapEvent, mapOpenCodeEventType };
