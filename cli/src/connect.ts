// Resolve the control-plane URL and token for status/logs/doctor.
// URL order: --url, CF_ORBS_URL, .cf-orbs/state.json (written by init/deploy from wrangler deploy output).
import { type ApiClient, makeApi } from "./api.js";
import { flagString } from "./args.js";
import type { Ctx } from "./context.js";
import { CliError } from "./errors.js";
import { readState, requireControlToken, type State } from "./project.js";

export function resolveUrl(ctx: Ctx, state: State): string | undefined {
  return flagString(ctx.args, "url") ?? ctx.env.CF_ORBS_URL ?? state.url;
}

export async function connect(ctx: Ctx): Promise<{ api: ApiClient; state: State }> {
  const state = await readState(ctx.paths);
  const url = resolveUrl(ctx, state);
  if (!url)
    throw new CliError(
      `no control-plane URL in ${ctx.paths.state}`,
      "run cf-orbs init (or cf-orbs deploy), or pass --url https://<name>.<subdomain>.workers.dev",
    );
  if (!/^https?:\/\//.test(url))
    throw new CliError(`bad URL ${url}`, "pass --url https://<name>.<subdomain>.workers.dev");
  const token = await requireControlToken(ctx.paths);
  return { api: makeApi(url, token, ctx.fetch), state };
}
