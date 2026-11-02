// Small argv parser. Supports --flag, --flag=value, --flag value, --no-flag, -h, and "--" to end flags.
import { CliError } from "./errors.js";

export type FlagSpec = Record<string, { type: "boolean" | "string"; short?: string }>;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[], spec: FlagSpec): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const byShort = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) if (s.short) byShort.set(s.short, name);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      let name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let inline: string | undefined = eq === -1 ? undefined : a.slice(eq + 1);
      let negated = false;
      if (!spec[name] && name.startsWith("no-") && spec[name.slice(3)]?.type === "boolean") {
        name = name.slice(3);
        negated = true;
      }
      const s = spec[name];
      if (!s) throw new CliError(`unknown flag --${name}`, "run cf-orbs --help");
      if (s.type === "boolean") {
        if (inline !== undefined) {
          if (!/^(true|false|1|0)$/.test(inline))
            throw new CliError(`--${name} takes no value`, `use --${name} or --no-${name}`);
          flags[name] = negated !== (inline === "true" || inline === "1");
        } else flags[name] = !negated;
        continue;
      }
      if (negated) throw new CliError(`--no-${name} is not valid`, `pass --${name} <value>`);
      if (inline === undefined) {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith("-") && next !== "-")) {
          throw new CliError(`--${name} needs a value`, `pass --${name} <value>`);
        }
        inline = next;
        i++;
      }
      flags[name] = inline;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      const name = byShort.get(a.slice(1));
      if (!name) throw new CliError(`unknown flag ${a}`, "run cf-orbs --help");
      const s = spec[name];
      if (s?.type === "boolean") flags[name] = true;
      else {
        const next = argv[i + 1];
        if (next === undefined) throw new CliError(`${a} needs a value`, `pass ${a} <value>`);
        flags[name] = next;
        i++;
      }
      continue;
    }
    positionals.push(a);
  }
  return { positionals, flags };
}

export function flagString(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function flagBool(p: ParsedArgs, name: string): boolean {
  return p.flags[name] === true;
}
