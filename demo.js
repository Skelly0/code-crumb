#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Claude Face Demo -- cycles through all states                  |
// |  Run this to preview all the face expressions!                  |
// +================================================================+

const fs = require('fs');
const path = require('path');

const HOME = process.env.USERPROFILE || process.env.HOME || '/tmp';
const STATE_FILE = process.env.CLAUDE_FACE_STATE || path.join(HOME, '.claude-face-state');

function writeState(state, detail = '') {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    state, detail, timestamp: Date.now(),
  }), 'utf8');
}

const states = [
  { state: 'idle',      detail: '',                     duration: 3000, label: 'Idle -- resting, blinking, breathing' },
  { state: 'thinking',  detail: '',                     duration: 3500, label: 'Thinking -- eyes spinning, orbiting particles' },
  { state: 'reading',   detail: 'reading index.ts',     duration: 3000, label: 'Reading -- narrowed eyes, focused' },
  { state: 'searching', detail: 'looking for "TODO"',   duration: 3500, label: 'Searching -- eyes darting left and right' },
  { state: 'coding',    detail: 'editing App.tsx',      duration: 3500, label: 'Coding -- focused eyes, determined mouth' },
  { state: 'executing', detail: 'npm run build',        duration: 3000, label: 'Executing -- running a command' },
  { state: 'happy',     detail: 'all done!',            duration: 3000, label: 'Happy -- sparkle eyes, celebration!' },
  { state: 'error',     detail: 'build failed (exit 1)', duration: 3500, label: 'Error -- glitching, distressed' },
  { state: 'sleeping',    detail: '',                      duration: 3500, label: 'Sleeping -- zzz, drifted off after long idle' },
  { state: 'waiting',     detail: 'needs input',           duration: 3000, label: 'Waiting -- needs user attention, gentle pulse' },
  { state: 'testing',     detail: 'npm test',              duration: 3500, label: 'Testing -- nervous energy, sweat drops' },
  { state: 'installing',  detail: 'npm install',           duration: 3000, label: 'Installing -- packages raining down' },
  { state: 'caffeinated', detail: 'hyperdrive mode!',      duration: 3000, label: 'Caffeinated -- wired, vibrating, speed lines' },
  { state: 'subagent',    detail: 'spawning subagent',     duration: 3000, label: 'Subagent -- mitosis energy, ghost echo' },
  { state: 'idle',      detail: '',                     duration: 2000, label: 'Back to idle -- the cycle of life' },
];

console.log('\n  Claude Face Demo');
console.log('  ' + '='.repeat(40));
console.log('  Make sure the renderer is running in another terminal!');
console.log('  (node renderer.js)\n');

async function runDemo() {
  for (const s of states) {
    console.log(`  > ${s.label}`);
    writeState(s.state, s.detail);
    await new Promise(r => setTimeout(r, s.duration));
  }
  console.log('\n  Demo complete! The face should now be idle.\n');
}

runDemo();
