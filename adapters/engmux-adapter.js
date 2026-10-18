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
const { StringDecoder } = require('string_decoder');
const { writeSessionState, signalExitCode, exitWhenFlushed } = require('./base-adapter');

const SESSION_ID = `engmux-${process.pid}-${Date.now()}`;
// The dispatching session. Claude Code exports CLAUDE_CODE_SESSION_ID (the
// hook payloads' session_id) to its tool processes, never CLAUDE_SESSION_ID,
// so reading only the latter left every orbital parented to the shell's pid:
// no conducting hold, and a stray top-level row in the session list.
// CLAUDE_SESSION_ID still wins -- an engmux nested under engmux sets it.
const PARENT_SESSION = process.env.CLAUDE_SESSION_ID
  || process.env.CLAUDE_CODE_SESSION_ID
  || String(process.ppid);
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
// Cap the copy of stdout kept for the JSON verdict, like every other
// stdin/stdout reader (1 MB). The passthrough itself is never capped.
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
  // exit code says which signal ended the dispatch (130 / 143 / 129).
  // Registered BEFORE the first write: until process.on runs, a signal gets
  // the default disposition and kills the process outright, and spawn() below
  // is slow enough on a loaded machine for a kill to land in that window.
  // SIGHUP too: a closing terminal sends it, and it killed the adapter with
  // the orbital left cycling.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
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

  // engmux's output reaches our caller as it arrives, byte for byte; only
  // the copy kept for the verdict below is capped. The passthrough used to BE
  // that copy, written at the end: a result over 1 MB reached the caller cut
  // off, as broken JSON, while the dispatch reported success.
  // The copy is decoded as a stream: chunk.toString() per chunk garbled any
  // multi-byte character split across two chunks.
  const decoder = new StringDecoder('utf8');
  let stdout = '';
  let capped = false;
  // A reader that leaves early (`| head`) turns the next write into EPIPE,
  // which would crash the adapter mid-dispatch, orbital unretired. The
  // dispatch runs on; its output just has nowhere to go.
  let outputClosed = false;
  process.stdout.on('error', () => { outputClosed = true; });
  child.stdout.on('data', (chunk) => {
    if (!outputClosed) {
      try { process.stdout.write(chunk); } catch { outputClosed = true; }
    }
    if (stdout.length < MAX_OUTPUT) stdout += decoder.write(chunk);
    else capped = true;
  });
  // Nothing is left to flush into a pipe nobody reads.
  const finish = (code) => (outputClosed ? process.exit(code) : exitWhenFlushed(code));

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
      writeState('error', `killed (${signal})`, true);
      finish(signalExitCode(signal));
      return;
    }

    // The verdict is engmux's JSON when we hold all of it. A capped copy is
    // never parsed: past the cap, the exit code decides, as it does for any
    // output that is not JSON.
    let success = false;
    let detail = '';
    try {
      if (capped) throw new Error('output over the cap');
      stdout += decoder.end();
      const result = JSON.parse(stdout);
      success = result.success === true;
      detail = success
        ? (result.response || '').slice(0, 40) || 'done'
        : (result.error || 'failed').slice(0, 40);
    } catch {
      success = code === 0;
      detail = success ? 'done' : `exit ${code}`;
    }

    writeState(success ? 'happy' : 'error', detail, true);
    // Not process.exit: the passthrough may still be in the pipe.
    finish(code || 0);
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
