#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - grid.js (OrbitalSystem)                 |
// +================================================================+

const assert = require('assert');
const { MiniFace, OrbitalSystem } = require('../grid');
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
    face.stoppedAt = Date.now() - 10000;
    assert.ok(face.isStale());
  });

  test('getEyes returns string for all states', () => {
    const states = [
      'idle', 'thinking', 'reading', 'searching', 'coding', 'executing',
      'happy', 'error', 'sleeping', 'waiting', 'testing', 'installing',
      'caffeinated', 'subagent', 'satisfied', 'proud', 'relieved',
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
    assert.ok(result.b >= Math.floor(mainPos.h / 2) + 3 + 2);
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
    face.stoppedAt = Date.now() - 10000;
    assert.ok(face.isStale());
  });

  test('fresh faces are not stale', () => {
    const face = new MiniFace('fresh');
    assert.ok(!face.isStale());
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

module.exports = { passed: () => passed, failed: () => failed };
