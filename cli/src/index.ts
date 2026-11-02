// cf-orbs CLI entry: command table, help, global flags (--json, --non-interactive, --dir, --url).
import { resolve } from "node:path";
import { type FlagSpec, flagBool, flagString, type ParsedArgs, parseArgs } from "./args.js";
import { benchCommand } from "./commands/bench.js";
import { deployCommand } from "./commands/deploy.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { logsCommand } from "./commands/logs.js";
import { snapshotsCommand } from "./commands/snapshots.js";
import { statusCommand } from "./commands/status.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { upgradeCommand } from "./commands/upgrade.js";
import { type Ctx, makeCtx } from "./context.js";
import { CliError, toFailedLine } from "./errors.js";
import { cliVersion } from "./project.js";
import { makeUi } from "./ui.js";

const GLOBAL: FlagSpec = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  json: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  dir: { type: "string" },
  url: { type: "string" },
};

interface Command {
  usage: string;
  summary: string;
  flags: FlagSpec;
  /** extra help lines for cf-orbs <command> --help */
  details?: string[];
  /** first positional is the project dir (init [dir]) */
  dirPositional?: boolean;
  run: (ctx: Ctx) => Promise<number>;
}

export const COMMANDS: Record<string, Command> = {
  init: {
    usage: "init [dir]",
    summary: "Scaffold, deploy and health-check a provider (re-runnable).",
    details: [
      "--provider cloudflare|external   where amp orb provider runs (default cloudflare)",
      "--token-file <file>              Amp provider token file (else AMP_ORB_PROVIDER_TOKEN, else prompt)",
      "--account-id <id>                Cloudflare account (else CLOUDFLARE_ACCOUNT_ID, else ask)",
      "--provider-name <name>           Amp provider name, as in Amp Settings → Orbs (default cf-orbs)",
      "--subdomain <name>               workers.dev subdomain to register if the account has none",
      "--vcpu <1|2|3|4>                 orb size: N vCPU, N x 3 GiB, 20 GB disk (default 4; 2 is cheaper)",
      "--name <name>                    Worker name (default cf-orbs; a second install needs another)",
      "--no-deploy                      preview: no Docker, no deploy. Make a git repo for Workers Builds,",
      "                                 create the Worker and its secrets, print the dashboard steps",
    ],
    flags: {
      provider: { type: "string" },
      "token-file": { type: "string" },
      "account-id": { type: "string" },
      "provider-name": { type: "string" },
      subdomain: { type: "string" },
      vcpu: { type: "string" },
      name: { type: "string" },
      "no-deploy": { type: "boolean" },
    },
    dirPositional: true,
    run: initCommand,
  },
  deploy: {
    usage: "deploy",
    summary: "Regenerate wrangler.jsonc from the config and deploy.",
    flags: {},
    run: deployCommand,
  },
  status: {
    usage: "status [orb]",
    summary: "Install status, or one orb's state.",
    flags: {},
    run: statusCommand,
  },
  logs: {
    usage: "logs <orb> [--lines N] | logs --provider",
    summary: "Redacted bootstrap log of an orb, or the provider log.",
    flags: { lines: { type: "string" }, provider: { type: "boolean" } },
    run: logsCommand,
  },
  snapshots: {
    usage: "snapshots list|forget <id>|prune",
    summary: "List or forget project snapshot mappings; prune old snapshot data.",
    details: [
      "list                          mappings, sizes, expiry, and the snapshot index summary",
      "forget <ampSnapshotId>        drop one mapping; the next spawn with it boots the image and runs setup",
      "forget --all-project [--yes]  drop every mapping (asks first unless --yes)",
      "prune [--older-than 7d]       list snapshots no orb or mapping uses, unused that long (dry run)",
      "prune --all                   same, with no age limit (mapped snapshots and orb disks stay)",
      "prune ... --yes               delete them with wrangler containers images delete",
      "Amp keeps its own cache: delete it in Amp → Orb Settings → Snapshots after an image change.",
    ],
    flags: {
      "all-project": { type: "boolean" },
      all: { type: "boolean" },
      "older-than": { type: "string" },
      yes: { type: "boolean", short: "y" },
    },
    run: snapshotsCommand,
  },
  doctor: {
    usage: "doctor",
    summary: "Check the install; PASS/FAIL with a fix. Never starts anything.",
    flags: {},
    run: doctorCommand,
  },
  upgrade: {
    usage: "upgrade --digest sha256:<hex> [--no-deploy]",
    summary: "Move the orb image to a new Amp image digest; keep the old key.",
    flags: { digest: { type: "string" }, "no-deploy": { type: "boolean" } },
    run: upgradeCommand,
  },
  uninstall: {
    usage: "uninstall [--yes]",
    summary: "List (dry run) or delete the Worker, container apps and images.",
    flags: { yes: { type: "boolean", short: "y" } },
    run: uninstallCommand,
  },
  bench: {
    usage: "bench substrate",
    summary: "Substrate benchmark (runs from a repo clone: npm run bench:substrate).",
    flags: {},
    run: benchCommand,
  },
};

export function helpText(version: string): string {
  const w = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));
  const lines = [
    `cf-orbs ${version}: Amp orbs on Cloudflare Containers. Community project, not affiliated with Cloudflare or Amp.`,
    "",
    "Usage: cf-orbs <command> [options]",
    "",
    "Commands:",
    ...Object.values(COMMANDS).map((c) => `  ${c.usage.padEnd(w)}  ${c.summary}`),
    "",
    "Global options:",
    "  --dir <path>        project directory (default: current directory)",
    "  --url <url>         control-plane URL (default: .cf-orbs/state.json or CF_ORBS_URL)",
    "  --json              print one JSON document on stdout",
    "  --non-interactive   never prompt; read AMP_ORB_PROVIDER_TOKEN, CLOUDFLARE_ACCOUNT_ID from env",
    "  -h, --help          show help",
    "  -v, --version       show version",
    "",
    "Start: create a provider token in Amp (Settings → Orbs → Add Provider), then run npx cf-orbs init.",
  ];
  return lines.join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const version = await cliVersion();
  const cmdName = findCommand(argv);
  const cmd = cmdName ? COMMANDS[cmdName] : undefined;
  let args: ParsedArgs;
  const json = argv.includes("--json");
  const earlyUi = makeUi({ json, nonInteractive: true });
  try {
    if (cmdName && !cmd) throw new CliError(`unknown command ${cmdName}`, "run cf-orbs --help");
    args = parseArgs(argv, { ...GLOBAL, ...(cmd?.flags ?? {}) });
  } catch (e) {
    printError(earlyUi, e);
    return 2;
  }
  if (flagBool(args, "version")) {
    process.stdout.write(`${version}\n`);
    return 0;
  }
  if (!cmd || flagBool(args, "help")) {
    const details = cmd?.details ? `\nOptions:\n${cmd.details.map((d) => `  ${d}`).join("\n")}\n` : "";
    process.stdout.write(
      `${cmd ? `Usage: cf-orbs ${cmd.usage}\n\n${cmd.summary}\n${details}` : helpText(version)}\n`,
    );
    return 0;
  }
  args.positionals.shift(); // the command name
  const nonInteractive = flagBool(args, "non-interactive") || Boolean(process.env.CI) || !process.stdin.isTTY;
  const ui = makeUi({ json: flagBool(args, "json"), nonInteractive });
  let dir = flagString(args, "dir") ?? process.cwd();
  if (cmd.dirPositional && args.positionals[0]) dir = args.positionals.shift() as string;
  const ctx = makeCtx(ui, args, resolve(dir));
  try {
    return await cmd.run(ctx);
  } catch (e) {
    printError(ui, e);
    return 1;
  }
}

/** First positional, skipping the values of global string flags (--dir x, --url x). */
export function findCommand(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") return argv[i + 1];
    if (a.startsWith("-")) {
      const name = a.replace(/^-+/, "");
      if (!a.includes("=") && GLOBAL[name]?.type === "string") i++;
      continue;
    }
    return a;
  }
  return undefined;
}

function printError(ui: ReturnType<typeof makeUi>, e: unknown): void {
  const line = toFailedLine(e);
  if (process.env.CF_ORBS_DEBUG && e instanceof Error && e.stack) process.stderr.write(`${e.stack}\n`);
  if (ui.json) ui.result({ ok: false, error: line });
  else process.stderr.write(`${line}\n`);
}
