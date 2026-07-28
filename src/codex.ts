import path from "node:path";
import { codexSessionsRoot, normalizeProject } from "./paths.js";
import type { Turn } from "./types.js";
import { messageText, newestFirst, readJsonLines, walkFiles, type StampedFile } from "./util.js";

/**
 * Reported as the session originator when reseat drives `codex app-server`,
 * so rollouts reseat created can be told apart from Codex's own.
 */
export const ORIGINATOR = "reseat";

/**
 * Codex's importer ends every imported session with an agent message holding
 * exactly this text (EXTERNAL_SESSION_IMPORTED_MARKER in codex-rs). Turns
 * recorded after it are real continuation work.
 */
export const IMPORT_MARKER = "<EXTERNAL SESSION IMPORTED>";

function isRolloutFile(name: string): boolean {
  return name.startsWith("rollout-") && name.endsWith(".jsonl");
}

/** The thread id of a rollout (its filename ends with the id). */
export function sessionId(file: string): string {
  return path.basename(file, ".jsonl").slice(-36);
}

/** Newest-first rollout files under the Codex sessions root. */
export async function rolloutFiles(): Promise<StampedFile[]> {
  return newestFirst(await walkFiles(codexSessionsRoot(), isRolloutFile));
}

export interface RolloutMeta {
  id: string | null;
  cwd: string | null;
  source: string | null;
  originator: string | null;
}

/** The `session_meta` header of a rollout: `{ id, cwd, source, originator }`. */
export async function inspectRollout(file: string): Promise<RolloutMeta> {
  const result: RolloutMeta = { id: null, cwd: null, source: null, originator: null };
  await readJsonLines(file, (record) => {
    if (record?.type !== "session_meta") return undefined;
    const payload = record.payload ?? {};
    result.id = payload.id ? String(payload.id) : null;
    result.cwd = payload.cwd ? String(payload.cwd) : null;
    result.source = payload.source ? String(payload.source) : null;
    result.originator = payload.originator ? String(payload.originator) : null;
    return false;
  });
  return result;
}

/**
 * Newest rollout for this project that actually contains conversation.
 * Codex writes `session_meta` the moment it starts, so opened-and-abandoned
 * rollouts are routine; they carry nothing to sync and are skipped. Files
 * that vanish mid-scan are skipped too.
 */
export async function latestRollout(projectPath: string): Promise<string | null> {
  const projectKey = normalizeProject(projectPath);
  for (const candidate of await rolloutFiles()) {
    try {
      const meta = await inspectRollout(candidate.file);
      if (!meta.cwd || normalizeProject(meta.cwd) !== projectKey) continue;
      if (await hasVisibleTurns(candidate.file)) return candidate.file;
    } catch {
      continue;
    }
  }
  return null;
}

/** True when the rollout holds at least one real prompt or assistant reply. */
export async function hasVisibleTurns(file: string): Promise<boolean> {
  let found = false;
  await readJsonLines(file, (record) => {
    const payload = record?.payload ?? {};
    if (record?.type === "event_msg" && ["user_message", "agent_message"].includes(payload.type)) {
      const text = String(payload.message ?? "").trim();
      if (text && text !== IMPORT_MARKER) {
        found = true;
        return false;
      }
    } else if (record?.type === "response_item" && payload.type === "message"
      && ["user", "assistant"].includes(payload.role)) {
      const text = messageText(payload.content);
      if (text && !(payload.role === "user" && isInjectedContext(text))) {
        found = true;
        return false;
      }
    }
    return undefined;
  });
  return found;
}

/** Find the rollout file for a thread id (used to locate a fresh import). */
export async function rolloutForSession(sessionId: string): Promise<string | null> {
  const files = await walkFiles(
    codexSessionsRoot(),
    (name) => isRolloutFile(name) && name.endsWith(`${sessionId}.jsonl`),
  );
  return files[0] ?? null;
}

/**
 * Context blocks Codex injects as user-role response items (real prompts
 * arrive as `event_msg` records in current Codex; the fallback only matters
 * for old rollouts). Matched by envelope so a genuine user prompt that
 * happens to start with markup isn't dropped.
 */
const INJECTED_CONTEXT = /^<(user_instructions|environment_context|ENVIRONMENT_CONTEXT|recommended_plugins|permissions|skills_instructions|INSTRUCTIONS)[\s>]/;

function isInjectedContext(text: string): boolean {
  return INJECTED_CONTEXT.test(text);
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
 * The visible conversation of a rollout as `{ role, text, timestamp }` turns.
 *
 * `event_msg` records are the clean source: Codex emits them only for real
 * user prompts and assistant replies. Old rollouts without them fall back to
 * `response_item` messages, where user-role records also carry injected
 * context envelopes; those are dropped there.
 */
export async function parseTurns(file: string): Promise<Turn[]> {
  const events: Turn[] = [];
  const responseItems: Turn[] = [];
  await readJsonLines(file, (record) => {
    const payload = record?.payload ?? {};
    if (record?.type === "event_msg" && payload.type === "user_message") {
      appendTurn(events, "user", payload.message, record.timestamp);
    } else if (record?.type === "event_msg" && payload.type === "agent_message") {
      if (String(payload.message ?? "").trim() === IMPORT_MARKER) return undefined;
      appendTurn(events, "assistant", payload.message, record.timestamp);
    } else if (record?.type === "response_item" && payload.type === "message") {
      const text = messageText(payload.content);
      if (payload.role === "user" && isInjectedContext(text)) return undefined;
      appendTurn(responseItems, payload.role, text, record.timestamp);
    }
    return undefined;
  });
  return events.length ? events : responseItems;
}

/** A short human title for the rollout: its first real user prompt. */
export async function extractTitle(file: string): Promise<string | null> {
  let fallback: string | null = null;
  let title: string | null = null;
  await readJsonLines(file, (record) => {
    const payload = record?.payload ?? {};
    if (record?.type === "event_msg" && payload.type === "user_message") {
      const text = String(payload.message ?? "").replace(/\s+/g, " ").trim();
      if (text && !text.startsWith("<")) {
        title = text.slice(0, 100);
        return false;
      }
    } else if (!fallback && record?.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const text = messageText(payload.content).replace(/\s+/g, " ").trim();
      if (text && !text.startsWith("<")) fallback = text.slice(0, 100);
    }
    return undefined;
  });
  return title ?? fallback;
}

/**
 * True when the rollout was created by reseat and Codex hasn't recorded any
 * new user prompt in it since — a plain import with nothing new to carry
 * back. The imported history itself appears as ordinary turn events, so only
 * user prompts after Codex's end-of-import marker count as new work.
 */
export async function isUnextendedImport(file: string): Promise<boolean> {
  let imported = false;
  let sawMarker = false;
  let extended = false;
  await readJsonLines(file, (record) => {
    const payload = record?.payload ?? {};
    if (record?.type === "session_meta") {
      imported = String(payload.originator ?? "") === ORIGINATOR;
      return imported ? undefined : false;
    }
    if (record?.type === "event_msg" && payload.type === "agent_message"
      && String(payload.message ?? "").trim() === IMPORT_MARKER) {
      sawMarker = true;
    } else if (record?.type === "event_msg" && payload.type === "user_message" && sawMarker) {
      extended = true;
      return false;
    }
    return undefined;
  });
  return imported && sawMarker && !extended;
}
