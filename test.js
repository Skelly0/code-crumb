#!/usr/bin/env node
'use strict';

// +================================================================+
// |  Code Crumb Test Suite                                             |
// |  Zero-dependency tests using Node.js built-in assert              |
// |                                                                  |
// |  Run: node test.js  or  npm test                                |
// +================================================================+

const testModules = [
  './tests/test-shared.js',
  './tests/test-state-machine.js',
  './tests/test-themes.js',
  './tests/test-animations.js',
  './tests/test-particles.js',
  './tests/test-face.js',
  './tests/test-grid.js',
  './tests/test-accessories.js',
  './tests/test-teams.js',
];

let totalPassed = 0;
let totalFailed = 0;

console.log('\n  Code Crumb Test Suite');
console.log('  ' + '='.repeat(40));

for (const modulePath of testModules) {
  const module = require(modulePath);
  totalPassed += module.passed();
  totalFailed += module.failed();
}

console.log(`\n  ${'='.repeat(40)}`);
if (totalFailed === 0) {
  console.log(`  \x1b[32mAll ${totalPassed} tests passed\x1b[0m`);
} else {
  console.log(`  \x1b[31m${totalFailed} failed\x1b[0m, ${totalPassed} passed`);
}
console.log(`  ${'='.repeat(40)}\n`);

process.exit(totalFailed > 0 ? 1 : 0);
