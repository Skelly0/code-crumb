'use strict';

// +================================================================+
// |  Themes, colors, ANSI codes, and thought bubble data            |
// |  Pure data and small utility functions used by all renderers     |
// +================================================================+

// -- ANSI ----------------------------------------------------------
const CSI = '\x1b[';
const ansi = {
  reset:      `${CSI}0m`,
  bold:       `${CSI}1m`,
  dim:        `${CSI}2m`,
  italic:     `${CSI}3m`,
  hide:       `${CSI}?25l`,
  show:       `${CSI}?25h`,
  clear:      `${CSI}2J${CSI}H`,
  home:       `${CSI}H`,
  to:         (r, c) => `${CSI}${r};${c}H`,
  fg:         (r, g, b) => `${CSI}38;2;${r};${g};${b}m`,
  bg:         (r, g, b) => `${CSI}48;2;${r};${g};${b}m`,
  clearLine:  `${CSI}2K`,
  clearBelow: `${CSI}J`,
};

// -- Color math ----------------------------------------------------
const BREATH_PERIOD = 4000;

function lerpColor(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function dimColor(color, factor) {
  return color.map(c => Math.round(c * factor));
}

function breathe(color, time) {
  const t = (Math.sin(time * Math.PI * 2 / BREATH_PERIOD) + 1) / 2;
  const factor = 0.65 + t * 0.35;
  return dimColor(color, factor);
}

// -- Themes --------------------------------------------------------
const themes = {
  idle: {
    border: [100,160,210], eye: [180,220,255], mouth: [140,190,230],
    accent: [80,130,180], label: [120,170,210], status: 'idle', emoji: '\u00b7',
  },
  thinking: {
    border: [170,110,220], eye: [210,180,255], mouth: [160,120,200],
    accent: [200,140,255], label: [180,130,230], status: 'thinking', emoji: '\u25c6',
  },
  coding: {
    border: [70,190,110], eye: [150,240,180], mouth: [100,200,140],
    accent: [90,210,130], label: [80,200,120], status: 'writing code', emoji: '\u25aa',
  },
  reading: {
    border: [100,180,180], eye: [160,220,220], mouth: [120,190,190],
    accent: [80,200,200], label: [110,190,190], status: 'reading', emoji: '\u25cb',
  },
  searching: {
    border: [210,190,70], eye: [250,240,150], mouth: [200,180,90],
    accent: [230,210,100], label: [220,200,80], status: 'searching', emoji: '\u25c7',
  },
  executing: {
    border: [210,150,70], eye: [250,210,150], mouth: [200,160,100],
    accent: [230,170,90], label: [220,160,80], status: 'running command', emoji: '\u25b8',
  },
  happy: {
    border: [220,200,60], eye: [255,250,150], mouth: [230,210,90],
    accent: [255,240,100], label: [240,220,80], status: 'done!', emoji: '\u2726',
  },
  satisfied: {
    border: [90,180,150], eye: [150,220,200], mouth: [120,200,170],
    accent: [110,200,180], label: [100,190,160], status: 'satisfied', emoji: '\u2218',
  },
  proud: {
    border: [130,200,80], eye: [190,240,140], mouth: [150,210,100],
    accent: [170,230,110], label: [150,220,90], status: 'proud', emoji: '\u25b8',
  },
  relieved: {
    border: [190,170,110], eye: [230,220,170], mouth: [210,190,140],
    accent: [220,200,140], label: [200,190,130], status: 'relieved', emoji: '\u25cb',
  },
  error: {
    border: [210,70,70], eye: [255,150,150], mouth: [200,100,100],
    accent: [230,90,90], label: [220,90,90], status: 'hit a snag', emoji: '\u00d7',
  },
  sleeping: {
    border: [60,50,110], eye: [90,80,150], mouth: [70,60,120],
    accent: [110,90,170], label: [80,70,140], status: 'sleeping', emoji: 'z',
  },
  waiting: {
    border: [150,140,180], eye: [190,180,220], mouth: [160,150,190],
    accent: [180,170,210], label: [160,150,190], status: 'waiting', emoji: '?',
  },
  testing: {
    border: [180,200,70], eye: [220,240,130], mouth: [190,210,100],
    accent: [200,220,90], label: [190,210,80], status: 'running tests', emoji: '\u29eb',
  },
  installing: {
    border: [70,160,190], eye: [130,200,230], mouth: [100,170,200],
    accent: [90,180,210], label: [80,170,200], status: 'installing', emoji: '\u25bc',
  },
  caffeinated: {
    border: [255,180,50], eye: [255,220,100], mouth: [240,190,70],
    accent: [255,200,80], label: [250,190,60], status: 'hyperdrive!', emoji: '\u25c9',
  },
  subagent: {
    border: [150,100,210], eye: [190,160,240], mouth: [140,110,200],
    accent: [180,130,230], label: [160,120,220], status: 'spawning', emoji: '\u25c8',
  },
};

// -- Timeline colors -----------------------------------------------
const TIMELINE_COLORS = {
  idle:        [60, 70, 80],
  thinking:    [140, 90, 180],
  coding:      [60, 160, 90],
  reading:     [80, 150, 150],
  searching:   [180, 160, 50],
  executing:   [180, 130, 50],
  happy:       [190, 170, 40],
  satisfied:   [90, 180, 150],
  proud:       [130, 200, 80],
  relieved:    [190, 170, 110],
  error:       [190, 50, 50],
  sleeping:    [40, 35, 80],
  waiting:     [120, 110, 150],
  testing:     [150, 170, 50],
  installing:  [50, 130, 160],
  caffeinated: [220, 150, 30],
  subagent:    [120, 80, 180],
};

// -- Sparkline blocks (activity density) ---------------------------
const SPARKLINE_BLOCKS = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587';

// -- Completion linger times ---------------------------------------
const COMPLETION_LINGER = {
  happy: 8000,
  proud: 7000,
  satisfied: 5500,
  relieved: 6000,
};

// -- Thought bubbles -----------------------------------------------
const IDLE_THOUGHTS = [
  'thinking about types',
  'contemplating recursion',
  'wondering about edge cases',
  'refactoring dreams',
  'pondering abstractions',
  'imagining clean code',
  'considering the void',
  'counting semicolons',
  'mapping dependencies',
  'tracing call stacks',
  'optimizing nothing',
  'cataloguing lint warnings',
];
const THINKING_THOUGHTS = [
  'hmm...', 'what if...', 'let me think...',
  'almost there...', 'connecting dots', 'following a thread',
  'one sec...', 'untangling this',
];
const COMPLETION_THOUGHTS = [
  'nice', 'good', 'clean', 'got it', 'smooth',
  'okay', 'that worked', 'moving on', 'next...',
];

// Per-state reactive thoughts -- personality, not status
const STATE_THOUGHTS = {
  coding: [
    'refactoring this...', 'let me fix this', 'almost there...',
    'one more edit', 'cleaning this up', 'this should work',
    'restructuring...', 'tweaking...', 'here we go',
  ],
  reading: [
    'let me see...', 'hmm interesting', 'checking this out',
    'scanning through', 'ah I see...', 'okay okay...',
    'taking notes...', 'absorbing this',
  ],
  searching: [
    'where is it...', 'gotta be somewhere', 'looking around...',
    'digging through', 'hunting...', 'let me find this',
    'scanning...', 'it must be here',
  ],
  executing: [
    'let\'s see...', 'running this...', 'here goes...',
    'fingers crossed', 'moment of truth', 'let me try this',
  ],
  testing: [
    'please pass...', 'moment of truth', 'sweating a bit',
    'come on...', 'hope this works', 'deep breath...',
  ],
  installing: [
    'downloading...', 'pulling deps', 'this might take a sec',
    'loading up...', 'grabbing packages', 'patience...',
  ],
  subagent: [
    'delegating this', 'sending a helper', 'teamwork...',
    'splitting the work', 'parallel vibes', 'tag team',
  ],
  error: [
    'ugh', 'wait what', 'hmm not right',
    'okay let me think', 'well that broke', 'debugging time',
  ],
};

module.exports = {
  ansi,
  BREATH_PERIOD,
  lerpColor,
  dimColor,
  breathe,
  themes,
  TIMELINE_COLORS,
  SPARKLINE_BLOCKS,
  COMPLETION_LINGER,
  IDLE_THOUGHTS,
  THINKING_THOUGHTS,
  COMPLETION_THOUGHTS,
  STATE_THOUGHTS,
};
