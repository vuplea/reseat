<p align="center"><img src="assets/logo.svg" width="120" alt="reseat logo: a session passing through a socket, changing color at the seam"></p>
<h1 align="center">reseat</h1>

<p align="center"><strong>Reseat your coding session in the other agent — Claude Code ⇄ Codex.</strong></p>

<p align="center">
  <a href="https://github.com/vuplea/reseat/actions/workflows/test.yml"><img src="https://github.com/vuplea/reseat/actions/workflows/test.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node >= 20">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License MIT">
</p>

You're deep in a task with Claude Code and hit your usage limit — or you just want Codex's
take on the same problem. `reseat` hands the newest session of your project to the other
agent, in either direction, as a **native, resumable** session. Like reseating a component:
pull it out of one socket, seat it in the other — same part, better contact.

The sync is pure local file work — **no model is invoked, no tokens are spent** — so it works
exactly when you need it: after the limit hit you.

```text
$ reseat
Claude Code → Codex
  project  ~/repos/my-app
  source   ~/.claude/projects/-home-me-repos-my-app/8f3a….jsonl
           session 8f3a1c2d-79b4-4303-baf8-5d05dc184713
  created  ~/.codex/sessions/2026/07/26/rollout-…-019f….jsonl
           session 019f9f61-4729-72c2-9814-9672ac54deea

Take the seat:
  codex resume --last
```

The reseat session is the newest one on the target side, so taking the seat is always the
same two commands: **`codex resume --last`** after handing off to Codex, and
**`claude --continue`** (from the project directory) after handing off to Claude Code.
Both session ids are printed — and kept in reseat's state — if you ever need to resume an
older handoff precisely.

Keep working in Codex. When you come back, `reseat` again — it notices Codex now has the
newer work and carries it back into Claude Code.

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
the Claude Code → Codex direction — recent enough to expose the app-server
import API (validated with codex-cli 0.144 through 0.153; an older Codex fails fast with a
clear message). Claude Code itself is never invoked; reseat just reads and
writes its session files.

## Usage

```text
reseat [sync] [project-dir] [options]   sync the project (default: current directory)
reseat status [project-dir]             show both sides and what a sync would do

  -n, --dry-run     preview without creating anything
      --to <agent>  force the direction: "claude" or "codex"
  -h, --help        show help          -V, --version    show the version
```

`reseat` looks at the newest session on each side for the project, figures out which one has
new work since the last sync, and recreates it on the other side. Run it whenever you want to
switch seats; it's a no-op when there's nothing new.

## How it works

- **Claude Code → Codex** goes through Codex's own app-server import API — the same machinery
  Codex uses to migrate sessions on first run. Codex itself creates the rollout, the thread
  database entry, and the visible turn history, so the thread shows up in `codex resume`'s
  picker and survives Codex storage changes. (Tools that instead reverse-engineer Codex's
  session store break when it evolves — that's how sessions ended up in SQLite but invisible
  to the picker.)
- **Codex → Claude Code** converts the rollout's visible conversation into Claude Code's
  session JSONL, which `claude --resume` picks up natively.
- Codex subagent threads run in the project's cwd too; they never count as the project's
  session — only the thread you talk to does.
- Per-project state (fingerprints of the last-synced sessions) prevents a fresh import from
  bouncing straight back, and sessions reseat created are marked so they never count as new
  work until you actually continue them.

What carries over is the **conversation** — your prompts and the agent's replies, in both
directions. Tool calls, diffs, and permissions don't transfer (the two CLIs' tool models are
incompatible); your files on disk are already the shared ground truth, and the incoming agent
re-reads what it needs.

No existing session is ever modified or deleted: reseat only creates new sessions on the
target side (plus its own small state file, and — via the import — Codex's usual thread
records). Everything stays on your machine.

## FAQ

**Does syncing cost tokens?** No. Both directions are local file transformations; Codex's
import API doesn't call a model either. Tokens are spent only when you resume and continue
the conversation — and the imported history then counts toward that first prompt's input,
as with any long session.

**Why not just re-explain the task?** Ten minutes of context, decisions, and dead ends per
handoff, every time. A synced session keeps all of it.

**Both sides changed — what happens?** The side modified most recently wins. Force the other
way with `--to`.

**Validated how?** Unit tests on fixtures matching the real formats, a sandboxed end-to-end
suite that drives the real `codex app-server` (`tools/e2e.ts`), live `codex exec resume` /
`claude --resume` round-trips, and a read-only sweep of a real machine's stores (100 Codex
rollouts, 222 Claude Code sessions — zero parse failures). Format assumptions were checked
against the codex-rs source and real rollouts, with Claude Code 2.1 and codex-cli 0.144
through 0.153. Please open an issue if your platform or version misbehaves.

**What if I run it twice at once?** Don't — there's deliberately no cross-process lock (it's
a manual CLI); the worst case is a duplicate session on the target side.

## Environment overrides

reseat honors the agents' own relocation variables — `CODEX_HOME` and `CLAUDE_CONFIG_DIR` —
so a relocated store is found automatically and stays consistent with where Codex actually
writes. `RESEAT_CLAUDE_PROJECTS`, `RESEAT_CODEX_SESSIONS`, and `RESEAT_STATE` override
individual locations on top of that (reading only — the Codex import always writes to
`CODEX_HOME`). One Codex-side constraint: imports are only accepted from session files under
`<home>/.claude/projects`, so a fully relocated Claude store also needs `HOME` adjusted for
the Claude → Codex direction.

## Development

Written in TypeScript, compiled with `tsc` into `dist/`; the published package ships the
compiled JavaScript and keeps zero runtime dependencies.

```sh
npm install           # pulls the TypeScript toolchain and builds dist/
npm test              # compile + unit tests (node:test)
npm run e2e           # sandboxed end-to-end run against the real codex CLI; costs no tokens
```

The e2e suite redirects both agents' stores (via `RESEAT_*`, `CODEX_HOME`, `HOME`) into a
temporary directory, so it never touches your real session history.

## License

[MIT](LICENSE)
