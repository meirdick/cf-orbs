// Client for the control plane's public /v1 routes (bearer CONTROL_TOKEN).
// Routes used (the Worker must serve these when CONTROL_TOKEN is set):
//   GET  /v1/health                 → 200 {ok:true,...}
//   GET  /v1/status                 → {registry: RegistrySummary, provider: ProviderStatus}; read loosely
//   GET  /v1/orbs/:id               → OrbStatus (worker/src/core/types.ts)
//   GET  /v1/orbs/:id/logs?lines=N  → {containerRunning, log: string}
//   POST /v1/provider/start         → start ProviderHost now (init only; doctor never calls it). Optional:
//                                     on 404 init waits for the 5-min cron instead.
//   POST /v1/provider/restart?ifImageChanged=1 → restart the provider if its image changed (deploy, upgrade);
//                                     {action, reason, restarted, ...ProviderStatus}
//   GET    /v1/project-snapshots       → {projectSnapshots: ProjectSnapshotRow[], summary: RegistrySummary}
//   DELETE /v1/project-snapshots/:id   → {snapshotId, forgotten: boolean}
//   GET    /v1/snapshots?candidates=1&olderThan=<s> → PruneResult (worker/src/core/registry-core.ts)
//   POST   /v1/snapshots/forget-many {ids}          → {forgotten: string[], mapped: string[]}
//   POST   /v1/warm                    → start prewarm (deploy, init); {count, started, orbIds}
//   GET    /v1/warm                    → {prewarm: config value, last: WarmRunView | null}
import { CliError } from "./errors.js";

export const ORB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type Fetch = typeof fetch;

export interface ApiClient {
  url: string;
  get(path: string): Promise<ApiResponse>;
  post(path: string, body?: unknown): Promise<ApiResponse>;
  del(path: string): Promise<ApiResponse>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  text: string;
}

export function makeApi(
  url: string,
  token: string | undefined,
  f: Fetch = fetch,
  timeoutMs = 20_000,
): ApiClient {
  const base = url.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown): Promise<ApiResponse> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await f(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new CliError(
        `cannot reach ${base} (${(e as Error).message})`,
        "check your network, then run cf-orbs doctor",
      );
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    return { status: res.status, body: parsed, text };
  };
  return {
    url: base,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    del: (p) => call("DELETE", p),
  };
}

/** Throw a one-line error for a non-2xx response. */
export function expectOk(r: ApiResponse, what: string): unknown {
  if (r.status >= 200 && r.status < 300) return r.body;
  if (r.status === 401) {
    throw new CliError(
      `${what}: control token rejected (401)`,
      "run cf-orbs deploy to re-send the token in .cf-orbs/control-token",
    );
  }
  if (r.status === 404) {
    throw new CliError(
      `${what}: route not found (404); the public API is off or the Worker is old`,
      "run cf-orbs deploy",
    );
  }
  const msg =
    typeof r.body === "object" && r.body && "error" in r.body
      ? String((r.body as { error: unknown }).error)
      : r.text.slice(0, 200);
  // Worker errors are already "Failed: <cause> — fix: <fix>". Keep its fix; add only what failed.
  const m = /^Failed: (.*?) — fix: (.*)$/s.exec(msg.trim());
  if (m) throw new CliError(`${what}: ${m[1]} (HTTP ${r.status})`, m[2] as string);
  throw new CliError(`${what}: HTTP ${r.status} ${msg}`, "run cf-orbs doctor");
}

export function checkOrbId(id: string): string {
  if (!ORB_ID_RE.test(id))
    throw new CliError(
      `invalid orb id ${JSON.stringify(id)}`,
      "pass the orb id from cf-orbs status (e.g. amp-T-…)",
    );
  return id;
}

/** Provider fields from /v1/status ({registry, provider: ProviderStatus}); tolerant of older shapes. */
export interface ProviderInfo {
  running?: boolean;
  lastLogLine?: string;
  logTail: string[];
  startedAt?: string;
  restarts?: number;
  lastError?: string;
  stopped?: boolean;
  /** Image ref and provider build the running container started from; the deploy's, when they differ. */
  image?: string;
  build?: string;
  deployedImage?: string;
  deployedBuild?: string;
}

export function providerInfo(status: unknown): ProviderInfo {
  if (!status || typeof status !== "object") return { logTail: [] };
  const p = (status as Record<string, unknown>).provider;
  if (!p || typeof p !== "object") return { logTail: [] };
  const o = p as Record<string, unknown>;
  const arr = [o.logTail, o.log, o.lines].find(Array.isArray) as unknown[] | undefined;
  const logTail = (arr ?? []).map(String);
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return {
    running: typeof o.running === "boolean" ? o.running : undefined,
    lastLogLine: str(o.lastLogLine) ?? logTail[logTail.length - 1],
    logTail,
    startedAt: str(o.startedAt),
    restarts: typeof o.restarts === "number" ? o.restarts : undefined,
    lastError: str(o.lastError) ?? str(o.error),
    stopped: typeof o.stopped === "boolean" ? o.stopped : undefined,
    image: str(o.image),
    build: str(o.build),
    deployedImage: str(o.deployedImage),
    deployedBuild: str(o.deployedBuild),
  };
}

/**
 * Every distinct image key named anywhere in a JSON value: "imageKey" string fields (handles, mappings) and
 * "imageKeys" string arrays (a Registry summary of keys that live snapshots use).
 */
export function collectImageKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) collectImageKeys(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (k === "imageKey" && typeof x === "string") out.add(x);
      else if (k === "imageKeys" && Array.isArray(x)) {
        for (const y of x) if (typeof y === "string") out.add(y);
      } else collectImageKeys(x, out);
    }
  }
  return out;
}
