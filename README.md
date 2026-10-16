<p align="center"><img src="assets/logo.svg" width="120" alt="reseat logo: a session passing through a socket, changing color at the seam"></p>
<h1 align="center">reseat</h1>

<p align="center"><strong>Reseat your coding session in the other agent — Claude Code ⇄ Codex ⇄ pi.</strong></p>

<p align="center">
  <a href="https://github.com/vuplea/reseat/actions/workflows/test.yml"><img src="https://github.com/vuplea/reseat/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT">
</p>

You're deep in a task with Claude Code and hit your usage limit — or you just want Codex's or
pi's take on the same problem. `reseat` hands the newest session of your project to the other
agents, in any direction, as **native, resumable** sessions. Like reseating a component: pull
it out of one socket, seat it in the others — same part, better contact. By default the newest
session with new work is synced to **both** other agents at once.

The sync is pure local file work — **no model is invoked, no tokens are spent** — so it works
exactly when you need it: after the limit hit you.

```text
$ reseat
pi → Claude Code and Codex
  project  ~/repos/my-app
  source   ~/.pi/agent/sessions/--home-me-repos-my-app--/2026/07/26/….jsonl
           session 019f9f61-4729-72c2-9814-9672ac54deea
  created  Claude Code session 0ba5e819-7de4-4313-8776-fa7fc299e2b4
           ~/.claude/projects/-home-me-repos-my-app/0ba5e819….jsonl
           Codex session 1d53073a-84e1-4157-9d97-9f55bde5b49a
           ~/.codex/sessions/2026/07/26/rollout-…-1d53….jsonl

Take the seat:
  claude --continue
  codex resume --last
  pi -c
```

The reseat sessions are the newest ones on their sides, so taking a seat is always the same
short commands: **`codex resume --last`**, and **`claude --continue`** or **`pi -c`** (from the
project directory) after handing off to that agent. All session ids are printed — and kept
in reseat's state — if you ever need to resume an older handoff precisely.

Keep working in Codex. When you come back, `reseat` again — it notices Codex now has the
newer work and carries it back into Claude Code and pi.

## Install

```sh
npx github:vuplea/reseat   # run once in a project directory (needs git on PATH)
```

To keep it around as `reseat`, install from a clone. The clone *is* the install (npm links
it), so `git pull && npm install` inside it updates the command:

```sh
git clone https://github.com/vuplea/reseat && cd reseat && npm install && npm install -g .
```

`npm install -g github:vuplea/reseat` does **not** work: npm builds git packages through a
nested install that runs in global mode, so the TypeScript toolchain is never present.

Runs anywhere Node.js 20+ runs (CI covers Linux and Windows). The only other
requirement is the [Codex](https://github.com/openai/codex) CLI, and only for
syncs that target Codex — recent enough to expose the app-server import API
(validated with codex-cli 0.144 through 0.153; an older Codex fails fast with
a clear message). Claude Code and pi are never invoked; reseat just reads and
writes their session files. (pi support validated with pi 0.85.)

## Usage

```text
reseat [sync] [project-dir] [options]   sync the project (default: current directory)
reseat status [project-dir]             show all sides and what a sync would do

  -n, --dry-run       preview without creating anything
      --to <agents>   force the targets, comma-separated: "claude", "codex", "pi"
                       (default: both other agents)
      --from <agent>  force the source agent (default: the most recently active one)
  -h, --help          show help          -V, --version    show the version
```

`reseat` looks at the newest session on each side for the project, figures out which one has
new work since the last sync, and recreates it on the other sides — both of them by default,
or just the ones `--to` names (`--to pi`, `--to codex,claude`). Run it whenever you want to
switch seats; it's a no-op when there's nothing new.

## How it works

- **→ Codex** goes through Codex's own app-server import API — the same machinery
  Codex uses to migrate sessions on first run. Codex itself creates the rollout, the thread
  database entry, and the visible turn history, so the thread shows up in `codex resume`'s
  picker and survives Codex storage changes. (Tools that instead reverse-engineer Codex's
  session store break when it evolves — that's how sessions ended up in SQLite but invisible
  to the picker.) The importer only accepts Claude-format files under
  `<home>/.claude/projects`, so a pi source travels through a temporary Claude session that
  is deleted again after the import.
- **→ Claude Code** converts the source conversation into Claude Code's session JSONL,
  which `claude --resume` picks up natively.
- **→ pi** converts the source conversation into pi's session JSONL — a v3 header, a
  chain of `message` entries, and a session name — which `pi -c` and `pi --session` pick
  up natively. Sessions reseat writes are closed with an invisible marker entry, so they
  are never mistaken for new work.
- Codex subagent threads run in the project's cwd too; they never count as the project's
  session — only the thread you talk to does.
- Per-project state (fingerprints of the last-synced sessions) prevents a fresh import from
  bouncing straight back, and sessions reseat created are marked so they never count as new
  work until you actually continue them.

What carries over is the **conversation** — your prompts and the agents' replies, in every
direction — and a text record of tool use: Codex's importer renders Claude Code's tool calls
and results as tagged messages, and reseat renders Codex's commands and their output (capped
at 8 KB per call) the same way going back. Neither agent can replay another's tools, so
nothing is re-executed and permissions don't transfer; your files on disk are already the
shared ground truth. pi sessions are followed along their active branch, so abandoned
branches stay behind; thinking stays behind everywhere.

No existing session is ever modified or deleted: reseat only creates new sessions on the
target sides (plus its own small state file, and — via the import — Codex's usual thread
records; the one exception is reseat's own temporary import file, deleted right after the
import). Everything stays on your machine.

## FAQ

**Does syncing cost tokens?** No. Every direction is a local file transformation; Codex's
import API doesn't call a model either. Tokens are spent only when you resume and continue
the conversation — and the imported history then counts toward that first prompt's input,
as with any long session.

**Why not just re-explain the task?** Ten minutes of context, decisions, and dead ends per
handoff, every time. A synced session keeps all of it.

**Several sides changed — what happens?** The side modified most recently wins, and its
session is handed to both other sides. Force a different pair with `--from`/`--to` (e.g.
`--from codex --to pi`); a forced sync that would only duplicate an unchanged handoff is
refused as already-synced.

**Validated how?** Unit tests on fixtures matching the real formats, a sandboxed end-to-end
suite that drives the real `codex app-server` and loads results with pi's real session
loader (`tools/e2e.ts`), live `codex exec resume` / `claude --resume` round-trips, and a
read-only sweep of a real machine's stores (100 Codex rollouts, 222 Claude Code sessions,
70 pi sessions — zero parse failures). Format assumptions were checked against the codex-rs
source, real rollouts, and pi's own session-manager, with Claude Code 2.1, codex-cli 0.144
through 0.153, and pi 0.85. Please open an issue if your platform or version misbehaves.

**What if I run it twice at once?** Don't — there's deliberately no cross-process lock (it's
a manual CLI); the worst case is a duplicate session on a target side.

## Environment overrides

reseat honors the agents' own relocation variables — `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and
`PI_CODING_AGENT_DIR` — so a relocated store is found automatically and stays consistent
with where the agents actually write. `RESEAT_CLAUDE_PROJECTS`, `RESEAT_CODEX_SESSIONS`,
`RESEAT_PI_SESSIONS`, and `RESEAT_STATE` override individual locations on top of that
(reading only — the Codex import always writes to `CODEX_HOME`; pi's own
`PI_CODING_AGENT_SESSION_DIR` flattens the store and is deliberately not honored). One
Codex-side constraint: imports are only accepted from session files under
`<home>/.claude/projects`, so a fully relocated Claude store also needs `HOME` adjusted for
syncs that target Codex.

## Development

Written in TypeScript, compiled with `tsc` into `dist/`; the published package ships the
compiled JavaScript and keeps zero runtime dependencies.

```sh
npm install           # pulls the TypeScript toolchain and builds dist/
npm test              # compile + unit tests (node:test)
npm run e2e           # sandboxed end-to-end run against the real codex CLI; costs no tokens
```

The e2e suite redirects all three agents' stores (via `RESEAT_*`, `CODEX_HOME`,
`PI_CODING_AGENT_DIR`, `HOME`) into a temporary directory, so it never touches your real
session history.

## License

[MIT](LICENSE)
