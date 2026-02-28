#!/usr/bin/env node
'use strict';

// +================================================================+
// |  engmux Adapter -- wraps engmux dispatches as Code Crumb orbitals |
// |                                                                  |
// |  Spawns engmux as a child process and writes session files so   |
// |  the dispatched agent appears as an orbital mini-face.           |
// |                                                                  |
// |  Usage:                                                          |
// |    node adapters/engmux-adapter.js [engmux args...]              |
// |  Example:                                                        |
// |    node adapters/engmux-adapter.js -E opencode -m opencode/big-pickle -e medium "do X" |
// +================================================================+

const { spawn } = require('child_process');
const { writeSessionState } = require('./base-adapter');

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

function writeState(state, detail, stopped = false) {
  writeSessionState(SESSION_ID, state, detail, stopped, {
    sessionId: SESSION_ID,
    modelName: extractModel(process.argv.slice(2)),
    cwd: process.cwd(),
    parentSession: PARENT_SESSION,
  });
}

// -- Main ---------------------------------------------------------------

const args = process.argv.slice(2);
if (args.length === 0) {
  process.stderr.write('Usage: node adapters/engmux-adapter.js [engmux args...]\n');
  process.exit(1);
}

// 1. Write initial spawning state
writeState('spawning', args.join(' ').slice(0, 40));

// 2. Spawn engmux
const child = spawn('python', ['-m', 'engmux', ...args], {
  stdio: ['inherit', 'pipe', 'inherit'],
  env: { ...process.env, CLAUDE_SESSION_ID: SESSION_ID },
});

let stdout = '';
child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

// 3. Cycle states while running
let cycleIndex = 0;
const cycleTimer = setInterval(() => {
  cycleIndex = (cycleIndex + 1) % SUB_STATES.length;
  writeState(SUB_STATES[cycleIndex], args.join(' ').slice(0, 40));
}, CYCLE_MS);

// 4. On completion — parse result, write final state
child.on('close', (code) => {
  clearInterval(cycleTimer);

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
  writeState('error', err.message.slice(0, 40), true);
  process.stderr.write(`engmux-adapter: ${err.message}\n`);
  process.exit(1);
});

// Clean up timer on signals to prevent process hanging
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { clearInterval(cycleTimer); process.exit(0); });
}
