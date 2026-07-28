import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { ORIGINATOR } from "./codex.js";

const REQUEST_TIMEOUT_MS = 60_000;
const IMPORT_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 1_500;

const CODEX_MISSING =
  "The Codex CLI was not found on PATH. Install it with: npm install -g @openai/codex";

/**
 * On Windows a bare `codex` through a shell would be resolved by cmd.exe,
 * which searches the working directory first — letting a repository shadow
 * the real CLI with its own `codex.cmd`. Resolve the executable from PATH
 * ourselves and use its absolute path. Elsewhere execvp semantics are safe.
 */
function resolveCodexCommand(): { command: string; shell: boolean } {
  if (process.platform !== "win32") return { command: "codex", shell: false };
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (let directory of (process.env.PATH ?? "").split(path.delimiter)) {
    directory = directory.replace(/^"|"$/g, "");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `codex${extension}`);
      if (!existsSync(candidate)) continue;
      return /\.(cmd|bat)$/i.test(candidate)
        ? { command: `"${candidate}"`, shell: true }
        : { command: candidate, shell: false };
    }
  }
  return { command: "codex", shell: false };
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface NotificationWaiter {
  method: string;
  resolve: (params: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

/**
 * Minimal JSON-RPC-over-stdio client for `codex app-server`.
 *
 * Codex is spawned with its originator overridden to "reseat" so threads
 * created here are attributed to reseat in their rollout metadata.
 */
class AppServer {
  private readonly pending = new Map<number, PendingRequest>();
  private received: any[] = [];
  private readonly waiters: NotificationWaiter[] = [];
  private nextId = 1;
  private stderrTail = "";
  private fatal: Error | null = null;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: readline.Interface;

  constructor(cwd: string) {
    const { command, shell } = resolveCodexCommand();
    this.child = spawn(command, ["app-server"], {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      shell,
      env: { ...process.env, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: ORIGINATOR },
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8000);
    });
    this.output = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.output.on("line", (line) => this.onLine(line));
    this.child.on("error", (error) => {
      this.fail((error as NodeJS.ErrnoException).code === "ENOENT" ? new Error(CODEX_MISSING) : error);
    });
    this.child.on("exit", (code) => {
      if (this.pending.size || this.waiters.length) {
        // Belt for shell-wrapped spawns, where a missing codex surfaces as a
        // shell failure rather than a spawn ENOENT.
        if (/not recognized|not found/i.test(this.stderrTail)) {
          this.fail(new Error(CODEX_MISSING));
          return;
        }
        this.fail(new Error(
          `codex app-server exited${code ? ` with code ${code}` : ""} before completing the request`
          + (this.stderrTail ? `: ${this.stderrTail.trim()}` : "."),
        ));
      }
    });
  }

  private onLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    // A response carries an id and no method (server-initiated requests have
    // their own id space and DO carry a method — never confuse the two).
    if (message.id != null && message.method == null && this.pending.has(message.id)) {
      const waiter = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        const detail = message.error?.message ?? JSON.stringify(message.error);
        waiter.reject(new Error(`codex app-server error: ${detail}`));
      } else {
        waiter.resolve(message.result);
      }
    } else if (message.error && message.id == null) {
      // A Codex that can't parse the request replies with an id-less error
      // (e.g. this API doesn't exist in its version). Fail fast and loudly
      // instead of waiting out the request timeout.
      const detail = message.error?.message ?? JSON.stringify(message.error);
      this.fail(new Error(
        `codex app-server rejected the request: ${detail}\n`
        + "This Codex version may be too old for session imports — try updating the Codex CLI.",
      ));
    } else if (message.method) {
      const index = this.waiters.findIndex((waiter) => waiter.method === message.method);
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        clearTimeout(waiter!.timer ?? undefined);
        waiter!.resolve(message.params);
      } else {
        this.received.push(message);
      }
    }
  }

  private fail(error: Error): void {
    if (this.fatal) return;
    this.fatal = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer ?? undefined);
      waiter.reject(error);
    }
  }

  request(method: string, params: any, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    if (this.fatal) return Promise.reject(this.fatal);
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  }

  notify(method: string, params?: any): void {
    this.child.stdin.write(`${JSON.stringify({ method, ...(params ? { params } : {}) })}\n`);
  }

  waitNotification(method: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    const index = this.received.findIndex((message) => message.method === method);
    if (index >= 0) return Promise.resolve(this.received.splice(index, 1)[0].params);
    if (this.fatal) return Promise.reject(this.fatal);
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = { method, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const current = this.waiters.indexOf(waiter);
        if (current >= 0) this.waiters.splice(current, 1);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /**
   * Shut down without leaving anything behind: no live pipes or timers to
   * keep the event loop running, no waiter left pending forever.
   */
  async close(): Promise<void> {
    this.output.close();
    this.child.stdin.end();
    const exited = new Promise<void>((resolve) => {
      if (this.child.exitCode != null) resolve();
      else this.child.once("exit", () => resolve());
    });
    let grace: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        grace = setTimeout(resolve, SHUTDOWN_GRACE_MS);
      }),
    ]);
    clearTimeout(grace);
    if (this.child.exitCode == null) this.child.kill();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (this.pending.size || this.waiters.length) {
      this.fail(new Error("codex app-server connection closed."));
    }
  }
}

/**
 * Import a Claude Code session into Codex through Codex's own app-server
 * API, which creates the native rollout, thread-database entry, and visible
 * turn history. Returns the new thread's `{ sessionId }`.
 *
 * The original session file is imported in place: Codex only accepts session
 * paths under Claude's own storage, and its import ledger skips a source
 * only when both the path and the content hash match a past import — so a
 * conversation that kept growing can be imported again and again.
 */
export async function importClaudeSession(
  { file, cwd, title, clientVersion = "0" }:
  { file: string; cwd: string; title: string; clientVersion?: string },
): Promise<{ sessionId: string }> {
  const server = new AppServer(cwd);
  try {
    await server.request("initialize", {
      clientInfo: { name: "reseat", title: "reseat", version: clientVersion },
      capabilities: { experimentalApi: true },
    });
    server.notify("initialized");

    const completedPromise = server.waitNotification(
      "externalAgentConfig/import/completed",
      IMPORT_TIMEOUT_MS,
    );
    // If the import request itself fails, the shutdown in `finally` rejects
    // this waiter too; mark it handled so that cannot crash the process.
    completedPromise.catch(() => {});
    const response = await server.request("externalAgentConfig/import", {
      source: "reseat",
      migrationItems: [{
        itemType: "SESSIONS",
        description: "Import one Claude Code session",
        cwd: null,
        details: { sessions: [{ path: path.resolve(file), cwd, title }] },
      }],
    });
    const completed = await completedPromise;
    if (completed.importId !== response.importId) {
      throw new Error("codex app-server reported a completion for a different import.");
    }
    const results: any[] = completed.itemTypeResults ?? [];
    const failures = results.flatMap((result) => result.failures ?? []);
    if (failures.length) {
      throw new Error(failures.map((failure) => failure.message).join("; "));
    }
    const success = results
      .flatMap((result) => result.successes ?? [])
      .find((item) => item.itemType === "SESSIONS" && item.target);
    if (!success) {
      throw new Error(
        "Codex did not create a thread. It skips sessions it has already imported "
        + "with identical content — continue the conversation first, then sync again.",
      );
    }
    return { sessionId: success.target };
  } finally {
    await server.close();
  }
}
