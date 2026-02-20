'use strict';

// +================================================================+
// |  Accessories -- hats, glasses, and other face adornments        |
// |  Small ASCII art layered above the face, one per state          |
// |  Toggle with 'a' key. State-specific: hard hat for installing,  |
// |  reading glasses for reading, party hat for happy, etc.         |
// +================================================================+

// Each accessory: { lines: string[] }
// lines[0] is topmost, lines[last] is closest to the face border.
// Lines are centered horizontally on the face at render time.

const ACCESSORIES = {
  hardhat: {
    lines: [
      '    \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2557    ',
      '  \u2554\u2550\u255d\u2592\u2592\u2592\u2592\u2592\u2592\u2558\u2550\u2557  ',
      '  \u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551  ',
      '\u2550\u2550\u2569\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2569\u2550\u2550',
    ],
  },
  glasses: {
    lines: [
      '\u256d\u2500\u2500\u2500\u2500\u2500\u256e \u256d\u2500\u2500\u2500\u2500\u2500\u256e',
      '\u2502 (\u25ce) \u251c\u2500\u2524 (\u25ce) \u2502',
      '\u2570\u2500\u2500\u2500\u2500\u2500\u256f \u2570\u2500\u2500\u2500\u2500\u2500\u256f',
    ],
  },
  wizardhat: {
    lines: [
      '      \u2605      ',
      '     \u2571 \u2572     ',
      '    \u2571 \u25c7 \u2572    ',
      '   \u2571\u2591\u2591\u2591\u2591\u2591\u2572   ',
      '  \u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580  ',
    ],
  },
  catears: {
    lines: [
      '  \u2571\u2572        \u2571\u2572  ',
      ' \u2571  \u2572      \u2571  \u2572 ',
    ],
  },
  partyhat: {
    lines: [
      '      \u25c6      ',
      '     \u2571\u2592\u2572     ',
      '    \u2571\u2592\u2592\u2592\u2572    ',
      '   \u2571\u2592\u2592\u2592\u2592\u2592\u2572   ',
      '  \u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580  ',
    ],
  },
  nightcap: {
    lines: [
      '         \u25ef    ',
      '    \u256d\u2500\u2500\u2500\u2500\u256f    ',
      '   \u2571 z Z z \u2572  ',
      '  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256f ',
    ],
  },
  detective: {
    lines: [
      '    \u2584\u2588\u2588\u2588\u2588\u2588\u2588\u2584    ',
      '   \u2588\u2588\u2593\u2593\u2593\u2593\u2593\u2593\u2588\u2588   ',
      '   \u2580\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2580   ',
      '\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580',
    ],
  },
  shades: {
    lines: [
      '\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u256e\u256d\u2500\u2500\u2500\u2500\u2500\u2500\u256e',
      '\u2502 \u2593\u2593\u2593\u2593 \u251c\u2524 \u2593\u2593\u2593\u2593 \u2502',
      '\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u256f',
    ],
  },
  crown: {
    lines: [
      '  \u25c6  \u25c6  \u25c6  \u25c6',
      '  \u2560\u2550\u2550\u256c\u2550\u2550\u256c\u2550\u2550\u2563',
      '  \u2551\u25c7 \u25c7 \u25c7 \u25c7 \u2551',
      '  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d',
    ],
  },
  antenna: {
    lines: [
      '      \u25c9      ',
      '     \u2571\u2502\u2572     ',
      '    \u2571 \u2502 \u2572    ',
      '  \u2500\u2500\u2534\u2500\u2500\u2500\u2534\u2500\u2500  ',
    ],
  },
  goggles: {
    lines: [
      '\u256d\u2550\u2550\u2550\u2550\u2550\u2550\u256e\u256d\u2550\u2550\u2550\u2550\u2550\u2550\u256e',
      '\u2551 (\u25ce)  \u2560\u2563  (\u25ce) \u2551',
      '\u2570\u2550\u2550\u2550\u2550\u2550\u2550\u256f\u2570\u2550\u2550\u2550\u2550\u2550\u2550\u256f',
    ],
  },
  caution: {
    lines: [
      '      \u2571\u2572      ',
      '     \u2571  \u2572     ',
      '    \u2571 !! \u2572    ',
      '   \u2571\u2500\u2500\u2500\u2500\u2500\u2500\u2572   ',
    ],
  },
  gitpush: {
    lines: [
      '  \u2191  \u2191  \u2191  ',
      '\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
      '\u2551 commit! \u2551',
      '\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d',
    ],
  },
};

// -- State-to-accessory mapping ------------------------------------
// Maps face states to accessory names. States not listed show no accessory.

const STATE_ACCESSORIES = {
  installing:  'hardhat',
  thinking:    'wizardhat',
  coding:      'catears',
  happy:       'partyhat',
  sleeping:    'nightcap',
  searching:   'detective',
  caffeinated: 'shades',
  proud:       'crown',
  subagent:    'antenna',
  testing:     'goggles',
  error:       'caution',
  committing:  'gitpush',
};

// -- Lookup --------------------------------------------------------

function getAccessory(state) {
  const name = STATE_ACCESSORIES[state];
  if (!name) return null;
  return ACCESSORIES[name] || null;
}

module.exports = { ACCESSORIES, STATE_ACCESSORIES, getAccessory };
