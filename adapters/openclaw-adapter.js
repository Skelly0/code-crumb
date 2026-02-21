#!/usr/bin/env node
'use strict';

// +================================================================+
// |  OpenClaw Adapter -- bridges OpenClaw/Pi events to Code Crumb    |
// |                                                                  |
// |  OpenClaw (formerly Clawdbot/Moltbot) uses the Pi coding agent  |
// |  engine. Pi's core tools: read, write, edit, bash.            |
// |  OpenClaw adds: exec, process, browser, canvas, sessions, etc.  |
// |                                                                  |
// |  This adapter accepts events via stdin JSON, supporting both    |
// |  Pi-native event names and the generic Code Crumb format.        |
// |                                                                  |
// |  Pi-native events:                                               |
// |    tool_call            → before tool execution                 |
// |    tool_execution_start → tool execution begins                 |
// |    tool_execution_end   → tool execution completes              |
// |    tool_result          → after tool execution (with output)    |
// |                                                                  |
// |  Generic events (also accepted):                                 |
// |    tool_start, tool_end, turn_end, error, waiting               |
// |                                                                  |
// |  Usage (standalone):                                             |
// |    echo '{"event":"tool_call","toolName":"edit",...}' |         |
// |      node adapters/openclaw-adapter.js                           |
// |                                                                  |
// |  Usage (as Pi extension -- add to your skill or extension):     |
// |    const { execSync } = require('child_process');                |
// |    pi.on('tool_call', (event) => {                              |
// |      execSync(`echo '${JSON.stringify({                         |
// |        event: 'tool_call',                                       |
// |        toolName: event.toolName,                                 |
// |        input: event.input                                        |
// |      })}' | node /path/to/openclaw-adapter.js`);                |
// |    });                                                           |
// +================================================================+

const { runStdinAdapter } = require('./base-adapter');

// -- Event normalisation ------------------------------------------------
// Pi uses event names like tool_call, tool_execution_start, etc.
// Normalise them to the generic tool_start / tool_end format.

function normalisePiEvent(raw) {
  switch (raw) {
    case 'tool_call':
    case 'tool_execution_start':
      return 'tool_start';
    case 'tool_execution_end':
    case 'tool_result':
      return 'tool_end';
    case 'session_end':
    case 'turn_end':
    case 'Stop':
      return 'turn_end';
    case 'Notification':
      return 'waiting';
    default:
      return raw; // tool_start, tool_end, error, waiting pass through
  }
}

function normaliseEvent(data) {
  const event = normalisePiEvent(data.event || '');
  // Pi uses toolName; generic uses tool/tool_name
  const toolName = data.toolName || data.tool || data.tool_name || '';
  const toolInput = data.input || data.tool_input || {};
  const toolOutput = data.output || data.result || '';
  const isError = data.error || data.is_error || data.blocked || false;
  const stderr = data.stderr || '';

  return { event, toolName, toolInput, toolOutput, isError, stderr };
}

// -- Main ---------------------------------------------------------------

if (require.main === module) {
  runStdinAdapter({
    defaultModel: 'openclaw',
    normaliseEvent,
    mapEvent: null, // No custom event types -- all handled by common logic
  });
}

module.exports = { normaliseEvent, normalisePiEvent };
