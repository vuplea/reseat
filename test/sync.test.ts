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
  piHeaderRecord,
  piImportedSession,
  piMessageEntries,
  temporaryStores,
  writeClaudeFixture,
  writeCodexFixture,
  writePiFixture,
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

test("plan: first sync with one side present hands it to both other sides", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writeClaudeFixture(
    stores,
    projectDirectoryName(stores.project),
    claudeConversation(stores),
  );
  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "claude");
  assert.deepEqual(decision.targets, ["codex", "pi"]);
  assert.equal(decision.sourcePath, file);
});

test("plan: first sync with several sides present lets the newest side win", async (t) => {
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
  assert.deepEqual(decision.targets, ["claude", "pi"]);
  assert.equal(decision.sourcePath, rollout);
  assert.equal(decision.bothChanged, true);
});

test("perform codex→claude,pi writes both sessions and records state; re-plan is a no-op", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("please do X", "2026-07-26T10:01:00.000Z"),
    codexAgentEvent("X is done", "2026-07-26T10:02:00.000Z"),
  ]);
  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "codex");
  assert.deepEqual(decision.targets, ["claude", "pi"]);
  const created = await perform(stores.project, decision);
  assert.deepEqual(Object.keys(created).sort(), ["claude", "pi"]);

  const claudeRecords = (await readFile(created.claude!.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(claudeRecords.map((record) => record.type), ["user", "assistant"]);
  assert.equal(claudeRecords[0].message.content[0].text, "please do X");

  const piEntries = (await readFile(created.pi!.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(piEntries[0].type, "session");
  assert.equal(piEntries[0].cwd, stores.project);
  assert.deepEqual(
    piEntries.filter((entry) => entry.type === "message").map((entry) => entry.message.role),
    ["user", "assistant"],
  );

  const state = await loadState();
  const key = Object.keys(state.projects)[0];
  assert.equal(state.projects[key]?.lastSync?.from, "codex");
  assert.deepEqual(state.projects[key]?.lastSync?.to, ["claude", "pi"]);

  const again = await plan(stores.project);
  assert.ok(again.action === "none");
  assert.equal(again.reason, "unchanged");
});

test("plan after a sync: continuing the created session syncs it to both other sides", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("please do X"),
    codexAgentEvent("X is done"),
  ]);
  const created = await perform(stores.project, await plan(stores.project));

  const records = (await readFile(created.claude!.file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  records.push(claudeUserRecord("continued in claude", { cwd: stores.project }));
  await writeClaudeFixture(stores, projectDirectoryName(stores.project), records, {
    name: `${created.claude!.sessionId}.jsonl`,
  });

  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "claude");
  assert.deepEqual(decision.targets, ["codex", "pi"]);
});

test("plan: forced targets restrict where the session goes", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("work"),
    codexAgentEvent("done"),
  ]);
  const decision = await plan(stores.project, { to: ["pi"] });
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "codex");
  assert.deepEqual(decision.targets, ["pi"]);
});

test("plan: forced source with forced targets", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("codex work"),
    codexAgentEvent("done"),
  ]);
  await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...piMessageEntries([["user", "pi work"], ["assistant", "done"]]),
  ], { mtime: new Date("2026-07-26T11:00:00Z") });
  const decision = await plan(stores.project, { from: "codex", to: ["pi"] });
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "codex");
  assert.deepEqual(decision.targets, ["pi"]);
});

test("plan: forced source defaults to both other targets", async (t) => {
  const stores = await temporaryStores(t);
  await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...piMessageEntries([["user", "pi work"], ["assistant", "done"]]),
  ]);
  const decision = await plan(stores.project, { from: "pi" });
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "pi");
  assert.deepEqual(decision.targets, ["claude", "codex"]);
});

test("plan without state: an unextended import never bounces back", async (t) => {
  const stores = await temporaryStores(t);
  await writeClaudeFixture(stores, projectDirectoryName(stores.project), claudeConversation(stores), {
    mtime: new Date("2026-07-26T09:00:00Z"),
  });
  await writeCodexFixture(stores, codexImportedRollout(stores.project), {
    mtime: new Date("2026-07-26T11:00:00Z"),
  });
  await writePiFixture(stores, piImportedSession(stores.project), {
    mtime: new Date("2026-07-26T12:00:00Z"),
  });
  const decision = await plan(stores.project);
  assert.ok(decision.action === "sync");
  assert.equal(decision.source, "claude", "the imports must not win; claude still has the only real work");
});

test("plan: forced targets require a source and refuse a pure import", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [codexMetaRecord(stores.project), codexUserEvent("work")]);
  const missing = await plan(stores.project, { to: ["codex"] });
  assert.ok(missing.action === "none");
  assert.equal(missing.reason, "missing-source");

  const forced = await plan(stores.project, { to: ["claude"] });
  assert.ok(forced.action === "sync");
  assert.equal(forced.source, "codex");
  assert.deepEqual(forced.targets, ["claude"]);
});

test("plan: a forced target whose only sources are imports refuses to duplicate", async (t) => {
  const stores = await temporaryStores(t);
  await writePiFixture(stores, piImportedSession(stores.project));
  const decision = await plan(stores.project, { to: ["codex"] });
  assert.ok(decision.action === "none");
  assert.equal(decision.reason, "source-is-import");
  assert.equal(decision.source, "pi");
});
