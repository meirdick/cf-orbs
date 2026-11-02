// workers.dev subdomain check for init. A new account has none, and `wrangler deploy` with closed stdin
// cannot register one (its confirm takes the "no" fallback). So init registers it through the API with
// wrangler's own credentials. API: GET/PUT /accounts/<id>/workers/subdomain {subdomain}.
import type { Fetch } from "./api.js";
import { CliError, registerSecret } from "./errors.js";
import type { Wrangler } from "./wrangler.js";

const API = "https://api.cloudflare.com/client/v4";
export const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type SubdomainCheck = { kind: "has"; subdomain: string } | { kind: "none" } | { kind: "unknown" };

/** Bearer for the Cloudflare API from `wrangler auth token --json` (OAuth or API token). Never printed. */
export async function wranglerBearer(w: Wrangler): Promise<string | undefined> {
  const r = await w.run(["auth", "token", "--json"], { timeoutMs: 60_000 });
  if (r.code !== 0) return undefined;
  try {
    const j = JSON.parse(r.stdout.slice(Math.max(0, r.stdout.indexOf("{")))) as {
      type?: string;
      token?: string;
    };
    if (typeof j.token !== "string" || !j.token || (j.type !== "oauth" && j.type !== "api_token"))
      return undefined;
    registerSecret(j.token);
    return j.token;
  } catch {
    return undefined;
  }
}

interface CfEnvelope {
  success?: boolean;
  result?: { subdomain?: unknown } | null;
  errors?: { code?: number; message?: string }[];
}

async function call(f: Fetch, method: string, url: string, bearer: string, body?: unknown) {
  const res = await f(url, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  let j: CfEnvelope = {};
  try {
    j = (await res.json()) as CfEnvelope;
  } catch {}
  return { status: res.status, j };
}

const errMsg = (j: CfEnvelope) =>
  (j.errors ?? [])
    .map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim())
    .join("; ")
    .slice(0, 200);

export async function checkSubdomain(f: Fetch, accountId: string, bearer: string): Promise<SubdomainCheck> {
  try {
    const { status, j } = await call(f, "GET", `${API}/accounts/${accountId}/workers/subdomain`, bearer);
    const sub = j.result?.subdomain;
    if (status === 200 && j.success !== false && typeof sub === "string" && sub)
      return { kind: "has", subdomain: sub };
    if (status === 404 || /subdomain/i.test(errMsg(j))) return { kind: "none" };
    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

export async function registerSubdomain(
  f: Fetch,
  accountId: string,
  bearer: string,
  name: string,
): Promise<void> {
  const fix = `pick another name and rerun cf-orbs init --subdomain <name>, or open https://dash.cloudflare.com/${accountId}/workers/onboarding`;
  if (!SUBDOMAIN_RE.test(name))
    throw new CliError(
      `workers.dev subdomain ${JSON.stringify(name)} is not valid (a-z, 0-9, -; max 63)`,
      fix,
    );
  let r: Awaited<ReturnType<typeof call>>;
  try {
    r = await call(f, "PUT", `${API}/accounts/${accountId}/workers/subdomain`, bearer, { subdomain: name });
  } catch (e) {
    throw new CliError(`could not register workers.dev subdomain ${name} (${(e as Error).message})`, fix);
  }
  if (r.status >= 300 || r.j.success === false)
    throw new CliError(
      `could not register workers.dev subdomain ${name} (HTTP ${r.status}${errMsg(r.j) ? `: ${errMsg(r.j)}` : ""})`,
      fix,
    );
}

/** Default subdomain from the account name: lowercase, [a-z0-9-], max 63. */
export function suggestSubdomain(accountName: string | undefined): string {
  const s = (accountName ?? "")
    .toLowerCase()
    .replace(/'s account$/, "")
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  return s || "cf-orbs";
}
