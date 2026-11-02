import { describe, expect, it } from "vitest";
import { AMP_DEFAULT_IMAGE_REPO, DEFAULT_CONFIG, type ProviderConfig } from "../src/core/types";
import { parseImageRef, resolveImageKey } from "../src/orb/images";

const images = {
  orb: "registry.cloudflare.com/acct/cf-orbs-orb@sha256:aa",
  py: "registry.cloudflare.com/acct/py@sha256:bb",
};
const cfg: ProviderConfig = {
  ...DEFAULT_CONFIG,
  images: { "ghcr.io/me/py:3.12": "py", "ghcr.io/me/gone:1": "gone" },
};

describe("resolveImageKey (D5)", () => {
  it("no ORB_IMAGE → orb", () => {
    expect(resolveImageKey(undefined, cfg, images)).toEqual({ key: "orb" });
    expect(resolveImageKey("", cfg, images)).toEqual({ key: "orb" });
  });

  it("default Amp repo with any tag → orb, no note", () => {
    expect(resolveImageKey(`${AMP_DEFAULT_IMAGE_REPO}:latest`, cfg, images)).toEqual({ key: "orb" });
    expect(resolveImageKey(`${AMP_DEFAULT_IMAGE_REPO}:v123`, cfg, images)).toEqual({ key: "orb" });
    expect(resolveImageKey(AMP_DEFAULT_IMAGE_REPO, cfg, images)).toEqual({ key: "orb" });
  });

  it("default repo at the pinned digest → orb, no note", () => {
    expect(resolveImageKey(`${AMP_DEFAULT_IMAGE_REPO}@${cfg.ampImageDigest}`, cfg, images)).toEqual({
      key: "orb",
    });
  });

  it("default repo at another digest → orb with a note", () => {
    const r = resolveImageKey(`${AMP_DEFAULT_IMAGE_REPO}:latest@sha256:${"1".repeat(64)}`, cfg, images);
    expect(r).toMatchObject({ key: "orb" });
    expect("note" in r && r.note).toMatch(/differs from the pinned/);
  });

  it("mapped custom ref → its key", () => {
    expect(resolveImageKey("ghcr.io/me/py:3.12", cfg, images)).toEqual({ key: "py" });
  });

  it("mapped ref whose key is not deployed → error", () => {
    expect(resolveImageKey("ghcr.io/me/gone:1", cfg, images)).toEqual({
      error:
        'Failed: image ghcr.io/me/gone:1 is not registered — fix: add it to cf-orbs.config.jsonc "images" and run cf-orbs deploy',
    });
  });

  it("unknown ref → exact error text", () => {
    expect(resolveImageKey("docker.io/library/ubuntu:24.04", cfg, images)).toEqual({
      error:
        'Failed: image docker.io/library/ubuntu:24.04 is not registered — fix: add it to cf-orbs.config.jsonc "images" and run cf-orbs deploy',
    });
  });

  it("a lookalike repo is not the Amp image", () => {
    expect(resolveImageKey(`${AMP_DEFAULT_IMAGE_REPO}-evil:latest`, cfg, images)).toHaveProperty("error");
  });

  it("parses registry ports, tags and digests", () => {
    expect(parseImageRef("localhost:5000/a/b:1@sha256:x")).toEqual({
      repo: "localhost:5000/a/b",
      tag: "1",
      digest: "sha256:x",
    });
    expect(parseImageRef("localhost:5000/a/b")).toEqual({
      repo: "localhost:5000/a/b",
      tag: undefined,
      digest: undefined,
    });
  });
});
