#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Demo -- cycles through all states                     |
// |  Run this to preview all the face expressions!                  |
// |  Now includes thought bubbles, streaks, and timeline demo       |
// +================================================================+

const fs = require('fs');
const { STATE_FILE } = require('./shared');

function writeState(state, detail = '', extra = {}) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    state, detail, timestamp: Date.now(), ...extra,
  }), 'utf8');
}

// Simulate a session with incrementing tool calls and streak
let toolCalls = 0;
let filesEdited = 0;
let streak = 0;
const sessionStart = Date.now();

const states = [
  { state: 'idle',      detail: '',                     duration: 3000, label: 'Idle -- resting, thought bubbles drift in' },
  { state: 'thinking',  detail: '',                     duration: 3500, label: 'Thinking -- eyes spinning, orbiting particles' },
  { state: 'reading',   detail: 'reading index.ts',     duration: 3000, label: 'Reading -- narrowed eyes, tool call count shows' },
  { state: 'searching', detail: 'looking for "TODO"',   duration: 3500, label: 'Searching -- eyes darting left and right' },
  { state: 'coding',    detail: 'editing App.tsx',      duration: 3500, label: 'Coding -- file count in thought bubble', files: true },
  { state: 'coding',    detail: 'editing utils.ts',     duration: 2000, label: 'More coding -- file count grows', files: true },
  { state: 'coding',    detail: 'editing styles.css',   duration: 2000, label: 'Even more -- thought bubble tracks files', files: true },
  { state: 'executing', detail: 'npm run build',        duration: 3000, label: 'Executing -- running a command' },
  { state: 'satisfied', detail: 'got it',               duration: 3000, label: 'Satisfied -- calm after reading, streak building', success: true },
  { state: 'proud',    detail: 'saved App.tsx',         duration: 3000, label: 'Proud -- nailed a code edit!', success: true },
  { state: 'relieved', detail: 'command succeeded',     duration: 3000, label: 'Relieved -- command ran clean', success: true },
  { state: 'proud',    detail: 'saved utils.ts',        duration: 2000, label: 'Proud again -- another clean edit', success: true },
  { state: 'satisfied', detail: 'step complete',        duration: 2000, label: 'Satisfied -- steady progress', success: true },
  { state: 'testing',     detail: 'npm test',              duration: 3500, label: 'Testing -- nervous energy, sweat drops' },
  { state: 'error',     detail: 'build failed (exit 1)', duration: 4000, label: 'Error! -- streak broken, dramatic reaction!', error: true },
  { state: 'sleeping',    detail: '',                      duration: 3500, label: 'Sleeping -- zzz, drifted off' },
  { state: 'waiting',     detail: 'needs input',           duration: 3000, label: 'Waiting -- needs user attention' },
  { state: 'installing',  detail: 'npm install',           duration: 3000, label: 'Installing -- packages raining down' },
  { state: 'caffeinated', detail: 'hyperdrive mode!',      duration: 3000, label: 'Caffeinated -- wired, vibrating' },
  { state: 'subagent',    detail: 'spawning subagent',     duration: 3000, label: 'Subagent -- mitosis energy' },
  { state: 'happy',      detail: 'all done!',             duration: 3000, label: 'Done! -- check out that timeline bar', success: true },
  { state: 'idle',      detail: '',                     duration: 2000, label: 'Back to idle -- the cycle of life' },
];

console.log('\n  Code Crumb Demo');
console.log('  ' + '='.repeat(40));
console.log('  Make sure the renderer is running in another terminal!');
console.log('  (node renderer.js)\n');
console.log('  NEW: Watch for thought bubbles, streak counter,');
console.log('  and the timeline bar at the bottom!\n');

async function runDemo() {
  for (const s of states) {
    console.log(`  > ${s.label}`);
    toolCalls++;
    if (s.files) filesEdited++;
    if (s.success) streak++;
    if (s.error) {
      // Break the streak
      const broken = streak;
      streak = 0;
      writeState(s.state, s.detail, {
        toolCalls, filesEdited, sessionStart,
        streak: 0, bestStreak: broken,
        brokenStreak: broken, brokenStreakAt: Date.now(),
        milestone: null,
      });
    } else {
      writeState(s.state, s.detail, {
        toolCalls, filesEdited, sessionStart,
        streak, bestStreak: streak,
        brokenStreak: 0, brokenStreakAt: 0,
        milestone: streak === 10 ? { type: 'streak', value: 10, at: Date.now() } : null,
      });
    }
    await new Promise(r => setTimeout(r, s.duration));
  }
  console.log('\n  Demo complete! The face should now be idle.\n');
}

runDemo();
