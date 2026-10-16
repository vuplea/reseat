import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { projectDirectoryName } from "../src/claude.js";
import { projectDirectoryName as piProjectDirectoryName } from "../src/pi.js";
import {
  codexAgentEvent,
  codexMetaRecord,
  codexUserEvent,
  piHeaderRecord,
  piMessageEntries,
  temporaryStores,
  writeCodexFixture,
  writePiFixture,
} from "./helpers.js";

const BIN = fileURLToPath(new URL("../bin/reseat.js", import.meta.url));

function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--help and --version", () => {
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /reseat/);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, /--to <agents>/);

  const version = run(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("unknown option and bad --to/--from fail with exit code 1", () => {
  assert.equal(run(["--nope"]).code, 1);
  const badTo = run(["--to", "cursor"]);
  assert.equal(badTo.code, 1);
  assert.match(badTo.stderr, /--to expects/);
  const badFrom = run(["--from", "cursor"]);
  assert.equal(badFrom.code, 1);
  assert.match(badFrom.stderr, /--from expects/);
  assert.equal(run(["--to", "claude", "--from", "claude"]).code, 1);
});

test("sync codex→claude,pi end to end through the CLI, then a no-op re-run", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("ship the fix"),
    codexAgentEvent("shipped"),
  ]);

  const dry = run([stores.project, "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /Codex → Claude Code and Pi/);
  assert.match(dry.stdout, /Dry run/);

  const sync = run([stores.project]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.match(sync.stdout, /Take the seat:/);
  assert.match(sync.stdout, /claude --continue/);
  assert.match(sync.stdout, /pi -c/);
  const sessions = [...sync.stdout.matchAll(/session ([0-9a-f-]{36})/g)].map((m) => m[1]);
  assert.equal(sessions.length, 3, "the source and both created session ids must be logged");
  const writtenClaude = await readdir(path.join(stores.claudeProjects, projectDirectoryName(stores.project)));
  assert.equal(writtenClaude.length, 1);
  assert.equal(writtenClaude[0], `${sessions[1]}.jsonl`, "the logged created id must match the written session");
  const writtenPi = await readdir(path.join(stores.piSessions, piProjectDirectoryName(stores.project)));
  assert.ok(writtenPi[0].endsWith(`_${sessions[2]}.jsonl`), "the logged pi id must match the written session");

  const rerun = run([stores.project]);
  assert.equal(rerun.code, 0);
  assert.match(rerun.stdout, /Nothing to sync/);
});

test("forced targets via --to restrict the sync", async (t) => {
  const stores = await temporaryStores(t);
  await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...piMessageEntries([["user", "ship the fix"], ["assistant", "shipped"]]),
  ]);
  const sync = run([stores.project, "--to", "claude"]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.match(sync.stdout, /Pi → Claude Code/);
  assert.match(sync.stdout, /claude --continue/);
  assert.doesNotMatch(sync.stdout, /pi -c/);
  const writtenClaude = await readdir(path.join(stores.claudeProjects, projectDirectoryName(stores.project)));
  assert.equal(writtenClaude.length, 1);
  const writtenPi = await readdir(path.join(stores.piSessions, piProjectDirectoryName(stores.project)));
  assert.equal(writtenPi.length, 1, "no new pi session may be written");
});

test("forced source and comma-separated targets via --from/--to", async (t) => {
  const stores = await temporaryStores(t);
  await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...piMessageEntries([["user", "pi work"], ["assistant", "done"]]),
  ], { mtime: new Date("2026-07-26T09:00:00Z") });
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("codex work"),
  ], { mtime: new Date("2026-07-26T11:00:00Z") });

  const forcedFrom = run([stores.project, "--from", "pi", "--to", "claude"]);
  assert.equal(forcedFrom.code, 0, forcedFrom.stderr);
  assert.match(forcedFrom.stdout, /Pi → Claude Code/);

  // --to also fixes the source: the most recently active non-target side
  const forcedTo = run([stores.project, "--to", "claude"]);
  assert.equal(forcedTo.code, 0, forcedTo.stderr);
  assert.match(forcedTo.stdout, /Codex → Claude Code/);

  const comma = run([stores.project, "--to", "claude,pi"]);
  assert.equal(comma.code, 0, comma.stderr);
  assert.match(comma.stdout, /Codex → Claude Code and Pi/);
});

test("status shows all sides and the planned direction", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("ship the fix"),
  ]);
  const status = run(["status", stores.project]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Codex\s+“ship the fix”/);
  assert.match(status.stdout, /no sessions for this project/);
  assert.match(status.stdout, /Next sync: Codex → Claude Code and Pi/);
});

test("sync in a directory with no sessions explains itself", async (t) => {
  const stores = await temporaryStores(t);
  const result = run([stores.project]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No Claude Code, Codex, or Pi sessions with any conversation exist/);
});
