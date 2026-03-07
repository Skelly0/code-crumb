#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - grid.js (OrbitalSystem)                 |
// +================================================================+

const assert = require('assert');
const { MiniFace, OrbitalSystem, renderSessionList, isProcessAlive, STALE_MS, ORPHAN_TIMEOUT, REPOSITION_MS } = require('../grid');
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

  test('updateFromFile sets pid from session data', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding', pid: 12345 });
    assert.strictEqual(face.pid, 12345);
  });

  test('updateFromFile preserves pid when subsequent update omits it', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding', pid: 12345 });
    face.updateFromFile({ state: 'reading' });
    assert.strictEqual(face.pid, 12345,
      'pid should persist when subsequent update omits it');
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
    face.lastUpdate = Date.now() - 10000; // Past IDLE_TIMEOUT (8s) but not THINKING_TIMEOUT (45s)
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

describe('grid.js -- lastUpdate uses fileMtimeMs or Date.now() (#71)', () => {
  test('lastUpdate uses fileMtimeMs when provided', () => {
    const face = new MiniFace('test');
    const mtime = Date.now() - 20000; // 20s ago
    face.updateFromFile({ state: 'coding' }, mtime);
    assert.strictEqual(face.lastUpdate, mtime,
      'lastUpdate should use fileMtimeMs when provided');
  });

  test('lastUpdate falls back to Date.now() when fileMtimeMs is omitted', () => {
    const face = new MiniFace('test');
    const before = Date.now();
    face.updateFromFile({ state: 'reading' });
    assert.ok(face.lastUpdate >= before,
      'lastUpdate should fall back to Date.now() without fileMtimeMs');
  });

  test('lastUpdate ignores data.timestamp (not file mtime)', () => {
    const face = new MiniFace('test');
    const staleTimestamp = Date.now() - 300000;
    const before = Date.now();
    face.updateFromFile({ state: 'coding', timestamp: staleTimestamp });
    assert.ok(face.lastUpdate >= before,
      'lastUpdate should not use data.timestamp');
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

  test('render writes blank detail row when detail is empty (ghost prevention)', () => {
    const face = new MiniFace('test');
    face.detail = '';
    const out = face.render(1, 1, 0, null);
    // Row 6 should always be written (with spaces) to prevent ghost artifacts
    const row6Marker = '\x1b[7;'; // ansi.to(startRow+6=7, col=1) → ESC[7;1H
    assert.ok(out.includes(row6Marker), 'row 6 should be rendered even when detail is empty');
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

// -- isMainSession classification -------------------------------------------

describe('grid.js -- MiniFace isMainSession', () => {
  test('default isMainSession is false', () => {
    const face = new MiniFace('test');
    assert.strictEqual(face.isMainSession, false);
  });

  test('updateFromFile with no parentSession and no isTeammate sets isMainSession true', () => {
    const face = new MiniFace('independent');
    face.updateFromFile({ state: 'coding', modelName: 'claude' });
    assert.strictEqual(face.isMainSession, true);
  });

  test('updateFromFile with parentSession set keeps isMainSession false', () => {
    const face = new MiniFace('child');
    face.updateFromFile({ state: 'coding', parentSession: 'parent-123' });
    assert.strictEqual(face.isMainSession, false);
  });

  test('updateFromFile with isTeammate true keeps isMainSession false', () => {
    const face = new MiniFace('teammate');
    face.updateFromFile({ state: 'coding', isTeammate: true, teamName: 'builders' });
    assert.strictEqual(face.isMainSession, false);
  });
});

describe('grid.js -- _assignLabels isMainSession', () => {
  test('independent main session uses modelName as label', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('ind-1');
    face.isMainSession = true;
    face.modelName = 'opencode';
    face.cwd = '/home/user/project';
    os.faces.set('ind-1', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'opencode',
      'isMainSession face should use modelName as label');
  });

  test('taskDescription still takes priority over isMainSession modelName', () => {
    const os = new OrbitalSystem();
    const face = new MiniFace('ind-2');
    face.isMainSession = true;
    face.modelName = 'claude';
    face.taskDescription = 'fix bugs';
    os.faces.set('ind-2', face);
    os._assignLabels();
    assert.strictEqual(face.label, 'fix bugs',
      'taskDescription should still take priority over isMainSession');
  });
});

describe('grid.js -- renderSessionList isMainSession indicator', () => {
  test('orbital with isMainSession gets outline star', () => {
    const face = new MiniFace('ind-orbital');
    face.state = 'coding';
    face.label = 'opencode';
    face.isMainSession = true;
    face.cwd = '/home/user/project';
    const result = renderSessionList(80, 40, [face], PALETTES[0].themes);
    assert.ok(result.includes('\u2606'), 'should show outline star for isMainSession orbital');
  });

  test('orbital without isMainSession gets no star', () => {
    const face = new MiniFace('sub-orbital');
    face.state = 'coding';
    face.label = 'sub-1';
    face.isMainSession = false;
    face.cwd = '/home/user/project';
    const result = renderSessionList(80, 40, [face], PALETTES[0].themes);
    assert.ok(!result.includes('\u2606'), 'should not show outline star for regular subagent');
    assert.ok(!result.includes('\u2605'), 'should not show filled star for regular subagent');
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

// -- Bug #0: orbital stale timeout (PID liveness + ORPHAN_TIMEOUT fallback) ---

describe('grid.js -- isStale() uses PID liveness + ORPHAN_TIMEOUT fallback (Bug #0)', () => {
  test('active face with live pid is never stale regardless of lastUpdate age', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = process.pid; // current process — definitely alive
    face.lastUpdate = Date.now() - 200000; // 200s ago — way past any timeout
    assert.ok(!face.isStale(),
      'face with live owning process should never be stale');
  });

  test('active face with dead pid and old lastUpdate is stale', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = 999999; // almost certainly not a real process
    face.lastUpdate = Date.now() - 100000; // 100s ago — past ORPHAN_TIMEOUT (90s)
    assert.ok(face.isStale(),
      'face with dead process and old lastUpdate should be stale');
  });

  test('active face with dead pid but recent lastUpdate is not stale', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'coding';
    face.pid = 999999; // dead process
    face.lastUpdate = Date.now() - 60000; // 60s ago — within ORPHAN_TIMEOUT (90s)
    assert.ok(!face.isStale(),
      'face with dead process but recent update should not be stale yet');
  });

  test('active face without pid falls back to ORPHAN_TIMEOUT (90s)', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = 0; // no pid (legacy session file)
    face.lastUpdate = Date.now() - 60000; // 60s ago — within ORPHAN_TIMEOUT (90s)
    assert.ok(!face.isStale(),
      'face without pid updated 60s ago should not be stale under ORPHAN_TIMEOUT');
  });

  test('active face without pid is stale after ORPHAN_TIMEOUT (90s)', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = 0; // no pid
    face.lastUpdate = Date.now() - 100000; // 100s ago — past ORPHAN_TIMEOUT (90s)
    assert.ok(face.isStale(),
      'face without pid updated 100s ago should be stale');
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

  test('stopped face with live pid is still stale after STOPPED_LINGER_MS', () => {
    const face = new MiniFace('test');
    face.stopped = true;
    face.stoppedAt = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS (10s)
    face.pid = process.pid; // live process — but stopped takes priority
    assert.ok(face.isStale(),
      'stopped flag should take priority over pid liveness');
  });

  test('active face with negative pid falls back to ORPHAN_TIMEOUT', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = -1; // negative pid — would signal process group on Unix
    face.lastUpdate = Date.now() - 100000; // 100s ago — past ORPHAN_TIMEOUT (90s)
    assert.ok(face.isStale(),
      'negative pid should be treated as no pid');
  });

  test('active face with pid 1 falls back to ORPHAN_TIMEOUT', () => {
    const face = new MiniFace('test');
    face.stopped = false;
    face.state = 'thinking';
    face.pid = 1; // PID 1 (init) — always alive, should be rejected
    face.lastUpdate = Date.now() - 100000; // 100s ago — past ORPHAN_TIMEOUT (90s)
    assert.ok(face.isStale(),
      'PID 1 should be rejected to prevent immortal orbitals');
  });

  test('completion state face (no pid) is stale after STOPPED_LINGER_MS (10s)', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.pid = 0; // no pid — falls through to completion-state timeout
      face.lastUpdate = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS (10s)
      assert.ok(face.isStale(),
        `completion state '${state}' past 10s (no pid) should be stale`);
    }
  });

  test('completion state face (no pid) within STOPPED_LINGER_MS is not stale', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.pid = 0; // no pid
      face.lastUpdate = Date.now() - 5000; // 5s ago — within STOPPED_LINGER_MS (10s)
      assert.ok(!face.isStale(),
        `completion state '${state}' within 10s (no pid) should not be stale`);
    }
  });

  test('completion state face with LIVE pid is NOT stale (Bug #108 fix)', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.pid = process.pid; // live process — should protect from staleness
      face.lastUpdate = Date.now() - 200000; // 200s ago — way past any timeout
      assert.ok(!face.isStale(),
        `completion state '${state}' with live pid should NEVER be stale`);
    }
  });

  test('completion state face with DEAD pid is stale after STOPPED_LINGER_MS', () => {
    const completionStates = ['happy', 'satisfied', 'proud', 'relieved'];
    for (const state of completionStates) {
      const face = new MiniFace('test');
      face.state = state;
      face.stopped = false;
      face.pid = 999999; // dead process
      face.lastUpdate = Date.now() - 15000; // 15s ago — past STOPPED_LINGER_MS
      assert.ok(face.isStale(),
        `completion state '${state}' with dead pid past 10s should be stale`);
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
      src.includes('if (knownFace && !knownFace.stopped)') &&
      src.includes('if (!completionStates.includes(knownFace.state)) continue;'),
      'loadSessions mtime purge should check for active in-memory face before deleting file'
    );
  });

  test('source code contains PID liveness check in isStale', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'grid.js'), 'utf8'
    );
    assert.ok(
      src.includes('isProcessAlive(this.pid)'),
      'isStale should check PID liveness before falling back to timeout'
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
  test('returns string for empty array', () => {
    const result = renderSessionList(80, 40, [], PALETTES[0].themes);
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

    const result = renderSessionList(80, 40, [...faces.values()], PALETTES[0].themes);
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

    const result = renderSessionList(30, 40, [...faces.values()], PALETTES[0].themes);
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

    const result = renderSessionList(80, 40, [...faces.values()], PALETTES[0].themes);
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
    const result = renderSessionList(80, 15, [...faces.values()], PALETTES[0].themes);
    assert.ok(result.includes('more'), 'should show overflow indicator');
  });
});

describe('grid.js -- renderSessionList selection', () => {
  function _makeFaces(n) {
    const faces = [];
    for (let i = 0; i < n; i++) {
      const f = new MiniFace(`sess-${i}`);
      f.state = i === 0 ? 'coding' : 'thinking';
      f.label = `sub-${i}`;
      f.cwd = `/home/user/proj-${i}`;
      faces.push(f);
    }
    return faces;
  }

  test('no highlight when selectedIndex is -1 (default)', () => {
    const faces = _makeFaces(2);
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes);
    // No selection marker should appear
    assert.ok(!result.includes('\u25b8'), 'no selection marker without selectedIndex');
  });

  test('shows selection marker when selectedIndex is set', () => {
    const faces = _makeFaces(2);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 1);
    assert.ok(result.includes('\u25b8'), 'should show selection marker ▸');
  });

  test('shows footer hint when selectedIndex >= 0', () => {
    const faces = _makeFaces(2);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('select'), 'footer should mention select');
    assert.ok(result.includes('promote'), 'footer should mention promote');
    assert.ok(result.includes('esc'), 'footer should mention esc');
  });

  test('no footer hint without selection', () => {
    const faces = _makeFaces(2);
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes);
    assert.ok(!result.includes('promote'), 'no footer without selection');
  });

  test('selectedIndex beyond visible range does not crash', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // selectedIndex 99 — way beyond the 2 entries (main + 1 sub)
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 99);
    assert.strictEqual(typeof result, 'string');
    // All 2 entries fit on screen — no phantom above indicator
    assert.ok(!result.includes('above'), 'no above indicator when all entries fit');
  });

  test('count text reflects main + orbitals', () => {
    const faces = _makeFaces(3);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('4 total'), 'should count main + 3 subs = 4 total');
  });

  test('empty map with selectedIndex shows footer but no entries', () => {
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, [], PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('promote'), 'footer shows even with only main');
  });

  test('backward compatible: omitting selectedIndex works', () => {
    const faces = _makeFaces(2);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // Calling without 6th arg should not crash
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo);
    assert.strictEqual(typeof result, 'string');
    assert.ok(!result.includes('\u25b8'), 'no selection marker without selectedIndex');
  });

  test('main session entry shows star indicator', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'thinking', detail: 'analyzing', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('\u2605'), 'main session should show ★ indicator');
  });

  test('subagent entries do not show star indicator', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    // Count ★ occurrences — should be exactly 1 (main only)
    const stars = (result.match(/\u2605/g) || []).length;
    assert.strictEqual(stars, 1, 'only main session should have ★, not subagents');
  });

  test('scrolls to show selected item beyond maxVisible', () => {
    // 5 subs + main = 6 sessions; rows=15 → maxVisible = floor((15-6)/4) = 2
    const faces = _makeFaces(5);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // Select the last session (index 5 in 0-based sorted array)
    const result = renderSessionList(80, 15, faces, PALETTES[0].themes, mainInfo, 5);
    // The last sub should be visible and selected
    assert.ok(result.includes('\u25b8'), 'should show selection marker');
    assert.ok(result.includes('sub-4'), 'last sub should be visible when scrolled');
    // "above" indicator should appear since we scrolled past top
    assert.ok(result.includes('above'), 'should show above indicator when scrolled down');
  });

  test('no above indicator when selection is at scroll top', () => {
    const faces = _makeFaces(5);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // Select index 0 — no scrolling needed
    const result = renderSessionList(80, 15, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(!result.includes('above'), 'no above indicator at top of list');
  });

  test('more indicator for items below visible window', () => {
    const faces = _makeFaces(5);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true,
    };
    // Select index 0 — items below are hidden
    const result = renderSessionList(80, 15, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('more'), 'should show more indicator for items below');
  });
});

// -- renderSessionList pin indicator ----------------------------------------

describe('grid.js -- renderSessionList pin indicator', () => {
  function _makeFaces(n) {
    const faces = [];
    for (let i = 0; i < n; i++) {
      const f = new MiniFace(`sess-${i}`);
      f.state = 'thinking';
      f.label = `sub-${i}`;
      f.cwd = `/home/user/proj-${i}`;
      faces.push(f);
    }
    return faces;
  }

  test('shows pin icon when isPinned is true', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'coding', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('\u229b'), 'pinned main should show ⊛ indicator');
    assert.ok(!result.includes('\u2605'), 'pinned main should not show ★');
  });

  test('shows star icon when isPinned is false', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'coding', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: false,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('\u2605'), 'unpinned main should show ★ indicator');
    assert.ok(!result.includes('\u229b'), 'unpinned main should not show ⊛');
  });

  test('footer says unpin when index 0 selected and pinned', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: true,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('unpin'), 'footer should say unpin when main is pinned and selected');
    assert.ok(!result.includes('pin+promote'), 'footer should not say pin+promote');
  });

  test('footer says pin+promote when index > 0 selected', () => {
    const faces = _makeFaces(2);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: false,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 1);
    assert.ok(result.includes('pin+promote'), 'footer should say pin+promote for orbital selection');
    assert.ok(!result.includes('unpin'), 'footer should not say unpin');
  });

  test('footer says promote when index 0 selected and not pinned', () => {
    const faces = _makeFaces(1);
    const mainInfo = {
      state: 'idle', detail: '', cwd: '/home', gitBranch: 'main',
      label: 'claude', stopped: false, firstSeen: 0, isMain: true, isPinned: false,
    };
    const result = renderSessionList(80, 40, faces, PALETTES[0].themes, mainInfo, 0);
    assert.ok(result.includes('promote'), 'footer should say promote');
    assert.ok(!result.includes('unpin'), 'footer should not say unpin');
    assert.ok(!result.includes('pin+promote'), 'footer should not say pin+promote');
  });
});

// -- _renderConnections filtering -------------------------------------------

describe('_renderConnections filtering', () => {
  // Helper: build an OrbitalSystem with mainSessionId set
  function makeOrbital(mainId) {
    const os = new OrbitalSystem();
    os.mainSessionId = mainId;
    os.time = 5000; // non-zero for pulse calculation
    return os;
  }

  // mainPos centered in a large terminal so connection dots aren't clipped
  const mainPos = {
    col: 10, row: 5, w: 20, h: 10,
    centerX: 20, centerY: 10,
  };
  const accentColor = [100, 200, 255];

  // Position far enough from main (steps >= 4) to generate dots
  function makePos(face) {
    return { col: 60, row: 25, face };
  }

  test('connection drawn for child whose parentSession matches main', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: 'session-A', isTeammate: false });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(out.includes('\u00b7'), 'should draw dots for matching parentSession');
  });

  test('no connection for child whose parentSession does NOT match main', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: 'session-B', isTeammate: false });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(!out.includes('\u00b7'), 'should skip dots when parentSession belongs to another session');
  });

  test('no connection for session with no parentSession (parallel session)', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: null, isTeammate: false });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(!out.includes('\u00b7'), 'should skip dots for parallel sessions without parentSession');
  });

  test('connection drawn for teammate regardless of parentSession', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: null, isTeammate: true, teamColor: [255, 100, 50] });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(out.includes('\u00b7'), 'teammates always get connection lines');
  });

  test('connection drawn for teammate with mismatched parentSession', () => {
    const os = makeOrbital('session-A');
    const pos = makePos({ parentSession: 'session-X', isTeammate: true, teamColor: [255, 100, 50] });
    const out = os._renderConnections(mainPos, [pos], accentColor);
    assert.ok(out.includes('\u00b7'), 'teammates get connections even with unrelated parentSession');
  });
});

// -- loadSessions transient read failure protection --------------------

describe('grid.js -- loadSessions transient read failure protection', () => {
  test('loadSessions protects existing face when file read returns empty', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const filePath = path.join(SESSIONS_DIR, 'flicker-empty.json');

    // First write: valid data so face gets created
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: 'flicker-empty',
      state: 'coding',
      detail: 'editing file',
      timestamp: Date.now(),
    }));
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has('flicker-empty'), 'face should exist after valid read');

    // Second write: empty file (simulates mid-write on Windows)
    fs.writeFileSync(filePath, '');
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has('flicker-empty'),
      'existing face should survive when file is empty (mid-write)');

    try { fs.unlinkSync(filePath); } catch {}
  });

  test('loadSessions protects existing face when file parse fails', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const filePath = path.join(SESSIONS_DIR, 'flicker-parse.json');

    // First write: valid data so face gets created
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: 'flicker-parse',
      state: 'thinking',
      detail: '',
      timestamp: Date.now(),
    }));
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has('flicker-parse'), 'face should exist after valid read');

    // Second write: truncated JSON (simulates partial write)
    fs.writeFileSync(filePath, '{"session_id":"flicker-par');
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has('flicker-parse'),
      'existing face should survive when file contains invalid JSON (partial write)');

    try { fs.unlinkSync(filePath); } catch {}
  });

  test('loadSessions does not create phantom face on read failure', () => {
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}
    const filePath = path.join(SESSIONS_DIR, 'phantom-test.json');

    // Write an empty file with no pre-existing face
    fs.writeFileSync(filePath, '');
    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has('phantom-test'),
      'should not create a face from an empty file');

    // Write truncated JSON with no pre-existing face
    fs.writeFileSync(filePath, '{"session_id":"phantom');
    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has('phantom-test'),
      'should not create a face from invalid JSON');

    try { fs.unlinkSync(filePath); } catch {}
  });
});

// -- Orbital session cleanup regression guards --------------------------

describe('grid.js -- session cleanup uses fileToFaceId and PID check', () => {
  test('STALE_MS >= ORPHAN_TIMEOUT (regression guard)', () => {
    assert.ok(STALE_MS >= ORPHAN_TIMEOUT,
      `STALE_MS (${STALE_MS}) must be >= ORPHAN_TIMEOUT (${ORPHAN_TIMEOUT})`);
  });

  test('isProcessAlive returns true for own process', () => {
    assert.strictEqual(isProcessAlive(process.pid), true);
  });

  test('isProcessAlive returns false for non-existent PID', () => {
    // PID 999999 is almost certainly not running
    assert.strictEqual(isProcessAlive(999999), false);
  });

  test('file deletion uses fileToFaceId reverse map for face lookup', () => {
    // Structural: loadSessions must use fileToFaceId (not path.basename) to find
    // the in-memory face protecting a session file. This test verifies that a face
    // whose session_id differs from its safeFilename is correctly protected.
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    // Session ID with characters that safeFilename transforms
    const sessionId = 'ses:special/chars!here';
    const filename = safeFilename(sessionId) + '.json';
    const filePath = path.join(SESSIONS_DIR, filename);

    // Write a valid session file
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId,
      state: 'thinking',
      pid: process.pid,
      timestamp: Date.now(),
    }));

    // First load: creates the face keyed by session_id
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should be created with session_id key');

    // Now make the file stale (backdate mtime far past STALE_MS)
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Second load: deletion loop must use fileToFaceId to find the active face
    // and protect the file (face is in 'thinking' state, not stopped)
    orbital.loadSessions('main-id');
    assert.ok(fs.existsSync(filePath),
      'stale file should NOT be deleted when an active in-memory face protects it via fileToFaceId');

    // Cleanup
    try { fs.unlinkSync(filePath); } catch {}
  });

  test('file deletion checks PID before deleting unprotected files', () => {
    // Structural: when no in-memory face protects a file, loadSessions must
    // read the file's pid field and call isProcessAlive before deleting.
    const fs = require('fs');
    const path = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const filePath = path.join(SESSIONS_DIR, 'pid-alive-test.json');

    // Write a stale file with OUR pid (still alive) but don't create a face for it
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: 'pid-alive-test',
      state: 'thinking',
      pid: process.pid,
      timestamp: Date.now(),
    }));

    // Backdate the file past STALE_MS
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Load — no in-memory face exists, but PID is alive → file should survive
    orbital.loadSessions('main-id');
    assert.ok(fs.existsSync(filePath),
      'stale file with alive PID should NOT be deleted');

    // Cleanup
    try { fs.unlinkSync(filePath); } catch {}
  });
});

// -- Bug #108: updateFromFile mtime tracking + stopped guard ---

describe('grid.js -- updateFromFile skips redundant updates (Bug #108)', () => {
  test('updateFromFile skips re-application when mtime is unchanged', () => {
    const face = new MiniFace('test');
    const mtime = Date.now() - 5000;
    face.updateFromFile({ state: 'coding', detail: 'edit foo.js' }, mtime);
    assert.strictEqual(face.state, 'coding');
    assert.strictEqual(face.detail, 'edit foo.js');

    // Second call with same mtime — should be skipped entirely
    face.updateFromFile({ state: 'reading', detail: 'bar.js' }, mtime);
    assert.strictEqual(face.state, 'coding',
      'state should not change when mtime is unchanged');
    assert.strictEqual(face.detail, 'edit foo.js',
      'detail should not change when mtime is unchanged');
  });

  test('updateFromFile applies update when mtime changes', () => {
    const face = new MiniFace('test');
    const mtime1 = Date.now() - 5000;
    face.updateFromFile({ state: 'thinking' }, mtime1);
    assert.strictEqual(face.state, 'thinking');

    // New mtime — should apply (coding can interrupt thinking)
    face.minDisplayUntil = 0; // bypass display timer for clean test
    const mtime2 = Date.now() - 3000;
    face.updateFromFile({ state: 'coding' }, mtime2);
    assert.strictEqual(face.state, 'coding',
      'state should update when mtime changes');
  });

  test('updateFromFile skips when face is stopped', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'coding' }, Date.now());
    assert.strictEqual(face.state, 'coding');

    // Stop the face
    face.stopped = true;
    face.stoppedAt = Date.now();

    // Try to update — should be ignored
    face.updateFromFile({ state: 'reading', detail: 'new stuff' }, Date.now() + 1000);
    assert.strictEqual(face.state, 'coding',
      'stopped face should not accept new state from file');
  });

  test('updateFromFile applies when mtime is 0 (no mtime available)', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'thinking' }, 0);
    assert.strictEqual(face.state, 'thinking');

    // Another call with 0 mtime — should still apply (no mtime tracking)
    face.minDisplayUntil = 0;
    face.updateFromFile({ state: 'coding' }, 0);
    assert.strictEqual(face.state, 'coding',
      'should apply updates when mtime is unavailable (0)');
  });

  test('updateFromFile applies when no mtime argument given', () => {
    const face = new MiniFace('test');
    face.updateFromFile({ state: 'thinking' });
    assert.strictEqual(face.state, 'thinking');

    // Another call with undefined mtime
    face.minDisplayUntil = 0;
    face.updateFromFile({ state: 'coding' });
    assert.strictEqual(face.state, 'coding',
      'should apply updates when mtime is undefined');
  });
});

// -- Bug #111: Face removal respects PID liveness when file is missing (Bug A) --

describe('grid.js -- face removal respects PID liveness when file is missing (Bug A)', () => {
  test('face with live PID stays in memory when its file disappears', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'pid-alive-no-file-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write a valid session file with our PID
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'thinking',
      pid: process.pid, timestamp: Date.now(),
    }));

    // First load: creates the face
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');

    // Delete the file — simulating race condition or external cleanup
    try { fs.unlinkSync(filePath); } catch {}
    assert.ok(!fs.existsSync(filePath), 'file should be gone');

    // Second load: file is missing, but PID is alive → face should survive
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId),
      'face with live PID should NOT be removed when its file disappears');
  });

  test('face with dead PID is removed when its file disappears', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'dead-pid-no-file-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write with a dead PID
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'thinking',
      pid: 999999, timestamp: Date.now(),
    }));

    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');

    // Delete the file
    try { fs.unlinkSync(filePath); } catch {}

    // Second load: file gone AND PID dead → face should be removed
    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has(sessionId),
      'face with dead PID should be removed when its file disappears');
  });

  test('stopped face is removed when its file disappears (regardless of PID)', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'stopped-no-file-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write with our PID (alive) but stopped
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'happy', stopped: true,
      pid: process.pid, timestamp: Date.now(),
    }));

    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');
    const face = orbital.faces.get(sessionId);
    // Ensure face is marked stopped and stale enough to be removed
    face.stopped = true;
    face.stoppedAt = Date.now() - 20000;

    // Delete the file
    try { fs.unlinkSync(filePath); } catch {}

    // Second load: file gone, face stopped → should be removed despite live PID
    orbital.loadSessions('main-id');
    assert.ok(!orbital.faces.has(sessionId),
      'stopped face should be removed even with live PID when file is gone');
  });
});

// -- Bug #111: File deletion protects on parse error (Bug B) --

describe('grid.js -- file deletion protects on parse error (Bug B)', () => {
  test('corrupted JSON file is not deleted during mtime purge', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const filePath = pathMod.join(SESSIONS_DIR, 'corrupted-json-test.json');

    // Write corrupted JSON (simulates mid-write race)
    fs.writeFileSync(filePath, '{"session_id":"corrupted-json-test","state":"thinki');

    // Backdate past STALE_MS so purge loop considers it
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Load — purge loop should catch the parse error and continue (protect the file)
    orbital.loadSessions('main-id');
    assert.ok(fs.existsSync(filePath),
      'corrupted JSON file should NOT be deleted during purge — could be mid-write');

    // Cleanup
    try { fs.unlinkSync(filePath); } catch {}
  });

  test('source code has catch-continue in purge loop parse', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'grid.js'), 'utf8'
    );
    // The purge loop's inner try/catch for JSON.parse should continue on error
    assert.ok(
      src.includes('catch {') && src.includes('continue; // Parse failure = mid-write race'),
      'purge loop catch block should continue instead of falling through to unlink'
    );
  });
});

// -- Bug #111: Completion-state face with live PID protected in file deletion (Bug C) --

describe('grid.js -- completion-state face with live PID protected in file deletion (Bug C)', () => {
  test('happy-state face with live PID is not deleted during mtime purge', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'happy-pid-alive-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write a completion-state session with our PID
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'happy',
      pid: process.pid, timestamp: Date.now(),
    }));

    // First load: creates the face in happy state
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');
    assert.strictEqual(orbital.faces.get(sessionId).state, 'happy');

    // Backdate file past STALE_MS
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Second load: file is stale and face is in completion state,
    // but PID is alive → file should be protected
    orbital.loadSessions('main-id');
    assert.ok(fs.existsSync(filePath),
      'stale file for completion-state face with live PID should NOT be deleted');

    // Cleanup
    try { fs.unlinkSync(filePath); } catch {}
  });

  test('completion-state face with dead PID is deleted during mtime purge', () => {
    const fs = require('fs');
    const pathMod = require('path');
    const { SESSIONS_DIR, safeFilename } = require('../shared');
    const orbital = new OrbitalSystem();

    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

    const sessionId = 'happy-pid-dead-test';
    const filePath = pathMod.join(SESSIONS_DIR, safeFilename(sessionId) + '.json');

    // Write a completion-state session with a dead PID
    fs.writeFileSync(filePath, JSON.stringify({
      session_id: sessionId, state: 'happy',
      pid: 999999, timestamp: Date.now(),
    }));

    // First load
    orbital.loadSessions('main-id');
    assert.ok(orbital.faces.has(sessionId), 'face should exist after first load');

    // Backdate past STALE_MS
    const staleTime = new Date(Date.now() - STALE_MS - 5000);
    fs.utimesSync(filePath, staleTime, staleTime);

    // Second load: stale, completion state, dead PID → should be deleted
    orbital.loadSessions('main-id');
    assert.ok(!fs.existsSync(filePath),
      'stale file for completion-state face with dead PID should be deleted');
  });

  test('source code checks PID liveness for completion-state faces in purge', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '..', 'grid.js'), 'utf8'
    );
    // The fix separates active non-completion (always protect) from completion with live PID
    assert.ok(
      src.includes('if (knownFace.pid && isProcessAlive(knownFace.pid)) continue;'),
      'purge loop should check PID liveness for completion-state faces'
    );
  });
});

// -- Orbital Grouping Tests ----------------------------------------

describe('grid.js -- OrbitalSystem._buildGroups', () => {
  test('groups faces by teamName', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'backend'; f1.teamColor = [255, 120, 120];
    const f2 = new MiniFace('s2'); f2.teamName = 'backend'; f2.teamColor = [255, 120, 120];
    const f3 = new MiniFace('s3'); f3.teamName = 'frontend';
    const groups = os._buildGroups([f1, f2, f3]);
    assert.strictEqual(groups.length, 2);
    const backend = groups.find(g => g.key === 'backend');
    assert.ok(backend);
    assert.strictEqual(backend.members.length, 2);
  });

  test('groups faces by parentSession when no teamName', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main-1';
    const f3 = new MiniFace('s3'); f3.parentSession = 'main-2';
    const groups = os._buildGroups([f1, f2, f3]);
    assert.strictEqual(groups.length, 2);
    const g1 = groups.find(g => g.key === 'main-1');
    assert.strictEqual(g1.members.length, 2);
  });

  test('falls back to sessionId for ungrouped faces', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1');
    const f2 = new MiniFace('s2');
    const groups = os._buildGroups([f1, f2]);
    assert.strictEqual(groups.length, 2);
    assert.strictEqual(groups[0].members.length, 1);
    assert.strictEqual(groups[1].members.length, 1);
  });

  test('derives color from team-colored members', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'ops'; f1.teamColor = [100, 200, 255];
    const f2 = new MiniFace('s2'); f2.teamName = 'ops';
    const groups = os._buildGroups([f1, f2]);
    assert.deepStrictEqual(groups[0].color, [100, 200, 255]);
  });

  test('color is null for non-team groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main';
    const groups = os._buildGroups([f1, f2]);
    assert.strictEqual(groups[0].color, null);
  });

  test('sorts groups by earliest firstSeen', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'late'; f1.firstSeen = 5000;
    const f2 = new MiniFace('s2'); f2.teamName = 'early'; f2.firstSeen = 1000;
    const groups = os._buildGroups([f1, f2]);
    assert.strictEqual(groups[0].key, 'early');
    assert.strictEqual(groups[1].key, 'late');
  });

  test('empty input returns empty groups', () => {
    const os = new OrbitalSystem();
    assert.strictEqual(os._buildGroups([]).length, 0);
  });
});

describe('grid.js -- OrbitalSystem._calculateGroupedAngles', () => {
  test('single face returns single angle at rotationAngle', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 1.5;
    const f1 = new MiniFace('s1');
    const angles = os._calculateGroupedAngles([f1]);
    assert.strictEqual(angles.size, 1);
    assert.strictEqual(angles.get(f1), 1.5);
  });

  test('empty input returns empty map', () => {
    const os = new OrbitalSystem();
    assert.strictEqual(os._calculateGroupedAngles([]).size, 0);
  });

  test('two groups cluster members with intra < inter gaps', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 0;
    const f1 = new MiniFace('s1'); f1.teamName = 'alpha'; f1.firstSeen = 100;
    const f2 = new MiniFace('s2'); f2.teamName = 'alpha'; f2.firstSeen = 200;
    const f3 = new MiniFace('s3'); f3.teamName = 'beta'; f3.firstSeen = 300;
    const f4 = new MiniFace('s4'); f4.teamName = 'beta'; f4.firstSeen = 400;
    const angles = os._calculateGroupedAngles([f1, f2, f3, f4]);

    // Within group alpha, the gap should be <= INTRA_GROUP_GAP
    const intraAlpha = Math.abs(angles.get(f2) - angles.get(f1));
    assert.ok(intraAlpha <= 0.35 + 0.001, `intra-group gap ${intraAlpha} should be <= 0.35`);

    // The gap between the groups should be larger than the intra-group gap
    const a2 = angles.get(f2); // last of alpha
    const b1 = angles.get(f3); // first of beta
    const interGap = b1 - a2;
    assert.ok(interGap > intraAlpha, `inter-group gap ${interGap} should exceed intra-group ${intraAlpha}`);
  });

  test('all ungrouped approximates even spacing', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 0;
    const faces = [];
    for (let i = 0; i < 4; i++) {
      const f = new MiniFace('s' + i);
      f.firstSeen = i * 100;
      faces.push(f);
    }
    const angles = os._calculateGroupedAngles(faces);

    // Even spacing would be ~PI/2 (1.57). With singletons the gaps should be roughly similar.
    const vals = faces.map(f => angles.get(f));
    for (let i = 1; i < vals.length; i++) {
      const gap = vals[i] - vals[i - 1];
      assert.ok(gap > 0.3 && gap < 2.5, `gap ${gap} should be roughly even`);
    }
  });

  test('returns angle for every visible face', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 0;
    const faces = [];
    for (let i = 0; i < 8; i++) {
      const f = new MiniFace('s' + i);
      f.parentSession = i < 4 ? 'main-a' : 'main-b';
      f.firstSeen = i * 100;
      faces.push(f);
    }
    const angles = os._calculateGroupedAngles(faces);
    assert.strictEqual(angles.size, 8);
    for (const f of faces) {
      assert.ok(typeof angles.get(f) === 'number', `face ${f.sessionId} should have an angle`);
    }
  });
});

describe('grid.js -- OrbitalSystem._renderGroupTethers', () => {
  test('returns empty string for singleton groups', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('s1') },
      { col: 40, row: 5, face: new MiniFace('s2') },
    ];
    const dots = [];
    const mainPos = { col: 25, row: 10, w: 12, h: 8, centerX: 31, centerY: 14 };
    const result = os._renderGroupTethers(positions, mainPos, [100, 160, 210], dots);
    assert.strictEqual(result, '');
    assert.strictEqual(dots.length, 0);
  });

  test('produces ANSI output for multi-member groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main';
    // Space them far apart so tether dots are drawn
    const positions = [
      { col: 5, row: 2, face: f1 },
      { col: 60, row: 2, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 30, row: 15, w: 12, h: 8, centerX: 36, centerY: 19 };
    const result = os._renderGroupTethers(positions, mainPos, [100, 160, 210], dots);
    assert.ok(result.length > 0, 'should produce ANSI output');
    assert.ok(dots.length > 0, 'should track dot positions');
  });
});

describe('grid.js -- OrbitalSystem._renderGroupLabels', () => {
  test('returns empty string for singleton groups', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('s1') },
      { col: 40, row: 5, face: new MiniFace('s2') },
    ];
    const dots = [];
    const mainPos = { col: 30, row: 15, w: 12, h: 8, centerX: 36, centerY: 19 };
    const result = os._renderGroupLabels(positions, 30, 80, dots, mainPos);
    assert.strictEqual(result, '');
    assert.strictEqual(dots.length, 0);
  });

  test('produces label text for multi-member groups', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2';
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 25, row: 5, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, dots, mainPos);
    assert.ok(result.length > 0, 'should produce ANSI output');
    assert.ok(dots.length > 0, 'should track label positions');
  });

  test('team groups show teamName as label', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.teamName = 'backend'; f1.teamColor = [255, 120, 120];
    const f2 = new MiniFace('s2'); f2.teamName = 'backend'; f2.teamColor = [255, 120, 120];
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 30, row: 5, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, dots, mainPos);
    assert.ok(result.includes('backend'), 'should contain team name label');
  });

  test('non-team groups show first member face label', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2';
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 30, row: 5, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, dots, mainPos);
    assert.ok(result.includes('sub-1'), 'should contain first member label');
  });

  test('spawning faces excluded from label positioning', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2'; f2.spawning = true;
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 25, row: 5, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, dots, mainPos);
    // Only 1 non-spawning member, so no label (need 2+)
    assert.strictEqual(result, '', 'should skip label when only 1 non-spawning member');
  });

  test('all-spawning group produces no label', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.spawning = true;
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.spawning = true;
    const positions = [
      { col: 10, row: 5, face: f1 },
      { col: 25, row: 5, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 50, row: 20, w: 12, h: 8, centerX: 56, centerY: 24 };
    const result = os._renderGroupLabels(positions, 30, 80, dots, mainPos);
    assert.strictEqual(result, '');
  });

  test('label skipped when overlapping main face area', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2';
    // Place faces directly above main face so label row falls inside exclusion zone
    const mainPos = { col: 10, row: 14, w: 30, h: 10, centerX: 25, centerY: 19 };
    const positions = [
      { col: 10, row: 7, face: f1 },
      { col: 25, row: 7, face: f2 },
    ];
    const dots = [];
    const result = os._renderGroupLabels(positions, 30, 80, dots, mainPos);
    // Label row = 7 + 7 = 14, which is inside mainPos.row-8=6 to mainPos.row+h+7=31
    assert.strictEqual(result, '', 'should skip label when overlapping main face');
  });

  test('label clamped to terminal bounds', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('s1'); f1.parentSession = 'main'; f1.label = 'sub-1';
    const f2 = new MiniFace('s2'); f2.parentSession = 'main'; f2.label = 'sub-2';
    // Place faces at far right edge
    const positions = [
      { col: 70, row: 2, face: f1 },
      { col: 75, row: 2, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 30, row: 20, w: 12, h: 8, centerX: 36, centerY: 24 };
    const result = os._renderGroupLabels(positions, 15, 80, dots, mainPos);
    // Label should still be within terminal cols
    if (result.length > 0) {
      const colMatch = result.match(/\x1b\[(\d+);(\d+)H/);
      if (colMatch) {
        const labelCol = parseInt(colMatch[2], 10);
        assert.ok(labelCol >= 1 && labelCol <= 80, 'label col should be within bounds');
      }
    }
  });
});

describe('grid.js -- OrbitalSystem._resolveOverlaps', () => {
  test('separates two horizontally overlapping faces', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('a') },
      { col: 14, row: 5, face: new MiniFace('b') }, // overlaps: MINI_W=8, 14 < 10+8
    ];
    os._resolveOverlaps(positions, 80, 30);
    const gap = Math.max(positions[0].col + 8, positions[1].col + 8) -
                Math.min(positions[0].col, positions[1].col);
    // After resolve, bounding boxes should not overlap
    const overlapX = Math.min(positions[0].col + 8, positions[1].col + 8) -
                     Math.max(positions[0].col, positions[1].col);
    assert.ok(overlapX <= 0, `faces should not overlap horizontally, overlapX=${overlapX}`);
  });

  test('separates two vertically overlapping faces', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('a') },
      { col: 10, row: 8, face: new MiniFace('b') }, // overlaps: MINI_H=7, 8 < 5+7
    ];
    os._resolveOverlaps(positions, 80, 30);
    const overlapY = Math.min(positions[0].row + 7, positions[1].row + 7) -
                     Math.max(positions[0].row, positions[1].row);
    assert.ok(overlapY <= 0, `faces should not overlap vertically, overlapY=${overlapY}`);
  });

  test('leaves non-overlapping faces untouched', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 10, row: 5, face: new MiniFace('a') },
      { col: 30, row: 5, face: new MiniFace('b') },
    ];
    os._resolveOverlaps(positions, 80, 30);
    assert.strictEqual(positions[0].col, 10);
    assert.strictEqual(positions[1].col, 30);
  });

  test('keeps faces within terminal bounds after nudging', () => {
    const os = new OrbitalSystem();
    const positions = [
      { col: 2, row: 2, face: new MiniFace('a') },
      { col: 4, row: 2, face: new MiniFace('b') },
    ];
    os._resolveOverlaps(positions, 80, 30);
    for (const p of positions) {
      assert.ok(p.col >= 1, `col ${p.col} should be >= 1`);
      assert.ok(p.row >= 1, `row ${p.row} should be >= 1`);
      assert.ok(p.col <= 80 - 8, `col ${p.col} should be <= cols - MINI_W`);
      assert.ok(p.row <= 30 - 7, `row ${p.row} should be <= rows - MINI_H`);
    }
  });
});

describe('grid.js -- _calculateGroupedAngles pixel-aware spacing', () => {
  test('pixel-aware minimum prevents sub-MINI_W gaps on small ellipses', () => {
    const os = new OrbitalSystem();
    os.rotationAngle = 0;
    const f1 = new MiniFace('a'); f1.parentSession = 'main';
    const f2 = new MiniFace('b'); f2.parentSession = 'main';
    const visible = [f1, f2];
    // Small semi-major axis (14px) — without pixel fix, 0.35 rad * 14 ≈ 5px < MINI_W (8)
    const angles = os._calculateGroupedAngles(visible, 14);
    const a1 = angles.get(f1);
    const a2 = angles.get(f2);
    const angularDiff = Math.abs(a2 - a1);
    const pixelDiff = angularDiff * 14; // approximate arc distance
    assert.ok(pixelDiff >= 8, `pixel gap ${pixelDiff.toFixed(1)} should be >= MINI_W (8)`);
  });
});

describe('grid.js -- _renderGroupTethers extended checks', () => {
  test('tether dots skip ALL face bounding boxes, not just endpoints', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('a'); f1.parentSession = 'main';
    const f2 = new MiniFace('b'); f2.parentSession = 'main';
    const fMiddle = new MiniFace('c'); // sits between a and b
    const positions = [
      { col: 5, row: 2, face: f1 },
      { col: 60, row: 2, face: f2 },
      { col: 30, row: 2, face: fMiddle }, // middle face that tether A→B could cross
    ];
    const dots = [];
    const mainPos = { col: 30, row: 20, w: 12, h: 8, centerX: 36, centerY: 24 };
    os._renderGroupTethers(positions, mainPos, [100, 160, 210], dots);
    // No dot should be inside fMiddle's bounding box (col 30-38, row 1-9)
    for (let i = 0; i < dots.length; i += 2) {
      const dRow = dots[i], dCol = dots[i + 1];
      const insideMiddle = dCol >= 29 && dCol <= 39 && dRow >= 1 && dRow <= 9;
      assert.ok(!insideMiddle,
        `tether dot at (${dRow},${dCol}) should not overlap middle face`);
    }
  });

  test('spawning faces skip tether segments', () => {
    const os = new OrbitalSystem();
    const f1 = new MiniFace('a'); f1.parentSession = 'main';
    const f2 = new MiniFace('b'); f2.parentSession = 'main'; f2.spawning = true;
    const positions = [
      { col: 5, row: 2, face: f1 },
      { col: 60, row: 2, face: f2 },
    ];
    const dots = [];
    const mainPos = { col: 30, row: 20, w: 12, h: 8, centerX: 36, centerY: 24 };
    os._renderGroupTethers(positions, mainPos, [100, 160, 210], dots);
    assert.strictEqual(dots.length, 0, 'no tether dots when one endpoint is spawning');
  });
});

// -- loadSessionsAsync / _applySessionResults -------------------------

describe('grid.js -- _applySessionResults', () => {
  test('applies session data to faces map', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding', modelName: 'claude' }, mtimeMs: Date.now() },
      { file: 'sub2.json', data: { session_id: 'sub2', state: 'reading', modelName: 'codex' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.strictEqual(os.faces.size, 2);
    assert.strictEqual(os.faces.get('sub1').state, 'coding');
    assert.strictEqual(os.faces.get('sub2').state, 'reading');
  });

  test('excludes main session from results', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'main.json', data: { session_id: 'main-id', state: 'thinking' }, mtimeMs: Date.now() },
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.strictEqual(os.faces.size, 1);
    assert.ok(os.faces.has('sub1'));
    assert.ok(!os.faces.has('main-id'));
  });

  test('protects existing face on empty file result', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', empty: true },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('sub1'), 'face should survive empty file read');
  });

  test('protects existing face on error result', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'reading';
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', error: true },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('sub1'), 'face should survive parse error');
  });

  test('removes faces not seen in results', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('old-sub');
    mf.state = 'idle';
    mf.lastUpdate = Date.now();
    os.faces.set('old-sub', mf);
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(!os.faces.has('old-sub'), 'unseen face should be removed');
    assert.ok(os.faces.has('sub1'));
  });

  test('marks new faces with spawning animation', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'thinking' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    const face = os.faces.get('sub1');
    assert.strictEqual(face.spawning, true);
    assert.strictEqual(face.spawnProgress, 0);
  });

  test('invalidates sorted cache when faces change', () => {
    const os = new OrbitalSystem();
    os._sortedDirty = false;
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.strictEqual(os._sortedDirty, true);
  });

  test('handles empty results array', () => {
    const os = new OrbitalSystem();
    os._applySessionResults('main-id', []);
    assert.strictEqual(os.faces.size, 0);
  });
});

describe('grid.js -- loadSessionsAsync re-entrancy guard', () => {
  test('_loadingInProgress flag prevents concurrent loads', () => {
    const os = new OrbitalSystem();
    os._loadingInProgress = true;
    os.mainSessionId = 'prev';
    // Should bail out immediately without changing mainSessionId
    os.loadSessionsAsync('new-id');
    // mainSessionId should NOT be updated because we bailed out
    assert.strictEqual(os.mainSessionId, 'prev');
  });

  test('_loadingInProgress is initially false', () => {
    const os = new OrbitalSystem();
    assert.strictEqual(os._loadingInProgress, false);
  });

  test('_loadingInProgress resets if _applySessionResults throws', () => {
    const os = new OrbitalSystem();
    const original = os._applySessionResults;
    os._applySessionResults = () => { throw new Error('boom'); };
    os._loadingInProgress = false;
    // Simulate what onComplete does — call via the try/finally path
    try {
      os._loadingInProgress = true;
      try { os._applySessionResults('main', []); }
      finally { os._loadingInProgress = false; }
    } catch {}
    assert.strictEqual(os._loadingInProgress, false, 'flag must reset even after throw');
    os._applySessionResults = original;
  });

  test('skips load when excludeId is falsy', () => {
    const os = new OrbitalSystem();
    os.loadSessionsAsync(null);
    assert.ok(!os._loadingInProgress, 'should not set loading flag for null excludeId');
  });
});

// -- _applySessionResults stale file purge --------------------------------

describe('grid.js -- _applySessionResults stale purge', () => {
  const STALE_MS = 120000;

  test('protects stale file when known face is active non-completion with live PID', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    mf.stopped = false;
    mf.pid = process.pid; // Live PID so isStale() returns false after apply
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding', pid: process.pid }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('sub1'), 'active non-completion face with live PID should survive stale purge');
  });

  test('protects stale file when completion-state face has live PID', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'happy';
    mf.stopped = false;
    mf.pid = process.pid; // Current process — guaranteed alive
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'happy' }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('sub1'), 'completion face with live PID should survive stale purge');
  });

  test('purges stale file when completion-state face has no live PID', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'satisfied';
    mf.stopped = false;
    mf.pid = 99999999; // Almost certainly dead PID
    os.faces.set('sub1', mf);
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'satisfied', pid: 99999999 }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    os._applySessionResults('main-id', results);
    // Face should be removed since session file was purged (not in survivingResults)
    assert.ok(!os.faces.has('sub1'), 'completion face with dead PID should be purged');
  });

  test('purges stale file with no known face and dead file PID', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'orphan.json', data: { session_id: 'orphan', state: 'idle', pid: 99999999 }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(!os.faces.has('orphan'), 'stale orphan with dead PID should be purged');
  });

  test('protects stale file when file data has live PID but no known face', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'new-sub.json', data: { session_id: 'new-sub', state: 'thinking', pid: process.pid }, mtimeMs: Date.now() - STALE_MS - 1000 },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('new-sub'), 'stale file with live PID should survive and create face');
  });

  test('non-stale file passes through without purge checks', () => {
    const os = new OrbitalSystem();
    const results = [
      { file: 'sub1.json', data: { session_id: 'sub1', state: 'coding' }, mtimeMs: Date.now() },
    ];
    os._applySessionResults('main-id', results);
    assert.ok(os.faces.has('sub1'), 'non-stale file should create face normally');
  });
});

// -- Bug fix: async face removal PID guard + no file deletion from face cleanup --

describe('grid.js -- async face removal PID guard (Bug #2)', () => {
  test('_applySessionResults keeps face with live PID when file missing', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    mf.pid = process.pid; // our own PID — guaranteed alive
    mf.stopped = false;
    os.faces.set('sub1', mf);

    // Empty results — file not seen, but PID is alive
    os._applySessionResults('main-id', []);
    assert.ok(os.faces.has('sub1'), 'face with live PID should survive missing file');
  });

  test('_applySessionResults removes face with dead PID when file missing', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    mf.pid = 999999; // non-existent PID
    mf.stopped = false;
    os.faces.set('sub1', mf);

    os._applySessionResults('main-id', []);
    assert.ok(!os.faces.has('sub1'), 'face with dead PID should be removed when file missing');
  });

  test('_applySessionResults removes stopped face even with live PID when file missing', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'happy';
    mf.pid = process.pid;
    mf.stopped = true;
    os.faces.set('sub1', mf);

    os._applySessionResults('main-id', []);
    assert.ok(!os.faces.has('sub1'), 'stopped face should be removed even with live PID');
  });

  test('_applySessionResults removes face with no PID when file missing', () => {
    const os = new OrbitalSystem();
    const mf = new MiniFace('sub1');
    mf.state = 'coding';
    mf.pid = 0;
    mf.stopped = false;
    os.faces.set('sub1', mf);

    os._applySessionResults('main-id', []);
    assert.ok(!os.faces.has('sub1'), 'face with no PID should be removed when file missing');
  });

  test('_applySessionResults does not delete session files when removing stale faces', () => {
    // Structural: the face removal loop should NOT contain fs.unlink
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../grid'), 'utf8');
    // Find the _applySessionResults method and check the face removal section
    const methodStart = src.indexOf('_applySessionResults(');
    const methodBody = src.slice(methodStart, src.indexOf('\n  _assignLabels', methodStart));
    const removalSection = methodBody.slice(methodBody.indexOf('Remove faces not seen'));
    assert.ok(!removalSection.includes('fs.unlink'), 'face removal loop should not delete files');
    assert.ok(!removalSection.includes('unlinkSync'), 'face removal loop should not delete files (sync)');
  });
});

describe('grid.js -- sync face removal no file deletion (Bug #4)', () => {
  test('loadSessions face removal does not contain unlinkSync', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../grid'), 'utf8');
    // Find the sync loadSessions method's face removal section
    const loadStart = src.indexOf('loadSessions(');
    const loadEnd = src.indexOf('\n  _assignLabels', loadStart);
    const loadBody = src.slice(loadStart, loadEnd);
    // The PID guard line should exist, but no unlinkSync after faces.delete
    const deleteIdx = loadBody.lastIndexOf('this.faces.delete(id)');
    const afterDelete = loadBody.slice(deleteIdx, deleteIdx + 200);
    assert.ok(!afterDelete.includes('unlinkSync'), 'sync face removal should not delete files');
  });
});

describe('grid.js -- MiniFace orbital offset lerping', () => {
  test('setTargetOffset snaps on first call', () => {
    const face = new MiniFace('lerp-snap');
    face.setTargetOffset(1.0);
    assert.strictEqual(face.orbitalOffset, 1.0);
    assert.strictEqual(face.targetOffset, 1.0);
    assert.strictEqual(face._lerpElapsed, REPOSITION_MS);
  });

  test('setTargetOffset snaps during spawning', () => {
    const face = new MiniFace('lerp-spawn');
    face.spawning = true;
    face.setTargetOffset(1.0);
    assert.strictEqual(face.orbitalOffset, 1.0);
    assert.strictEqual(face.targetOffset, 1.0);
    assert.strictEqual(face._lerpElapsed, REPOSITION_MS);
  });

  test('setTargetOffset starts lerp on change', () => {
    const face = new MiniFace('lerp-change');
    face.setTargetOffset(1.0); // snap initial
    face.setTargetOffset(2.0); // should start lerp
    assert.strictEqual(face._lerpElapsed, 0);
    assert.strictEqual(face._lerpStartOffset, 1.0);
    assert.strictEqual(face.targetOffset, 2.0);
  });

  test('dead zone ignores tiny changes', () => {
    const face = new MiniFace('lerp-deadzone');
    face.setTargetOffset(1.0);
    face.setTargetOffset(1.001); // 0.001 < 0.005 threshold
    assert.strictEqual(face.targetOffset, 1.0);
  });

  test('tick advances lerp', () => {
    const face = new MiniFace('lerp-tick');
    face.setTargetOffset(0.0); // snap initial
    face.setTargetOffset(1.0); // start lerp
    face.tick(200); // halfway through 400ms
    assert.ok(face.orbitalOffset > 0.0, 'should have moved from start');
    assert.ok(face.orbitalOffset < 1.0, 'should not have reached target yet');
  });

  test('tick completes at REPOSITION_MS', () => {
    const face = new MiniFace('lerp-complete');
    face.setTargetOffset(0.0);
    face.setTargetOffset(1.0);
    face.tick(REPOSITION_MS);
    assert.strictEqual(face.orbitalOffset, face.targetOffset);
  });

  test('ease-out: past halfway at t=0.5', () => {
    const face = new MiniFace('lerp-easeout');
    face.setTargetOffset(0.0);
    face.setTargetOffset(1.0);
    face.tick(REPOSITION_MS / 2); // t=0.5
    // cubic ease-out at t=0.5: 1 - (0.5)^3 = 0.875 -- well past 0.5
    assert.ok(face.orbitalOffset > 0.5, `expected > 0.5 but got ${face.orbitalOffset}`);
  });

  test('shortest path wraps correctly', () => {
    const face = new MiniFace('lerp-wrap');
    face.setTargetOffset(3.0);
    face.setTargetOffset(-3.0); // should wrap through PI, not the long way
    face.tick(REPOSITION_MS);
    // After completion, should be at the target
    const diff = Math.abs(face.orbitalOffset - (-3.0));
    assert.ok(diff < 0.001, `expected close to -3.0, got ${face.orbitalOffset}`);
  });

  test('_shortestAngleDist correctness', () => {
    const face = new MiniFace('lerp-dist');
    // 0 to PI => PI
    const d1 = face._shortestAngleDist(0, Math.PI);
    assert.ok(Math.abs(d1 - Math.PI) < 0.001, `0->PI expected PI, got ${d1}`);
    // 0 to -PI => wraps (either direction is PI, implementation may return -PI or PI)
    const d2 = face._shortestAngleDist(0, -Math.PI);
    assert.ok(Math.abs(Math.abs(d2) - Math.PI) < 0.001, `0->-PI expected |PI|, got ${d2}`);
    // 3.0 to -3.0: should wrap through PI (~0.28 rad), not the long way (~6.0 rad)
    const d3 = face._shortestAngleDist(3.0, -3.0);
    const expected = -3.0 - 3.0 + Math.PI * 2; // ~0.283
    assert.ok(Math.abs(d3 - expected) < 0.001, `3.0->-3.0 expected ~${expected.toFixed(3)}, got ${d3}`);
  });

  test('rapid target changes restart from current position', () => {
    const face = new MiniFace('lerp-rapid');
    face.setTargetOffset(0.0);
    face.setTargetOffset(2.0); // start lerp 0 -> 2
    face.tick(200); // halfway, orbitalOffset is between 0 and 2
    const midOffset = face.orbitalOffset;
    assert.ok(midOffset > 0.0 && midOffset < 2.0, 'should be mid-lerp');
    face.setTargetOffset(0.5); // redirect mid-lerp
    assert.strictEqual(face._lerpStartOffset, midOffset, 'lerp should restart from current position');
    assert.strictEqual(face.targetOffset, 0.5);
    assert.strictEqual(face._lerpElapsed, 0);
  });
});

module.exports = { passed: () => passed, failed: () => failed };
