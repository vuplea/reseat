import assert from "node:assert/strict";
import { test } from "node:test";
import {
  extractTitle,
  inspectRollout,
  isUnextendedImport,
  latestRollout,
  parseTurns,
} from "../src/codex.js";
import {
  codexAgentEvent,
  codexAgentItem,
  codexImportedRollout,
  codexMetaRecord,
  codexResponseItem,
  codexUserEvent,
  codexUserItem,
  temporaryStores,
  writeCodexFixture,
} from "./helpers.js";

test("parseTurns prefers event messages and merges consecutive same-role turns", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexResponseItem("user", "<user_instructions>ignored</user_instructions>"),
    codexUserEvent("first ask", "2026-07-26T10:01:00.000Z"),
    codexAgentEvent("part one"),
    codexAgentEvent("part two"),
    codexUserEvent("second ask", "2026-07-26T10:05:00.000Z"),
  ]);
  const turns = await parseTurns(file);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ["user", "first ask"],
    ["assistant", "part one\n\npart two"],
    ["user", "second ask"],
  ]);
  assert.equal(turns[0].timestamp, "2026-07-26T10:01:00.000Z");
});

test("parseTurns falls back to response items and drops injected user context", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexResponseItem("user", "<environment_context>noise</environment_context>"),
    codexResponseItem("developer", "system stuff"),
    codexResponseItem("user", "real question"),
    codexResponseItem("assistant", "real answer"),
  ]);
  const turns = await parseTurns(file);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ["user", "real question"],
    ["assistant", "real answer"],
  ]);
});

test("parseTurns reads item_completed turns (codex-cli 0.147+) over the response items", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writeCodexFixture(stores, [
    codexMetaRecord(stores.project, { cli_version: "0.153.4" }),
    codexResponseItem("user", "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nrules\n</INSTRUCTIONS>"),
    codexResponseItem("user", "real question"),
    codexUserItem("real question"),
    codexResponseItem("assistant", "real answer"),
    codexAgentItem("real answer"),
    codexAgentItem("Which runtime should this target?"),
  ]);
  const turns = await parseTurns(file);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ["user", "real question"],
    ["assistant", "real answer\n\nWhich runtime should this target?"],
  ]);
});

test("latestRollout matches on normalized cwd and picks the newest", async (t) => {
  const stores = await temporaryStores(t);
  await writeCodexFixture(stores, [codexMetaRecord("/somewhere/else"), codexUserEvent("x")], {
    mtime: new Date("2026-07-26T12:00:00Z"),
  });
  const older = await writeCodexFixture(stores, [codexMetaRecord(stores.project), codexUserEvent("a")], {
    mtime: new Date("2026-07-26T09:00:00Z"),
  });
  const newest = await writeCodexFixture(stores, [codexMetaRecord(stores.project), codexUserEvent("b")], {
    mtime: new Date("2026-07-26T11:00:00Z"),
  });
  assert.equal(await latestRollout(stores.project), newest);
  assert.notEqual(older, newest);
});

test("latestRollout skips subagent threads, which share the project's cwd", async (t) => {
  const stores = await temporaryStores(t);
  const main = await writeCodexFixture(stores, [codexMetaRecord(stores.project), codexUserItem("a")], {
    mtime: new Date("2026-07-26T09:00:00Z"),
  });
  await writeCodexFixture(stores, [
    codexMetaRecord(stores.project, { thread_source: "subagent", source: { subagent: { thread_spawn: { depth: 1 } } } }),
    codexAgentItem("working on the subtask"),
  ], { mtime: new Date("2026-07-26T11:00:00Z") });
  assert.equal(await latestRollout(stores.project), main);
});

test("inspectRollout reads the session_meta header", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writeCodexFixture(stores, [
    codexMetaRecord(stores.project, { id: "0000-1111", originator: "codex-tui", source: "cli" }),
  ]);
  const meta = await inspectRollout(file);
  assert.equal(meta.id, "0000-1111");
  assert.equal(meta.cwd, stores.project);
  assert.equal(meta.originator, "codex-tui");
  assert.equal(meta.source, "cli");
  assert.equal(meta.threadSource, "user");
});

test("extractTitle uses the first real user prompt", async (t) => {
  const stores = await temporaryStores(t);
  for (const prompt of [codexUserEvent, codexUserItem]) {
    const file = await writeCodexFixture(stores, [
      codexMetaRecord(stores.project),
      codexResponseItem("user", "<user_instructions>skip me</user_instructions>"),
      prompt("  please   fix\nthe build "),
    ]);
    assert.equal(await extractTitle(file), "please fix the build");
  }
});

test("isUnextendedImport: reseat import is pure until a prompt lands after the marker", async (t) => {
  const stores = await temporaryStores(t);
  const pureImport = await writeCodexFixture(stores, codexImportedRollout(stores.project));
  assert.equal(await isUnextendedImport(pureImport), true);

  for (const prompt of [codexUserEvent, codexUserItem]) {
    const extended = await writeCodexFixture(stores, [...codexImportedRollout(stores.project), prompt("continued in codex")]);
    assert.equal(await isUnextendedImport(extended), false);
  }

  const native = await writeCodexFixture(stores, [
    codexMetaRecord(stores.project),
    codexUserEvent("hello"),
  ]);
  assert.equal(await isUnextendedImport(native), false);
});

test("parseTurns drops Codex's end-of-import marker", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writeCodexFixture(stores, [
    ...codexImportedRollout(stores.project, [["user", "imported ask"], ["assistant", "imported reply"]]),
    codexUserItem("new ask"),
    codexAgentItem("new reply"),
  ]);
  const turns = await parseTurns(file);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ["user", "imported ask"],
    ["assistant", "imported reply"],
    ["user", "new ask"],
    ["assistant", "new reply"],
  ]);
});
