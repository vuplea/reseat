import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { projectDirectoryName } from "../src/claude.js";
import { loadState } from "../src/state.js";
import { perform, plan } from "../src/sync.js";
import {
  claudeAssistantRecord,
  claudeUserRecord,
  codexAgentEvent,
  codexImportedRollout,
  codexMetaRecord,
  codexUserEvent,
  temporaryStores,
  writeClaudeFixture,
  writeCodexFixture,
  type Stores,
} from "./helpers.js";

function claudeConversation(stores: Stores, texts = ["hello", "hi there"]) {
  const [ask, reply] = texts;
  return [
    claudeUserRecord(ask, { cwd: stores.project }),
    claudeAssistantRecord(reply, { cwd: stores.project }),
  ];
}

test("plan: no sessions anywhere", async (t) => {
  const stores = await temporaryStores(t);
  const decision = await plan(stores.project);
  assert.ok(decision.action === "none");
  assert.equal(decision.reason, "no-sessions");
});

test("plan: first sync with one side present syncs that side", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writeClaudeFixture(
    stores,
    projectDirectoryName(stores.project),
    claudeConversation(stores),
  );
  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "claude");
  assert.equal(decision.target, "codex");
  assert.equal(decision.sourcePath, file);
});

test("plan: first sync with both sides present lets the newer side win", async (t) => {
  const stores = await temporaryStores(t);
  await writeClaudeFixture(stores, projectDirectoryName(stores.project), claudeConversation(stores), {
    mtime: new Date("2026-07-26T09:00:00Z"),
  });
  const rollout = await writeCodexFixture(
    stores,
    [codexMetaRecord(stores.project), codexUserEvent("newer work"), codexAgentEvent("done")],
    { mtime: new Date("2026-07-26T11:00:00Z") },
  );
  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "codex");
  assert.equal(decision.sourcePath, rollout);
  assert.equal(decision.bothChanged, true);
});

test("perform codex→claude writes a session and records state; re-plan is a no-op", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("please do X", "2026-07-26T10:01:00.000Z"),
    codexAgentEvent("X is done", "2026-07-26T10:02:00.000Z"),
  ]);
  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "codex");
  const created = await perform(stores.project, decision);
  const records = (await readFile(created.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map((record) => record.type), ["user", "assistant"]);
  assert.equal(records[0].message.content[0].text, "please do X");

  const state = await loadState();
  const key = Object.keys(state.projects)[0];
  assert.equal(state.projects[key]?.lastSync?.from, "codex");

  const again = await plan(stores.project);
  assert.ok(again.action === "none");
  assert.equal(again.reason, "unchanged");
});

test("plan after a sync: continuing the created Claude session syncs it back", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("please do X"),
    codexAgentEvent("X is done"),
  ]);
  const created = await perform(stores.project, await plan(stores.project));

  const records = (await readFile(created.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  records.push(claudeUserRecord("continued in claude", { cwd: stores.project }));
  await writeClaudeFixture(stores, projectDirectoryName(stores.project), records, {
    name: `${created.sessionId}.jsonl`,
  });

  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "claude");
});

test("plan without state: an unextended import never bounces back", async (t) => {
  const stores = await temporaryStores(t);
  await writeClaudeFixture(stores, projectDirectoryName(stores.project), claudeConversation(stores), {
    mtime: new Date("2026-07-26T09:00:00Z"),
  });
  await writeCodexFixture(stores, codexImportedRollout(stores.project), {
    mtime: new Date("2026-07-26T11:00:00Z"),
  });
  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "claude", "the import must not win; claude still has the only real work");
});

test("plan: forced direction requires a source and refuses a pure import", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [codexMetaRecord(stores.project), codexUserEvent("work")]);
  const missing = await plan(stores.project, { to: "codex" });
  assert.ok(missing.action === "none");
  assert.equal(missing.reason, "missing-source");

  const forced = await plan(stores.project, { to: "claude" });
  assert.ok(forced.action === "sync");
  assert.equal(forced.source, "codex");
});
