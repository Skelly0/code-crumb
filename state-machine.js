'use strict';

// +================================================================+
// |  State Machine -- pure logic for Code Crumb state management         |
// |  Extracted for testability. No I/O, no side effects.            |
// |                                                                  |
// |  Handles:                                                        |
// |    - Tool name → face state mapping (multi-editor)              |
// |    - Forensic error detection (50+ regex patterns)               |
// |    - Post-tool result classification                             |
// |    - Streak tracking and milestone detection                     |
// |                                                                  |
// |  Supported editors:                                              |
// |    - Claude Code (edit, bash, grep, glob, read, task, etc.)     |
// |    - OpenAI Codex CLI (shell, apply_diff, apply_patch, etc.)    |
// |    - OpenCode (file_edit, terminal, search_files, etc.)         |
// |    - OpenClaw/Pi (read, write, edit, bash, exec, process, etc.) |
// +================================================================+

const path = require('path');

// -- Tool-to-State Mapping -------------------------------------------

// Tool name patterns per category — covers Claude Code, Codex CLI, OpenCode, and OpenClaw/Pi
const EDIT_TOOLS = /^(edit|multiedit|write|str_replace|create_file|file_edit|write_file|create_file_with_contents|apply_diff|apply_patch|code_edit|insert_text|replace_text|patch)$/i;
const BASH_TOOLS = /^(bash|shell|terminal|execute|run_command|run|exec|process|sh|cmd|powershell|command|cli)$/i;
const READ_TOOLS = /^(read|view|cat|file_read|read_file|get_file_contents|open_file)$/i;
const SEARCH_TOOLS = /^(grep|glob|search|ripgrep|find|list|search_files|list_files|list_dir|find_files|file_search|codebase_search)$/i;
const WEB_TOOLS = /^(web_search|web_fetch|fetch|webfetch|browser|browse|http_request|curl|canvas)$/i;
const SUBAGENT_TOOLS = /^(task|subagent|spawn_agent|delegate|codex_agent|sessions)$/i;
const REVIEW_TOOLS = /diff|review|compare|patch/i;

function toolToState(toolName, toolInput) {
  // Writing/editing code
  if (EDIT_TOOLS.test(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
    const shortPath = filePath ? path.basename(filePath) : '';
    return { state: 'coding', detail: shortPath ? `editing ${shortPath}` : 'writing code' };
  }

  // Running commands
  if (BASH_TOOLS.test(toolName)) {
    const cmd = toolInput?.command || toolInput?.cmd || toolInput?.input || '';
    const shortCmd = cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;

    // Detect test commands
    if (/\b(jest|pytest|vitest|mocha|cypress|playwright|\.test\.|\.spec\.)\b/i.test(cmd) ||
        /\b(npm|yarn|pnpm|bun|go|cargo|dotnet)\s+(run\s+)?(test|tests)\b/i.test(cmd) ||
        /\b(rake|npx|composer)\s+test\b/i.test(cmd) ||
        /\b(pytest|nosetests)\b/i.test(cmd) ||
        /\bnode\s+(--test|test)\b/i.test(cmd) ||
        /\b(make|gradle|mvn|php\s+artisan)\s+test\b/i.test(cmd)) {
      return { state: 'testing', detail: shortCmd || 'running tests' };
    }

    // Detect install commands
    if (/\b(npm|yarn|pnpm|bun)\s+(install|i|add)\b/i.test(cmd) ||
        /\b(pip|pip3)\s+(install|-r)\b/i.test(cmd) ||
        /\b(cargo\s+build|cargo\s+add)\b/i.test(cmd) ||
        /\b(apt|apt-get|apk)\s+(install|add)\b/i.test(cmd) ||
        /\b(brew\s+install|homebrew)\b/i.test(cmd) ||
        /\b(go\s+get|go\s+install)\b/i.test(cmd) ||
        /\b(composer\s+require|composer\s+install)\b/i.test(cmd) ||
        /\b(dotnet\s+add|dotnet\s+restore)\b/i.test(cmd)) {
      return { state: 'installing', detail: shortCmd || 'installing' };
    }

    // Detect git commit / push / tag operations
    if (/\bgit\s+(commit|push|tag)\b/i.test(cmd)) {
      const isPush = /\bgit\s+push\b/i.test(cmd);
      const isTag  = /\bgit\s+tag\b/i.test(cmd);
      const detail = isPush ? 'pushing to remote' : isTag ? 'tagging release' : 'committing changes';
      return { state: 'committing', detail: shortCmd || detail };
    }

    return { state: 'executing', detail: shortCmd || 'running command' };
  }

  // Reviewing / diffing code
  if (REVIEW_TOOLS.test(toolName)) {
    return { state: 'reviewing', detail: toolName || 'reviewing' };
  }

  // Reading files
  if (READ_TOOLS.test(toolName)) {
    const filePath = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
    const shortPath = filePath ? path.basename(filePath) : '';
    return { state: 'reading', detail: shortPath ? `reading ${shortPath}` : 'reading' };
  }

  // Searching
  if (SEARCH_TOOLS.test(toolName)) {
    const pattern = toolInput?.pattern || toolInput?.query || toolInput?.search_term || '';
    return { state: 'searching', detail: pattern ? `looking for "${pattern}"` : 'searching' };
  }

  // Web/fetch
  if (WEB_TOOLS.test(toolName)) {
    const query = toolInput?.query || toolInput?.url || '';
    const shortQuery = query.length > 30 ? query.slice(0, 27) + '...' : query;
    return { state: 'searching', detail: shortQuery ? `searching "${shortQuery}"` : 'searching the web' };
  }

  // Task/subagent
  if (SUBAGENT_TOOLS.test(toolName)) {
    const desc = toolInput?.description || toolInput?.prompt || '';
    const shortDesc = desc.length > 30 ? desc.slice(0, 27) + '...' : desc;
    return { state: 'subagent', detail: shortDesc || 'spawning subagent' };
  }

  // MCP tools
  if (/^mcp__/.test(toolName)) {
    const parts = toolName.split('__');
    const server = parts[1] || 'external';
    const tool = parts[2] || '';
    return { state: 'executing', detail: `${server}: ${tool}` };
  }

  // Default
  return { state: 'thinking', detail: toolName || '' };
}

// -- Error Detection -------------------------------------------------

// Signature patterns that scream "something broke" in stdout
const stdoutErrorPatterns = [
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bpermission denied\b/i,
  /\bsegmentation fault\b/i,
  /\bsyntax error\b/i,
  /\bENOENT\b/,
  /\bENOTDIR\b/,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /\bFATAL\b/,
  /\bPANIC\b/i,
  /\bUnhandledPromiseRejection\b/,
  /\bTraceback \(most recent call last\)/,        // Python
  /\bat Object\.<anonymous>.*\n\s+at /,           // Node stack trace
  /\bCannot find module\b/,
  /\bModuleNotFoundError\b/,
  /\bImportError\b/,
  /\bCompilation failed\b/i,
  /\bbuild failed\b/i,
  /\btest(s)? failed\b/i,
  /\bfailed with exit code\b/i,
  /\bnpm ERR!/,
  /\bcargo error\b/i,
  /\frustc.*error\[E\d+\]/,                       // Rust compiler errors
  /\bCONFLICT\b/,                                 // git merge conflicts
  /\bAutomatic merge failed\b/i,
  /\bfix conflicts and then commit\b/i,
];

// Patterns in stderr that actually mean trouble (not just warnings)
const stderrErrorPatterns = [
  /\berror\b/i,
  /\bfatal\b/i,
  /\bfailed\b/i,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bcommand not found\b/i,
  /\bpermission denied\b/i,
  /\bsegmentation fault\b/i,
  /\bpanic\b/i,
];

// False positive guards: these look scary but aren't
const falsePositives = [
  /0 errors?\b/i,
  /no errors?\b/i,
  /errors?:\s*0\b/i,
  /error handling/i,
  /error\.js/i,                                     // Just a filename
  /stderr/i,                                        // Talking about stderr
  /\.error\s*[=(]/,                                 // Property/method named error
  /error_count.*0/i,
  /warning/i,                                       // warnings aren't errors
  /no conflicts?\b/i,                               // "no conflicts" isn't a conflict
];

function looksLikeError(text, patterns) {
  if (!text) return false;
  const hit = patterns.some(p => p.test(text));
  if (!hit) return false;
  // Check it's not a false positive
  return !falsePositives.some(p => p.test(text));
}

// Try to extract an exit code from stdout -- Claude Code often
// appends "Exit code: N" to the output even though it doesn't
// give us exit_code as a field.
function extractExitCode(stdout) {
  const match = stdout.match(/(?:exit code|exited with|returned?)[:=\s]+(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

// Detect rate limit / usage limit / quota errors in tool output
const rateLimitPatterns = [
  /\brate.?limit/i,
  /\busage.?limit/i,
  /\btoo many requests\b/i,
  /\b429\b.*\b(error|status|rejected|failed)\b/i,   // 429 with error context
  /\b(error|status|http)\b.*\b429\b/i,               // error context before 429
  /\bquota.?exceeded\b/i,
  /\b(at|over)\s+capacity\b/i,                        // only "at capacity" / "over capacity"
  /\b(server|model|system)\s+(is\s+)?overloaded\b/i,  // only server/model/system overloaded
  /\bretry.?after\s+\d/i,                             // only "retry after" followed by a number
  /\bthrottled\b/i,                                    // only past tense (the event, not the function)
  /\bconcurrency.?limit/i,
];

// False positive guards for rate limit detection
const rateLimitFalsePositives = [
  /\bthrottle\s*[=(]/i,                                // throttle( — function call
  /\bthrottle\.js\b/i,                                 // filename
  /useThrottle/i,                                      // React hook
  /import.*throttle/i,                                 // import statement
  /require.*throttle/i,                                // require() call
  /\boverload(ed|ing)?\s+(function|method|operator)/i, // language overloading
  /\boperator\s+overload/i,                            // operator overloading
  /\bcapacity\s*(plan|test|check|monitor|report)/i,    // capacity planning
  /\b(disk|memory|storage)\s+capacity\b/i,             // hardware capacity
];

function looksLikeRateLimit(stdout, stderr) {
  const combined = (stdout || '') + (stderr || '');
  const hit = rateLimitPatterns.some(p => p.test(combined));
  if (!hit) return false;
  return !rateLimitFalsePositives.some(p => p.test(combined));
}

// Friendly error detail based on what we found
function errorDetail(stdout, stderr) {
  const combined = (stdout || '') + (stderr || '');
  if (isMergeConflict(stdout, stderr)) return 'merge conflict!';
  if (/command not found/i.test(combined)) return 'command not found';
  if (/permission denied/i.test(combined)) return 'permission denied';
  if (/no such file or directory/i.test(combined)) return 'file not found';
  if (/segmentation fault/i.test(combined)) return 'segfault!';
  if (/ENOENT/.test(combined)) return 'missing file/path';
  if (/syntax error/i.test(combined)) return 'syntax error';
  if (/Traceback|at Object\.<anonymous>|Error:/.test(stdout || '')) return 'exception thrown';
  if (/Cannot find module|ModuleNotFound/i.test(combined)) return 'missing module';
  if (/Compilation failed|build failed/i.test(combined)) return 'build broke';
  if (/test(s)? failed|\d+\s+failed/i.test(combined)) return 'tests failed';
  if (/npm ERR!/i.test(combined)) return 'npm error';
  return 'something went wrong';
}

// -- Post-Tool Classification ----------------------------------------

// Detect git merge conflicts in command output
function isMergeConflict(stdout, stderr) {
  const combined = (stdout || '') + (stderr || '');
  return /\bCONFLICT\s+\(.*\):/.test(combined) ||
         /\bAutomatic merge failed\b/i.test(combined) ||
         /\bfix conflicts and then commit\b/i.test(combined);
}

// Encapsulates the full PostToolUse decision tree.
// Returns { state, detail, diffInfo }
function classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag) {
  const stdout = toolResponse?.stdout || '';
  const stderr = toolResponse?.stderr || '';
  const isError = isErrorFlag || toolResponse?.isError || false;
  const inferredExit = extractExitCode(stdout);

  let state, detail;
  let diffInfo = null;

  // Decision tree -- in order of confidence
  // Rate limit is a refinement of error detection -- only checked when there's
  // already an error signal, to avoid false positives from file contents / search results
  const isRateLimited = looksLikeRateLimit(stdout, stderr);

  if (isError) {
    if (isRateLimited) { state = 'ratelimited'; detail = 'usage limit'; }
    else { state = 'error'; detail = errorDetail(stdout, stderr); }
  } else if (toolResponse?.interrupted) {
    state = 'error';
    detail = 'interrupted';
  } else if (inferredExit !== null && inferredExit !== 0) {
    if (isRateLimited) { state = 'ratelimited'; detail = 'usage limit'; }
    else { state = 'error'; detail = errorDetail(stdout, stderr) || `exit ${inferredExit}`; }
  } else if (looksLikeError(stderr, stderrErrorPatterns)) {
    if (isRateLimited) { state = 'ratelimited'; detail = 'usage limit'; }
    else { state = 'error'; detail = errorDetail(stdout, stderr); }
  } else if (BASH_TOOLS.test(toolName) && looksLikeError(stdout, stdoutErrorPatterns)) {
    // Only check stdout patterns for shell commands -- other tools have structured output
    if (isRateLimited) { state = 'ratelimited'; detail = 'usage limit'; }
    else { state = 'error'; detail = errorDetail(stdout, stderr); }
  } else if (EDIT_TOOLS.test(toolName)) {
    state = 'proud';
    const fp = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
    detail = fp ? `saved ${path.basename(fp)}` : 'code written';
    // Calculate diff info for thought bubbles
    const oldStr = toolInput?.old_string || toolInput?.old_str || '';
    const newStr = toolInput?.new_string || toolInput?.new_str || toolInput?.content || '';
    if (oldStr || newStr) {
      const removed = oldStr ? oldStr.split('\n').length : 0;
      const added = newStr ? newStr.split('\n').length : 0;
      diffInfo = { added, removed };
    }
  } else if (READ_TOOLS.test(toolName)) {
    state = 'satisfied';
    const fp = toolInput?.file_path || toolInput?.path || toolInput?.target_file || '';
    detail = fp ? `read ${path.basename(fp)}` : 'got it';
  } else if (SEARCH_TOOLS.test(toolName)) {
    state = 'satisfied';
    const pattern = toolInput?.pattern || toolInput?.query || toolInput?.search_term || '';
    detail = pattern ? `found "${pattern.length > 20 ? pattern.slice(0, 17) + '...' : pattern}"` : 'got it';
  } else if (WEB_TOOLS.test(toolName)) {
    state = 'satisfied';
    detail = 'search complete';
  } else if (BASH_TOOLS.test(toolName)) {
    state = 'relieved';
    const cmd = toolInput?.command || toolInput?.cmd || toolInput?.input || '';
    const isTest = /\b(jest|pytest|vitest|mocha|cypress|playwright|\.test\.|spec)\b/i.test(cmd) ||
                   /\bnpm\s+(run\s+)?test\b/i.test(cmd) ||
                   /\bnode\s+(--test|test)\b/i.test(cmd) ||
                   /\b(make|gradle|mvn|php\s+artisan)\s+test\b/i.test(cmd);
    const isBuild = /\b(build|compile|tsc|webpack|vite|esbuild|rollup|make)\b/i.test(cmd);
    const isGit = /\bgit\s/i.test(cmd);
    const isInstall = /\b(npm\s+install|yarn|pip\s+install|cargo\s+build|pnpm|bun\s+(add|install))\b/i.test(cmd);

    if (isTest) {
      // Try to pull test count from stdout
      const testCount = stdout.match(/(\d+)\s+(?:tests?|specs?)\s+passed/i)
                       || stdout.match(/(\d+)\s+passing/i);
      detail = testCount ? `${testCount[1]} tests passed` : 'tests passed';
    } else if (isBuild) {
      detail = 'build succeeded';
    } else if (isGit) {
      if (isMergeConflict(stdout, stderr)) {
        state = 'error';
        detail = 'merge conflict!';
      } else if (/\bgit\s+push\b/i.test(cmd)) {
        state = 'proud';
        detail = 'pushed!';
      } else if (/\bgit\s+commit\b/i.test(cmd)) {
        state = 'proud';
        detail = 'committed';
      } else if (/\bgit\s+(merge|pull|rebase)\b/i.test(cmd)) {
        state = 'satisfied';
        detail = 'merged clean';
      } else {
        detail = 'git done';
      }
    } else if (isInstall) {
      detail = 'installed';
    } else {
      detail = 'command succeeded';
    }
  } else {
    state = 'satisfied';
    detail = 'step complete';
  }

  return { state, detail, diffInfo };
}

// -- Streak Management -----------------------------------------------

const MILESTONES = [10, 25, 50, 100, 200, 500];

// Mutates and returns stats. Call after classifyToolResult.
function updateStreak(stats, isError) {
  if (isError) {
    stats.brokenStreak = stats.streak || 0;
    stats.brokenStreakAt = Date.now();
    stats.streak = 0;
    stats.totalErrors = (stats.totalErrors || 0) + 1;
  } else {
    stats.streak = (stats.streak || 0) + 1;
    if (stats.streak > (stats.bestStreak || 0)) {
      stats.bestStreak = stats.streak;
    }
    if (MILESTONES.includes(stats.streak)) {
      stats.recentMilestone = { type: 'streak', value: stats.streak, at: Date.now() };
    }
  }
  return stats;
}

// -- Default Stats ---------------------------------------------------

function defaultStats() {
  return {
    streak: 0, bestStreak: 0,
    brokenStreak: 0, brokenStreakAt: 0,
    totalToolCalls: 0, totalErrors: 0,
    records: { longestSession: 0, mostSubagents: 0, mostFilesEdited: 0 },
    session: { id: '', start: 0, toolCalls: 0, filesEdited: [], subagentCount: 0, commitCount: 0 },
    recentMilestone: null,
    daily: { date: '', sessionCount: 0, cumulativeMs: 0 },
    frequentFiles: {},
  };
}

module.exports = {
  toolToState,
  EDIT_TOOLS,
  BASH_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  WEB_TOOLS,
  SUBAGENT_TOOLS,
  REVIEW_TOOLS,
  stdoutErrorPatterns,
  stderrErrorPatterns,
  falsePositives,
  isMergeConflict,
  looksLikeError,
  looksLikeRateLimit,
  rateLimitPatterns,
  rateLimitFalsePositives,
  errorDetail,
  extractExitCode,
  classifyToolResult,
  MILESTONES,
  updateStreak,
  defaultStats,
};
