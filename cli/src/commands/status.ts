// cf-orbs status [orb]: install status or one orb. Reads /v1/status or /v1/orbs/:id. No secrets in output.
import { checkOrbId, expectOk, providerInfo } from "../api.js";
import { connect } from "../connect.js";
import type { Ctx } from "../context.js";
import { fmtAge, fmtBytes, table } from "../ui.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string =>
  v === undefined || v === null ? "-" : typeof v === "string" ? v : JSON.stringify(v);

/** "warm (8m left)" for a warm orb, else the state. */
export function stateText(orb: Obj, now: number): string {
  const st = str(orb.state);
  if (st !== "warm" || typeof orb.warmUntil !== "string") return st;
  const t = Date.parse(orb.warmUntil);
  if (!Number.isFinite(t)) return st;
  return `warm (${fmtAge(new Date(now - Math.max(0, t - now)).toISOString(), now)} left)`;
}

/** Accepts OrbStatus ({orb: OrbRecord, ...}) or a bare OrbRecord. */
export function orbRow(v: unknown, now: number): string[] {
  const s = obj(v);
  const orb = s.orb ? obj(s.orb) : s;
  const handle = obj(orb.handle);
  const lastStop = obj(orb.lastStop);
  return [
    str(orb.orbId),
    stateText(orb, now),
    s.containerRunning === undefined ? "-" : s.containerRunning ? "yes" : "no",
    str(orb.imageKey),
    diskText(v),
    handle.createdAt ? fmtAge(String(handle.createdAt), now) : "-",
    handle.size === undefined ? "-" : fmtBytes(Number(handle.size)),
    lastStop.at ? `${fmtAge(String(lastStop.at), now)} ago ${str(lastStop.reason)}` : "-",
  ];
}

/** "sha256:0123456789ab" from a deployed image ref with a digest, else its last path part. */
export function shortImage(ref: unknown): string {
  if (typeof ref !== "string" || ref === "") return "-";
  const d = /@(sha256:[0-9a-f]{1,12})/.exec(ref);
  return d ? (d[1] as string) : ref.slice(ref.lastIndexOf("/") + 1);
}

/** Table cell for an orb's disk image: STALE, current, unknown, or "-" when there is no disk. */
export function diskText(v: unknown): string {
  const s = obj(v);
  const orb = s.orb ? obj(s.orb) : s;
  const handle = obj(orb.handle);
  if (!handle.id) return "-";
  if (s.diskImageStale === true) return "STALE";
  if (typeof s.diskImageRef !== "string" || s.diskImageRef === "") return "unknown";
  return typeof s.currentImageRef === "string" && s.currentImageRef !== "" ? "current" : "key missing";
}

/** "sha256:… (current)", "sha256:… (old; current sha256:…)" or unknown for one orb. */
export function diskImageText(v: unknown): string {
  const s = obj(v);
  const orb = s.orb ? obj(s.orb) : s;
  const handle = obj(orb.handle);
  if (!handle.id) return "-";
  const ref = (x: unknown) => (typeof x === "string" && x !== "" ? shortImage(x) : undefined);
  const disk = ref(s.diskImageRef);
  const current = ref(s.currentImageRef);
  if (s.diskImageStale === true) return `${disk ?? "unknown"} (old; current ${current ?? "unknown"})`;
  if (disk) return current ? `${disk} (current)` : `${disk} (image key not deployed)`;
  return "unknown (saved before disk-image tracking)";
}

/** Per project snapshot: age, amp version seen at the pause, image digest, stale flag (projectSnapshotRefresh). */
export function projectLines(projects: unknown, now: number): string[] {
  if (!Array.isArray(projects) || projects.length === 0) return [];
  const rows = projects.map(obj);
  const lines = [
    table(
      ["PROJECT SNAPSHOT", "AGE", "AMP", "IMAGE", "STALE"],
      rows.map((p) => {
        const st = obj(p.stale);
        return [
          str(p.snapshotId),
          p.createdAt ? fmtAge(String(p.createdAt), now) : "-",
          str(p.ampVersion),
          shortImage(p.imageRef),
          p.stale
            ? st.forgotten
              ? "yes, forgotten"
              : "yes, kept (24 h limit)"
            : p.expired
              ? "expired"
              : "no",
        ];
      }),
    ),
  ];
  for (const p of rows) {
    if (!p.stale) continue;
    const st = obj(p.stale);
    lines.push(
      `project snapshot ${str(p.snapshotId)} stale since ${str(st.at)} (${str(st.reason)}): delete it in Amp settings to re-prepare`,
    );
  }
  return lines;
}

export function renderStatus(status: unknown, now = Date.now()): string {
  const s = obj(status);
  const reg = obj(s.registry);
  const lines: string[] = [];
  const p = providerInfo(status);
  lines.push(
    `provider: ${p.running === undefined ? "unknown" : p.running ? "running" : p.stopped ? "stopped (by cf-orbs)" : "not running"}` +
      (p.startedAt ? `, started ${fmtAge(p.startedAt, now)} ago (${p.startedAt})` : "") +
      (p.restarts !== undefined ? `, restarts ${p.restarts}` : "") +
      (p.image ? `, image ${shortImage(p.image)}` : ""),
  );
  if (p.running && p.deployedBuild && p.build !== p.deployedBuild)
    lines.push(
      `provider image: the deploy has a new one (${shortImage(p.deployedImage)}); the 5-min check restarts the provider`,
    );
  if (p.lastLogLine) lines.push(`provider log: ${p.lastLogLine}`);
  if (p.lastError) lines.push(`provider error: ${p.lastError}`);
  if (typeof reg.error === "string") lines.push(`registry error: ${reg.error}`);
  if (reg.retainedSnapshots !== undefined) {
    lines.push(
      `snapshots: ${str(reg.retainedSnapshots)} retained, ${fmtBytes(Number(reg.retainedSnapshotBytes))}` +
        `, ${str(reg.projectSnapshots)} project snapshot(s)` +
        (reg.nextExpiry ? `, next expiry ${str(reg.nextExpiry)}` : ""),
    );
  }
  const prunable = Number(reg.prunableSnapshots);
  if (prunable > 0)
    lines.push(
      `prunable: ${prunable} (${fmtBytes(Number(reg.prunableSnapshotBytes))}); see cf-orbs snapshots prune`,
    );
  const pw = prewarmText(s.prewarm, now);
  if (pw) lines.push(pw);
  const projects = projectLines(reg.projects, now);
  if (projects.length > 0) lines.push("", ...projects, "");
  const running = Array.isArray(reg.running) ? reg.running.map(String) : undefined;
  if (running) {
    lines.push(`awake orbs: ${running.length} of ${str(reg.max)}`);
    for (const id of running) lines.push(`  ${id}`);
  }
  // per-orb rows, if the Worker includes them
  const orbs = Array.isArray(s.orbs) ? s.orbs : [];
  if (orbs.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["ORB", "STATE", "RUNNING", "IMAGE", "DISK", "SNAP AGE", "SNAP SIZE", "LAST STOP"],
        orbs.map((o) => orbRow(o, now)),
      ),
    );
  }
  if (running && running.length > 0) lines.push("Details: cf-orbs status <orb>");
  return lines.join("\n");
}

const secs = (ms: unknown) => `${Math.round(Number(ms) / 1000)} s`;

/** "41 s", "41 s and 39 s", "41 s, 39 s and 40 s" */
function andList(xs: string[]): string {
  if (xs.length <= 1) return xs.join("");
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/**
 * Last prewarm run from /v1/status "prewarm" (WarmRunView), or undefined when there is none.
 * "prewarm: 2 of 2 ready in 41 s and 39 s, 3m ago"
 */
export function prewarmText(v: unknown, now: number): string | undefined {
  const w = obj(v);
  if (typeof w.error === "string") return `prewarm: ${w.error}`;
  if (typeof w.count !== "number" || typeof w.at !== "string") return undefined;
  const ms = Array.isArray(w.msPerInstance) ? w.msPerInstance : [];
  let t = `prewarm: ${str(w.ok)} of ${w.count} ready`;
  if (ms.length > 0) t += ` in ${andList(ms.map(secs))}`;
  const failed = Number(w.failed) || 0;
  if (failed > 0) {
    const jobs = Array.isArray(w.jobs) ? w.jobs.map(obj) : [];
    const why = jobs.find((j) => j.state === "failed" && typeof j.error === "string")?.error;
    t += `, ${failed} failed${why ? ` (${String(why)})` : ""}`;
  }
  const pending = Number(w.pending) || 0;
  if (pending > 0) t += `, ${pending} still starting`;
  return `${t}, ${fmtAge(w.at, now)} ago`;
}

export function renderOrb(status: unknown, now = Date.now()): string {
  const s = obj(status);
  const orb = obj(s.orb);
  const handle = obj(orb.handle);
  const rows: [string, string][] = [
    ["orb", str(orb.orbId)],
    ["state", stateText(orb, now)],
    ...(orb.warmUntil ? ([["warm until", str(orb.warmUntil)]] as [string, string][]) : []),
    ["container running", s.containerRunning === undefined ? "-" : String(s.containerRunning)],
    [
      "bootstrap",
      s.bootstrap ? `${obj(s.bootstrap).alive ? "alive" : "dead"} pid ${str(obj(s.bootstrap).pid)}` : "-",
    ],
    ["image key", str(orb.imageKey)],
    ["disk image", diskImageText(s)],
    ["instance", str(orb.instance)],
    ["awake since", orb.awakeSince ? `${str(orb.awakeSince)} (${fmtAge(String(orb.awakeSince), now)})` : "-"],
    ["last wake source", str(orb.lastWakeSource)],
    ["last spawn", orb.lastSpawnMs === undefined ? "-" : `${(Number(orb.lastSpawnMs) / 1000).toFixed(1)} s`],
    ["recent spawns", spawnsText(orb.spawns)],
    ["DO colo", str(s.doColo)],
    [
      "snapshot",
      handle.id
        ? `${str(handle.id)} ${fmtBytes(Number(handle.size))}, age ${fmtAge(String(handle.createdAt), now)}`
        : "-",
    ],
    ["snapshot expires", str(s.snapshotExpiresAt)],
    ["last stop", orb.lastStop ? `${str(obj(orb.lastStop).at)} ${str(obj(orb.lastStop).reason)}` : "-"],
    [
      "in-flight op",
      s.inFlightOp
        ? `${str(obj(s.inFlightOp).op)} ${str(obj(s.inFlightOp).phase)} since ${str(obj(s.inFlightOp).startedAt)}`
        : "-",
    ],
  ];
  const w = Math.max(...rows.map((r) => r[0].length));
  return rows.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join("\n");
}

/** Last spawns, newest first: "2.3 s per-orb-snapshot, 45.1 s image, FAILED image". */
function spawnsText(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) return "-";
  return [...v]
    .reverse()
    .slice(0, 5)
    .map((e) => {
      const x = obj(e);
      const src = str(x.source);
      return x.ok ? `${(Number(x.ms) / 1000).toFixed(1)} s ${src}` : `FAILED ${src}`;
    })
    .join(", ");
}

export async function statusCommand(ctx: Ctx): Promise<number> {
  const { api } = await connect(ctx);
  const id = ctx.args.positionals[0];
  if (id) {
    const body = expectOk(await api.get(`/v1/orbs/${encodeURIComponent(checkOrbId(id))}`), `status of ${id}`);
    ctx.ui.result(body);
    ctx.ui.out(renderOrb(body, ctx.now()));
    return 0;
  }
  const body = expectOk(await api.get("/v1/status"), "status");
  ctx.ui.result(body);
  ctx.ui.out(renderStatus(body, ctx.now()));
  return 0;
}
