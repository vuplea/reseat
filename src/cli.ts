import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as claude from "./claude.js";
import * as codex from "./codex.js";
import * as pi from "./pi.js";
import { SIDE_NAMES, SIDES, perform, plan, type Decision, type NoneDecision, type NoneReason } from "./sync.js";
import { claudeProjectsRoot, codexSessionsRoot, normalizeProject, piSessionsRoot, stateFile } from "./paths.js";
import type { Side } from "./types.js";
import { age, pathExists } from "./util.js";

const USAGE = `reseat — pull your coding session out of one agent, seat it in the others.

Syncs the newest session of a project between Claude Code, Codex, and pi, so
you can keep one conversation going across all of them. The newest session
with new work is handed to both other agents by default. No model calls, no
tokens.

Usage:
  reseat [sync] [project-dir] [options]   sync the project (default: current directory)
  reseat status [project-dir]             show all sides and what a sync would do

Options:
  -n, --dry-run          preview the sync without creating anything
      --to <agents>      force the targets, comma-separated: "claude", "codex", "pi",
                         e.g. --to codex or --to claude,pi (default: both other agents)
      --from <agent>     force the source agent (default: the most recently active one)
  -h, --help             show this help
  -V, --version          show the version

Examples:
  reseat                     # in a project directory: hand the newest session to both others
  reseat --to pi             # push the newest Claude Code or Codex session to pi
  reseat --from pi --to codex,claude   # push the pi session to both others
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
  to: Side[] | null;
  from: Side | null;
}

function parseSideList(value: string, option: string): Side[] {
  const sides = value.split(",").map((side) => side.trim()).filter(Boolean);
  const invalid = sides.filter((side) => !SIDES.includes(side as Side));
  if (invalid.length) {
    throw new Error(
      `${option} expects comma-separated agents from ${SIDES.map((side) => `"${side}"`).join(", ")},`
      + ` got: ${invalid.map((side) => `"${side}"`).join(", ")}`,
    );
  }
  return [...new Set(sides)] as Side[];
}

function parseArguments(argv: string[]): CliOptions {
  const options: CliOptions = { command: "sync", project: null, dryRun: false, to: null, from: null };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "-n" || argument === "--dry-run") options.dryRun = true;
    else if (argument === "--to") {
      const target = argv[++index];
      if (target == null) throw new Error(`--to expects comma-separated agents, got nothing`);
      options.to = parseSideList(target, "--to");
    } else if (argument === "--from") {
      const source = argv[++index];
      if (source == null || source.includes(",")) {
        throw new Error(`--from expects a single agent from ${SIDES.map((side) => `"${side}"`).join(", ")}`);
      }
      options.from = parseSideList(source, "--from")[0] ?? null;
    } else if (argument === "-h" || argument === "--help") options.command = "help";
    else if (argument === "-V" || argument === "--version") options.command = "version";
    else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}\n\n${USAGE}`);
    else positional.push(argument);
  }
  if (options.from && options.to?.includes(options.from)) {
    throw new Error(`--from "${options.from}" cannot also be a --to target`);
  }
  if (options.to && !options.to.length) options.to = null;
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
    `No ${SIDES.slice(0, -1).map((side) => SIDE_NAMES[side]).join(", ")}, or ${SIDE_NAMES[SIDES[SIDES.length - 1]]} sessions with any conversation exist for ${project} yet.\n`
    + `(searched ${claudeProjectsRoot()}, ${codexSessionsRoot()}, and ${piSessionsRoot()})\n`
    + "Start a conversation in any agent first, then run reseat to hand it over.",
  unchanged: () => "Nothing to sync — no side has new work since the last sync.",
  "import-only": () => "Nothing to sync — the only new session is a reseat import that was never continued.",
  "missing-source": (project, decision) => decision.source
    ? `Cannot sync from ${SIDE_NAMES[decision.source]}: it has no session for this project.`
    : `Cannot sync: no session to carry exists for this project on any side other than the target.`,
  "source-is-import": (project, decision) =>
    `The newest ${SIDE_NAMES[decision.source!] ?? "source"} session is itself a reseat import with no new turns; `
    + "syncing it back would only duplicate the conversation.",
  "already-synced": (project, decision) => {
    const targets = (decision.targets ?? []).map((side) => SIDE_NAMES[side]).join(" and ");
    const hints = (decision.targets ?? [])
      .map((side) => exactResumeHint(side, decision.skipped?.[side], project))
      .join("\n");
    return `Already synced — the ${SIDE_NAMES[decision.source!]} session is unchanged since it was last `
      + `handed to ${targets}.\n\nTake the seat:\n${hints}`;
  },
};

/**
 * Right after a sync the created sessions are the newest on their sides, so
 * the short resume forms are the documented way in. Claude Code and pi
 * resolve sessions per working directory, so their hints only work from the
 * project; Codex resumes from anywhere.
 */
function resumeHint(target: Side, project: string): string {
  if (target === "codex") return "  codex resume --last";
  if (target === "pi") return `  ${cdPrefix(project)}pi -c`;
  return `  ${cdPrefix(project)}claude --continue`;
}

/**
 * Later on, "--last" may no longer be the reseat session — the
 * already-synced hint names the exact session instead.
 */
function exactResumeHint(target: Side, sessionId: string | undefined, project: string): string {
  if (target === "codex") return `  codex resume ${sessionId}`;
  if (target === "pi") return `  ${cdPrefix(project)}pi --session ${sessionId}`;
  return `  ${cdPrefix(project)}claude --resume ${sessionId}`;
}

function cdPrefix(project: string): string {
  return normalizeProject(project) === normalizeProject(process.cwd()) ? "" : `cd ${project} && `;
}

function sideModule(side: Side) {
  return side === "claude" ? claude : side === "codex" ? codex : pi;
}

async function describeSide(side: Side, file: string): Promise<string> {
  const module = sideModule(side);
  const [title, generated, info] = await Promise.all([
    module.extractTitle(file),
    module.isUnextendedImport(file),
    stat(file, { bigint: true }),
  ]);
  const parts = [`${age(info.mtimeNs)} ago`];
  if (generated) parts.push("reseat import");
  const label = SIDE_NAMES[side].padEnd(11);
  const summary = title ? `“${title.length > 60 ? `${title.slice(0, 60)}…` : title}”` : "(no visible prompt)";
  return `  ${label} ${summary}  (${parts.join(", ")})`;
}

async function runStatus(project: string, options: CliOptions): Promise<number> {
  const decision = await plan(project, { to: options.to, from: options.from });
  console.log(`Project: ${project}\n`);
  if (decision.action === "none" && decision.reason === "no-sessions") {
    console.log(NOTHING_TO_DO["no-sessions"](project, decision));
    return 0;
  }
  for (const side of SIDES) {
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
    console.log(`Next sync: ${SIDE_NAMES[decision.source]} → ${decision.targets.map((side) => SIDE_NAMES[side]).join(" and ")}`);
  } else {
    console.log(NOTHING_TO_DO[decision.reason](project, decision));
  }
  console.log(`Stores:    ${claudeProjectsRoot()}`);
  console.log(`           ${codexSessionsRoot()}`);
  console.log(`           ${piSessionsRoot()}`);
  console.log(`State:     ${stateFile()}`);
  return 0;
}

async function runSync(project: string, options: CliOptions): Promise<number> {
  const decision = await plan(project, { to: options.to, from: options.from });
  if (decision.action !== "sync") {
    const explain = NOTHING_TO_DO[decision.reason](project, decision);
    if (["missing-source", "source-is-import"].includes(decision.reason)) {
      console.error(explain);
      return 1;
    }
    console.log(explain);
    return 0;
  }

  const sourceModule = sideModule(decision.source);
  const targetNames = decision.targets.map((side) => SIDE_NAMES[side]).join(" and ");
  console.log(`${SIDE_NAMES[decision.source]} → ${targetNames}`);
  console.log(`  project  ${project}`);
  console.log(`  source   ${decision.sourcePath}`);
  console.log(`           session ${sourceModule.sessionId(decision.sourcePath)}`);
  if (decision.bothChanged) {
    console.log("  (several sides have new work; the most recently active one wins)");
  }
  for (const [target, sessionId] of Object.entries(decision.skipped) as Array<[Side, string]>) {
    console.log(`  ${SIDE_NAMES[target].padEnd(9)} already holds this conversation (session ${sessionId}); skipped`);
  }
  if (options.dryRun) {
    console.log("\nDry run — nothing was created.");
    return 0;
  }

  const created = await perform(project, decision, { clientVersion: await version() });
  for (const [target, entry] of Object.entries(created) as Array<[Side, { file: string; sessionId: string }]>) {
    console.log(`  created  ${SIDE_NAMES[target]} session ${entry.sessionId}`);
    console.log(`           ${entry.file}`);
  }
  console.log(`\nTake the seat:\n${decision.targets.map((side) => resumeHint(side, project)).join("\n")}`);
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
