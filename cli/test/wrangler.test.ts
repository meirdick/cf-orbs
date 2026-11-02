import { describe, expect, it } from "vitest";
import { redact, registerSecret, toFailedLine } from "../src/errors";
import {
  classifyDeployFailure,
  deployWithRetry,
  lastErrorLine,
  parseWhoami,
  parseWorkerUrl,
  type RunResult,
  type Wrangler,
} from "../src/wrangler";

const PUSH_TIMEOUT = `9addb4c7f3af: Pushed
failed commit on ref "layer-sha256:9edf": failed to do request: Put "https://registry.cloudflare.com/v2/acct/x/blobs/uploads/u": net/http: timeout awaiting response headers
✘ [ERROR] Docker command exited with code: 1`;
const PREP_401 = `Image already exists remotely, skipping push
├ Preparing orb for Cloudflare Containers
│   registry.cloudflare.com/acct/cf-orbs-orbsession-orb@sha256:f910
✘ [ERROR] Unauthorized`;
const OK = `Uploaded cf-orbs (11.67 sec)
Deployed cf-orbs triggers (0.69 sec)
  https://cf-orbs.example.workers.dev
Current Version ID: b346a080`;

function fakeWrangler(results: RunResult[]): Wrangler & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(args) {
      calls.push(args);
      const r = results.shift();
      if (!r) throw new Error("no more results");
      return r;
    },
  };
}
const nosleep = async () => {};

describe("deploy output parsing", () => {
  it("classifies the known registry flakes as retryable", () => {
    expect(classifyDeployFailure(PUSH_TIMEOUT)).toBe("retry");
    expect(classifyDeployFailure(PREP_401)).toBe("retry");
    expect(classifyDeployFailure("✘ [ERROR] Unauthorized")).not.toBe("retry"); // no image push before it
  });
  it("maps Workers Paid, Docker and auth errors", () => {
    expect(classifyDeployFailure("✘ [ERROR] You need a Workers Paid plan to use Containers.")).toBe("paid");
    expect(classifyDeployFailure("Cannot connect to the Docker daemon at unix:///var/run/docker.sock")).toBe(
      "docker",
    );
    expect(classifyDeployFailure("✘ [ERROR] You are not logged in. Run wrangler login")).toBe("auth");
    expect(classifyDeployFailure("✘ [ERROR] Build failed with 1 error")).toBe("other");
  });
  it("finds the workers.dev URL, preferring the Worker's own name", () => {
    expect(parseWorkerUrl(OK, "cf-orbs")).toBe("https://cf-orbs.example.workers.dev");
    expect(
      parseWorkerUrl("see https://other.sub.workers.dev and https://cf-orbs.sub.workers.dev", "cf-orbs"),
    ).toBe("https://cf-orbs.sub.workers.dev");
    expect(parseWorkerUrl("no url here")).toBeUndefined();
  });
  it("takes the [ERROR] line as the cause, without ANSI codes", () => {
    expect(
      lastErrorLine(
        "noise\n\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1mBuild failed\x1b[0m\nLogs were written",
      ),
    ).toBe("Build failed");
  });
  it("parses whoami --json", () => {
    const w = parseWhoami(
      `{"loggedIn":true,"email":"a@b","accounts":[{"id":"1","name":"A","type":"standard"}]}`,
    );
    expect(w).toEqual({ loggedIn: true, email: "a@b", accounts: [{ id: "1", name: "A" }] });
    expect(parseWhoami("garbage")).toEqual({ loggedIn: false, accounts: [] });
  });
});

describe("deployWithRetry", () => {
  it("retries the push timeout and the 401 up to 3 times, then succeeds", async () => {
    const w = fakeWrangler([
      { code: 1, stdout: PUSH_TIMEOUT, stderr: "" },
      { code: 1, stdout: PUSH_TIMEOUT, stderr: "" },
      { code: 1, stdout: "", stderr: PREP_401 },
      { code: 0, stdout: OK, stderr: "" },
    ]);
    const retries: number[] = [];
    const r = await deployWithRetry(w, ["--secrets-file", "/tmp/s"], {
      name: "cf-orbs",
      sleep: nosleep,
      onRetry: (n) => retries.push(n),
    });
    expect(r.attempts).toBe(4);
    expect(r.url).toBe("https://cf-orbs.example.workers.dev");
    expect(retries).toEqual([1, 2, 3]);
    expect(w.calls.every((c) => c[0] === "deploy" && c.includes("--secrets-file"))).toBe(true);
  });
  it("gives up after 3 retries with a one-line fix", async () => {
    const w = fakeWrangler(Array.from({ length: 4 }, () => ({ code: 1, stdout: PUSH_TIMEOUT, stderr: "" })));
    await expect(deployWithRetry(w, [], { sleep: nosleep })).rejects.toThrow(
      /^Failed: image push to registry.cloudflare.com kept failing .* — fix: rerun cf-orbs deploy/,
    );
    expect(w.calls).toHaveLength(4);
  });
  it("does not retry the Workers Paid error and maps it to one line", async () => {
    const w = fakeWrangler([
      {
        code: 1,
        stdout: "",
        stderr: "✘ [ERROR] Containers are not enabled for this account. Upgrade to the Workers Paid plan.",
      },
    ]);
    await expect(deployWithRetry(w, [], { sleep: nosleep })).rejects.toThrow(
      /^Failed: Containers need the Workers Paid plan on this account — fix: upgrade at https:\/\/dash\.cloudflare\.com/,
    );
    expect(w.calls).toHaveLength(1);
  });
});

describe("redaction", () => {
  it("removes registered secrets and aop_live_ tokens from Failed lines", () => {
    registerSecret("c".repeat(64));
    expect(redact(`x ${"c".repeat(64)} aop_live_abcDEF_123 y`)).toBe("x [redacted] aop_live_[redacted] y");
    expect(toFailedLine(new Error("boom aop_live_zzz\nsecond line"))).toBe(
      "Failed: boom aop_live_[redacted] second line — fix: rerun with CF_ORBS_DEBUG=1 and report the output",
    );
  });
});
