import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { DwError } from "@devicewrapper/core";

/**
 * Minimal Chrome DevTools Protocol client over --remote-debugging-pipe.
 *
 * We drive the render page directly instead of through Playwright: Playwright enables the Network
 * domain on every page and keeps each request (including POST bodies) alive, so streaming video
 * frames through the page's network leaked a full frame per frame and mirrored every byte over the
 * protocol. Here the Network domain is never enabled; only Runtime/Page/Target are used.
 */

type Json = Record<string, unknown>;

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  method: string;
  sessionId?: string;
}

/** Path of Playwright's headless Chromium shell (installed by `devicewrapper setup`). */
export function defaultChromiumPath(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const { registry } = require("playwright-core/lib/server/registry/index") as {
      registry: { findExecutable(name: string): { executablePath(lang: string): string | undefined } | undefined };
    };
    return registry.findExecutable("chromium-headless-shell")?.executablePath("javascript") ?? null;
  } catch {
    return null;
  }
}

export class ChromeProcess {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<(params: Json, sessionId?: string) => void>>();
  private buffer = "";
  private closed = false;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly writer: Writable,
    reader: Readable,
    private readonly userDataDir: string,
  ) {
    reader.on("data", (chunk: Buffer) => this.onData(chunk));
    const fail = (why: string) => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`Chromium ${why} during ${p.method}`));
      this.pending.clear();
    };
    proc.on("exit", (code, signal) => fail(`exited (${signal ?? code})`));
    reader.on("error", () => fail("pipe error"));
    // A crashed renderer never answers pending calls; fail them right away instead.
    this.on("Target.targetCrashed", (p) => this.failTarget(String(p.targetId), `crashed (${String(p.status)})`));
    // Some Chromium builds report a renderer crash only on the page's own session.
    this.on("Inspector.targetCrashed", (_p, sid) => {
      if (sid) this.failSession(sid, "crashed");
    });
    this.on("Target.detachedFromTarget", (p) => {
      const sid = String(p.sessionId);
      for (const [id, q] of this.pending) {
        if (q.sessionId === sid) {
          this.pending.delete(id);
          q.reject(new Error(`Target closed during ${q.method}`));
        }
      }
    });
  }

  private readonly sessionsByTarget = new Map<string, string>();

  private failTarget(targetId: string, why: string): void {
    const sid = this.sessionsByTarget.get(targetId);
    if (sid) this.failSession(sid, why);
  }

  /** Sessions whose renderer crashed: later calls fail at once instead of waiting forever. */
  private readonly deadSessions = new Map<string, string>();

  private failSession(sid: string, why: string): void {
    this.deadSessions.set(sid, why);
    for (const [id, q] of this.pending) {
      if (q.sessionId === sid) {
        this.pending.delete(id);
        q.reject(new Error(`Target ${why} during ${q.method}`));
      }
    }
  }

  static async launch(executablePath: string, args: string[]): Promise<ChromeProcess> {
    const userDataDir = mkdtempSync(join(tmpdir(), "devicewrapper-chrome-"));
    const proc = spawn(
      executablePath,
      [
        ...args,
        "--remote-debugging-pipe",
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        // A crashed renderer should die at once; crash reporting can leave it hanging instead.
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-backgrounding-occluded-windows",
        "--metrics-recording-only",
        "--password-store=basic",
        "--use-mock-keychain",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    proc.stderr!.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const spawned = await new Promise<Error | null>((res) => {
      proc.once("spawn", () => res(null));
      proc.once("error", (e) => res(e));
    });
    if (spawned) throw spawned;
    const chrome = new ChromeProcess(proc, proc.stdio[3] as Writable, proc.stdio[4] as Readable, userDataDir);
    try {
      await chrome.send("Browser.getVersion", {}, undefined, 30000);
      await chrome.send("Target.setDiscoverTargets", { discover: true }, undefined, 10000);
    } catch (e) {
      chrome.kill();
      throw new Error(`Chromium did not start: ${(e as Error).message}. ${stderr.trim().split("\n").slice(-3).join(" ")}`);
    }
    return chrome;
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    let end: number;
    while ((end = this.buffer.indexOf("\0")) >= 0) {
      const raw = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let msg: { id?: number; method?: string; params?: Json; result?: Json; error?: { message: string }; sessionId?: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result ?? {});
      } else if (msg.method) {
        if (process.env.DW_CDP_TRACE && !/console|exception|Network|Page\.(frame|lifecycle|load|dom)/i.test(msg.method)) console.error("[cdp]", msg.method, msg.sessionId ?? "", JSON.stringify(msg.params ?? {}).slice(0, 160));
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {}, msg.sessionId);
      }
    }
  }

  send(method: string, params: Json = {}, sessionId?: string, timeoutMs = 0): Promise<Json> {
    if (this.closed) return Promise.reject(new Error(`Chromium is not running (${method})`));
    const dead = sessionId ? this.deadSessions.get(sessionId) : undefined;
    if (dead) return Promise.reject(new Error(`Target ${dead} before ${method}`));
    const id = this.nextId++;
    const msg = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<Json>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const done = <A>(fn: (a: A) => void) => (a: A) => {
        if (timer) clearTimeout(timer);
        fn(a);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method, ...(sessionId ? { sessionId } : {}) });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      this.writer.write(msg + "\0");
    });
  }

  on(method: string, fn: (params: Json, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  async newPage(onConsole?: (type: string, text: string) => void): Promise<CdpPage> {
    const { targetId } = (await this.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
    const { sessionId } = (await this.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
    this.sessionsByTarget.set(targetId, sessionId);
    const page = new CdpPage(this, targetId, sessionId);
    if (onConsole) {
      page.disposers.push(
        this.on("Runtime.consoleAPICalled", (p, sid) => {
          if (sid !== sessionId) return;
          const args = (p.args as Array<{ value?: unknown; description?: string }>) ?? [];
          onConsole(String(p.type), args.map((a) => (a.value !== undefined ? String(a.value) : a.description ?? "")).join(" "));
        }),
        this.on("Runtime.exceptionThrown", (p, sid) => {
          if (sid !== sessionId) return;
          const d = p.exceptionDetails as { text?: string; exception?: { description?: string } };
          onConsole("error", d.exception?.description ?? d.text ?? "exception");
        }),
      );
    }
    await this.send("Inspector.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
    await this.send("Page.enable", {}, sessionId);
    return page;
  }

  kill(): void {
    this.closed = true;
    this.proc.kill("SIGKILL");
    rmSync(this.userDataDir, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    if (!this.closed) await this.send("Browser.close", {}, undefined, 5000).catch(() => undefined);
    await new Promise<void>((res) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) return res();
      const t = setTimeout(() => {
        this.proc.kill("SIGKILL");
        res();
      }, 5000);
      this.proc.once("exit", () => {
        clearTimeout(t);
        res();
      });
    });
    this.closed = true;
    rmSync(this.userDataDir, { recursive: true, force: true });
  }
}

export class CdpPage {
  readonly disposers: Array<() => void> = [];

  constructor(
    private readonly chrome: ChromeProcess,
    readonly targetId: string,
    readonly sessionId: string,
  ) {}

  async goto(url: string): Promise<void> {
    const r = (await this.chrome.send("Page.navigate", { url }, this.sessionId, 30000)) as { errorText?: string };
    if (r.errorText) throw new Error(`Navigation to ${url} failed: ${r.errorText}`);
  }

  /** Evaluates an expression (awaiting promises) and returns its JSON value. */
  async evaluate<T>(expression: string, timeoutMs = 0): Promise<T> {
    const r = (await this.chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, this.sessionId, timeoutMs)) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception?.description ?? d.text ?? "evaluation failed").split("\n")[0]);
    }
    return r.result?.value as T;
  }

  /** Calls window.dw[method](...args) with JSON arguments. */
  call<T>(method: string, args: unknown[], timeoutMs = 0): Promise<T> {
    const argList = args.map((a) => JSON.stringify(a)).join(",");
    return this.evaluate<T>(`window.dw.${method}(${argList})`, timeoutMs);
  }

  async waitFor(expression: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (await this.evaluate<boolean>(expression, 5000)) return;
      } catch {
        // page still loading
      }
      if (Date.now() > deadline) throw new DwError("RENDERER_START_FAILED", `The renderer page did not become ready within ${timeoutMs / 1000} s.`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async close(): Promise<void> {
    for (const d of this.disposers) d();
    await this.chrome.send("Target.closeTarget", { targetId: this.targetId }, undefined, 5000).catch(() => undefined);
  }
}
