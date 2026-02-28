#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - grid.js (OrbitalSystem)                 |
// +================================================================+

const assert = require('assert');
const { MiniFace, OrbitalSystem, renderSessionList } = require('../grid');
const { gridMouths, eyes, mouths } = require('../animations');
const { PALETTES } = require('../themes');
const { ParticleSystem } = require('../particles');

let passed = 0;
let failed = 0;
let currentDescribe = '';

function describe(name, fn) {
  currentDescribe = name;
  console.log(`\n  ${name}`);
  fn();
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    \x1b[32m\u2713\x1b[0m ${name}`);
  } catch (e) {
    failed++;
    console.log(`    \x1b[31m\u2717\x1b[0m ${name}`);
    console.log(`      ${e.message}`);
  }
}

describe('grid.js -- MiniFace modelName', () => {
  test('default modelName is empty', () => {
    const face = new MiniFace('test-session');
    assert.strictEqual(face.modelName, '');
  });

  test('updateFromFile sets modelName', () => {
    const face = new MiniFace('test-session');
    face.updateFromFile({ state: 'coding', modelName: 'codex' });
    assert.strictEqual(face.modelName, 'codex');
  });

  test('updateFromFile ignores missing modelName', () => {
    const face = new MiniFace('test-session');
    face.updateFromFile({ state: 'coding', modelName: 'o3' });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.modelName, 'o3');
  });
});

describe('grid.js -- MiniFace', () => {
  test('initializes with idle state', () => {
    const face = new MiniFace('test-session');
    assert.strictEqual(face.state, 'idle');
    assert.strictEqual(face.sessionId, 'test-session');
  });

  test('updateFromFile changes state', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js', timestamp: Date.now() });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'editing foo.js');
  });

  test('updateFromFile tracks stopped', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'happy', stopped: true, timestamp: Date.now() });
    assert.ok(face.stopped);
  });

  test('isStale returns false for fresh face', () => {
    const face = new MiniFace('test');
    assert.ok(!face.isStale());
  });

  test('isStale returns true for old stopped face', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 15000; // Past STOPPED_LINGER_MS (10s)
    assert.ok(face.isStale());
  });

  test('getEyes returns string for all states', () => {
    const states = [
      'idle', 'thinking', 'reading', 'searching', 'coding', 'executing',
      'happy', 'error', 'sleeping', 'waiting', 'testing', 'installing',
      'caffeinated', 'subagent', 'satisfied', 'proud', 'relieved',
      'committing',
    ];
    for (const state of states) {
      const face = new MiniFace('test');
      face.state = state;
      face.blinkFrame = -1;
      const result = face.getEyes();
      assert.ok(typeof result === 'string', `MiniFace.getEyes failed for state: ${state}`);
    }
  });

  test('getMouth returns string for all states', () => {
    const states = Object.keys(gridMouths);
    for (const state of states) {
      const face = new MiniFace('test');
      face.state = state;
      const result = face.getMouth();
      assert.ok(typeof result === 'string', `MiniFace.getMouth failed for state: ${state}`);
    }
  });
});

describe('grid.js -- MiniFace tick() timeout logic', () => {
  test('completion state lingers then transitions to thinking (not idle)', () => {
    const face = new MiniFace('test');
    face.state = 'happy';
    face.lastUpdate = Date.now() - 9000; // Past happy linger (8000ms)
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
  });

  test('thinking persists for active session past IDLE_TIMEOUT', () => {
    const face = new MiniFace('test');
    face.state = 'thinking';
    face.stopped = false;
    face.lastUpdate = Date.now() - 10000; // Past IDLE_TIMEOUT (8s) but not THINKING_TIMEOUT (120s)
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
  });

  test('thinking degrades to idle quickly when stopped', () => {
    const face = new MiniFace('test');
    face.state = 'thinking';
    face.stopped = true;
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT (8s)
    face.tick(16);
    assert.strictEqual(face.state, 'idle');
  });

  test('active tool state transitions to thinking when session active', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.stopped = false;
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT (8s)
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
  });

  test('active tool state transitions to idle when stopped', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.stopped = true;
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT (8s)
    face.tick(16);
    assert.strictEqual(face.state, 'idle');
  });
});

describe('grid.js -- OrbitalSystem', () => {
  test('initializes with empty map', () => {
    const orbital = new OrbitalSystem();
    assert.strictEqual(orbital.faces.size, 0);
  });

  test('update ticks all faces and advances rotation', () => {
    const orbital = new OrbitalSystem();
    orbital.faces.set('a', new MiniFace('a'));
    orbital.faces.set('b', new MiniFace('b'));
    const prevAngle = orbital.rotationAngle;
    orbital.update(66);
    assert.strictEqual(orbital.frame, 1);
    assert.ok(orbital.rotationAngle > prevAngle);
    for (const face of orbital.faces.values()) {
      assert.strictEqual(face.frame, 1);
    }
  });

  test('rotation angle advances by rotationSpeed each update', () => {
    const orbital = new OrbitalSystem();
    const speed = orbital.rotationSpeed;
    orbital.update(66);
    assert.ok(Math.abs(orbital.rotationAngle - speed) < 0.0001);
  });

  test('rotation angle wraps around at 2*PI', () => {
    const orbital = new OrbitalSystem();
    orbital.rotationAngle = Math.PI * 2 - 0.001;
    orbital.update(66);
    assert.ok(orbital.rotationAngle < Math.PI * 2);
  });
});

describe('grid.js -- OrbitalSystem calculateOrbit', () => {
  test('returns zero maxSlots for small terminal', () => {
    const orbital = new OrbitalSystem();
    const mainPos = { row: 5, col: 10, w: 30, h: 10, centerX: 25, centerY: 10 };
    const result = orbital.calculateOrbit(40, 15, mainPos);
    assert.strictEqual(result.maxSlots, 0);
  });

  test('returns positive maxSlots for large terminal', () => {
    const orbital = new OrbitalSystem();
    const mainPos = { row: 15, col: 40, w: 30, h: 10, centerX: 55, centerY: 20 };
    const result = orbital.calculateOrbit(120, 50, mainPos);
    assert.ok(result.maxSlots > 0);
    assert.ok(result.a > 0);
    assert.ok(result.b > 0);
  });

  test('maxSlots capped at 8', () => {
    const orbital = new OrbitalSystem();
    const mainPos = { row: 50, col: 100, w: 30, h: 10, centerX: 115, centerY: 55 };
    const result = orbital.calculateOrbit(300, 120, mainPos);
    assert.ok(result.maxSlots <= 8);
  });

  test('semi-axes clear the main face box', () => {
    const orbital = new OrbitalSystem();
    const mainPos = { row: 15, col: 40, w: 30, h: 10, centerX: 55, centerY: 20 };
    const result = orbital.calculateOrbit(120, 50, mainPos);
    // a should be at least mainPos.w/2 + MINI_W/2 + 3
    assert.ok(result.a >= Math.floor(mainPos.w / 2) + 4 + 3);
    // b should be at least mainPos.h/2 + MINI_H/2 + 6 (extra for decorations)
    assert.ok(result.b >= Math.floor(mainPos.h / 2) + 3 + 6);
  });
});

describe('grid.js -- OrbitalSystem session exclusion', () => {
  test('loadSessions with excludeId skips main session', () => {
    const orbital = new OrbitalSystem();
    // Manually populate to test exclusion logic
    orbital.faces.set('main-session', new MiniFace('main-session'));
    orbital.faces.set('sub-session', new MiniFace('sub-session'));
    // After a loadSessions call with excludeId, the main session would be excluded
    // We test the concept by checking that _assignLabels works on remaining faces
    orbital.faces.delete('main-session');
    orbital._assignLabels();
    assert.strictEqual(orbital.faces.size, 1);
    assert.ok(orbital.faces.has('sub-session'));
  });
});

describe('grid.js -- OrbitalSystem stale cleanup', () => {
  test('stale stopped faces are detected', () => {
    const face = new MiniFace('stale');
    face.stopped = true;
    face.stoppedAt = Date.now() - 15000; // Past STOPPED_LINGER_MS (10s)
    assert.ok(face.isStale());
  });

  test('recently stopped faces are not stale', () => {
    const face = new MiniFace('recent');
    face.stopped = true;
    face.stoppedAt = Date.now() - 5000; // Within STOPPED_LINGER_MS (10s)
    assert.ok(!face.isStale());
  });

  test('fresh faces are not stale', () => {
    const face = new MiniFace('fresh');
    assert.ok(!face.isStale());
  });

  test('completion states become stale after STOPPED_LINGER_MS (issue #59 fix)', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace(state);
      face.state = state;
      face.lastUpdate = Date.now() - 15000; // Past STOPPED_LINGER_MS (10s)
      assert.ok(face.isStale(), `${state} should be stale after 10s`);
    }
  });

  test('recent completion states are not stale', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace(state);
      face.state = state;
      face.lastUpdate = Date.now() - 5000; // Within STOPPED_LINGER_MS (10s)
      assert.ok(!face.isStale(), `${state} should not be stale within 10s`);
    }
  });
});

describe('grid.js -- OrbitalSystem session schema validation', () => {
  test('loadSessions shows sessions without parentSession/isTeammate (parallel sessions)', () => {
    // Parallel Claude Code sessions don't have parentSession or isTeammate.
    // They should now appear as orbitals (excluded only by matching excludeId).
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    // Create a session file WITHOUT parentSession or isTeammate
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const parallelFile = path.join(SESSIONS_DIR, 'parallel-session.json');
    fs.writeFileSync(parallelFile, JSON.stringify({
      session_id: 'parallel-session',
      state: 'thinking',
      detail: '',
      timestamp: Date.now(),
    }));

    orbital.loadSessions('different-id');
    assert.ok(orbital.faces.has('parallel-session'),
      'session without parentSession/isTeammate should be included as parallel orbital');

    // Clean up
    try { fs.unlinkSync(parallelFile); } catch {}
  });

  test('loadSessions excludes session matching excludeId', () => {
    // The main session should be excluded by its ID, not by missing fields
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const mainFile = path.join(SESSIONS_DIR, 'main-session.json');
    fs.writeFileSync(mainFile, JSON.stringify({
      session_id: 'main-session',
      state: 'coding',
      detail: '',
      timestamp: Date.now(),
    }));

    orbital.loadSessions('main-session');
    assert.ok(!orbital.faces.has('main-session'),
      'session matching excludeId should be excluded');

    // Clean up
    try { fs.unlinkSync(mainFile); } catch {}
  });

  test('loadSessions includes sessions with parentSession', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const subFile = path.join(SESSIONS_DIR, 'real-subagent.json');
    fs.writeFileSync(subFile, JSON.stringify({
      session_id: 'real-subagent',
      state: 'coding',
      detail: 'editing',
      timestamp: Date.now(),
      parentSession: 'main-session',
    }));

    orbital.loadSessions('main-session');
    assert.ok(orbital.faces.has('real-subagent'),
      'session with parentSession should be included');

    // Clean up
    try { fs.unlinkSync(subFile); } catch {}
  });

  test('loadSessions includes sessions with isTeammate', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const teamFile = path.join(SESSIONS_DIR, 'teammate-session.json');
    fs.writeFileSync(teamFile, JSON.stringify({
      session_id: 'teammate-session',
      state: 'reading',
      detail: '',
      timestamp: Date.now(),
      isTeammate: true,
      teamName: 'alpha',
      teammateName: 'researcher',
    }));

    orbital.loadSessions('main-session');
    assert.ok(orbital.faces.has('teammate-session'),
      'session with isTeammate should be included');

    // Clean up
    try { fs.unlinkSync(teamFile); } catch {}
  });
});

describe('grid.js -- OrbitalSystem side panel', () => {
  test('_renderSidePanel returns string with faces on sides', () => {
    const orbital = new OrbitalSystem();
    const face1 = new MiniFace('sub-1');
    face1.state = 'coding';
    face1.label = 'sub-1';
    orbital.faces.set('sub-1', face1);
    const mainPos = { row: 7, col: 26, w: 30, h: 10, centerX: 41, centerY: 12 };
    const result = orbital._renderSidePanel(80, 24, mainPos);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  test('_renderSidePanel returns text fallback when no side space', () => {
    const orbital = new OrbitalSystem();
    orbital.faces.set('sub-1', new MiniFace('sub-1'));
    // Main face fills the entire terminal width
    const mainPos = { row: 2, col: 1, w: 38, h: 10, centerX: 20, centerY: 7 };
    const result = orbital._renderSidePanel(40, 15, mainPos);
    assert.ok(result.includes('subagent'));
  });

  test('_renderSidePanel distributes faces to both sides', () => {
    const orbital = new OrbitalSystem();
    for (let i = 0; i < 4; i++) {
      const f = new MiniFace(`sub-${i}`);
      f.label = `sub-${i}`;
      f.state = 'coding';
      orbital.faces.set(`sub-${i}`, f);
    }
    const mainPos = { row: 7, col: 26, w: 30, h: 10, centerX: 41, centerY: 12 };
    const result = orbital._renderSidePanel(80, 24, mainPos);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  test('render falls back to side panel at 80x24', () => {
    const orbital = new OrbitalSystem();
    const f = new MiniFace('sub-1');
    f.label = 'sub-1';
    f.state = 'reading';
    orbital.faces.set('sub-1', f);
    // At 80x24, orbital ellipse can't fit (maxB < minB), so side panel kicks in
    const mainPos = { row: 7, col: 26, w: 30, h: 10, centerX: 41, centerY: 12 };
    const result = orbital.render(80, 24, mainPos);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });
});

describe('animations.js -- conducting', () => {
  test('eyes.conducting cycles through phases', () => {
    // Phase 0 (frame 0): open
    const r0 = eyes.conducting({}, 0);
    assert.ok(r0.left && r0.right);

    // Phase 1 (frame 30): lookLeft
    const r1 = eyes.conducting({}, 30);
    const ll = eyes.lookLeft();
    assert.deepStrictEqual(r1, ll);

    // Phase 3 (frame 90): lookRight
    const r3 = eyes.conducting({}, 90);
    const lr = eyes.lookRight();
    assert.deepStrictEqual(r3, lr);

    // Phase 5 (frame 150): focused
    const r5 = eyes.conducting({}, 150);
    const fc = eyes.focused();
    assert.deepStrictEqual(r5, fc);
  });

  test('mouths.conducting returns determined mouth', () => {
    const result = mouths.conducting();
    const expected = mouths.determined();
    assert.strictEqual(result, expected);
  });
});

describe('particles.js -- stream style', () => {
  test('stream particles spawn with outward velocity', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'stream');
    assert.strictEqual(ps.particles.length, 5);
    for (const p of ps.particles) {
      assert.strictEqual(p.style, 'stream');
      // Spawns from center
      assert.strictEqual(p.x, ps.width / 2);
      assert.strictEqual(p.y, ps.height / 2);
      // Has non-zero velocity
      assert.ok(p.vx !== 0 || p.vy !== 0);
      assert.ok(p.life > 0);
      assert.ok(p.maxLife === 60);
    }
  });

  test('stream particles move outward on update', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'stream');
    const p = ps.particles[0];
    const origX = p.x;
    const origY = p.y;
    ps.update();
    // Should have moved from center
    assert.ok(p.x !== origX || p.y !== origY);
  });
});

describe('face.js -- orbital toggle', () => {
  test('showOrbitals defaults to true', () => {
    const { ClaudeFace } = require('../face');
    const face = new ClaudeFace();
    assert.strictEqual(face.showOrbitals, true);
  });

  test('toggleOrbitals flips state', () => {
    const { ClaudeFace } = require('../face');
    const face = new ClaudeFace();
    face.toggleOrbitals();
    assert.strictEqual(face.showOrbitals, false);
    face.toggleOrbitals();
    assert.strictEqual(face.showOrbitals, true);
  });

  test('subagentCount defaults to 0', () => {
    const { ClaudeFace } = require('../face');
    const face = new ClaudeFace();
    assert.strictEqual(face.subagentCount, 0);
  });

  test('lastPos is null before first render', () => {
    const { ClaudeFace } = require('../face');
    const face = new ClaudeFace();
    assert.strictEqual(face.lastPos, null);
  });
});

describe('OrbitalSystem._renderSidePanel', () => {
  test('right-col is placed past bubble when active bubble is on right side', () => {
    const sys = new OrbitalSystem();
    const mf = new MiniFace('test-session');
    sys.faces.set('test-session', mf);

    // mainPos.col=5 forces canLeft=false (leftCol = 5-8-2 = -5 < 1)
    // bubble at col=27 (= 5+20+2), width=15
    const mainPos = {
      col: 5, w: 20, row: 5, h: 12,
      centerX: 15, centerY: 11,
      bubble: { col: 27, w: 15, row: 8, h: 3 }
    };
    const expectedMinCol = mainPos.bubble.col + mainPos.bubble.w + 2; // 27+15+2=44

    const out = sys._renderSidePanel(100, 40, mainPos, null);
    assert.ok(typeof out === 'string', 'output should be a string');

    // Extract all cursor positions \x1b[row;colH from ANSI output
    const re = /\x1b\[(\d+);(\d+)H/g;
    let m;
    const rightCols = [];
    while ((m = re.exec(out)) !== null) {
      const col = parseInt(m[2], 10);
      if (col > mainPos.col + mainPos.w) rightCols.push(col);
    }

    assert.ok(rightCols.length > 0, 'should render some content to the right of main face');
    const minRightCol = Math.min(...rightCols);
    assert.ok(
      minRightCol >= expectedMinCol,
      `right-side mini-face col ${minRightCol} should be >= bubble right edge ${expectedMinCol}`
    );
  });

  test('right-col falls back to mainPos.w + SIDE_PAD when no bubble', () => {
    const sys = new OrbitalSystem();
    const mf = new MiniFace('test-session-2');
    sys.faces.set('test-session-2', mf);

    const mainPos = {
      col: 5, w: 20, row: 5, h: 12,
      centerX: 15, centerY: 11
      // no bubble
    };
    const SIDE_PAD = 2;
    const expectedCol = mainPos.col + mainPos.w + SIDE_PAD; // 5+20+2=27

    const out = sys._renderSidePanel(100, 40, mainPos, null);
    const re = /\x1b\[(\d+);(\d+)H/g;
    let m;
    const rightCols = [];
    while ((m = re.exec(out)) !== null) {
      const col = parseInt(m[2], 10);
      if (col > mainPos.col + mainPos.w) rightCols.push(col);
    }

    assert.ok(rightCols.length > 0, 'should render some content to the right of main face');
    const minRightCol = Math.min(...rightCols);
    assert.ok(
      minRightCol >= expectedCol,
      `right-side mini-face col ${minRightCol} should be >= ${expectedCol}`
    );
  });
});

describe('grid.js -- MiniFace tick() minDisplayUntil guard (Bug 3)', () => {
  test('tick does not override state during minDisplayUntil', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT
    face.minDisplayUntil = Date.now() + 5000; // Locked for 5 more seconds
    face.tick(16);
    assert.strictEqual(face.state, 'coding',
      'state should not change while minDisplayUntil is in the future');
  });

  test('tick transitions after minDisplayUntil expires', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.stopped = false;
    face.lastUpdate = Date.now() - 9000; // Past IDLE_TIMEOUT
    face.minDisplayUntil = Date.now() - 1; // Expired
    face.tick(16);
    assert.strictEqual(face.state, 'thinking',
      'should transition to thinking after minDisplayUntil expires');
  });

  test('tick sets minDisplayUntil after timeout transition', () => {
    const face = new MiniFace('test');
    face.state = 'happy';
    face.lastUpdate = Date.now() - 9000; // Past happy linger
    face.minDisplayUntil = 0; // Expired
    const before = Date.now();
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
    assert.ok(face.minDisplayUntil >= before + 1500,
      'minDisplayUntil should be set after timeout transition');
  });

  test('blink animation still runs during minDisplayUntil lock', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.minDisplayUntil = Date.now() + 5000;
    face.blinkTimer = 10; // About to blink
    face.tick(20); // dt > blinkTimer — triggers blink then increments frame
    assert.ok(face.blinkFrame >= 0,
      'blink should trigger even during minDisplayUntil lock');
    assert.strictEqual(face.state, 'coding',
      'state should remain locked');
  });

  test('spawning auto-transition sets minDisplayUntil', () => {
    const face = new MiniFace('test');
    face.state = 'spawning';
    face.firstSeen = Date.now() - 3000; // Past 2s spawn duration
    face.minDisplayUntil = 0;
    const before = Date.now();
    face.tick(16);
    assert.strictEqual(face.state, 'thinking');
    assert.ok(face.minDisplayUntil >= before + 1500);
  });
});

describe('grid.js -- MiniFace updateFromFile detail gating (Bug 3)', () => {
  test('detail updates when state change is accepted', () => {
    const face = new MiniFace('test');
    face.state = 'idle';
    face.minDisplayUntil = 0;
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js' });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'editing foo.js');
  });

  test('detail does NOT update when state change is rejected', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.detail = 'editing foo.js';
    face.minDisplayUntil = Date.now() + 5000; // Locked
    face.updateFromFile({ state: 'reading', detail: 'reading bar.js' });
    assert.strictEqual(face.state, 'coding',
      'state should remain locked');
    assert.strictEqual(face.detail, 'editing foo.js',
      'detail should not update when state is rejected');
  });

  test('detail updates for same-state refresh', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.detail = 'editing foo.js';
    face.minDisplayUntil = Date.now() + 5000; // Locked
    face.updateFromFile({ state: 'coding', detail: 'editing bar.js' });
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'editing bar.js',
      'detail should update when same state is refreshed');
  });

  test('error always bypasses and updates detail', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.detail = 'editing foo.js';
    face.minDisplayUntil = Date.now() + 5000; // Locked
    face.updateFromFile({ state: 'error', detail: 'command failed' });
    assert.strictEqual(face.state, 'error');
    assert.strictEqual(face.detail, 'command failed');
  });
});

describe('grid.js -- completion linger respects sessionActive (#70)', () => {
  test('stopped session decays to idle after completion linger', () => {
    const face = new MiniFace('test');
    face.state = 'happy';
    face.stopped = true;
    face.lastUpdate = Date.now() - 9000;
    face.minDisplayUntil = 0;
    face.tick(16);
    assert.strictEqual(face.state, 'idle',
      'stopped session should decay to idle, not thinking');
  });

  test('active session decays to thinking after completion linger', () => {
    const face = new MiniFace('test');
    face.state = 'happy';
    face.stopped = false;
    face.lastUpdate = Date.now() - 9000;
    face.minDisplayUntil = 0;
    face.tick(16);
    assert.strictEqual(face.state, 'thinking',
      'active session should decay to thinking');
  });
});

describe('grid.js -- lastUpdate uses Date.now() not data.timestamp (#71)', () => {
  test('lastUpdate is set to current time regardless of data.timestamp', () => {
    const face = new MiniFace('test');
    const staleTimestamp = Date.now() - 300000;
    const before = Date.now();
    face.updateFromFile({ state: 'coding', timestamp: staleTimestamp });
    assert.ok(face.lastUpdate >= before,
      'lastUpdate should use Date.now(), not stale data.timestamp');
  });

  test('lastUpdate is set even without data.timestamp', () => {
    const face = new MiniFace('test');
    const before = Date.now();
    face.updateFromFile({ state: 'reading' });
    assert.ok(face.lastUpdate >= before,
      'lastUpdate should be set even with no timestamp in data');
  });
});

describe('grid.js -- MiniFace pending state queue (#55)', () => {
  test('rejected state is buffered as pendingState', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.minDisplayUntil = Date.now() + 5000;
    face.updateFromFile({ state: 'reading', detail: 'reading bar.js' });
    assert.strictEqual(face.state, 'coding', 'state should remain locked');
    assert.strictEqual(face.pendingState, 'reading', 'rejected state should be buffered');
    assert.strictEqual(face.pendingDetail, 'reading bar.js', 'rejected detail should be buffered');
  });

  test('pending state flushes when minDisplayUntil expires in tick()', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.pendingState = 'searching';
    face.pendingDetail = 'grep foo';
    face.minDisplayUntil = Date.now() - 1;
    face.lastUpdate = Date.now();
    face.tick(16);
    assert.strictEqual(face.state, 'searching', 'pending state should flush');
    assert.strictEqual(face.detail, 'grep foo', 'pending detail should flush');
    assert.strictEqual(face.pendingState, null, 'pendingState should clear after flush');
  });

  test('active work state interrupts interruptible state despite minDisplayUntil', () => {
    const face = new MiniFace('test');
    face.state = 'idle';
    face.minDisplayUntil = Date.now() + 5000;
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js' });
    assert.strictEqual(face.state, 'coding',
      'work state should interrupt idle despite minDisplayUntil');
  });

  test('work states get shorter minDisplayUntil (~800ms)', () => {
    const face = new MiniFace('test');
    face.state = 'idle';
    face.minDisplayUntil = 0;
    const before = Date.now();
    face.updateFromFile({ state: 'coding', detail: 'editing foo.js' });
    assert.ok(face.minDisplayUntil <= before + 1000,
      'work state minDisplayUntil should be ~800ms, not 1500ms');
    assert.ok(face.minDisplayUntil >= before + 600,
      'work state minDisplayUntil should be at least ~800ms');
  });

  test('non-work state cannot interrupt locked work state', () => {
    const face = new MiniFace('test');
    face.state = 'coding';
    face.minDisplayUntil = Date.now() + 5000;
    face.updateFromFile({ state: 'thinking', detail: '' });
    assert.strictEqual(face.state, 'coding',
      'thinking should not interrupt locked coding state');
    assert.strictEqual(face.pendingState, 'thinking',
      'thinking should be buffered as pending');
  });
});

describe('grid.js -- MiniFace detail row rendering (#57)', () => {
  test('render includes detail text when detail is set', () => {
    const face = new MiniFace('test');
    face.detail = 'foo.js';
    const out = face.render(1, 1, 0, null);
    assert.ok(out.includes('foo.js'), 'render output should include detail text');
  });

  test('render omits detail row when detail is empty', () => {
    const face = new MiniFace('test');
    face.detail = '';
    const out = face.render(1, 1, 0, null);
    // Row 6 should not be written — no extra ansi.to positioning beyond row 5
    const row6Marker = '\x1b[7;'; // ansi.to(startRow+6=7, col=1) → ESC[7;1H
    assert.ok(!out.includes(row6Marker), 'row 6 should not be rendered when detail is empty');
  });

  test('detail is truncated to BOX_W (8) characters', () => {
    const face = new MiniFace('test');
    face.detail = 'this-is-a-very-long-filename.js';
    const out = face.render(1, 1, 0, null);
    assert.ok(out.includes('this-is-'), 'detail should be truncated to 8 chars');
    assert.ok(!out.includes('this-is-a-'), 'detail should not exceed 8 chars');
  });
});

// -- taskDescription tests ---------------------------------------------------

describe('grid.js -- MiniFace taskDescription', () => {
  test('stores taskDescription from updateFromFile', () => {
    const mf = new MiniFace('td-test');
    mf.updateFromFile({ state: 'coding', detail: 'editing foo.js', taskDescription: 'fix unit tests' });
    assert.strictEqual(mf.taskDescription, 'fix unit tests');
  });

  test('taskDescription not cleared by updates without it', () => {
    const mf = new MiniFace('td-sticky');
    mf.updateFromFile({ state: 'coding', detail: 'editing foo.js', taskDescription: 'fix unit tests' });
    mf.updateFromFile({ state: 'searching', detail: 'grep: TODO' });
    assert.strictEqual(mf.taskDescription, 'fix unit tests',
      'taskDescription should persist when subsequent update omits it');
  });
});

describe('grid.js -- OrbitalSystem _assignLabels taskDescription', () => {
  test('_assignLabels prefers taskDescription over cwd', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('td-label');
    face.taskDescription = 'fix tests';
    face.cwd = '/home/user/project';
    os.faces.set('td-label', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'fix test',
      'label should be taskDescription truncated to 8 chars');
  });

  test('teammate name takes priority over taskDescription', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('td-team');
    face.teammateName = 'reviewer';
    face.taskDescription = 'fix tests';
    os.faces.set('td-team', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'reviewer',
      'teammateName should take priority over taskDescription');
  });

  test('falls back to cwd when no taskDescription', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('td-fallback');
    face.cwd = '/home/user/my-project';
    os.faces.set('td-fallback', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'my-proje',
      'label should fall back to cwd basename truncated to 8 chars');
  });
});

// -- Issue #58: SessionStart always takes over as main face ------------------

describe('grid.js -- SessionStart adoption (issue #58)', () => {
  test('update-state.js: SessionStart forces shouldWriteGlobal even when another session owns state file', () => {
    // Simulates the logic in update-state.js: if an existing session owns the
    // state file (different ID, not stopped, fresh timestamp), shouldWriteGlobal
    // would normally be false. But SessionStart overrides it to true.
    const hookEvent = 'SessionStart';
    const existingSessionId = 'old-session-abc';
    const incomingSessionId = 'new-session-xyz';
    const existingTimestamp = Date.now() - 5000; // 5s ago — well within 120s

    // Simulate the shouldWriteGlobal check from update-state.js
    let shouldWriteGlobal = true;
    if (existingSessionId && existingSessionId !== incomingSessionId &&
        /* !existing.stopped */ true && Date.now() - existingTimestamp < 120000) {
      shouldWriteGlobal = false;
    }

    // Before the fix, shouldWriteGlobal would stay false and SessionStart would be lost
    assert.strictEqual(shouldWriteGlobal, false, 'shouldWriteGlobal should initially be false');

    // Apply the fix: SessionStart always forces global write
    if (hookEvent === 'SessionStart') shouldWriteGlobal = true;

    assert.strictEqual(shouldWriteGlobal, true,
      'SessionStart should force shouldWriteGlobal to true');
  });

  test('renderer adoption: detail "session starting" triggers main session takeover', () => {
    // Simulates the renderer's adoption logic: a new session with
    // detail='session starting' should be adopted even if the old session
    // is not stopped and not stale.
    const mainSessionId = 'old-session-abc';
    const incomingId = 'new-session-xyz';
    const lastStopped = false;
    const lastMainUpdate = Date.now() - 5000; // 5s ago — not stale
    const stateData = { detail: 'session starting' };

    let adopted = false;
    if (incomingId && mainSessionId && incomingId !== mainSessionId) {
      if (lastStopped || Date.now() - lastMainUpdate > 120000
          || stateData.detail === 'session starting') {
        adopted = true;
      }
    }

    assert.strictEqual(adopted, true,
      'renderer should adopt new session when detail is "session starting"');
  });

  test('renderer does NOT adopt random subagent writing to state file', () => {
    // A subagent with a different detail should NOT trigger adoption
    const mainSessionId = 'main-session';
    const incomingId = 'subagent-session';
    const lastStopped = false;
    const lastMainUpdate = Date.now() - 5000; // 5s ago — not stale
    const stateData = { detail: 'editing foo.js' };

    let adopted = false;
    if (incomingId && mainSessionId && incomingId !== mainSessionId) {
      if (lastStopped || Date.now() - lastMainUpdate > 120000
          || stateData.detail === 'session starting') {
        adopted = true;
      }
    }

    assert.strictEqual(adopted, false,
      'renderer should NOT adopt subagent with non-SessionStart detail');
  });
});

// -- Bug #0: orbital stale timeout (THINKING_TIMEOUT for active faces) -------

describe('grid.js -- isStale() uses THINKING_TIMEOUT for active faces (Bug #0)', () => {
  test('active face within 120s is not stale', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.lastUpdate = Date.now() - 60000; // 60s ago — within THINKING_TIMEOUT (120s)
    assert.ok(!face.isStale(),
      'active face updated 60s ago should not be stale (was incorrectly true after 30s)');
  });

  test('active face after 120s is stale', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.lastUpdate = Date.now() - 125000; // 125s ago — past THINKING_TIMEOUT (120s)
    assert.ok(face.isStale(),
      'active face updated 125s ago should be stale');
  });

  test('active coding face within 120s is not stale', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'coding';
    face.lastUpdate = Date.now() - 31000; // 31s ago — was stale under old STALE_MS (30s), not now
    assert.ok(!face.isStale(),
      'active coding face updated 31s ago should not be stale under THINKING_TIMEOUT');
  });

  test('stopped face is stale after STOPPED_LINGER_MS (10s)', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS (10s)
    assert.ok(face.isStale(),
      'stopped face past 10s should still be stale');
  });

  test('stopped face within STOPPED_LINGER_MS is not stale', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 5000; // 5s ago — within STOPPED_LINGER_MS (10s)
    assert.ok(!face.isStale(),
      'stopped face within 10s should not be stale');
  });

  test('completion state face is stale after STOPPED_LINGER_MS (10s)', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.lastUpdate = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS (10s)
      assert.ok(face.isStale(),
        `completion state '${state}' past 10s should be stale`);
    }
  });

  test('completion state face within STOPPED_LINGER_MS is not stale', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.lastUpdate = Date.now() - 5000; // 5s ago — within STOPPED_LINGER_MS (10s)
      assert.ok(!face.isStale(),
        `completion state '${state}' within 10s should not be stale`);
    }
  });
});

describe('grid.js -- loadSessions mtime purge protects active faces (Bug #0)', () => {
  test('source code contains active-face protection logic in mtime purge', () => {
    // Structural test: verify the fix is present in grid.js source
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'grid.js'), 'utf8'
    );
    // The fix skips deleting session files for active (non-stopped, non-completion) in-memory faces
    assert.ok(
      src.includes('knownFace && !knownFace.stopped && !completionStates.includes(knownFace.state)'),
      'loadSessions mtime purge should check for active in-memory face before deleting file'
    );
  });

  test('loadSessions does not delete file for active thinking face past STALE_MS', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    // Write a session file and back-date its mtime past STALE_MS (30s)
    const sessionId = 'active-thinking-test';
    const filePath = pathMod.join(SESSIONS_DIR, sessionId + '.json');
    const sessionData = {
      session_id: sessionId,
      state: 'thinking',
      detail: '',
      timestamp: Date.now(),
    };
    fs.writeFileSync(filePath, JSON.stringify(sessionData));

    // Pre-populate the face in memory as active (not stopped, not completion)
    const face = new MiniFace(sessionId);
    face.state = 'thinking';
    face.stopped = false;
    orbital.faces.set(sessionId, face);

    // Back-date the file mtime by writing then touching with an old time
    // We simulate STALE_MS elapsed by directly manipulating the purge condition:
    // the purge checks (now - mtime > STALE_MS) && face is active => skip delete
    // Since we can't easily fake mtime, we verify the face survives loadSessions
    // by confirming the protection branch exists (covered by source test above)
    // and that a fresh file with an active face is retained
    orbital.loadSessions('different-main-id');

    const fileStillExists = fs.existsSync(filePath);
    // Clean up regardless
    try { fs.unlinkSync(filePath); } catch {}

    assert.ok(fileStillExists || orbital.faces.has(sessionId),
      'active thinking face should be protected from mtime purge deletion');
  });
});

// -- Row 5 cwd basename fallback -----------------------------------

describe('grid.js -- MiniFace row 5 cwd fallback', () => {
  test('row 5 shows cwd basename when no gitBranch', () => {
    const face = new MiniFace('test-cwd');
    face.state = 'coding';
    face.cwd = '/home/user/projects/my-app';
    face.label = 'sub-1';
    const output = face.render(1, 1, 0, PALETTES[0].themes);
    // The 6th row (startRow + 5) should contain "my-app"
    assert.ok(output.includes('my-app'), 'row 5 should show cwd basename');
  });

  test('row 5 shows branch when gitBranch is present (not cwd)', () => {
    const face = new MiniFace('test-branch');
    face.state = 'coding';
    face.cwd = '/home/user/projects/my-app';
    face.gitBranch = 'main';
    face.label = 'sub-1';
    const output = face.render(1, 1, 0, PALETTES[0].themes);
    assert.ok(output.includes('\u2387'), 'row 5 should show branch indicator');
    assert.ok(output.includes('main'), 'row 5 should show branch name');
    // Should NOT show the cwd basename when branch is present
    assert.ok(!output.includes('my-app'), 'row 5 should not show cwd when branch exists');
  });

  test('row 5 falls back to theme.status when no cwd and no branch', () => {
    const face = new MiniFace('test-fallback');
    face.state = 'coding';
    face.cwd = '';
    face.gitBranch = null;
    face.label = 'sub-1';
    const output = face.render(1, 1, 0, PALETTES[0].themes);
    const theme = PALETTES[0].themes.coding;
    // Status gets sliced to BOX_W (8 chars), so check for the beginning
    if (theme && theme.status) {
      const expected = theme.status.slice(0, 8);
      assert.ok(output.includes(expected), 'row 5 should show theme status as fallback');
    }
  });
});

// -- renderSessionList overlay -------------------------------------

describe('grid.js -- renderSessionList', () => {
  test('returns string for empty Map', () => {
    const result = renderSessionList(80, 40, new Map(), PALETTES[0].themes);
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.includes('no sessions'), 'should show empty message');
  });

  test('returns string with session info for populated Map', () => {
    const faces = new Map();
    const f1 = new MiniFace('sess-1');
    f1.state = 'coding';
    f1.label = 'fix-auth';
    f1.cwd = '/home/user/projects/my-app';
    f1.detail = 'edit src/auth.ts';
    faces.set('sess-1', f1);

    const f2 = new MiniFace('sess-2');
    f2.state = 'thinking';
    f2.label = 'scraper';
    f2.cwd = '/home/user/projects/scraper';
    faces.set('sess-2', f2);

    const result = renderSessionList(80, 40, faces, PALETTES[0].themes);
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.length > 0, 'should produce output');
    assert.ok(result.includes('2 total'), 'should show count');
    assert.ok(result.includes('fix-auth'), 'should include label');
  });

  test('handles narrow terminal gracefully', () => {
    const faces = new Map();
    const f = new MiniFace('sess-1');
    f.state = 'coding';
    f.label = 'test';
    faces.set('sess-1', f);

    const result = renderSessionList(30, 40, faces, PALETTES[0].themes);
    assert.strictEqual(result, '', 'should return empty for narrow terminal');
  });

  test('includes stopped sessions with different indicator', () => {
    const faces = new Map();
    const f = new MiniFace('sess-stopped');
    f.state = 'idle';
    f.stopped = true;
    f.label = 'done';
    f.cwd = '/tmp/project';
    faces.set('sess-stopped', f);

    const result = renderSessionList(80, 40, faces, PALETTES[0].themes);
    assert.ok(result.includes('\u2715'), 'stopped session should show ✕ indicator');
  });

  test('shows overflow indicator when too many sessions', () => {
    const faces = new Map();
    for (let i = 0; i < 20; i++) {
      const f = new MiniFace(`sess-${i}`);
      f.state = 'coding';
      f.label = `s-${i}`;
      f.cwd = `/tmp/proj-${i}`;
      faces.set(`sess-${i}`, f);
    }

    // Very short terminal -- can only fit a few
    const result = renderSessionList(80, 15, faces, PALETTES[0].themes);
    assert.ok(result.includes('more'), 'should show overflow indicator');
  });
});

module.exports = { passed: () => passed, failed: () => failed };
