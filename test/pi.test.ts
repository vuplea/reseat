import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  IMPORT_MARKER,
  extractTitle,
  isUnextendedImport,
  latestSession,
  parseTurns,
  projectDirectoryName,
  sessionId,
  writeSession,
} from "../src/pi.js";
import type { Turn } from "../src/types.js";
import {
  piHeaderRecord,
  piImportMarkerEntry,
  piImportedSession,
  piMessageEntries,
  piMessageEntry,
  temporaryStores,
  writePiFixture,
} from "./helpers.js";

test("projectDirectoryName mirrors pi's own encoding (separators only, wrapped in dashes)", () => {
  if (process.platform === "win32") {
    // On Windows a Unix-style absolute path resolves against the current drive.
    assert.equal(projectDirectoryName("D:\\Desktop\\Repos\\reseat"), "--D--Desktop-Repos-reseat--");
    assert.equal(projectDirectoryName("E:\\Repos\\_enc.test_dir"), "--E--Repos-_enc.test_dir--");
    assert.equal(projectDirectoryName("C:/fwd/slashes"), "--C--fwd-slashes--");
  } else {
    assert.equal(projectDirectoryName("/home/u/repos/app"), "--home-u-repos-app--");
    assert.equal(projectDirectoryName("/home/u/repos/a.b_c d"), "--home-u-repos-a.b_c d--");
  }
});

test("sessionId reads the id pi names the file after", () => {
  const id = "01a1445a-8ad6-74ab-863d-5dea767431e0";
  assert.equal(sessionId(path.join("sessions", `2026-10-16T10-55-46-902Z_${id}.jsonl`)), id);
});

test("parseTurns follows the active branch, skipping thinking and tool traffic", async (t) => {
  const stores = await temporaryStores(t);
  const first = piMessageEntry("user", "first ask", { id: "aaaa0001" });
  const answer = piMessageEntry("assistant", "answer", { id: "aaaa0002", parentId: "aaaa0001" });
  const abandoned = piMessageEntry("user", "an abandoned branch, never answered", { parentId: "aaaa0001" });
  const followUp = piMessageEntry("user", "real follow-up", { id: "aaaa0004", parentId: "aaaa0002" });
  const last = piMessageEntry("assistant", "final answer", { id: "aaaa0005", parentId: "aaaa0004" });
  const file = await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    first,
    answer,
    abandoned, // a side branch off the first entry, in file order but off the path
    followUp,
    last,
  ]);
  const turns = await parseTurns(file);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ["user", "first ask"],
    ["assistant", "answer"],
    ["user", "real follow-up"],
    ["assistant", "final answer"],
  ]);
});

test("parseTurns merges consecutive same-role turns and drops thinking-only replies", async (t) => {
  const stores = await temporaryStores(t);
  const file = await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    piMessageEntry("user", "part one", { id: "aaaa0001" }),
    piMessageEntry("user", "part two", { id: "aaaa0002", parentId: "aaaa0001" }),
    {
      type: "message", id: "aaaa0003", parentId: "aaaa0002", timestamp: "2026-07-26T10:02:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal reasoning must not transfer" },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
        ],
        api: "test", provider: "test", model: "test-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
        stopReason: "stop", timestamp: Date.now(),
      },
    },
    piMessageEntry("assistant", "actual reply", { id: "aaaa0004", parentId: "aaaa0003" }),
  ]);
  const turns = await parseTurns(file);
  assert.deepEqual(turns.map((turn) => [turn.role, turn.text]), [
    ["user", "part one\n\npart two"],
    ["assistant", "actual reply"],
  ]);
  assert.ok(!turns.some((turn) => turn.text.includes("internal reasoning")));
});

test("parseTurns skips bash executions, tool results, and non-message entries", async (t) => {
  const stores = await temporaryStores(t);
  const turns = piMessageEntries([["user", "run the tests"]]);
  const file = await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...turns,
    {
      type: "message", id: "abcd0002", parentId: String(turns.at(-1)!.id), timestamp: "2026-07-26T10:02:00.000Z",
      message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false },
    },
    {
      type: "message", id: "abcd0003", parentId: "abcd0002", timestamp: "2026-07-26T10:03:00.000Z",
      message: { role: "bashExecution", command: "npm test", output: "ok", exitCode: 0, cancelled: false, truncated: false },
    },
    { type: "model_change", id: "abcd0004", parentId: "abcd0003", timestamp: "2026-07-26T10:04:00.000Z", provider: "test", modelId: "test-model" },
    { type: "compaction", id: "abcd0005", parentId: "abcd0004", timestamp: "2026-07-26T10:05:00.000Z", summary: "summarized history", tokensBefore: 50000 },
    piMessageEntry("assistant", "they pass", { parentId: "abcd0005" }),
  ]);
  assert.deepEqual((await parseTurns(file)).map((turn) => [turn.role, turn.text]), [
    ["user", "run the tests"],
    ["assistant", "they pass"],
  ]);
});

test("extractTitle prefers the session name over the first prompt", async (t) => {
  const stores = await temporaryStores(t);
  const turns = piMessageEntries([["user", "first prompt here"], ["assistant", "hi"]]);
  const named = await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...turns,
    { type: "session_info", id: "abcd0006", parentId: String(turns.at(-1)!.id), timestamp: "2026-07-26T10:06:00.000Z", name: "Refactor auth module" },
  ]);
  assert.equal(await extractTitle(named), "Refactor auth module");

  const unnamed = await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...piMessageEntries([["user", "  fix   the\nbuild  "], ["assistant", "done"]]),
  ]);
  assert.equal(await extractTitle(unnamed), "fix the build");
});

test("isUnextendedImport: true for a fresh import, false once continued or native", async (t) => {
  const stores = await temporaryStores(t);
  const pure = await writePiFixture(stores, piImportedSession(stores.project));
  assert.equal(await isUnextendedImport(pure), true);

  const messages = piMessageEntries([["user", "x"], ["assistant", "y"]]);
  const marker = piImportMarkerEntry(String(messages.at(-1)!.id));
  const continued = await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...messages,
    marker,
    piMessageEntry("user", "continued in pi", { parentId: String(marker.id) }),
  ]);
  assert.equal(await isUnextendedImport(continued), false);

  const native = await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...piMessageEntries([["user", "hello"], ["assistant", "hi"]]),
  ]);
  assert.equal(await isUnextendedImport(native), false);
});

test("latestSession skips opened-and-abandoned sessions", async (t) => {
  const stores = await temporaryStores(t);
  await writePiFixture(stores, [piHeaderRecord(stores.project)], {
    mtime: new Date("2026-07-26T12:00:00Z"),
  });
  const real = await writePiFixture(stores, [
    piHeaderRecord(stores.project),
    ...piMessageEntries([["user", "hello"]]),
  ], { mtime: new Date("2026-07-26T09:00:00Z") });
  assert.equal(await latestSession(stores.project), real);
});

test("writeSession produces a loadable, marker-closed session", async (t) => {
  const stores = await temporaryStores(t);
  const turns: Turn[] = [
    { role: "user", text: "hello", timestamp: "2026-07-26T10:00:00.000Z" },
    { role: "assistant", text: "hi", timestamp: "2026-07-26T10:00:01.000Z" },
  ];
  const { file, sessionId: id } = await writeSession(turns, stores.project, { title: "My task" });
  const entries = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

  const header = entries[0];
  assert.equal(header.type, "session");
  assert.equal(header.version, 3);
  assert.equal(header.id, id);
  assert.equal(header.cwd, path.resolve(stores.project));
  assert.match(path.basename(file), /^\d{4}-\d{2}-\d{2}T[0-9-]+Z_[0-9a-f-]{36}\.jsonl$/);
  assert.equal(sessionId(file), id);

  const messages = entries.filter((entry) => entry.type === "message");
  assert.deepEqual(messages.map((entry) => entry.message.role), ["user", "assistant"]);
  assert.equal(messages[0].parentId, null);
  assert.equal(messages[1].parentId, messages[0].id);
  assert.equal(messages[0].message.content[0].text, "hello");
  const assistant = messages[1].message;
  assert.equal(assistant.content[0].text, "hi");
  assert.equal(assistant.usage.totalTokens, 0, "usage must be present and zeroed");
  assert.equal(assistant.stopReason, "stop");

  const info = entries.find((entry) => entry.type === "session_info");
  assert.equal(info.name, "My task");

  const marker = entries.at(-1)!;
  assert.equal(marker.type, "custom");
  assert.equal(marker.customType, IMPORT_MARKER);
  assert.equal(await isUnextendedImport(file), true);
  assert.equal(await extractTitle(file), "My task");
});
