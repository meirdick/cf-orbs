// Substrate bench: Cloudflare Containers only, no Amp. Uses the bench routes of a cf-orbs
// install with "debugExec": true. Bench orbs are named bench-<run>-<n>; Amp never sends such ids.
//
//   npm run bench:substrate -- --dir <install dir> [--runs 5] [--sizes 1,5,10] [--parallel 10]
//                              [--cache-files 20000] [--restore-delay 0] [--instance 2/6/20] [--yes]
//
// Per run and size S: start from image → write S GB random + sha256 → snapshot → destroy → (wait
// --restore-delay s) → restore (same orb) → sha256 again (first full read of lazily restored data) → destroy.
// Per run also a build-cache workload: many small files (like node_modules or a build cache), read before the
// snapshot (page cache warm) and again after the restore. Then one snapshot is restored by --parallel new orbs
// at once. Every sample is kept: a failed start, snapshot or destroy is a failed sample and the bench goes on.
import { parseArgs } from "node:util";
import {
  type Api,
  awakePerHour,
  BenchError,
  confirm,
  countBy,
  fail,
  freeDiskGB,
  harnessStamps,
  type InstanceSpec,
  intArg,
  isMain,
  isoNow,
  makeApi,
  parseInstanceArg,
  RATES,
  readInstall,
  runMain,
  SCHEMA,
  type Shape,
  shapeOf,
  sleep,
  wranglerVersion,
  writeResult,
} from "./lib.ts";

export interface Sample {
  metric: string;
  run: number;
  orbId: string;
  ok: boolean;
  ms?: number;
  sizeGb?: number;
  bytes?: number;
  mbps?: number;
  firstOfRun?: boolean;
  /** Sample from the build-cache run (snapshot, pause, restore and destroy of the cache orb). */
  cache?: boolean;
  doColo?: string;
  containerColo?: string;
  workerColo?: string;
  error?: string;
}

const FILE = "/home/user/bench.bin";
const CACHE_DIR = "/home/user/bench-cache";
/** undici's default header timeout is 300 s; stay under it. */
const MAX_EXEC_MS = 290_000;
/** The DO gives a start up to JOB_DEADLINE_MS (270 s); wait longer than that, but under undici's 300 s. */
const START_TIMEOUT_MS = 295_000;
export const DEFAULT_SIZES = [1, 5, 10];

/** Errors that fail every request the same way (token, old Worker, debugExec off): stop, do not record. */
const isSetupError = (e: unknown) =>
  e instanceof BenchError && /control token rejected|route not found|bench and exec are off/.test(e.message);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Seconds of awake orb time per step: guesses from M0, not measured bounds. */
export function estimateOrbSeconds(o: {
  runs: number;
  sizes: number[];
  parallel: number;
  cacheFiles: number;
}): number {
  const perSize = (gb: number) => 40 + 10 + gb * (5 + 4 + 6.5 + 5);
  const cache = o.cacheFiles > 0 ? 40 + 10 + (o.cacheFiles / 20_000) * 60 : 0;
  const perRun = o.sizes.reduce((a, gb) => a + perSize(gb), 0) + cache;
  return o.runs * perRun + 60 + o.parallel * 40;
}

export function costUsd(orbSeconds: number, s: Shape): number {
  return (orbSeconds / 3600) * awakePerHour(s, 1);
}

function parse() {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      runs: { type: "string" },
      sizes: { type: "string" },
      parallel: { type: "string" },
      "cache-files": { type: "string" },
      "restore-delay": { type: "string" },
      instance: { type: "string" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  const sizes = (values.sizes ?? DEFAULT_SIZES.join(",")).split(",").map((s) => Number(s.trim()));
  if (sizes.some((s) => !Number.isInteger(s) || s < 1 || s > 19))
    fail(`--sizes ${values.sizes} is not valid`, "use whole GB from 1 to 19, comma separated, like 1,5,10");
  return {
    help: values.help === true,
    dir: values.dir,
    runs: intArg(values.runs, "runs", 5, 1, 100),
    sizes,
    parallel: intArg(values.parallel, "parallel", 10, 0, 50),
    cacheFiles: intArg(values["cache-files"], "cache-files", 20_000, 0, 200_000),
    restoreDelayS: intArg(values["restore-delay"], "restore-delay", 0, 0, 3600),
    instance: values.instance ? parseInstanceArg(values.instance) : undefined,
    yes: values.yes === true,
  };
}

type StartResult = {
  ready: boolean;
  readyMs?: number;
  error?: string;
  doColo?: string;
  workerColo?: string;
};

export class Bench {
  readonly samples: Sample[] = [];
  readonly live = new Set<string>();
  private firstStartDone = false;
  private readonly api: Api;
  private readonly instance: InstanceSpec;
  private readonly restoreDelayMs: number;

  constructor(api: Api, instance: InstanceSpec, restoreDelayMs = 0) {
    this.api = api;
    this.instance = instance;
    this.restoreDelayMs = restoreDelayMs;
  }

  private path(orbId: string, what: "bench" | "exec") {
    return `/v1/orbs/${encodeURIComponent(orbId)}/${what}`;
  }

  /** Never throws except on a setup error. A client timeout or HTTP error is ready: false. */
  async start(orbId: string, source: "image" | { snapshotId: string }): Promise<StartResult> {
    const body = { action: "start", source, instance: this.instance };
    // Before the request: if the client gives up while the DO still starts the container, cleanup destroys
    // it. Destroy on a stopped bench orb does nothing.
    this.live.add(orbId);
    try {
      let r = await this.api.post(this.path(orbId, "bench"), body, START_TIMEOUT_MS);
      // A restore right after destroy on the same orb can see the old instance for a moment: retry once.
      if (!r.ready && /already running/.test(String(r.error))) {
        await sleep(2000);
        r = await this.api.post(this.path(orbId, "bench"), body, START_TIMEOUT_MS);
      }
      return r;
    } catch (e) {
      if (isSetupError(e)) throw e;
      return { ready: false, error: msg(e) };
    }
  }

  async snapshot(
    orbId: string,
    name: string,
  ): Promise<{ id?: string; size?: number; ms?: number; syncMs?: number; error?: string }> {
    try {
      return await this.api.post(this.path(orbId, "bench"), { action: "snapshot", name }, MAX_EXEC_MS);
    } catch (e) {
      if (isSetupError(e)) throw e;
      return { error: msg(e) };
    }
  }

  async destroy(orbId: string): Promise<{ ok: boolean; ms?: number; error?: string }> {
    try {
      const r = (await this.api.post(this.path(orbId, "bench"), { action: "destroy" }, 120_000)) as {
        ms: number;
      };
      this.live.delete(orbId);
      return { ok: true, ms: r.ms };
    } catch (e) {
      if (isSetupError(e)) throw e;
      return { ok: false, error: msg(e) };
    }
  }

  async exec(orbId: string, script: string, timeoutMs = 120_000) {
    const r = await this.api.post(
      this.path(orbId, "exec"),
      { cmd: ["bash", "-c", script], timeoutMs: Math.min(timeoutMs, MAX_EXEC_MS - 5000) },
      MAX_EXEC_MS,
    );
    if (r?.error) throw new Error(`exec: ${r.error}`);
    if (r.exitCode !== 0)
      throw new Error(
        `exec exit ${r.exitCode}: ${String(r.stderr || r.stdout)
          .trim()
          .split("\n")
          .at(-1)}`,
      );
    return r as { stdout: string; durationMs: number };
  }

  async colo(orbId: string): Promise<string | undefined> {
    try {
      const r = await this.exec(
        orbId,
        "curl -s --max-time 5 https://www.cloudflare.com/cdn-cgi/trace",
        20_000,
      );
      return /^colo=([A-Z]{3})$/m.exec(r.stdout)?.[1];
    } catch {
      return undefined;
    }
  }

  add(s: Sample) {
    this.samples.push(s);
    const v = !s.ok
      ? `FAILED ${s.error}`
      : s.ms === undefined
        ? "ok"
        : `${(s.ms / 1000).toFixed(2)} s${s.mbps ? ` (${s.mbps} MB/s)` : ""}`;
    console.log(`  ${s.orbId} ${s.metric}${s.sizeGb ? ` ${s.sizeGb} GB` : s.cache ? " (cache)" : ""}: ${v}`);
  }

  /** Start from image; records an image-start sample. Returns false on failure. */
  async imageStart(run: number, orbId: string): Promise<boolean> {
    const firstOfRun = !this.firstStartDone;
    this.firstStartDone = true;
    const r = await this.start(orbId, "image");
    const containerColo = r.ready ? await this.colo(orbId) : undefined;
    this.add({
      metric: "image-start",
      run,
      orbId,
      ok: r.ready,
      ms: r.ready ? r.readyMs : undefined,
      firstOfRun,
      doColo: r.doColo,
      workerColo: r.workerColo,
      containerColo,
      error: r.ready ? undefined : (r.error ?? "not ready"),
    });
    return r.ready;
  }

  /** snapshot → destroy; always records snapshot, destroy and pause samples. Returns the snapshot id. */
  async pause(
    run: number,
    orbId: string,
    sizeGb: number | undefined,
    name: string,
    cache?: boolean,
  ): Promise<string | undefined> {
    const tag = cache ? { cache } : {};
    const s = await this.snapshot(orbId, name);
    const snapErr = s.id ? undefined : (s.error ?? "no snapshot id");
    this.add({
      metric: "snapshot",
      run,
      orbId,
      sizeGb,
      ...tag,
      ok: !!s.id,
      ms: s.id ? s.ms : undefined,
      bytes: s.size,
      error: snapErr,
    });
    const d = await this.destroy(orbId);
    this.add({ metric: "destroy", run, orbId, sizeGb, ...tag, ok: d.ok, ms: d.ms, error: d.error });
    const ok = !!s.id && d.ok;
    this.add({
      metric: "pause",
      run,
      orbId,
      sizeGb,
      ...tag,
      ok,
      ms: ok ? (s.syncMs ?? 0) + (s.ms ?? 0) + (d.ms ?? 0) : undefined,
      error: ok ? undefined : (snapErr ?? d.error),
    });
    return ok ? s.id : undefined;
  }

  async restore(
    run: number,
    orbId: string,
    sizeGb: number | undefined,
    snapshotId: string,
    cache?: boolean,
  ): Promise<boolean> {
    if (this.restoreDelayMs > 0) await sleep(this.restoreDelayMs);
    const r = await this.start(orbId, { snapshotId });
    const containerColo = r.ready ? await this.colo(orbId) : undefined;
    this.add({
      metric: "restore",
      run,
      orbId,
      sizeGb,
      ...(cache ? { cache } : {}),
      ok: r.ready,
      ms: r.ready ? r.readyMs : undefined,
      doColo: r.doColo,
      containerColo,
      error: r.ready ? undefined : (r.error ?? "not ready"),
    });
    return r.ready;
  }

  async timed(
    run: number,
    orbId: string,
    metric: string,
    sizeGb: number | undefined,
    bytes: number | undefined,
    script: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    try {
      const r = await this.exec(orbId, script, timeoutMs);
      const mbps = bytes ? Math.round(bytes / 1e6 / Math.max(0.001, r.durationMs / 1000)) : undefined;
      this.add({ metric, run, orbId, sizeGb, ok: true, ms: r.durationMs, bytes, mbps });
      return r.stdout.trim();
    } catch (e) {
      this.add({ metric, run, orbId, sizeGb, ok: false, error: (e as Error).message });
      return undefined;
    }
  }

  async sizeRun(run: number, orbId: string, gb: number): Promise<string | undefined> {
    const bytes = gb * 1e9;
    const t = 60_000 + gb * 30_000;
    if (!(await this.imageStart(run, orbId))) return undefined;
    try {
      const w = await this.timed(
        run,
        orbId,
        "write",
        gb,
        bytes,
        `head -c ${bytes} /dev/urandom > ${FILE} && sync`,
        t,
      );
      if (w === undefined) return undefined;
      const before = await this.timed(
        run,
        orbId,
        "checksum-before",
        gb,
        bytes,
        `sha256sum ${FILE} | cut -c1-64`,
        t,
      );
      if (!before) return undefined;
      const snap = await this.pause(run, orbId, gb, `${orbId}-s`);
      if (!snap) return undefined;
      if (!(await this.restore(run, orbId, gb, snap))) return undefined;
      const after = await this.timed(
        run,
        orbId,
        "read-after-restore",
        gb,
        bytes,
        `sha256sum ${FILE} | cut -c1-64`,
        t,
      );
      this.add({
        metric: "verify",
        run,
        orbId,
        sizeGb: gb,
        ok: after === before,
        error: after === before ? undefined : "checksum after restore differs",
      });
      return after === before ? snap : undefined;
    } finally {
      if (this.live.has(orbId)) await this.destroy(orbId).catch(() => undefined);
    }
  }

  /** Build-cache workload: n small files (1-32 KB), read before the snapshot and after the restore. */
  async cacheRun(run: number, orbId: string, files: number): Promise<void> {
    if (!(await this.imageStart(run, orbId))) return;
    const gen =
      `python3 - <<'PY'\nimport os\nroot=${JSON.stringify(CACHE_DIR)}\nn=${files}\ntotal=0\n` +
      `for i in range(n):\n  d=os.path.join(root, 'pkg%04d' % (i // 100))\n  os.makedirs(d, exist_ok=True)\n` +
      `  sz=1024+(i*7919)%31744\n  open(os.path.join(d, 'f%03d.js' % (i % 100)),'wb').write(os.urandom(sz))\n  total+=sz\n` +
      `print(total)\nPY\nsync`;
    const read = `cd ${CACHE_DIR} && find . -type f -print0 | sort -z | xargs -0 cat | sha256sum | cut -c1-64`;
    try {
      const total = await this.timed(run, orbId, "cache-write", undefined, undefined, gen, 240_000);
      const bytes = Number(total) || undefined;
      const before = await this.timed(run, orbId, "cache-read-before", undefined, bytes, read, 240_000);
      if (!before) return;
      const snap = await this.pause(run, orbId, undefined, `${orbId}-c`, true);
      if (!snap || !(await this.restore(run, orbId, undefined, snap, true))) return;
      const after = await this.timed(run, orbId, "cache-read-after-restore", undefined, bytes, read, 240_000);
      this.add({
        metric: "cache-verify",
        run,
        orbId,
        ok: after === before,
        error: after === before ? undefined : "checksum differs",
      });
    } finally {
      if (this.live.has(orbId)) await this.destroy(orbId).catch(() => undefined);
    }
  }

  async parallelRestore(runId: string, n: number, snapshotId: string, sizeGb: number) {
    const ids = Array.from({ length: n }, (_, i) => `bench-${runId}-p${i}`);
    const t0 = Date.now();
    const rs = await Promise.all(
      ids.map(async (orbId) => {
        const c0 = Date.now();
        const r = await this.start(orbId, { snapshotId });
        return { orbId, r, clientMs: Date.now() - c0 };
      }),
    );
    const wallMs = Date.now() - t0;
    const checks = await Promise.all(
      rs.map(async ({ orbId, r }) => {
        if (!r.ready) return undefined;
        try {
          return (
            (await this.exec(orbId, `stat -c %s ${FILE}`, 30_000)).stdout.trim() === String(sizeGb * 1e9)
          );
        } catch {
          return false;
        }
      }),
    );
    rs.forEach(({ orbId, r }, i) => {
      const ok = r.ready && checks[i] === true;
      this.add({
        metric: "parallel-restore",
        run: 0,
        orbId,
        sizeGb,
        ok,
        ms: r.ready ? r.readyMs : undefined,
        doColo: r.doColo,
        error: r.ready ? (ok ? undefined : "file missing or wrong size after restore") : r.error,
      });
    });
    await Promise.all(
      ids.map((id) => (this.live.has(id) ? this.destroy(id).catch(() => undefined) : undefined)),
    );
    const ok = rs.filter((_, i) => checks[i] === true).length;
    const slowest = Math.max(0, ...rs.filter((x) => x.r.ready).map((x) => x.r.readyMs ?? 0));
    return { n, ok, wallMs, slowestReadyMs: slowest, sizeGb, clientMs: rs.map((x) => x.clientMs) };
  }

  async cleanup() {
    await Promise.all([...this.live].map((id) => this.destroy(id).catch(() => undefined)));
    if (this.live.size)
      console.error(
        `could not destroy ${[...this.live].join(", ")}; the DO alarm stops them within 30 min (BENCH_LEASE_MS)`,
      );
  }
}

async function main(): Promise<number> {
  const o = parse();
  if (o.help) {
    console.log(
      "npm run bench:substrate -- --dir <install dir> [--runs 5] [--sizes 1,5,10] [--parallel 10] [--cache-files 20000] [--restore-delay <s>] [--instance 2/6/20|standard-4] [--yes]",
    );
    return 0;
  }
  const inst = readInstall(o.dir);
  if (inst.config.debugExec !== true)
    fail(
      "this install has debugExec off",
      'set "debugExec": true in cf-orbs.config.jsonc and run cf-orbs deploy',
    );
  const instance = o.instance ?? inst.instance;
  const shape = shapeOf(instance);
  const need = Math.max(...o.sizes) + o.cacheFiles * 16_500 * 1e-9 + 1;
  if (need > freeDiskGB(shape))
    fail(
      `${Math.max(...o.sizes)} GB does not fit on ${shape.label} (about ${freeDiskGB(shape).toFixed(1)} GB free after the image)`,
      "use smaller --sizes or a larger --instance (2/6/20 or standard-4 have 20 GB disk)",
    );

  const api = makeApi(inst);
  const health = await api.get("/v1/health");
  const orbSeconds = estimateOrbSeconds(o);
  const usd = costUsd(orbSeconds, shape);
  console.log(`cf-orbs substrate bench on ${inst.url.replace(/^https?:\/\//, "")} (${shape.label})`);
  console.log(
    `  runs ${o.runs}, sizes ${o.sizes.join(",")} GB, cache files ${o.cacheFiles}, parallel restores ${o.parallel}, restore delay ${o.restoreDelayS} s`,
  );
  console.log(
    `  cost estimate (100% CPU): about ${Math.round(orbSeconds / 60)} orb-minutes × $${awakePerHour(shape, 1).toFixed(3)}/h ≈ $${usd.toFixed(2)}; orb-minutes are guesses from M0`,
  );
  console.log(
    "  plus snapshot storage: unpriced (beta). Snapshots cannot be deleted; they expire 30 d after the last restore.",
  );
  await confirm("Start the bench?", o.yes);

  const runId = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "t");
  const bench = new Bench(api, instance, o.restoreDelayS * 1000);
  const startedAt = isoNow();
  let aborted = false;
  const onSig = () => {
    aborted = true;
    console.error("interrupted: destroying bench orbs, then writing partial results");
  };
  process.once("SIGINT", onSig);

  const snaps = new Map<number, string>();
  let parallel: Awaited<ReturnType<Bench["parallelRestore"]>> | undefined;
  try {
    for (let r = 0; r < o.runs && !aborted; r++) {
      console.log(`run ${r + 1}/${o.runs}`);
      for (const gb of o.sizes) {
        if (aborted) break;
        const id = await bench.sizeRun(r, `bench-${runId}-r${r}-${gb}g`, gb);
        if (id) snaps.set(gb, id);
      }
      if (o.cacheFiles > 0 && !aborted) await bench.cacheRun(r, `bench-${runId}-r${r}-cache`, o.cacheFiles);
    }
    const pgb = Math.min(...o.sizes);
    const psnap = snaps.get(pgb);
    if (o.parallel > 0 && !aborted) {
      if (psnap) {
        console.log(`parallel: ${o.parallel} orbs restore one ${pgb} GB snapshot at once`);
        parallel = await bench.parallelRestore(runId, o.parallel, psnap, pgb);
      } else console.log(`parallel: skipped, no good ${pgb} GB snapshot`);
    }
  } catch (e) {
    if (!(e instanceof BenchError)) throw e;
    console.error(`Failed: ${e.message} — fix: ${e.fix}`);
    aborted = true;
  } finally {
    await bench.cleanup();
  }

  const samples = bench.samples;
  const result = {
    kind: "substrate",
    schema: SCHEMA,
    runId,
    aborted,
    stamps: {
      ...(await harnessStamps()),
      date: startedAt,
      finishedAt: isoNow(),
      wrangler: await wranglerVersion(),
      compatibilityDate: inst.compatibilityDate,
      baseImageDigest: inst.baseImageDigest,
      dockerfileSha: inst.dockerfileSha,
      installCliVersion: inst.cliVersion,
      apiVersion: health?.version,
      instance,
      instanceLabel: shape.label,
      memGiB: shape.memGiB,
      ampImageDigest: typeof inst.config.ampImageDigest === "string" ? inst.config.ampImageDigest : undefined,
      doColos: countBy(samples, (s) => s.doColo),
      containerColos: countBy(samples, (s) => s.containerColo),
      workerColos: countBy(samples, (s) => s.workerColo),
      coldStartNote:
        "image-start with firstOfRun=true is the first start of this bench run on a new orb name. It may or may not land on a host without the image cached; a cold host cannot be forced.",
    },
    config: {
      runs: o.runs,
      sizesGb: o.sizes,
      parallel: o.parallel,
      cacheFiles: o.cacheFiles,
      restoreDelayS: o.restoreDelayS,
    },
    cost: {
      orbSecondsEstimate: orbSeconds,
      usdEstimate: Number(usd.toFixed(4)),
      basis: "estimate at 100% CPU; orb-seconds are guesses from M0; snapshot storage not priced",
      ratesChecked: RATES.checked,
    },
    samples,
    parallel,
    failures: samples.filter((s) => !s.ok).length,
  };
  const file = writeResult("substrate", result);
  console.log(`wrote ${file} (${samples.length} samples, ${result.failures} failed)`);
  console.log("next: npm run bench:render");
  return aborted ? 1 : 0;
}

if (isMain(import.meta.url)) runMain(main);
