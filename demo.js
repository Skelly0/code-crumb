#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Demo -- cycles through all states                     |
// |  Run this to preview all the face expressions!                  |
// |  Now includes thought bubbles, streaks, and timeline demo       |
// +================================================================+

const fs = require('fs');
const path = require('path');
const { STATE_FILE, SESSIONS_DIR } = require('./shared');

// Ensure sessions dir exists for orbital demo
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

const mainId = 'demo-main';

function writeState(state, detail = '', extra = {}) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    state, detail, timestamp: Date.now(), sessionId: mainId, modelName: 'claude', ...extra,
  }), 'utf8');
}

function writeSession(id, state, detail, cwd, stopped = false, taskDescription) {
  const filename = id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  const data = {
    session_id: id, state, detail, timestamp: Date.now(),
    cwd: cwd || process.cwd(), stopped, modelName: 'claude',
  };
  if (taskDescription) data.taskDescription = taskDescription;
  fs.writeFileSync(path.join(SESSIONS_DIR, filename), JSON.stringify(data), 'utf8');
}

function removeSession(id) {
  const filename = id.replace(/[^a-zA-Z0-9_-]/g, '_') + '.json';
  try { fs.unlinkSync(path.join(SESSIONS_DIR, filename)); } catch {}
}

const subagents = [
  { id: 'demo-sub-1', cwd: '/home/user/my-app/src', taskDescription: 'fix auth tests' },
  { id: 'demo-sub-2', cwd: '/home/user/my-app/tests', taskDescription: 'add logging' },
  { id: 'demo-sub-3', cwd: '/home/user/api-server', taskDescription: 'refactor db' },
];

// Simulate a session with incrementing tool calls and streak
let toolCalls = 0;
let filesEdited = 0;
let streak = 0;
const sessionStart = Date.now();

const states = [
  { state: 'idle',      detail: '',                     duration: 3000, label: 'Idle -- resting, thought bubbles drift in' },
  { state: 'thinking',  detail: '',                     duration: 3500, label: 'Thinking -- eyes spinning, orbiting particles' },
  { state: 'responding', detail: 'generating response',    duration: 3500, label: 'Responding -- after tools, final output' },
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
  // -- Orbital subagent sequence --
  { state: 'subagent', detail: 'spawning subagent', duration: 3000, label: 'Subagent -- first orbital spawns!',
    orbital: () => {
      writeSession(subagents[0].id, 'reading', 'reading index.ts', subagents[0].cwd, false, subagents[0].taskDescription);
    }},
  { state: 'subagent', detail: 'conducting', duration: 3000, label: 'Second orbital -- two subagents now',
    orbital: () => {
      writeSession(subagents[0].id, 'coding', 'editing App.tsx', subagents[0].cwd, false, subagents[0].taskDescription);
      writeSession(subagents[1].id, 'testing', 'npm test', subagents[1].cwd, false, subagents[1].taskDescription);
    }},
  { state: 'subagent', detail: 'conducting', duration: 4000, label: 'Third orbital -- full constellation!',
    orbital: () => {
      writeSession(subagents[2].id, 'searching', 'looking for TODO', subagents[2].cwd, false, subagents[2].taskDescription);
      writeSession(subagents[0].id, 'caffeinated', 'hyperdrive!', subagents[0].cwd, false, subagents[0].taskDescription);
      writeSession(subagents[1].id, 'coding', 'editing fix.ts', subagents[1].cwd, false, subagents[1].taskDescription);
    }},
  { state: 'subagent', detail: 'conducting', duration: 5000, label: 'Orbitals working -- good time for a screenshot!',
    orbital: () => {
      writeSession(subagents[0].id, 'executing', 'npm run build', subagents[0].cwd, false, subagents[0].taskDescription);
      writeSession(subagents[1].id, 'proud', 'code written', subagents[1].cwd, false, subagents[1].taskDescription);
      writeSession(subagents[2].id, 'coding', 'editing handler.ts', subagents[2].cwd, false, subagents[2].taskDescription);
    }},
  { state: 'subagent', detail: 'wrapping up', duration: 3000, label: 'Subagents finishing up',
    orbital: () => {
      writeSession(subagents[0].id, 'happy', 'all done!', subagents[0].cwd, true, subagents[0].taskDescription);
      writeSession(subagents[1].id, 'happy', 'all done!', subagents[1].cwd, true, subagents[1].taskDescription);
      writeSession(subagents[2].id, 'happy', 'all done!', subagents[2].cwd, true, subagents[2].taskDescription);
    }},
  { state: 'happy',      detail: 'all done!',             duration: 3000, label: 'Done! -- check out that timeline bar', success: true },
  { state: 'idle',      detail: '',                     duration: 2000, label: 'Back to idle -- the cycle of life' },
];

console.log('\n  Code Crumb Demo');
console.log('  ' + '='.repeat(40));
console.log('  Make sure the renderer is running in another terminal!');
console.log('  (node renderer.js)\n');
console.log('  Watch for thought bubbles, streak counter,');
console.log('  timeline bar, and orbital subagents!\n');

async function runDemo() {
  for (const s of states) {
    console.log(`  > ${s.label}`);
    toolCalls++;
    if (s.files) filesEdited++;
    if (s.success) streak++;
    if (s.error) {
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
    // Spawn/update orbital subagent sessions
    if (s.orbital) s.orbital();
    await new Promise(r => setTimeout(r, s.duration));
  }

  // Clean up orbital session files
  for (const s of subagents) removeSession(s.id);
  console.log('\n  Demo complete! The face should now be idle.\n');
}

runDemo();
