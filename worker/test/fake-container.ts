// Fake ContainerPort modelling the verified semantics (see container-port.ts header). Used by unit tests.
import type {
  Clock,
  ContainerPort,
  ExecOptions,
  ExecResult,
  KV,
  StartOptions,
} from "../src/core/container-port";

export type ExecHandler = (
  cmd: string[],
  opts: ExecOptions,
  fake: FakeContainer,
) => Partial<ExecResult> | string | undefined;

export class FakeContainer implements ContainerPort {
  running = false;
  knownSnapshots = new Map<string, { size: number; fromImage: string }>();
  /** files written by exec handlers, carried across snapshot/restore */
  disk: Record<string, string> = {};
  private diskBySnapshot = new Map<string, Record<string, string>>();
  bootId = crypto.randomUUID();
  startedWith?: StartOptions;
  startCount = 0;
  destroyCount = 0;
  snapshotCount = 0;
  inactivityTimeoutMs?: number;
  readyAfterMs = 0; // simulate boot time
  nextSnapshotError?: Error; // throws once
  snapshotDelayMs = 0;
  execLog: string[][] = [];
  handler: ExecHandler = () => ({ exitCode: 0, stdout: "" });
  private monitorReject?: (e: Error) => void;
  private monitorResolve?: () => void;
  private pendingFailure?: string;
  private readyAt = 0;
  private imageMap: Record<string, string>;
  constructor(
    public clock: Clock,
    images: Record<string, string> = { orb: "registry.cloudflare.com/acct/cf-orbs-orb@sha256:deadbeef" },
  ) {
    this.imageMap = images;
  }
  images() {
    return this.imageMap;
  }
  start(o: StartOptions) {
    if (this.running) throw new Error("Container is already running");
    if (!("image" in o.source) && !("snapshotId" in o.source))
      throw new TypeError("image or containerSnapshot required");
    this.startedWith = o;
    this.startCount++;
    this.bootId = crypto.randomUUID();
    this.running = true;
    this.readyAt = this.clock.now() + this.readyAfterMs;
    this.pendingFailure = undefined;
    if ("snapshotId" in o.source) {
      const snap = this.knownSnapshots.get(o.source.snapshotId);
      if (!snap) {
        this.pendingFailure = `Snapshot "${o.source.snapshotId}" was not found.`;
      } else this.disk = { ...(this.diskBySnapshot.get(o.source.snapshotId) ?? {}) };
    } else this.disk = {};
    // deliver async failure
    if (this.pendingFailure) {
      const msg = this.pendingFailure;
      queueMicrotask(() => {
        this.running = false;
        this.monitorReject?.(new Error(msg));
      });
    }
  }
  monitor(): Promise<void> {
    return new Promise((res, rej) => {
      this.monitorResolve = res;
      this.monitorReject = rej;
      if (this.pendingFailure) {
        this.running = false;
        rej(new Error(this.pendingFailure));
      }
    });
  }
  async exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    if (!this.running) throw new Error("The container has not been started");
    if (this.pendingFailure) throw new Error(this.pendingFailure);
    if (this.clock.now() < this.readyAt) throw new Error("connection refused: container not ready");
    this.execLog.push(cmd);
    const r = this.handler(cmd, opts, this);
    const base: ExecResult = {
      exitCode: 0,
      stdout: "",
      stderr: "",
      pid: 100 + this.execLog.length,
      durationMs: 1,
    };
    if (typeof r === "string") return { ...base, stdout: r };
    return { ...base, ...(r ?? {}) };
  }
  async execDetached(cmd: string[], opts: ExecOptions = {}) {
    const r = await this.exec(cmd, opts);
    return { pid: r.pid };
  }
  async snapshot(name: string) {
    if (!this.running) throw new Error("Container is not running");
    if (this.nextSnapshotError) {
      const e = this.nextSnapshotError;
      this.nextSnapshotError = undefined;
      throw e;
    }
    if (this.snapshotDelayMs) await this.clock.sleep(this.snapshotDelayMs);
    this.snapshotCount++;
    const id = crypto.randomUUID();
    const size = Object.values(this.disk).join("").length * 1000 + 31_000_000;
    this.knownSnapshots.set(id, {
      size,
      fromImage:
        this.startedWith && "image" in this.startedWith.source ? this.startedWith.source.image : "snapshot",
    });
    this.diskBySnapshot.set(id, { ...this.disk });
    void name;
    return { id, size };
  }
  async destroy() {
    this.running = false;
    this.destroyCount++;
    this.monitorReject?.(new Error("destroyed"));
  }
  async inspect() {
    return this.running
      ? {
          image:
            this.startedWith && "image" in this.startedWith.source
              ? this.startedWith.source.image
              : this.imageMap.orb!,
          labels: this.startedWith?.labels ?? {},
        }
      : null;
  }
  async setInactivityTimeout(ms: number) {
    this.inactivityTimeoutMs = ms;
  }
  /** test helper: simulate the platform stopping the instance without notice */
  platformStop() {
    this.running = false;
    this.monitorResolve?.();
  }
}

export class MemoryKV implements KV {
  map = new Map<string, unknown>();
  async get<T>(k: string) {
    return this.map.get(k) as T | undefined;
  }
  async put<T>(k: string, v: T) {
    this.map.set(k, structuredClone(v));
  }
  async delete(k: string) {
    return this.map.delete(k);
  }
  async list<T>(prefix: string) {
    const out = new Map<string, T>();
    for (const [k, v] of this.map) if (k.startsWith(prefix)) out.set(k, v as T);
    return out;
  }
}

export class FakeClock implements Clock {
  t = Date.parse("2026-10-30T20:00:00Z");
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.t += ms;
  }
  advance(ms: number) {
    this.t += ms;
  }
}
