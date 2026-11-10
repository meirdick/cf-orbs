// Project layout. The CLI ships the Worker source, Dockerfiles and dispatch.sh under cli/templates/ (copied at build
// time by scripts/sync-templates.mjs). init/deploy copy them into <dir>/.cf-orbs/ and generate wrangler.jsonc there,
// so users never edit Worker code.
//
// <dir>/
//   cf-orbs.config.jsonc     user config (source of truth)
//   image/Dockerfile         orb image, user-editable; upgrade bumps its digest; image/<key>.Dockerfile for extra keys
//   .gitignore               generated; keeps .cf-orbs/ (and its control-token) out of git
//                            (git mode: only control-token and state.json; Workers Builds needs the rest)
//   package.json             git mode only: pins wrangler for Workers Builds
//   .cf-orbs/
//     wrangler.jsonc         generated
//     worker/src/**          copied from templates on every deploy
//     provider/**, dispatch/**  copied from templates on every deploy
//     state.json             {url, accountId, providerName, mode, workerName}; never tokens
//     control-token          CONTROL_TOKEN, mode 0600
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CfOrbsConfig, CONFIG_FILE, defaultConfigText, setTopLevelJsonc } from "./config.js";
import { CliError, registerSecret } from "./errors.js";
import { renderWranglerJsonc } from "./wrangler-template.js";

export const STATE_DIR = ".cf-orbs";

export interface ProjectPaths {
  dir: string;
  config: string;
  imageDir: string;
  imageDockerfile: string;
  stateDir: string;
  wrangler: string;
  state: string;
  controlToken: string;
  gitignore: string;
  /** git mode: root package.json that pins wrangler for Workers Builds */
  packageJson: string;
}

export function projectPaths(dir: string): ProjectPaths {
  const d = resolve(dir);
  const s = join(d, STATE_DIR);
  return {
    dir: d,
    config: join(d, CONFIG_FILE),
    imageDir: join(d, "image"),
    imageDockerfile: join(d, "image", "Dockerfile"),
    stateDir: s,
    wrangler: join(s, "wrangler.jsonc"),
    state: join(s, "state.json"),
    controlToken: join(s, "control-token"),
    gitignore: join(d, ".gitignore"),
    packageJson: join(d, "package.json"),
  };
}

/** cli/templates, resolved from this file (works from src/ under vitest and from dist/ when installed). */
export function templatesDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates");
}

export interface State {
  url?: string;
  accountId?: string;
  providerName?: string;
  /**
   * Provider host of the last init or deploy, or "git": init --no-deploy, Workers Builds deploys from a repo
   * (the provider host is then cloudflare).
   */
  mode?: "cloudflare" | "external" | "git";
  workerName?: string;
  deployedAt?: string;
  cliVersion?: string;
}

export async function readState(p: ProjectPaths): Promise<State> {
  try {
    return JSON.parse(await readFile(p.state, "utf8")) as State;
  } catch {
    return {};
  }
}

export async function writeState(p: ProjectPaths, s: State): Promise<void> {
  await mkdir(p.stateDir, { recursive: true });
  // whitelist fields so a token can never land here by accident
  const clean: State = {
    url: s.url,
    accountId: s.accountId,
    providerName: s.providerName,
    mode: s.mode,
    workerName: s.workerName,
    deployedAt: s.deployedAt,
    cliVersion: s.cliVersion,
  };
  await writeFile(p.state, `${JSON.stringify(clean, null, 2)}\n`);
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export async function readControlToken(p: ProjectPaths): Promise<string | undefined> {
  try {
    const t = (await readFile(p.controlToken, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(t)) return undefined;
    registerSecret(t);
    return t;
  } catch {
    return undefined;
  }
}

export async function requireControlToken(p: ProjectPaths): Promise<string> {
  const t = await readControlToken(p);
  if (!t) throw new CliError(`no control token in ${p.controlToken}`, "run cf-orbs init in this directory");
  return t;
}

export async function writeControlToken(p: ProjectPaths, token: string): Promise<void> {
  await mkdir(p.stateDir, { recursive: true });
  await writeFile(p.controlToken, `${token}\n`, { mode: 0o600 });
  await chmod(p.controlToken, 0o600); // writeFile mode is ignored when the file already exists
  registerSecret(token);
}

export async function fileMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}

export const GITIGNORE_LINES = [
  ".cf-orbs/*",
  "!.cf-orbs/state.json",
  ".cf-orbs/control-token",
  ".wrangler/",
  "node_modules/",
];

/** Git mode (init --no-deploy): the generated files are committed, so only these stay out of git. */
export const GIT_MODE_GITIGNORE_LINES = [
  ".cf-orbs/control-token",
  ".cf-orbs/state.json",
  ".wrangler/",
  "node_modules/",
];

/** Lines of the local layout that hide the generated files. Git mode removes them. */
const LOCAL_ONLY_LINES = new Set([".cf-orbs/*", "!.cf-orbs/state.json"]);

/** Add the cf-orbs lines to <dir>/.gitignore, keeping existing lines. */
export async function ensureGitignore(p: ProjectPaths, git = false): Promise<void> {
  let cur = "";
  try {
    cur = await readFile(p.gitignore, "utf8");
  } catch {}
  if (git && cur.split(/\r?\n/).some((l) => LOCAL_ONLY_LINES.has(l.trim()))) {
    cur = cur
      .split(/(?<=\n)/)
      .filter((l) => !LOCAL_ONLY_LINES.has(l.trim()))
      .join("");
    await writeFile(p.gitignore, cur);
  }
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const add = (git ? GIT_MODE_GITIGNORE_LINES : GITIGNORE_LINES).filter((l) => !have.has(l));
  if (add.length === 0) return;
  const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
  const header = cur.includes("# cf-orbs") ? "" : "# cf-orbs (generated)\n";
  await writeFile(p.gitignore, `${cur}${sep}${header}${add.join("\n")}\n`);
}

const COPIED = ["worker", "provider", "dispatch"] as const;

/**
 * Write the project files. User-owned files (config, image/Dockerfile) are written only when missing.
 * Generated files (.cf-orbs/worker, provider, dispatch) are replaced every time.
 */
export async function materialize(
  p: ProjectPaths,
  opts: { templates?: string; configOverrides?: Partial<CfOrbsConfig>; git?: boolean } = {},
): Promise<{ wroteConfig: boolean; wroteDockerfile: boolean }> {
  const t = opts.templates ?? templatesDir();
  if (!existsSync(join(t, "worker", "src", "index.ts"))) {
    throw new CliError(
      `CLI templates missing at ${t}`,
      "reinstall cf-orbs, or run npm run build -w cli in a source checkout",
    );
  }
  await mkdir(p.stateDir, { recursive: true });
  for (const sub of COPIED) {
    const dst = join(p.stateDir, sub);
    await rm(dst, { recursive: true, force: true });
    if (existsSync(join(t, sub))) await cp(join(t, sub), dst, { recursive: true });
  }
  let wroteDockerfile = false;
  if (!existsSync(p.imageDockerfile)) {
    const src = join(t, "image", "Dockerfile");
    if (!existsSync(src)) throw new CliError(`orb image template missing at ${src}`, "reinstall cf-orbs");
    await mkdir(p.imageDir, { recursive: true });
    await cp(src, p.imageDockerfile);
    wroteDockerfile = true;
  }
  let wroteConfig = false;
  if (!existsSync(p.config)) {
    const example = join(t, "cf-orbs.config.example.jsonc");
    let text = existsSync(example) ? await readFile(example, "utf8") : defaultConfigText();
    for (const [k, v] of Object.entries(opts.configOverrides ?? {})) text = setTopLevelJsonc(text, k, v);
    await writeFile(p.config, text);
    wroteConfig = true;
  }
  await ensureGitignore(p, opts.git);
  return { wroteConfig, wroteDockerfile };
}

/** The files the provider image is built from, relative to .cf-orbs/ (its build context). */
export const PROVIDER_BUILD_FILES = ["provider/Dockerfile", "provider/entry.sh", "dispatch/dispatch.sh"];

/**
 * First 16 hex of sha256 over the provider image inputs and the provider container size (providerInstance),
 * so a deploy that changes the size restarts a running provider. deploy writes it to the Worker as
 * CF_ORBS_PROVIDER_BUILD; ProviderHost restarts its container when it changes. A missing file hashes as empty.
 */
export async function providerBuild(p: ProjectPaths, instance = "lite"): Promise<string> {
  const h = createHash("sha256");
  for (const f of PROVIDER_BUILD_FILES) {
    const file = join(p.stateDir, f);
    h.update(`${f}\0`);
    h.update(existsSync(file) ? await readFile(file) : "");
    h.update("\0");
  }
  h.update(`instance\0${instance}\0`);
  return h.digest("hex").slice(0, 16);
}

/** Writes wrangler.jsonc after materialize(). Returns the provider build it wrote. */
export async function writeWranglerConfig(
  p: ProjectPaths,
  c: CfOrbsConfig,
  accountId?: string,
): Promise<string> {
  await mkdir(p.stateDir, { recursive: true });
  const build = await providerBuild(p, c.providerInstance);
  await writeFile(p.wrangler, renderWranglerJsonc(c, { accountId, providerBuild: build }));
  return build;
}

/** Check that every extra image key has its Dockerfile, so wrangler does not fail mid-deploy. */
export function missingDockerfiles(p: ProjectPaths, c: CfOrbsConfig): string[] {
  return [...new Set(Object.values(c.images))]
    .map((k) => join(p.imageDir, `${k}.Dockerfile`))
    .filter((f) => !existsSync(f));
}

/**
 * Write secrets to a temp JSON file (0600) for `wrangler deploy --secrets-file`, run fn, delete the file in finally.
 * The file lives in a fresh temp dir, never in the project.
 */
export async function withSecretsFile<T>(
  secrets: Record<string, string>,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cf-orbs-"));
  const file = join(dir, "secrets.json");
  try {
    for (const v of Object.values(secrets)) registerSecret(v);
    await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function cliVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    );
    return String(pkg.version);
  } catch {
    return "0.0.0";
  }
}

/** Git mode deploy command: Workers Builds runs it in the repo root. */
export const GIT_DEPLOY_COMMAND = "npx wrangler deploy --config .cf-orbs/wrangler.jsonc";

/** Root package.json for git mode: Workers Builds installs the wrangler version it names. */
export function gitPackageJson(name: string, wrangler: string): string {
  const pkg = {
    name,
    private: true,
    scripts: { deploy: "wrangler deploy --config .cf-orbs/wrangler.jsonc" },
    devDependencies: { wrangler },
  };
  return `${JSON.stringify(pkg, null, 2)}\n`;
}
