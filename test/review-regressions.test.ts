import assert from "node:assert/strict";
import { appendFile, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { latestSession, projectDirectoryName } from "../src/claude.js";
import { latestRollout, parseTurns } from "../src/codex.js";
import { perform, plan } from "../src/sync.js";
import {
  claudeUserRecord,
  codexAgentEvent,
  codexMetaRecord,
  codexResponseItem,
  codexUserEvent,
  temporaryStores,
  writeClaudeFixture,
  writeCodexFixture,
} from "./helpers.js";

test("an opened-and-abandoned Codex rollout (session_meta only) never becomes the sync source", async (t) => {
  const stores = await temporaryStores(t);
  const claudeFile = await writeClaudeFixture(
    stores,
    projectDirectoryName(stores.project),
    [claudeUserRecord("real work", { cwd: stores.project })],
    { mtime: new Date("2026-07-26T09:00:00Z") },
  );
  await writeCodexFixture(stores, [codexMetaRecord(stores.project)], {
    mtime: new Date("2026-07-26T11:00:00Z"),
  });
  assert.equal(await latestRollout(stores.project), null);
  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "claude");
  assert.equal(decision.sourcePath, claudeFile);
});

test("an empty or prompt-less newest Claude session falls back to the newest one with conversation", async (t) => {
  const stores = await temporaryStores(t);
  const name = projectDirectoryName(stores.project);
  const real = await writeClaudeFixture(stores, name, [claudeUserRecord("real work")], {
    mtime: new Date("2026-07-26T09:00:00Z"),
  });
  await writeClaudeFixture(stores, name, [{ type: "mode", mode: "normal", sessionId: "x" }], {
    mtime: new Date("2026-07-26T11:00:00Z"),
  });
  await writeClaudeFixture(stores, name, [], { mtime: new Date("2026-07-26T12:00:00Z") });
  assert.equal(await latestSession(stores.project), real);
});

test("a prompt landing between plan and perform is transferred, not lost", async (t) => {
  const stores = await temporaryStores(t);
  const rollout = await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("first"),
    codexAgentEvent("done"),
  ]);
  const decision = await plan(stores.project);
  await appendFile(rollout, `${JSON.stringify({
    timestamp: "2026-07-26T10:09:00.000Z",
    type: "event_msg",
    payload: { type: "user_message", message: "landed mid-sync" },
  })}\n`);
  await utimes(rollout, new Date(), new Date());
  const created = await perform(stores.project, decision);
  const written = await readFile(created.file, "utf8");
  assert.match(written, /landed mid-sync/, "the late turn must be carried over");
  const again = await plan(stores.project);
  assert.equal(again.action, "none", "and the sync must be recorded as complete");
});

test("forcing an unchanged source again reports already-synced instead of duplicating", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("work"),
    codexAgentEvent("done"),
  ]);
  const first = await plan(stores.project, { to: "claude" });
  assert.ok(first.action === "sync");
  const created = await perform(stores.project, first);

  const second = await plan(stores.project, { to: "claude" });
  assert.ok(second.action === "none");
  assert.equal(second.reason, "already-synced");
  assert.equal(second.createdSessionId, created.sessionId);
  const files = await readdir(path.join(stores.claudeProjects, projectDirectoryName(stores.project)));
  assert.equal(files.length, 1, "no duplicate session may be written");
});

test("a genuine user prompt starting with markup survives the response-item fallback", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexResponseItem("user", "<user_instructions>injected</user_instructions>"),
    codexResponseItem("user", "<task>fix the parser</task>"),
    codexResponseItem("assistant", "on it"),
  ]);
  const turns = await parseTurns(file);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ["user", "<task>fix the parser</task>"],
    ["assistant", "on it"],
  ]);
});

test("a JSONL line containing null does not crash the readers", async (t) => {
  const stores = await temporaryStores(t);
  const name = projectDirectoryName(stores.project);
  const file = await writeClaudeFixture(stores, name, [claudeUserRecord("fine")]);
  await writeFile(file, `null\n${JSON.stringify(claudeUserRecord("fine"))}\n`, "utf8");
  assert.equal(await latestSession(stores.project), file);
});
