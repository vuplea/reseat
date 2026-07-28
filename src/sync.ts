import path from "node:path";
import { importClaudeSession } from "./appserver.js";
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import { loadState, projectState, saveState, setProjectState } from "./state.js";
import type { Side } from "./types.js";
import { fingerprint, sameFingerprint, type Fingerprint } from "./util.js";

export const SIDE_NAMES: Record<Side, string> = { claude: "Claude Code", codex: "Codex" };

/** The per-side operations sync needs; both agent modules provide them. */
interface SideModule {
  sessionId(file: string): string;
  isUnextendedImport(file: string): Promise<boolean>;
}

const sessionModule: Record<Side, SideModule> = { claude, codex };

export type NoneReason =
  | "no-sessions"
  | "unchanged"
  | "import-only"
  | "missing-source"
  | "source-is-import"
  | "already-synced";

export interface SyncDecision {
  action: "sync";
  latest: Partial<Record<Side, string>>;
  source: Side;
  target: Side;
  sourcePath: string;
  bothChanged?: boolean;
}

export interface NoneDecision {
  action: "none";
  latest: Partial<Record<Side, string>>;
  reason: NoneReason;
  source?: Side;
  target?: Side;
  createdSessionId?: string;
}

export type Decision = SyncDecision | NoneDecision;

/** Newest session file per side for the project; sides with none are absent. */
export async function latestSessions(projectPath: string): Promise<Partial<Record<Side, string>>> {
  const latest: Partial<Record<Side, string>> = {};
  const claudeFile = await claude.latestSession(projectPath);
  if (claudeFile) latest.claude = claudeFile;
  const codexFile = await codex.latestRollout(projectPath);
  if (codexFile) latest.codex = codexFile;
  return latest;
}

/**
 * Decide what a sync would do, without doing it.
 *
 * A side counts as changed when its newest session differs from the
 * fingerprint recorded after the previous sync. Among changed sides the most
 * recently modified wins. Sessions reseat itself created that were never
 * continued afterwards never count as new work — that is what prevents a
 * fresh import from bouncing straight back, even if the state file is lost.
 */
export async function plan(
  projectPath: string,
  { to }: { to?: Side | null } = {},
): Promise<Decision> {
  const latest = await latestSessions(projectPath);
  const sides = Object.keys(latest) as Side[];
  if (!sides.length) return { latest, action: "none", reason: "no-sessions" };

  if (to) {
    const source: Side = to === "codex" ? "claude" : "codex";
    const sourceFile = latest[source];
    if (!sourceFile) return { latest, action: "none", reason: "missing-source", source };
    if (await sessionModule[source].isUnextendedImport(sourceFile)) {
      return { latest, action: "none", reason: "source-is-import", source };
    }
    // Forcing an unchanged source again would only mint a duplicate session;
    // point back at what the previous sync created instead.
    const previous = projectState(await loadState(), projectPath);
    if (previous.lastSync?.to === to
      && sameFingerprint(await fingerprint(sourceFile), previous.latest?.[source])) {
      return {
        latest,
        action: "none",
        reason: "already-synced",
        source,
        target: to,
        createdSessionId: previous.lastSync.createdSessionId,
      };
    }
    return { latest, action: "sync", source, target: to, sourcePath: sourceFile };
  }

  const state = await loadState();
  const previous = projectState(state, projectPath).latest ?? {};
  const changed: Side[] = [];
  const candidates: Array<{ side: Side; mtimeNs: bigint }> = [];
  for (const side of sides) {
    const current = await fingerprint(latest[side]!);
    if (sameFingerprint(current, previous[side])) continue;
    changed.push(side);
    if (await sessionModule[side].isUnextendedImport(latest[side]!)) continue;
    candidates.push({ side, mtimeNs: BigInt(current.mtimeNs) });
  }
  if (!candidates.length) {
    return { latest, action: "none", reason: changed.length ? "import-only" : "unchanged" };
  }
  candidates.sort((a, b) => (a.mtimeNs < b.mtimeNs ? 1 : a.mtimeNs > b.mtimeNs ? -1 : 0));
  const source = candidates[0].side;
  return {
    latest,
    action: "sync",
    source,
    target: source === "claude" ? "codex" : "claude",
    sourcePath: latest[source]!,
    bothChanged: candidates.length > 1,
  };
}

/**
 * Execute a sync plan. Returns `{ file, sessionId }` of the created session.
 *
 * Afterwards the state records the fingerprints of the source that was synced
 * and the session that was created — deliberately those exact files, so any
 * session that appeared on either side mid-sync still registers as a change
 * on the next run.
 */
export async function perform(
  projectPath: string,
  decision: Decision,
  { clientVersion }: { clientVersion?: string } = {},
): Promise<{ file: string; sessionId: string }> {
  if (decision.action !== "sync") throw new Error("perform() called without a sync plan.");
  const cwd = path.resolve(projectPath);
  // Fingerprint the source before reading it: a turn that lands mid-transfer
  // then makes the file look changed on the next run and gets re-synced,
  // instead of being recorded as already handled without ever transferring.
  const sourceFingerprint = await fingerprint(decision.sourcePath);
  let created: { file: string; sessionId: string };
  if (decision.source === "claude") {
    const title = (await claude.extractTitle(decision.sourcePath)) ?? "Imported Claude Code session";
    const { sessionId } = await importClaudeSession({
      file: decision.sourcePath,
      cwd,
      title,
      clientVersion,
    });
    const rollout = await codex.rolloutForSession(sessionId);
    if (!rollout) {
      throw new Error(`Codex created thread ${sessionId}, but no rollout file was found for it.`);
    }
    created = { file: rollout, sessionId };
  } else {
    const turns = await codex.parseTurns(decision.sourcePath);
    if (!turns.length) {
      throw new Error(`No visible conversation found in ${decision.sourcePath}`);
    }
    created = await claude.writeSession(turns, cwd);
  }

  const latest: Partial<Record<Side, Fingerprint>> = {
    [decision.source]: sourceFingerprint,
    [decision.target]: await fingerprint(created.file),
  };
  const state = await loadState();
  setProjectState(state, projectPath, {
    version: 1,
    latest,
    lastSync: {
      at: new Date().toISOString(),
      from: decision.source,
      to: decision.target,
      sourcePath: decision.sourcePath,
      sourceSessionId: sessionModule[decision.source].sessionId(decision.sourcePath),
      createdPath: created.file,
      createdSessionId: created.sessionId,
    },
  });
  await saveState(state);
  return created;
}
