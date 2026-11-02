// Contract tests for dispatch/dispatch.sh (D11, D12, plan task 1.13).
// Runs the script with ORB_* env against the node:http mock of the control API.
// DISPATCH_SHELL picks the shell (default /bin/sh), e.g. DISPATCH_SHELL=dash.
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type MockServer, startMockServer } from "./mock-server";

const SCRIPT = fileURLToPath(new URL("../dispatch.sh", import.meta.url));
const SHELL = process.env.DISPATCH_SHELL ?? "/bin/sh";
const ORB = "amp-T-0a1b2c3d";
const CTRL = "ctl-Secret.Value_0123456789abcdef";
const ORB_TOKEN = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJvcmIifQ.c2lnbmF0dXJlLXZhbHVl";
const AOP = "aop_live_ZZq81kd02mxPq7Lr";

interface Result {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  argv: string;
}

let dir: string;
let wrapDir: string;
let argvLog: string;
let mock: MockServer;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cf-orbs-dispatch-"));
  wrapDir = join(dir, "bin");
  argvLog = join(dir, "argv.log");
  const realCurl = execFileSync("sh", ["-c", "command -v curl"]).toString().trim();
  execFileSync("mkdir", ["-p", wrapDir]);
  // Records every curl argv, so tests can prove no secret is on a command line.
  writeFileSync(
    join(wrapDir, "curl"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "$CFO_ARGV_LOG"\nexec "${realCurl}" "$@"\n`,
  );
  chmodSync(join(wrapDir, "curl"), 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  mock = await startMockServer();
  writeFileSync(argvLog, "");
});

afterEach(async () => {
  await mock.close();
});

function run(env: Record<string, string>, opts: { noDefaults?: boolean } = {}): Promise<Result> {
  const base: Record<string, string> = {
    PATH: `${wrapDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: dir,
    CFO_ARGV_LOG: argvLog,
  };
  const defaults: Record<string, string> = opts.noDefaults
    ? {}
    : { CF_ORBS_URL: mock.url, CF_ORBS_CONTROL_TOKEN: CTRL, ORB_OPERATION: "spawn", ORB_ID: ORB };
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(SHELL, [SCRIPT], { env: { ...base, ...defaults, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, ms: Date.now() - t0, argv: readFileSync(argvLog, "utf8") }),
    );
  });
}

const lines = (s: string) => s.split("\n").filter((l) => l !== "");
const count = (s: string, line: string) => lines(s).filter((l) => l === line).length;

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const addr = s.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe(`dispatch.sh request mapping (${SHELL})`, () => {
  it("spawn sends op, snapshotId, image, token, ampUrl with the bearer", async () => {
    const r = await run({
      ORB_IMAGE: "us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb:latest",
      ORB_SNAPSHOT_ID: "snap-f3851194-5479269c",
      ORB_TOKEN,
      AMP_URL: "https://ampcode.com",
    });
    expect(r.code).toBe(0);
    expect(lines(r.stdout)[0]).toBe(`cf-orbs: spawn ${ORB}`);
    const [post] = mock.posts();
    expect(mock.posts()).toHaveLength(1);
    expect(post?.path).toBe(`/v1/orbs/${ORB}/ops`);
    expect(post?.authorization).toBe(`Bearer ${CTRL}`);
    expect(post?.contentType).toBe("application/json");
    expect(post?.body).toEqual({
      op: "spawn",
      snapshotId: "snap-f3851194-5479269c",
      image: "us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb:latest",
      token: ORB_TOKEN,
      ampUrl: "https://ampcode.com",
    });
    expect(mock.gets()[0]?.path).toBe(`/v1/ops/${ORB}:3f2a9c1e-0000-4000-8000-000000000001`);
  });

  it("pause sends only op and snapshotId (no token, image or ampUrl)", async () => {
    const r = await run({
      ORB_OPERATION: "pause",
      ORB_SNAPSHOT_ID: "snap-p1",
      ORB_TOKEN,
      ORB_IMAGE: "img",
      AMP_URL: "https://ampcode.com",
    });
    expect(r.code).toBe(0);
    expect(lines(r.stdout)[0]).toBe(`cf-orbs: pause ${ORB}`);
    expect(mock.posts()[0]?.body).toEqual({ op: "pause", snapshotId: "snap-p1" });
  });

  it("delete sends only op", async () => {
    const r = await run({ ORB_OPERATION: "delete" });
    expect(r.code).toBe(0);
    expect(mock.posts()[0]?.body).toEqual({ op: "delete" });
  });

  it("omits ampUrl and image when unset or empty", async () => {
    const r = await run({ ORB_TOKEN, ORB_IMAGE: "" });
    expect(r.code).toBe(0);
    const body = (mock.posts()[0]?.body ?? {}) as Record<string, unknown>;
    expect(body).toEqual({ op: "spawn", token: ORB_TOKEN });
    expect("ampUrl" in body).toBe(false);
    expect(mock.posts()[0]?.rawBody).not.toContain("ampUrl");
  });

  it("escapes quotes, backslashes, newlines and control characters so values round-trip", async () => {
    const snap = 'a"b\\c';
    const amp = "https://x.example/\npath\tq\u0001z é";
    const r = await run({ ORB_SNAPSHOT_ID: snap, AMP_URL: amp, ORB_TOKEN });
    expect(r.code).toBe(0);
    expect(mock.posts()[0]?.body).toEqual({ op: "spawn", snapshotId: snap, token: ORB_TOKEN, ampUrl: amp });
  });
});

describe(`dispatch.sh progress and outcome (${SHELL})`, () => {
  it("prints each progress line exactly once and exits 0 on success", async () => {
    mock.scenario = {
      polls: [
        { phase: "queued", progress: [] },
        { phase: "running", progress: ["starting orb from image"] },
        { phase: "running", progress: ["starting orb from image", 'bootstrap "launched" \\ ok'] },
        { phase: "running", progress: ["starting orb from image", 'bootstrap "launched" \\ ok'] },
        {
          phase: "succeeded",
          progress: ["starting orb from image", 'bootstrap "launched" \\ ok', "connected — ü ✓\tdone"],
          extra: { result: { wake: { source: "image", ms: [1, 2] } }, finishedAt: "2026-10-30T00:00:00Z" },
        },
      ],
    };
    const r = await run({ ORB_TOKEN });
    expect(r.code).toBe(0);
    expect(count(r.stdout, "starting orb from image")).toBe(1);
    expect(count(r.stdout, 'bootstrap "launched" \\ ok')).toBe(1);
    expect(count(r.stdout, "connected — ü ✓ done")).toBe(1);
    expect(lines(r.stdout)).toContain(`started spawn ${ORB}:3f2a9c1e-0000-4000-8000-000000000001`);
    expect(lines(r.stdout).at(-1)).toMatch(new RegExp(`^cf-orbs: spawn ${ORB} done in \\d+ s$`));
    expect(mock.gets()).toHaveLength(5);
    expect(mock.gets()[0]?.authorization).toBe(`Bearer ${CTRL}`);
  });

  it("prints 'attaching to running <op>' when the op was already in flight", async () => {
    mock.scenario = { attached: true, opId: `${ORB}:abc` };
    const r = await run({});
    expect(r.code).toBe(0);
    expect(lines(r.stdout)).toContain(`attaching to running spawn ${ORB}:abc`);
  });

  it("failed op: exit 1 with the server's Failed line, one prefix only", async () => {
    // Real Worker errors already start with "Failed:" (session.ts asFailed).
    const error =
      "Failed: image foo:1 is not registered; add it to cf-orbs.config.jsonc — fix: run cf-orbs deploy";
    mock.scenario = { polls: [{ phase: "failed", progress: ["mapping image"], error }] };
    const r = await run({});
    expect(r.code).toBe(1);
    expect(lines(r.stdout).at(-1)).toBe(error);
    expect(lines(r.stderr)).toEqual([error]);
    expect(r.stdout).not.toContain("Failed: Failed:");
    expect(count(r.stdout, "mapping image")).toBe(1);
  });

  it("4xx with a Worker Failed line keeps one prefix", async () => {
    const error = "Failed: orb was deleted at 2026-10-30T01:02:03Z — fix: start a new thread";
    mock.scenario = { postReply: { status: 409, body: JSON.stringify({ error }) } };
    const r = await run({});
    expect(r.code).toBe(1);
    expect(lines(r.stdout).at(-1)).toBe(error);
    expect(lines(r.stderr)).toEqual([error]);
  });

  it("long-poll sends since=<lines printed>", async () => {
    mock.scenario = {
      polls: [
        { phase: "running", progress: ["a"] },
        { phase: "running", progress: ["a", "b", "c"] },
        { phase: "succeeded", progress: ["a", "b", "c"] },
      ],
    };
    const r = await run({});
    expect(r.code).toBe(0);
    const since = mock.gets().map((g) => g.query.get("since"));
    expect(since).toEqual(["0", "1", "3"]);
  });

  it("a reply with new lines polls again at once", async () => {
    mock.scenario = {
      polls: [
        { phase: "running", progress: ["a"] },
        { phase: "running", progress: ["a", "b"] },
        { phase: "succeeded", progress: ["a", "b", "c"] },
      ],
    };
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(900);
  });

  it("a fast reply with nothing new waits 1 s before the next poll (no busy loop)", async () => {
    mock.scenario = {
      polls: [
        { phase: "running", progress: ["a"] },
        { phase: "running", progress: ["a"] },
        { phase: "running", progress: ["a"] },
        { phase: "running", progress: ["a"] },
        { phase: "succeeded", progress: ["a"] },
      ],
    };
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.ms).toBeGreaterThanOrEqual(1000);
  });

  it("failed op without a fix gets the logs command as fix", async () => {
    mock.scenario = { polls: [{ phase: "failed", progress: [], error: "snapshot timed out" }] };
    const r = await run({ ORB_OPERATION: "pause" });
    expect(r.code).toBe(1);
    expect(lines(r.stdout).at(-1)).toBe(`Failed: snapshot timed out — fix: cf-orbs logs ${ORB}`);
  });

  it("server down: retries 3 times 2 s apart, then Failed", async () => {
    const port = await freePort();
    const r = await run({ CF_ORBS_URL: `http://127.0.0.1:${port}` });
    expect(r.code).toBe(1);
    expect(
      lines(r.stdout).filter((l) => l.startsWith("control plane: connection refused, retry")),
    ).toHaveLength(2);
    expect(lines(r.stdout).at(-1)).toBe(
      `Failed: control plane unreachable at http://127.0.0.1:${port} (connection refused, 3 attempts) — fix: run cf-orbs status; check the Worker is deployed`,
    );
    expect(r.ms).toBeGreaterThanOrEqual(3900);
    expect(lines(r.argv)).toHaveLength(3);
  });

  it("retries a transient 503 on POST, then succeeds", async () => {
    mock.scenario = { postFailures: [{ status: 503, body: '{"error":"busy"}' }] };
    const r = await run({});
    expect(r.code).toBe(0);
    expect(mock.posts()).toHaveLength(2);
    expect(lines(r.stdout)).toContain("control plane: HTTP 503, retry 1 of 2");
  });

  it("deadline: Failed when the op never finishes", async () => {
    mock.scenario = { neverFinish: true, holdMaxMs: 1000 };
    const r = await run({ CF_ORBS_DEADLINE_SECONDS: "3" });
    expect(r.code).toBe(1);
    expect(lines(r.stdout).at(-1)).toBe(
      `Failed: control plane did not finish spawn within 3 s — fix: cf-orbs logs ${ORB}`,
    );
    expect(count(r.stdout, "still working")).toBe(1);
    expect(r.ms).toBeLessThan(8000);
    for (const g of mock.gets()) expect(g.path).toMatch(/^\/v1\/ops\//);
  });

  it("401 → Failed with the control token fix", async () => {
    mock.scenario = { postReply: { status: 401, body: '{"error":"unauthorized"}' } };
    const r = await run({});
    expect(r.code).toBe(1);
    expect(lines(r.stdout).at(-1)).toBe(
      "Failed: control plane rejected the control token (HTTP 401) — fix: set CF_ORBS_CONTROL_TOKEN to the Worker CONTROL_TOKEN",
    );
  });

  it("400 with a server error passes the error through", async () => {
    mock.scenario = {
      postReply: { status: 400, body: '{"error":"orb was deleted at 2026-10-30T01:02:03Z"}' },
    };
    const r = await run({});
    expect(r.code).toBe(1);
    expect(lines(r.stdout).at(-1)).toBe(
      `Failed: orb was deleted at 2026-10-30T01:02:03Z (HTTP 400) — fix: cf-orbs logs ${ORB}`,
    );
  });

  it("unknown opId on GET → Failed", async () => {
    mock.scenario = { getReply: { status: 404, body: '{"error":"no such op"}' } };
    const r = await run({});
    expect(r.code).toBe(1);
    expect(lines(r.stdout).at(-1)).toMatch(/^Failed: op .* is unknown to the control plane — fix: /);
  });

  it("unreadable POST reply → Failed", async () => {
    mock.scenario = { postReply: { status: 202, body: "<html>oops</html>" } };
    const r = await run({});
    expect(r.code).toBe(1);
    expect(lines(r.stdout).at(-1)).toMatch(/^Failed: control plane sent an unreadable reply/);
  });
});

describe(`dispatch.sh secrets (${SHELL})`, () => {
  it("never prints ORB_TOKEN, the control token, aop_live_ or Bearer values, nor puts them in argv", async () => {
    mock.scenario = {
      polls: [
        { phase: "running", progress: [`echo token ${ORB_TOKEN}`, `key ${AOP} here`] },
        {
          phase: "failed",
          progress: [`echo token ${ORB_TOKEN}`, `key ${AOP} here`, `header Bearer ${CTRL}`, `raw ${CTRL}`],
          error: `bootstrap rejected ${ORB_TOKEN} via ${AOP}`,
        },
      ],
    };
    const r = await run({ ORB_TOKEN, AMP_URL: "https://ampcode.com", SECRET_CANARY: "canary-9f8e7d" });
    expect(r.code).toBe(1);
    const all = r.stdout + r.stderr;
    for (const secret of [ORB_TOKEN, CTRL, AOP, "canary-9f8e7d", "c2lnbmF0dXJlLXZhbHVl"]) {
      expect(all).not.toContain(secret);
      expect(r.argv).not.toContain(secret);
    }
    expect(all).toContain("aop_live_[redacted]");
    expect(all).toContain("Bearer [redacted]");
    expect(all).toContain("raw [redacted]");
    expect(mock.posts()[0]?.body?.token).toBe(ORB_TOKEN);
  });

  it("control.internal: sends no bearer even when a token is set", async () => {
    // curl reaches the mock through http_proxy, as the intercept would in the provider container.
    const r = await run({ CF_ORBS_URL: "http://control.internal", http_proxy: mock.url });
    expect(r.code).toBe(0);
    expect(mock.posts()[0]?.host).toBe("control.internal");
    expect(mock.posts()[0]?.authorization).toBeUndefined();
    expect(mock.gets()[0]?.authorization).toBeUndefined();
  });

  it("reads the bearer from CF_ORBS_CONTROL_TOKEN_FILE", async () => {
    const f = join(dir, "ctl");
    writeFileSync(f, "file-token-123456\r\n");
    const r = await run({ CF_ORBS_CONTROL_TOKEN: "", CF_ORBS_CONTROL_TOKEN_FILE: f });
    expect(r.code).toBe(0);
    expect(mock.posts()[0]?.authorization).toBe("Bearer file-token-123456");
    expect(r.argv).not.toContain("file-token-123456");
  });

  it("plain http to a remote host → exit 2, nothing sent", async () => {
    const r = await run({ CF_ORBS_URL: "http://cf-orbs.example.workers.dev" });
    expect(r.code).toBe(2);
    expect(lines(r.stdout).at(-1)).toBe(
      "Failed: CF_ORBS_URL must use https for cf-orbs.example.workers.dev — fix: set CF_ORBS_URL to https://<your Worker host>",
    );
    expect(lines(r.argv)).toHaveLength(0);
  });

  it("external mode without a control token → exit 2", async () => {
    const r = await run({ CF_ORBS_CONTROL_TOKEN: "" });
    expect(r.code).toBe(2);
    expect(lines(r.stdout).at(-1)).toMatch(
      /^Failed: no control token for 127\.0\.0\.1 — fix: set CF_ORBS_CONTROL_TOKEN/,
    );
    expect(mock.requests).toHaveLength(0);
  });
});

describe(`dispatch.sh input checks (${SHELL})`, () => {
  for (const id of ["../x", "a/b", "-abc", "_x", "a b", "a\nb", "x".repeat(129)]) {
    it(`invalid ORB_ID ${JSON.stringify(id.slice(0, 12))} → exit 2`, async () => {
      const r = await run({ ORB_ID: id });
      expect(r.code).toBe(2);
      expect(lines(r.stdout).at(-1)).toMatch(/^Failed: invalid orb id '.*' — fix: check ORB_ID from Amp$/);
      expect(mock.requests).toHaveLength(0);
    });
  }

  it("missing ORB_ID → exit 2", async () => {
    const r = await run({ ORB_OPERATION: "spawn", CF_ORBS_URL: mock.url }, { noDefaults: true });
    expect(r.code).toBe(2);
    expect(lines(r.stdout).at(-1)).toBe("Failed: invalid orb id '' — fix: check ORB_ID from Amp");
  });

  it("128-char ORB_ID is accepted", async () => {
    const id = `a${"b".repeat(127)}`;
    const r = await run({ ORB_ID: id });
    expect(r.code).toBe(0);
    expect(mock.posts()[0]?.orbId).toBe(id);
  });

  it("ORB_OPERATION=reset → exit 2 with update fix", async () => {
    const r = await run({ ORB_OPERATION: "reset" });
    expect(r.code).toBe(2);
    expect(lines(r.stdout).at(-1)).toBe(
      "Failed: unknown ORB_OPERATION 'reset' — fix: update cf-orbs (npx cf-orbs@latest deploy)",
    );
    expect(mock.requests).toHaveLength(0);
  });

  it("bad CF_ORBS_URL and deadline → exit 2", async () => {
    expect((await run({ CF_ORBS_URL: "ftp://x" })).code).toBe(2);
    expect((await run({ CF_ORBS_URL: 'http://x/"y' })).code).toBe(2);
    expect((await run({ CF_ORBS_DEADLINE_SECONDS: "abc" })).code).toBe(2);
    expect((await run({ CF_ORBS_DEADLINE_SECONDS: "0" })).code).toBe(2);
    expect(mock.requests).toHaveLength(0);
  });

  it("trailing slash on CF_ORBS_URL is dropped", async () => {
    const r = await run({ CF_ORBS_URL: `${mock.url}/` });
    expect(r.code).toBe(0);
    expect(mock.posts()[0]?.path).toBe(`/v1/orbs/${ORB}/ops`);
  });
});

it("dispatch.sh is executable", () => {
  expect(existsSync(SCRIPT)).toBe(true);
  expect(
    execFileSync("sh", ["-c", `test -x "${SCRIPT}" && echo yes`])
      .toString()
      .trim(),
  ).toBe("yes");
});
