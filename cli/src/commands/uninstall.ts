// cf-orbs uninstall [--yes]: list (dry run) or delete the Worker, both container apps and their images.
// Snapshot data has no delete API and can persist up to 30 days.
import { flagBool } from "../args.js";
import { loadConfig } from "../config.js";
import type { Ctx } from "../context.js";
import { CliError, oneLine } from "../errors.js";
import { readState } from "../project.js";
import { makeWrangler, type Wrangler } from "../wrangler.js";
import { containerAppNames } from "../wrangler-template.js";

export const RETENTION_NOTE =
  "Note: container snapshots (paused orbs, project snapshots) have no delete API; Cloudflare keeps their data up to 30 days after the last restore.";

export interface Resources {
  worker: string;
  apps: { id: string; name: string }[];
  images: string[]; // "<repo>:<tag>"
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

/** Pure: pick this install's resources out of `containers list --json` and `containers images list --json`. */
export function selectResources(worker: string, appsJson: string, imagesJson: string): Resources {
  const names = new Set(containerAppNames(worker));
  const apps = parseJsonArray<{ id: string; name: string }>(appsJson)
    .filter((a) => names.has(a.name))
    .map((a) => ({ id: a.id, name: a.name }));
  const prefixes = [...names].map((n) => `${n}-`);
  const images = parseJsonArray<{ name: string; tags?: string[] }>(imagesJson)
    .filter((r) => prefixes.some((p) => r.name.startsWith(p)))
    .flatMap((r) => (r.tags ?? []).map((t) => `${r.name}:${t}`));
  return { worker, apps, images };
}

async function listResources(w: Wrangler, worker: string): Promise<Resources> {
  const [apps, images] = await Promise.all([
    w.run(["containers", "list", "--json", "--per-page", "100"], { timeoutMs: 60_000 }),
    w.run(["containers", "images", "list", "--json"], { timeoutMs: 60_000 }),
  ]);
  if (apps.code !== 0)
    throw new CliError(
      `wrangler containers list failed: ${oneLine(apps.stderr).slice(0, 200)}`,
      "run npx wrangler login, then rerun",
    );
  if (images.code !== 0)
    throw new CliError(
      `wrangler containers images list failed: ${oneLine(images.stderr).slice(0, 200)}`,
      "run npx wrangler login, then rerun",
    );
  return selectResources(worker, apps.stdout, images.stdout);
}

export async function uninstallCommand(ctx: Ctx): Promise<number> {
  const { ui, paths } = ctx;
  const state = await readState(paths);
  let worker = state.workerName;
  try {
    worker = (await loadConfig(paths.config)).name;
  } catch {}
  if (!worker)
    throw new CliError(
      `no cf-orbs project in ${paths.dir}`,
      "run in the project dir or pass --dir <project dir>",
    );
  const w = makeWrangler(ctx.run, { accountId: state.accountId });
  const res = await listResources(w, worker);
  const yes = flagBool(ctx.args, "yes");
  ui.out(`${yes ? "Deleting" : "Would delete"}:`);
  ui.out(`  Worker ${res.worker}${state.url ? ` (${state.url})` : ""}`);
  for (const a of res.apps) ui.out(`  container app ${a.name} (${a.id})`);
  if (res.apps.length === 0) ui.out("  container apps: none found");
  ui.out(`  images: ${res.images.length} tag(s)`);
  for (const i of res.images) ui.out(`    ${i}`);
  if (!yes) {
    ui.out("Dry run. Run cf-orbs uninstall --yes to delete. Local files in .cf-orbs/ are kept.");
    ui.out(RETENTION_NOTE);
    ui.result({ ok: true, dryRun: true, ...res });
    return 0;
  }
  const errors: string[] = [];
  const del = async (args: string[], what: string) => {
    // CI=1: wrangler takes its confirm fallback (yes) without a prompt
    const r = await w.run(args, { timeoutMs: 120_000, env: { CI: "1" } });
    if (r.code === 0) ui.step(`deleted ${what}`);
    else errors.push(`${what}: ${oneLine(`${r.stderr} ${r.stdout}`).slice(-200)}`);
  };
  await del(["delete", res.worker], `Worker ${res.worker}`);
  for (const a of res.apps) await del(["containers", "delete", a.id], `container app ${a.name}`);
  for (const i of res.images)
    await del(["containers", "images", "delete", i, "--skip-confirmation"], `image ${i}`);
  ui.out(RETENTION_NOTE);
  ui.result({ ok: errors.length === 0, dryRun: false, ...res, errors });
  if (errors.length > 0) {
    for (const e of errors) ui.warn(e);
    throw new CliError(
      `${errors.length} delete(s) failed`,
      "rerun cf-orbs uninstall --yes; deleted items are skipped",
    );
  }
  ui.out("Uninstalled. Remove the project directory to delete local files.");
  return 0;
}
