import { AsyncLocalStorage } from "node:async_hooks";
import { ChallengeError, FetchTimeoutError, SiteFetchError } from "./libs/errors.js";
import { buildFetchModule } from "./libs/fetch-module.js";
import { readCappedText } from "./libs/read-capped.js";

export interface FetcherOptions {
  intervalMs?: number;
  maxInFlight?: number;
  timeoutMs?: number;
  solverUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type Priority = "interactive" | "bulk";

// Plugins call @libs/fetch without knowing their lane, so the route handler sets it for the whole call.
const priorityStorage = new AsyncLocalStorage<Priority>();

export const runWithPriority = <T>(priority: Priority, operation: () => T): T => priorityStorage.run(priority, operation);

export const currentPriority = (): Priority | undefined => priorityStorage.getStore();

// Lets the plugin proxy know how long the route handler allows the call before the worker is killed.
const deadlineStorage = new AsyncLocalStorage<number>();

export const runWithDeadline = <T>(milliseconds: number, operation: () => T): T => deadlineStorage.run(milliseconds, operation);

export const currentDeadline = (): number | undefined => deadlineStorage.getStore();

// Carries the HTTP request's abort signal so a client that disconnects stops its plugin call.
const signalStorage = new AsyncLocalStorage<AbortSignal>();

export const runWithSignal = <T>(signal: AbortSignal, operation: () => T): T => signalStorage.run(signal, operation);

export const currentSignal = (): AbortSignal | undefined => signalStorage.getStore();

const INTERACTIVE_STREAK_LIMIT = 3;
const SOLVER_HEADROOM_MS = 10_000;
const MAX_SOLVER_BYTES = 20_000_000;
const MAX_CHALLENGE_PROBE_BYTES = 2_000_000;

interface QueueItem {
  run: () => void;
}

interface SourceQueue {
  active: number;
  nextStart: number;
  interactive: QueueItem[];
  bulk: QueueItem[];
  interactiveStreak: number;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface SolverSession {
  cookie: string;
  userAgent: string;
  expiresAt: number;
}

interface SolverResponse {
  status?: string;
  message?: string;
  solution?: {
    status?: number;
    response?: string;
    userAgent?: string;
    headers?: Record<string, string>;
    cookies?: Array<{ name: string; value: string }>;
  };
}

const untilAborted = <T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
};

const DEFAULT_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export class SourceFetcher {
  private readonly queues = new Map<string, SourceQueue>();
  private readonly sessions = new Map<string, SolverSession>();
  private readonly solves = new Map<string, Promise<void>>();
  private readonly intervalMs: number;
  private readonly maxInFlight: number;
  private readonly timeoutMs: number;
  private readonly solverUrl: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: FetcherOptions = {}) {
    this.intervalMs = options.intervalMs ?? 1_500;
    this.maxInFlight = options.maxInFlight ?? 2;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.solverUrl = options.solverUrl;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  createModule(sourceId: string, site: string | (() => string)) {
    const fetchApi = (url: string, init?: RequestInit) => this.request(sourceId, typeof site === "function" ? site() : site, url, init);

    return buildFetchModule(fetchApi);
  }

  async request(sourceId: string, site: string, url: string, init: RequestInit = {}): Promise<Response> {
    const priority = priorityStorage.getStore() ?? "bulk";
    return this.schedule(
      sourceId,
      priority,
      async () => {
        init.signal?.throwIfAborted();
        const response = await this.timedFetch(url, this.withHeaders(site, url, init), this.timeoutMs);
        if (!(await this.isChallenge(response))) return response;
        if (!this.solverUrl) throw new ChallengeError();
        return this.solveOnce(site, url, init);
      },
      init.signal ?? undefined,
    );
  }

  private withHeaders(site: string, url: string, init: RequestInit): RequestInit {
    const origin = new URL(url).origin;
    const session = this.sessions.get(origin);
    if (session && session.expiresAt <= this.now()) this.sessions.delete(origin);
    const activeSession = this.sessions.get(origin);
    const headers = new Headers(init.headers);
    // A clearance cookie is bound to the solver's user agent, so the session's agent wins over the plugin's.
    if (activeSession) headers.set("user-agent", activeSession.userAgent);
    else if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_USER_AGENT);
    if (!headers.has("referer")) headers.set("referer", site);
    if (!headers.has("accept")) headers.set("accept", "*/*");
    if (activeSession?.cookie) {
      const existing = headers.get("cookie");
      headers.set("cookie", existing ? `${existing}; ${activeSession.cookie}` : activeSession.cookie);
    }
    return { ...init, headers, redirect: "follow" };
  }

  private async timedFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (controller.signal.aborted) throw new FetchTimeoutError();
      if (init.signal?.aborted) throw error;
      throw new SiteFetchError("Upstream request failed", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private async isChallenge(response: Response): Promise<boolean> {
    if (response.status !== 403 && response.status !== 503) return false;
    try {
      const body = await readCappedText(response.clone(), MAX_CHALLENGE_PROBE_BYTES);
      return /just a moment|cf-chl-|cdn-cgi\/challenge-platform/i.test(body);
    } catch {
      return false;
    }
  }

  // One solve per site at a time, run apart from the caller's deadline: a slow solve still stores its cookie for
  // the next attempt even when the call that started it has given up. Callers that find a solve running wait for it
  // and retry with the stored cookie.
  private async solveOnce(site: string, url: string, init: RequestInit): Promise<Response> {
    const origin = new URL(url).origin;
    const running = this.solves.get(origin);
    if (running) {
      await untilAborted(running, init.signal ?? undefined);
      const retry = await this.timedFetch(url, this.withHeaders(site, url, init), this.timeoutMs);
      if (await this.isChallenge(retry)) throw new ChallengeError();
      return retry;
    }
    const solving = this.solve(url, init);
    const settled: Promise<void> = solving
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (this.solves.get(origin) === settled) this.solves.delete(origin);
      });
    this.solves.set(origin, settled);
    return untilAborted(solving, init.signal ?? undefined);
  }

  private async solve(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") throw new ChallengeError(`Solver cannot replay ${method} requests`);
    if (method === "POST" && init.body !== undefined && init.body !== null && typeof init.body !== "string") {
      throw new ChallengeError("Solver can only replay form-encoded POST requests");
    }
    const command =
      method === "POST"
        ? { cmd: "request.post", url, postData: typeof init.body === "string" ? init.body : "", maxTimeout: this.timeoutMs }
        : { cmd: "request.get", url, maxTimeout: this.timeoutMs };
    const response = await this.timedFetch(
      this.solverUrl!,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      },
      this.timeoutMs + SOLVER_HEADROOM_MS,
    );
    if (!response.ok) throw new ChallengeError("Solver request failed");
    let result: SolverResponse;
    try {
      result = JSON.parse(await readCappedText(response, MAX_SOLVER_BYTES)) as SolverResponse;
    } catch {
      throw new ChallengeError("Solver returned an invalid response");
    }
    const solution = result.solution;
    if (result.status !== "ok" || !solution || solution.response === undefined) {
      throw new ChallengeError(result.message || "Solver did not return a solution");
    }
    const cookie = (solution.cookies ?? []).map(({ name, value }) => `${name}=${value}`).join("; ");
    this.sessions.set(new URL(url).origin, {
      cookie,
      userAgent: solution.userAgent || DEFAULT_USER_AGENT,
      expiresAt: this.now() + 30 * 60_000,
    });
    return new Response(solution.response, {
      status: solution.status ?? 200,
      ...(solution.headers ? { headers: solution.headers } : {}),
    });
  }

  private schedule<T>(sourceId: string, priority: Priority, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason as Error);
        return;
      }
      const queue = this.queues.get(sourceId) ?? {
        active: 0,
        nextStart: 0,
        interactive: [],
        bulk: [],
        interactiveStreak: 0,
        timer: undefined,
      };
      this.queues.set(sourceId, queue);
      const onAbort = (): void => {
        const lane = queue[priority];
        const index = lane.indexOf(item);
        if (index >= 0) lane.splice(index, 1);
        reject(signal!.reason as Error);
      };
      const item: QueueItem = {
        run: () => {
          signal?.removeEventListener("abort", onAbort);
          queue.active += 1;
          queue.nextStart = this.now() + this.intervalMs;
          void operation()
            .then(resolve, reject)
            .finally(() => {
              queue.active -= 1;
              this.drain(sourceId, queue);
            });
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      queue[priority].push(item);
      this.drain(sourceId, queue);
    });
  }

  private drain(sourceId: string, queue: SourceQueue): void {
    if (queue.active >= this.maxInFlight || (queue.interactive.length === 0 && queue.bulk.length === 0)) return;
    const delay = Math.max(0, queue.nextStart - this.now());
    if (delay > 0) {
      if (!queue.timer) {
        queue.timer = setTimeout(() => {
          queue.timer = undefined;
          this.drain(sourceId, queue);
        }, delay);
      }
      return;
    }
    this.next(queue).run();
    this.drain(sourceId, queue);
  }

  private next(queue: SourceQueue): QueueItem {
    const bulkWaiting = queue.bulk.length > 0;
    if (queue.interactive.length > 0 && !(bulkWaiting && queue.interactiveStreak >= INTERACTIVE_STREAK_LIMIT)) {
      if (bulkWaiting) queue.interactiveStreak += 1;
      return queue.interactive.shift()!;
    }
    queue.interactiveStreak = 0;
    return queue.bulk.shift()!;
  }
}
