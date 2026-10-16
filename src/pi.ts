import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { piSessionsRoot } from "./paths.js";
import type { Turn } from "./types.js";
import { messageText, newestFirst, readJsonLines, type StampedFile } from "./util.js";

/**
 * Sessions reseat writes end with a `custom` entry of this type, so they can
 * be told apart from sessions pi recorded itself. Custom entries never enter
 * the LLM context (they are extension state), so the marker itself is
 * invisible when the session is resumed.
 */
export const IMPORT_MARKER = "reseat-import";

/**
 * pi encodes a project's cwd into its session directory name. Replicates
 * getDefaultSessionDirPath in pi's session-manager: strip the leading path
 * separator, replace every separator and Windows drive colon with "-",
 * then wrap in "--" on both sides. Unlike Claude Code, other characters
 * (".", "_", spaces) are kept as-is.
 */
export function projectDirectoryName(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Resolve the session directory for a project. */
export async function projectDirectory(
  projectPath: string,
  { create = false }: { create?: boolean } = {},
): Promise<string> {
  const result = path.join(piSessionsRoot(), projectDirectoryName(projectPath));
  if (create) await mkdir(result, { recursive: true });
  return result;
}

const SESSION_FILE = /\.jsonl$/;

/**
 * Newest-first session files for a project. Sessions are the `.jsonl` files
 * pi writes into the encoded project directory, named
 * `<file-timestamp>_<session-id>.jsonl`.
 */
export async function sessionFiles(projectPath: string): Promise<StampedFile[]> {
  const directory = await projectDirectory(projectPath);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.isFile() && SESSION_FILE.test(entry.name))
    .map((entry) => path.join(directory, entry.name));
  return newestFirst(files);
}

/**
 * The newest session that actually contains conversation. pi writes the
 * session header the moment it starts, so opened-and-abandoned sessions
 * are routine; they carry nothing to sync and are skipped.
 */
export async function latestSession(projectPath: string): Promise<string | null> {
  for (const candidate of await sessionFiles(projectPath)) {
    if (await hasVisibleTurns(candidate.file)) return candidate.file;
  }
  return null;
}

/**
 * The session id of a session file: pi names the file after the id
 * (`<timestamp>_<uuid>.jsonl`, the id also sits in the header).
 */
export function sessionId(file: string): string {
  return path.basename(file, ".jsonl").split("_").pop()!;
}

/** True when the session holds at least one real prompt or assistant reply. */
export async function hasVisibleTurns(file: string): Promise<boolean> {
  let found = false;
  await readJsonLines(file, (record) => {
    if (record?.type !== "message") return undefined;
    const message = record.message ?? {};
    if (!["user", "assistant"].includes(message.role)) return undefined;
    if (!messageText(message.content)) return undefined;
    found = true;
    return false;
  });
  return found;
}

/**
 * The entries of a session file in file order, header excluded. Blank and
 * malformed lines are skipped, as pi's own loader does.
 */
async function readEntries(file: string): Promise<any[]> {
  const entries: any[] = [];
  await readJsonLines(file, (record) => {
    if (record?.type !== "session") entries.push(record);
    return undefined;
  });
  return entries;
}

/**
 * The active branch of a session: pi entries form a tree linked by
 * `id`/`parentId`, and the last non-label entry in file order is the leaf.
 * Walked leaf-to-root, then reversed into conversation order. Label
 * entries are bookmarks pi keeps at the end of the file, outside the tree
 * path; they and other non-message entries are skipped here.
 */
async function activeBranch(file: string): Promise<any[]> {
  const entries = await readEntries(file);
  const byId = new Map<string, any>();
  for (const entry of entries) {
    if (typeof entry?.id === "string") byId.set(entry.id, entry);
  }
  const leaf = [...entries].reverse().find(
    (entry) => typeof entry?.id === "string" && entry.type !== "label",
  );
  const branch: any[] = [];
  let current: any = leaf;
  while (current && typeof current.id === "string") {
    branch.push(current);
    current = current.parentId == null ? null : byId.get(String(current.parentId));
  }
  return branch.reverse();
}

function appendTurn(turns: Turn[], role: unknown, text: unknown, timestamp?: string): void {
  const value = String(text ?? "").trim();
  if (!value || (role !== "user" && role !== "assistant")) return;
  const previous = turns.at(-1);
  if (previous?.role === role) {
    previous.text += `\n\n${value}`;
  } else {
    turns.push({ role, text: value, timestamp });
  }
}

/**
 * The visible conversation of a session as `{ role, text, timestamp }` turns,
 * following the active branch. Thinking blocks and tool traffic are not part
 * of the conversation and don't transfer; `messageText` keeps text blocks
 * only. Compaction summaries are skipped for parity with the other
 * directions — the full turn history they summarize is carried instead.
 */
export async function parseTurns(file: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  for (const entry of await activeBranch(file)) {
    if (entry?.type !== "message") continue;
    const message = entry.message ?? {};
    if (!["user", "assistant"].includes(message.role)) continue;
    appendTurn(turns, message.role, messageText(message.content), entry.timestamp);
  }
  return turns;
}

/**
 * A short human title for the session: its display name when one was set
 * with /name, else the first real user prompt.
 */
export async function extractTitle(file: string): Promise<string | null> {
  const names: string[] = [];
  await readJsonLines(file, (record) => {
    if (record?.type === "session_info") {
      // A later session_info without a name clears a previously set one.
      if (typeof record.name === "string" && record.name.trim()) names.push(record.name.trim());
      else names.length = 0;
    }
    return undefined;
  });
  const name = names.at(-1);
  if (name) return name.slice(0, 100);
  const firstUser = (await parseTurns(file)).find((turn) => turn.role === "user");
  return firstUser ? firstUser.text.replace(/\s+/g, " ").slice(0, 100) : null;
}

/**
 * True when the session was created by reseat and pi hasn't recorded a new
 * user message in it since — a plain import with nothing new to carry back.
 * The marker custom entry is appended last, so any user message after it is
 * real continuation work.
 */
export async function isUnextendedImport(file: string): Promise<boolean> {
  let sawMarker = false;
  let sawContinuation = false;
  await readJsonLines(file, (record) => {
    if (record?.type === "custom" && record.customType === IMPORT_MARKER) sawMarker = true;
    else if (sawMarker && record?.type === "message" && record.message?.role === "user") {
      sawContinuation = true;
      return false;
    }
    return undefined;
  });
  return sawMarker && !sawContinuation;
}

function entryId(): string {
  return randomUUID().slice(0, 8);
}

/**
 * Write `turns` as a resumable pi session for the project. Returns
 * `{ file, sessionId }`.
 *
 * The shape mirrors what pi's own SessionManager appends: a v3 session
 * header, `message` entries linked into a chain by `id`/`parentId`, an
 * optional `session_info` entry carrying the title, and the marker custom
 * entry. Assistant messages carry the full pi message shape (usage, model,
 * stop reason) so pi's readers never trip over a missing field.
 */
export async function writeSession(
  turns: Turn[],
  projectPath: string,
  { title }: { title?: string | null } = {},
): Promise<{ file: string; sessionId: string }> {
  if (!turns.length) throw new Error("Refusing to write an empty session.");
  const id = randomUUID();
  const directory = await projectDirectory(projectPath, { create: true });
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const file = path.join(directory, `${fileTimestamp}_${id}.jsonl`);
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: path.resolve(projectPath) }),
  ];
  let parentId: string | null = null;
  for (const turn of turns) {
    const entryIdValue = entryId();
    const at = turn.timestamp ?? timestamp;
    const message: Record<string, unknown> = {
      role: turn.role,
      content: [{ type: "text", text: turn.text }],
      timestamp: Date.parse(at) || Date.parse(timestamp),
    };
    if (turn.role === "assistant") {
      message.api = "reseat";
      message.provider = "reseat";
      message.model = "imported";
      message.usage = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      message.stopReason = "stop";
    }
    lines.push(JSON.stringify({
      type: "message", id: entryIdValue, parentId, timestamp: at, message,
    }));
    parentId = entryIdValue;
  }
  if (title) {
    const labelEntryId = entryId();
    lines.push(JSON.stringify({
      type: "session_info", id: labelEntryId, parentId, timestamp, name: title,
    }));
    parentId = labelEntryId;
  }
  lines.push(JSON.stringify({
    type: "custom", id: entryId(), parentId, timestamp,
    customType: IMPORT_MARKER, data: { source: "reseat" },
  }));
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return { file, sessionId: id };
}
