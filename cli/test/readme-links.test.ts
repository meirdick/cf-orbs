import { describe, expect, it } from "vitest";
import { absoluteLinks, BLOB } from "../scripts/readme-links.mjs";

describe("absoluteLinks (npm page README)", () => {
  it("points relative links at GitHub and keeps anchors", () => {
    expect(absoluteLinks("[a](AGENTS.md) [b](docs/architecture.md#parts) [c](./SECURITY.md)")).toBe(
      `[a](${BLOB}AGENTS.md) [b](${BLOB}docs/architecture.md#parts) [c](${BLOB}SECURITY.md)`,
    );
  });
  it("keeps absolute URLs, mailto, in-page anchors and root paths", () => {
    const s = "[x](https://example.com/a) [m](mailto:a@example.com) [h](#quick-start) [r](/abs)";
    expect(absoluteLinks(s)).toBe(s);
  });
});
