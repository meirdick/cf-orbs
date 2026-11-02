// FakeRegistry: RegistryClient over Maps, for unit tests of any module that talks to the Registry DO.
// Also exports makeOrbCtx(): an OrbContext over FakeContainer/MemoryKV/FakeClock whose exec handler
// simulates the orb scripts (matched by script string identity) so bootstrap alive/connected can be driven.
import type { Clock, ExecOptions } from "../src/core/container-port";
import { projectKeyOf } from "../src/core/registry-core";
import {
  DEFAULT_CONFIG,
  JOB_DEADLINE_MS,
  type ProjectSnapshotMapping,
  type ProviderConfig,
  type RegistryClient,
  type SnapshotHandle,
  STALE_FORGET_INTERVAL_MS,
  type StaleMarkResult,
} from "../src/core/types";
import type { OrbContext } from "../src/orb/context";
import {
  BOOTSTRAP_SH,
  LOGTAIL_SH,
  QUIESCE_SH,
  RESUME_SH,
  STATUS_SH,
  WAIT_CONNECTED_SH,
} from "../src/orb/scripts";
import { FakeClock, FakeContainer, MemoryKV } from "./fake-container";

export class FakeRegistry implements RegistryClient {
  projects = new Map<string, ProjectSnapshotMapping>();
  snapshots: { handle: SnapshotHandle; orbId: string }[] = [];
  /** orbId → last heartbeat (epoch ms) */
  slots = new Map<string, number>();
  /** project → last stale forget (ISO); same rate limit as RegistryCore */
  forgets = new Map<string, string>();
  calls: string[] = [];
  constructor(
    public max = 20,
    private clock: Clock = { now: () => Date.now(), sleep: async () => {} },
  ) {}
  async getProjectSnapshot(id: string) {
    this.calls.push(`get ${id}`);
    const m = this.projects.get(id);
    return m && !m.stale?.forgotten ? structuredClone(m) : undefined;
  }
  async markProjectSnapshotStale(id: string, reason: string, at: string): Promise<StaleMarkResult> {
    this.calls.push(`stale ${id}`);
    const m = this.projects.get(id);
    if (!m) return { forgotten: false, note: "no mapping" };
    if (m.stale?.forgotten) return { forgotten: false, note: `already forgotten at ${m.stale.at}` };
    const key = projectKeyOf(id);
    const last = this.forgets.get(key);
    if (last && Date.parse(at) - Date.parse(last) < STALE_FORGET_INTERVAL_MS) {
      m.stale = { reason, at: m.stale?.at ?? at, forgotten: false };
      return { forgotten: false, note: `kept: this project had a forget at ${last}` };
    }
    m.stale = { reason, at: m.stale?.at ?? at, forgotten: true };
    this.forgets.set(key, at);
    return { forgotten: true, note: "forgot the mapping" };
  }
  async projectSnapshotStale(id: string) {
    return this.projects.get(id)?.stale;
  }
  async putProjectSnapshot(m: ProjectSnapshotMapping) {
    this.calls.push(`put ${m.snapshotId}`);
    this.projects.set(m.snapshotId, structuredClone(m));
  }
  async touchProjectSnapshot(id: string, usedAt: string) {
    this.calls.push(`touch ${id}`);
    const m = this.projects.get(id);
    if (m) m.lastUsedAt = usedAt;
  }
  async dropProjectSnapshot(id: string) {
    this.calls.push(`drop ${id}`);
    this.projects.delete(id);
  }
  async recordSnapshot(handle: SnapshotHandle, orbId: string) {
    this.calls.push(`record ${handle.id}`);
    this.snapshots.push({ handle: structuredClone(handle), orbId });
  }
  async orbDeleted(orbId: string, at: string) {
    this.calls.push(`deleted ${orbId} ${at}`);
  }
  async acquireRunSlot(orbId: string) {
    this.calls.push(`acquire ${orbId}`);
    if (this.slots.has(orbId) || this.slots.size < this.max) {
      this.slots.set(orbId, this.clock.now());
      return { ok: true, running: this.slots.size, max: this.max };
    }
    return { ok: false, running: this.slots.size, max: this.max };
  }
  async releaseRunSlot(orbId: string) {
    this.calls.push(`release ${orbId}`);
    this.slots.delete(orbId);
  }
  async heartbeat(orbId: string) {
    this.calls.push(`heartbeat ${orbId}`);
    this.slots.set(orbId, this.clock.now());
  }
}

/** Simulated amp bootstrap inside the fake container. */
export interface BootSim {
  /** bootId of the container where the bootstrap is alive; undefined = not running */
  aliveBoot?: string;
  /** pid of the live bootstrap */
  pid: number;
  /** the bootstrap connects to Amp (WAIT_CONNECTED_SH exit 0) */
  connects: boolean;
  /** BOOTSTRAP_SH sees the connect before it returns (its "launch to connected" timing line) */
  bootSeesConnect: boolean;
  /** Amp rejects the token: BOOTSTRAP_SH exit 1 */
  rejectToken: boolean;
  /** bootstrap starts, then exits before it connects */
  diesBeforeConnect: boolean;
  /** number of real (non-retry) bootstrap launches */
  launches: number;
  /** lines LOGTAIL_SH returns (may hold secrets, to test redaction) */
  logLines: string[];
  /** env of every BOOTSTRAP_SH exec */
  bootEnvs: Record<string, string>[];
  /** echo ORB_TOKEN in BOOTSTRAP_SH output (simulates a leak the Worker must redact) */
  leakToken: boolean;
  /** STATUS_SH "act" value (log bytes); bump it to simulate agent work */
  activity: number;
  /** STATUS_SH "use" value (messages the executor saw); bump it to simulate Amp using a warm orb */
  use: number;
  /** WAIT_CONNECTED_SH with AMP_CHECK=1 prints this line after "connected" (e.g. "amp: current 0.0.1") */
  ampCheckLine?: string;
  /** QUIESCE_SH with AMP_VERSION=1 prints "amp: version <this>" */
  ampVersion?: string;
}

export const STATE_FILE = "/home/user/.cf-orbs/bootstrap";

export function scriptHandler(sim: BootSim) {
  return (cmd: string[], opts: ExecOptions, fake: FakeContainer) => {
    const script = cmd[0] === "bash" && cmd[1] === "-c" ? cmd[2] : undefined;
    const env = opts.env ?? {};
    const alive = () => sim.aliveBoot === fake.bootId;
    if (script === BOOTSTRAP_SH) {
      sim.bootEnvs.push({ ...env });
      const prev = fake.disk[STATE_FILE]?.split(" ");
      if (alive() && prev?.[2] === env.ORB_TOKEN_SHA) return `bootstrap already running (pid ${sim.pid})`;
      sim.launches++;
      sim.pid = 1000 + sim.launches;
      const leak = sim.leakToken ? ` token=${env.ORB_TOKEN}` : "";
      if (sim.rejectToken) {
        sim.aliveBoot = undefined;
        return {
          exitCode: 1,
          stdout: `Failed: amp orb bootstrap exited within 1s${leak}\n== bootstrap.log\nError: ORB_TOKEN was rejected by Amp`,
        };
      }
      sim.aliveBoot = fake.bootId;
      fake.disk[STATE_FILE] = `${sim.pid} ${fake.bootId} ${env.ORB_TOKEN_SHA} 0`;
      const seen = sim.bootSeesConnect && sim.connects && !sim.diesBeforeConnect;
      const timing = `timing: script to launch 30 ms (prelude 3, state+host 2, cpus 5, memory 1, start 19); launch to ${seen ? "connected 412" : "still waiting 10000"} ms`;
      return `${timing}\nbootstrap running (pid ${sim.pid})${leak}`;
    }
    if (script === WAIT_CONNECTED_SH) {
      if (sim.diesBeforeConnect) sim.aliveBoot = undefined;
      if (!alive())
        return {
          exitCode: 1,
          stdout: `not connected; last log lines:\nreason: bootstrap pid ${sim.pid} exited`,
        };
      if (sim.connects)
        return `connected after 3s${env.AMP_CHECK === "1" && sim.ampCheckLine ? `\n${sim.ampCheckLine}` : ""}`;
      const w = Number(env.WAIT_SECONDS ?? 60);
      (fake.clock as FakeClock).advance(w * 1000);
      return { exitCode: 1, stdout: `not connected; last log lines:\nreason: timeout after ${w}s` };
    }
    if (script === RESUME_SH) {
      const prev = fake.disk[STATE_FILE]?.split(" ");
      if (!prev || !alive()) return { exitCode: 1, stdout: `reason: bootstrap pid ${sim.pid} exited` };
      if (!sim.connects) return { exitCode: 1, stdout: `reason: bootstrap pid ${sim.pid} is not connected` };
      fake.disk[STATE_FILE] = `${prev[0]} ${prev[1]} ${env.ORB_TOKEN_SHA} ${prev[3]}`;
      return `warm bootstrap pid ${sim.pid} still connected`;
    }
    if (script === STATUS_SH)
      return `${alive() ? `alive ${sim.pid}` : "dead"}\nsha x boot current\nact ${sim.activity}\nuse ${sim.use}`;
    if (script === QUIESCE_SH) {
      const was = alive();
      sim.aliveBoot = undefined;
      const v = env.AMP_VERSION === "1" ? `amp: version ${sim.ampVersion ?? "unknown"}\n` : "";
      return `${v}${was ? `stopping bootstrap pid ${sim.pid}\n` : ""}quiesced; remaining amp processes: 0`;
    }
    if (script === LOGTAIL_SH) return sim.logLines.join("\n");
    return { exitCode: 0, stdout: "" };
  };
}

/** MemoryKV that returns copies, like DO storage. A mutation without put() is lost, as in production. */
export class CopyingKV extends MemoryKV {
  override async get<T>(k: string) {
    const v = this.map.get(k);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }
}

export interface OrbHarness {
  ctx: OrbContext;
  fake: FakeContainer;
  kv: CopyingKV;
  clock: FakeClock;
  registry: FakeRegistry;
  sim: BootSim;
  /** every say() line, in order (stands in for op progress and the DO log) */
  lines: string[];
  /** reset ctx.deadline to now + 4 min 30 s, as session.ts does per op */
  newOp(): OrbContext;
}

export function makeOrbCtx(
  opts: {
    orbId?: string;
    config?: Partial<ProviderConfig>;
    maxRunning?: number;
    images?: Record<string, string>;
  } = {},
): OrbHarness {
  const clock = new FakeClock();
  const fake = new FakeContainer(clock, opts.images);
  const kv = new CopyingKV();
  const registry = new FakeRegistry(opts.maxRunning ?? 20, clock);
  const sim: BootSim = {
    pid: 0,
    connects: true,
    bootSeesConnect: false,
    rejectToken: false,
    diesBeforeConnect: false,
    launches: 0,
    logLines: ["amp orb bootstrap starting", "connecting to thread"],
    bootEnvs: [],
    leakToken: false,
    activity: 0,
    use: 0,
  };
  fake.handler = scriptHandler(sim);
  const lines: string[] = [];
  const ctx: OrbContext = {
    orbId: opts.orbId ?? "amp-T-test",
    container: fake,
    kv,
    clock,
    // warmMinutes 0: most tests cover the cold pause. Warm tests set it.
    config: { ...DEFAULT_CONFIG, warmMinutes: 0, ...opts.config },
    registry,
    say: (l) => lines.push(l),
    deadline: clock.now() + JOB_DEADLINE_MS,
  };
  return {
    ctx,
    fake,
    kv,
    clock,
    registry,
    sim,
    lines,
    newOp() {
      ctx.deadline = clock.now() + JOB_DEADLINE_MS;
      return ctx;
    },
  };
}
