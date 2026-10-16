import { rm } from "node:fs/promises";
import path from "node:path";
import { importClaudeSession } from "./appserver.js";
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import * as pi from "./pi.js";
import { loadState, projectState, saveState, setProjectState } from "./state.js";
import type { Side, Turn } from "./types.js";
import { fingerprint, newestFirst, sameFingerprint, type Fingerprint } from "./util.js";

export const SIDES = ["claude", "codex", "pi"] as const;
export const SIDE_NAMES: Record<Side, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

/** The per-side operations sync needs; every agent module provides them. */
interface SideModule {
  sessionId(file: string): string;
  isUnextendedImport(file: string): Promise<boolean>;
  extractTitle(file: string): Promise<string | null>;
  parseTurns(file: string): Promise<Turn[]>;
}

const sessionModule: Record<Side, SideModule> = { claude, codex, pi };

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
  targets: Side[];
  sourcePath: string;
  bothChanged?: boolean;
  /**
   * Forced targets that already hold this exact source conversation: side →
   * the session previously created for it. They are skipped, not duplicated.
   */
  skipped: Partial<Record<Side, string>>;
}

export interface NoneDecision {
  action: "none";
  latest: Partial<Record<Side, string>>;
  reason: NoneReason;
  source?: Side;
  targets?: Side[];
  /** For "already-synced": target → the session previously created. */
  skipped?: Partial<Record<Side, string>>;
}

export type Decision = SyncDecision | NoneDecision;

export interface PlanOptions {
  /** Force the targets; defaults to every other side. */
  to?: Side[] | null;
  /** Force the source; defaults to the most recently active side. */
  from?: Side | null;
}

/** Newest session file per side for the project; sides with none are absent. */
export async function latestSessions(projectPath: string): Promise<Partial<Record<Side, string>>> {
  const latest: Partial<Record<Side, string>> = {};
  const claudeFile = await claude.latestSession(projectPath);
  if (claudeFile) latest.claude = claudeFile;
  const codexFile = await codex.latestRollout(projectPath);
  if (codexFile) latest.codex = codexFile;
  const piFile = await pi.latestSession(projectPath);
  if (piFile) latest.pi = piFile;
  return latest;
}

/** Every side except `side`. */
function otherSides(side: Side): Side[] {
  return SIDES.filter((candidate) => candidate !== side);
}

/**
 * Decide what a sync would do, without doing it.
 *
 * The source is the side with new work since the last sync — the most
 * recently modified one when several changed. The conversation is then
 * recreated on every other side, or on the sides `--to` names. Sessions
 * reseat itself created that were never continued afterwards never count
 * as new work — that is what prevents a fresh import from bouncing
 * straight back, even if the state file is lost.
 */
export async function plan(
  projectPath: string,
  { to, from }: PlanOptions = {},
): Promise<Decision> {
  const latest = await latestSessions(projectPath);
  const sides = Object.keys(latest) as Side[];
  if (!sides.length) return { latest, action: "none", reason: "no-sessions" };

  const previous = projectState(await loadState(), projectPath);
  let source: Side | undefined;
  let bothChanged: boolean | undefined;

  if (from) {
    const targets = (to ?? otherSides(from)).filter((side) => side !== from);
    if (!latest[from]) {
      return { latest, action: "none", reason: "missing-source", source: from, targets };
    }
    if (await sessionModule[from].isUnextendedImport(latest[from]!)) {
      return { latest, action: "none", reason: "source-is-import", source: from, targets };
    }
    source = from;
  } else {
    // Candidate sources: forced targets exclude their own side; otherwise
    // every side whose newest session changed since the last sync counts.
    const restricted = to?.length
      ? sides.filter((side) => !to!.includes(side))
      : sides;
    if (!restricted.length) {
      return { latest, action: "none", reason: "missing-source", targets: to ?? [] };
    }
    if (to?.length) {
      // A forced target needs a source: the most recently active side that
      // isn't itself a target, skipping pure imports.
      const stamped = await newestFirst(restricted.map((side) => latest[side]!));
      for (const { file } of stamped) {
        const side = restricted.find((candidate) => latest[candidate] === file)!;
        if (await sessionModule[side].isUnextendedImport(file)) continue;
        source = side;
        break;
      }
      if (!source) {
        const newestImport = restricted.find((side) => latest[side] === stamped[0]!.file)!;
        return {
          latest, action: "none", reason: "source-is-import", source: newestImport, targets: to,
        };
      }
    } else {
      const changed: Side[] = [];
      const candidates: Array<{ side: Side; mtimeNs: bigint }> = [];
      for (const side of restricted) {
        const current = await fingerprint(latest[side]!);
        if (sameFingerprint(current, previous.latest?.[side])) continue;
        changed.push(side);
        if (await sessionModule[side].isUnextendedImport(latest[side]!)) continue;
        candidates.push({ side, mtimeNs: BigInt(current.mtimeNs) });
      }
      if (!candidates.length) {
        return {
          latest,
          action: "none",
          reason: changed.length ? "import-only" : "unchanged",
        };
      }
      candidates.sort((a, b) => (a.mtimeNs < b.mtimeNs ? 1 : a.mtimeNs > b.mtimeNs ? -1 : 0));
      source = candidates[0].side;
      bothChanged = candidates.length > 1;
    }
  }

  if (!source) {
    return { latest, action: "none", reason: "missing-source", targets: to ?? [] };
  }

  const targets = to?.length ? to.filter((side) => side !== source) : otherSides(source);

  // Forced runs skip targets that already hold this exact conversation;
  // unforced runs can't reach a satisfied target (its source never changed).
  const skipped: Partial<Record<Side, string>> = {};
  if (to?.length || from) {
    const sourceFingerprint = await fingerprint(latest[source]!);
    for (const target of targets) {
      const record = previous.syncedTargets?.[target];
      if (record && sameFingerprint(record.sourceFingerprint, sourceFingerprint)) {
        skipped[target] = record.createdSessionId;
      }
    }
    if (Object.keys(skipped).length === targets.length) {
      return {
        latest,
        action: "none",
        reason: "already-synced",
        source,
        targets,
        skipped,
      };
    }
  }

  return {
    latest,
    action: "sync",
    source,
    targets,
    sourcePath: latest[source]!,
    bothChanged,
    skipped,
  };
}

/** The visible turns of a source file, refusing an empty conversation. */
async function turnsOf(file: string, side: Side): Promise<Turn[]> {
  const turns = await sessionModule[side].parseTurns(file);
  if (!turns.length) {
    throw new Error(`No visible conversation found in ${file}`);
  }
  return turns;
}

/**
 * Execute a sync plan, creating one session per target. Returns
 * `{ file, sessionId }` per created side.
 *
 * Afterwards the state records the fingerprints of the source that was
 * synced and every session that was created — deliberately those exact
 * files, so any session that appeared on any side mid-sync still registers
 * as a change on the next run.
 */
export async function perform(
  projectPath: string,
  decision: Decision,
  { clientVersion }: { clientVersion?: string } = {},
): Promise<Partial<Record<Side, { file: string; sessionId: string }>>> {
  if (decision.action !== "sync") throw new Error("perform() called without a sync plan.");
  const cwd = path.resolve(projectPath);
  // Fingerprint the source before reading it: a turn that lands mid-transfer
  // then makes the file look changed on the next run and gets re-synced,
  // instead of being recorded as already handled without ever transferring.
  const sourceFingerprint = await fingerprint(decision.sourcePath);
  const sourceModule = sessionModule[decision.source];
  const created: Partial<Record<Side, { file: string; sessionId: string }>> = {};

  for (const target of decision.targets) {
    if (target === "codex") {
      // Codex imports only Claude-format session files from under
      // ~/.claude/projects, so a foreign source travels through a temporary
      // Claude session that is removed again once the import is done.
      let claudeFile = decision.sourcePath;
      let temporary: string | null = null;
      if (decision.source !== "claude") {
        const written = await claude.writeSession(
          await turnsOf(decision.sourcePath, decision.source), cwd,
        );
        claudeFile = written.file;
        temporary = written.file;
      }
      const title = (await sourceModule.extractTitle(decision.sourcePath)) ?? "Imported session";
      try {
        const { sessionId } = await importClaudeSession({
          file: claudeFile,
          cwd,
          title,
          clientVersion,
        });
        const rollout = await codex.rolloutForSession(sessionId);
        if (!rollout) {
          throw new Error(`Codex created thread ${sessionId}, but no rollout file was found for it.`);
        }
        created.codex = { file: rollout, sessionId };
      } finally {
        if (temporary) await rm(temporary, { force: true }).catch(() => {});
      }
    } else if (target === "claude") {
      created.claude = await claude.writeSession(
        await turnsOf(decision.sourcePath, decision.source), cwd,
      );
    } else {
      const title = await sourceModule.extractTitle(decision.sourcePath);
      created.pi = await pi.writeSession(
        await turnsOf(decision.sourcePath, decision.source), cwd, { title },
      );
    }
  }

  const state = await loadState();
  const previous = projectState(state, projectPath);
  const latest: Partial<Record<Side, Fingerprint>> = { ...previous.latest };
  latest[decision.source] = sourceFingerprint;
  const syncedTargets = { ...previous.syncedTargets };
  for (const [side, entry] of Object.entries(created) as Array<[Side, { file: string; sessionId: string }]>) {
    latest[side] = await fingerprint(entry.file);
    syncedTargets[side] = {
      sourcePath: decision.sourcePath,
      sourceFingerprint,
      createdPath: entry.file,
      createdSessionId: entry.sessionId,
      at: new Date().toISOString(),
    };
  }
  setProjectState(state, projectPath, {
    version: 1,
    latest,
    lastSync: {
      at: new Date().toISOString(),
      from: decision.source,
      to: decision.targets,
      sourcePath: decision.sourcePath,
      sourceSessionId: sourceModule.sessionId(decision.sourcePath),
      created: (Object.entries(created) as Array<[Side, { file: string; sessionId: string }]>)
        .map(([to, entry]) => ({ to, path: entry.file, sessionId: entry.sessionId })),
    },
    syncedTargets,
  });
  await saveState(state);
  return created;
}
