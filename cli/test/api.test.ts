import { describe, expect, it } from "vitest";
import { expectOk } from "../src/api";

describe("expectOk", () => {
  it("keeps a Worker Failed line as one cause and its own fix", () => {
    const body = {
      error:
        "Failed: AMP_ORB_PROVIDER_TOKEN is not set, so the provider runs outside Cloudflare (external mode) — fix: start your external provider, or set AMP_ORB_PROVIDER_TOKEN and run cf-orbs init --provider cloudflare",
    };
    expect(() => expectOk({ status: 409, body, text: JSON.stringify(body) }, "provider start")).toThrow(
      "Failed: provider start: AMP_ORB_PROVIDER_TOKEN is not set, so the provider runs outside Cloudflare (external mode) (HTTP 409) — fix: start your external provider, or set AMP_ORB_PROVIDER_TOKEN and run cf-orbs init --provider cloudflare",
    );
  });
  it("wraps a plain error with the doctor fix", () => {
    expect(() => expectOk({ status: 500, body: { error: "boom" }, text: "" }, "status")).toThrow(
      "Failed: status: HTTP 500 boom — fix: run cf-orbs doctor",
    );
  });
  it("one prefix and one fix only", () => {
    try {
      expectOk({ status: 400, body: { error: "Failed: a — fix: b" }, text: "" }, "x");
    } catch (e) {
      const m = (e as Error).message;
      expect(m.match(/Failed:/g)).toHaveLength(1);
      expect(m.match(/— fix:/g)).toHaveLength(1);
    }
  });
});
