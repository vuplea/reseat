#!/usr/bin/env node

/**
 * End-to-end smoke test against the real Codex CLI and pi's session store,
 * fully sandboxed.
 *
 * Everything is redirected into a temporary directory: reseat's stores via
 * RESEAT_* variables, Codex itself via CODEX_HOME, and pi via
 * PI_CODING_AGENT_DIR, so the run leaves no trace in real session history
 * on any side. Requires `codex` on PATH. No model is ever invoked; the run
 * costs no tokens.
 *
 *   npm run e2e [-- --keep]     --keep leaves the sandbox on disk
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/reseat.js", import.meta.url));
const keep = process.argv.includes("--keep");

let failures = 0;
function check(condition: boolean, label: string): void {
  console.log(`${condition ? "  ok " : "  FAIL"} ${label}`);
  if (!condition) failures++;
}

function claudeRecord(
  role: "user" | "assistant",
  text: string,
  sessionId: string,
  cwd: string,
  parentUuid: string | null,
  timestamp: string,
): Record<string, any> {
  return {
    parentUuid,
    isSidechain: false,
    type: role,
    message: { role, content: [{ type: "text", text }] },
    uuid: randomUUID(),
    timestamp,
    sessionId,
    cwd,
    version: "2.1.220",
    gitBranch: "main",
  };
}

const root = await mkdtemp(path.join(os.tmpdir(), "reseat-e2e-"));
const codexHome = path.join(root, "codex-home");
const piAgentDir = path.join(root, "pi-agent");
// Codex only accepts session imports from under <home>/.claude/projects and
// resolves <home> from HOME/USERPROFILE, so the sandbox overrides those too.
const home = path.join(root, "home");
const stores: Record<string, string> = {
  RESEAT_CLAUDE_PROJECTS: path.join(home, ".claude", "projects"),
  RESEAT_CODEX_SESSIONS: path.join(codexHome, "sessions"),
  RESEAT_PI_SESSIONS: path.join(piAgentDir, "sessions"),
  RESEAT_STATE: path.join(root, "state.json"),
  CODEX_HOME: codexHome,
  PI_CODING_AGENT_DIR: piAgentDir,
  HOME: home,
  USERPROFILE: home,
};
const project = path.join(root, "project");
await mkdir(project, { recursive: true });
await mkdir(codexHome, { recursive: true });
// The app-server needs an auth/config to start; borrow the real ones read-only.
for (const name of ["auth.json", "config.toml"]) {
  try {
    await copyFile(path.join(os.homedir(), ".codex", name), path.join(codexHome, name));
  } catch {
    // Fine — codex may not need it for imports.
  }
}

function reseat(...args: string[]): { code: number | null; out: string } {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...stores },
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

async function newestFileUnder(dir: string): Promise<string | undefined> {
  const files: string[] = [];
  async function visit(d: string) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(d, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".jsonl")) files.push(target);
    }
  }
  await visit(dir);
  const stats = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
  return stats.sort((a, b) => a.mtime - b.mtime).at(-1)?.file;
}

const piSessionDir = path.join(stores.RESEAT_PI_SESSIONS, `--${path.resolve(project).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

async function piEntries(file: string): Promise<any[]> {
  return (await readFile(file, "utf8"))
    .trim().split("\n").map((line) => JSON.parse(line));
}

try {
  console.log(`Sandbox: ${root}\n`);

  console.log("1. Claude Code → Codex and pi (first sync)");
  const sessionId = randomUUID();
  const encoded = path.resolve(project).replace(/[^a-zA-Z0-9]/g, "-");
  const sessionDir = path.join(stores.RESEAT_CLAUDE_PROJECTS, encoded);
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
  const first = claudeRecord("user", "Build a CLI that syncs agent sessions.", sessionId, project, null, "2026-07-26T10:00:00.000Z");
  const second = claudeRecord("assistant", "Starting with the session stores.", sessionId, project, first.uuid, "2026-07-26T10:00:05.000Z");
  await writeFile(sessionFile, `${[first, second].map((r) => JSON.stringify(r)).join("\n")}\n`);

  const sync1 = reseat(project);
  check(sync1.code === 0, `sync exits 0 (output: ${sync1.out.split("\n")[0]})`);
  check(/Claude Code → Codex and Pi/.test(sync1.out), "direction is Claude Code → both others");
  check(/codex resume --last/.test(sync1.out) && /pi -c/.test(sync1.out), "prints both resume hints");
  const rollout = await newestFileUnder(stores.RESEAT_CODEX_SESSIONS);
  check(Boolean(rollout), "a rollout file was created");
  const meta = rollout ? JSON.parse((await readFile(rollout, "utf8")).split("\n")[0]) : null;
  check(meta?.payload?.originator === "reseat", `rollout originator is "reseat" (got: ${meta?.payload?.originator})`);
  check(meta?.payload?.cwd === path.resolve(project), "rollout cwd is the project");
  const piFile1 = await newestFileUnder(piSessionDir);
  check(Boolean(piFile1), "a pi session was created");
  if (piFile1) {
    const piLines = (await readFile(piFile1, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    check(piLines[0]?.type === "session" && piLines[0]?.cwd === path.resolve(project), "pi session header carries the project cwd");
    const texts = piLines.filter((e) => e.type === "message").map((e) => e.message.content[0]?.text ?? e.message.content);
    check(texts.some((text) => String(text).includes("syncs agent sessions")), "the conversation landed in the pi session");
    check(piLines.at(-1)?.customType === "reseat-import", "the pi session is marker-closed");
  }

  console.log("\n2. Immediate re-run is a no-op");
  const rerun = reseat(project);
  check(rerun.code === 0 && /Nothing to sync/.test(rerun.out), "re-run reports nothing to sync");

  console.log("\n3. Claude session keeps growing → second sync to both others");
  const third = claudeRecord("user", "Now add a --dry-run flag.", sessionId, project, second.uuid, "2026-07-26T10:10:00.000Z");
  await appendFile(sessionFile, `${JSON.stringify(third)}\n`);
  await utimes(sessionFile, new Date(), new Date());
  const sync2 = reseat(project);
  check(sync2.code === 0, `second sync exits 0 (output: ${sync2.out.trim().split("\n").at(-1)})`);
  check(/Claude Code → Codex and Pi/.test(sync2.out), "direction is Claude Code → both others again");

  console.log("\n4. Work continues in Codex → carried back to Claude Code and pi");
  const rollout2 = await newestFileUnder(stores.RESEAT_CODEX_SESSIONS);
  if (!rollout2) throw new Error("no rollout found after the second import");
  // Recorded the way codex-cli 0.147+ writes turns: `item_completed` events.
  const codexItem = (type: "UserMessage" | "AgentMessage", text: string) => JSON.stringify({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: { type: "item_completed", item: { id: randomUUID(), type, content: [{ type: type === "UserMessage" ? "text" : "Text", text }] } },
  });
  const toolRecords = [
    { type: "custom_tool_call", name: "exec", call_id: "call_e2e", input: 'text(await tools.exec_command({cmd:"git status --short"}));', status: "completed" },
    { type: "custom_tool_call_output", call_id: "call_e2e", output: [{ type: "input_text", text: JSON.stringify({ exit_code: 0, output: " M README.md\n" }) }] },
  ].map((payload) => JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload }));
  await appendFile(rollout2, `${codexItem("UserMessage", "Also support forced direction.")}\n${toolRecords.join("\n")}\n${codexItem("AgentMessage", "Added as --to.")}\n`);
  const sync3 = reseat(project);
  check(sync3.code === 0, "third sync exits 0");
  check(/Codex → Claude Code and Pi/.test(sync3.out), "direction is Codex → both others");
  check(/claude --continue/.test(sync3.out) && /pi -c/.test(sync3.out), "prints both resume hints");
  const claudeFiles = (await readdir(sessionDir)).filter((name) => name !== `${sessionId}.jsonl`);
  check(claudeFiles.length === 1, "exactly one new Claude session was written");
  if (claudeFiles.length === 1) {
    const written = (await readFile(path.join(sessionDir, claudeFiles[0]), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const texts = written.map((record) => record.message.content[0].text);
    check(texts.some((text) => text.includes("forced direction")), "new Codex turns are present");
    check(texts.some((text) => text.includes("[codex_tool_call: exec]") && text.includes(" M README.md")), "Codex tool calls and output are present");
    check(texts.some((text) => text.includes("syncs agent sessions")), "imported history is preserved");
    check(!texts.some((text) => text.includes("EXTERNAL SESSION IMPORTED")), "Codex's import marker is filtered out");
    check(written.every((record) => String(record.version).startsWith("reseat/")), "written records carry the reseat marker");
  }

  console.log("\n5. Work continues in pi → carried to Claude Code and Codex");
  const piFile2 = await newestFileUnder(piSessionDir);
  if (!piFile2) throw new Error("no pi session found after the carry-back");
  const piLines2 = await piEntries(piFile2);
  const lastEntry = piLines2.at(-1)!;
  const continuationId = randomUUID().slice(0, 8);
  await appendFile(piFile2, `${JSON.stringify({
    type: "message",
    id: continuationId,
    parentId: lastEntry.id,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text: "And sync through pi too." }], timestamp: Date.now() },
  })}\n${JSON.stringify({
    type: "message",
    id: randomUUID().slice(0, 8),
    parentId: continuationId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Seated in all three now." }],
      api: "test", provider: "test", model: "test-model",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    },
  })}\n`);
  await utimes(piFile2, new Date(), new Date());
  const sync4 = reseat(project);
  check(sync4.code === 0, `pi-continuation sync exits 0 (output: ${sync4.out.trim().split("\n").at(-1)})`);
  check(/Pi → Claude Code and Codex/.test(sync4.out), "direction is Pi → both others");
  const claudeFiles2 = (await readdir(sessionDir)).filter((name) => name !== `${sessionId}.jsonl`);
  check(claudeFiles2.length === 2, "one more Claude session was written for the pi conversation");
  if (claudeFiles2.length === 2) {
    const piTexts = (await Promise.all(claudeFiles2.map(async (name) =>
      (await readFile(path.join(sessionDir, name), "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line)).map((record) => record.message.content[0].text),
    ))).flat();
    check(piTexts.some((text) => text.includes("sync through pi too")), "the new pi prompt arrived in Claude Code");
    check(piTexts.some((text) => text.includes("Seated in all three")), "the new pi reply arrived in Claude Code");
  }
  const rollout3 = await newestFileUnder(stores.RESEAT_CODEX_SESSIONS);
  check(Boolean(rollout3) && rollout3 !== rollout2, "a new rollout was created for the pi conversation");
  if (rollout3 && rollout3 !== rollout2) {
    const meta3 = JSON.parse((await readFile(rollout3, "utf8")).split("\n")[0]);
    check(meta3?.payload?.originator === "reseat", "the pi→codex rollout is attributed to reseat");
    check(meta3?.payload?.cwd === path.resolve(project), "the pi→codex rollout cwd is the project");
  }
  const leftover = (await readdir(sessionDir)).filter((name) => name !== `${sessionId}.jsonl`);
  check(leftover.length === 2, "the temporary Claude session used for the Codex import was cleaned up");

  console.log("\n6. Re-run after the carry-back is a no-op");
  const rerun2 = reseat(project);
  check(rerun2.code === 0 && /Nothing to sync/.test(rerun2.out), "re-run reports nothing to sync");

  console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed."}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (keep) console.log(`Sandbox kept at ${root}`);
  else await rm(root, { recursive: true, force: true });
}
