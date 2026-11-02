import { describe, expect, it } from "vitest";
import { type FlagSpec, flagBool, flagString, parseArgs } from "../src/args";
import { findCommand, helpText } from "../src/index";

const spec: FlagSpec = {
  json: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  dir: { type: "string" },
  lines: { type: "string" },
  "no-deploy": { type: "boolean" },
};

describe("parseArgs", () => {
  it("parses positionals, booleans, --k v and --k=v", () => {
    const p = parseArgs(["status", "orb-1", "--json", "--dir", "/x", "--lines=5"], spec);
    expect(p.positionals).toEqual(["status", "orb-1"]);
    expect(flagBool(p, "json")).toBe(true);
    expect(flagString(p, "dir")).toBe("/x");
    expect(flagString(p, "lines")).toBe("5");
  });
  it("supports short flags, --no-<bool>, explicit --no-deploy and --", () => {
    const p = parseArgs(["-y", "--no-json", "--no-deploy", "--", "--not-a-flag"], spec);
    expect(flagBool(p, "yes")).toBe(true);
    expect(p.flags.json).toBe(false);
    expect(flagBool(p, "no-deploy")).toBe(true);
    expect(p.positionals).toEqual(["--not-a-flag"]);
  });
  it("rejects unknown flags, missing values and values on booleans with Failed/fix text", () => {
    expect(() => parseArgs(["--nope"], spec)).toThrow(
      /^Failed: unknown flag --nope — fix: run cf-orbs --help$/,
    );
    expect(() => parseArgs(["--dir"], spec)).toThrow(/--dir needs a value/);
    expect(() => parseArgs(["--dir", "--json"], spec)).toThrow(/--dir needs a value/);
    expect(() => parseArgs(["--json=maybe"], spec)).toThrow(/takes no value/);
    expect(() => parseArgs(["-q"], spec)).toThrow(/unknown flag -q/);
  });
});

describe("command detection and help", () => {
  it("skips values of global string flags", () => {
    expect(findCommand(["--dir", "proj", "status"])).toBe("status");
    expect(findCommand(["--url=https://x", "doctor"])).toBe("doctor");
    expect(findCommand(["--json"])).toBeUndefined();
  });
  it("help lists every command", () => {
    const h = helpText("0.1.0");
    for (const c of ["init", "deploy", "status", "logs", "doctor", "upgrade", "uninstall", "bench"])
      expect(h).toContain(`  ${c}`);
  });
});
