// cf-orbs bench substrate: the harness lives in the repo (bench/substrate.ts); this points to it until the CLI wraps it.
import type { Ctx } from "../context.js";

const HOWTO =
  'cf-orbs bench: run the harness from a clone of the cf-orbs repo: npm run bench:substrate -- --dir <this directory> (needs "debugExec": true)';

export async function benchCommand(ctx: Ctx): Promise<number> {
  ctx.ui.out(HOWTO);
  ctx.ui.result({ ok: true, message: HOWTO });
  return 0;
}
