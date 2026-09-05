import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

export interface Stores {
  root: string;
  claudeProjects: string;
  codexSessions: string;
  state: string;
  project: string;
}

/**
 * Point reseat's stores at fresh temporary directories for the duration of
 * a test, returning their locations plus a scratch project directory.
 */
export async function temporaryStores(t: TestContext): Promise<Stores> {
  const root = await mkdtemp(path.join(os.tmpdir(), "reseat-test-"));
  const stores: Stores = {
    root,
    claudeProjects: path.join(root, "claude-projects"),
    codexSessions: path.join(root, "codex-sessions"),
    state: path.join(root, "state.json"),
    project: path.join(root, "project"),
  };
  await mkdir(stores.claudeProjects, { recursive: true });
  await mkdir(stores.codexSessions, { recursive: true });
  await mkdir(stores.project, { recursive: true });
  const saved: Record<string, string | undefined> = {
    RESEAT_CLAUDE_PROJECTS: process.env.RESEAT_CLAUDE_PROJECTS,
    RESEAT_CODEX_SESSIONS: process.env.RESEAT_CODEX_SESSIONS,
    RESEAT_STATE: process.env.RESEAT_STATE,
  };
  process.env.RESEAT_CLAUDE_PROJECTS = stores.claudeProjects;
  process.env.RESEAT_CODEX_SESSIONS = stores.codexSessions;
  process.env.RESEAT_STATE = stores.state;
  t.after(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return stores;
}

export function claudeUserRecord(text: string, overrides: Record<string, any> = {}): Record<string, any> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
    uuid: randomUUID(),
    timestamp: "2026-07-26T10:00:00.000Z",
    sessionId: overrides.sessionId ?? randomUUID(),
    cwd: overrides.cwd ?? "C:\\project",
    version: "2.1.220",
    ...overrides,
  };
}

export function claudeAssistantRecord(text: string, overrides: Record<string, any> = {}): Record<string, any> {
  return { ...claudeUserRecord(text, overrides), type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } };
}

/** Write a Claude session file into the store; `mtime` (Date) orders candidates. */
export async function writeClaudeFixture(
  stores: Stores,
  projectDirName: string,
  records: unknown[],
  { name, mtime }: { name?: string; mtime?: Date } = {},
): Promise<string> {
  const directory = path.join(stores.claudeProjects, projectDirName);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name ?? `${randomUUID()}.jsonl`);
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  if (mtime) await utimes(file, mtime, mtime);
  return file;
}

export function codexMetaRecord(cwd: string, overrides: Record<string, any> = {}): Record<string, any> {
  const id = overrides.id ?? randomUUID();
  return {
    timestamp: "2026-07-26T10:00:00.000Z",
    type: "session_meta",
    payload: {
      cwd,
      originator: "codex_exec",
      cli_version: "0.144.0",
      source: "exec",
      thread_source: "user",
      ...overrides,
      id,
    },
  };
}

export function codexUserEvent(message: string, timestamp = "2026-07-26T10:01:00.000Z"): Record<string, any> {
  return { timestamp, type: "event_msg", payload: { type: "user_message", message } };
}

export function codexAgentEvent(message: string, timestamp = "2026-07-26T10:02:00.000Z"): Record<string, any> {
  return { timestamp, type: "event_msg", payload: { type: "agent_message", message } };
}

/** `item_completed` turn records: how codex-cli 0.147+ writes prompts and replies. */
export function codexUserItem(text: string, timestamp = "2026-07-26T10:01:00.000Z"): Record<string, any> {
  return codexItem("UserMessage", "text", text, timestamp);
}

export function codexAgentItem(text: string, timestamp = "2026-07-26T10:02:00.000Z"): Record<string, any> {
  return codexItem("AgentMessage", "Text", text, timestamp);
}

function codexItem(type: string, contentType: string, text: string, timestamp: string): Record<string, any> {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "item_completed", item: { id: randomUUID(), type, content: [{ type: contentType, text }] } },
  };
}

export function codexResponseItem(role: string, text: string, timestamp = "2026-07-26T10:01:00.000Z"): Record<string, any> {
  return {
    timestamp,
    type: "response_item",
    payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] },
  };
}

/**
 * Records shaped like a rollout Codex creates when reseat imports a Claude
 * session: the history replayed as turn events, closed by Codex's
 * end-of-import marker (verified against codex-cli 0.144 and 0.153).
 */
export function codexImportedRollout(
  cwd: string,
  turns: Array<[string, string]> = [["user", "hello"], ["assistant", "hi"]],
): Array<Record<string, any>> {
  return [
    codexMetaRecord(cwd, { originator: "reseat", source: "exec" }),
    { timestamp: "2026-07-26T10:00:00.100Z", type: "event_msg", payload: { type: "task_started" } },
    ...turns.map(([role, text]) => (role === "user" ? codexUserEvent(text) : codexAgentEvent(text))),
    codexAgentEvent("<EXTERNAL SESSION IMPORTED>"),
    { timestamp: "2026-07-26T10:00:01.000Z", type: "event_msg", payload: { type: "task_complete" } },
  ];
}

/** Write a Codex rollout into the store; `mtime` (Date) orders candidates. */
export async function writeCodexFixture(
  stores: Stores,
  records: unknown[],
  { id, mtime }: { id?: string; mtime?: Date } = {},
): Promise<string> {
  id = id ?? randomUUID();
  const directory = path.join(stores.codexSessions, "2026", "07", "26");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-07-26T10-00-00-${id}.jsonl`);
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  if (mtime) await utimes(file, mtime, mtime);
  return file;
}
