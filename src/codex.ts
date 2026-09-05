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
  threadSource: string | null;
}

/** The `session_meta` header of a rollout: `{ id, cwd, source, originator, thread_source }`. */
export async function inspectRollout(file: string): Promise<RolloutMeta> {
  const result: RolloutMeta = { id: null, cwd: null, source: null, originator: null, threadSource: null };
  await readJsonLines(file, (record) => {
    if (record?.type !== "session_meta") return undefined;
    const payload = record.payload ?? {};
    result.id = payload.id ? String(payload.id) : null;
    result.cwd = payload.cwd ? String(payload.cwd) : null;
    result.source = payload.source ? String(payload.source) : null;
    result.originator = payload.originator ? String(payload.originator) : null;
    result.threadSource = payload.thread_source ? String(payload.thread_source) : null;
    return false;
  });
  return result;
}

/**
 * Newest rollout for this project that actually contains conversation.
 * Codex writes `session_meta` the moment it starts, so opened-and-abandoned
 * rollouts are routine; they carry nothing to sync and are skipped. Subagent
 * threads are skipped too: they share the project's cwd but hold a worker's
 * task, not the user's conversation. So are files that vanish mid-scan.
 */
export async function latestRollout(projectPath: string): Promise<string | null> {
  const projectKey = normalizeProject(projectPath);
  for (const candidate of await rolloutFiles()) {
    try {
      const meta = await inspectRollout(candidate.file);
      if (!meta.cwd || normalizeProject(meta.cwd) !== projectKey) continue;
      if (meta.threadSource === "subagent") continue;
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
    const event = eventTurn(record);
    if (event ? event.text !== IMPORT_MARKER : responseTurn(record)) {
      found = true;
      return false;
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

/** Turn roles of Codex's turn events by event type: pre-0.147 rollouts, and what its importer still writes. */
const EVENT_ROLES: Record<string, Turn["role"]> = { user_message: "user", agent_message: "assistant" };

/** Turn roles of `item_completed` events by item type: codex-cli 0.147 and later. */
const ITEM_ROLES: Record<string, Turn["role"]> = { UserMessage: "user", AgentMessage: "assistant" };

/**
 * The prompt or reply an `event_msg` record carries, if any. Codex emits
 * these only for real turns, never for injected context, so they are the
 * clean source of a rollout's visible conversation.
 */
function eventTurn(record: any): Turn | undefined {
  if (record?.type !== "event_msg") return undefined;
  const payload = record.payload ?? {};
  const item = payload.type === "item_completed" ? payload.item ?? {} : null;
  const role = item ? ITEM_ROLES[item.type] : EVENT_ROLES[payload.type];
  if (!role) return undefined;
  const text = item ? messageText(item.content) : String(payload.message ?? "").trim();
  return text ? { role, text, timestamp: record.timestamp } : undefined;
}

/**
 * Context blocks Codex injects as user-role response items. Matched by
 * envelope so a genuine user prompt that happens to start with markup isn't
 * dropped.
 */
const INJECTED_CONTEXT = /^<(user_instructions|environment_context|ENVIRONMENT_CONTEXT|recommended_plugins|permissions|skills_instructions|INSTRUCTIONS)[\s>]/;

/**
 * The prompt or reply a user/assistant `response_item` message carries, if
 * any: the fallback for rollouts without turn events. User-role records also
 * carry injected context envelopes; those are dropped.
 */
function responseTurn(record: any): Turn | undefined {
  const payload = record?.payload ?? {};
  if (record?.type !== "response_item" || payload.type !== "message") return undefined;
  const role = payload.role;
  if (role !== "user" && role !== "assistant") return undefined;
  const text = messageText(payload.content);
  if (!text || (role === "user" && INJECTED_CONTEXT.test(text))) return undefined;
  return { role, text, timestamp: record.timestamp };
}

function appendTurn(turns: Turn[], turn: Turn): void {
  const previous = turns.at(-1);
  if (previous?.role === turn.role) {
    previous.text += `\n\n${turn.text}`;
  } else {
    turns.push({ ...turn });
  }
}

/**
 * The visible conversation of a rollout as `{ role, text, timestamp }` turns,
 * consecutive same-role turns merged: from turn events when the rollout has
 * any, else from response items.
 */
export async function parseTurns(file: string): Promise<Turn[]> {
  const events: Turn[] = [];
  const responseItems: Turn[] = [];
  await readJsonLines(file, (record) => {
    const event = eventTurn(record);
    if (event) {
      if (event.text !== IMPORT_MARKER) appendTurn(events, event);
    } else {
      const item = responseTurn(record);
      if (item) appendTurn(responseItems, item);
    }
    return undefined;
  });
  return events.length ? events : responseItems;
}

/** A short human title for the rollout: its first real user prompt. */
export async function extractTitle(file: string): Promise<string | null> {
  let title: string | null = null;
  let fallback: string | null = null;
  await readJsonLines(file, (record) => {
    const event = eventTurn(record);
    const turn = event ?? responseTurn(record);
    if (turn?.role !== "user" || turn.text.startsWith("<")) return undefined;
    const text = turn.text.replace(/\s+/g, " ").slice(0, 100);
    if (event) {
      title = text;
      return false;
    }
    fallback ??= text;
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
    if (record?.type === "session_meta") {
      imported = String(record.payload?.originator ?? "") === ORIGINATOR;
      return imported ? undefined : false;
    }
    const turn = eventTurn(record);
    if (turn?.role === "assistant" && turn.text === IMPORT_MARKER) {
      sawMarker = true;
    } else if (turn?.role === "user" && sawMarker) {
      extended = true;
      return false;
    }
    return undefined;
  });
  return imported && sawMarker && !extended;
}
