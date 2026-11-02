import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/args";
import { parseAge, snapshotImageRefs, snapshotsCommand, snapshotTag } from "../src/commands/snapshots";
import { renderStatus } from "../src/commands/status";
import { type Ctx, makeCtx } from "../src/context";
import { projectPaths, writeControlToken } from "../src/project";
import type { Ui } from "../src/ui";
import type { RunResult } from "../src/wrangler";

const NOW = Date.parse("2026-10-30T20:00:00Z");
const D = 86_400_000;
const TOKEN = "b".repeat(64);
const URL_ = "https://cf-orbs.x.workers.dev";
const iso = (ms: number) => new Date(ms).toISOString();

const CANDIDATES = [
  { id: "aaa111", orbId: "amp-T-1", imageKey: "orb", bytes: 1_200_000_000, lastUsedAt: iso(NOW - 12 * D) },
  { id: "bbb222", orbId: "amp-T-2", imageKey: "orb", bytes: 300_000_000, lastUsedAt: iso(NOW - 9 * D) },
];
const PRUNE = {
  candidates: CANDIDATES,
  totalBytes: 1_500_000_000,
  kept: { mapped: 1, current: 4, young: 6 },
};
const IMAGES = JSON.stringify([
  {
    name: "cf-orbs-orbsession-orb",
    tags: ["wrangler-1", snapshotTag("aaa111"), snapshotTag("bbb222")],
  },
  { name: "cf-orbs-providerhost-provider", tags: ["wrangler-2"] },
]);

function captureUi(json = false): { ui: Ui; lines: string[]; results: unknown[] } {
  const lines: string[] = [];
  const results: unknown[] = [];
  const push = (l: string) => lines.push(l);
  return {
    lines,
    results,
    ui: {
      json,
      nonInteractive: true,
      step: push,
      warn: push,
      out: push,
      result: (v) => results.push(v),
      raw: () => {},
    },
  };
}

describe("cf-orbs snapshots prune", () => {
  let dir: string;
  let calls: string[];
  let forgetBodies: unknown[];
  let wrangler: string[][];
  let runResult: (args: string[]) => RunResult;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cf-orbs-prune-"));
    await writeControlToken(projectPaths(dir), TOKEN);
    await writeFile(join(dir, "cf-orbs.config.jsonc"), '{ "name": "cf-orbs" }\n');
    calls = [];
    forgetBodies = [];
    wrangler = [];
    runResult = (args) => {
      if (args.includes("list")) return { code: 0, stdout: IMAGES, stderr: "" };
      return { code: 0, stdout: "Deleted", stderr: "" };
    };
  });

  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.search}`);
    if ((init?.headers as Record<string, string>)?.authorization !== `Bearer ${TOKEN}`)
      return new Response("", { status: 401 });
    if (u.pathname === "/v1/snapshots" && u.searchParams.get("candidates") === "1")
      return Response.json(PRUNE);
    if (u.pathname === "/v1/snapshots/forget-many" && method === "POST") {
      const b = JSON.parse(String(init?.body)) as { ids: string[] };
      forgetBodies.push(b);
      return Response.json({ forgotten: b.ids, mapped: [] });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  function ctxFor(argv: string[], json = false) {
    const cap = captureUi(json);
    const args = parseArgs(["prune", ...argv, "--url", URL_], {
      all: { type: "boolean" },
      "older-than": { type: "string" },
      yes: { type: "boolean", short: "y" },
      url: { type: "string" },
    });
    const ctx: Ctx = makeCtx(cap.ui, args, dir, {
      fetch: fakeFetch,
      env: {},
      now: () => NOW,
      run: async (_cmd, a) => {
        const args = a.slice(a.indexOf("containers"));
        wrangler.push(args);
        return runResult(args);
      },
    });
    return { ctx, cap };
  }

  it("without --yes lists candidates, total and kept counts, runs no wrangler, exits 0", async () => {
    const { ctx, cap } = ctxFor([]);
    expect(await snapshotsCommand(ctx)).toBe(0);
    expect(calls).toEqual(["GET /v1/snapshots?candidates=1&olderThan=604800"]);
    expect(wrangler).toEqual([]);
    const text = cap.lines.join("\n");
    expect(text).toMatch(/^CF SNAPSHOT\s+ORB\s+SIZE\s+LAST USED$/m);
    expect(text).toMatch(/^aaa111\s+amp-T-1\s+1.20 GB\s+12d ago$/m);
    expect(text).toContain("Kept: 1 in a project mapping, 4 orb disk(s), 6 used in the last 7d.");
    expect(cap.lines.at(-1)).toBe("Would delete 2 snapshot(s), 1.50 GB; rerun with --yes.");
  });

  it("--older-than and --all set the age gate; both together is an error", async () => {
    expect(await snapshotsCommand(ctxFor(["--older-than", "36h"]).ctx)).toBe(0);
    expect(await snapshotsCommand(ctxFor(["--all"]).ctx)).toBe(0);
    expect(calls).toEqual([
      "GET /v1/snapshots?candidates=1&olderThan=129600",
      "GET /v1/snapshots?candidates=1&olderThan=0",
    ]);
    await expect(snapshotsCommand(ctxFor(["--all", "--older-than", "2d"]).ctx)).rejects.toThrow(
      /^Failed: --all and --older-than do not go together — fix: /,
    );
    await expect(snapshotsCommand(ctxFor(["--older-than", "7"]).ctx)).rejects.toThrow(
      /^Failed: bad --older-than 7 — fix: use a number and a unit/,
    );
    expect(calls).toHaveLength(2);
  });

  it("--yes deletes each image tag with wrangler, then forgets the deleted ids", async () => {
    const { ctx, cap } = ctxFor(["--yes"], true);
    expect(await snapshotsCommand(ctx)).toBe(0);
    expect(wrangler).toEqual([
      ["containers", "images", "list", "--json"],
      [
        "containers",
        "images",
        "delete",
        `cf-orbs-orbsession-orb:${snapshotTag("aaa111")}`,
        "--skip-confirmation",
      ],
      [
        "containers",
        "images",
        "delete",
        `cf-orbs-orbsession-orb:${snapshotTag("bbb222")}`,
        "--skip-confirmation",
      ],
    ]);
    expect(forgetBodies).toEqual([{ ids: ["aaa111", "bbb222"] }]);
    expect(cap.results.at(-1)).toMatchObject({
      ok: true,
      dryRun: false,
      deleted: ["aaa111", "bbb222"],
      deletedBytes: 1_500_000_000,
      failed: [],
      forgotten: ["aaa111", "bbb222"],
    });
  });

  it("one wrangler error is reported and skipped; the rest are deleted and forgotten; exit 0", async () => {
    runResult = (args) => {
      if (args.includes("list")) return { code: 0, stdout: IMAGES, stderr: "" };
      if (args.some((a) => a.endsWith(snapshotTag("aaa111"))))
        return { code: 1, stdout: "", stderr: "✘ [ERROR] Image not found\n" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const { ctx, cap } = ctxFor(["--yes"]);
    expect(await snapshotsCommand(ctx)).toBe(0);
    expect(forgetBodies).toEqual([{ ids: ["bbb222"] }]);
    expect(cap.lines).toContain(
      `Failed: wrangler could not delete cf-orbs-orbsession-orb:${snapshotTag("aaa111")} (Image not found) — fix: none needed; skipped, Cloudflare drops it at its 30-day TTL`,
    );
    expect(cap.lines.at(-1)).toBe("Deleted 1 snapshot(s), 300 MB. 1 failed and were skipped.");
  });

  it("exits 1 with a fix when wrangler cannot list images; deletes and forgets nothing", async () => {
    runResult = () => ({ code: 1, stdout: "", stderr: "✘ [ERROR] You are not logged in.\n" });
    const { ctx } = ctxFor(["--yes"]);
    await expect(snapshotsCommand(ctx)).rejects.toThrow(
      "Failed: wrangler containers images list failed: You are not logged in. — fix: run npx wrangler login, then rerun cf-orbs snapshots prune --yes",
    );
    expect(wrangler).toHaveLength(1);
    expect(forgetBodies).toEqual([]);
  });

  it("exits 1 when every delete fails", async () => {
    runResult = (args) =>
      args.includes("list")
        ? { code: 0, stdout: "[]", stderr: "" }
        : { code: 1, stdout: "", stderr: "✘ [ERROR] boom\n" };
    const { ctx } = ctxFor(["--yes"]);
    await expect(snapshotsCommand(ctx)).rejects.toThrow(
      /^Failed: no snapshot deleted; wrangler failed on all 2 — fix: /,
    );
    expect(forgetBodies).toEqual([]);
    const j = ctxFor(["--yes"], true);
    expect(await snapshotsCommand(j.ctx)).toBe(1);
    expect(j.cap.results.at(-1)).toMatchObject({
      ok: false,
      deleted: [],
      failed: [
        { id: "aaa111", error: "boom" },
        { id: "bbb222", error: "boom" },
      ],
    });
  });
});

describe("prune helpers", () => {
  it("parseAge", () => {
    expect(parseAge("7d")).toBe(7 * D);
    expect(parseAge("36h")).toBe(36 * 3_600_000);
    expect(parseAge("90m")).toBe(90 * 60_000);
    for (const bad of ["", "7", "d", "1w", "-1d"]) expect(() => parseAge(bad)).toThrow(/bad --older-than/);
  });

  it("snapshotImageRefs finds the repo that holds the tag, else <worker>-orbsession-<key>", () => {
    const images = JSON.stringify([
      { name: "w-orbsession-orb", tags: [snapshotTag("a")] },
      { name: "w-orbsession-py", tags: [snapshotTag("b")] },
      { name: "other-orbsession-orb", tags: [snapshotTag("c")] },
    ]);
    const refs = snapshotImageRefs(
      "w",
      [
        { id: "a", imageKey: "py" },
        { id: "b", imageKey: "orb" },
        { id: "c", imageKey: "py" },
      ],
      images,
    );
    // Seen live 2026-10-31: the tag is the sha256 hex of the snapshot id.
    expect(snapshotTag("7ef0c3d6-0562-4021-a568-5af4b0498b04")).toBe(
      "rootfs-snapshot-3a3c736d7468ce79a4d7a6ae6e1d8161f62bb7e2c296217f115cd21b9a0f2c4f",
    );
    expect([...refs.values()]).toEqual([
      `w-orbsession-orb:${snapshotTag("a")}`,
      `w-orbsession-py:${snapshotTag("b")}`,
      `w-orbsession-py:${snapshotTag("c")}`,
    ]);
    expect(snapshotImageRefs("w", [{ id: "a", imageKey: "orb" }], "not json").get("a")).toBe(
      `w-orbsession-orb:${snapshotTag("a")}`,
    );
  });

  it("status shows prunable only when > 0", () => {
    const reg = {
      retainedSnapshots: 68,
      retainedSnapshotBytes: 3.2e9,
      projectSnapshots: 1,
      running: [],
      max: 20,
    };
    expect(
      renderStatus({ registry: { ...reg, prunableSnapshots: 40, prunableSnapshotBytes: 2.1e9 } }, NOW),
    ).toContain("prunable: 40 (2.10 GB); see cf-orbs snapshots prune");
    expect(renderStatus({ registry: { ...reg, prunableSnapshots: 0 } }, NOW)).not.toContain("prunable");
    expect(renderStatus({ registry: reg }, NOW)).not.toContain("prunable");
  });
});
