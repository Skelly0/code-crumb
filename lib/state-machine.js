'use strict';

// +================================================================+
// |  State Machine -- pure logic for Code Crumb state management   |
// |  Extracted for testability. No I/O, no side effects.           |
// |                                                                |
// |  Handles:                                                      |
// |    - Tool name → face state mapping (multi-editor)             |
// |    - Forensic error detection (50+ regex patterns)             |
// |    - Post-tool result classification                           |
// |    - Streak tracking and milestone detection                   |
// |                                                                |
// |  Supported editors:                                            |
// |    - Claude Code (edit, bash, grep, glob, read, task, etc.)    |
// |    - OpenAI Codex CLI (shell, apply_diff, apply_patch, etc.)   |
// |    - OpenCode (file_edit, terminal, search_files, etc.)        |
// |    - OpenClaw/Pi (read, write, edit, bash, exec, process, etc.)|
// +================================================================+

const path = require('path');

// -- Tool-to-State Mapping -------------------------------------------

// Tool name patterns per category — covers Claude Code, Codex CLI, OpenCode, and OpenClaw/Pi
const EDIT_TOOLS = /^(edit|multiedit|write|notebookedit|notebook_edit|str_replace|create_file|file_edit|write_file|create_file_with_contents|apply_diff|apply_patch|code_edit|insert_text|replace_text|patch)$/i;
const BASH_TOOLS = /^(bash|shell|terminal|execute|run_command|run|exec|process|sh|cmd|powershell|command|cli|killshell|bashoutput|enterworktree|exitworktree)$/i;
// Shell-management tools: no command text of their own, so details fall back to the humanized name
const SHELL_MGMT_TOOLS = /^(killshell|bashoutput|enterworktree|exitworktree)$/i;
const READ_TOOLS = /^(read|view|cat|file_read|read_file|get_file_contents|open_file|notebookread|readmcpresourcetool|readmcpresourcedirtool|listmcpresourcestool)$/i;
const SEARCH_TOOLS = /^(grep|glob|search|ripgrep|find|list|ls|toolsearch|search_files|list_files|list_dir|find_files|file_search|codebase_search)$/i;
const LIST_TOOLS = /^(ls|list|list_dir|list_files)$/i;
const WEB_TOOLS = /^(web_search|websearch|web_fetch|fetch|webfetch|browser|browse|http_request|curl|canvas)$/i;
const SUBAGENT_TOOLS = /^(task|agent|subagent|spawn_agent|delegate|codex_agent|sessions|workflow|sendmessage|listagents|taskoutput|taskstop|monitor)$/i;
// Subsets of SUBAGENT_TOOLS: ones whose completion means an agent finished, vs. ones that just check in
const AGENT_DONE_TOOLS = /^(task|agent|subagent|spawn_agent|delegate|codex_agent|workflow|taskoutput)$/i;
const AGENT_MONITOR_TOOLS = /^(taskoutput|taskstop|listagents|monitor)$/i;
const REVIEW_TOOLS = /^(diff|review|compare|reportfindings|code_review)$/i;
const ASK_TOOLS = /^(askuserquestion|ask_user|ask_user_question|request_user_input)$/i;
const SKILL_TOOLS = /^(skill|loadskill|load_skill)$/i;
const PLAN_TOOLS = /^(todowrite|todoread|enterplanmode|exitplanmode|croncreate|cronlist|crondelete|schedulewakeup)$/i;
const SCHEDULE_TOOLS = /^(croncreate|cronlist|crondelete|schedulewakeup)$/i;
const PUBLISH_TOOLS = /^(artifact|senduserfile)$/i;

// MCP tool verbs (mcp__<server>__<verb>_<rest>) — read-ish, search-ish, and write-ish prefixes
const MCP_READ_VERBS = /^(read|get|list|fetch|describe|inspect|check|show|view|download|export|whoami|debug)(_|$)/i;
const MCP_SEARCH_VERBS = /^(search|find|query|lookup)(_|$)/i;
const MCP_WRITE_VERBS = /^(create|update|write|modify|edit|insert|delete|remove|append|set|move|replace|format|batch|push|merge|upload|import|add|manage|resize|copy|draft)(_|$)/i;

// Coerce a tool_input field to text. Strings pass through, numbers and
// booleans stringify, and objects/arrays/null become '' — MCP inputs are
// often structured, and a non-string here used to throw inside stripAnsi.
function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

// "AskUserQuestion" -> "ask user question", "mcp__foo__bar_baz" -> "foo bar baz".
// Used wherever a tool has no better detail than its own name.
function humanizeToolName(name) {
  return toText(name)
    .replace(/^mcp__/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// mcp__<server>__<tool>. Plugin-installed servers arrive as plugin_<x>_<x>;
// collapse that to <x> so the status line reads "github: create pull request".
function splitMcpToolName(toolName) {
  const parts = toText(toolName).split('__');
  let server = (parts[1] || 'external').replace(/^plugin_/, '');
  const segs = server.split('_');
  if (segs.length === 2 && segs[0] === segs[1]) server = segs[0];
  const rawTool = parts.slice(2).join('__');
  return {
    server: server.replace(/_/g, ' '),
    tool: rawTool.replace(/[_-]/g, ' '),
    rawTool,
  };
}

function mcpVerbState(rawTool) {
  // The verb tables expect snake_case. Servers also ship kebab-case
  // (`find-tasks`) and camelCase (`getIssue`) names, which used to fall
  // through to executing; fold both into snake_case first.
  const t = toText(rawTool).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/-/g, '_');
  if (MCP_SEARCH_VERBS.test(t)) return 'searching';
  if (MCP_READ_VERBS.test(t)) return 'reading';
  if (MCP_WRITE_VERBS.test(t)) return 'coding';
  return 'executing';
}

// -- Shell Command Intent --------------------------------------------

// A shell command's arguments are data, not intent: `git commit -m "fix jest
// config"` is a commit, and `cat src/foo.test.js` is a read. Matching the
// test/build/install tables against the raw command read both as test runs,
// and a commit whose message named a build or a spec was reported as "build
// succeeded" / "tests passed" -- so it never showed proud and never counted.

// Commands that only look at things. Their segments carry no intent, and
// their stdout is content (a grep for ENOENT prints ENOENT), not a verdict.
// `cd`/`pushd`/`popd` only move: `cd repo && git log` is still a read. Their
// only output is their own failure, though, so that is still looked for
// (SHELL_MOVE_FAILURE) -- editors that report no exit code rely on it.
const READ_ONLY_COMMANDS = /^(cat|less|more|head|tail|grep|egrep|fgrep|rg|ag|ack|find|fd|ls|dir|wc|bat|file|stat|echo|printf|which|where|type|diff|tree|du|df|pwd|cd|pushd|popd)$/i;
const GIT_READ_ONLY_SUBCOMMANDS = /^(diff|log|show|grep|blame|status)$/i;
const SHELL_MOVE_FAILURE = /\b(?:cd|pushd|popd):.*(?:no such file or directory|not a directory|permission denied)/i;

// Replace every quoted string with an empty one. Left to right, so whichever
// quote opens first owns the span: a double-quoted heredoc commit message
// (`-m "$(cat <<'EOF' ... EOF)"`) is removed whole. An unterminated quote is
// left alone.
function stripQuotedArgs(cmd) {
  return toText(cmd).replace(/"(?:[^"\\]|\\[\s\S])*"|'[^']*'/g, '""');
}

// First word of a segment and the rest, past env assignments and wrappers.
function segmentWords(segment) {
  let s = segment.trim().replace(/^[({]\s*/, '');
  for (;;) {
    const m = s.match(/^(?:[A-Za-z_]\w*=\S*|sudo|time|command|builtin|exec)\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.split(/\s+/).filter(Boolean);
}

function isReadOnlySegment(segment) {
  const words = segmentWords(segment);
  if (!words.length) return true;
  const cmd = words[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  if (READ_ONLY_COMMANDS.test(cmd)) return true;
  if (/^git$/i.test(cmd)) {
    // Skip global options (`git -C dir log`, `git --no-pager diff`).
    let i = 1;
    while (i < words.length && words[i].startsWith('-')) {
      i += /^-[Cc]$/.test(words[i]) ? 2 : 1;
    }
    return GIT_READ_ONLY_SUBCOMMANDS.test(words[i] || '');
  }
  return false;
}

// { unquoted, intent, readOnly } for a shell command:
//   unquoted  the command with quoted string arguments emptied
//   intent    unquoted, minus the segments that only read (cat/grep/git log...)
//   readOnly  true when every segment only reads
// Segments split on && || ; | & and newlines -- but not on the `&` inside a
// redirect (`2>&1`, `>&2`, `&>file`, `<&3`): splitting `grep x 2>&1` left a
// segment `1`, which is not a read-only command, so an ordinary grep had its
// stdout scanned for errors and its matches read as a failure.
const SHELL_SEGMENT_SPLIT = /&&|\|\||(?<![<>])&(?!>)|[;|\r\n]/;
function shellIntent(cmd) {
  const unquoted = stripQuotedArgs(cmd);
  const segments = unquoted.split(SHELL_SEGMENT_SPLIT).filter(s => s.trim());
  const acting = segments.filter(s => !isReadOnlySegment(s));
  return {
    unquoted,
    intent: acting.join(' ; '),
    readOnly: segments.length > 0 && acting.length === 0,
  };
}

const GIT_WRITE_RE = /\bgit\s+(commit|push|tag)\b/i;

function isTestCommand(intent) {
  return /\b(jest|pytest|vitest|mocha|cypress|playwright|rspec|\.test\.|\.spec\.)\b/i.test(intent) ||
    /\b(npm|yarn|pnpm|bun|go|cargo|dotnet)\s+(run\s+)?(test|tests)\b/i.test(intent) ||
    /\b(rake|npx|composer)\s+test\b/i.test(intent) ||
    /\b(pytest|nosetests)\b/i.test(intent) ||
    /\bnode\s+(--test|test)\b/i.test(intent) ||
    /\b(make|gradle|mvn|php\s+artisan)\s+test\b/i.test(intent);
}

// Package installs. One table for both sides of a tool call: the PostToolUse
// copy had bare `yarn` and `pnpm`, so `yarn lint` or `pnpm dev` finished as
// "installed", while `npm i x` and `pip3 install x` showed installing and
// then finished as "command succeeded". Flags and workspace selectors may sit
// between the manager and its verb (`pnpm --filter web add zod`, `pnpm -r
// install`, `yarn workspace web add zod`, `yarn global add serve`), and a
// bare `yarn` (flags at most) IS `yarn install`.
const PKG_INSTALL_RE = /\b(npm|yarn|pnpm|bun)(?:\s+(?:(?:--filter|-F|--cwd|--prefix|--dir|-C)\s+\S+|workspace\s+\S+|global|-\S+))*\s+(install|i|add|ci)(?=\s|$)/i;
const BARE_YARN_RE = /(?:^|;)\s*yarn(?:\s+-\S+)*\s*(?=;|$)/i;
function isInstallCommand(intent) {
  return PKG_INSTALL_RE.test(intent) || BARE_YARN_RE.test(intent) ||
    /\b(pip|pip3)\s+(install|-r)\b/i.test(intent) ||
    /\b(cargo\s+build|cargo\s+add)\b/i.test(intent) ||
    /\b(apt|apt-get|apk)\s+(install|add)\b/i.test(intent) ||
    /\b(brew\s+install|homebrew)\b/i.test(intent) ||
    /\b(go\s+get|go\s+install)\b/i.test(intent) ||
    /\b(composer\s+require|composer\s+install)\b/i.test(intent) ||
    /\b(dotnet\s+add|dotnet\s+restore)\b/i.test(intent);
}

function toolToState(toolName, toolInput) {
  let result;
  const name = toText(toolName);
  const input = (toolInput && typeof toolInput === 'object') ? toolInput : {};
  const filePath = toText(input.file_path || input.notebook_path || input.path || input.target_file);
  const shortPath = filePath ? path.basename(filePath) : '';

  // Writing/editing code
  if (EDIT_TOOLS.test(name)) {
    result = { state: 'coding', detail: shortPath ? `editing ${shortPath}` : 'writing code' };
  }

  // Running commands
  else if (BASH_TOOLS.test(name)) {
    const cmd = toText(input.command || input.cmd || input.input);
    const shortCmd = cmd.length > 40 ? cmd.slice(0, 37) + '...' : cmd;
    // Classify on intent, never on arguments (see Shell Command Intent)
    const { intent } = shellIntent(cmd);

    // Detect git commit / push / tag operations first -- a commit message
    // is free text and routinely names tests, builds and specs
    if (GIT_WRITE_RE.test(intent)) {
      const isPush = /\bgit\s+push\b/i.test(intent);
      const isTag  = /\bgit\s+tag\b/i.test(intent);
      const detail = isPush ? 'pushing to remote' : isTag ? 'tagging release' : 'committing changes';
      result = { state: 'committing', detail: shortCmd || detail };
    }

    // Detect test commands
    else if (isTestCommand(intent)) {
      result = { state: 'testing', detail: shortCmd || 'running tests' };
    }

    // Detect install commands
    else if (isInstallCommand(intent)) {
      result = { state: 'installing', detail: shortCmd || 'installing' };
    }

    // Detect ML training commands (must come after install detection)
    else if (/\b(python|python3|torchrun|deepspeed|accelerate)\b.*\btrain\b/i.test(intent) ||
        /\bunsloth\b/i.test(intent) ||
        /\b(python|python3)\b.*\b(fine.?tune|finetune)\b/i.test(intent) ||
        /\b(python|python3)\b.*(--epochs?|--learning.?rate|--lr)\b/i.test(intent) ||
        /\bnohup\b.*\btrain\b/i.test(intent)) {
      result = { state: 'training', detail: shortCmd || 'training model' };
    }

    else {
      const fallback = SHELL_MGMT_TOOLS.test(name) ? humanizeToolName(name) : 'running command';
      result = { state: 'executing', detail: shortCmd || fallback };
    }
  }

  // Reviewing / diffing code
  else if (REVIEW_TOOLS.test(name)) {
    result = { state: 'reviewing', detail: humanizeToolName(name) || 'reviewing' };
  }

  // Reading files
  else if (READ_TOOLS.test(name)) {
    result = { state: 'reading', detail: shortPath ? `reading ${shortPath}` : 'reading' };
  }

  // Searching
  else if (SEARCH_TOOLS.test(name)) {
    const pattern = toText(input.pattern || input.query || input.search_term);
    if (!pattern && LIST_TOOLS.test(name) && shortPath) {
      result = { state: 'searching', detail: `listing ${shortPath}` };
    } else {
      result = { state: 'searching', detail: pattern ? `looking for "${pattern}"` : 'searching' };
    }
  }

  // Web/fetch
  else if (WEB_TOOLS.test(name)) {
    const query = toText(input.query || input.url);
    const shortQuery = query.length > 30 ? query.slice(0, 27) + '...' : query;
    result = { state: 'searching', detail: shortQuery ? `searching "${shortQuery}"` : 'searching the web' };
  }

  // Asking the user something — the face waits on them
  else if (ASK_TOOLS.test(name)) {
    result = { state: 'waiting', detail: 'asking you' };
  }

  // Loading a skill = reading instructions
  else if (SKILL_TOOLS.test(name)) {
    const skill = toText(input.skill || input.name);
    result = { state: 'reading', detail: skill ? `skill: ${skill}` : 'loading a skill' };
  }

  // Planning / scheduling tools are thinking, not doing
  else if (PLAN_TOOLS.test(name)) {
    result = { state: 'thinking', detail: SCHEDULE_TOOLS.test(name) ? 'scheduling' : 'planning' };
  }

  // Publishing an artifact or sending a file is producing output
  else if (PUBLISH_TOOLS.test(name)) {
    result = { state: 'coding', detail: /^senduserfile$/i.test(name) ? 'sending a file' : 'publishing' };
  }

  // Task/subagent
  else if (SUBAGENT_TOOLS.test(name)) {
    const desc = toText(input.description || input.prompt);
    const shortDesc = desc.length > 30 ? desc.slice(0, 27) + '...' : desc;
    let fallback = 'spawning subagent';
    if (/^workflow$/i.test(name)) fallback = 'orchestrating';
    else if (/^sendmessage$/i.test(name)) fallback = 'messaging an agent';
    else if (AGENT_MONITOR_TOOLS.test(name)) fallback = 'checking on agents';
    result = { state: 'subagent', detail: shortDesc || fallback };
  }

  // MCP tools — classify by verb so "read_sheet_values" reads and
  // "create_pull_request" codes instead of everything being "executing"
  else if (/^mcp__/.test(name)) {
    const { server, tool, rawTool } = splitMcpToolName(name);
    result = { state: mcpVerbState(rawTool), detail: `${server}: ${tool}` };
  }

  // Default: unknown tool, best we can do is say its name in plain words
  else {
    result = { state: 'thinking', detail: humanizeToolName(name) };
  }

  // Strip ANSI escape sequences from detail before returning
  if (result.detail) {
    result.detail = stripAnsi(result.detail).replace(/[\r\n]+/g, ' ');
  }
  return result;
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
  /\d+\s+fail(ed|ing)\b/i,                          // "3 failed" (jest/pytest/code-crumb), "3 failing" (mocha)
  /^FAIL\b/m,                                        // Go test output
  /# fail [1-9]\d*/i,                                  // node --test TAP format (excludes "# fail 0")
  /\bfailed with exit code\b/i,
  /\bnpm ERR!/,
  /\bcargo error\b/i,
  /\brustc.*error\[E\d+\]/,                       // Rust compiler errors
  /\bCONFLICT\s+\(.*?\):/,                         // git merge conflicts (requires git format)
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

// False positive guards: these look scary but aren't. Each one only cancels
// an error match on its own line (see lineIsGuarded).
const WARNING_GUARD = /warning/i;                   // warnings aren't errors
const falsePositives = [
  /\b0 errors?\b/i,                                  // not "10 errors"
  /no errors?\b/i,
  /errors?:\s*0\b/i,
  /error handling/i,
  /error\.js/i,                                     // Just a filename
  /stderr/i,                                        // Talking about stderr
  /\.error\s*[=(]/,                                 // Property/method named error
  /error_count\W*0\b/i,                              // not "error_count: 10"
  WARNING_GUARD,
  /no conflicts?\b/i,                               // "no conflicts" isn't a conflict
  /Merge made by/i,                                 // git merge success ("Merge made by recursive strategy")
  /Already up.to.date/i,                            // git pull/merge when nothing to do
  /conflicts? resolved/i,                           // past-tense resolution, not an active failure
  /\b0\s+fail(ed|ing)\b/i,                          // "0 failed" / "0 failing" is success
];

// Strip ANSI escape sequences (SGR colors/bold/underline, CSI controls, OSC hyperlinks/titles)
// so regex patterns match through styled output and detail strings are clean for rendering.
function stripAnsi(text) {
  return text ? text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '') : '';
}

// A false-positive guard only cancels an error match on the SAME line.
// Applied to the whole output, one "No errors found" or "Captured stderr
// call" anywhere cancelled a real "1 failed" elsewhere. A line whose only
// guard is "warning" but which names an error outright ("2 warnings,
// 1 error") is still an error.
function lineIsGuarded(line) {
  const guards = falsePositives.filter(p => p.test(line));
  if (guards.length === 0) return false;
  if (guards.length === 1 && guards[0] === WARNING_GUARD && /\berrors?\b/i.test(line)) return false;
  return true;
}

function looksLikeError(text, patterns) {
  if (!text) return false;
  const clean = stripAnsi(toText(text));
  const lines = clean.split(/\r?\n/);
  for (const p of patterns) {
    if (p.source.includes('\\n')) {
      // A pattern that spans lines (the Node stack trace) is matched on the
      // whole output and judged by the line it starts on.
      const m = clean.match(p);
      if (m && !lineIsGuarded(lines[clean.slice(0, m.index).split('\n').length - 1] || '')) return true;
      continue;
    }
    for (const line of lines) {
      if (p.test(line) && !lineIsGuarded(line)) return true;
    }
  }
  return false;
}

// Try to extract an exit code from stdout -- Claude Code often
// appends "Exit code: N" to the output even though it doesn't
// give us exit_code as a field.
// Only phrases that are about an exit status count: "Exit code: N", "exit
// code N", "exit status N", "exited with [code|status] N". The bare
// "returned N" form was dropped -- "Search returned 12 results" and
// "fib(10) returned 55" are program output, not statuses. The number is at
// most three digits and must end on a word boundary. JSON-escaped line
// breaks (`\n` as two characters, as in classifyTruncatedInput's raw text)
// are read as whitespace so the leading word boundary still holds.
function extractExitCode(stdout) {
  const clean = stripAnsi(toText(stdout)).replace(/\\[nrt]/g, ' ');
  const match = clean.match(/\b(?:exit\s+(?:code|status)|exited\s+with(?:\s+(?:exit\s+)?(?:code|status))?)[:=\s]+(\d{1,3})\b/i);
  return match ? parseInt(match[1], 10) : null;
}

// Friendly error detail based on what we found
function errorDetail(stdout, stderr) {
  const combined = stripAnsi((stdout || '') + (stderr || ''));
  if (isMergeConflict(stdout, stderr)) return 'merge conflict!';
  if (/command not found/i.test(combined)) return 'command not found';
  if (/permission denied/i.test(combined)) return 'permission denied';
  if (/no such file or directory/i.test(combined)) return 'file not found';
  if (/segmentation fault/i.test(combined)) return 'segfault!';
  if (/ENOENT/.test(combined)) return 'missing file/path';
  if (/syntax error/i.test(combined)) return 'syntax error';
  if (/Cannot find module|ModuleNotFound/i.test(combined)) return 'missing module';
  if (/Traceback|at Object\.<anonymous>|Error:/.test(combined)) return 'exception thrown';
  if (/Compilation failed|build failed/i.test(combined)) return 'build broke';
  if (/test(s)? failed|\d+\s+fail(ed|ing)|^FAIL\b|# fail [1-9]/im.test(combined)) return 'tests failed';
  if (/npm ERR!/i.test(combined)) return 'npm error';
  return 'something went wrong';
}

// -- Tool Response Normalization --------------------------------------

// Claude Code sends tool output as `tool_result` (string or object).
// Other editors may use `tool_response` with {stdout, stderr}.
// This normalizes both into a consistent {stdout, stderr} object and keeps
// the signals that mean trouble — `interrupted` (user hit Esc), `isError` /
// `is_error` (MCP), and a numeric `exitCode` / `exit_code` — so
// classifyToolResult can react to them. Without this an interrupted
// command used to render as relieved / "command succeeded".
function normalizeToolResponse(data) {
  // Claude Code's PostToolUseFailure carries no tool_response at all: the
  // failure is `error` (a string -- a failing Bash command's own output lands
  // there) plus `is_interrupt`. Read those, or every failed tool reads as
  // "something went wrong" and an Esc never shows "interrupted".
  if (data.tool_result == null && data.tool_response == null
      && (typeof data.error === 'string' || data.is_interrupt !== undefined)) {
    const out = { stdout: '', stderr: toText(data.error) };
    if (data.is_interrupt !== undefined) out.interrupted = !!data.is_interrupt;
    return out;
  }
  const rawResult = data.tool_result ?? data.tool_response ?? {};
  if (typeof rawResult === 'string') return { stdout: rawResult, stderr: '' };
  if (Array.isArray(rawResult)) {
    // Content block array: [{type:"text", text:"..."}]
    const text = rawResult
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
    return { stdout: text, stderr: '' };
  }
  if (typeof rawResult !== 'object' || rawResult === null) {
    return { stdout: toText(rawResult), stderr: '' };
  }
  const out = { stdout: toText(rawResult.stdout), stderr: toText(rawResult.stderr) };
  const isError = rawResult.isError ?? rawResult.is_error;
  if (isError !== undefined) out.isError = !!isError;
  if (rawResult.interrupted !== undefined) out.interrupted = !!rawResult.interrupted;
  const exit = rawResult.exitCode ?? rawResult.exit_code;
  if (typeof exit === 'number') out.exitCode = exit;
  // Claude Code's edit diff, carried through only when it is the array we expect.
  // It is read for line counts and never persisted -- see diffFromPatch.
  if (Array.isArray(rawResult.structuredPatch)) out.structuredPatch = rawResult.structuredPatch;
  return out;
}

// -- Post-Tool Classification ----------------------------------------

// Detect git merge conflicts in command output
function isMergeConflict(stdout, stderr) {
  const combined = stripAnsi((stdout || '') + (stderr || ''));
  return /\bCONFLICT\s+\(.*\):/.test(combined) ||
         /\bAutomatic merge failed\b/i.test(combined) ||
         /\bfix conflicts and then commit\b/i.test(combined);
}

// -- Edit Diff Counting ----------------------------------------------

// Claude Code attaches a `structuredPatch` to PostToolUse for Edit/MultiEdit/
// Write-over-existing: hunks of { oldStart, oldLines, newStart, newLines,
// lines } where each line keeps its '+', '-' or ' ' prefix. Counting those is
// exact -- a same-length replacement is +1 -1, where counting the raw inputs
// claims +2 -2. Returns null when the patch is absent or malformed so the
// caller can fall back. Only the two totals are kept; the patch is never
// written to the state file.
function diffFromPatch(structuredPatch) {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return null;
  let added = 0, removed = 0, sawHunk = false;
  for (const hunk of structuredPatch) {
    if (!hunk || !Array.isArray(hunk.lines)) continue;
    sawHunk = true;
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line[0] === '+') added++;
      else if (line[0] === '-') removed++;
    }
  }
  return sawHunk ? { added, removed } : null;
}

// Fallback when no patch is available (other editors, Write to a new file):
// line counts of the edit's own inputs. Approximate -- a replacement counts
// both sides in full -- but it is all these tools give us.
function diffFromInput(input) {
  if (Array.isArray(input.edits)) {              // MultiEdit
    let added = 0, removed = 0;
    for (const e of input.edits) {
      const o = toText(e && e.old_string), n = toText(e && e.new_string);
      if (o) removed += o.split('\n').length;
      if (n) added += n.split('\n').length;
    }
    return added || removed ? { added, removed } : null;
  }
  const oldStr = toText(input.old_string || input.old_str);
  const newStr = toText(input.new_string || input.new_str || input.content || input.new_source);
  if (!oldStr && !newStr) return null;
  return { added: newStr ? newStr.split('\n').length : 0, removed: oldStr ? oldStr.split('\n').length : 0 };
}

// Encapsulates the full PostToolUse decision tree.
// Returns { state, detail, diffInfo }
function classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag) {
  const name = toText(toolName);
  const input = (toolInput && typeof toolInput === 'object') ? toolInput : {};
  const stdout = toText(toolResponse?.stdout);
  const stderr = toText(toolResponse?.stderr);
  const isError = isErrorFlag || toolResponse?.isError || false;
  const isShell = BASH_TOOLS.test(name);
  const cmd = isShell ? toText(input.command || input.cmd || input.input) : '';
  const { unquoted, intent, readOnly } = shellIntent(cmd);
  // An exit code is only inferred from a shell's own output. Any other tool
  // reporting "returned 12 results" is content, not a status.
  const inferredExit = isShell ? extractExitCode(stdout) : null;
  const exitCode = typeof toolResponse?.exitCode === 'number' ? toolResponse.exitCode : null;
  const fp = toText(input.file_path || input.notebook_path || input.path || input.target_file);

  let state, detail;
  let diffInfo = null;

  // Decision tree -- in order of confidence
  // Interrupted first: PostToolUseFailure forces isErrorFlag, and an Esc
  // is still an interruption rather than a generic failure.
  if (toolResponse?.interrupted) {
    state = 'error';
    detail = 'interrupted';
  } else if (isError) {
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (exitCode !== null && exitCode !== 0) {
    state = 'error'; detail = exitDetail(stdout, stderr, exitCode);
  } else if (inferredExit !== null && inferredExit !== 0) {
    state = 'error'; detail = exitDetail(stdout, stderr, inferredExit);
  } else if (!READ_TOOLS.test(name) && !SEARCH_TOOLS.test(name) && !WEB_TOOLS.test(name) && looksLikeError(stderr, stderrErrorPatterns)) {
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (isShell && readOnly && SHELL_MOVE_FAILURE.test(stripAnsi(stdout))) {
    // A read-only chain's stdout is content -- except a failed `cd`, whose
    // message is the only thing it can print (merged output, no exit code).
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (isShell && !readOnly && looksLikeError(stdout, stdoutErrorPatterns)) {
    // Only check stdout patterns for shell commands -- other tools have
    // structured output -- and not for commands that only read: the stdout
    // of `grep -rn ENOENT src/` or `cat build.log` is content, not a verdict
    state = 'error'; detail = errorDetail(stdout, stderr);
  } else if (EDIT_TOOLS.test(name)) {
    state = 'proud';
    detail = fp ? `saved ${path.basename(fp)}` : 'code written';
    // Diff info for thought bubbles: exact from the patch when we got one,
    // otherwise estimated from the edit's inputs
    diffInfo = diffFromPatch(toolResponse && toolResponse.structuredPatch) || diffFromInput(input);
  } else if (READ_TOOLS.test(name)) {
    state = 'satisfied';
    detail = fp ? `read ${path.basename(fp)}` : 'got it';
  } else if (SEARCH_TOOLS.test(name)) {
    state = 'satisfied';
    const pattern = toText(input.pattern || input.query || input.search_term);
    detail = pattern ? `found "${pattern.length > 20 ? pattern.slice(0, 17) + '...' : pattern}"` : 'got it';
  } else if (WEB_TOOLS.test(name)) {
    state = 'satisfied';
    detail = 'search complete';
  } else if (BASH_TOOLS.test(name)) {
    state = 'relieved';
    // Classify on intent, never on arguments (see Shell Command Intent).
    // The git checks come first: a commit message is free text, and
    // "Fix the build script" must still count as a commit.
    const isTest = isTestCommand(intent);
    const isBuild = /\b(build|compile|tsc|webpack|vite|esbuild|rollup|make)\b/i.test(intent);
    const isGit = /\bgit\s/i.test(unquoted);
    const isInstall = isInstallCommand(intent);

    if (isGit && isMergeConflict(stdout, stderr)) {
      state = 'error';
      detail = 'merge conflict!';
    } else if (/\bgit\s+push\b/i.test(intent)) {
      state = 'proud';
      detail = 'pushed!';
    } else if (/\bgit\s+commit\b/i.test(intent)) {
      state = 'proud';
      detail = 'committed';
    } else if (isTest) {
      // Try to pull test count from stdout
      const cleanStdout = stripAnsi(stdout);
      const testCount = cleanStdout.match(/(\d+)\s+(?:tests?|specs?)\s+passed/i)
                       || cleanStdout.match(/(\d+)\s+passing/i);
      detail = testCount ? `${testCount[1]} tests passed` : 'tests passed';
    } else if (isBuild) {
      detail = 'build succeeded';
    } else if (isGit) {
      if (/\bgit\s+(merge|pull|rebase)\b/i.test(intent)) {
        state = 'satisfied';
        detail = 'merged clean';
      } else {
        detail = 'git done';
      }
    } else if (isInstall) {
      detail = 'installed';
    } else if (SHELL_MGMT_TOOLS.test(name)) {
      detail = `${humanizeToolName(name)} done`;
    } else {
      detail = 'command succeeded';
    }
  } else if (ASK_TOOLS.test(name)) {
    state = 'satisfied';
    detail = 'got your answer';
  } else if (SKILL_TOOLS.test(name)) {
    state = 'satisfied';
    detail = 'skill loaded';
  } else if (PLAN_TOOLS.test(name)) {
    state = 'satisfied';
    detail = SCHEDULE_TOOLS.test(name) ? 'scheduled' : 'planned';
  } else if (PUBLISH_TOOLS.test(name)) {
    state = 'proud';
    detail = /^senduserfile$/i.test(name) ? 'sent' : 'published';
  } else if (SUBAGENT_TOOLS.test(name)) {
    // A returning Agent/Task/Workflow/TaskOutput means a helper finished
    if (AGENT_DONE_TOOLS.test(name)) {
      state = 'happy';
      detail = 'agent done';
    } else if (/^sendmessage$/i.test(name)) {
      state = 'satisfied';
      detail = 'message sent';
    } else {
      state = 'satisfied';
      detail = 'checked in';
    }
  } else if (REVIEW_TOOLS.test(name)) {
    state = 'satisfied';
    detail = 'reviewed';
  } else if (/^mcp__/.test(name)) {
    state = 'satisfied';
    detail = `${splitMcpToolName(name).server} done`;
  } else {
    state = 'satisfied';
    detail = 'step complete';
  }

  // Strip ANSI escape sequences from detail before returning
  if (detail) detail = stripAnsi(detail).replace(/[\r\n]+/g, ' ');
  return { state, detail, diffInfo };
}

// Detail for a non-zero exit: the forensic message when the output says
// something specific, otherwise the bare exit code (errorDetail never
// returns an empty string, so `|| exit N` used to be unreachable).
function exitDetail(stdout, stderr, code) {
  const d = errorDetail(stdout, stderr);
  return d === 'something went wrong' ? `exit ${code}` : d;
}

// -- Truncated Input Classification -----------------------------------

// When stdin exceeds MAX_INPUT (1MB), the full JSON can't be parsed.
// This function extracts what it can from the raw (truncated) text to
// avoid silently swallowing errors.  Returns { state, detail }.
function classifyTruncatedInput(hookEvent, rawInput) {
  // PostToolUseFailure is always an error
  if (hookEvent === 'PostToolUseFailure') {
    return { state: 'error', detail: 'tool failed' };
  }
  // PostToolUse -- attempt forensic error detection from truncated data.
  // Also runs when hookEvent is empty (adapter path) so exit codes and
  // isError flags are still detected even without event type info.
  if (hookEvent === 'PostToolUse' || !hookEvent) {
    // Tier 1: isError flag (appears early in JSON, before large stdout)
    if (/"isError"\s*:\s*true/.test(rawInput)) {
      return { state: 'error', detail: errorDetail(rawInput, '') || 'something went wrong' };
    }
    const toolMatch = rawInput.match(/"tool_name"\s*:\s*"([^"]+)"/);
    const toolName = toolMatch ? toolMatch[1] : '';
    // Tier 2: exit code embedded in stdout -- shell tools only. With the tool
    // name cut off by the truncation it is still tried, as it always was.
    const exitCode = (!toolName || BASH_TOOLS.test(toolName)) ? extractExitCode(rawInput) : null;
    if (exitCode !== null && exitCode !== 0) {
      return { state: 'error', detail: errorDetail(rawInput, '') || `exit ${exitCode}` };
    }
    // Tier 3: stdout error patterns for Bash tools
    if (BASH_TOOLS.test(toolName) && looksLikeError(rawInput, stdoutErrorPatterns)) {
      return { state: 'error', detail: errorDetail(rawInput, '') || 'something went wrong' };
    }
    // No error detected in the captured data -- fall through to default
  }

  // Non-PostToolUse events -- map to correct face states
  const eventMap = {
    Stop:               { state: 'responding', detail: 'wrapping up' },
    SessionEnd:         { state: 'responding', detail: 'session ending' },
    Notification:       { state: 'waiting',    detail: 'needs attention' },
    UserPromptSubmit:   { state: 'thinking',   detail: 'reading your message' },
    TeammateIdle:       { state: 'waiting',    detail: 'teammate idle' },
    TaskCompleted:      { state: 'happy',      detail: 'task done' },
    SessionStart:       { state: 'idle',       detail: 'session starting' },
    SubagentStart:      { state: 'subagent',   detail: 'spawning subagent' },
    SubagentStop:       { state: 'happy',      detail: 'subagent done' },
    StopFailure:        { state: 'error',      detail: 'API error' },
    PreCompact:         { state: 'thinking',   detail: 'compacting memory' },
    PostCompact:        { state: 'satisfied',  detail: 'memory compacted' },
    PermissionRequest:  { state: 'waiting',    detail: 'needs permission' },
    Setup:              { state: 'starting',   detail: 'setting up' },
    Elicitation:        { state: 'waiting',    detail: 'needs input' },
    ElicitationResult:  { state: 'satisfied',  detail: 'input received' },
    ConfigChange:       { state: 'reading',    detail: 'config updated' },
    InstructionsLoaded: { state: 'reading',    detail: 'loading instructions' },
    PostModelSwitch:    { state: 'thinking',   detail: 'model switched' },
  };
  return eventMap[hookEvent] || { state: 'thinking', detail: 'large input' };
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

// -- Frequent Files Management ----------------------------------------

const MAX_FREQUENT_FILES = 50;

// Prunes the frequentFiles map in-place to stay within bounds.
// Only acts when the map exceeds MAX_FREQUENT_FILES entries.
// Filters out count < 2 (single-touch noise), then keeps the top N by count.
function pruneFrequentFiles(frequentFiles) {
  if (!frequentFiles) return frequentFiles;
  const keys = Object.keys(frequentFiles);
  if (keys.length <= MAX_FREQUENT_FILES) return frequentFiles;
  const sorted = keys
    .map(k => [k, frequentFiles[k]])
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FREQUENT_FILES);
  for (const k of keys) delete frequentFiles[k];
  for (const [k, v] of sorted) frequentFiles[k] = v;
  return frequentFiles;
}

// Returns a small subset of frequentFiles suitable for embedding in state files.
// Only includes entries with count >= 3 (the _getTopFile threshold), capped at 10.
function topFrequentFiles(frequentFiles, limit) {
  if (!frequentFiles) return {};
  const cap = limit || 10;
  const entries = Object.entries(frequentFiles)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap);
  const result = {};
  for (const [k, v] of entries) result[k] = v;
  return result;
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
    topLevelSessions: {},
  };
}

// Repair a stats object read from disk so every field the hooks touch exists.
// A truncated write, an older schema, or a hand-edited file can leave `{}` or
// a partial shape; without this, `stats.session.id` throws inside a hook.
function normalizeStats(parsed) {
  const def = defaultStats();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return def;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const out = { ...def, ...parsed };
  out.records = { ...def.records, ...obj(parsed.records) };
  out.session = { ...def.session, ...obj(parsed.session) };
  if (!Array.isArray(out.session.filesEdited)) out.session.filesEdited = [];
  out.daily = { ...def.daily, ...obj(parsed.daily) };
  out.frequentFiles = obj(parsed.frequentFiles);
  out.topLevelSessions = obj(parsed.topLevelSessions);
  return out;
}

// -- Subagent Session State (pure logic) ---------------------------------

// Build the state object for writing to a subagent's session file.
// Preserves sticky fields (modelName, model, editor, taskDescription, cwd,
// gitBranch) from the existing session file, falling back to values from the
// sub entry. `model` is spread conditionally so an agent whose model was never
// resolved carries no empty key (the state file has a ~1 KB budget).
function buildSubagentSessionState(existing, sub, parentSessionId, defaultCwd) {
  if (existing.stopped) return null;
  return {
    sessionId: sub.id,
    modelName: existing.modelName || sub.model || 'haiku',
    ...(existing.model ? { model: existing.model } : {}),
    editor: existing.editor || sub.editor || '',
    cwd: existing.cwd || defaultCwd || '',
    gitBranch: existing.gitBranch || '',
    parentSession: parentSessionId,
    taskDescription: existing.taskDescription || sub.taskDescription || sub.description,
  };
}

// -- Claude Code Subagent Attribution (pure logic) ------------------------

// Claude Code fires every hook inside a subagent call with the PARENT's
// session_id and adds agent_id / agent_type. The orbital's identity therefore
// has to be synthesised from both, or all of a parent's agents collapse onto
// one session id (and onto the main face).
// Orbital session id for a Claude Code subagent: parent session + agent id.
function subagentSessionId(sessionId, agentId) {
  return `${sessionId}-agent-${agentId}`;
}

// -- Model Identity (pure logic) ------------------------------------------

// Model families we know how to name. First substring hit wins, so a new
// family is one entry here and nothing else. Deliberately tiny: this is the
// only Claude-specific knowledge in the codebase.
const MODEL_FAMILIES = [
  [/opus/i, 'Opus'],
  [/sonnet/i, 'Sonnet'],
  [/haiku/i, 'Haiku'],
  [/fable/i, 'Fable'],
];

// Raw model id -> display name. `claude-opus-5` / `claude-opus-5[1m]` /
// `anthropic/claude-opus` all become `Opus`.
//
// An unrecognised id is returned verbatim rather than prettified: the render
// sites already truncate (grid.js slices row 5 to BOX_W), and a plain `gpt-5`
// is more honest than a made-up family name. No length cap here for the same
// reason -- producers produce, renderers slice, and the session list has room
// for the full name.
function prettyModelName(raw) {
  let id = toText(raw).trim();
  if (!id) return '';
  id = id.replace(/\[[^\]]*\]\s*$/, '');           // "claude-opus-5[1m]"
  id = id.replace(/^.*\//, '');                     // "anthropic/claude-opus"
  id = id.trim();
  if (!id) return '';
  for (const [pattern, name] of MODEL_FAMILIES) {
    if (pattern.test(id)) return name;
  }
  return id;
}

// Path to a Claude Code subagent's own transcript, derived from the parent's
// `transcript_path` in the hook payload. Documented layout:
//   <projects>/<project>/<parentSessionId>/subagents/agent-<agentId>.jsonl
// Returns '' for anything it cannot derive safely. The agent id charset guard
// is a path-traversal guard -- an id carrying `..` or a separator must never
// compose a path.
function agentTranscriptPath(transcriptPath, agentId) {
  const tp = toText(transcriptPath).trim();
  const id = toText(agentId).trim();
  if (!tp || !id) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return '';
  const base = path.basename(tp);
  if (!/\.jsonl$/i.test(base)) return '';
  return path.join(path.dirname(tp), path.basename(tp, path.extname(tp)),
    'subagents', `agent-${id}.jsonl`);
}

// Human label for a subagent orbital: first non-empty line of the prompt
// (whitespace collapsed, <= 40 chars with a trailing ellipsis), else the
// agent type, else 'subagent'. SubagentStart carries `invocation_prompt`;
// `description` / `prompt` cover other hosts and older payloads.
function subagentLabel(data) {
  const d = data || {};
  const src = toText(d.description || d.invocation_prompt || d.prompt);
  const line = src.split(/\r?\n/).map(s => s.replace(/\s+/g, ' ').trim()).find(Boolean) || '';
  if (line) return line.length > 40 ? line.slice(0, 39) + '\u2026' : line;
  return toText(d.agent_type) || 'subagent';
}

// -- Per-Session Counters (pure logic) -------------------------------------
// Shared by update-state.js and the adapters (base-adapter.js), so a session
// switch restores counters and parks agents the same way on both paths.
//
// Per-session counters. The shared stats file has ONE `session` owner, and two
// top-level windows alternating hooks used to reset it on every switch: each
// window's file reported the other's toolCalls, and daily.sessionCount grew by
// one per alternation. Each session now keeps its own counters, keyed by id,
// and the session file reports those. Bounded: idle entries age out after a
// day and the map keeps the 50 most recently seen.
const COUNTER_MAX_AGE_MS = 24 * 3600000;
const COUNTER_MAX_ENTRIES = 50;
const COUNTER_MAX_FILES = 200;

// `countedDay` is the daily bucket (YYYY-MM-DD, UTC like stats.daily.date) in
// which this session last counted toward daily.sessionCount. It replaced a
// `counted` boolean that never reset, so a session running across midnight
// was never counted in the new day at all.
function freshCounter(now) {
  return { toolCalls: 0, filesEdited: [], start: now, commitCount: 0, creditedMs: 0, lastSeen: now, countedDay: '' };
}

// Repair one entry in place (a hand-edited or older stats file must never
// throw below). Returns null for anything that is not an entry at all.
function normalizeCounter(c, now) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  c.toolCalls = num(c.toolCalls, 0);
  c.start = num(c.start, now) || now;
  c.commitCount = num(c.commitCount, 0);
  c.creditedMs = num(c.creditedMs, 0);
  c.lastSeen = num(c.lastSeen, now);
  // A pre-countedDay entry that was counted is taken as counted today:
  // counting it again right after an upgrade would be the worse error.
  if (typeof c.countedDay !== 'string') {
    c.countedDay = c.counted ? new Date(now).toISOString().slice(0, 10) : '';
  }
  delete c.counted;
  c.filesEdited = Array.isArray(c.filesEdited)
    ? c.filesEdited.filter(f => typeof f === 'string').slice(0, COUNTER_MAX_FILES) : [];
  return c;
}

// While a session does not own stats.session, its running agents (and its
// subagent count) wait on its counter entry. Only stored when there is
// something to keep, so an idle window's entry stays small.
const COUNTER_MAX_AGENTS = 32;

function parkAgents(c, session) {
  if (!c || !session) return;
  const active = Array.isArray(session.activeSubagents)
    ? session.activeSubagents.filter(s => s && typeof s === 'object').slice(0, COUNTER_MAX_AGENTS) : [];
  if (active.length) c.activeSubagents = active; else delete c.activeSubagents;
  if (session.subagentCount > 0) c.subagentCount = session.subagentCount; else delete c.subagentCount;
}

function unparkAgents(c, session) {
  if (!c || !session) return;
  if (Array.isArray(c.activeSubagents)) {
    session.activeSubagents = c.activeSubagents.filter(s => s && typeof s === 'object');
  }
  if (typeof c.subagentCount === 'number' && Number.isFinite(c.subagentCount)) {
    session.subagentCount = c.subagentCount;
  }
  delete c.activeSubagents;
  delete c.subagentCount;
}

function pruneCounters(map, keepId, now) {
  for (const id of Object.keys(map)) {
    const c = map[id];
    if (!c || typeof c !== 'object') { delete map[id]; continue; }
    if (id !== keepId && now - (c.lastSeen || 0) > COUNTER_MAX_AGE_MS) delete map[id];
  }
  const ids = Object.keys(map);
  if (ids.length <= COUNTER_MAX_ENTRIES) return;
  // Over the cap, throwaway entries (at most one tool call, nothing parked)
  // go first, then the least recently seen. A flood of short-lived ids -- an
  // old OpenClaw snippet mints one per event -- used to push a busy window's
  // counters out, and it came back as a brand-new session.
  const throwaway = (id) => (map[id].toolCalls || 0) <= 1 && !Array.isArray(map[id].activeSubagents);
  ids.sort((a, b) => (throwaway(a) - throwaway(b)) || ((map[b].lastSeen || 0) - (map[a].lastSeen || 0)));
  for (const id of ids.slice(COUNTER_MAX_ENTRIES)) {
    // Never evict parked agents: their SubagentStops would match nothing
    // and their orbitals would be ghosts.
    if (id !== keepId && !Array.isArray(map[id].activeSubagents)) delete map[id];
  }
}

// -- Parallel Session Classification (pure logic) -------------------------

// Registry limits for stats.topLevelSessions ({ sessionId: lastSeenMs }).
const TOP_LEVEL_REGISTRY_MAX = 200;
const TOP_LEVEL_REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Decide whether a foreign session (id differs from the stats owner) seen
// while the owner has active subagents is a real subagent or an unrelated
// parallel top-level session (#134).
//   registryHit            session fired SessionStart (in stats.topLevelSessions)
//   fileBornAt             birthtime of the session's own file (null/0 = unknown)
//   earliestSubagentStart  startedAt of the oldest active subagent
// A real subagent's session file is created by its own first hook, which can
// only fire after SubagentStart — so a file born before the earliest active
// subagent spawned proves the session is an independent parallel one.
// Unknown birthtime (unsupported filesystem) falls back to 'subagent', the
// pre-fix behavior, so real subagent grouping never regresses.
function classifyForeignSession({ registryHit, fileBornAt, earliestSubagentStart }) {
  if (registryHit) return 'parallel';
  if (typeof fileBornAt === 'number' && fileBornAt > 0 &&
      typeof earliestSubagentStart === 'number' && earliestSubagentStart > 0 &&
      fileBornAt < earliestSubagentStart) {
    return 'parallel';
  }
  return 'subagent';
}

// Prune the top-level session registry in place: drop entries older than the
// TTL, then oldest-first down to the cap. Returns the registry.
function pruneTopLevelSessions(registry, now) {
  if (!registry) return registry;
  for (const id of Object.keys(registry)) {
    if (now - registry[id] > TOP_LEVEL_REGISTRY_TTL_MS) delete registry[id];
  }
  const ids = Object.keys(registry);
  if (ids.length > TOP_LEVEL_REGISTRY_MAX) {
    ids.sort((a, b) => registry[a] - registry[b]);
    for (const id of ids.slice(0, ids.length - TOP_LEVEL_REGISTRY_MAX)) {
      delete registry[id];
    }
  }
  return registry;
}

module.exports = {
  COUNTER_MAX_AGE_MS,
  COUNTER_MAX_ENTRIES,
  COUNTER_MAX_FILES,
  COUNTER_MAX_AGENTS,
  freshCounter,
  normalizeCounter,
  parkAgents,
  unparkAgents,
  pruneCounters,
  toolToState,
  humanizeToolName,
  toText,
  EDIT_TOOLS,
  BASH_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  WEB_TOOLS,
  SUBAGENT_TOOLS,
  REVIEW_TOOLS,
  ASK_TOOLS,
  SKILL_TOOLS,
  PLAN_TOOLS,
  PUBLISH_TOOLS,
  stdoutErrorPatterns,
  stderrErrorPatterns,
  falsePositives,
  isMergeConflict,
  looksLikeError,
  stripAnsi,
  errorDetail,
  extractExitCode,
  normalizeToolResponse,
  diffFromPatch,
  diffFromInput,
  classifyToolResult,
  classifyTruncatedInput,
  MILESTONES,
  updateStreak,
  defaultStats,
  normalizeStats,
  MAX_FREQUENT_FILES,
  pruneFrequentFiles,
  topFrequentFiles,
  buildSubagentSessionState,
  subagentSessionId,
  subagentLabel,
  MODEL_FAMILIES,
  prettyModelName,
  agentTranscriptPath,
  classifyForeignSession,
  pruneTopLevelSessions,
  TOP_LEVEL_REGISTRY_MAX,
  TOP_LEVEL_REGISTRY_TTL_MS,
};
