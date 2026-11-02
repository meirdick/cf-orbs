import { describe, expect, it } from "vitest";
import { helloCommand, type InitOptions, type InitProbes, type InitStep, plan } from "../src/commands/init";

const probes = (over: Partial<InitProbes> = {}): InitProbes => ({
  nodeVersion: "22.11.0",
  docker: true,
  whoami: { loggedIn: true, accounts: [{ id: "acct1", name: "Me" }] },
  hasControlToken: false,
  deployed: false,
  envToken: false,
  tty: true,
  ...over,
});
const opts = (over: Partial<InitOptions> = {}): InitOptions => ({
  mode: "cloudflare",
  nonInteractive: false,
  providerName: "cf-orbs",
  ...over,
});
const kinds = (s: InitStep[]) => s.map((x) => x.kind);
const fails = (s: InitStep[]) =>
  s.filter((x): x is Extract<InitStep, { kind: "fail" }> => x.kind === "fail").map((x) => x.error.message);

describe("init plan: cloudflare mode", () => {
  it("fresh interactive install: prompt token, subdomain, deploy, health, start and wait for provider", () => {
    const s = plan(opts(), probes());
    expect(kinds(s)).toEqual([
      "use-account",
      "plan-check",
      "scaffold",
      "control-token",
      "amp-token",
      "subdomain",
      "deploy",
      "health",
      "status",
      "selftest",
      "start-provider",
      "wait-provider",
      "done",
    ]);
    expect(s.find((x) => x.kind === "amp-token")).toEqual({ kind: "amp-token", source: "prompt" });
    expect(s.find((x) => x.kind === "control-token")).toEqual({ kind: "control-token", action: "generate" });
    expect(s.find((x) => x.kind === "deploy")).toEqual({
      kind: "deploy",
      secrets: ["CONTROL_TOKEN", "AMP_ORB_PROVIDER_TOKEN"],
    });
    expect(s.find((x) => x.kind === "wait-provider")).toEqual({ kind: "wait-provider", timeoutMs: 90_000 });
    expect(s.at(-1)).toEqual({
      kind: "done",
      command: 'amp -ox "hello from cf-orbs" --orb-provider cf-orbs',
    });
  });
  it("token source precedence: --token-file, then env, then prompt", () => {
    expect(
      plan(opts({ tokenFile: "/t" }), probes({ envToken: true })).find((x) => x.kind === "amp-token"),
    ).toEqual({ kind: "amp-token", source: "file" });
    expect(plan(opts(), probes({ envToken: true })).find((x) => x.kind === "amp-token")).toEqual({
      kind: "amp-token",
      source: "env",
    });
  });
  it("non-interactive first install without a token fails with a fix", () => {
    const s = plan(opts({ nonInteractive: true }), probes());
    expect(fails(s)).toEqual([
      expect.stringMatching(/^Failed: no Amp provider token given — fix: set AMP_ORB_PROVIDER_TOKEN/),
    ]);
  });
  it("non-interactive re-run keeps the existing token secret and control token", () => {
    const s = plan(
      opts({ nonInteractive: true }),
      probes({ deployed: true, prevMode: "cloudflare", hasControlToken: true, tty: false }),
    );
    expect(s.find((x) => x.kind === "amp-token")).toEqual({ kind: "amp-token", source: "keep" });
    expect(s.find((x) => x.kind === "control-token")).toEqual({ kind: "control-token", action: "reuse" });
    expect(s.find((x) => x.kind === "deploy")).toEqual({ kind: "deploy", secrets: ["CONTROL_TOKEN"] });
  });
  it("non-interactive switch external → cloudflare without a token fails: there is no secret to keep", () => {
    const s = plan(
      opts({ nonInteractive: true }),
      probes({ deployed: true, prevMode: "external", hasControlToken: true, tty: false }),
    );
    expect(fails(s)).toEqual([
      "Failed: no Amp provider token (the Worker has none after external mode) — fix: set AMP_ORB_PROVIDER_TOKEN or pass --token-file <file>",
    ]);
  });
  it("collects every failed precondition", () => {
    const s = plan(
      opts(),
      probes({ nodeVersion: "18.19.0", docker: false, whoami: { loggedIn: false, accounts: [] } }),
    );
    expect(kinds(s).every((k) => k === "fail")).toBe(true);
    expect(fails(s)).toEqual([
      expect.stringMatching(/Node 18.19.0 is too old/),
      expect.stringMatching(/Docker is not running/),
      expect.stringMatching(/wrangler is not logged in .* — fix: run npx wrangler login/),
    ]);
  });
  it("rejects Node 20 because the bundled wrangler 4 needs Node 22", () => {
    expect(fails(plan(opts(), probes({ nodeVersion: "20.19.0" })))).toEqual([
      "Failed: Node 20.19.0 is too old; cf-orbs needs Node 22 or later — fix: install Node 22+ (https://nodejs.org) and rerun",
    ]);
    expect(fails(plan(opts(), probes({ nodeVersion: "22.0.0" })))).toEqual([]);
  });
  it("several accounts: pick interactively, fail non-interactively, honor --account-id", () => {
    const two = {
      loggedIn: true,
      accounts: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
    };
    expect(plan(opts(), probes({ whoami: two }))[0]).toEqual({
      kind: "pick-account",
      accounts: two.accounts,
    });
    expect(fails(plan(opts({ nonInteractive: true, tokenFile: "/t" }), probes({ whoami: two })))[0]).toMatch(
      /2 Cloudflare accounts — fix: pass --account-id/,
    );
    expect(plan(opts({ accountId: "b" }), probes({ whoami: two }))[0]).toEqual({
      kind: "use-account",
      accountId: "b",
      accountName: "B",
    });
    expect(fails(plan(opts({ accountId: "zzz" }), probes({ whoami: two })))[0]).toMatch(
      /account zzz is not in wrangler whoami/,
    );
  });
});

describe("init plan: external mode", () => {
  it("needs no Amp token, still generates CONTROL_TOKEN, prints the dispatch env instead of waiting for a provider", () => {
    const s = plan(opts({ mode: "external", nonInteractive: true }), probes({ tty: false }));
    expect(kinds(s)).toEqual([
      "use-account",
      "plan-check",
      "scaffold",
      "control-token",
      "subdomain",
      "deploy",
      "health",
      "status",
      "selftest",
      "print-external-env",
      "done",
    ]);
    expect(s.find((x) => x.kind === "deploy")).toEqual({ kind: "deploy", secrets: ["CONTROL_TOKEN"] });
    expect(s.find((x) => x.kind === "scaffold")).toEqual({ kind: "scaffold", mode: "external" });
  });
  it("uses the given provider name in the final command", () => {
    expect(plan(opts({ mode: "external", providerName: "my-orbs" }), probes()).at(-1)).toEqual({
      kind: "done",
      command: helloCommand("my-orbs"),
    });
  });
});
