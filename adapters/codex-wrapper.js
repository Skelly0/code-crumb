#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Codex Wrapper -- bridges OpenAI Codex CLI to Code Crumb           |
// |                                                                  |
// |  Wraps `codex exec --json` and translates JSONL events into     |
// |  Code Crumb state file writes. Only works in non-interactive    |
// |  (headless) mode since Codex lacks a hook system.               |
// |                                                                  |
// |  Usage:                                                          |
// |    node adapters/codex-wrapper.js "your prompt here"            |
// |    node adapters/codex-wrapper.js --approval auto "fix the bug" |
// |                                                                  |
// |  All flags before the last argument are passed to codex exec.    |
// +================================================================+

const { spawn } = require('child_process');
const path = require('path');
const {
  writeSessionState, readStats, writeStats, guardedWriteState,
  initSession, buildExtra, handleToolStart, handleToolEnd,
  processJsonlStream,
} = require('./base-adapter');
const { SUBAGENT_TOOLS } = require('../state-machine');

// -- Session setup -----------------------------------------------------

const sessionId = process.env.CLAUDE_SESSION_ID || `codex-${process.pid}`;
const modelName = process.env.CODE_CRUMB_MODEL || 'codex';
const stats = readStats();
initSession(stats, sessionId);

// Track active tool calls by item ID
const activeTools = new Map();
const activeSubagents = [];

function extra() {
  return buildExtra(stats, sessionId, modelName);
}

// -- JSONL Event Processor -------------------------------------------

function handleEvent(event) {
  // Re-read stats from disk to avoid overwriting concurrent sessions' changes
  const fresh = readStats();
  fresh.session = stats.session;
  fresh.daily = stats.daily;
  fresh.frequentFiles = { ...fresh.frequentFiles, ...stats.frequentFiles };
  Object.assign(stats, fresh);

  try {
    const type = event.type || '';
    const item = event.item || {};

    // Clear old milestones
    if (stats.recentMilestone && Date.now() - stats.recentMilestone.at > 8000) {
      stats.recentMilestone = null;
    }

    // Tool call started (item.created with tool_use type)
    if (type === 'item.created' && item.type === 'tool_use') {
      const toolName = item.name || item.tool_name || '';
      const toolInput = item.input || item.tool_input || {};

      activeTools.set(item.id, { toolName, toolInput });

      const { state, detail } = handleToolStart(stats, toolName, toolInput);

      if (SUBAGENT_TOOLS.test(toolName)) {
        stats.session.subagentCount++;

        // Create synthetic session for subagent
        const subId = `${sessionId}-sub-${Date.now()}`;
        const desc = toolInput?.description || toolInput?.prompt || '';
        const shortDesc = desc.length > 30 ? desc.slice(0, 27) + '...' : desc;
        writeSessionState(subId, 'thinking', shortDesc || detail, false, {
          sessionId: subId, modelName, cwd: '', parentSession: sessionId,
        });
        activeSubagents.push({ subId, toolName, itemId: item.id });

        // Override main state to 'subagent'
        const subDetail = `conducting ${activeSubagents.length}`;
        guardedWriteState(sessionId, 'subagent', subDetail, extra());
        writeSessionState(sessionId, 'subagent', subDetail, false, extra());
        writeStats(stats);
      } else if (activeSubagents.length > 0) {
        // Redirect non-subagent tool state to latest synthetic session
        const latest = activeSubagents[activeSubagents.length - 1];
        writeSessionState(latest.subId, state, detail, false, {
          sessionId: latest.subId, modelName, cwd: '', parentSession: sessionId,
        });

        // Keep main state as 'subagent'
        const subDetail = `conducting ${activeSubagents.length}`;
        guardedWriteState(sessionId, 'subagent', subDetail, extra());
        writeSessionState(sessionId, 'subagent', subDetail, false, extra());
        writeStats(stats);
      } else {
        guardedWriteState(sessionId, state, detail, extra());
        writeSessionState(sessionId, state, detail, false, extra());
        writeStats(stats);
      }
    }

    // Tool call completed (item.completed with tool_use type)
    else if (type === 'item.completed' && item.type === 'tool_use') {
      const cached = activeTools.get(item.id) || {};
      const toolName = cached.toolName || item.name || '';
      const toolInput = cached.toolInput || item.input || {};
      const output = item.output || '';
      const isError = item.status === 'failed' || item.error != null;

      const toolResponse = { stdout: output, stderr: '', isError };
      const result = handleToolEnd(stats, toolName, toolInput, toolResponse, isError);

      const ex = extra();
      ex.diffInfo = result.diffInfo;

      if (SUBAGENT_TOOLS.test(toolName) && activeSubagents.length > 0) {
        // Remove oldest subagent (FIFO)
        const removed = activeSubagents.shift();
        writeSessionState(removed.subId, result.state, result.detail, true, {
          sessionId: removed.subId, modelName, cwd: '', parentSession: sessionId,
        });

        if (activeSubagents.length > 0) {
          const subDetail = `conducting ${activeSubagents.length}`;
          guardedWriteState(sessionId, 'subagent', subDetail, ex);
          writeSessionState(sessionId, 'subagent', subDetail, false, ex);
        } else {
          guardedWriteState(sessionId, result.state, result.detail, ex);
          writeSessionState(sessionId, result.state, result.detail, false, ex);
        }
      } else if (activeSubagents.length > 0) {
        // Redirect completed tool state to latest synthetic session
        const latest = activeSubagents[activeSubagents.length - 1];
        writeSessionState(latest.subId, result.state, result.detail, false, {
          sessionId: latest.subId, modelName, cwd: '', parentSession: sessionId,
        });

        // Keep main state as 'subagent'
        const subDetail = `conducting ${activeSubagents.length}`;
        guardedWriteState(sessionId, 'subagent', subDetail, ex);
        writeSessionState(sessionId, 'subagent', subDetail, false, ex);
      } else {
        guardedWriteState(sessionId, result.state, result.detail, ex);
        writeSessionState(sessionId, result.state, result.detail, false, ex);
      }
      writeStats(stats);
      activeTools.delete(item.id);
    }

    // Turn completed
    else if (type === 'turn.completed') {
      // Clean up all remaining synthetic subagent sessions
      while (activeSubagents.length > 0) {
        const removed = activeSubagents.shift();
        writeSessionState(removed.subId, 'happy', 'all done!', true, {
          sessionId: removed.subId, modelName, cwd: '', parentSession: sessionId,
        });
      }
      guardedWriteState(sessionId, 'happy', 'all done!', extra());
      writeSessionState(sessionId, 'happy', 'all done!', true, extra());
      writeStats(stats);
    }

    // Turn failed
    else if (type === 'turn.failed' || type === 'error') {
      const { updateStreak } = require('../state-machine');
      updateStreak(stats, true);
      guardedWriteState(sessionId, 'error', event.message || 'something went wrong', extra());
      writeSessionState(sessionId, 'error', event.message || 'something went wrong', false, extra());
      writeStats(stats);
    }

    // Thread/turn started -> thinking
    else if (type === 'turn.started' || type === 'thread.started') {
      guardedWriteState(sessionId, 'thinking', 'warming up...', extra());
      writeSessionState(sessionId, 'thinking', 'warming up...', false, extra());
    }
  } catch {
    // Silent failure -- don't break the wrapper
  }
}

// -- Main: spawn codex exec --json and parse JSONL -------------------

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node codex-wrapper.js [codex-flags] "your prompt"');
  console.error('  Wraps `codex exec --json` and shows Code Crumb reactions.');
  process.exit(1);
}

// Set initial state
guardedWriteState(sessionId, 'thinking', 'starting codex...', extra());

const codex = spawn('codex', ['exec', '--json', ...args], {
  stdio: ['inherit', 'pipe', 'inherit'],
  shell: true,
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

codex.on('exit', (code) => {
  // Clean up any remaining synthetic subagent sessions
  while (activeSubagents.length > 0) {
    const removed = activeSubagents.shift();
    writeSessionState(removed.subId, 'happy', 'codex finished', true, {
      sessionId: removed.subId, modelName, cwd: '', parentSession: sessionId,
    });
  }
  guardedWriteState(sessionId, 'happy', 'codex finished', extra());
  writeSessionState(sessionId, 'happy', 'codex finished', true, extra());
  writeStats(stats);
  process.exit(code || 0);
});
