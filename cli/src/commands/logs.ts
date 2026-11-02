// cf-orbs logs <orb> [--lines N]: redacted bootstrap log tail and op progress of one orb.
// cf-orbs logs --provider: the provider's log tail.
import { checkOrbId, expectOk, providerInfo } from "../api.js";
import { flagBool, flagString } from "../args.js";
import { connect } from "../connect.js";
import type { Ctx } from "../context.js";
import { CliError } from "../errors.js";

export function logLines(body: unknown): string[] {
  if (typeof body === "string") return body === "" ? [] : body.replace(/\r?\n$/, "").split(/\r?\n/);
  if (Array.isArray(body)) return body.map(String);
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    for (const k of ["lines", "log", "logs", "logTail"]) {
      if (Array.isArray(o[k])) return (o[k] as unknown[]).map(String);
      if (typeof o[k] === "string") return logLines(o[k]);
    }
  }
  return [JSON.stringify(body)];
}

export async function logsCommand(ctx: Ctx): Promise<number> {
  const linesFlag = flagString(ctx.args, "lines") ?? "200";
  const n = Number.parseInt(linesFlag, 10);
  if (!Number.isInteger(n) || n < 1 || n > 5000)
    throw new CliError(`--lines must be 1-5000, got ${linesFlag}`, "pass --lines 200");
  const provider = flagBool(ctx.args, "provider");
  const id = ctx.args.positionals[0];
  if (!provider && !id)
    throw new CliError(
      "no orb id given",
      "run cf-orbs logs <orb id> (ids from cf-orbs status) or cf-orbs logs --provider",
    );
  const { api } = await connect(ctx);
  // provider: the Worker returns the provider log tail (last 20 lines, redacted) inside /v1/status
  const body = provider
    ? providerInfo(expectOk(await api.get("/v1/status"), "provider logs")).logTail.slice(-n)
    : expectOk(
        await api.get(`/v1/orbs/${encodeURIComponent(checkOrbId(id as string))}/logs?lines=${n}`),
        `logs of ${id}`,
      );
  const lines = logLines(body);
  ctx.ui.result({ lines });
  for (const l of lines) ctx.ui.out(l);
  return 0;
}
