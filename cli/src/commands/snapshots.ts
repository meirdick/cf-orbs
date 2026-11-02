// cf-orbs snapshots list | forget <ampSnapshotId> | forget --all-project [--yes]
//                  | prune [--older-than 7d] [--all] [--yes]
// Project snapshot mappings live in the Registry DO (Amp ORB_SNAPSHOT_ID → Cloudflare snapshot handle).
// Forget drops the mapping only: the next spawn with that id boots the image and Amp runs setup again.
// Cloudflare keeps the snapshot data until its 30-day TTL. The DO container API cannot delete it, but
// wrangler can: a snapshot is the image tag <worker>-orbsession-<key>:rootfs-snapshot-<sha256 hex of id>.
// Prune uses that path (seen 2026-10-30 and 2026-10-31, not documented), so each delete fails soft.
import { createHash } from "node:crypto";
import { expectOk } from "../api.js";
import { flagBool, flagString } from "../args.js";
import { loadConfig } from "../config.js";
import { connect } from "../connect.js";
import type { Ctx } from "../context.js";
import { CliError, oneLine } from "../errors.js";
import { ask, fmtAge, fmtBytes, table } from "../ui.js";
import { lastErrorLine, makeWrangler, type Wrangler } from "../wrangler.js";
import { containerAppNames } from "../wrangler-template.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" && v !== "" ? v : "-");

export const ROUTE = "/v1/project-snapshots";

/** Amp keeps its own cache entry. cf-orbs cannot delete it; the user must. */
export const AMP_CACHE_HINT =
  "Amp caches one prepared snapshot per provider for 72 h. After an image or bootstrap change, delete it in " +
  "Amp → Orb Settings → Snapshots (or amp projects snapshots delete <owner/repo> --resource <size>), " +
  "then run cf-orbs snapshots forget --all-project.";

/** The two steps after an image change, as printed by cf-orbs upgrade. */
export const AMP_CACHE_STEPS: readonly string[] = [
  "Then clear the snapshot caches, so new threads run setup on the new image:",
  "  1. Amp: delete the cached snapshot in Amp → Orb Settings → Snapshots",
  "     (or amp projects snapshots delete <owner/repo> --resource <size>). Amp keeps it for 72 h.",
  "  2. cf-orbs: cf-orbs snapshots forget --all-project",
];

export interface ProjectSnapshotsBody {
  projectSnapshots: Obj[];
  summary: Obj;
}

export function parseBody(v: unknown): ProjectSnapshotsBody {
  const b = obj(v);
  const list = Array.isArray(b.projectSnapshots) ? b.projectSnapshots.map(obj) : [];
  return { projectSnapshots: list, summary: obj(b.summary) };
}

/** "in 2d", "expired" or "-". */
function fmtExpiry(row: Obj, now: number): string {
  if (row.expired === true) return "expired";
  if (typeof row.expiresAt !== "string") return "-";
  const t = Date.parse(row.expiresAt);
  if (!Number.isFinite(t)) return "-";
  return `in ${fmtAge(new Date(now).toISOString(), t)}`;
}

const ago = (v: unknown, now: number) => (typeof v === "string" ? `${fmtAge(v, now)} ago` : "-");

export function renderProjectSnapshots(body: unknown, now = Date.now()): string {
  const { projectSnapshots, summary } = parseBody(body);
  const lines: string[] = [];
  if (projectSnapshots.length === 0) lines.push("No project snapshot mappings.");
  else {
    lines.push(
      table(
        ["AMP SNAPSHOT", "CF SNAPSHOT", "SIZE", "SOURCE ORB", "CREATED", "LAST USED", "EXPIRES"],
        projectSnapshots.map((r) => {
          const h = obj(r.handle);
          return [
            str(r.snapshotId),
            str(h.id),
            h.size === undefined ? "-" : fmtBytes(Number(h.size)),
            str(r.sourceOrbId),
            ago(r.createdAt, now),
            ago(r.lastUsedAt, now),
            fmtExpiry(r, now),
          ];
        }),
      ),
    );
  }
  if (summary.retainedSnapshots !== undefined) {
    lines.push("");
    lines.push(
      `snapshot index: ${Number(summary.retainedSnapshots)} retained, ${fmtBytes(Number(summary.retainedSnapshotBytes))}` +
        (typeof summary.nextExpiry === "string" ? `, next expiry ${summary.nextExpiry}` : ""),
    );
  }
  lines.push("Forget drops the mapping only. Cloudflare keeps snapshot data until its 30-day TTL.");
  return lines.join("\n");
}

export type Confirm = (question: string) => Promise<boolean>;

const ttyConfirm: Confirm = async (q) => /^y(es)?$/i.test(await ask(q));

export async function snapshotsCommand(ctx: Ctx, confirm: Confirm = ttyConfirm): Promise<number> {
  const [sub = "list", id, ...extra] = ctx.args.positionals;
  if (sub === "prune") {
    if (id !== undefined)
      throw new CliError(`snapshots prune takes no argument, got ${id}`, "run cf-orbs snapshots prune");
    return pruneCommand(ctx);
  }
  if (sub === "list") {
    if (id !== undefined)
      throw new CliError(`snapshots list takes no argument, got ${id}`, "run cf-orbs snapshots list");
    const { api } = await connect(ctx);
    const body = expectOk(await api.get(ROUTE), "snapshots list");
    ctx.ui.result(body);
    ctx.ui.out(renderProjectSnapshots(body, ctx.now()));
    return 0;
  }
  if (sub !== "forget")
    throw new CliError(
      `unknown snapshots command ${sub}`,
      "use cf-orbs snapshots list, forget <ampSnapshotId> or prune",
    );
  const all = flagBool(ctx.args, "all-project");
  if (extra.length > 0 || (all && id !== undefined))
    throw new CliError(
      "snapshots forget takes one Amp snapshot id or --all-project, not both",
      "run cf-orbs snapshots forget <ampSnapshotId> or cf-orbs snapshots forget --all-project",
    );
  if (!all && id === undefined)
    throw new CliError(
      "snapshots forget needs an Amp snapshot id or --all-project",
      "run cf-orbs snapshots list to see the ids",
    );
  const { api } = await connect(ctx);
  const forgetOne = async (snapshotId: string): Promise<boolean> => {
    const b = obj(
      expectOk(await api.del(`${ROUTE}/${encodeURIComponent(snapshotId)}`), `forget ${snapshotId}`),
    );
    return b.forgotten === true;
  };

  if (!all) {
    const sid = id as string;
    const forgotten = await forgetOne(sid);
    ctx.ui.result({ ok: true, forgotten: forgotten ? [sid] : [] });
    ctx.ui.out(
      forgotten
        ? `Forgot ${sid}. The next spawn with this id boots the image and Amp runs setup again.`
        : `No mapping for ${sid}. Nothing to forget.`,
    );
    return 0;
  }

  const { projectSnapshots } = parseBody(expectOk(await api.get(ROUTE), "snapshots list"));
  const ids = projectSnapshots.map((r) => r.snapshotId).filter((x): x is string => typeof x === "string");
  if (ids.length === 0) {
    ctx.ui.result({ ok: true, forgotten: [] });
    ctx.ui.out("No project snapshot mappings. Nothing to forget.");
    return 0;
  }
  if (!flagBool(ctx.args, "yes")) {
    if (ctx.ui.nonInteractive)
      throw new CliError(
        `forget --all-project would drop ${ids.length} mapping(s) and needs confirmation`,
        "rerun with --yes",
      );
    const ok = await confirm(
      `Forget ${ids.length} project snapshot mapping(s)? New threads then boot the image and run setup again. [y/N] `,
    );
    if (!ok) {
      ctx.ui.result({ ok: true, forgotten: [], cancelled: true });
      ctx.ui.out("Cancelled. Nothing forgotten.");
      return 0;
    }
  }
  const forgotten: string[] = [];
  for (const sid of ids) {
    if (!(await forgetOne(sid))) continue; // gone already (GC or another forget)
    forgotten.push(sid);
    ctx.ui.step(`forgot ${sid}`);
  }
  ctx.ui.result({ ok: true, forgotten });
  ctx.ui.out(
    `Forgot ${forgotten.length} project snapshot mapping(s). New threads boot the image and Amp runs setup again.`,
  );
  return 0;
}

// ---- prune ----

export const PRUNE_ROUTE = "/v1/snapshots";
export const DEFAULT_OLDER_THAN = "7d";
const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000 };

/** "7d", "36h", "90m" → ms. */
export function parseAge(v: string): number {
  const m = /^(\d{1,4})([dhm])$/.exec(v.trim());
  if (!m) throw new CliError(`bad --older-than ${v}`, "use a number and a unit: 7d, 36h or 90m");
  return Number(m[1]) * (UNIT_MS[m[2] as string] as number);
}

export interface PruneRow {
  id: string;
  orbId: string;
  imageKey: string;
  bytes: number;
  lastUsedAt: string;
}

export interface PruneBody {
  candidates: PruneRow[];
  totalBytes: number;
  kept: { mapped: number; current: number; young: number };
}

export function parsePruneBody(v: unknown): PruneBody {
  const b = obj(v);
  const k = obj(b.kept);
  const candidates = (Array.isArray(b.candidates) ? b.candidates.map(obj) : [])
    .filter((r) => typeof r.id === "string" && r.id !== "")
    .map((r) => ({
      id: r.id as string,
      orbId: str(r.orbId),
      imageKey: typeof r.imageKey === "string" && r.imageKey !== "" ? r.imageKey : "orb",
      bytes: Number(r.bytes) || 0,
      lastUsedAt: str(r.lastUsedAt),
    }));
  return {
    candidates,
    totalBytes: candidates.reduce((n, r) => n + r.bytes, 0),
    kept: { mapped: Number(k.mapped) || 0, current: Number(k.current) || 0, young: Number(k.young) || 0 },
  };
}

export function renderPrune(body: PruneBody, age: string, now = Date.now()): string {
  const lines: string[] = [];
  const n = body.candidates.length;
  if (n > 0)
    lines.push(
      table(
        ["CF SNAPSHOT", "ORB", "SIZE", "LAST USED"],
        body.candidates.map((r) => [r.id, r.orbId, fmtBytes(r.bytes), ago(r.lastUsedAt, now)]),
      ),
      "",
    );
  const unused = age === "0m" ? "any age" : `unused for ${age} or more`;
  lines.push(
    `${n} snapshot(s), ${fmtBytes(body.totalBytes)}: no orb or project mapping uses them, ${unused}.`,
  );
  const k = body.kept;
  lines.push(
    `Kept: ${k.mapped} in a project mapping, ${k.current} orb disk(s)` +
      (age === "0m" ? "." : `, ${k.young} used in the last ${age}.`),
  );
  return lines.join("\n");
}

/** Tag Cloudflare gives a container snapshot in the image registry: sha256 hex of the snapshot id. */
export const snapshotTag = (id: string) => `rootfs-snapshot-${createHash("sha256").update(id).digest("hex")}`;

/**
 * Pure: "<repo>:<tag>" for each snapshot id. Looks the tag up in `containers images list --json` under this
 * install's orb repos; when it is not listed, uses <worker>-orbsession-<imageKey>.
 */
export function snapshotImageRefs(
  worker: string,
  rows: Pick<PruneRow, "id" | "imageKey">[],
  imagesJson: string,
): Map<string, string> {
  const prefix = `${containerAppNames(worker)[0]}-`;
  const byTag = new Map<string, string>();
  for (const r of parseJsonArray<{ name?: unknown; tags?: unknown }>(imagesJson)) {
    if (typeof r.name !== "string" || !r.name.startsWith(prefix) || !Array.isArray(r.tags)) continue;
    for (const t of r.tags) if (typeof t === "string") byTag.set(t, r.name);
  }
  return new Map(
    rows.map((r) => {
      const tag = snapshotTag(r.id);
      return [r.id, `${byTag.get(tag) ?? `${prefix}${r.imageKey}`}:${tag}`];
    }),
  );
}

function parseJsonArray<T>(s: string): T[] {
  const i = s.indexOf("[");
  if (i === -1) return [];
  try {
    const v = JSON.parse(s.slice(i));
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

/** Same source as uninstall: the config name, else the name in state.json. */
async function workerName(ctx: Ctx, fallback: string | undefined): Promise<string> {
  try {
    return (await loadConfig(ctx.paths.config)).name;
  } catch {}
  if (fallback) return fallback;
  throw new CliError(
    `no cf-orbs project in ${ctx.paths.dir}`,
    "run in the project dir or pass --dir <project dir>",
  );
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** undefined on success, else one line from wrangler. */
async function deleteImage(w: Wrangler, ref: string): Promise<string | undefined> {
  // CI=1: wrangler takes its confirm fallback (yes) without a prompt
  const r = await w.run(["containers", "images", "delete", ref, "--skip-confirmation"], {
    timeoutMs: 120_000,
    env: { CI: "1" },
  });
  if (r.code === 0) return undefined;
  return oneLine(lastErrorLine(`${r.stdout}\n${r.stderr}`)).slice(0, 200);
}

async function pruneCommand(ctx: Ctx): Promise<number> {
  const all = flagBool(ctx.args, "all");
  const olderFlag = flagString(ctx.args, "older-than");
  if (all && olderFlag !== undefined)
    throw new CliError(
      "--all and --older-than do not go together",
      "use --all (no age limit) or --older-than <age>",
    );
  const age = all ? "0m" : (olderFlag ?? DEFAULT_OLDER_THAN);
  const olderThanS = Math.floor(parseAge(age) / 1000);
  const yes = flagBool(ctx.args, "yes");
  const { api, state } = await connect(ctx);
  const body = parsePruneBody(
    expectOk(await api.get(`${PRUNE_ROUTE}?candidates=1&olderThan=${olderThanS}`), "snapshots prune"),
  );
  const n = body.candidates.length;
  const base = { olderThanSeconds: olderThanS, ...body };
  ctx.ui.out(renderPrune(body, age, ctx.now()));
  if (n === 0) {
    ctx.ui.result({ ok: true, dryRun: !yes, ...base, deleted: [], failed: [] });
    ctx.ui.out("Nothing to prune.");
    return 0;
  }
  if (!yes) {
    ctx.ui.result({ ok: true, dryRun: true, ...base });
    ctx.ui.out(`Would delete ${n} snapshot(s), ${fmtBytes(body.totalBytes)}; rerun with --yes.`);
    return 0;
  }

  const worker = await workerName(ctx, state.workerName);
  const w = makeWrangler(ctx.run, { accountId: state.accountId });
  const list = await w.run(["containers", "images", "list", "--json"], { timeoutMs: 60_000 });
  if (list.code !== 0)
    throw new CliError(
      `wrangler containers images list failed: ${lastErrorLine(`${list.stdout}\n${list.stderr}`)}`,
      "run npx wrangler login, then rerun cf-orbs snapshots prune --yes",
    );
  const refs = snapshotImageRefs(worker, body.candidates, list.stdout);
  const deleted: string[] = [];
  const failed: { id: string; error: string }[] = [];
  let bytes = 0;
  for (const r of body.candidates) {
    const ref = refs.get(r.id) as string;
    const err = await deleteImage(w, ref);
    if (err === undefined) {
      deleted.push(r.id);
      bytes += r.bytes;
      ctx.ui.step(`deleted ${ref} (${fmtBytes(r.bytes)})`);
    } else {
      failed.push({ id: r.id, error: err });
      ctx.ui.warn(
        `Failed: wrangler could not delete ${ref} (${err}) — fix: none needed; skipped, Cloudflare drops it at its 30-day TTL`,
      );
    }
  }
  let forgotten: string[] = [];
  if (deleted.length > 0) {
    try {
      const r = expectOk(await api.post(`${PRUNE_ROUTE}/forget-many`, { ids: deleted }), "forget-many");
      forgotten = arr(obj(r).forgotten);
    } catch (e) {
      // The data is gone; only the index is behind. Its daily GC drops the ids at their TTL.
      ctx.ui.warn(e instanceof Error ? e.message : String(e));
    }
  }
  const result = { ...base, dryRun: false, deleted, deletedBytes: bytes, failed, forgotten };
  if (deleted.length === 0) {
    const e = new CliError(
      `no snapshot deleted; wrangler failed on all ${failed.length}`,
      "check the lines above, then run npx wrangler containers images list",
    );
    if (ctx.ui.json) {
      ctx.ui.result({ ok: false, error: e.message, ...result });
      return 1;
    }
    throw e;
  }
  ctx.ui.result({ ok: true, ...result });
  ctx.ui.out(
    `Deleted ${deleted.length} snapshot(s), ${fmtBytes(bytes)}.` +
      (failed.length > 0 ? ` ${failed.length} failed and were skipped.` : ""),
  );
  return 0;
}
