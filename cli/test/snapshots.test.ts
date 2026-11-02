import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";
import { ampCacheCheck } from "../src/commands/doctor";
import { AMP_CACHE_STEPS, renderProjectSnapshots, snapshotsCommand } from "../src/commands/snapshots";
import { upgradeCommand } from "../src/commands/upgrade";
import { AMP_DEFAULT_IMAGE_REPO, DEFAULT_CONFIG } from "../src/config";
import { type Ctx, makeCtx } from "../src/context";
import { projectPaths, writeControlToken } from "../src/project";
import type { Ui } from "../src/ui";

const NOW = Date.parse("2026-10-30T20:00:00Z");
const H = 3600_000;
const TOKEN = "a".repeat(64);
const iso = (ms: number) => new Date(ms).toISOString();

const ROW_A = {
  snapshotId: "snap-f3851194-5479269c",
  handle: { id: "cf-snap-1", size: 194_000_000, imageKey: "orb", createdAt: iso(NOW - 3 * H) },
  sourceOrbId: "amp-T-1",
  createdAt: iso(NOW - 3 * H),
  lastUsedAt: iso(NOW - H),
  expiresAt: iso(NOW + 71 * H),
  expired: false,
};
const ROW_B = {
  ...ROW_A,
  snapshotId: "snap-old",
  handle: { ...ROW_A.handle, id: "cf-snap-0" },
  expired: true,
};
const SUMMARY = {
  projectSnapshots: 1,
  retainedSnapshots: 3,
  retainedSnapshotBytes: 1_500_000_000,
  running: [],
  max: 20,
  nextExpiry: "2026-11-20T00:00:00.000Z",
};

function captureUi(nonInteractive = true): { ui: Ui; lines: string[]; results: unknown[] } {
  const lines: string[] = [];
  const results: unknown[] = [];
  const push = (l: string) => lines.push(l);
  return {
    lines,
    results,
    ui: {
      json: false,
      nonInteractive,
      step: push,
      warn: push,
      out: push,
      result: (v) => results.push(v),
      raw: () => {},
    },
  };
}

describe("renderProjectSnapshots", () => {
  it("prints one row per mapping and the index summary", () => {
    const out = renderProjectSnapshots({ projectSnapshots: [ROW_A, ROW_B], summary: SUMMARY }, NOW);
    const lines = out.split("\n");
    expect(lines[0]).toMatch(
      /^AMP SNAPSHOT\s+CF SNAPSHOT\s+SIZE\s+SOURCE ORB\s+CREATED\s+LAST USED\s+EXPIRES$/,
    );
    expect(lines[2]).toMatch(
      /^snap-f3851194-5479269c\s+cf-snap-1\s+194 MB\s+amp-T-1\s+3h ago\s+60m ago\s+in 3d$/,
    );
    expect(lines[3]).toMatch(/^snap-old\s+cf-snap-0\s+.*expired$/);
    expect(out).toContain("snapshot index: 3 retained, 1.50 GB, next expiry 2026-11-20T00:00:00.000Z");
    expect(out).toContain("Cloudflare keeps snapshot data until its 30-day TTL");
  });
  it("says so when there are no mappings and tolerates odd bodies", () => {
    expect(renderProjectSnapshots({ projectSnapshots: [], summary: {} }, NOW)).toMatch(
      /^No project snapshot mappings\./,
    );
    expect(renderProjectSnapshots("junk", NOW)).toMatch(/^No project snapshot mappings\./);
  });
});

describe("cf-orbs snapshots", () => {
  let dir: string;
  let rows: Record<string, unknown>[];
  let calls: string[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cf-orbs-snap-"));
    rows = [structuredClone(ROW_A), structuredClone(ROW_B)];
    calls = [];
  });

  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${TOKEN}`)
      return new Response("", { status: 401 });
    if (u.pathname === "/v1/project-snapshots" && method === "GET")
      return Response.json({ projectSnapshots: rows, summary: SUMMARY });
    const m = /^\/v1\/project-snapshots\/([^/]+)$/.exec(u.pathname);
    if (m && method === "DELETE") {
      const id = decodeURIComponent(m[1] as string);
      const before = rows.length;
      rows = rows.filter((r) => r.snapshotId !== id);
      return Response.json({ snapshotId: id, forgotten: rows.length < before });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  async function ctxFor(argv: string[], nonInteractive = true) {
    await writeControlToken(projectPaths(dir), TOKEN);
    const cap = captureUi(nonInteractive);
    const args = parseArgs(argv, {
      "all-project": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      url: { type: "string" },
    });
    const ctx: Ctx = makeCtx(cap.ui, args, dir, {
      fetch: fakeFetch,
      env: {},
      now: () => NOW,
    });
    return { ctx, cap };
  }

  it("list (also the default) prints the table from GET /v1/project-snapshots", async () => {
    for (const argv of [["list"], []]) {
      calls = [];
      const { ctx, cap } = await ctxFor([...argv, "--url", "https://cf-orbs.x.workers.dev"]);
      expect(await snapshotsCommand(ctx)).toBe(0);
      expect(calls).toEqual(["GET /v1/project-snapshots"]);
      expect(cap.lines.join("\n")).toContain("snap-f3851194-5479269c");
      expect(cap.results[0]).toEqual({ projectSnapshots: rows, summary: SUMMARY });
    }
  });

  it("forget <id> sends DELETE with the id encoded; a missing id is not an error", async () => {
    const { ctx, cap } = await ctxFor(["forget", "snap-old", "--url", "https://cf-orbs.x.workers.dev"]);
    expect(await snapshotsCommand(ctx)).toBe(0);
    expect(calls).toEqual(["DELETE /v1/project-snapshots/snap-old"]);
    expect(cap.lines.at(-1)).toMatch(/^Forgot snap-old\. The next spawn with this id boots the image/);
    const again = await ctxFor(["forget", "a b", "--url", "https://cf-orbs.x.workers.dev"]);
    calls = [];
    expect(await snapshotsCommand(again.ctx)).toBe(0);
    expect(calls).toEqual(["DELETE /v1/project-snapshots/a%20b"]);
    expect(again.cap.lines.at(-1)).toBe("No mapping for a b. Nothing to forget.");
  });

  it("forget --all-project needs --yes when it cannot prompt, and deletes nothing", async () => {
    const { ctx } = await ctxFor(["forget", "--all-project", "--url", "https://cf-orbs.x.workers.dev"]);
    await expect(snapshotsCommand(ctx)).rejects.toThrow(
      /^Failed: forget --all-project would drop 2 mapping\(s\) and needs confirmation — fix: rerun with --yes$/,
    );
    expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("forget --all-project asks on a TTY; no keeps everything, yes forgets each mapping", async () => {
    const no = await ctxFor(["forget", "--all-project", "--url", "https://cf-orbs.x.workers.dev"], false);
    const asked: string[] = [];
    const decline = async (q: string) => {
      asked.push(q);
      return false;
    };
    expect(await snapshotsCommand(no.ctx, decline)).toBe(0);
    expect(asked[0]).toMatch(/^Forget 2 project snapshot mapping\(s\)\?.*\[y\/N\] $/);
    expect(no.cap.lines.at(-1)).toBe("Cancelled. Nothing forgotten.");
    expect(rows).toHaveLength(2);
    const yes = await ctxFor(["forget", "--all-project", "--url", "https://cf-orbs.x.workers.dev"], false);
    calls = [];
    expect(await snapshotsCommand(yes.ctx, async () => true)).toBe(0);
    expect(calls).toEqual([
      "GET /v1/project-snapshots",
      "DELETE /v1/project-snapshots/snap-f3851194-5479269c",
      "DELETE /v1/project-snapshots/snap-old",
    ]);
    expect(rows).toEqual([]);
    expect(yes.cap.results.at(-1)).toEqual({ ok: true, forgotten: ["snap-f3851194-5479269c", "snap-old"] });
  });

  it("forget --all-project --yes runs without a prompt; with nothing left it says so", async () => {
    const { ctx } = await ctxFor([
      "forget",
      "--all-project",
      "--yes",
      "--url",
      "https://cf-orbs.x.workers.dev",
    ]);
    expect(
      await snapshotsCommand(ctx, async () => {
        throw new Error("must not prompt");
      }),
    ).toBe(0);
    expect(rows).toEqual([]);
    const again = await ctxFor(["forget", "--all-project", "-y", "--url", "https://cf-orbs.x.workers.dev"]);
    expect(await snapshotsCommand(again.ctx)).toBe(0);
    expect(again.cap.lines.at(-1)).toBe("No project snapshot mappings. Nothing to forget.");
  });

  it("bad usage fails with one-line fixes before any request", async () => {
    for (const [argv, re] of [
      [["forget"], /needs an Amp snapshot id or --all-project — fix: run cf-orbs snapshots list/],
      [["forget", "a", "--all-project"], /not both — fix:/],
      [["forget", "a", "b"], /not both — fix:/],
      [["list", "x"], /takes no argument/],
      [["drop"], /^Failed: unknown snapshots command drop — fix: use cf-orbs snapshots list/],
    ] as [string[], RegExp][]) {
      const { ctx } = await ctxFor([...argv, "--url", "https://cf-orbs.x.workers.dev"]);
      await expect(snapshotsCommand(ctx)).rejects.toThrow(re);
    }
    expect(calls).toEqual([]);
  });

  it("an old Worker without the route gets the deploy fix", async () => {
    const { ctx } = await ctxFor(["list", "--url", "https://cf-orbs.x.workers.dev"]);
    ctx.fetch = (async () => new Response("not found", { status: 404 })) as typeof fetch;
    await expect(snapshotsCommand(ctx)).rejects.toThrow(
      /route not found \(404\).* — fix: run cf-orbs deploy$/,
    );
  });
});

describe("Amp snapshot cache hints", () => {
  it("doctor prints it as INFO with the Amp UI path, the amp CLI command and the cf-orbs step", () => {
    const c = ampCacheCheck({ registry: { projectSnapshots: 2 } });
    expect(c.status).toBe("INFO");
    expect(c.name).toBe("Amp snapshot cache");
    expect(c.detail).toMatch(
      /^cf-orbs holds 2 project snapshot mapping\(s\)\. Amp caches one prepared snapshot per provider for 72 h\./,
    );
    expect(c.detail).toContain("Amp → Orb Settings → Snapshots");
    expect(c.detail).toContain("amp projects snapshots delete <owner/repo> --resource <size>");
    expect(c.detail).toContain("cf-orbs snapshots forget --all-project");
    expect(c.detail).not.toContain("\n");
    expect(ampCacheCheck(undefined).detail).toMatch(/^Amp caches one/);
  });

  it("upgrade --no-deploy prints the Amp step and the cf-orbs step after bumping the digest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cf-orbs-upg-"));
    await mkdir(join(dir, "image"));
    await writeFile(
      join(dir, "image", "Dockerfile"),
      `FROM ${AMP_DEFAULT_IMAGE_REPO}@${DEFAULT_CONFIG.ampImageDigest}\nUSER root\n`,
    );
    await writeFile(join(dir, "cf-orbs.config.jsonc"), "{}\n");
    const cap = captureUi();
    const ctx = makeCtx(
      cap.ui,
      parseArgs(["--digest", `sha256:${"1".repeat(64)}`, "--no-deploy"], {
        digest: { type: "string" },
        "no-deploy": { type: "boolean" },
      }),
      dir,
    );
    expect(await upgradeCommand(ctx)).toBe(0);
    expect(await readFile(join(dir, "image", "Dockerfile"), "utf8")).toContain("1".repeat(64));
    const out = cap.lines.join("\n");
    expect(out).toContain("Amp → Orb Settings → Snapshots");
    expect(out).toContain("cf-orbs snapshots forget --all-project");
    expect(cap.lines.slice(-AMP_CACHE_STEPS.length)).toEqual([...AMP_CACHE_STEPS]);
    expect(cap.results.at(-1)).toMatchObject({ ok: true, deployed: false, nextSteps: AMP_CACHE_STEPS });
  });
});
