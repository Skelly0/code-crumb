#!/usr/bin/env node
'use strict';

// +================================================================+
// |  OpenCode Adapter -- bridges OpenCode events to Code Crumb          |
// |                                                                  |
// |  OpenCode uses a plugin system that emits events like:         |
// |    - tool.execute.before  (maps to tool_start state)           |
// |    - tool.execute.after   (maps to tool_end state)             |
// |    - session.idle         (maps to turn_end/happy)            |
// |    - session.error        (maps to error state)                |
// |                                                                  |
// |  Usage (with OpenCode plugin):                                  |
// |    Add a plugin that pipes events to this adapter via stdin.   |
// |                                                                  |
// |  Event Schema from OpenCode plugins:                            |
// |    {                                                             |
// |      "type": "tool.execute.before"|"tool.execute.after"|...    |
// |      "input": { "tool": "...", "args": {...} },                |
// |      "output": {...}                                            |
// |    }                                                             |
// |                                                                  |
// |  Also supports generic format for compatibility:               |
// |    { "event": "tool_start"|"tool_end"|"turn_end"|"error", ... } |
// +================================================================+

const { runStdinAdapter } = require('./base-adapter');

// -- Event normalisation ------------------------------------------------
// Map OpenCode event types to the generic internal names.

function mapOpenCodeEventType(raw) {
  switch (raw) {
    case 'session.created':        return 'session_start';
    case 'message.part.updated':   return 'message_update';
    case 'tool.execute.before':    return 'tool_start';
    case 'tool.execute.after':     return 'tool_end';
    case 'session.idle':           return 'turn_end';
    case 'session.error':          return 'error';
    default:                       return raw;
  }
}

function normaliseEvent(data) {
  const rawEvent = data.type || data.event || '';
  const event = mapOpenCodeEventType(rawEvent);

  // OpenCode: input.tool, input.args; Generic: tool, tool_input
  const opencodeInput = data.input || {};
  const toolName = opencodeInput.tool || data.tool || data.tool_name || '';
  const toolArgs = opencodeInput.args || {};
  const toolInput = data.input || data.tool_input || toolArgs;
  const toolOutput = data.output?.content?.[0]?.text
    || data.output?.output
    || data.output
    || '';
  const isError = data.output?.error || data.error || data.is_error || false;
  const stderr = data.output?.error || '';

  return { event, toolName, toolInput, toolOutput, isError, stderr };
}

// -- Custom event mapping -----------------------------------------------
// OpenCode has a few event types that don't map to the generic set.

function mapEvent(event, toolName, toolInput, toolOutput, isError, data) {
  if (event === 'session_start') {
    return { state: 'waiting', detail: 'session started' };
  }
  if (event === 'message_update') {
    if (data.is_thinking) {
      return { state: 'thinking', detail: data.thinking || 'analyzing' };
    } else if (data.tools_called) {
      return { state: 'responding', detail: 'generating response' };
    }
    return { state: 'waiting', detail: 'receiving message' };
  }
  return null; // Fall through to common handling
}

// -- Main ---------------------------------------------------------------

if (require.main === module) {
  runStdinAdapter({
    defaultModel: 'opencode',
    normaliseEvent,
    mapEvent,
  });
}

module.exports = { normaliseEvent, mapEvent, mapOpenCodeEventType };
