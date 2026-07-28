import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import { SIDE_NAMES, perform, plan, type NoneDecision, type NoneReason } from "./sync.js";
import { claudeProjectsRoot, codexSessionsRoot, normalizeProject, stateFile } from "./paths.js";
import type { Side } from "./types.js";
import { age, pathExists } from "./util.js";

const USAGE = `reseat — pull your coding session out of one agent, seat it in the other.

Syncs the newest session of a project between Claude Code and Codex, so you
can keep one conversation going across both. No model calls, no tokens.

Usage:
  reseat [sync] [project-dir] [options]   sync the project (default: current directory)
  reseat status [project-dir]             show both sides and what a sync would do

Options:
  -n, --dry-run        preview the sync without creating anything
      --to <agent>     force the direction: "claude" or "codex"
  -h, --help           show this help
  -V, --version        show the version

Examples:
  reseat                     # in a project directory: hand the newest session over
  reseat --to codex          # push the latest Claude Code session to Codex
  reseat status ~/repos/app  # what would a sync of ~/repos/app do?
`;

async function version(): Promise<string> {
  // This file runs compiled from dist/src/, so package.json sits two levels up.
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  return String(pkg.version);
}

interface CliOptions {
  command: "sync" | "status" | "help" | "version";
  project: string | null;
  dryRun: boolean;
  to: Side | null;
}

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = { command: "sync", project: null, dryRun: false, to: null };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "-n" || argument === "--dry-run") options.dryRun = true;
    else if (argument === "--to") {
      const target = argv[++index];
      if (target !== "claude" && target !== "codex") {
        throw new Error(`--to expects "claude" or "codex", got: ${target ?? "(nothing)"}`);
      }
      options.to = target;
    } else if (argument === "-h" || argument === "--help") options.command = "help";
    else if (argument === "-V" || argument === "--version") options.command = "version";
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}\n\n${USAGE}`);
    else positional.push(argument);
  }
  const first = positional[0];
  if (options.command === "sync" && (first === "sync" || first === "status" || first === "help")) {
    options.command = first;
    positional.shift();
  }
  if (positional.length > 1) throw new Error(`Unexpected argument: ${positional[1]}\n\n${USAGE}`);
  if (positional.length) options.project = positional[0];
  return options;
}

const NOTHING_TO_DO: Record<NoneReason, (project: string, decision: NoneDecision) => string> = {
  "no-sessions": (project) =>
    `No Claude Code or Codex sessions with any conversation exist for ${project} yet.\n`
    + `(searched ${claudeProjectsRoot()} and ${codexSessionsRoot()})\n`
    + "Start a conversation in either agent first, then run reseat to hand it over.",
  unchanged: () => "Nothing to sync — neither side has new work since the last sync.",
  "import-only": () => "Nothing to sync — the only new session is a reseat import that was never continued.",
  "missing-source": (project, decision) =>
    `Cannot sync from ${SIDE_NAMES[decision.source!]}: it has no session for this project.`,
  "source-is-import": (project, decision) =>
    `The newest ${SIDE_NAMES[decision.source!]} session is itself a reseat import with no new turns; `
    + "syncing it back would only duplicate the conversation.",
  "already-synced": (project, decision) =>
    `Already synced — the ${SIDE_NAMES[decision.source!]} session is unchanged since it was last `
    + `handed to ${SIDE_NAMES[decision.target!]}.\n\nTake the seat:\n`
    + exactResumeHint(decision.target!, decision.createdSessionId, project),
};

/**
 * Right after a sync the created session is the newest on its side, so the
 * short resume forms are the documented way in. Claude Code resolves
 * sessions per working directory, so its hint only works from the project;
 * Codex resumes from anywhere.
 */
function resumeHint(target: Side, project: string): string {
  if (target === "codex") return "  codex resume --last";
  return `  ${cdPrefix(project)}claude --continue`;
}

/**
 * Later on, "--last" may no longer be the reseat session — the
 * already-synced hint names the exact session instead.
 */
function exactResumeHint(target: Side, sessionId: string | undefined, project: string): string {
  if (target === "codex") return `  codex resume ${sessionId}`;
  return `  ${cdPrefix(project)}claude --resume ${sessionId}`;
}

function cdPrefix(project: string): string {
  return normalizeProject(project) === normalizeProject(process.cwd()) ? "" : `cd ${project} && `;
}

async function describeSide(side: Side, file: string): Promise<string> {
  const sideModule = side === "claude" ? claude : codex;
  const [title, generated, info] = await Promise.all([
    sideModule.extractTitle(file),
    sideModule.isUnextendedImport(file),
    stat(file, { bigint: true }),
  ]);
  const parts = [`${age(info.mtimeNs)} ago`];
  if (generated) parts.push("reseat import");
  const label = SIDE_NAMES[side].padEnd(11);
  const summary = title ? `“${title.length > 60 ? `${title.slice(0, 60)}…` : title}”` : "(no visible prompt)";
  return `  ${label} ${summary}  (${parts.join(", ")})`;
}

async function runStatus(project: string, options: CliOptions): Promise<number> {
  const decision = await plan(project, { to: options.to });
  console.log(`Project: ${project}\n`);
  if (decision.action === "none" && decision.reason === "no-sessions") {
    console.log(NOTHING_TO_DO["no-sessions"](project, decision));
    return 0;
  }
  for (const side of ["claude", "codex"] as const) {
    const file = decision.latest[side];
    if (file) {
      console.log(await describeSide(side, file));
      console.log(`              ${file}`);
    } else {
      console.log(`  ${SIDE_NAMES[side].padEnd(11)} (no sessions for this project)`);
    }
  }
  console.log();
  if (decision.action === "sync") {
    console.log(`Next sync: ${SIDE_NAMES[decision.source]} → ${SIDE_NAMES[decision.target]}`);
  } else {
    console.log(NOTHING_TO_DO[decision.reason](project, decision));
  }
  console.log(`Stores:    ${claudeProjectsRoot()}`);
  console.log(`           ${codexSessionsRoot()}`);
  console.log(`State:     ${stateFile()}`);
  return 0;
}

async function runSync(project: string, options: CliOptions): Promise<number> {
  const decision = await plan(project, { to: options.to });
  if (decision.action !== "sync") {
    const explain = NOTHING_TO_DO[decision.reason](project, decision);
    if (["missing-source", "source-is-import"].includes(decision.reason)) {
      console.error(explain);
      return 1;
    }
    console.log(explain);
    return 0;
  }

  const sourceModule = decision.source === "claude" ? claude : codex;
  console.log(`${SIDE_NAMES[decision.source]} → ${SIDE_NAMES[decision.target]}`);
  console.log(`  project  ${project}`);
  console.log(`  source   ${decision.sourcePath}`);
  console.log(`           session ${sourceModule.sessionId(decision.sourcePath)}`);
  if (decision.bothChanged) {
    console.log("  (both sides have new work; the most recently active one wins)");
  }
  if (options.dryRun) {
    console.log("\nDry run — nothing was created.");
    return 0;
  }

  const created = await perform(project, decision, { clientVersion: await version() });
  console.log(`  created  ${created.file}`);
  console.log(`           session ${created.sessionId}`);
  console.log(`\nTake the seat:\n${resumeHint(decision.target, project)}`);
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (options.command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (options.command === "version") {
    console.log(await version());
    return 0;
  }

  const project = path.resolve(options.project ?? process.cwd());
  if (!await pathExists(project)) {
    console.error(`Project directory does not exist: ${project}`);
    return 1;
  }
  try {
    return options.command === "status"
      ? await runStatus(project, options)
      : await runSync(project, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
