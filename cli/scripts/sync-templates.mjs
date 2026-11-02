#!/usr/bin/env node
// Copy the Worker source, Dockerfiles and dispatch.sh into cli/templates/ so the npm package can scaffold projects.
// Usage: node scripts/sync-templates.mjs [--strict]   (--strict fails when a source is missing; used by prepack)
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { absoluteLinks } from "./readme-links.mjs";

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(cli, "..");
const out = join(cli, "templates");
const strict = process.argv.includes("--strict");

// [source relative to repo root, destination relative to templates/, required file that proves the source is complete]
const SOURCES = [
  ["worker/src", "worker/src", "index.ts"],
  ["image", "image", "Dockerfile"],
  ["provider", "provider", "Dockerfile"],
  ["dispatch", "dispatch", "dispatch.sh"],
];

const skip = (src) => {
  const b = basename(src);
  return b === "node_modules" || b === "test" || b === ".wrangler" || /\.test\.[cm]?[jt]s$/.test(b);
};

let missing = 0;
for (const [from, to, proof] of SOURCES) {
  const src = join(root, from);
  const dst = join(out, to);
  await rm(dst, { recursive: true, force: true });
  if (!existsSync(join(src, proof))) {
    missing++;
    process.stderr.write(`sync-templates: ${from}/${proof} not found${strict ? "" : " (skipped)"}\n`);
    if (!existsSync(src)) continue;
  }
  await mkdir(dirname(dst), { recursive: true });
  await cp(src, dst, { recursive: true, filter: (s) => !skip(s) });
}
// The npm page shows cli/README.md: keep it a copy of the repo README. Relative links do not resolve on
// npmjs.com, so point them at the file on GitHub. In-page anchors (#...) and absolute URLs stay as they are.
const readme = join(root, "README.md");
if (existsSync(readme)) {
  const text = await readFile(readme, "utf8");
  await writeFile(join(cli, "README.md"), absoluteLinks(text));
}
const example = join(root, "cf-orbs.config.example.jsonc");
if (existsSync(example)) await cp(example, join(out, "cf-orbs.config.example.jsonc"));

if (strict && missing > 0) {
  process.stderr.write(
    "Failed: templates incomplete — fix: build the worker, image, provider and dispatch modules first\n",
  );
  process.exit(1);
}
process.stderr.write(`sync-templates: wrote ${out}\n`);
