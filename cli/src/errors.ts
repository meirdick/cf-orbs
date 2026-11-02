// One error type for every user-facing failure: "Failed: <cause> — fix: <command or action>", one line.

export class CliError extends Error {
  constructor(
    readonly cause_: string,
    readonly fix: string,
  ) {
    super(`Failed: ${oneLine(cause_)} — fix: ${oneLine(fix)}`);
    this.name = "CliError";
  }
}

export function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

const secrets = new Set<string>();

/** Register a secret value so redact() removes it from every line the CLI prints. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(s: string): string {
  let out = s;
  for (const v of secrets) out = out.split(v).join("[redacted]");
  return out.replace(/aop_live_[A-Za-z0-9_-]+/g, "aop_live_[redacted]");
}

/** Turn any thrown value into one redacted "Failed: … — fix: …" line. */
export function toFailedLine(e: unknown): string {
  if (e instanceof CliError) return redact(e.message);
  const msg = e instanceof Error ? e.message : String(e);
  if (/^Failed: .* — fix: /.test(msg)) return redact(oneLine(msg));
  return redact(
    `Failed: ${oneLine(msg) || "unknown error"} — fix: rerun with CF_ORBS_DEBUG=1 and report the output`,
  );
}
