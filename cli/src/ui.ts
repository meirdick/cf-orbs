// Output helpers. Progress goes to stderr; results go to stdout (so --json stdout is pure JSON).
import { redact } from "./errors.js";

export interface Ui {
  json: boolean;
  nonInteractive: boolean;
  /** progress line (stderr) */
  step(line: string): void;
  /** warning line (stderr) */
  warn(line: string): void;
  /** result text (stdout); suppressed in --json mode */
  out(line: string): void;
  /** final JSON document (stdout); only in --json mode */
  result(value: unknown): void;
  /** raw passthrough of child output (stderr); suppressed in --json mode */
  raw(chunk: string): void;
}

export function makeUi(opts: { json: boolean; nonInteractive: boolean }): Ui {
  return {
    json: opts.json,
    nonInteractive: opts.nonInteractive,
    step: (l) => process.stderr.write(`${redact(l)}\n`),
    warn: (l) => process.stderr.write(`warning: ${redact(l)}\n`),
    out: (l) => {
      if (!opts.json) process.stdout.write(`${redact(l)}\n`);
    },
    result: (v) => {
      if (opts.json) process.stdout.write(`${redact(JSON.stringify(v, null, 2))}\n`);
    },
    raw: (c) => {
      if (!opts.json) process.stderr.write(redact(c));
    },
  };
}

/** Plain text table. Columns sized to content. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) =>
    r
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [fmt(headers), fmt(widths.map((w) => "-".repeat(w))), ...rows.map(fmt)].join("\n");
}

export function fmtBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return "-";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} kB`;
  return `${n} B`;
}

export function fmtAge(iso: string | undefined, now = Date.now()): string {
  if (!iso) return "-";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "-";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172_800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** Ask a question on the TTY. Returns the trimmed answer. */
export async function ask(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Read a secret from the TTY without echo. Ctrl-C aborts. */
export async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  if (!stdin.isTTY) {
    // piped input: read one line
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: stdin });
    const line = await new Promise<string>((res) => rl.once("line", res).once("close", () => res("")));
    rl.close();
    process.stderr.write("\n");
    return line.trim();
  }
  return new Promise<string>((resolve, reject) => {
    let buf = "";
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          done();
          process.stderr.write("\n");
          resolve(buf.trim());
          return;
        }
        if (ch === "\u0003") {
          done();
          process.stderr.write("\n");
          reject(new Error("Failed: cancelled — fix: run the command again"));
          return;
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}
