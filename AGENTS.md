# AGENTS.md

Project instructions for coding agents live in **[CLAUDE.md](CLAUDE.md)** — architecture, file layout, the
face state machine and its timing rules, hook events, tool mapping, testing, and code conventions.

Read that file first. It is the single source of truth; this stub exists so tools that look for an
`AGENTS.md` find their way there instead of drifting from a second copy (the previous fork of this file
had already fallen behind on the PID-liveness mechanism, the parallel-session classification, and the
test count).

Quick reference:

- `npm test` — run the suite (isolated from your real `~/.code-crumb*` files)
- `npm start` + `npm run demo` — see every face state
- Hook code (`update-state.js`, `adapters/`) must never throw and must finish in ~50ms
- Never write state files directly; use `writeJsonAtomic` from `shared.js`
