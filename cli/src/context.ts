// What every command gets. Injected so tests can swap the process runner and fetch.

import type { Fetch } from "./api.js";
import type { ParsedArgs } from "./args.js";
import { type ProjectPaths, projectPaths } from "./project.js";
import type { Ui } from "./ui.js";
import { type Runner, runProcess } from "./wrangler.js";

export interface Ctx {
  ui: Ui;
  args: ParsedArgs;
  paths: ProjectPaths;
  run: Runner;
  fetch: Fetch;
  env: NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** cli/templates override (tests) */
  templates?: string;
}

export function makeCtx(ui: Ui, args: ParsedArgs, dir: string, over: Partial<Ctx> = {}): Ctx {
  return {
    ui,
    args,
    paths: projectPaths(dir),
    run: runProcess,
    fetch: globalThis.fetch,
    env: process.env,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    ...over,
  };
}
