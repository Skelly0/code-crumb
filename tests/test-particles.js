#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite - particles.js                             |
// +================================================================+

const assert = require('assert');
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

describe('particles.js -- ParticleSystem', () => {
  test('starts with no particles', () => {
    const ps = new ParticleSystem();
    assert.strictEqual(ps.particles.length, 0);
  });

  test('spawn adds particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    assert.strictEqual(ps.particles.length, 5);
  });

  test('all particle styles can be spawned', () => {
    const styles = ['float', 'sparkle', 'glitch', 'orbit', 'zzz', 'question', 'sweat', 'falling', 'speedline', 'echo', 'heart', 'push'];
    for (const style of styles) {
      const ps = new ParticleSystem();
      ps.spawn(3, style);
      assert.strictEqual(ps.particles.length, 3, `spawn failed for style: ${style}`);
      for (const p of ps.particles) {
        assert.ok(typeof p.life === 'number', `particle.life missing for style: ${style}`);
        assert.ok(typeof p.char === 'string', `particle.char missing for style: ${style}`);
        assert.strictEqual(p.style, style);
      }
    }
  });

  test('update decrements particle life', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'float');
    const lifeBefore = ps.particles[0].life;
    ps.update();
    assert.strictEqual(ps.particles[0].life, lifeBefore - 1);
  });

  test('update removes dead particles', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'glitch');
    ps.particles[0].life = 1;
    ps.update();
    assert.strictEqual(ps.particles.length, 0);
  });

  test('fadeAll caps particle life', () => {
    const ps = new ParticleSystem();
    ps.spawn(5, 'float');
    ps.fadeAll(12);
    for (const p of ps.particles) {
      assert.ok(p.life <= 12);
    }
  });

  test('orbit particles move in circles', () => {
    const ps = new ParticleSystem();
    ps.spawn(1, 'orbit');
    const p = ps.particles[0];
    const angleBefore = p.angle;
    ps.update();
    assert.notStrictEqual(p.angle, angleBefore);
  });
});

module.exports = { passed: () => passed, failed: () => failed };
