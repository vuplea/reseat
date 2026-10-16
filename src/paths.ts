import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

/**
 * Root of Claude Code's per-project session storage. Honors Claude's own
 * CLAUDE_CONFIG_DIR relocation; RESEAT_CLAUDE_PROJECTS overrides both.
 */
export function claudeProjectsRoot(): string {
  if (process.env.RESEAT_CLAUDE_PROJECTS) return process.env.RESEAT_CLAUDE_PROJECTS;
  const base = process.env.CLAUDE_CONFIG_DIR ?? path.join(HOME, ".claude");
  return path.join(base, "projects");
}

/**
 * Root of Codex's rollout storage (date-sharded JSONL files). Honors Codex's
 * own CODEX_HOME relocation — which the spawned `codex app-server` also sees,
 * so reads and writes stay in the same store; RESEAT_CODEX_SESSIONS
 * overrides for reading only.
 */
export function codexSessionsRoot(): string {
  if (process.env.RESEAT_CODEX_SESSIONS) return process.env.RESEAT_CODEX_SESSIONS;
  const base = process.env.CODEX_HOME ?? path.join(HOME, ".codex");
  return path.join(base, "sessions");
}

/**
 * Root of pi's session storage (per-project subdirectories). Honors pi's
 * own PI_CODING_AGENT_DIR relocation; RESEAT_PI_SESSIONS overrides both.
 * (pi's PI_CODING_AGENT_SESSION_DIR flattens the store into one directory
 * and is deliberately not honored here.)
 */
export function piSessionsRoot(): string {
  if (process.env.RESEAT_PI_SESSIONS) return process.env.RESEAT_PI_SESSIONS;
  const base = process.env.PI_CODING_AGENT_DIR ?? path.join(HOME, ".pi", "agent");
  return path.join(base, "sessions");
}

/** Where reseat remembers per-project sync state. */
export function stateFile(): string {
  if (process.env.RESEAT_STATE) return process.env.RESEAT_STATE;
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(HOME, "AppData", "Local");
    return path.join(base, "reseat", "state.json");
  }
  const base = process.env.XDG_STATE_HOME ?? path.join(HOME, ".local", "state");
  return path.join(base, "reseat", "state.json");
}

/**
 * Canonical key for a project directory, so the same project always maps to
 * the same state entry regardless of how its path was spelled.
 */
export function normalizeProject(projectPath: string): string {
  let value = path.resolve(projectPath);
  if (value.startsWith("\\\\?\\")) value = value.slice(4);
  value = path.normalize(value);
  return process.platform === "win32" ? value.toLowerCase() : value;
}
