import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeProject, stateFile } from "./paths.js";
import type { Side } from "./types.js";
import type { Fingerprint } from "./util.js";

export interface LastSync {
  at: string;
  from: Side;
  to: Side;
  sourcePath: string;
  sourceSessionId: string;
  createdPath: string;
  createdSessionId: string;
}

export interface ProjectState {
  version?: number;
  latest?: Partial<Record<Side, Fingerprint>>;
  lastSync?: LastSync;
}

export interface ReseatState {
  projects: Record<string, ProjectState>;
}

/**
 * Per-project sync memory. For each project reseat records the fingerprints
 * of the newest session on each side as they stood right after the last sync,
 * so the next run can tell which side actually changed — and so a session
 * reseat just created is never mistaken for new work to sync back.
 */
export async function loadState(): Promise<ReseatState> {
  let raw: string;
  try {
    raw = await readFile(stateFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(
        `Warning: could not read ${stateFile()} (${(error as Error).message}); treating all sessions as new.`,
      );
    }
    return { projects: {} };
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && typeof value.projects === "object" && value.projects) {
      return value as ReseatState;
    }
  } catch {
    // Fall through to the warning below.
  }
  console.error(`Warning: ${stateFile()} is corrupt; treating all sessions as new.`);
  return { projects: {} };
}

export async function saveState(state: ReseatState): Promise<void> {
  const file = stateFile();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

export function projectState(state: ReseatState, projectPath: string): ProjectState {
  return state.projects[normalizeProject(projectPath)] ?? {};
}

export function setProjectState(state: ReseatState, projectPath: string, value: ProjectState): void {
  state.projects[normalizeProject(projectPath)] = value;
}
