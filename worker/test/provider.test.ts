import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import {
  CONTROL_HOST,
  CONTROL_URL,
  decideProvider,
  ensureProviderRunning,
  nextAlarm,
  PROVIDER_ALARM_MS,
  PROVIDER_GRACE_MS,
  PROVIDER_INACTIVITY_MS,
  PROVIDER_LOG,
  PROVIDER_LOG_TAIL_MS,
  PROVIDER_PROBE_MS,
  PROVIDER_WATCHDOG_GAP_MS,
  type ProviderContainerPort,
  ProviderController,
  type ProviderDecisionInput,
  ProviderHost,
  type ProviderState,
  providerInstanceOf,
  redactLine,
  STATE_KEY,
  short8,
  shouldStart,
  tokenSha16,
} from "../src/provider";
import { isMissingMethod, restartProvider } from "../src/provider-restart";
import { FakeClock, MemoryKV } from "./fake-container";

const TOKEN = "aop_live_0123456789abcdefSECRET";
const TOKEN2 = "aop_live_fedcba9876543210ROTATED";

class FakeProviderContainer implements ProviderContainerPort {
  running = false;
  starts: Parameters<ProviderContainerPort["start"]>[0][] = [];
  intercepts: [string, unknown][] = [];
  inactivityMs?: number;
  destroyCount = 0;
  execLog: string[][] = [];
  logLines = [`2026-10-30T20:00:00Z job token ${TOKEN}`, "Error: Amp rejected the orb provider token"];
  failStart?: Error;
  constructor(
    public imageMap: Record<string, string> = { provider: "registry.cloudflare.com/x/provider@sha256:1" },
  ) {}
  images() {
    return this.imageMap;
  }
  start(o: Parameters<ProviderContainerPort["start"]>[0]) {
    if (this.failStart) throw this.failStart;
    if (this.running) throw new Error("Container is already running");
    this.starts.push(o);
    this.running = true;
  }
  async interceptOutboundHttp(host: string, target: Fetcher) {
    this.intercepts.push([host, target]);
  }
  async exec(cmd: string[]) {
    if (!this.running) throw new Error("The container has not been started");
    this.execLog.push(cmd);
    return { exitCode: 0, stdout: `${this.logLines.join("\n")}\n`, stderr: "" };
  }
  async destroy() {
    this.running = false;
    this.destroyCount++;
  }
  async setInactivityTimeout(ms: number) {
    this.inactivityMs = ms;
  }
}

const FETCHER = { fetch: async () => new Response("ok") } as unknown as Fetcher;

function setup(
  opts: {
    token?: string;
    container?: FakeProviderContainer;
    kv?: MemoryKV;
    clock?: FakeClock;
    build?: string;
    log?: string[];
  } = {},
) {
  const container = opts.container ?? new FakeProviderContainer();
  const kv = opts.kv ?? new MemoryKV();
  const clock = opts.clock ?? new FakeClock();
  const alarm: { at?: number; deletes: number } = { deletes: 0 };
  const ctl = new ProviderController({
    container,
    kv,
    clock,
    token: "token" in opts ? opts.token : TOKEN,
    build: opts.build,
    log: (l) => opts.log?.push(l),
    controlApi: () => FETCHER,
    setAlarm: async (at) => {
      alarm.at = at;
    },
    deleteAlarm: async () => {
      alarm.at = undefined;
      alarm.deletes++;
    },
  });
  return { ctl, container, kv, clock, alarm };
}

const base: ProviderDecisionInput = { trigger: "ensure", running: false, hasToken: true, stopped: false };

describe("decideProvider / shouldStart / nextAlarm", () => {
  it("covers each case", () => {
    expect(decideProvider({ ...base, hasToken: false }).action).toBe("none");
    expect(decideProvider({ ...base, trigger: "alarm", stopped: true }).action).toBe("none");
    expect(decideProvider({ ...base, stopped: true }).action).toBe("start"); // explicit ensure restarts a stopped provider
    expect(decideProvider(base).action).toBe("start");
    expect(decideProvider({ ...base, running: true, tokenSha: "a", runningTokenSha: "b" }).action).toBe(
      "restart",
    );
    expect(decideProvider({ ...base, running: true, tokenSha: "a", runningTokenSha: "a" }).action).toBe(
      "keep",
    );
    expect(decideProvider({ ...base, running: true }).action).toBe("keep");
    expect(shouldStart(base)).toBe(true);
    expect(shouldStart({ ...base, running: true })).toBe(false);
    expect(nextAlarm(1000)).toBe(1000 + PROVIDER_ALARM_MS);
    expect(PROVIDER_ALARM_MS).toBe(300_000);
    expect(PROVIDER_INACTIVITY_MS).toBe(21_600_000);
  });
});

describe("decideProvider: provider image (build)", () => {
  const run = { ...base, running: true, tokenSha: "a", runningTokenSha: "a" };
  it("restarts a running provider from another build, or one started by code without builds", () => {
    expect(decideProvider({ ...run, build: "b2", runningBuild: "b1" })).toEqual({
      action: "restart",
      reason: "provider image changed (build b1 -> b2)",
    });
    expect(decideProvider({ ...run, build: "b2" })).toEqual({
      action: "restart",
      reason: "provider image changed (build unknown -> b2)",
    });
    expect(decideProvider({ ...run, build: "b2", runningBuild: "b2" }).action).toBe("keep");
    expect(decideProvider({ ...run, runningBuild: "b1" }).action).toBe("keep"); // no build in this deploy
  });
  it("force restarts a running provider; a stopped provider stays stopped for the alarm trigger", () => {
    expect(decideProvider({ ...run, build: "b", runningBuild: "b", force: true })).toEqual({
      action: "restart",
      reason: "restart requested",
    });
    expect(decideProvider({ ...base, trigger: "alarm", stopped: true, build: "b2" }).action).toBe("none");
  });
  it("short8 takes the digest's first 8 hex", () => {
    expect(short8("registry.cloudflare.com/a/p@sha256:0123456789abcdef")).toBe("01234567");
    expect(short8("registry.cloudflare.com/a/p:tag-12345678")).toBe("12345678");
    expect(short8(undefined)).toBe("none");
  });
});

describe("redactLine / tokenSha16", () => {
  it("redacts provider tokens, JWTs, long runs and exact secrets", () => {
    expect(redactLine(`x ${TOKEN} y`)).toBe("x aop_live_[redacted] y");
    expect(redactLine("t eyJhbGciOi.test.sig z")).toBe("t [redacted-jwt] z");
    expect(redactLine("orb_abcdefghijklmnopqrst")).toBe("orb_[redacted]");
    expect(redactLine(`h ${"a".repeat(40)}`)).toBe("h [redacted]");
    expect(redactLine("weird-secret-value here", ["weird-secret-value"])).toBe("[redacted] here");
    expect(redactLine("orb amp-T-0a1b2c3d-1111-2222-3333-444455556666 ok")).toBe(
      "orb amp-T-0a1b2c3d-1111-2222-3333-444455556666 ok",
    );
  });
  it("hashes to 16 hex", async () => {
    const a = await tokenSha16(TOKEN);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(await tokenSha16(TOKEN2));
  });
});

describe("ProviderController", () => {
  it("first ensure starts lite with token env, intercepts control.internal, sets timeout and alarm", async () => {
    const { ctl, container, kv, clock, alarm } = setup();
    const s = await ctl.ensure("ensure");
    expect(container.starts).toHaveLength(1);
    expect(container.starts[0]).toMatchObject({
      image: "registry.cloudflare.com/x/provider@sha256:1",
      instance: "lite",
      enableInternet: true,
      env: { AMP_ORB_PROVIDER_TOKEN: TOKEN, CF_ORBS_URL: CONTROL_URL },
    });
    expect(container.intercepts).toEqual([[CONTROL_HOST, FETCHER]]);
    expect(container.inactivityMs).toBe(21_600_000);
    expect(alarm.at).toBe(clock.now() + 300_000);
    expect(s).toMatchObject({ starts: 1, restarts: 0, startedAt: new Date(clock.now()).toISOString() });
    // token never persisted; only its sha prefix
    const stored = JSON.stringify([...kv.map.values()]);
    expect(stored).not.toContain(TOKEN);
    expect(stored).toContain(await tokenSha16(TOKEN));
  });

  it("second ensure keeps the container and re-registers the intercept", async () => {
    const { ctl, container } = setup();
    await ctl.ensure("ensure");
    await ctl.ensure("ensure");
    expect(container.starts).toHaveLength(1);
    expect(container.intercepts).toHaveLength(2);
  });

  it("concurrent ensures start once", async () => {
    const { ctl, container } = setup();
    await Promise.all([ctl.ensure("ensure"), ctl.ensure("ensure"), ctl.alarm()]);
    expect(container.starts).toHaveLength(1);
  });

  it("alarm restarts a provider that stopped, counts the restart and re-arms", async () => {
    const { ctl, container, clock, alarm, kv } = setup();
    await ctl.ensure("ensure");
    container.running = false; // platform stop
    clock.advance(PROVIDER_ALARM_MS);
    await ctl.alarm();
    expect(container.starts).toHaveLength(2);
    const s = (await kv.get<ProviderState>(STATE_KEY)) as ProviderState;
    expect(s.restarts).toBe(1);
    expect(s.lastStop?.reason).toBe("found not running");
    expect(alarm.at).toBe(clock.now() + PROVIDER_ALARM_MS);
  });

  it("alarm while running only refreshes", async () => {
    const { ctl, container, clock } = setup();
    await ctl.ensure("ensure");
    container.inactivityMs = undefined;
    clock.advance(PROVIDER_ALARM_MS);
    await ctl.alarm();
    expect(container.starts).toHaveLength(1);
    expect(container.inactivityMs).toBe(PROVIDER_INACTIVITY_MS);
  });

  it("restarts when the Worker token changed (rotation)", async () => {
    const container = new FakeProviderContainer();
    const kv = new MemoryKV();
    await setup({ container, kv }).ctl.ensure("ensure");
    const { ctl } = setup({ container, kv, token: TOKEN2 });
    const s = await ctl.ensure("ensure");
    expect(container.destroyCount).toBe(1);
    expect(container.starts).toHaveLength(2);
    expect(container.starts[1]?.env.AMP_ORB_PROVIDER_TOKEN).toBe(TOKEN2);
    expect(s.restarts).toBe(1);
    expect(s.lastStop?.reason).toBe("provider token changed");
  });

  it("no token: ensure fails with fix text, alarm disarmed, alarm() does not throw", async () => {
    const { ctl, container, alarm } = setup({ token: undefined });
    await expect(ctl.ensure("ensure")).rejects.toThrow(
      /^Failed: AMP_ORB_PROVIDER_TOKEN is not set .* — fix: /,
    );
    await expect(ctl.alarm()).resolves.toBeUndefined();
    expect(container.starts).toHaveLength(0);
    expect(alarm.at).toBeUndefined();
  });

  it("token removed (switch to external mode): alarm stops the running CF provider", async () => {
    const container = new FakeProviderContainer();
    const kv = new MemoryKV();
    await setup({ container, kv }).ctl.ensure("ensure");
    const { ctl, alarm } = setup({ container, kv, token: undefined });
    await ctl.alarm();
    expect(container.running).toBe(false);
    expect(container.destroyCount).toBe(1);
    expect(alarm.at).toBeUndefined();
    expect((await kv.get<ProviderState>(STATE_KEY))?.lastStop?.reason).toMatch(/external mode/);
  });

  it("missing provider image: fails, stores lastError, keeps the alarm for a retry", async () => {
    const { ctl, kv, alarm } = setup({ container: new FakeProviderContainer({ orb: "x" }) });
    await expect(ctl.ensure("ensure")).rejects.toThrow(
      /^Failed: image "provider" is not in this deploy — fix: /,
    );
    expect((await kv.get<ProviderState>(STATE_KEY))?.lastError).toMatch(/^Failed: /);
    expect(alarm.at).toBeDefined();
  });

  it("start error text is redacted and gets a fix", async () => {
    const container = new FakeProviderContainer();
    container.failStart = new Error(`boom ${TOKEN}\nstack`);
    const { ctl } = setup({ container });
    const err = await ctl.ensure("ensure").catch((e: Error) => e.message);
    expect(err).toBe("Failed: boom [redacted] — fix: run cf-orbs doctor");
  });

  it("start racing another start ('already running') is treated as running", async () => {
    const container = new FakeProviderContainer();
    container.failStart = new Error("Container is already running");
    container.running = false;
    const { ctl } = setup({ container });
    const s = await ctl.ensure("ensure");
    expect(s.lastError).toBeUndefined();
    expect(container.intercepts).toHaveLength(1);
  });

  it("stop destroys, disarms, and the alarm then does not restart; ensure does", async () => {
    const { ctl, container, alarm } = setup();
    await ctl.ensure("ensure");
    await ctl.stop();
    expect(container.running).toBe(false);
    expect(alarm.at).toBeUndefined();
    await ctl.alarm();
    expect(container.starts).toHaveLength(1);
    const s = await ctl.ensure("ensure");
    expect(container.starts).toHaveLength(2);
    expect(s.stopped).toBe(false);
  });

  it("status returns a redacted 20-line tail of the provider log", async () => {
    const { ctl, container } = setup();
    expect((await ctl.status()).logTail).toEqual([]);
    await ctl.ensure("ensure");
    const st = await ctl.status();
    expect(container.execLog.at(-1)).toEqual(["tail", "-n", "20", PROVIDER_LOG]);
    expect(st.running).toBe(true);
    expect(st.restarts).toBe(0);
    expect(st.logTail).toHaveLength(2);
    expect(JSON.stringify(st)).not.toContain(TOKEN);
    expect(st.logTail[0]).toBe("2026-10-30T20:00:00Z job token [redacted]");
    expect((await ctl.status(false)).logTail).toEqual([]);
  });

  it("starts the size from the config", async () => {
    const container = new FakeProviderContainer();
    const ctl = new ProviderController({
      container,
      kv: new MemoryKV(),
      clock: new FakeClock(),
      token: TOKEN,
      instance: providerInstanceOf('{"providerInstance":"standard-1"}'),
      controlApi: () => FETCHER,
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    });
    await ctl.ensure("ensure");
    expect(container.starts[0]?.instance).toBe("standard-1");
    expect(providerInstanceOf(undefined)).toBe("lite");
    expect(providerInstanceOf('{"providerInstance":"basic"}')).toBe("lite");
    expect(providerInstanceOf("not json")).toBe("lite");
  });

  describe("watchdog", () => {
    const hang = () => new Promise<never>(() => {});
    // check() awaits crypto.subtle before the probe, and that resolves on the event loop, not in a
    // microtask. So fake only setTimeout, and advance until the alarm ends.
    const fakeTimeouts = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    async function alarmWithTimers(ctl: ProviderController) {
      let done = false;
      const p = ctl.alarm().finally(() => {
        done = true;
      });
      while (!done) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(1000);
      }
      await p;
    }

    it("restarts a provider that does not answer 2 alarm checks in a row, then waits before the next restart", async () => {
      fakeTimeouts();
      try {
        const log: string[] = [];
        const { ctl, container, clock, kv } = setup({ log });
        await ctl.ensure("ensure");
        container.exec = hang;
        // Inside the grace period after a start: no probe.
        await alarmWithTimers(ctl);
        expect((kv.map.get(STATE_KEY) as ProviderState).slowChecks ?? 0).toBe(0);
        clock.advance(PROVIDER_GRACE_MS + 1);
        await alarmWithTimers(ctl);
        expect(container.starts).toHaveLength(1);
        expect((kv.map.get(STATE_KEY) as ProviderState).slowChecks).toBe(1);
        await alarmWithTimers(ctl);
        expect(container.starts).toHaveLength(2);
        expect(container.destroyCount).toBe(1);
        const s = kv.map.get(STATE_KEY) as ProviderState;
        expect(s.lastStop?.reason).toMatch(/did not answer 2 checks in a row/);
        expect(s.slowChecks).toBe(0);
        expect(log.join("\n")).toMatch(/restarting/);
        // Still slow after the restart: no second restart inside the gap.
        clock.advance(PROVIDER_GRACE_MS + 1);
        await alarmWithTimers(ctl);
        await alarmWithTimers(ctl);
        await alarmWithTimers(ctl);
        expect(container.starts).toHaveLength(2);
        clock.advance(PROVIDER_WATCHDOG_GAP_MS);
        await alarmWithTimers(ctl);
        expect(container.starts).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a provider that answers is kept, and one slow check is forgotten", async () => {
      fakeTimeouts();
      try {
        const { ctl, container, clock, kv } = setup();
        await ctl.ensure("ensure");
        clock.advance(PROVIDER_GRACE_MS + 1);
        const answer = container.exec.bind(container);
        container.exec = hang;
        await alarmWithTimers(ctl);
        container.exec = answer;
        await ctl.alarm();
        expect((kv.map.get(STATE_KEY) as ProviderState).slowChecks).toBe(0);
        expect(container.execLog.at(-1)).toEqual(["true"]);
        container.exec = hang;
        await alarmWithTimers(ctl);
        expect(container.starts).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("status answers when the log read hangs (an overloaded provider container)", async () => {
    vi.useFakeTimers();
    try {
      const { ctl, container } = setup();
      await ctl.ensure("ensure");
      container.exec = () => new Promise(() => {});
      const pending = ctl.status();
      await vi.advanceTimersByTimeAsync(PROVIDER_LOG_TAIL_MS + 1);
      const st = await pending;
      expect(st.running).toBe(true);
      expect(st.logTail).toEqual([
        `(log unavailable: the provider container did not answer in ${PROVIDER_LOG_TAIL_MS / 1000} s; it can be overloaded)`,
      ]);
      // The next call is not stuck behind the hung read.
      const again = ctl.status();
      await vi.advanceTimersByTimeAsync(PROVIDER_LOG_TAIL_MS + 1);
      expect((await again).running).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ProviderController: restart for a new provider image", () => {
  const IMG1 = "registry.cloudflare.com/x/provider@sha256:1111111111aa";
  const IMG2 = "registry.cloudflare.com/x/provider@sha256:2222222222bb";

  it("start stores the image and build; status shows them and the deploy's", async () => {
    const { ctl } = setup({ container: new FakeProviderContainer({ provider: IMG1 }), build: "b1" });
    const s = await ctl.ensure("ensure");
    expect(s).toMatchObject({ v: 2, image: IMG1, build: "b1" });
    expect(await ctl.status(false)).toMatchObject({
      image: IMG1,
      build: "b1",
      deployedImage: IMG1,
      deployedBuild: "b1",
    });
  });

  it("a check on a new build restarts the provider with the new image and logs one line", async () => {
    const container = new FakeProviderContainer({ provider: IMG1 });
    const kv = new MemoryKV();
    const clock = new FakeClock();
    const first = await setup({ container, kv, clock, build: "b1" }).ctl.ensure("ensure");
    // The DO is rebuilt by the new deploy: new images map, new build.
    container.imageMap = { provider: IMG2 };
    clock.advance(60_000);
    const log: string[] = [];
    const { ctl } = setup({ container, kv, clock, build: "b2", log });
    const r = await ctl.check("alarm");
    expect(r.action).toBe("restart");
    expect(container.destroyCount).toBe(1);
    expect(container.starts.map((x) => x.image)).toEqual([IMG1, IMG2]);
    expect(log).toEqual(["provider: image changed 11111111 -> 22222222; restarted"]);
    expect(r.state).toMatchObject({ image: IMG2, build: "b2", restarts: 1 });
    expect(r.state.startedAt).not.toBe(first.startedAt);
    expect(r.state.lastStop?.reason).toBe("provider image changed (build b1 -> b2)");
    // same build again: kept
    expect((await ctl.check("alarm")).action).toBe("keep");
    expect(container.starts).toHaveLength(2);
  });

  it("restarts a provider that code without builds started (state v 1, no build)", async () => {
    const container = new FakeProviderContainer({ provider: IMG1 });
    container.running = true;
    const kv = new MemoryKV();
    kv.map.set(STATE_KEY, { v: 1, starts: 1, restarts: 0, startedAt: "2026-10-30T00:00:00Z" });
    const { ctl } = setup({ container, kv, build: "b1" });
    const r = await ctl.check("alarm");
    expect(r).toMatchObject({ action: "restart", reason: "provider image changed (build unknown -> b1)" });
    expect(container.starts).toHaveLength(1);
  });

  it("force restarts a running provider on the same build", async () => {
    const { ctl, container } = setup({ build: "b1" });
    await ctl.ensure("ensure");
    const r = await ctl.check("ensure", true);
    expect(r).toMatchObject({ action: "restart", reason: "restart requested" });
    expect(container.destroyCount).toBe(1);
    expect(container.starts).toHaveLength(2);
  });

  it("a stop written by v 1 code (the restart route's old-code stop) does not hold back the alarm", async () => {
    const container = new FakeProviderContainer();
    const kv = new MemoryKV();
    kv.map.set(STATE_KEY, { v: 1, starts: 1, restarts: 0, stopped: true });
    const { ctl } = setup({ container, kv, build: "b1" });
    expect((await ctl.check("alarm")).action).toBe("start");
    // a v 2 stop does
    await ctl.stop();
    expect((await ctl.check("alarm")).action).toBe("none");
    expect(container.starts).toHaveLength(1);
  });

  it("stopForReset destroys the container, records why, and does not mark it stopped", async () => {
    const { ctl, container, kv } = setup({ build: "b1" });
    await ctl.ensure("ensure");
    expect(await ctl.stopForReset("b2")).toBe("provider image changed (build b1 -> b2)");
    expect(container.running).toBe(false);
    const s = (await kv.get<ProviderState>(STATE_KEY)) as ProviderState;
    expect(s.stopped).toBeFalsy();
    expect(s.lastStop?.reason).toBe("provider image changed (build b1 -> b2)");
  });
});

describe("restartProvider (Worker side)", () => {
  type Host = Record<string, (...a: any[]) => Promise<any>>;
  function ns(hosts: Host[]) {
    const got: number[] = [];
    let i = 0;
    return {
      got,
      PROVIDER: {
        getByName: (n: string) => {
          expect(n).toBe("provider");
          got.push(i);
          return hosts[Math.min(i++, hosts.length - 1)];
        },
      } as any,
    };
  }

  it("a DO on an older build: stops, resets, and the new DO starts the new image", async () => {
    const calls: string[] = [];
    const old: Host = {
      restart: async (o) => {
        calls.push(`old.restart ${JSON.stringify(o)}`);
        return { action: "reset", reason: "provider image changed (build b1 -> b2)", restarted: false };
      },
      reset: async () => {
        calls.push("old.reset");
        throw new Error("Durable Object reset because its code was updated");
      },
    };
    const fresh: Host = {
      restart: async () => {
        calls.push("new.restart");
        return { action: "start", reason: "container not running", restarted: false, running: true };
      },
    };
    const env = { ...ns([old, fresh]), CF_ORBS_PROVIDER_BUILD: "b2" };
    const r = await restartProvider(env, { ifImageChanged: true, onOldCode: "stop" });
    expect(calls).toEqual(['old.restart {"ifImageChanged":true,"build":"b2"}', "old.reset", "new.restart"]);
    expect(r).toMatchObject({
      action: "start",
      restarted: true,
      running: true,
      reason: "provider image changed (build b1 -> b2)",
    });
  });

  it("a DO that answers reset twice fails with fix text", async () => {
    const h: Host = {
      restart: async () => ({ action: "reset", reason: "x", restarted: false }),
      reset: async () => {},
    };
    await expect(
      restartProvider(
        { ...ns([h]), CF_ORBS_PROVIDER_BUILD: "b2" },
        { ifImageChanged: true, onOldCode: "stop" },
      ),
    ).rejects.toThrow(/^Failed: the provider Durable Object still runs the old deploy after a reset — fix: /);
  });

  it("a DO on code without restart(): the route stops it, the cron keeps the old ensure", async () => {
    const missing = async () => {
      throw new TypeError('The RPC receiver does not implement the method "restart".');
    };
    const stop = vi.fn(async () => {});
    const ensureRunning = vi.fn(async () => ({ running: true, restarts: 0, stopped: false, logTail: [] }));
    const h: Host = { restart: missing, stop, ensureRunning };
    const a = await restartProvider({ ...ns([h]) }, { ifImageChanged: true, onOldCode: "stop" });
    expect(a).toMatchObject({ action: "stopped-old-code", restarted: false });
    expect(stop).toHaveBeenCalledTimes(1);
    const b = await restartProvider({ ...ns([h]) }, { ifImageChanged: true, onOldCode: "ensure" });
    expect(b).toMatchObject({ action: "keep", running: true });
    expect(ensureRunning).toHaveBeenCalledWith("alarm");
    expect(isMissingMethod(new TypeError("host.restart is not a function"))).toBe(true);
    expect(isMissingMethod(new Error("Failed: boom"))).toBe(false);
  });

  it("other errors pass through", async () => {
    const h: Host = {
      restart: async () => {
        throw new Error("Failed: boom — fix: x");
      },
    };
    await expect(
      restartProvider({ ...ns([h]) }, { ifImageChanged: true, onOldCode: "stop" }),
    ).rejects.toThrow("Failed: boom");
  });
});

describe("ProviderHost DO wiring", () => {
  function fakeCtx(running: boolean, exportsObj: Record<string, unknown>) {
    const c = new FakeProviderContainer();
    c.running = running;
    const timeouts: number[] = [];
    const container = {
      get running() {
        return c.running;
      },
      images: c.imageMap,
      start: (o: any) => c.start(o),
      interceptOutboundHttp: (h: string, t: Fetcher) => c.interceptOutboundHttp(h, t),
      setInactivityTimeout: async (ms: number) => {
        timeouts.push(ms);
      },
      destroy: () => c.destroy(),
      exec: async () => ({
        output: async () => ({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      }),
    };
    const store = new Map<string, unknown>();
    const storage = {
      get: async (k: string) => store.get(k),
      put: async (k: string, v: unknown) => void store.set(k, v),
      delete: async (k: string) => store.delete(k),
      list: async () => new Map(),
      setAlarm: vi.fn(async () => {}),
      deleteAlarm: vi.fn(async () => {}),
    };
    const ctx = {
      container,
      storage,
      exports: exportsObj,
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => fn(),
      abort: vi.fn((reason: string) => {
        throw new Error(`aborted: ${reason}`);
      }),
    };
    return { ctx, c, timeouts, storage };
  }

  it("constructor re-sets the inactivity timeout when the container is running", () => {
    const { ctx, timeouts } = fakeCtx(true, {});
    new ProviderHost(ctx as any, { AMP_ORB_PROVIDER_TOKEN: TOKEN } as any);
    expect(timeouts).toEqual([PROVIDER_INACTIVITY_MS]);
  });

  it("ensureRunning uses ctx.exports.ControlApi for the intercept", async () => {
    const api = { fetch: async () => new Response("ok") };
    const { ctx, c, storage } = fakeCtx(false, { ControlApi: api });
    const host = new ProviderHost(ctx as any, { AMP_ORB_PROVIDER_TOKEN: TOKEN } as any);
    const st = await host.ensureRunning();
    expect(st.running).toBe(true);
    expect(c.intercepts).toEqual([[CONTROL_HOST, api]]);
    expect(storage.setAlarm).toHaveBeenCalled();
  });

  it("missing ControlApi export fails with fix text", async () => {
    const { ctx } = fakeCtx(false, {});
    const host = new ProviderHost(ctx as any, { AMP_ORB_PROVIDER_TOKEN: TOKEN } as any);
    await expect(host.ensureRunning()).rejects.toThrow(
      /^Failed: ControlApi entrypoint is not exported — fix: /,
    );
  });

  it("restart: same build keeps or force-restarts; an older build stops and answers reset; reset aborts", async () => {
    const api = { fetch: async () => new Response("ok") };
    const { ctx, c } = fakeCtx(false, { ControlApi: api });
    const env = { AMP_ORB_PROVIDER_TOKEN: TOKEN, CF_ORBS_PROVIDER_BUILD: "b1" } as any;
    const host = new ProviderHost(ctx as any, env);
    expect(await host.restart({ ifImageChanged: true, build: "b1" })).toMatchObject({
      action: "start",
      restarted: false,
      running: true,
      build: "b1",
      deployedBuild: "b1",
    });
    expect(await host.restart({ ifImageChanged: true, build: "b1" })).toMatchObject({
      action: "keep",
      restarted: false,
    });
    expect(await host.restart({ build: "b1" })).toMatchObject({ action: "restart", restarted: true });
    expect(c.starts).toHaveLength(2);
    const r = await host.restart({ ifImageChanged: true, build: "b2" });
    expect(r).toMatchObject({
      action: "reset",
      reason: "provider image changed (build b1 -> b2)",
      running: false,
      stopped: false,
    });
    await expect(host.reset()).rejects.toThrow(/^aborted: /);
    expect(ctx.abort).toHaveBeenCalledTimes(1);
  });

  it("ensureProviderRunning is a no-op without a token (external mode); else asks for an image check", async () => {
    const restart = vi.fn(async () => ({ action: "keep", reason: "running", restarted: false }));
    const getByName = vi.fn(() => ({ restart }));
    await ensureProviderRunning({ PROVIDER: { getByName } as any, AMP_ORB_PROVIDER_TOKEN: undefined });
    expect(getByName).not.toHaveBeenCalled();
    await ensureProviderRunning({
      PROVIDER: { getByName } as any,
      AMP_ORB_PROVIDER_TOKEN: TOKEN,
      CF_ORBS_PROVIDER_BUILD: "b1",
    });
    expect(getByName).toHaveBeenCalledWith("provider");
    expect(restart).toHaveBeenCalledWith({ ifImageChanged: true, build: "b1" });
    // a DO on code without restart() gets the old ensure("alarm")
    const ensureRunning = vi.fn(async () => ({}));
    await ensureProviderRunning({
      PROVIDER: { getByName: () => ({ ensureRunning }) } as any,
      AMP_ORB_PROVIDER_TOKEN: TOKEN,
    });
    expect(ensureRunning).toHaveBeenCalledWith("alarm");
  });
});

describe("provider/entry.sh", () => {
  const entry = resolve(__dirname, "../../provider/entry.sh");
  function fixture(ampBody: string) {
    const dir = mkdtempSync(join(tmpdir(), "cf-orbs-entry-"));
    const amp = join(dir, "amp");
    writeFileSync(amp, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.0.test; exit 0; fi\n${ampBody}\n`);
    chmodSync(amp, 0o755);
    const dispatch = join(dir, "dispatch.sh");
    writeFileSync(dispatch, "#!/bin/sh\nexit 0\n");
    chmodSync(dispatch, 0o755);
    return { dir, amp, dispatch, log: join(dir, "provider.log") };
  }
  function run(env: Record<string, string | undefined>, input?: string) {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    return spawnSync("bash", [entry], { env: clean, input, encoding: "utf8", timeout: 20_000 });
  }

  it("redacts aop_live_ and the exact token on stdout and in the log; prints the exit code", () => {
    const f = fixture(
      `echo "connected aop_live_ZZZ999other"\necho "env $AMP_ORB_PROVIDER_TOKEN" >&2\nexit 3`,
    );
    const r = run({
      AMP_ORB_PROVIDER_TOKEN: TOKEN,
      CF_ORBS_AMP_BIN: f.amp,
      CF_ORBS_DISPATCH: f.dispatch,
      CF_ORBS_PROVIDER_LOG: f.log,
      CF_ORBS_ONCE: "1",
    });
    const log = readFileSync(f.log, "utf8");
    expect(r.status).toBe(3);
    for (const out of [r.stdout, log]) {
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain("ZZZ999other");
      expect(out).toContain("connected aop_live_[redacted]");
      expect(out).toContain("env [redacted]");
      expect(out).toMatch(/exited with code 3/);
    }
  });

  it("fails with fix text when the token is missing", () => {
    const f = fixture("exit 0");
    const r = run({ CF_ORBS_AMP_BIN: f.amp, CF_ORBS_DISPATCH: f.dispatch, CF_ORBS_PROVIDER_LOG: f.log });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Failed: AMP_ORB_PROVIDER_TOKEN is not set — fix: /);
  });

  it("caps the log by keeping its tail", () => {
    const f = fixture("exit 0");
    writeFileSync(f.log, "x".repeat(5000));
    run({
      AMP_ORB_PROVIDER_TOKEN: TOKEN,
      CF_ORBS_AMP_BIN: f.amp,
      CF_ORBS_DISPATCH: f.dispatch,
      CF_ORBS_PROVIDER_LOG: f.log,
      CF_ORBS_LOG_MAX_BYTES: "1000",
      CF_ORBS_ONCE: "1",
    });
    expect(statSync(f.log).size).toBeLessThan(1000);
    expect(readFileSync(f.log, "utf8")).toMatch(/log passed 1000 bytes/);
  });

  it("redact-only mode matches the Worker redaction", () => {
    const lines = [
      `a ${TOKEN} b`,
      "t eyJhbGciOi.test.sig z",
      `h ${"f".repeat(48)}`,
      "plain amp-T-1234-5678 line",
    ];
    const r = run({ CF_ORBS_REDACT_ONLY: "1" }, `${lines.join("\n")}\n`);
    expect(r.stdout.trimEnd().split("\n")).toEqual(lines.map((l) => redactLine(l)));
  });
});
