#!/usr/bin/env node

/**
 * End-to-end smoke test against the real Codex CLI, fully sandboxed.
 *
 * Everything is redirected into a temporary directory: reseat's stores via
 * RESEAT_* variables and Codex itself via CODEX_HOME, so the run leaves no
 * trace in real session history on either side. Requires `codex` on PATH.
 * No model is ever invoked; the run costs no tokens.
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
// Codex only accepts session imports from under <home>/.claude/projects and
// resolves <home> from HOME/USERPROFILE, so the sandbox overrides those too.
const home = path.join(root, "home");
const stores: Record<string, string> = {
  RESEAT_CLAUDE_PROJECTS: path.join(home, ".claude", "projects"),
  RESEAT_CODEX_SESSIONS: path.join(codexHome, "sessions"),
  RESEAT_STATE: path.join(root, "state.json"),
  CODEX_HOME: codexHome,
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

async function newestRollout(): Promise<string | undefined> {
  const files: string[] = [];
  async function visit(dir: string) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.name.endsWith(".jsonl")) files.push(target);
    }
  }
  await visit(stores.RESEAT_CODEX_SESSIONS);
  const stats = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
  return stats.sort((a, b) => a.mtime - b.mtime).at(-1)?.file;
}

try {
  console.log(`Sandbox: ${root}\n`);

  console.log("1. Claude Code → Codex (first import)");
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
  check(/Claude Code → Codex/.test(sync1.out), "direction is Claude Code → Codex");
  check(/codex resume --last/.test(sync1.out), "prints the codex resume hint");
  const rollout = await newestRollout();
  check(Boolean(rollout), "a rollout file was created");
  const meta = rollout ? JSON.parse((await readFile(rollout, "utf8")).split("\n")[0]) : null;
  check(meta?.payload?.originator === "reseat", `rollout originator is "reseat" (got: ${meta?.payload?.originator})`);
  check(meta?.payload?.cwd === path.resolve(project), "rollout cwd is the project");

  console.log("\n2. Immediate re-run is a no-op");
  const rerun = reseat(project);
  check(rerun.code === 0 && /Nothing to sync/.test(rerun.out), "re-run reports nothing to sync");

  console.log("\n3. Claude session keeps growing → second import must succeed");
  const third = claudeRecord("user", "Now add a --dry-run flag.", sessionId, project, second.uuid, "2026-07-26T10:10:00.000Z");
  await appendFile(sessionFile, `${JSON.stringify(third)}\n`);
  await utimes(sessionFile, new Date(), new Date());
  const sync2 = reseat(project);
  check(sync2.code === 0, `second sync exits 0 (output: ${sync2.out.trim().split("\n").at(-1)})`);
  check(/Claude Code → Codex/.test(sync2.out), "direction is Claude Code → Codex again");

  console.log("\n4. Work continues in Codex → carried back to Claude Code");
  const rollout2 = await newestRollout();
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
  check(/Codex → Claude Code/.test(sync3.out), "direction is Codex → Claude Code");
  check(/claude --continue/.test(sync3.out), "prints the claude resume hint");
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

  console.log("\n5. Re-run after the carry-back is a no-op");
  const rerun2 = reseat(project);
  check(rerun2.code === 0 && /Nothing to sync/.test(rerun2.out), "re-run reports nothing to sync");

  console.log(`\n${failures ? `${failures} check(s) FAILED` : "All checks passed."}`);
  process.exitCode = failures ? 1 : 0;
} finally {
  if (keep) console.log(`Sandbox kept at ${root}`);
  else await rm(root, { recursive: true, force: true });
}
