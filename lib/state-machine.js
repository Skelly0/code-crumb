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
// The PowerShell cmdlets (and their aliases) and cmd's findstr are the same
// reads on Windows: without them `Get-Content src/x.js` had its content read
// as a failure there, and broke the streak.
const READ_ONLY_COMMANDS = /^(cat|less|more|head|tail|grep|egrep|fgrep|rg|ag|ack|find|fd|ls|dir|wc|bat|file|stat|echo|printf|which|where|type|diff|tree|du|df|pwd|cd|pushd|popd|journalctl|findstr|get-content|gc|select-string|sls|get-childitem|gci|get-item|gi|test-path|resolve-path|get-location|gl|set-location|sl|write-output|write-host|measure-object|select-object|sort-object|where-object|format-table|format-list|out-string)$/i;
// `git reflog`, `git rev-parse` and friends print history, and history is
// free text: `git reflog` echoes every commit subject ("handle ENOENT in
// loader"), and its content read as "missing file/path".
const GIT_READ_ONLY_SUBCOMMANDS = /^(diff|log|show|grep|blame|status|reflog|shortlog|describe|rev-parse|rev-list|ls-files|ls-tree|ls-remote|show-ref|for-each-ref|cat-file|whatchanged)$/i;
const SHELL_MOVE_FAILURE = /\b(?:cd|pushd|popd):.*(?:no such file or directory|not a directory|permission denied)/i;

// The command a word names: no directory, no Windows extension.
// `.\gradlew.bat`, `C:\Git\cmd\git.exe` and `node_modules/.bin/jest` are
// gradlew, git and jest.
function cmdName(word) {
  return toText(word).replace(/^.*[\\/]/, '').replace(/\.(?:exe|cmd|bat|ps1)$/i, '');
}

// The first `n` positional words after the command, past flags and the
// values of the flags that take one (`kubectl -n prod logs`, `docker
// compose -f x.yml logs`).
function positionals(words, valueFlags, n) {
  const out = [];
  for (let i = 1; i < words.length && out.length < n; i++) {
    const w = words[i];
    if (w.startsWith('-')) { if (valueFlags.test(w)) i++; continue; }
    out.push(w);
  }
  return out;
}

// git's global options sit between `git` and its subcommand: `git -C ../app
// commit`, `git --no-pager log`, `git -c core.x=y push`, `git --git-dir=.g
// commit`. Matching `git\s+commit` missed every one of those, so a commit run
// in another folder showed "executing", finished as "git done", and was never
// counted. Returns { sub, args } for a segment's words (words[0] is git).
const GIT_VALUE_OPTS = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/;
function gitSubcommand(words) {
  let i = 1;
  while (i < words.length && words[i].startsWith('-')) {
    i += GIT_VALUE_OPTS.test(words[i]) ? 2 : 1;
  }
  return { sub: words[i] || '', args: words.slice(i + 1) };
}

// `git branch` lists, unless it is told to change something. A listing
// echoes each branch's last commit subject (`-vv`), which is content -- but
// `git branch new-name`, `-d`, `-m`, `-c` and `-u` act.
const BRANCH_LIST_FLAGS = /^(?:-[arvil]+|--(?:all|remotes|list|verbose|show-current|ignore-case|omit-empty|color|no-color|column|no-column|abbrev|no-abbrev|contains|no-contains|merged|no-merged|points-at|sort|format)(?:=.*)?)$/;
const BRANCH_VALUE_FLAGS = /^--(?:contains|no-contains|merged|no-merged|points-at|sort|format)$/;
function isBranchListing(args) {
  let listMode = false, positional = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (!BRANCH_LIST_FLAGS.test(a)) return false;
      if (/^(?:-[arvi]*l[arvi]*|--list)$/.test(a)) listMode = true;
      if (BRANCH_VALUE_FLAGS.test(a) && args[i + 1] && !args[i + 1].startsWith('-')) i++;
      continue;
    }
    positional = true;   // a pattern under --list; otherwise a branch to create
  }
  return listMode || !positional;
}

function isReadOnlyGit({ sub, args }) {
  if (/^reflog$/i.test(sub)) return !/^(?:expire|delete)$/i.test(args[0] || '');
  if (GIT_READ_ONLY_SUBCOMMANDS.test(sub)) return true;
  if (/^stash$/i.test(sub)) return /^(?:list|show)$/i.test(args[0] || '');
  if (/^branch$/i.test(sub)) return isBranchListing(args);
  if (/^remote$/i.test(sub)) return !args.length || /^(?:-v|--verbose|show|get-url)$/.test(args[0]);
  return false;
}

// Other tools whose job is to print what is already there: GitHub listings
// and logs (`gh run view --log-failed` prints a CI log full of failures),
// container and cluster logs. `docker logs api` printing "FATAL could not
// connect" is the log, not this command failing.
const GH_READ_VERBS = /^(?:list|ls|view|status|diff|checks)$/i;
const DOCKER_VALUE_FLAGS = /^(?:-H|--host|--context|-c|--config|-l|--log-level|-f|--file|-p|--project-name|--profile|--env-file|--project-directory|--ansi|--progress)$/;
const KUBECTL_VALUE_FLAGS = /^(?:-n|--namespace|--context|--cluster|--user|--kubeconfig|-s|--server)$/;
function isReadOnlyTool(cmd, words) {
  if (/^gh$/i.test(cmd)) {
    const [noun, verb] = positionals(words, /^(?:-R|--repo)$/, 2);
    return /^(?:status|search)$/i.test(noun || '') || GH_READ_VERBS.test(verb || '');
  }
  if (/^(?:docker|podman)$/i.test(cmd)) {
    const [sub, next] = positionals(words, DOCKER_VALUE_FLAGS, 2);
    if (/^compose$/i.test(sub || '')) return /^(?:logs|ps)$/i.test(next || '');
    return /^(?:logs|ps|images|inspect)$/i.test(sub || '');
  }
  if (/^(?:docker-compose|podman-compose)$/i.test(cmd)) {
    return /^(?:logs|ps)$/i.test(positionals(words, DOCKER_VALUE_FLAGS, 1)[0] || '');
  }
  if (/^kubectl$/i.test(cmd)) {
    return /^(?:logs|get|describe|top)$/i.test(positionals(words, KUBECTL_VALUE_FLAGS, 1)[0] || '');
  }
  return false;
}

// A shell wrapper is not the intent; the script it runs is. Codex on Windows
// runs every command as `pwsh -Command <script>`, so the first word was always
// `pwsh` and nothing inside was ever recognised. Unwraps pwsh/powershell
// -Command/-c, cmd /c, and sh/bash/zsh -c (twice at most, for a nested one),
// dropping one level of quotes around the script.
// The shell may be named by a path (`/bin/zsh -lc`, `"C:\Program Files\
// PowerShell\7\pwsh.exe" -Command`), quoted or not.
const SHELL_DIR = String.raw`(?:"[^"]*[\\/]|[^\s"]*[\\/])?`;
const SHELL_WRAPPER_RE = new RegExp(String.raw`^\s*(?:` +
  SHELL_DIR + String.raw`(?:pwsh|powershell)(?:\.exe)?"?(?:\s+-(?:NoProfile|NoLogo|NonInteractive|nop|noni|ExecutionPolicy\s+\S+))*\s+-(?:Command|c)\b` +
  '|' + SHELL_DIR + String.raw`cmd(?:\.exe)?"?(?:\s+\/[dqs])*\s+\/[ck]\b` +
  '|' + SHELL_DIR + String.raw`(?:ba|z|da)?sh(?:\.exe)?"?\s+-(?:l?c|cl?)\b` +
  String.raw`)\s*([\s\S]*)$`, 'i');
function unwrapShell(cmd) {
  let s = toText(cmd);
  for (let i = 0; i < 2; i++) {
    const m = SHELL_WRAPPER_RE.exec(s);
    if (!m) break;
    s = m[1].trim();
    // Only a quote pair that spans the whole script: `bash -lc "cat a" &&
    // bash -lc "npm install"` starts and ends with a quote that closes two
    // different strings, and stripping those joined the segments -- the
    // install then read as part of a read-only chain.
    const dq = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(s);
    const sq = /^'([^']*)'$/.exec(s);
    if (dq) s = dq[1];
    else if (sq) s = sq[1];
  }
  return s;
}

// Replace every quoted string with an empty one, and drop every heredoc body.
// Left to right, so whichever opens first owns the span: a double-quoted
// heredoc commit message (`-m "$(cat <<'EOF' ... EOF)"`) is removed whole as
// a string. An unquoted heredoc (`cat > x.py <<'EOF'` ... `EOF`) is data too:
// its body lines used to split into segments of their own, so a script that
// merely mentioned `npm install` showed "installing". An unterminated quote
// is left alone. A scanner, not a regex: every step moves forward, so the
// cost is linear in the command.
const HEREDOC_OPEN = /<<-?[ \t]*(["']?)([A-Za-z_][\w.-]*)\1/y;
function closingQuote(s, i) {
  if (s[i] === "'") return s.indexOf("'", i + 1);
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j;
  }
  return -1;
}
function stripQuotedArgs(cmd) {
  const s = toText(cmd);
  let out = '';
  const heredocs = [];   // delimiters opened on the current line
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = closingQuote(s, i);
      if (end >= 0) { out += '""'; i = end + 1; continue; }
    } else if (c === '<' && s[i + 1] === '<' && s[i - 1] !== '<' && s[i + 2] !== '<') {
      HEREDOC_OPEN.lastIndex = i;
      const m = HEREDOC_OPEN.exec(s);
      if (m) { heredocs.push(m[2]); out += '<<'; i += m[0].length; continue; }
    } else if (c === '\n' && heredocs.length) {
      // The bodies start on the next line and run to their delimiter lines.
      let j = i + 1;
      for (const delim of heredocs) {
        while (j < s.length) {
          let e = s.indexOf('\n', j);
          if (e < 0) e = s.length;
          const line = s.slice(j, e).trim();
          j = e + 1;
          if (line === delim) break;
        }
      }
      heredocs.length = 0;
      out += '\n';
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// First word of a segment and the rest, past env assignments and wrappers.
// A subshell's closing paren rides on the last word: `(git push)`.
function segmentWords(segment) {
  let s = segment.trim().replace(/^[({]\s*/, '');
  for (;;) {
    const m = s.match(/^(?:[A-Za-z_]\w*=\S*|sudo|time|command|builtin|exec)\s+/);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s.split(/\s+/).map(w => w.replace(/\)+$/, '')).filter(Boolean);
}

function isReadOnlySegment(segment) {
  const words = segmentWords(segment);
  if (!words.length) return true;
  const cmd = cmdName(words[0]);
  if (READ_ONLY_COMMANDS.test(cmd)) return true;
  if (/^git$/i.test(cmd)) return isReadOnlyGit(gitSubcommand(words));
  return isReadOnlyTool(cmd, words);
}

// The git calls among a command's acting segments: [{ sub, args }].
function gitCalls(intent) {
  const calls = [];
  for (const segment of intent.split(' ; ')) {
    const words = segmentWords(segment);
    if (words.length && /^git$/i.test(cmdName(words[0]))) calls.push(gitSubcommand(words));
  }
  return calls;
}
const hasGitSub = (calls, re) => calls.some(c => re.test(c.sub));

// Can this command line report success although a command in it failed?
// Only then is its output worth searching once the host has said it
// succeeded (classifyToolResult's trustSuccess). An acting command's exit
// status is lost when it
//   - feeds a pipe: `npm test 2>&1 | tail -5` exits with tail's status
//   - runs in the background: `npm run dev &`
//   - has a `||` or a `;` / newline / `&` after it: `npm test || true`,
//     `npm test; echo done`, `if npm test; then ...` -- the list exits with
//     its LAST command's status, and `a && b || c` with c's.
// `a && b` is not masked: the first failure ends the list with its status.
// A read-only segment's own failure (`cat nope; npm test`) is not looked for.
function exitMasked(segments) {
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].readOnly) continue;
    const op = segments[i].op;
    if (op === '|' || op === '&') return true;
    for (let j = i; j < segments.length - 1; j++) {
      if (/^(?:\|\||;|\n|\r|&)$/.test(segments[j].op)) return true;
    }
  }
  return false;
}

// { unquoted, intent, readOnly, masked } for a shell command:
//   unquoted  the command with quoted string arguments and heredocs emptied
//   intent    unquoted, minus the segments that only read (cat/grep/git log...)
//   readOnly  true when every segment only reads
//   masked    true when a failure could still exit 0 (see exitMasked)
// Segments split on && || ; | & and newlines -- but not on the `&` inside a
// redirect (`2>&1`, `>&2`, `&>file`, `<&3`): splitting `grep x 2>&1` left a
// segment `1`, which is not a read-only command, so an ordinary grep had its
// stdout scanned for errors and its matches read as a failure.
const SHELL_SEGMENT_SPLIT = /(&&|\|\||(?<![<>])&(?!>)|[;|\r\n])/;
function shellIntent(cmd) {
  const unquoted = stripQuotedArgs(unwrapShell(cmd));
  // split() with a capture group interleaves each segment with the operator
  // after it; an empty segment (`|&`, `\r\n`) keeps the operator before it.
  const parts = unquoted.split(SHELL_SEGMENT_SPLIT);
  const segments = [];
  for (let k = 0; k < parts.length; k += 2) {
    const text = parts[k];
    if (text.trim()) segments.push({ text, op: parts[k + 1] || '', readOnly: isReadOnlySegment(text) });
  }
  const acting = segments.filter(s => !s.readOnly);
  return {
    unquoted,
    intent: acting.map(s => s.text).join(' ; '),
    readOnly: segments.length > 0 && acting.length === 0,
    masked: exitMasked(segments),
    segments,
  };
}

// -- Predicate Commands ------------------------------------------------
// Commands whose exit status 1 is an answer, not a failure: grep/rg/findstr
// "no match", diff/cmp "the files differ", test/[ "false", which/where "not
// found", pgrep "no such process". Each reports real trouble with 2. Claude
// Code sends every non-zero exit as PostToolUseFailure ("Exit code 1"), Codex
// and OpenCode as a numeric exit code, so every empty search was an error
// face that broke the streak.
//
// What a predicate may have printed is its rule: 'silent' (nothing), 'alone'
// (anything, but only as the whole command), or a RegExp every non-blank line
// must match. which/where print a line of their own on a miss, so 'silent'
// counted almost none of them: GNU which (Git Bash, Fedora, Arch) says `which:
// no <name> in (<PATH>)` -- a PATH with `Program Files (x86)` in it, so the
// parenthesis runs to the end of the line -- and System32's where.exe says
// `INFO: Could not find files for the given pattern(s).` (both checked on
// Windows 11). Exactly those lines: a localized where.exe, or anything else
// printed alongside, keeps the error face.
const WHICH_MISS_RE = /^which: no \S+ in \(.*\)$/;
const WHERE_MISS_RE = /^INFO: Could not find files for the given pattern\(s\)\.$/;
const PREDICATE_KINDS = [
  [/^(?:grep|egrep|fgrep|rg|ag|ack|findstr)$/i, 'no matches', 'silent'],
  [/^(?:diff|cmp)$/i, 'files differ', 'alone'],
  [/^(?:test|\[|\[\[)$/, 'condition false', 'silent'],
  [/^which$/i, 'not found', WHICH_MISS_RE],
  [/^where$/i, 'not found', WHERE_MISS_RE],
  [/^pgrep$/i, 'no process', 'silent'],
];
function predicateKind(segment) {
  const words = segmentWords(segment.text);
  if (!words.length) return null;
  const cmd = cmdName(words[0]);
  if (/^git$/i.test(cmd)) {
    const { sub, args } = gitSubcommand(words);
    if (/^grep$/i.test(sub)) return ['no matches', 'silent'];
    // Plain `git diff` exits 0 with differences; 1 is only an answer when
    // asked for. `--quiet` prints nothing; `--exit-code` prints the diff it
    // found, which IS its answer -- so, like diff, it must stand alone (the
    // silent rule made every difference an error face).
    if (/^diff$/i.test(sub)) {
      if (args.includes('--quiet')) return ['files differ', 'silent'];
      if (args.includes('--exit-code')) return ['files differ', 'alone'];
    }
    return null;
  }
  for (const [re, detail, rule] of PREDICATE_KINDS) if (re.test(cmd)) return [detail, rule];
  return null;
}

// The detail for a shell command whose exit status 1 answered its question,
// or null. Its status must be the predicate's own: the LAST segment, reached
// only through `&&` or a pipe from read-only segments (`npm test && grep x`
// exits 1 when npm test failed). A failing read-only step (`cat nope | grep
// x`, `cd nowhere && grep x`) prints its complaint, so a search or a test
// must have printed nothing at all, and which/where only their own miss
// line; diff's output IS its answer, so a diff must stand alone. `output` is
// everything the command printed, minus the editor's "Exit code N" trailer.
function predicateAnswer(segments, exit, output) {
  if (exit !== 1 || !segments || !segments.length) return null;
  const last = segments[segments.length - 1];
  const kind = predicateKind(last);
  if (!kind) return null;
  const [detail, rule] = kind;
  const before = segments.slice(0, -1);
  if (rule === 'alone' && before.length) return null;
  if (before.some(s => !s.readOnly || !/^(?:&&|\|)$/.test(s.op))) return null;
  if (rule === 'silent' && output.trim()) return null;
  if (rule instanceof RegExp && output.split('\n').some(l => l.trim() && !rule.test(l.trim()))) return null;
  return detail;
}

// What a command printed, without the editor's own exit-status line.
function withoutExitTrailer(text) {
  const lines = stripAnsi(toText(text)).split(/\r?\n/);
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length && EXIT_TRAILER_RE.test(lines[0])) lines.shift();
  if (lines.length && EXIT_TRAILER_RE.test(lines[lines.length - 1])) lines.pop();
  return lines.join('\n');
}

// A build, judged by the command and its subcommand -- never its arguments:
// `rm -rf build`, `mkdir -p build` and `cp -r build/ dist` all finished as
// "build succeeded". Build tools count by name; a subcommand-style tool counts
// when its subcommand (or its `run` script) is build/compile.
const BUILD_TOOLS = /^(?:tsc|webpack|vite|esbuild|rollup|parcel|make|cmake|ninja|msbuild|gradlew?|mvnw?|turbo|nx|bazel)$/i;
const SUBCOMMAND_TOOLS = /^(?:npm|yarn|pnpm|bun|deno|go|cargo|docker|podman|dotnet|swift|zig|next|nuxt|astro|ng|sbt|gradlew?|mvnw?|flutter|stack|cabal|mix|dune)$/i;
const RUNNERS = /^(?:npx|bunx|pnpx)$/i;

// make's targets: its words past flags, a flag's value (`-C build`, `-j 8`)
// and VAR=value assignments. A bare `make` (or -j8 at most) builds the
// default goal; `make lint`, `make clean` and `make format` do not build
// anything, and all three finished as "build succeeded".
const MAKE_VALUE_FLAGS = /^(?:-C|-f|-I|-o|-W|--directory|--file|--makefile|--include-dir|--old-file|--assume-old|--what-if|--new-file|--assume-new)$/;
const MAKE_BUILD_TARGET = /^(?:all|compile|release|debug|dist|bundle)$|build/i;
const MAKE_TEST_TARGET = /^(?:tests?|check|unittests?|tests?[-_:]\S+|\S+[-_:]tests?)$/i;
function makeTargets(words) {
  const targets = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (MAKE_VALUE_FLAGS.test(w)) { i++; continue; }
    if (/^-[jl]$/.test(w) && /^\d+$/.test(words[i + 1] || '')) { i++; continue; }
    if (w.startsWith('-') || /^[A-Za-z_]\w*=/.test(w)) continue;
    targets.push(w);
  }
  return targets;
}
// The targets of the first make call among a command's acting segments, or
// null when it runs no make.
function makeCall(intent) {
  for (const segment of intent.split(' ; ')) {
    const words = segmentWords(segment);
    if (words.length && /^g?make$/i.test(cmdName(words[0]))) return makeTargets(words);
  }
  return null;
}

function isBuildCommand(intent) {
  for (const segment of intent.split(' ; ')) {
    let words = segmentWords(segment);
    if (words.length && RUNNERS.test(words[0])) {
      // Past the runner's flags, and the package a `-p`/`--package` names.
      const rest = [];
      for (let i = 1; i < words.length; i++) {
        if (/^(?:-p|--package)$/.test(words[i])) { i++; continue; }
        if (!words[i].startsWith('-')) rest.push(words[i]);
      }
      words = rest;
    }
    if (!words.length) continue;
    const cmd = cmdName(words[0]);
    if (/^g?make$/i.test(cmd)) {
      const targets = makeTargets(words);
      if (!targets.length || targets.some(t => MAKE_BUILD_TARGET.test(t))) return true;
      continue;
    }
    if (BUILD_TOOLS.test(cmd)) return true;
    if (!SUBCOMMAND_TOOLS.test(cmd)) continue;
    // Past flags, a flag's value (`--filter web`) and a workspace selector.
    const rest = [];
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (/^(?:--filter|-F|--cwd|--prefix|--dir|-C|-w|--workspace|-p|--project|-t|--tag|-f|--file)$/.test(w)) { i++; continue; }
      if (w.startsWith('-')) continue;
      if (w === 'workspace' && /^(?:yarn|npm|pnpm)$/i.test(cmd)) { i++; continue; }
      rest.push(w);
    }
    const sub = rest[0] === 'run' ? rest[1] : rest[0];
    if (sub && /^(?:build|compile)(?:[:\-].*)?$/i.test(sub)) return true;
    // A build tool run through the manager (`yarn tsc`, `pnpm vite build`,
    // `pnpm exec tsc`, `npm exec -- webpack`), or one level down (`docker
    // compose build`).
    const next = /^(?:exec|dlx|x|compose)$/i.test(sub || '') ? rest[1] : sub;
    if (next && BUILD_TOOLS.test(next)) return true;
    if (/^compose$/i.test(sub || '') && /^build$/i.test(rest[1] || '')) return true;
  }
  return false;
}

// Test runs that the word tables cannot see, judged token by token:
//   node    `node --test`, or a script under test/ or tests/, test.js, or a
//           *.test.js / *.spec.js -- `node tests/run.js` (this repo's own
//           suite) used to be "executing" / "command succeeded"
//   gradle  a test task (`test`, `check`, `:app:testDebugUnitTest`,
//           `connectedAndroidTest`) -- never the task `-x test` excludes
//   maven   the test or verify phase, or a surefire/failsafe goal
//   make    a test target (`test`, `check`, `test-unit`), past -C dir
// `./gradlew test`, `gradlew.bat test` and `./mvnw test` finished as "build
// succeeded": the wrapper name never matched `gradle\s+test`.
const NODE_VALUE_FLAGS = /^(?:-r|--require|--import|--loader|--experimental-loader|--env-file|-C|--conditions|--input-type|--title|--inspect-port|--test-reporter|--test-reporter-destination|--test-name-pattern|--test-concurrency)$/;
const NODE_TEST_SCRIPT = /^(?:\.[\\/])?tests?(?:$|[\\/]|\.[cm]?[jt]s$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const GRADLE_VALUE_FLAGS = /^(?:-p|--project-dir|-x|--exclude-task|-b|--build-file|-c|--settings-file|-g|--gradle-user-home|-I|--init-script|-D|-P|--console|--warning-mode|--priority|--max-workers)$/;
const GRADLE_TEST_TASK = /^(?:test|check|connectedCheck|\w+Tests?)$/;
const MAVEN_VALUE_FLAGS = /^(?:-pl|--projects|-P|--activate-profiles|-f|--file|-s|--settings|-gs|--global-settings|-t|--toolchains|-T|--threads|-rf|--resume-from|-D|--define|-l|--log-file|-b|--builder)$/;
const MAVEN_TEST_PHASE = /^(?:test|verify|integration-test|(?:surefire|failsafe):[\w-]+)$/;
function isNodeTestRun(words) {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--test') return true;
    if (/^(?:-e|--eval|-p|--print)$/.test(w)) return false;
    if (NODE_VALUE_FLAGS.test(w)) { i++; continue; }
    if (w.startsWith('-')) continue;
    return NODE_TEST_SCRIPT.test(w);
  }
  return false;
}
function isToolTestRun(intent) {
  for (const segment of intent.split(' ; ')) {
    const words = segmentWords(segment);
    if (!words.length) continue;
    const cmd = cmdName(words[0]);
    if (/^node$/i.test(cmd)) { if (isNodeTestRun(words)) return true; }
    else if (/^gradlew?$/i.test(cmd)) {
      if (positionals(words, GRADLE_VALUE_FLAGS, Infinity).some(t => GRADLE_TEST_TASK.test(t.replace(/^.*:/, '')))) return true;
    } else if (/^mvnw?$/i.test(cmd)) {
      if (positionals(words, MAVEN_VALUE_FLAGS, Infinity).some(p => MAVEN_TEST_PHASE.test(p))) return true;
    } else if (/^g?make$/i.test(cmd)) {
      if (makeTargets(words).some(t => MAKE_TEST_TARGET.test(t))) return true;
    }
  }
  return false;
}

function isTestCommand(intent) {
  return /\b(jest|pytest|vitest|mocha|cypress|playwright|rspec|\.test\.|\.spec\.)\b/i.test(intent) ||
    /\b(npm|yarn|pnpm|bun|deno|go|cargo|dotnet)\s+(run\s+)?(test|tests)\b/i.test(intent) ||
    /\b(rake|npx|composer)\s+test\b/i.test(intent) ||
    /\b(pytest|nosetests)\b/i.test(intent) ||
    /\bphp\s+artisan\s+test\b/i.test(intent) ||
    isToolTestRun(intent);
}

// Package installs. One table for both sides of a tool call: the PostToolUse
// copy had bare `yarn` and `pnpm`, so `yarn lint` or `pnpm dev` finished as
// "installed", while `npm i x` and `pip3 install x` showed installing and
// then finished as "command succeeded". Flags and workspace selectors may sit
// between the manager and its verb (`pnpm --filter web add zod`, `pnpm -r
// install`, `yarn workspace web add zod`, `yarn global add serve`), and a
// bare `yarn` (flags at most) IS `yarn install`.
// Token by token: the regex this replaces let `-C` be either a flag with a
// value or a flag on its own, so `pnpm -C -C -C ...` had exponentially many
// readings -- twenty of them held the hook for over a minute.
const PKG_MANAGERS = /^(?:npm|yarn|pnpm|bun)$/i;
const PKG_VALUE_FLAGS = /^(?:--filter|-F|--cwd|--prefix|--dir|-C)$/;
function isPkgInstall(words) {
  if (words.length && /^corepack$/i.test(cmdName(words[0]))) words = words.slice(1);
  if (!words.length) return false;
  const cmd = cmdName(words[0]);
  if (!PKG_MANAGERS.test(cmd)) return false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (PKG_VALUE_FLAGS.test(w) || /^workspace$/i.test(w)) { i++; continue; }
    if (/^global$/i.test(w) || w.startsWith('-')) continue;
    return /^(?:install|i|add|ci)$/i.test(w);
  }
  return /^yarn$/i.test(cmd);
}
// `cargo build` is a build (isBuildCommand), not an install: it showed
// "installing" for as long as it compiled.
function isInstallCommand(intent) {
  return intent.split(' ; ').some(s => isPkgInstall(segmentWords(s))) ||
    /\b(pip|pip3)\s+(install|-r)\b/i.test(intent) ||
    /\bcargo\s+add\b/i.test(intent) ||
    /\b(apt|apt-get|apk)\s+(install|add)\b/i.test(intent) ||
    /\b(brew\s+install|homebrew)\b/i.test(intent) ||
    /\b(go\s+get|go\s+install)\b/i.test(intent) ||
    /\b(composer\s+require|composer\s+install)\b/i.test(intent) ||
    /\b(dotnet\s+add|dotnet\s+restore)\b/i.test(intent);
}

// ML training runs: a launcher, then (anywhere after it) what it trains.
// Each check finds the launcher once and searches what follows it:
// `\bpython\b.*\btrain\b` rescanned the rest of the command from every
// "python" in it -- quadratic, ~140ms for 4,000 of them.
function isTrainingCommand(intent) {
  const from = (re) => { const m = re.exec(intent); return m ? intent.slice(m.index) : null; };
  const launched = from(/\b(?:python|python3|torchrun|deepspeed|accelerate)\b/i);
  if (launched !== null && /\btrain\b/i.test(launched)) return true;
  if (/\bunsloth\b/i.test(intent)) return true;
  const py = from(/\b(?:python|python3)\b/i);
  if (py !== null && (/\b(?:fine.?tune|finetune)\b/i.test(py) || /(?:--epochs?|--learning.?rate|--lr)\b/i.test(py))) return true;
  const nohup = from(/\bnohup\b/i);
  return nohup !== null && /\btrain\b/i.test(nohup);
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
    const git = gitCalls(intent);
    if (hasGitSub(git, /^(?:commit|push|tag)$/i)) {
      const isPush = hasGitSub(git, /^push$/i);
      const isTag  = hasGitSub(git, /^tag$/i);
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
    else if (isTrainingCommand(intent)) {
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
  /(?<!\d)\d+\s+fail(ed|ing)\b/i,                   // "3 failed" (jest/pytest/code-crumb), "3 failing" (mocha)
  /^FAIL\b/m,                                        // Go test output
  /# fail [1-9]\d*/i,                                  // node --test TAP format (excludes "# fail 0")
  /\bfailed with exit code\b/i,
  /\bnpm ERR!/,
  /\bcargo error\b/i,
  /\brustc.*error\[E\d+\]/,                       // Rust compiler errors
  /\bCONFLICT\s+\([^)\r\n]{1,40}\):/,              // git merge conflicts (requires git format)
  /\bAutomatic merge failed\b/i,
  /\bfix conflicts and then commit\b/i,
  // git's own failures, for output with stderr merged in (a masked `git push
  // 2>&1 | tail`, OpenCode): stdout had no pattern for any of them, so a
  // rejected push finished as "pushed!".
  /^fatal: /,                                      // "fatal: not a git repository"
  /^error: failed to push some refs\b/,
  /^ ! \[(?:remote )?rejected\]/,
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
// An OSC sequence (a hyperlink, a title) ends in BEL or in ESC \\ (ST). The
// old pattern knew only BEL: an OSC 8 link ending in ST was never stripped,
// and a long run of them took quadratic time. `(?<!\\d)` below keeps a run of
// 30,000 digits (Claude Code's inline output cap) from costing the hook
// 350ms of backtracking in "\\d+\\s+failed" -- the lookbehind makes it linear.
function stripAnsi(text) {
  return text
    ? text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    : '';
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

// -- Echoed Content ------------------------------------------------------

// Lines a command prints that quote free text back rather than judge
// anything. Searched as verdicts, they were the commonest false error:
// `git commit -m "Treat a delete-pending lock (win32 EPERM) as held"` echoes
// its subject as `[main 1a2b3c4] Treat ... EPERM ...`, `git push -u origin
// fix/error-toast` names the branch in four lines, `git stash` repeats the
// last subject ("... Handle ENOENT ..."), and a green test run lists its
// test names ("reports permission denied"). Each pattern is one line's exact
// shape, anchored at its start, so a real failure on the same output is
// never one of them: a rejected ref, `error: failed to push some refs`,
// `fatal: ...`, "2 failing" and `CONFLICT (content)` all stay.
const ECHOED_LINES = [
  // git commit / cherry-pick / revert / merge: the summary and its details
  /^\[[^\]\r\n]*\s[0-9a-f]{7,40}\]\s/,             // [main (root-commit) 1a2b3c4] <subject>
  /^ Date: /,
  /^\s*\d+ files? changed\b/,
  /^ (?:create|delete) mode \d+ /,
  /^ mode change \d+ => \d+ /,
  /^ (?:rename|copy) .* \(\d+%\)$/,
  /^ [^|\r\n]+\| +(?:\d+ ?[+\-]*|Bin\b.*)$/,        // diffstat: " src/panic.rs | 2 +-"
  // push / fetch / pull: the remote, its messages and every ref updated
  // (never ` ! [rejected]`, which has no line here)
  /^(?:To|From) \S+\s*$/,
  /^ [*+\-=t ] (?:\[[^\]\r\n]{1,40}\]|branch|[0-9a-f]{4,40}\.{2,3}[0-9a-f]{4,40}) +\S/,
  /^branch '[^'\r\n]*' set up to track /i,
  /^remote:(?!\s*(?:error|fatal)\b)/i,
  // branch moves, stashes and resets, which repeat a subject or a name
  /^Saved working directory and index state /,
  /^Dropped (?:refs\/)?stash@\{\d+\} /,
  /^HEAD is now at [0-9a-f]{7,40}\b/,
  /^Previous HEAD position was /,
  /^(?:Switched to (?:a new )?branch|Already on|Reset branch) '/,
  /^Your branch (?:is|and) /,
  /^Deleted (?:remote-tracking )?branch \S+ \(was [0-9a-f]+\)/,
  /^Successfully rebased and updated /,
  // Claude Code's own notice after a command that cd'd out of the project:
  // a project folder named error-tracker or panic-button tripped the stderr
  // patterns on every such command
  /^Shell cwd was reset to /,
  // a passing test: its pass mark, then its name (jest/vitest/mocha/node
  // spec, Windows mocha's √, TAP, pytest -v)
  /^\s*(?:\u2713|\u2714|\u221a|\u2705)/,
  /^\s*ok \d+\b/,
  /^\S+::.* PASSED\b/,
];

function dropEchoedLines(text) {
  const clean = stripAnsi(toText(text));
  if (!clean) return '';
  return clean.split('\n').filter(line => {
    const l = line.replace(/\r$/, '');
    return !ECHOED_LINES.some(p => p.test(l));
  }).join('\n');
}

// -- Bounded Scans ---------------------------------------------------------

// A failure shows at the start of a command's output (command not found, a
// codex `Exit code: N` header) or at its end (the test summary, the build's
// last word), so a very large output is searched in two windows: its first
// 16 KB and its last 64 KB, each cut back to whole lines. A 900 KB Bash
// result used to be searched in full -- every pattern over every line --
// where a 900 KB Read is never searched at all.
const SCAN_HEAD_BYTES = 16 * 1024;
const SCAN_TAIL_BYTES = 64 * 1024;
function scanWindow(text) {
  const s = toText(text);
  if (s.length <= SCAN_HEAD_BYTES + SCAN_TAIL_BYTES) return s;
  let head = s.slice(0, SCAN_HEAD_BYTES);
  const h = head.lastIndexOf('\n');
  if (h > 0) head = head.slice(0, h);
  let tail = s.slice(-SCAN_TAIL_BYTES);
  const t = tail.indexOf('\n');
  if (t >= 0) tail = tail.slice(t + 1);
  return head + '\n' + tail;
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

// The exit status an editor wrote around a command's output: a line of its
// own, first or last. A read-only command's output is content -- `grep -n
// "Exit code" x.js` prints matches that name exit codes, `tail ci.log` prints
// "exited with code 1" -- so only such a trailer counts for it.
const EXIT_TRAILER_RE = /^\s*(?:exit\s+(?:code|status)|exited\s+with(?:\s+(?:exit\s+)?(?:code|status))?)[:=\s]+(\d{1,3})\s*\.?\s*$/i;
function extractTrailerExitCode(stdout) {
  const lines = stripAnsi(toText(stdout)).split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return null;
  for (const line of [lines[0], lines[lines.length - 1]]) {
    const m = EXIT_TRAILER_RE.exec(line);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

// A chain that moves (cd/pushd/popd): only then can a move failure be its own.
const SHELL_MOVE_RE = /(?:^|&&|\|\||[;|&\r\n])\s*(?:cd|pushd|popd)(?=\s|$)/i;

// Friendly error detail based on what we found. `opts.conflicts: false` is
// for a command that cannot have made a merge conflict (a shell command with
// no git in it): this repo's own failing test run lists test names quoting
// `CONFLICT (content):`, and every failure it had read "merge conflict!".
// `opts.git` names a git command's verdict: 'push' or 'git'. A `fatal:` line
// is git's own word on what went wrong, and a masked `git push 2>&1 | tail`
// that ended in one read "something went wrong" (Codex: a bare "exit 128").
// A cause named outright (command not found, permission denied) still wins,
// and the rest is checked after it -- `Error:` and "no such file" inside
// git's message are fragments of it. Without git in the command, a `fatal:`
// is anyone's.
function errorDetail(stdout, stderr, opts) {
  const combined = stripAnsi((stdout || '') + (stderr || ''));
  if (!(opts && opts.conflicts === false) && isMergeConflict(stdout, stderr)) return 'merge conflict!';
  if (/^ ! \[(?:remote )?rejected\]|\bfailed to push some refs\b/m.test(combined)) return 'push rejected';
  if (/command not found/i.test(combined)) return 'command not found';
  if (/permission denied/i.test(combined)) return 'permission denied';
  if (opts && opts.git && /^fatal: /m.test(stripAnsi(`${stdout || ''}\n${stderr || ''}`))) {
    return opts.git === 'push' ? 'push failed' : 'git failed';
  }
  if (/no such file or directory/i.test(combined)) return 'file not found';
  if (/segmentation fault/i.test(combined)) return 'segfault!';
  if (/ENOENT/.test(combined)) return 'missing file/path';
  if (/syntax error/i.test(combined)) return 'syntax error';
  if (/Cannot find module|ModuleNotFound/i.test(combined)) return 'missing module';
  if (/Traceback|at Object\.<anonymous>|Error:/.test(combined)) return 'exception thrown';
  if (/Compilation failed|build failed/i.test(combined)) return 'build broke';
  if (/test(s)? failed|(?<!\d)\d+\s+fail(ed|ing)|^FAIL\b|# fail [1-9]/im.test(combined)) return 'tests failed';
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
  // Claude Code's Agent result: 'completed', or 'async_launched' for an agent
  // sent to the background (the default) -- which returns at once.
  if (typeof rawResult.status === 'string') out.status = rawResult.status;
  // A `run_in_background` Bash call returns at once with the id of the job
  // it started -- {stdout: '', stderr: '', interrupted: false,
  // backgroundTaskId} -- and no verdict (see isBackgroundLaunch).
  if (typeof rawResult.backgroundTaskId === 'string' && rawResult.backgroundTaskId) {
    out.backgroundTaskId = rawResult.backgroundTaskId;
  }
  return out;
}

// -- Post-Tool Classification ----------------------------------------

// Detect git merge conflicts in command output. The parenthesis holds one
// short word pair (`content`, `modify/delete`): `\(.*\)` scanned to the end
// of the output for every "CONFLICT (" in it.
function isMergeConflict(stdout, stderr) {
  const combined = stripAnsi((stdout || '') + (stderr || ''));
  return /\bCONFLICT\s+\([^)\r\n]{1,40}\):/.test(combined) ||
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

// A `run_in_background` Bash call returns the moment its job starts. Its
// verdict comes later (BashOutput / TaskOutput), so "tests passed" and
// "build succeeded" here were guesses, and the streak went up before the job
// had run. The flag alone counts only with no output at all.
function isBackgroundLaunch(input, toolResponse, stdout, stderr) {
  if (toolResponse && typeof toolResponse.backgroundTaskId === 'string' && toolResponse.backgroundTaskId) return true;
  return input.run_in_background === true && !stdout.trim() && !stderr.trim();
}

// Encapsulates the full PostToolUse decision tree.
// Returns { state, detail, diffInfo }, plus `neutral: true` for a result
// with no verdict yet (a background launch): it must neither extend nor
// break the streak, and counts as no commit.
//
// opts.trustSuccess: the host only calls this for a tool that succeeded --
// Claude Code reports a failing one as PostToolUseFailure, never PostToolUse
// (checked against 2.1.300) -- so the output is not searched for failure
// words, and no exit code is inferred from it. Every false error face came
// from that search: a commit echoing its subject, a push naming its branch,
// a green test run listing its test names. Two exceptions keep searching:
// a command line whose failure could still exit 0 (see exitMasked), and a
// shell-management tool, whose output is another command's (BashOutput).
// Explicit signals -- interrupted, isError, a numeric exit code -- always
// count. Without the option (Codex, whose PostToolUse fires for failures
// too; the adapters) everything is searched, echoed content dropped first.
function classifyToolResult(toolName, toolInput, toolResponse, isErrorFlag, opts) {
  const name = toText(toolName);
  const input = (toolInput && typeof toolInput === 'object') ? toolInput : {};
  const isShell = BASH_TOOLS.test(name);
  // Bounded windows of the output (see Bounded Scans), and for a shell, with
  // the lines that only echo content dropped (see Echoed Content).
  let stdout = scanWindow(toolResponse?.stdout);
  let stderr = scanWindow(toolResponse?.stderr);
  if (isShell) { stdout = dropEchoedLines(stdout); stderr = dropEchoedLines(stderr); }
  const isError = isErrorFlag || toolResponse?.isError || false;
  const shellMgmt = SHELL_MGMT_TOOLS.test(name);
  const cmd = isShell ? toText(input.command || input.cmd || input.input) : '';
  const { unquoted, intent, readOnly, masked, segments } = shellIntent(cmd);
  const trusted = !!(opts && opts.trustSuccess) && !(isShell && (masked || shellMgmt));
  // A merge conflict is only a git command's -- or an unknown command's. So
  // is a `fatal:` line's verdict (see errorDetail).
  const isGit = /\bgit\s/i.test(unquoted);
  const detailOpts = {
    conflicts: !isShell || !cmd.trim() || isGit,
    git: isShell && isGit ? (hasGitSub(gitCalls(intent), /^push$/i) ? 'push' : 'git') : '',
  };
  // An exit code is only inferred from a shell's own output. Any other tool
  // reporting "returned 12 results" is content, not a status -- and so is a
  // read-only command's output, save an editor's own trailer line.
  const inferredExit = trusted || !isShell ? null : readOnly ? extractTrailerExitCode(stdout) : extractExitCode(stdout);
  const exitCode = typeof toolResponse?.exitCode === 'number' ? toolResponse.exitCode : null;
  const fp = toText(input.file_path || input.notebook_path || input.path || input.target_file);

  let state, detail;
  let diffInfo = null;
  let neutral = false;
  // A predicate's "no" (see Predicate Commands): the host's exit code, or the
  // editor's own "Exit code N" line -- on the failure text for Claude Code.
  const predicate = isShell && !shellMgmt
    ? predicateAnswer(segments,
        exitCode !== null ? exitCode : extractTrailerExitCode(isError ? stderr : stdout),
        withoutExitTrailer(stdout + '\n' + stderr))
    : null;

  // Decision tree -- in order of confidence
  // Interrupted first: PostToolUseFailure forces isErrorFlag, and an Esc
  // is still an interruption rather than a generic failure.
  if (toolResponse?.interrupted) {
    state = 'error';
    detail = 'interrupted';
  } else if (predicate) {
    // An answer, not a verdict on the work: neither breaks nor extends the streak.
    state = 'satisfied';
    detail = predicate;
    neutral = true;
  } else if (isError) {
    state = 'error'; detail = errorDetail(stdout, stderr, detailOpts);
  } else if (exitCode !== null && exitCode !== 0) {
    state = 'error'; detail = exitDetail(stdout, stderr, exitCode, detailOpts);
  } else if (isShell && !shellMgmt && isBackgroundLaunch(input, toolResponse, stdout, stderr)) {
    // Launched, not finished -- like a background agent's `async_launched`
    state = 'satisfied';
    detail = 'launched in background';
    neutral = true;
  } else if (!trusted && inferredExit !== null && inferredExit !== 0) {
    state = 'error'; detail = exitDetail(stdout, stderr, inferredExit, detailOpts);
  } else if (!trusted && !READ_TOOLS.test(name) && !SEARCH_TOOLS.test(name) && !WEB_TOOLS.test(name) && looksLikeError(stderr, stderrErrorPatterns)) {
    state = 'error'; detail = errorDetail(stdout, stderr, detailOpts);
  } else if (!trusted && isShell && readOnly && SHELL_MOVE_RE.test(unquoted) && SHELL_MOVE_FAILURE.test(stdout)) {
    // A read-only chain's stdout is content -- except a failed `cd`, whose
    // message is the only thing it can print (merged output, no exit code).
    // Only a chain with a cd in it: `tail deploy.log` can print one too.
    state = 'error'; detail = errorDetail(stdout, stderr, detailOpts);
  } else if (!trusted && isShell && !readOnly && looksLikeError(stdout, stdoutErrorPatterns)) {
    // Only check stdout patterns for shell commands -- other tools have
    // structured output -- and not for commands that only read: the stdout
    // of `grep -rn ENOENT src/` or `cat build.log` is content, not a verdict
    state = 'error'; detail = errorDetail(stdout, stderr, detailOpts);
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
    const isBuild = isBuildCommand(intent);
    const isInstall = isInstallCommand(intent);
    const git = gitCalls(intent);
    const make = makeCall(intent);

    // `git log` / `git grep "CONFLICT ("` print conflicts as content. A
    // trusted success cannot be one: git exits 1 on a conflict.
    if (!trusted && isGit && !readOnly && isMergeConflict(stdout, stderr)) {
      state = 'error';
      detail = 'merge conflict!';
    } else if (hasGitSub(git, /^push$/i)) {
      state = 'proud';
      detail = 'pushed!';
    } else if (hasGitSub(git, /^commit$/i)) {
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
      if (hasGitSub(git, /^(?:merge|pull|rebase)$/i)) {
        state = 'satisfied';
        detail = 'merged clean';
      } else {
        detail = 'git done';
      }
    } else if (isInstall) {
      detail = 'installed';
    } else if (make && make.length) {
      // `make lint`, `make clean`: done, but not a build (see makeTargets)
      detail = `make ${make[0].slice(0, 20)} done`;
    } else if (shellMgmt) {
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
    // A returning Agent/Task/Workflow/TaskOutput means a helper finished --
    // unless it was only launched: background agents are Claude Code's
    // default, and their Agent call returns `async_launched` straight away,
    // so "agent done" was shown the moment each one started.
    if (toolResponse?.status === 'async_launched') {
      state = 'satisfied';
      detail = 'agent launched';
    } else if (AGENT_DONE_TOOLS.test(name)) {
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
  const result = { state, detail, diffInfo };
  if (neutral) result.neutral = true;
  return result;
}

// Detail for a non-zero exit: the forensic message when the output says
// something specific, otherwise the bare exit code (errorDetail never
// returns an empty string, so `|| exit N` used to be unreachable).
function exitDetail(stdout, stderr, code, opts) {
  const d = errorDetail(stdout, stderr, opts);
  return d === 'something went wrong' ? `exit ${code}` : d;
}

// -- Truncated Input Classification -----------------------------------

// When stdin exceeds MAX_INPUT (1MB), the full JSON can't be parsed.
// This function extracts what it can from the raw (truncated) text to
// avoid silently swallowing errors.  Returns { state, detail }.
function classifyTruncatedInput(hookEvent, rawInput) {
  // The scans below see bounded windows of the raw text (see Bounded Scans),
  // with its JSON-escaped line breaks made real: `\nCONFLICT` has no word
  // boundary before the C, and a one-line text is one line for every
  // per-line guard. The envelope regexes are linear and keep the whole raw.
  const scanned = scanWindow(rawInput).replace(/\\r\\n|\\[nr]/g, '\n');
  // PostToolUseFailure is always an error. A git command's merge conflict
  // says so (the first "command" is tool_input's: it precedes the output).
  if (hookEvent === 'PostToolUseFailure') {
    const command = /"command"\s*:\s*"((?:[^"\\]|\\.){0,2000})/.exec(scanned);
    const conflict = (!command || /\bgit\s/.test(command[1])) && isMergeConflict(scanned, '');
    return { state: 'error', detail: conflict ? 'merge conflict!' : 'tool failed' };
  }
  // PostToolUse -- attempt forensic error detection from truncated data.
  // Also runs when hookEvent is empty (adapter path) so exit codes and
  // isError flags are still detected even without event type info.
  if (hookEvent === 'PostToolUse' || !hookEvent) {
    // Tier 1: isError flag (appears early in JSON, before large stdout)
    if (/"isError"\s*:\s*true/.test(rawInput)) {
      return { state: 'error', detail: errorDetail(scanned, '') || 'something went wrong' };
    }
    // tool_name (hooks) or tool (the OpenCode plugin's flat payload).
    const toolMatch = rawInput.match(/"(?:tool_name|toolName|tool)"\s*:\s*"([^"]+)"/);
    const toolName = toolMatch ? toolMatch[1] : '';
    // Tier 2: exit code embedded in stdout -- shell tools only. With the tool
    // name cut off by the truncation it is still tried, as it always was.
    const exitCode = (!toolName || BASH_TOOLS.test(toolName)) ? extractExitCode(scanned) : null;
    if (exitCode !== null && exitCode !== 0) {
      return { state: 'error', detail: errorDetail(scanned, '') || `exit ${exitCode}` };
    }
    // Tier 3: stdout error patterns for Bash tools
    if (BASH_TOOLS.test(toolName) && looksLikeError(scanned, stdoutErrorPatterns)) {
      return { state: 'error', detail: errorDetail(scanned, '') || 'something went wrong' };
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
    Interrupt:          { state: 'error',      detail: 'interrupted' },
    PreCompact:         { state: 'thinking',   detail: 'compacting memory' },
    PostCompact:        { state: 'satisfied',  detail: 'memory compacted' },
    PermissionRequest:  { state: 'waiting',    detail: 'needs permission' },
    PermissionDenied:   { state: 'thinking',   detail: 'permission denied' },
    Setup:              { state: 'starting',   detail: 'setting up' },
    Elicitation:        { state: 'waiting',    detail: 'needs input' },
    ElicitationResult:  { state: 'satisfied',  detail: 'input received' },
    ConfigChange:       { state: 'reading',    detail: 'config updated' },
    InstructionsLoaded: { state: 'reading',    detail: 'loading instructions' },
    PostModelSwitch:    { state: 'thinking',   detail: 'model switched' },
  };
  return Object.prototype.hasOwnProperty.call(eventMap, hookEvent)
    ? eventMap[hookEvent] : { state: 'thinking', detail: 'large input' };
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
// Only acts when the map exceeds MAX_FREQUENT_FILES entries: every other
// entry ages by one (so a count of 1 -- single-touch noise -- goes), then the
// top N by count are kept. `keep` is the file just touched: it neither ages
// nor is cut. Without both, a full map of files at 2+ rejected every newcomer
// in the same write that added it, and lifetime counts that never decayed
// kept weeks-old files on top for good.
function pruneFrequentFiles(frequentFiles, keep) {
  if (!frequentFiles) return frequentFiles;
  const keys = Object.keys(frequentFiles);
  if (keys.length <= MAX_FREQUENT_FILES) return frequentFiles;
  const kept = keys
    .map(k => [k, k === keep ? frequentFiles[k] : frequentFiles[k] - 1])
    .filter(([k, count]) => k === keep || count >= 1)
    .sort((a, b) => (b[0] === keep) - (a[0] === keep) || b[1] - a[1])
    .slice(0, MAX_FREQUENT_FILES);
  for (const k of keys) delete frequentFiles[k];
  for (const [k, v] of kept) frequentFiles[k] = v;
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
    frequentFiles: Object.create(null),
    topLevelSessions: Object.create(null),
  };
}

// Repair a stats object read from disk so every field the hooks touch exists.
// A truncated write, an older schema, or a hand-edited file can leave `{}` or
// a partial shape; without this, `stats.session.id` throws inside a hook.
//
// Every field keeps its default's type: a string "streak":"5" concatenated
// ("51", "511"...), and `activeSubagents: [null]` threw in every hook -- which
// then fell back, so the file was never rewritten and never repaired.
// The maps keyed by a session id or a file name have no prototype: a session
// called `__proto__` wrote its counters onto Object.prototype (so they never
// persisted), and a file named `toString` read the inherited function and
// stored "function toString() { [native code] }1" -- growing on every edit.
function normalizeStats(parsed) {
  const def = defaultStats();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return def;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const dict = (v, keep) => {
    const d = Object.create(null);
    for (const [k, x] of Object.entries(obj(v))) if (keep(x)) d[k] = x;
    return d;
  };
  const typed = (src, d) => {
    const o = { ...src };
    for (const [k, dv] of Object.entries(d)) {
      if (typeof dv === 'number') o[k] = isNum(src[k]) ? src[k] : dv;
      else if (typeof dv === 'string') o[k] = typeof src[k] === 'string' ? src[k] : dv;
      else if (Array.isArray(dv)) o[k] = Array.isArray(src[k]) ? src[k] : dv;
    }
    return o;
  };
  const out = typed({ ...def, ...parsed }, def);
  out.records = typed({ ...def.records, ...obj(parsed.records) }, def.records);
  out.session = typed({ ...def.session, ...obj(parsed.session) }, def.session);
  out.session.filesEdited = out.session.filesEdited.filter(f => typeof f === 'string');
  if (out.session.activeSubagents !== undefined) {
    out.session.activeSubagents = Array.isArray(out.session.activeSubagents)
      ? out.session.activeSubagents.filter(a => a && typeof a === 'object' && !Array.isArray(a)) : [];
  }
  out.daily = typed({ ...def.daily, ...obj(parsed.daily) }, def.daily);
  const m = parsed.recentMilestone;
  out.recentMilestone = m && typeof m === 'object' && !Array.isArray(m) ? m : null;
  out.frequentFiles = dict(parsed.frequentFiles, isNum);
  out.topLevelSessions = dict(parsed.topLevelSessions, isNum);
  if (parsed.sessionCounters !== undefined) {
    out.sessionCounters = dict(parsed.sessionCounters, (x) => x && typeof x === 'object' && !Array.isArray(x));
  }
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

// A session file's sticky firstSeenAt for a write whose previous file (if
// any) is `prev`: carried, else seeded from a pre-field file's last write
// (the best it can know), else now. Shared by update-state.js and the
// adapters: writeSessionState rebuilds an adapter's file from scratch, so
// without it any adapter write (codex-notify's turn end, the wrapper's)
// reset the field the foreign-session classifier relies on.
function firstSeenFor(prev, now) {
  if (prev && typeof prev.firstSeenAt === 'number' && prev.firstSeenAt > 0) return prev.firstSeenAt;
  if (prev && typeof prev.timestamp === 'number' && prev.timestamp > 0) return Math.min(prev.timestamp, now);
  return now;
}

// The daily bucket a moment falls in: the LOCAL calendar day, YYYY-MM-DD.
// It used to be the UTC day (toISOString), so "session N today" and "Xh Ym
// today" reset at 10:00 in Sydney and 17:00 in California.
function localDay(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// `countedDay` is the daily bucket (localDay, like stats.daily.date) in
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
  c.idleMs = num(c.idleMs, 0);
  c.lastSeen = num(c.lastSeen, now);
  // A pre-countedDay entry that was counted is taken as counted today:
  // counting it again right after an upgrade would be the worse error.
  if (typeof c.countedDay !== 'string') {
    c.countedDay = c.counted ? localDay(now) : '';
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

// `keepIds` (one id or an array) are never removed: the owner, and the
// session whose hook is running -- evicting that one re-counted it as a new
// session on every event.
function pruneCounters(map, keepIds, now) {
  const keep = new Set([].concat(keepIds || []));
  for (const id of Object.keys(map)) {
    const c = map[id];
    if (!c || typeof c !== 'object') { delete map[id]; continue; }
    if (!keep.has(id) && now - (c.lastSeen || 0) > COUNTER_MAX_AGE_MS) delete map[id];
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
    if (!keep.has(id) && !Array.isArray(map[id].activeSubagents)) delete map[id];
  }
}

// Fold a session's elapsed time, up to `end`, into the records and today's
// cumulative total. `creditedMs` remembers how much was already added, so
// crediting the same session at every turn end and every ownership switch
// never counts a millisecond twice. Shared by update-state.js and the
// adapters (which used to credit nothing at all).
function creditSession(stats, c, end) {
  if (!c || !c.start || !stats || !stats.records || !stats.daily) return;
  // Active time: a gap the session sat silent through (touchCounter) is
  // neither today's time nor part of how long it ran.
  const dur = end - c.start - (c.idleMs || 0);
  if (dur > (stats.records.longestSession || 0)) stats.records.longestSession = dur;
  const files = Array.isArray(c.filesEdited) ? c.filesEdited.length : 0;
  if (files > (stats.records.mostFilesEdited || 0)) stats.records.mostFilesEdited = files;
  const delta = dur - (c.creditedMs || 0);
  if (delta > 0) {
    stats.daily.cumulativeMs += delta;
    c.creditedMs = dur;
  }
}

// Where to stop crediting a session that is losing ownership: its own last
// activity. Crediting it up to "now" -- the moment ANOTHER session took over
// -- added a session that ended at 18:00 to the next morning's total (a
// Friday-to-Monday gap read "62h 59m today"). A live window's idle time is
// still counted, by its own next turn end.
function creditEndFor(c, now) {
  return Math.min(now, (c && c.lastSeen) || now);
}

// A session seen again after IDLE_GAP_MS of silence was not being worked in
// meanwhile: the gap goes to idleMs, which creditSession leaves out. Without
// it the same window, left open Friday to Monday, credited the whole weekend
// at its next turn end ("62h today", longestSession 64h) -- creditEndFor only
// covered a session losing ownership. Long enough that a silent tool call
// (a 40-minute build writes nothing between its Pre and Post) still counts.
const IDLE_GAP_MS = 2 * 60 * 60 * 1000;
function touchCounter(c, now) {
  if (!c) return;
  if (c.lastSeen && now - c.lastSeen > IDLE_GAP_MS) c.idleMs = (c.idleMs || 0) + (now - c.lastSeen);
  c.lastSeen = now;
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
  localDay,
  firstSeenFor,
  creditSession,
  creditEndFor,
  touchCounter,
  IDLE_GAP_MS,
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
  shellIntent,
  dropEchoedLines,
  scanWindow,
  SCAN_HEAD_BYTES,
  SCAN_TAIL_BYTES,
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
