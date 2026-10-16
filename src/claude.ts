import { randomUUID } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeProjectsRoot } from "./paths.js";
import type { Turn } from "./types.js";
import { messageText, newestFirst, readJsonLines, type StampedFile } from "./util.js";

/**
 * Written into the `version` field of session records reseat creates, so
 * they can be told apart from sessions Claude Code recorded itself.
 */
export const GENERATED_MARKER = "reseat/1";
const MARKER_PREFIX = "reseat/";

/**
 * Claude Code stores each project's sessions under a directory named after
 * the project path with every non-alphanumeric character replaced by "-"
 * (verified against Claude Code 2.1: `E:\Repos\_a.b` -> `E--Repos--a-b`).
 */
export function projectDirectoryName(projectPath: string): string {
  return path.resolve(projectPath).replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Resolve the session directory for a project. On Windows an existing
 * directory is matched case-insensitively (drive-letter case varies);
 * elsewhere paths are case-sensitive and so are the encoded names.
 */
export async function projectDirectory(
  projectPath: string,
  { create = false }: { create?: boolean } = {},
): Promise<string> {
  const encoded = projectDirectoryName(projectPath);
  if (process.platform === "win32") {
    try {
      const entries = await readdir(claudeProjectsRoot(), { withFileTypes: true });
      const match = entries.find(
        (entry) => entry.isDirectory() && entry.name.toLowerCase() === encoded.toLowerCase(),
      );
      if (match) return path.join(claudeProjectsRoot(), match.name);
    } catch {
      // Root missing; fall through to the encoded default.
    }
  }
  const result = path.join(claudeProjectsRoot(), encoded);
  if (create) await mkdir(result, { recursive: true });
  return result;
}

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Newest-first session files for a project. Sessions are exactly the
 * `<uuid>.jsonl` files at the project directory's top level; subdirectories
 * hold other artifacts (memory files, subagent transcripts).
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
 * The newest session that actually contains conversation. Freshly launched
 * or abandoned sessions (no prompt yet, only meta/command records) are
 * routine and would make a sync fail or produce an empty thread.
 */
export async function latestSession(projectPath: string): Promise<string | null> {
  for (const candidate of await sessionFiles(projectPath)) {
    if (await hasVisibleTurns(candidate.file)) return candidate.file;
  }
  return null;
}

/** The session id of a session file (Claude names the file after it). */
export function sessionId(file: string): string {
  return path.basename(file, ".jsonl");
}

/** True when the session holds at least one real prompt or assistant reply. */
export async function hasVisibleTurns(file: string): Promise<boolean> {
  let found = false;
  await readJsonLines(file, (record) => {
    if (!["user", "assistant"].includes(record.type)) return undefined;
    const text = messageText(record.message?.content);
    if (!text) return undefined;
    if (record.type === "user" && (record.isMeta || text.startsWith("<") || text.startsWith("Caveat:"))) {
      return undefined;
    }
    found = true;
    return false;
  });
  return found;
}

/**
 * True when every conversation record in the file was written by reseat —
 * i.e. the session is a plain import that Claude Code hasn't added to yet.
 */
export async function isUnextendedImport(file: string): Promise<boolean> {
  let sawMarker = false;
  let sawForeign = false;
  await readJsonLines(file, (record) => {
    if (!["user", "assistant"].includes(record.type)) return undefined;
    if (String(record.version ?? "").startsWith(MARKER_PREFIX)) sawMarker = true;
    else {
      sawForeign = true;
      return false;
    }
    return undefined;
  });
  return sawMarker && !sawForeign;
}

/**
 * The visible conversation of a Claude Code session as `{ role, text,
 * timestamp }` turns. Meta records, injected context envelopes, and command
 * transcripts are dropped; consecutive same-role records merge, mirroring
 * how the other agents parse their history.
 */
export async function parseTurns(file: string): Promise<Turn[]> {
  const turns: Turn[] = [];
  await readJsonLines(file, (record) => {
    const role = record.type;
    if (role !== "user" && role !== "assistant") return undefined;
    const text = messageText(record.message?.content);
    if (!text) return undefined;
    if (role === "user" && (record.isMeta || text.startsWith("<") || text.startsWith("Caveat:"))) {
      return undefined;
    }
    const previous = turns.at(-1);
    if (previous && previous.role === role) {
      previous.text += `\n\n${text}`;
    } else {
      turns.push({ role, text, timestamp: record.timestamp });
    }
    return undefined;
  });
  return turns;
}

/**
 * A short human title for the session: the first real user prompt, with
 * command transcripts and injected context skipped.
 */
export async function extractTitle(file: string): Promise<string | null> {
  let title: string | null = null;
  await readJsonLines(file, (record) => {
    if (record?.type !== "user" || record?.isMeta) return undefined;
    const text = messageText(record?.message?.content).replace(/\s+/g, " ").trim();
    if (!text || text.startsWith("<") || text.startsWith("Caveat:")) return undefined;
    title = text.slice(0, 100);
    return false;
  });
  return title;
}

/**
 * Write `turns` as a resumable Claude Code session for the project.
 * Returns `{ file, sessionId }`.
 */
export async function writeSession(
  turns: Turn[],
  projectPath: string,
): Promise<{ file: string; sessionId: string }> {
  if (!turns.length) throw new Error("Refusing to write an empty session.");
  const id = randomUUID();
  const directory = await projectDirectory(projectPath, { create: true });
  const file = path.join(directory, `${id}.jsonl`);
  let parentUuid: string | null = null;
  const lines = turns.map((turn) => {
    const uuid = randomUUID();
    const record = {
      parentUuid,
      isSidechain: false,
      type: turn.role,
      timestamp: turn.timestamp ?? new Date().toISOString(),
      sessionId: id,
      cwd: path.resolve(projectPath),
      version: GENERATED_MARKER,
      uuid,
      message: {
        role: turn.role,
        content: [{ type: "text", text: turn.text }],
      },
    };
    parentUuid = uuid;
    return JSON.stringify(record);
  });
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return { file, sessionId: id };
}
