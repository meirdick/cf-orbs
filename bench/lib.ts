// Shared helpers for the bench scripts. Node built-ins only. Run with Node 22.18+ (it runs
// TypeScript directly). Never prints the control token.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** BENCH_RESULTS_DIR redirects output (harness self-tests); results to publish go in bench/results. */
export const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ?? join(REPO_ROOT, "bench", "results");
export const SCHEMA = 1;

/** True when this module is the script node was started with (not imported by a test). */
export const isMain = (url: string) =>
  !!process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href;

// ---- errors ----

export class BenchError extends Error {
  readonly fix: string;
  constructor(cause: string, fix: string) {
    super(cause);
    this.fix = fix;
  }
}

export const fail = (cause: string, fix: string): never => {
  throw new BenchError(cause, fix);
};

/** Run main; print one line "Failed: <cause> — fix: <action>" on error. */
export function runMain(main: () => Promise<number>): void {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      if (e instanceof BenchError) console.error(`Failed: ${redact(e.message)} — fix: ${e.fix}`);
      else
        console.error(
          `Failed: ${redact(e instanceof Error ? e.message : String(e))} — fix: see the output above`,
        );
      process.exit(1);
    },
  );
}

/** Mask anything token-shaped. */
export function redact(s: string): string {
  return s
    .replace(/\b(aop_live_|orb_)[A-Za-z0-9_-]+/g, "$1<redacted>")
    .replace(/(Bearer\s+)\S+/gi, "$1<redacted>");
}

// ---- small utils ----

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const isoNow = () => new Date().toISOString();
/** File-name-safe ISO timestamp: 2026-10-30T18-05-52Z. */
export const isoFile = (d = new Date()) =>
  d
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-");

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  // stdin is closed: amp -x reads the prompt from stdin when a pipe is open and then times out.
  return new Promise((res) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? REPO_ROOT,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (!done) child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120_000);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (e) => {
      done = true;
      clearTimeout(timer);
      res({ code: 1, stdout, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      done = true;
      clearTimeout(timer);
      res({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function confirm(question: string, yes: boolean): Promise<void> {
  if (yes) return;
  if (!process.stdin.isTTY) fail("confirmation needed and stdin is not a terminal", "pass --yes");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (a !== "y" && a !== "yes") fail("cancelled", "run again and answer y, or pass --yes");
}

export function writeResult(prefix: string, data: unknown, dir = RESULTS_DIR): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${prefix}-${isoFile()}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

export function intArg(v: string | undefined, name: string, dflt: number, min = 1, max = 1000): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`--${name} must be an integer ${min}-${max}, got ${v}`, `fix --${name}`);
  return n;
}

// ---- statistics ----

export interface Summary {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
}

/** Nearest-rank percentile (no interpolation): the ceil(q·n)-th smallest value. */
export function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i] as number;
}

export function summarize(values: number[]): Summary | undefined {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return undefined;
  return {
    n: v.length,
    min: v[0] as number,
    p50: percentile(v, 0.5),
    p95: percentile(v, 0.95),
    max: v[v.length - 1] as number,
  };
}

// ---- prices. Re-verify when either side changes pricing. ----

export const RATES = {
  checked: "2026-10-30",
  source:
    "https://developers.cloudflare.com/containers/platform/pricing/ · https://ampcode.com/docs/orbs/sizes-and-costs",
  memGiBHour: 0.009,
  vcpuHour: 0.072,
  diskGBHour: 0.000252,
  ampEnterpriseCpuHour: 0.0504,
  ampEnterpriseGBHour: 0.0162,
  workersPaidMonth: 5,
  providerLiteMonth: 2.01,
  providerCustomMonth: 20,
  amp: { "a1.tiny": 0.08, "a1.small": 0.17, "a1.medium": 0.33 } as Record<string, number>,
};

export type InstanceSpec = string | { vcpu: number; memoryMib: number; diskMb: number };

export interface Shape {
  label: string;
  vcpu: number;
  memGiB: number;
  diskGB: number;
}

const NAMED: Record<string, Omit<Shape, "label">> = {
  "standard-1": { vcpu: 0.5, memGiB: 4, diskGB: 8 },
  "standard-2": { vcpu: 1, memGiB: 6, diskGB: 12 },
  "standard-3": { vcpu: 2, memGiB: 8, diskGB: 16 },
  "standard-4": { vcpu: 4, memGiB: 12, diskGB: 20 },
};

export function shapeOf(spec: InstanceSpec): Shape {
  if (typeof spec === "string") {
    const n = NAMED[spec];
    if (!n) return fail(`unknown instance ${spec}`, "use standard-1..4 or vcpu/memGiB/diskGB like 2/6/20");
    return { label: spec, ...n };
  }
  const memGiB = spec.memoryMib / 1024;
  const diskGB = spec.diskMb / 1000;
  return { label: `custom ${spec.vcpu}/${round(memGiB)}/${round(diskGB)}`, vcpu: spec.vcpu, memGiB, diskGB };
}

/** "standard-4" or "2/6/20" (vCPU/GiB/GB) → instance spec as the Worker takes it. */
export function parseInstanceArg(v: string): InstanceSpec {
  if (NAMED[v]) return v;
  const m = /^(\d+(?:\.\d+)?)\/(\d+)\/(\d+)$/.exec(v);
  if (!m) return fail(`--instance ${v} is not valid`, "use standard-1..4 or vcpu/memGiB/diskGB like 2/6/20");
  return { vcpu: Number(m[1]), memoryMib: Number(m[2]) * 1024, diskMb: Number(m[3]) * 1000 };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Awake cost per hour at a CPU utilization (0-1). Memory and disk bill on provisioned size, CPU on use. */
export function awakePerHour(s: Shape, cpuUtil: number): number {
  return s.memGiB * RATES.memGiBHour + s.diskGB * RATES.diskGBHour + s.vcpu * RATES.vcpuHour * cpuUtil;
}

/** Amp Enterprise fee formula for a self-hosted orb of this size (lower bound, risk R7). */
export function ampEnterprisePerHour(s: Shape): number {
  return s.vcpu * RATES.ampEnterpriseCpuHour + s.memGiB * RATES.ampEnterpriseGBHour;
}

/** Usable disk after the orb image (M0: 15 GB free on a 20 GB disk, 4.8 GB on standard-1). Conservative. */
export function freeDiskGB(s: Shape): number {
  return s.diskGB * 0.93 - 3.6;
}

// ---- install dir ----

export interface Install {
  dir: string;
  url: string;
  /** Bearer for the control plane. Never print it. */
  token: string;
  cliVersion?: string;
  providerName?: string;
  compatibilityDate?: string;
  config: Record<string, unknown>;
  instance: InstanceSpec;
  baseImageDigest?: string;
  dockerfileSha?: string;
}

/** Strip // and /* *\/ comments outside strings, then trailing commas. Enough for wrangler.jsonc. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i] as string;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      i = i < 0 ? text.length : i + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function readInstall(dirArg: string | undefined): Install {
  if (!dirArg) return fail("--dir is missing", "pass --dir <the directory where you ran cf-orbs init>");
  const dir = resolve(dirArg);
  const stateFile = join(dir, ".cf-orbs", "state.json");
  const tokenFile = join(dir, ".cf-orbs", "control-token");
  if (!existsSync(stateFile)) fail(`${stateFile} not found`, "pass the directory where you ran cf-orbs init");
  if (!existsSync(tokenFile)) fail(`${tokenFile} not found`, "run cf-orbs deploy in that directory");
  const state = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
  const url = typeof state.url === "string" ? state.url.replace(/\/+$/, "") : "";
  if (!url) fail(`${stateFile} has no url`, "run cf-orbs deploy in that directory");
  const token = readFileSync(tokenFile, "utf8").trim();
  if (!token) fail(`${tokenFile} is empty`, "run cf-orbs deploy in that directory");

  let compatibilityDate: string | undefined;
  let config: Record<string, unknown> = {};
  const wj = join(dir, ".cf-orbs", "wrangler.jsonc");
  if (existsSync(wj)) {
    const w = parseJsonc(readFileSync(wj, "utf8")) as Record<string, any>;
    compatibilityDate = typeof w.compatibility_date === "string" ? w.compatibility_date : undefined;
    try {
      config = JSON.parse(String(w.vars?.CF_ORBS_CONFIG ?? "{}")) as Record<string, unknown>;
    } catch {}
  }
  let baseImageDigest: string | undefined;
  let dockerfileSha: string | undefined;
  const df = join(dir, "image", "Dockerfile");
  if (existsSync(df)) {
    const text = readFileSync(df, "utf8");
    dockerfileSha = sha256(text).slice(0, 12);
    baseImageDigest = /^FROM\s+\S+@(sha256:[0-9a-f]{64})/m.exec(text)?.[1];
  }
  return {
    dir,
    url,
    token,
    cliVersion: typeof state.cliVersion === "string" ? state.cliVersion : undefined,
    providerName: typeof state.providerName === "string" ? state.providerName : undefined,
    compatibilityDate,
    config,
    instance: (config.instance as InstanceSpec | undefined) ?? { vcpu: 4, memoryMib: 12288, diskMb: 20000 },
    baseImageDigest,
    dockerfileSha,
  };
}

// ---- control plane client ----

export interface Api {
  get(path: string, timeoutMs?: number): Promise<any>;
  post(path: string, body: unknown, timeoutMs?: number): Promise<any>;
}

export function makeApi(inst: Pick<Install, "url" | "token">, f: typeof fetch = fetch): Api {
  const call = async (method: string, path: string, body: unknown, timeoutMs: number) => {
    let res: Response;
    try {
      res = await f(`${inst.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${inst.token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return fail(`${method} ${path}: ${(e as Error).message}`, "check your network and run cf-orbs doctor");
    }
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    if (res.status === 404 && /debugExec is false/.test(text))
      fail(
        `${path}: bench and exec are off on this install`,
        'set "debugExec": true in cf-orbs.config.jsonc and run cf-orbs deploy',
      );
    if (res.status === 401)
      fail(`${path}: control token rejected (401)`, "run cf-orbs deploy to re-send .cf-orbs/control-token");
    if (res.status === 404)
      fail(`${path}: route not found (404); the Worker is older than this harness`, "run cf-orbs deploy");
    if (res.status >= 300) {
      const err = typeof parsed === "object" && parsed?.error ? String(parsed.error) : text.slice(0, 300);
      const m = /^Failed: (.*?) — fix: (.*)$/s.exec(err);
      if (m) fail(`${path}: ${m[1]} (HTTP ${res.status})`, m[2] as string);
      fail(`${path}: HTTP ${res.status} ${err}`, "run cf-orbs doctor");
    }
    return parsed;
  };
  return {
    get: (p, t = 30_000) => call("GET", p, undefined, t),
    post: (p, b, t = 30_000) => call("POST", p, b, t),
  };
}

// ---- stamps ----

export async function harnessStamps(): Promise<Record<string, unknown>> {
  const head = await run("git", ["rev-parse", "HEAD"]);
  // Result JSON written by earlier runs is not a harness change: leave bench/results out of the dirty check.
  const dirty = await run("git", ["status", "--porcelain", "--", ".", ":(exclude)bench/results"]);
  const rootPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as Record<string, any>;
  const cliPkg = JSON.parse(readFileSync(join(REPO_ROOT, "cli", "package.json"), "utf8")) as Record<
    string,
    any
  >;
  return {
    harnessCommit: head.code === 0 ? head.stdout.trim() : "unknown",
    harnessDirty: dirty.code === 0 ? dirty.stdout.trim() !== "" : undefined,
    cfOrbsVersion: cliPkg.version,
    workersTypes: rootPkg.devDependencies?.["@cloudflare/workers-types"],
    node: process.version,
    client: `${process.platform}-${process.arch}`,
  };
}

/** Stamps that describe a cf-orbs install. Wrangler is the version this clone would deploy with. */
export async function installStamps(inst: Install): Promise<Record<string, unknown>> {
  return {
    wrangler: await wranglerVersion(),
    compatibilityDate: inst.compatibilityDate,
    baseImageDigest: inst.baseImageDigest,
    ampImageDigest: typeof inst.config.ampImageDigest === "string" ? inst.config.ampImageDigest : undefined,
    dockerfileSha: inst.dockerfileSha,
    installCliVersion: inst.cliVersion,
    instance: inst.instance,
    instanceLabel: shapeOf(inst.instance).label,
  };
}

export async function wranglerVersion(): Promise<string | undefined> {
  const r = await run("npx", ["--no-install", "wrangler", "--version"], { timeoutMs: 60_000 });
  const v = /(\d+\.\d+\.\d+)/.exec(r.stdout)?.[1];
  if (v) return v;
  try {
    return JSON.parse(readFileSync(join(REPO_ROOT, "node_modules", "wrangler", "package.json"), "utf8"))
      .version;
  } catch {
    return undefined;
  }
}

export async function ampVersion(): Promise<string | undefined> {
  const r = await run("amp", ["--version"], { timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout.trim().split(/\s+/)[0] : undefined;
}

export function countBy<T>(xs: T[], key: (x: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = key(x);
    if (k === undefined) continue;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ---- orb time vs model time ----

/** A run is model-stalled when msg → first assistant is above max(STALL_FACTOR × p50 of the run set, STALL_MIN_S). */
export const STALL_FACTOR = 2;
export const STALL_MIN_S = 20;
export const STALL_RULE = `msg → first assistant > max(${STALL_FACTOR} × p50 of the run set, ${STALL_MIN_S} s)`;

export interface TurnTimes {
  msgAt?: number;
  firstAssistantAt?: number;
  firstToolResultAt?: number;
  msgToFirstAssistantS?: number;
  msgToFirstToolS?: number;
  toolRoundTripsS?: number[];
}

export interface Split {
  /**
   * firstAssistantAt − msgAt, s. Wake run: Amp, AI Gateway and model only (the model does not wait for the
   * orb). New thread: also orb setup, because Amp waits for spawn, bootstrap and .agents/setup or resume.
   */
  nonOrbS?: number;
  /** firstToolResultAt − firstAssistantAt, s: orb wait + command run (the first tool round trip). */
  orbS?: number;
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Split the first turn at the first assistant message (it carries the first tool_use). Computed from the
 * stored timestamps, so old result files get it too. Files without the epoch fields fall back to the stored
 * second fields (same differences), then to the first tool round trip.
 */
export function splitTimings(t: TurnTimes | undefined): Split {
  if (!t) return {};
  const nonOrbS =
    num(t.msgAt) && num(t.firstAssistantAt)
      ? (t.firstAssistantAt - t.msgAt) / 1000
      : num(t.msgToFirstAssistantS)
        ? t.msgToFirstAssistantS
        : undefined;
  const orbS =
    num(t.firstAssistantAt) && num(t.firstToolResultAt)
      ? (t.firstToolResultAt - t.firstAssistantAt) / 1000
      : num(t.msgToFirstToolS) && num(t.msgToFirstAssistantS)
        ? t.msgToFirstToolS - t.msgToFirstAssistantS
        : num(t.toolRoundTripsS?.[0])
          ? t.toolRoundTripsS[0]
          : undefined;
  return { nonOrbS, orbS };
}

/** Stall threshold in seconds for a run set (nearest-rank p50), or undefined when no run has a non-orb time. */
export function stallThresholdS(nonOrbS: Array<number | undefined>): number | undefined {
  const s = summarize(nonOrbS.filter(num));
  return s ? Math.max(STALL_FACTOR * s.p50, STALL_MIN_S) : undefined;
}

export const isStalled = (nonOrbS: number | undefined, thresholdS: number | undefined): boolean =>
  num(nonOrbS) && num(thresholdS) && nonOrbS > thresholdS;

/**
 * Add nonOrbS, orbS and (successful runs only) stalled to each run record, in place. Returns the stall summary
 * for the result file. The renderer computes the same values again from the timestamps.
 */
export function markStalls(runs: Array<Record<string, any>>): {
  rule: string;
  thresholdS?: number;
  stalled: number;
  of: number;
} {
  for (const r of runs) Object.assign(r, splitTimings(r.timings));
  const ok = runs.filter((r) => r.ok && num(r.nonOrbS));
  const thresholdS = stallThresholdS(ok.map((r) => r.nonOrbS));
  for (const r of ok) r.stalled = isStalled(r.nonOrbS, thresholdS);
  return { rule: STALL_RULE, thresholdS, stalled: ok.filter((r) => r.stalled).length, of: ok.length };
}

// ---- fixed work job (bench/prompt-work.txt) ----

/** What the orb measured for the fixed job in bench/prompt-work.txt (the CFBENCH line). */
export interface WorkTimes {
  cpuS?: number;
  diskS?: number;
  cloneS?: number;
  npmS?: number;
  nproc?: number;
  memMb?: number;
}

const WORK_KEYS: Record<string, keyof WorkTimes> = {
  cpu_s: "cpuS",
  disk_s: "diskS",
  clone_s: "cloneS",
  npm_s: "npmS",
  nproc: "nproc",
  mem_mb: "memMb",
};

/**
 * The last CFBENCH line in a text: `CFBENCH cpu_s=… disk_s=… clone_s=… npm_s=… nproc=… mem_mb=…`. Only
 * numeric values count (the printf template in the command has none). Undefined when no line has a value.
 */
export function parseWork(text: string): WorkTimes | undefined {
  let out: WorkTimes | undefined;
  for (const m of text.matchAll(/CFBENCH((?:[ \t]+[a-z_]+=[^\s"\\]*)+)/g)) {
    const w: WorkTimes = {};
    for (const kv of (m[1] as string).matchAll(/([a-z_]+)=(-?[0-9]+(?:\.[0-9]+)?)(?![^\s"\\])/g)) {
      const k = WORK_KEYS[kv[1] as string];
      if (k) w[k] = Number(kv[2]);
    }
    if (Object.keys(w).length) out = w;
  }
  return out;
}

/** The CFBENCH line from the tool results of the turn that starts at fromIndex (tool output only, never model text). */
export function workFromThread(t: any, fromIndex = 0): WorkTimes | undefined {
  const msgs: any[] = Array.isArray(t?.messages) ? t.messages : [];
  let out: WorkTimes | undefined;
  for (const m of msgs.slice(fromIndex)) {
    if (m?.role !== "user" || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c?.type !== "tool_result") continue;
      out = parseWork(JSON.stringify(c)) ?? out;
    }
  }
  return out;
}
