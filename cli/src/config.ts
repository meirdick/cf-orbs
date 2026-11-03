// cf-orbs.config.jsonc: load, validate, edit. ProviderConfig and DEFAULT_CONFIG are copies of
// worker/src/core/types.ts (the CLI ships without the worker package); cli/test/config.test.ts keeps them equal.
// Validation rules match worker/src/core/config.ts parseConfig, so a config the CLI accepts never fails in the Worker.
import { readFile } from "node:fs/promises";
import { CliError } from "./errors.js";

/** An orb size. Copy of worker OrbInstanceSpec: "lite" is the provider's size only. */
export type OrbInstanceSpec =
  | "standard-1"
  | "standard-2"
  | "standard-3"
  | "standard-4"
  | { vcpu: number; memoryMib: number; diskMb: number };

/** Copy of worker/src/core/types.ts ProviderConfig. */
export interface ProviderConfig {
  instance: OrbInstanceSpec;
  maxRunning: number;
  maxAwakeHours: number;
  checkpointMinutes: number;
  warmMinutes: number;
  inactivityTimeoutMinutes: number;
  alarmSeconds: number;
  images: Record<string, string>;
  ampImageDigest: string;
  debugExec: boolean;
  hugePages: boolean;
  fastTmpfsGb: number;
  prewarm: number;
  projectSnapshotRefresh: ProjectSnapshotRefresh;
}

/** Copy of worker/src/core/types.ts ProjectSnapshotRefresh. */
export type ProjectSnapshotRefresh = "off" | "on-change";

/** Copy of worker/src/core/types.ts DEFAULT_CONFIG. */
export const DEFAULT_CONFIG: ProviderConfig = {
  instance: { vcpu: 4, memoryMib: 12288, diskMb: 20000 },
  maxRunning: 20,
  maxAwakeHours: 12,
  checkpointMinutes: 0,
  warmMinutes: 10,
  inactivityTimeoutMinutes: 15,
  alarmSeconds: 60,
  images: {},
  ampImageDigest: "sha256:378c5e2188f00960eca36dc806aa04e1cacd92c2341665bcdf4692326c462d6d",
  debugExec: false,
  hugePages: true,
  fastTmpfsGb: 0,
  prewarm: 2,
  projectSnapshotRefresh: "off",
};

/** Same as worker MAX_PREWARM: throwaway instances per deploy. */
export const MAX_PREWARM = 5;

/** The instance init --vcpu N writes: N vCPU, 3 GiB per vCPU (the Cloudflare minimum), 20 GB disk (the maximum). */
export function instanceForVcpu(vcpu: number): { vcpu: number; memoryMib: number; diskMb: number } {
  return { vcpu, memoryMib: vcpu * 3072, diskMb: 20_000 };
}

export const AMP_DEFAULT_IMAGE_REPO = "us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb";

export type ProviderHostMode = "cloudflare" | "external";

/** Full config file: ProviderConfig plus CLI-only fields. */
export interface CfOrbsConfig extends ProviderConfig {
  /** Worker name. Default "cf-orbs". A second install (another size) needs another name. */
  name: string;
  providerHost: ProviderHostMode;
  debugSsh: boolean;
}

export const DEFAULT_CLI_CONFIG: CfOrbsConfig = {
  name: "cf-orbs",
  ...structuredClone(DEFAULT_CONFIG),
  providerHost: "cloudflare",
  debugSsh: false,
};

export const CONFIG_FILE = "cf-orbs.config.jsonc";
const FIX = `edit ${CONFIG_FILE} and run cf-orbs deploy`;
/** Same as worker MIN_ORB_DISK_MB: room for the orb image (~2.4 GB) plus a repo. */
export const MIN_ORB_DISK_MB = 8000;
export const IMAGE_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const KNOWN_KEYS = new Set([...Object.keys(DEFAULT_CLI_CONFIG), "$schema"]);

// ---------- JSONC ----------

/** Remove // and /* *\/ comments and trailing commas outside strings. */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      out += " ";
    } else {
      out += c;
      i++;
    }
  }
  // trailing commas: a comma followed only by whitespace and then } or ]
  let res = "";
  for (let j = 0; j < out.length; j++) {
    const c = out[j] as string;
    if (c === '"') {
      const end = stringEnd(out, j);
      res += out.slice(j, end);
      j = end - 1;
      continue;
    }
    if (c === ",") {
      let k = j + 1;
      while (k < out.length && /\s/.test(out[k] as string)) k++;
      if (out[k] === "}" || out[k] === "]") continue;
    }
    res += c;
  }
  return res;
}

/** Index just past the closing quote of the string starting at i. */
function stringEnd(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === "\\") j += 2;
    else if (text[j] === '"') return j + 1;
    else j++;
  }
  return text.length;
}

export function parseJsonc(text: string, file = CONFIG_FILE): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new CliError(`${file} is not valid JSONC (${(e as Error).message})`, `fix the syntax in ${file}`);
  }
}

/**
 * Set a top-level key in a JSONC object text, keeping comments elsewhere.
 * Replaces the value if the key exists, else inserts it before the closing brace.
 */
export function setTopLevelJsonc(text: string, key: string, value: unknown, indent = "  "): string {
  const json = JSON.stringify(value, null, 2).replace(/\n/g, `\n${indent}`);
  const span = findTopLevelValue(text, key);
  if (span) return text.slice(0, span.start) + json + text.slice(span.end);
  const close = text.lastIndexOf("}");
  if (close === -1)
    throw new CliError(
      `${CONFIG_FILE} has no top-level object`,
      `restore ${CONFIG_FILE} from cf-orbs.config.example.jsonc`,
    );
  // find last non-space, non-comment char before close to decide on a comma
  const before = stripJsonc(text.slice(0, close)).trimEnd();
  const needComma = !before.endsWith("{") && !before.endsWith(",");
  let head = text.slice(0, close).replace(/\s*$/, "");
  if (needComma) head = insertCommaAfterLastValue(head);
  return `${head}\n${indent}${JSON.stringify(key)}: ${json}\n${text.slice(close)}`;
}

function insertCommaAfterLastValue(head: string): string {
  // walk back over trailing line comments to put the comma after the last value, not inside a comment
  const lines = head.split("\n");
  for (let li = lines.length - 1; li >= 0; li--) {
    const code = stripJsonc(lines[li] as string).trimEnd();
    if (code === "") continue;
    const line = lines[li] as string;
    // position of the end of the code part in the original line
    const idx = codeEndIndex(line);
    lines[li] = `${line.slice(0, idx)},${line.slice(idx)}`;
    return lines.join("\n");
  }
  return `${head},`;
}

function codeEndIndex(line: string): number {
  let i = 0;
  let last = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (c === '"') {
      i = stringEnd(line, i);
      last = i;
    } else if (c === "/" && (line[i + 1] === "/" || line[i + 1] === "*")) break;
    else {
      if (!/\s/.test(c)) last = i + 1;
      i++;
    }
  }
  return last;
}

/** Locate the value of a top-level key: [start, end) in the original text. */
export function findTopLevelValue(text: string, key: string): { start: number; end: number } | undefined {
  let depth = 0;
  let i = 0;
  const n = text.length;
  let expectKey = false;
  while (i < n) {
    const c = text[i] as string;
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }
    if (c === '"') {
      const end = stringEnd(text, i);
      if (depth === 1 && expectKey) {
        const k = JSON.parse(text.slice(i, end)) as string;
        let j = skipWs(text, end);
        if (text[j] === ":" && k === key) {
          j = skipWs(text, j + 1);
          return { start: j, end: valueEnd(text, j) };
        }
      }
      i = end;
      expectKey = false;
      continue;
    }
    if (c === "{" || c === "[") {
      depth++;
      expectKey = c === "{" && depth === 1;
    } else if (c === "}" || c === "]") depth--;
    else if (c === "," && depth === 1) expectKey = true;
    i++;
  }
  return undefined;
}

function skipWs(text: string, i: number): number {
  let j = i;
  for (;;) {
    while (j < text.length && /\s/.test(text[j] as string)) j++;
    if (text[j] === "/" && text[j + 1] === "/") {
      while (j < text.length && text[j] !== "\n") j++;
    } else if (text[j] === "/" && text[j + 1] === "*") {
      const e = text.indexOf("*/", j + 2);
      j = e === -1 ? text.length : e + 2;
    } else return j;
  }
}

function valueEnd(text: string, start: number): number {
  const c = text[start];
  if (c === '"') return stringEnd(text, start);
  if (c === "{" || c === "[") {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === '"') {
        i = stringEnd(text, i);
        continue;
      }
      if (ch === "/" && text[i + 1] === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && text[i + 1] === "*") {
        const e = text.indexOf("*/", i + 2);
        i = e === -1 ? text.length : e + 2;
        continue;
      }
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return text.length;
  }
  let i = start;
  while (i < text.length && !/[,}\]\s/]/.test(text[i] as string)) i++;
  return i;
}

// ---------- validation ----------

function fail(cause: string, fix = FIX): never {
  throw new CliError(cause, fix);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, name: string, min: number, max: number, integer = true): number {
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    (integer && !Number.isInteger(v)) ||
    v < min ||
    v > max
  ) {
    fail(
      `${name} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}, got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

/** Cloudflare custom instance rules: 1-4 vCPU, ≤ 12 GiB, ≤ 20 GB disk, ≥ 3 GiB per vCPU. Orbs need standard-1 or more. */
export function validateInstance(v: unknown): OrbInstanceSpec {
  if (typeof v === "string") {
    if (["standard-1", "standard-2", "standard-3", "standard-4"].includes(v)) return v as OrbInstanceSpec;
    if (v === "lite" || v === "basic" || v === "dev") {
      fail(
        `instance ${v} is too small for the orb image`,
        `set instance to standard-1 or larger in ${CONFIG_FILE}`,
      );
    }
    fail(`unknown instance ${JSON.stringify(v)}; use standard-1..4 or {vcpu, memoryMib, diskMb}`);
  }
  if (!isObj(v))
    fail(`instance must be standard-1..4 or {vcpu, memoryMib, diskMb}, got ${JSON.stringify(v)}`);
  for (const k of Object.keys(v)) {
    if (!["vcpu", "memoryMib", "diskMb"].includes(k))
      fail(`unknown key instance.${k}; use vcpu, memoryMib, diskMb`);
  }
  const vcpu = num(v.vcpu, "instance.vcpu", 1, 4, false);
  const memoryMib = num(v.memoryMib, "instance.memoryMib", 1, 12 * 1024);
  const diskMb = num(v.diskMb, "instance.diskMb", MIN_ORB_DISK_MB, 20_000);
  if (memoryMib < vcpu * 3072)
    fail(`instance.memoryMib ${memoryMib} is below 3 GiB per vCPU (${vcpu * 3072} for ${vcpu} vCPU)`);
  return { vcpu, memoryMib, diskMb };
}

/** Memory of an instance in MiB. Same as worker instanceMemoryMib. */
export function instanceMemoryMib(i: OrbInstanceSpec): number {
  if (typeof i === "object") return i.memoryMib;
  return { "standard-1": 4096, "standard-2": 6144, "standard-3": 8192, "standard-4": 12288 }[i];
}

/** fastTmpfsGb: 0-8, and at most the orb memory minus 3 GiB. Same rule as worker validateFastTmpfs. */
export function validateFastTmpfs(v: unknown, instance: OrbInstanceSpec): number {
  const n = num(v, "fastTmpfsGb", 0, 8);
  const gib = Math.floor(instanceMemoryMib(instance) / 1024);
  const max = Math.max(0, gib - 3);
  if (n > max)
    fail(
      `fastTmpfsGb ${n} leaves less than 3 GiB of the orb's ${gib} GiB memory`,
      `set fastTmpfsGb to ${max} or less in ${CONFIG_FILE} and run cf-orbs deploy`,
    );
  return n;
}

/** Validate a parsed config object. Missing fields take defaults. Unknown keys fail (catches typos). */
export function validateConfig(raw: unknown): CfOrbsConfig {
  if (raw === undefined || raw === null) return structuredClone(DEFAULT_CLI_CONFIG);
  if (!isObj(raw)) fail(`${CONFIG_FILE} must contain one JSON object`);
  for (const k of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(k))
      fail(
        `unknown key ${JSON.stringify(k)} in ${CONFIG_FILE}`,
        `remove it or check spelling against cf-orbs.config.example.jsonc`,
      );
  }
  const out = structuredClone(DEFAULT_CLI_CONFIG);
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || !NAME_RE.test(raw.name)) {
      fail(`name must be lowercase letters, digits and dashes (max 63), got ${JSON.stringify(raw.name)}`);
    }
    out.name = raw.name;
  }
  if (raw.instance !== undefined) out.instance = validateInstance(raw.instance);
  if (raw.maxRunning !== undefined) out.maxRunning = num(raw.maxRunning, "maxRunning", 1, 1000);
  if (raw.maxAwakeHours !== undefined)
    out.maxAwakeHours = num(raw.maxAwakeHours, "maxAwakeHours", 1, 24 * 30, false);
  if (raw.checkpointMinutes !== undefined) {
    const c = num(raw.checkpointMinutes, "checkpointMinutes", 0, 24 * 60);
    if (c !== 0 && c < 15) fail(`checkpointMinutes must be 0 (off) or at least 15, got ${c}`);
    out.checkpointMinutes = c;
  }
  if (raw.warmMinutes !== undefined) out.warmMinutes = num(raw.warmMinutes, "warmMinutes", 0, 120);
  if (raw.inactivityTimeoutMinutes !== undefined) {
    out.inactivityTimeoutMinutes = num(raw.inactivityTimeoutMinutes, "inactivityTimeoutMinutes", 5, 360);
  }
  if (raw.alarmSeconds !== undefined) out.alarmSeconds = num(raw.alarmSeconds, "alarmSeconds", 10, 3600);
  if (out.alarmSeconds * 1000 >= out.inactivityTimeoutMinutes * 60_000) {
    fail(
      `alarmSeconds ${out.alarmSeconds} must be shorter than inactivityTimeoutMinutes ${out.inactivityTimeoutMinutes}`,
    );
  }
  if (raw.images !== undefined) {
    if (!isObj(raw.images)) fail("images must be an object of image ref → image key");
    const images: Record<string, string> = {};
    for (const [ref, key] of Object.entries(raw.images)) {
      if (typeof key !== "string" || !IMAGE_KEY_RE.test(key)) {
        fail(
          `images[${JSON.stringify(ref)}] must be an image key like "my-image", got ${JSON.stringify(key)}`,
        );
      }
      if (key === "orb" || key === "provider")
        fail(`images[${JSON.stringify(ref)}]: key ${key} is reserved; pick another key`);
      images[ref] = key;
    }
    out.images = images;
  }
  if (raw.debugExec !== undefined) {
    if (typeof raw.debugExec !== "boolean") fail("debugExec must be true or false");
    out.debugExec = raw.debugExec;
  }
  if (raw.hugePages !== undefined) {
    if (typeof raw.hugePages !== "boolean")
      fail(`hugePages must be true or false, got ${JSON.stringify(raw.hugePages)}`);
    out.hugePages = raw.hugePages;
  }
  if (raw.fastTmpfsGb !== undefined) out.fastTmpfsGb = validateFastTmpfs(raw.fastTmpfsGb, out.instance);
  if (raw.prewarm !== undefined) out.prewarm = num(raw.prewarm, "prewarm", 0, MAX_PREWARM);
  if (raw.projectSnapshotRefresh !== undefined) {
    const v = raw.projectSnapshotRefresh;
    if (v !== "off" && v !== "on-change")
      fail(`projectSnapshotRefresh must be "off" or "on-change", got ${JSON.stringify(v)}`);
    out.projectSnapshotRefresh = v;
  }
  if (raw.ampImageDigest !== undefined) {
    if (typeof raw.ampImageDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.ampImageDigest)) {
      fail(`ampImageDigest must look like sha256:<64 hex>, got ${JSON.stringify(raw.ampImageDigest)}`);
    }
    out.ampImageDigest = raw.ampImageDigest;
  }
  if (raw.providerHost !== undefined) {
    if (raw.providerHost !== "cloudflare" && raw.providerHost !== "external") {
      fail(`providerHost must be "cloudflare" or "external", got ${JSON.stringify(raw.providerHost)}`);
    }
    out.providerHost = raw.providerHost;
  }
  if (raw.debugSsh !== undefined) {
    if (typeof raw.debugSsh !== "boolean")
      fail(`debugSsh must be true or false, got ${JSON.stringify(raw.debugSsh)}`);
    out.debugSsh = raw.debugSsh;
  }
  return out;
}

export function parseConfigText(text: string): CfOrbsConfig {
  return validateConfig(parseJsonc(text));
}

export async function loadConfig(path: string): Promise<CfOrbsConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new CliError(
      `${path} not found`,
      "run cf-orbs init in this directory, or pass --dir <project dir>",
    );
  }
  return parseConfigText(text);
}

/**
 * The subset the Worker reads from CF_ORBS_CONFIG. providerHost rides along but the Worker ignores it:
 * the Worker runs ProviderHost only when the AMP_ORB_PROVIDER_TOKEN secret exists (deploy deletes it in external mode).
 */
export function workerConfigJson(c: CfOrbsConfig): string {
  const { name: _name, debugSsh: _ssh, ...rest } = c;
  return JSON.stringify(rest);
}

/** Every image key the generated wrangler.jsonc builds for OrbSession: "orb" plus config.images values. */
export function orbImageKeys(c: CfOrbsConfig): string[] {
  return [...new Set(["orb", ...Object.values(c.images)])];
}

/** Starter config text written by init when the example template is missing. */
export function defaultConfigText(overrides: Partial<CfOrbsConfig> = {}): string {
  const c = { ...DEFAULT_CLI_CONFIG, ...overrides };
  return `// cf-orbs configuration. wrangler.jsonc is generated from this file by cf-orbs deploy.
{
  "name": ${JSON.stringify(c.name)},
  // custom {vcpu 1-4, memoryMib <= 12288 and >= 3072 per vCPU, diskMb 8000-20000} or "standard-1".."standard-4"
  // default 4 vCPU, 12 GiB, 20 GB; cf-orbs init --vcpu N writes N vCPU, N x 3 GiB, 20 GB
  "instance": ${JSON.stringify(c.instance)},
  "maxRunning": ${c.maxRunning}, // cap on awake orbs
  "maxAwakeHours": ${c.maxAwakeHours}, // watchdog self-pauses an orb awake longer than this
  "checkpointMinutes": ${c.checkpointMinutes}, // 0 = off; else >= 15, dirty-only snapshots
  "warmMinutes": ${c.warmMinutes}, // after an Amp pause, keep the orb running this long (0-120; 0 = stop at once)
  "hugePages": ${c.hugePages}, // bootstrap sets transparent huge pages to always (faster new memory)
  "fastTmpfsGb": ${c.fastTmpfsGb}, // 0 = off; else GiB of memory-backed /mnt/fast for caches (max memory GiB - 3, and 8)
  "prewarm": ${c.prewarm}, // 0-5 throwaway instances after each deploy, to pull the new image onto hosts; 0 = off
  "projectSnapshotRefresh": ${JSON.stringify(c.projectSnapshotRefresh)}, // "off" | "on-change": forget a project snapshot after an amp or image change
  "providerHost": ${JSON.stringify(c.providerHost)}, // "cloudflare" | "external"
  "images": ${JSON.stringify(c.images)}, // ORB_IMAGE ref -> image key (image/<key>.Dockerfile)
  "debugSsh": ${c.debugSsh}
}
`;
}
