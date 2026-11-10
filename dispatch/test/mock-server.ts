// node:http mock of the control API op protocol (D11) for dispatch.sh contract tests.
// POST /v1/orbs/:orbId/ops → {opId, attached}; GET /v1/ops/:opId?wait=N → op status.
// Also accepts absolute-form request targets, so it can act as an HTTP proxy for http://control.internal.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { replyText } from "../../worker/src/core/text";
import type { OpPhase, OpRecord, OpRequest } from "../../worker/src/core/types";
import { redactLine } from "../../worker/src/orb/journal";

export interface MockPoll {
  phase: OpPhase;
  progress: string[];
  error?: string;
  /** Extra fields merged into the GET reply (to test the dispatch JSON reader). */
  extra?: Record<string, unknown>;
}

export interface MockScenario {
  attached?: boolean;
  opId?: string;
  /** Replies to GET in order; the last one repeats. Default: one succeeded poll. */
  polls?: MockPoll[];
  /** Every GET holds for min(wait, holdMaxMs) and answers phase "running". */
  neverFinish?: boolean;
  holdMaxMs?: number;
  /** Status and raw body for the first N POSTs (then normal). */
  postFailures?: { status: number; body: string }[];
  /** Status and raw body for every POST (overrides the normal reply). */
  postReply?: { status: number; body: string };
  /** Status and raw body for every GET (overrides polls). */
  getReply?: { status: number; body: string };
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  host: string;
  authorization?: string;
  contentType?: string;
  rawBody: string;
  body?: OpRequest;
  orbId?: string;
}

export interface MockServer {
  url: string;
  port: number;
  requests: RecordedRequest[];
  scenario: MockScenario;
  /** Bodies of every POST op, in order. */
  posts(): RecordedRequest[];
  gets(): RecordedRequest[];
  close(): Promise<void>;
}

function sendRaw(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/** ?format=text: answer as the Worker does (core/text.ts). A body that is not JSON goes out as it is. */
function sendAs(target: URL, res: ServerResponse, status: number, body: string): void {
  if (target.searchParams.get("format") !== "text") return sendRaw(res, status, body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendRaw(res, status, body);
  }
  const since = Number(target.searchParams.get("since") ?? "0") || 0;
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(replyText(parsed, since, redactLine));
}

export async function startMockServer(scenario: MockScenario = {}): Promise<MockServer> {
  const requests: RecordedRequest[] = [];
  let pollIndex = 0;
  let postCount = 0;
  const state = { scenario };
  const timers = new Set<NodeJS.Timeout>();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const target = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const rec: RecordedRequest = {
      method: req.method ?? "",
      path: target.pathname,
      query: target.searchParams,
      host: target.hostname,
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"],
      rawBody,
    };
    requests.push(rec);
    const sc = state.scenario;
    const send = (r: ServerResponse, status: number, body: string) => sendAs(target, r, status, body);

    const post = target.pathname.match(/^\/v1\/orbs\/([^/]+)\/ops$/);
    if (req.method === "POST" && post) {
      rec.orbId = decodeURIComponent(post[1] ?? "");
      try {
        rec.body = JSON.parse(rawBody) as OpRequest;
      } catch {
        return send(res, 400, JSON.stringify({ error: "bad json" }));
      }
      const failure = sc.postFailures?.[postCount];
      postCount++;
      if (failure) return send(res, failure.status, failure.body);
      if (sc.postReply) return send(res, sc.postReply.status, sc.postReply.body);
      const opId = sc.opId ?? `${rec.orbId}:3f2a9c1e-0000-4000-8000-000000000001`;
      return send(res, 202, JSON.stringify({ opId, attached: sc.attached ?? false }));
    }

    const get = target.pathname.match(/^\/v1\/ops\/([^/]+)$/);
    if (req.method === "GET" && get) {
      if (sc.getReply) return send(res, sc.getReply.status, sc.getReply.body);
      const opId = decodeURIComponent(get[1] ?? "");
      const wait = Number(target.searchParams.get("wait") ?? "0");
      const base: Omit<OpRecord, "phase" | "progress"> = {
        opId,
        orbId: opId.split(":")[0] ?? "",
        op: "spawn",
        inputsHash: "0".repeat(64),
        startedAt: new Date(0).toISOString(),
      };
      if (sc.neverFinish) {
        const ms = Math.min(wait * 1000, sc.holdMaxMs ?? 1000);
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            timers.delete(t);
            r();
          }, ms);
          timers.add(t);
        });
        return send(res, 200, JSON.stringify({ ...base, phase: "running", progress: ["still working"] }));
      }
      const polls = sc.polls ?? [{ phase: "succeeded", progress: ["ok"] }];
      const p = polls[Math.min(pollIndex, polls.length - 1)] as MockPoll;
      pollIndex++;
      const reply: Record<string, unknown> = { ...base, phase: p.phase, progress: p.progress, ...p.extra };
      if (p.error !== undefined) reply.error = p.error;
      return send(res, 200, JSON.stringify(reply));
    }

    send(res, 404, JSON.stringify({ error: "not found" }));
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => sendRaw(res, 500, JSON.stringify({ error: "mock crashed" })));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    get scenario() {
      return state.scenario;
    },
    set scenario(s: MockScenario) {
      state.scenario = s;
    },
    posts: () => requests.filter((r) => r.method === "POST"),
    gets: () => requests.filter((r) => r.method === "GET"),
    close: async () => {
      for (const t of timers) clearTimeout(t);
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
