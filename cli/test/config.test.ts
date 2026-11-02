import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig as workerParseConfig } from "../../worker/src/core/config";
import {
  DEFAULT_CONFIG as WORKER_DEFAULT,
  AMP_DEFAULT_IMAGE_REPO as WORKER_REPO,
} from "../../worker/src/core/types";
import {
  AMP_DEFAULT_IMAGE_REPO,
  DEFAULT_CLI_CONFIG,
  DEFAULT_CONFIG,
  defaultConfigText,
  findTopLevelValue,
  orbImageKeys,
  parseConfigText,
  parseJsonc,
  setTopLevelJsonc,
  stripJsonc,
  validateConfig,
  workerConfigJson,
} from "../src/config";

describe("defaults", () => {
  it("DEFAULT_CONFIG equals the worker's DEFAULT_CONFIG", () => {
    expect(DEFAULT_CONFIG).toStrictEqual(WORKER_DEFAULT);
    expect(AMP_DEFAULT_IMAGE_REPO).toBe(WORKER_REPO);
  });
  it("an empty config file gives the defaults", () => {
    expect(parseConfigText("{}")).toStrictEqual(DEFAULT_CLI_CONFIG);
    expect(parseConfigText("// only a comment\n{ }\n")).toStrictEqual(DEFAULT_CLI_CONFIG);
  });
  it("the root example and the generated starter both parse to the defaults", () => {
    const example = readFileSync(new URL("../../cf-orbs.config.example.jsonc", import.meta.url), "utf8");
    expect(parseConfigText(example)).toStrictEqual(DEFAULT_CLI_CONFIG);
    expect(parseConfigText(defaultConfigText())).toStrictEqual(DEFAULT_CLI_CONFIG);
  });
});

describe("JSONC", () => {
  it("strips comments and trailing commas but keeps // and /* inside strings", () => {
    const t = `{
      // line
      "a": "http://x/*not a comment*/", /* block */
      "b": [1, 2,],
      "c": "say \\"hi\\" // still string",
    }`;
    expect(JSON.parse(stripJsonc(t))).toEqual({
      a: "http://x/*not a comment*/",
      b: [1, 2],
      c: 'say "hi" // still string',
    });
  });
  it("reports syntax errors as one Failed line", () => {
    expect(() => parseJsonc("{ a: 1 }")).toThrow(
      /^Failed: cf-orbs.config.jsonc is not valid JSONC .* — fix: /,
    );
  });
  it("setTopLevelJsonc replaces a value and keeps comments", () => {
    const t = `{\n  // keep me\n  "images": {}, // and me\n  "maxRunning": 20\n}\n`;
    const out = setTopLevelJsonc(t, "images", { a: "b" });
    expect(out).toContain("// keep me");
    expect(out).toContain("// and me");
    expect(parseJsonc(out)).toEqual({ images: { a: "b" }, maxRunning: 20 });
  });
  it("setTopLevelJsonc inserts a missing key after a trailing line comment", () => {
    const t = `{\n  "maxRunning": 20 // cap\n}\n`;
    const out = setTopLevelJsonc(t, "ampImageDigest", "sha256:x");
    expect(parseJsonc(out)).toEqual({ maxRunning: 20, ampImageDigest: "sha256:x" });
    expect(out).toContain("// cap");
  });
  it("setTopLevelJsonc inserts into an empty object", () => {
    expect(parseJsonc(setTopLevelJsonc("{}", "a", 1))).toEqual({ a: 1 });
  });
  it("findTopLevelValue ignores nested keys of the same name", () => {
    const t = `{"x": {"images": 1}, "images": {"k": "v"}}`;
    const span = findTopLevelValue(t, "images");
    expect(span && t.slice(span.start, span.end)).toBe(`{"k": "v"}`);
  });
});

describe("validation", () => {
  const bad: [string, unknown, RegExp][] = [
    [
      "vcpu 5",
      { instance: { vcpu: 5, memoryMib: 12288, diskMb: 20000 } },
      /instance.vcpu must be a number from 1 to 4/,
    ],
    [
      "13 GiB",
      { instance: { vcpu: 4, memoryMib: 13312, diskMb: 20000 } },
      /instance.memoryMib must be an integer from 1 to 12288/,
    ],
    [
      "disk 25 GB",
      { instance: { vcpu: 2, memoryMib: 6144, diskMb: 25000 } },
      /instance.diskMb must be an integer from 8000 to 20000/,
    ],
    ["< 3 GiB/vCPU", { instance: { vcpu: 2, memoryMib: 4096, diskMb: 20000 } }, /below 3 GiB per vCPU/],
    ["lite", { instance: "lite" }, /too small/],
    ["basic", { instance: "basic" }, /too small/],
    ["unknown type", { instance: "standard-9" }, /unknown instance/],
    ["checkpoint 10", { checkpointMinutes: 10 }, /0 \(off\) or at least 15/],
    ["warm 121", { warmMinutes: 121 }, /warmMinutes must be an integer from 0 to 120/],
    ["warm -1", { warmMinutes: -1 }, /warmMinutes must be an integer from 0 to 120/],
    ["hugePages string", { hugePages: "on" }, /hugePages must be true or false/],
    ["prewarm 6", { prewarm: 6 }, /prewarm must be an integer from 0 to 5/],
    ["prewarm -1", { prewarm: -1 }, /prewarm must be an integer from 0 to 5/],
    ["prewarm 1.5", { prewarm: 1.5 }, /prewarm must be an integer from 0 to 5/],
    [
      "projectSnapshotRefresh unknown",
      { projectSnapshotRefresh: "always" },
      /projectSnapshotRefresh must be "off" or "on-change", got "always"/,
    ],
    ["fastTmpfsGb 9", { fastTmpfsGb: 9 }, /fastTmpfsGb must be an integer from 0 to 8/],
    [
      "fastTmpfsGb > memory - 3",
      { instance: { vcpu: 2, memoryMib: 6144, diskMb: 20000 }, fastTmpfsGb: 4 },
      /fastTmpfsGb 4 leaves less than 3 GiB of the orb's 6 GiB memory/,
    ],
    ["fastTmpfsGb on standard-1", { instance: "standard-1", fastTmpfsGb: 2 }, /set fastTmpfsGb to 1 or less/],
    ["providerHost", { providerHost: "fly" }, /providerHost must be/],
    ["typo key", { maxRuning: 3 }, /unknown key "maxRuning"/],
    ["bad image key", { images: { "x/y:1": "Bad Key" } }, /must be an image key/],
    ["reserved image key", { images: { "x/y:1": "provider" } }, /reserved/],
    ["bad digest", { ampImageDigest: "sha256:abc" }, /ampImageDigest/],
    ["bad name", { name: "CF Orbs" }, /name must be/],
    ["alarm vs inactivity", { alarmSeconds: 900, inactivityTimeoutMinutes: 15 }, /must be shorter/],
  ];
  for (const [label, raw, re] of bad) {
    it(`rejects ${label} with a one-line Failed/fix message`, () => {
      expect(() => validateConfig(raw)).toThrow(re);
      try {
        validateConfig(raw);
      } catch (e) {
        expect((e as Error).message).toMatch(/^Failed: [^\n]+ — fix: [^\n]+$/);
      }
    });
  }
  it("accepts named and edge custom instances", () => {
    expect(validateConfig({ instance: "standard-1" }).instance).toBe("standard-1");
    expect(validateConfig({ instance: { vcpu: 4, memoryMib: 12288, diskMb: 20000 } }).instance).toEqual({
      vcpu: 4,
      memoryMib: 12288,
      diskMb: 20000,
    });
    expect(validateConfig({ instance: { vcpu: 1, memoryMib: 3072, diskMb: 8000 } }).instance).toEqual({
      vcpu: 1,
      memoryMib: 3072,
      diskMb: 8000,
    });
  });
  it("agrees with the worker's parseConfig on the provider fields", () => {
    const cases: unknown[] = [
      {},
      { instance: "standard-3", maxRunning: 5, checkpointMinutes: 30, images: { "r/x:1": "x" } },
      { instance: { vcpu: 2, memoryMib: 4096, diskMb: 20000 } },
      { instance: "lite" },
      { checkpointMinutes: 5 },
      { alarmSeconds: 900 },
      { warmMinutes: 0 },
      { warmMinutes: 30 },
      { warmMinutes: 500 },
      { hugePages: false, fastTmpfsGb: 8 },
      { instance: "standard-3", fastTmpfsGb: 5 },
      { instance: "standard-3", fastTmpfsGb: 6 },
      { instance: { vcpu: 1, memoryMib: 3072, diskMb: 8000 }, fastTmpfsGb: 1 },
      { hugePages: 1 },
      { prewarm: 0 },
      { prewarm: 5 },
      { prewarm: 6 },
      { prewarm: "2" },
      { projectSnapshotRefresh: "off" },
      { projectSnapshotRefresh: "on-change" },
      { projectSnapshotRefresh: "always" },
      { projectSnapshotRefresh: true },
      { projectSnapshotRefresh: null },
    ];
    for (const raw of cases) {
      let cli: unknown;
      let worker: unknown;
      try {
        cli = JSON.parse(workerConfigJson(validateConfig(raw)));
      } catch {
        cli = "error";
      }
      try {
        worker = workerParseConfig(JSON.stringify(raw));
      } catch {
        worker = "error";
      }
      if (cli === "error" || worker === "error") expect(cli).toBe(worker);
      else expect(worker).toEqual(workerParseConfig(JSON.stringify(cli)));
    }
  });
  it("workerConfigJson drops CLI-only fields name and debugSsh, keeps providerHost", () => {
    const j = JSON.parse(workerConfigJson(DEFAULT_CLI_CONFIG));
    expect(j.name).toBeUndefined();
    expect(j.debugSsh).toBeUndefined();
    expect(j.providerHost).toBe("cloudflare");
    expect(j.instance).toEqual(DEFAULT_CONFIG.instance);
  });
  it("orbImageKeys is orb plus distinct image values", () => {
    expect(orbImageKeys(validateConfig({ images: { a: "k1", b: "k1", c: "k2" } }))).toEqual([
      "orb",
      "k1",
      "k2",
    ]);
  });
});
