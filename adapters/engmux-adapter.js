#!/usr/bin/env node
'use strict';

// +======================================================================+
// |  engmux Adapter -- wraps engmux dispatches as Code Crumb orbitals    |
// |                                                                      |
// |  Spawns engmux as a child process and writes session files so        |
// |  the dispatched agent appears as an orbital mini-face.               |
// |                                                                      |
// |  Usage:                                                              |
// |    node adapters/engmux-adapter.js [engmux args...]                  |
// |  Example:                                                            |
// |    node adapters/engmux-adapter.js -E opencode -m opencode/big-pickle|
// |      -e medium "do X"                                                |
// +======================================================================+

const { spawn } = require('child_process');
const { writeSessionState, signalExitCode } = require('./base-adapter');

const SESSION_ID = `engmux-${process.pid}-${Date.now()}`;
const PARENT_SESSION = process.env.CLAUDE_SESSION_ID || String(process.ppid);
const SUB_STATES = ['thinking', 'reading', 'coding', 'searching', 'executing'];
const CYCLE_MS = 8000;

// Extract model name from args for the label (-m / --model flag)
function extractModel(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-m' || args[i] === '--model') && args[i + 1]) {
      // Strip prefix like "opencode/" for display
      return args[i + 1].replace(/^[^/]+\//, '');
    }
  }
  return 'engmux';
}

// Extract the dispatch engine (-E / --engine) — that's the editor provenance
function extractEngine(args) {
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-E' || args[i] === '--engine') && args[i + 1]) return args[i + 1];
  }
  return 'engmux';
}

function writeState(state, detail, stopped = false) {
  writeSessionState(SESSION_ID, state, detail, stopped, {
    sessionId: SESSION_ID,
    modelName: extractModel(process.argv.slice(2)),
    editor: extractEngine(process.argv.slice(2)),
    cwd: process.cwd(),
    parentSession: PARENT_SESSION,
  });
}

// -- Main ---------------------------------------------------------------

// engmux is a Python module. Only Windows ships a bare `python`; Linux and Homebrew
// macOS usually have `python3` only. ENGMUX_PYTHON / PYTHON override either.
const PYTHON = process.env.ENGMUX_PYTHON || process.env.PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');
// Cap captured stdout like every other stdin/stdout reader (1 MB).
const MAX_OUTPUT = 1048576;

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('Usage: node adapters/engmux-adapter.js [engmux args...]\n');
    process.exit(1);
  }

  // The orbital is retired exactly once, by whichever of close / error / a
  // caught signal gets there first.
  let finished = false;
  let child = null;
  let cycleTimer = null;

  // Ctrl+C or a kill: retire the orbital before going, or it stands on its
  // last cycled work state until it goes stale. The child is told too (a
  // SIGTERM aimed at this process alone would otherwise orphan it), and the
  // exit code says which signal ended the dispatch (130 / 143).
  // Registered BEFORE the first write: until process.on runs, a signal gets
  // the default disposition and kills the process outright, and spawn() below
  // is slow enough on a loaded machine for a kill to land in that window.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      if (cycleTimer) clearInterval(cycleTimer);
      if (!finished) {
        finished = true;
        writeState('error', 'interrupted', true);
      }
      try { if (child) child.kill(sig); } catch {}
      process.exit(signalExitCode(sig));
    });
  }

  // 1. Write initial spawning state
  writeState('spawning', args.join(' ').slice(0, 40));

  // 2. Spawn engmux
  child = spawn(PYTHON, ['-m', 'engmux', ...args], {
    stdio: ['inherit', 'pipe', 'inherit'],
    env: { ...process.env, CLAUDE_SESSION_ID: SESSION_ID },
  });

  let stdout = '';
  child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString(); });

  // 3. Cycle states while running
  let cycleIndex = 0;
  cycleTimer = setInterval(() => {
    cycleIndex = (cycleIndex + 1) % SUB_STATES.length;
    writeState(SUB_STATES[cycleIndex], args.join(' ').slice(0, 40));
  }, CYCLE_MS);

  // 4. On completion — parse result, write final state
  child.on('close', (code, signal) => {
    clearInterval(cycleTimer);
    if (finished) return;
    finished = true;
    // Killed by a signal: code is null, and `code || 0` used to report success.
    if (signal) {
      process.stdout.write(stdout);
      writeState('error', `killed (${signal})`, true);
      process.exit(signalExitCode(signal));
    }

    let success = false;
    let detail = '';
    try {
      const result = JSON.parse(stdout);
      success = result.success === true;
      detail = success
        ? (result.response || '').slice(0, 40) || 'done'
        : (result.error || 'failed').slice(0, 40);
      // Pass through the JSON to our own stdout
      process.stdout.write(stdout);
    } catch {
      success = code === 0;
      detail = success ? 'done' : `exit ${code}`;
      process.stdout.write(stdout);
    }

    writeState(success ? 'happy' : 'error', detail, true);
    process.exit(code || 0);
  });

  child.on('error', (err) => {
    clearInterval(cycleTimer);
    if (finished) return;
    finished = true;
    writeState('error', err.message.slice(0, 40), true);
    process.stderr.write(`engmux-adapter: ${err.message}\n`);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

module.exports = { extractModel, extractEngine };
