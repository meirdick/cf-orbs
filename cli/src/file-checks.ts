// Checks on the project files: image pins, debugExec, secrets in tracked files, git mode files.
// Used by doctor (all modes) and by init --no-deploy before its first commit. Read-only.
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Check } from "./commands/doctor.js";
import { type CfOrbsConfig, CONFIG_FILE } from "./config.js";
import { CliError, toFailedLine } from "./errors.js";
import { type ProjectPaths, readControlToken, templatesDir } from "./project.js";
import { type Runner, WRANGLER_PIN } from "./wrangler.js";

const pass = (name: string, detail: string): Check => ({ name, status: "PASS", detail });
const failed = (name: string, e: CliError): Check => ({ name, status: "FAIL", detail: toFailedLine(e) });
const skip = (name: string, detail: string): Check => ({ name, status: "SKIP", detail });

const DIGEST_REF = /@sha256:[0-9a-f]{64}$/;

/** Base image refs in a Dockerfile that have no @sha256 digest. Earlier stage names and scratch are fine. */
export function unpinnedFroms(dockerfile: string): string[] {
  const stages = new Set<string>(["scratch"]);
  const out: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = /^\s*FROM\s+(.+)$/i.exec(line);
    if (!m) continue;
    const words = (m[1] as string).trim().split(/\s+/);
    const ref = words.find((w) => !w.startsWith("--"));
    if (!ref) continue;
    const known = stages.has(ref.toLowerCase());
    const as = words.findIndex((w) => w.toLowerCase() === "as");
    if (as !== -1 && words[as + 1]) stages.add((words[as + 1] as string).toLowerCase());
    if (!known && !DIGEST_REF.test(ref)) out.push(ref);
  }
  return out;
}

/** "<repo>@sha256:0123456789ab" for a PASS line. */
function shortRefs(dockerfile: string): string {
  const refs = [...dockerfile.matchAll(/^\s*FROM\s+(?:--\S+\s+)*(\S+)/gim)].map((m) =>
    (m[1] as string).replace(/@sha256:([0-9a-f]{12})[0-9a-f]{52}$/, "@sha256:$1…"),
  );
  return refs.join(", ");
}

async function pinCheck(name: string, file: string, label: string, fix: string): Promise<Check> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return failed(name, new CliError(`${label} not found`, "run cf-orbs init in this directory"));
  }
  const bad = unpinnedFroms(text);
  if (bad.length > 0)
    return failed(name, new CliError(`${label} FROM ${bad.join(", ")} has no @sha256 digest`, fix));
  return pass(name, `${label} FROM ${shortRefs(text)} (by digest)`);
}

/** image/Dockerfile and the Dockerfile of every extra image key: each FROM is pinned by digest. */
export async function orbImagePinCheck(p: ProjectPaths, c?: CfOrbsConfig): Promise<Check> {
  const keys = [...new Set(Object.values(c?.images ?? {}))];
  const files = [
    ["image/Dockerfile", p.imageDockerfile],
    ...keys.map((k) => [`image/${k}.Dockerfile`, join(p.imageDir, `${k}.Dockerfile`)]),
  ] as const;
  const fix =
    "pin the base image as <image>@sha256:<digest> (for the Amp image: cf-orbs upgrade --digest sha256:<hex>)";
  let first: Check | undefined;
  let extra = 0;
  for (const [label, file] of files) {
    if (label !== "image/Dockerfile" && !existsSync(file)) continue; // deploy reports a missing one
    const c1 = await pinCheck("orb image pin", file, label, fix);
    if (c1.status === "FAIL") return c1;
    if (first) extra++;
    first ??= c1;
  }
  return extra > 0 && first
    ? { ...first, detail: `${first.detail}; ${extra} extra image key(s) pinned too` }
    : (first as Check);
}

/** The provider image cf-orbs builds: the project copy (.cf-orbs/provider) if there is one, else the template. */
export async function providerImagePinCheck(p: ProjectPaths, templates = templatesDir()): Promise<Check> {
  const copy = join(p.stateDir, "provider", "Dockerfile");
  const [file, label] = existsSync(copy)
    ? [copy, ".cf-orbs/provider/Dockerfile"]
    : [join(templates, "provider", "Dockerfile"), "provider/Dockerfile (CLI template)"];
  return pinCheck(
    "provider image pin",
    file,
    label,
    "reinstall cf-orbs (the provider image is a CLI template), then cf-orbs deploy",
  );
}

/** debugExec lets the control token run commands in orbs. WARN, never FAIL: the substrate bench needs it. */
export function debugExecCheck(c: CfOrbsConfig | undefined, git: boolean): Check {
  if (!c) return skip("debugExec", "needs a valid config");
  if (!c.debugExec) return pass("debugExec", "false (the control token cannot run commands in orbs)");
  const then = git ? "commit and push" : "run cf-orbs deploy";
  return {
    name: "debugExec",
    status: "WARN",
    detail: toFailedLine(
      new CliError(
        "debugExec is true: whoever has the control token can run any command in any orb",
        `set "debugExec": false in ${CONFIG_FILE}, then ${then} (keep it on only for the substrate bench)`,
      ),
    ),
  };
}

const AOP_TOKEN = /aop_live_[A-Za-z0-9_-]{8,}/;
const MAX_SCAN_BYTES = 10_000_000;

/**
 * Files (relative to dir) that hold an Amp provider token or one of the given secret values.
 * Never returns the values. Skips files over 10 MB.
 */
export async function filesWithSecrets(dir: string, files: string[], values: string[]): Promise<string[]> {
  const hits: string[] = [];
  const vals = values.filter((v) => v.length >= 8);
  for (const f of files) {
    const path = join(dir, f);
    try {
      if ((await stat(path)).size > MAX_SCAN_BYTES) continue;
      const text = await readFile(path, "latin1");
      if (AOP_TOKEN.test(text) || vals.some((v) => text.includes(v))) hits.push(f);
    } catch {}
  }
  return hits;
}

/** `git ls-files` of dir, or undefined when dir is not in a git work tree (or git is missing). */
export async function gitTrackedFiles(run: Runner, dir: string): Promise<string[] | undefined> {
  const r = await run("git", ["-C", dir, "ls-files", "-z"], { timeoutMs: 30_000 });
  if (r.code !== 0) return undefined;
  return r.stdout.split("\0").filter(Boolean);
}

/** No aop_live_ token and no control token value in a file git tracks. SKIP outside a git work tree. */
export async function trackedSecretsCheck(
  run: Runner,
  p: ProjectPaths,
  extra: string[] = [],
): Promise<Check> {
  const name = "secrets in git";
  const files = await gitTrackedFiles(run, p.dir);
  if (!files) return skip(name, "not a git repository");
  const ct = await readControlToken(p);
  const hits = await filesWithSecrets(p.dir, files, [...(ct ? [ct] : []), ...extra]);
  if (hits.length === 0) return pass(name, `${files.length} tracked file(s), no aop_live_ or control token`);
  return failed(
    name,
    new CliError(
      `a token is in tracked file(s): ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? ", …" : ""}`,
      "git rm --cached those files (or remove the token), make a new token, and purge it from history if you pushed",
    ),
  );
}

/** Git mode: .cf-orbs/control-token and .cf-orbs/state.json are ignored and not tracked. */
export async function gitignoreCheck(run: Runner, p: ProjectPaths): Promise<Check> {
  const name = "gitignore";
  const paths = [".cf-orbs/control-token", ".cf-orbs/state.json"];
  const notIgnored: string[] = [];
  for (const f of paths) {
    // exit 0: ignored; 1: not ignored or tracked; 128: no repo. Fall back to the .gitignore lines then.
    const r = await run("git", ["-C", p.dir, "check-ignore", "-q", f], { timeoutMs: 30_000 });
    if (r.code === 0) continue;
    if (r.code === 1) {
      notIgnored.push(f);
      continue;
    }
    let lines: string[] = [];
    try {
      lines = (await readFile(p.gitignore, "utf8")).split(/\r?\n/).map((l) => l.trim());
    } catch {}
    if (!lines.includes(f)) notIgnored.push(f);
  }
  if (notIgnored.length === 0) return pass(name, `${paths.join(" and ")} are ignored`);
  return failed(
    name,
    new CliError(
      `${notIgnored.join(" and ")} not ignored by git (or tracked)`,
      `add ${notIgnored.join(" and ")} to .gitignore and run git rm --cached on any that git tracks`,
    ),
  );
}

/** Git mode: package.json pins the wrangler version the CLI uses (Workers Builds installs that one). */
export async function wranglerPinCheck(p: ProjectPaths): Promise<Check> {
  const name = "wrangler pin";
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(p.packageJson, "utf8"));
  } catch {
    return failed(
      name,
      new CliError(
        "package.json is missing or not valid JSON",
        "rerun cf-orbs init --no-deploy (it writes one)",
      ),
    );
  }
  const v = pkg.devDependencies?.wrangler ?? pkg.dependencies?.wrangler;
  if (v === WRANGLER_PIN) return pass(name, `package.json pins wrangler ${v}, same as cf-orbs`);
  return failed(
    name,
    new CliError(
      `package.json ${v ? `pins wrangler ${v}` : "has no wrangler dependency"}; cf-orbs uses ${WRANGLER_PIN}`,
      `set devDependencies.wrangler to "${WRANGLER_PIN}", run npm install, commit and push`,
    ),
  );
}

/** All file checks for doctor, in output order. git: state.mode is "git". */
export async function fileChecks(
  run: Runner,
  p: ProjectPaths,
  c: CfOrbsConfig | undefined,
  o: { git: boolean; templates?: string },
): Promise<Check[]> {
  const out = [
    await orbImagePinCheck(p, c),
    await providerImagePinCheck(p, o.templates),
    debugExecCheck(c, o.git),
    await trackedSecretsCheck(run, p),
  ];
  if (o.git) out.push(await gitignoreCheck(run, p), await wranglerPinCheck(p));
  return out;
}
