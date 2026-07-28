import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { projectDirectoryName } from "../src/claude.js";
import {
  codexAgentEvent,
  codexMetaRecord,
  codexUserEvent,
  temporaryStores,
  writeCodexFixture,
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

  const version = run(["--version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test("unknown option and bad --to fail with exit code 1", () => {
  assert.equal(run(["--nope"]).code, 1);
  const badTo = run(["--to", "cursor"]);
  assert.equal(badTo.code, 1);
  assert.match(badTo.stderr, /--to expects/);
});

test("sync codex→claude end to end through the CLI, then a no-op re-run", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("ship the fix"),
    codexAgentEvent("shipped"),
  ]);

  const dry = run([stores.project, "--dry-run"]);
  assert.equal(dry.code, 0);
  assert.match(dry.stdout, /Codex → Claude Code/);
  assert.match(dry.stdout, /Dry run/);

  const sync = run([stores.project]);
  assert.equal(sync.code, 0, sync.stderr);
  assert.match(sync.stdout, /Take the seat:/);
  assert.match(sync.stdout, /claude --continue/);
  const sessions = [...sync.stdout.matchAll(/session ([0-9a-f-]{36})/g)].map((m) => m[1]);
  assert.equal(sessions.length, 2, "both the source and created session ids must be logged");
  const written = await readdir(path.join(stores.claudeProjects, projectDirectoryName(stores.project)));
  assert.equal(written.length, 1);
  assert.equal(written[0], `${sessions[1]}.jsonl`, "the logged created id must match the written session");

  const rerun = run([stores.project]);
  assert.equal(rerun.code, 0);
  assert.match(rerun.stdout, /Nothing to sync/);
});

test("status shows both sides and the planned direction", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("ship the fix"),
  ]);
  const status = run(["status", stores.project]);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /Codex\s+“ship the fix”/);
  assert.match(status.stdout, /no sessions for this project/);
  assert.match(status.stdout, /Next sync: Codex → Claude Code/);
});

test("sync in a directory with no sessions explains itself", async (t) => {
  const stores = await temporaryStores(t);
  const result = run([stores.project]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No Claude Code or Codex sessions with any conversation exist/);
});
