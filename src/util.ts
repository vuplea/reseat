import { createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

export async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Collect files in a tree whose basename passes `predicate`. Missing/unreadable directories are skipped. */
export async function walkFiles(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && predicate(entry.name)) files.push(target);
    }));
  }
  await visit(root);
  return files;
}

export interface StampedFile {
  file: string;
  mtimeNs: bigint;
}

/** Stat the given files and return `{ file, mtimeNs }` entries sorted newest first. Files that vanish are dropped. */
export async function newestFirst(files: string[]): Promise<StampedFile[]> {
  const entries = await Promise.all(files.map(async (file) => {
    try {
      const info = await stat(file, { bigint: true });
      return { file, mtimeNs: info.mtimeNs };
    } catch {
      return null;
    }
  }));
  return entries
    .filter((entry): entry is StampedFile => entry !== null)
    .sort((a, b) => (a.mtimeNs < b.mtimeNs ? 1 : a.mtimeNs > b.mtimeNs ? -1 : 0));
}

/**
 * Identity of a file's current content, used to detect changes between runs.
 * mtime and size are stored as strings so nanosecond precision survives JSON.
 */
export interface Fingerprint {
  path: string;
  mtimeNs: string;
  size: string;
}

export async function fingerprint(file: string): Promise<Fingerprint> {
  const info = await stat(file, { bigint: true });
  return {
    path: path.resolve(file),
    mtimeNs: info.mtimeNs.toString(),
    size: info.size.toString(),
  };
}

export function sameFingerprint(a?: Fingerprint | null, b?: Fingerprint | null): boolean {
  if (!a || !b) return false;
  return a.path === b.path && a.mtimeNs === b.mtimeNs && a.size === b.size;
}

/**
 * Stream a JSONL file, invoking `onRecord` per parsed line. Blank and
 * malformed lines are skipped. Return `false` from `onRecord` to stop early.
 */
export async function readJsonLines(
  file: string,
  onRecord: (record: any) => unknown,
): Promise<void> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record == null) continue;
      if (await onRecord(record) === false) break;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * Flatten a message `content` field (string, or array of text-bearing parts
 * in Claude or Codex shape) into plain text.
 */
export function messageText(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && ["text", "input_text", "output_text"].includes(item.type))
    .map((item) => String(item.text ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** "3s", "5m", "2h", "4d" — compact age for status output. */
export function age(mtimeNs: bigint): string {
  const ms = Date.now() - Number(mtimeNs / 1_000_000n);
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
