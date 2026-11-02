# cf-orbs

Run [Amp](https://ampcode.com) orbs on your own Cloudflare account. cf-orbs is a self-hosted Amp orb provider built on Cloudflare Containers. You install it with one command.

Community project. Not affiliated with Cloudflare or Amp (Sourcegraph). "Cloudflare" and "Amp" are trademarks of their owners.

## Why cf-orbs

Measured against Amp-hosted orbs and Amp's reference providers for Docker, E2B and Vercel, same prompt, same project, same night (2026-10-31, [full table](https://cf-orbs-site.mdick85.workers.dev/#compare), [method](docs/benchmarks.md)):

- **Fast new threads.** Project snapshots skip `.agents/setup`: about 12 s of orb setup before the first turn, against 36-45 s for the E2B and Vercel reference scripts, which rebuild the repo every thread.
- **Fast wake.** Warm pause keeps the orb and its Amp executor alive for 10 min after Amp pauses it (snapshot taken first, `warmMinutes` to change). A follow-up in that window runs its first tool in 0.3-0.5 s; Amp-hosted takes 0.85 s, a cold restore 1.5-2 s plus process start.
- **Fast network.** git clone 0.26 s, npm install of express 7.7 s; Amp-hosted a1.small 0.54 s and 15.2 s; E2B 0.44 s and 10.1 s.
- **Same interactive speed.** Tool round trips on a live orb are 0.8-0.9 s on every provider.
- **Reliable.** 10 of 10 threads in every benchmark round. A lost orb comes back in 22 s and the agent retries. Paused orbs restore after an image rebuild.
- **Cheapest cloud option at this size.** About $0.11/h running idle and $0.17/h at 20% CPU for 4 vCPU / 12 GiB / 20 GB; no compute charge while paused (snapshot storage has no published rate yet). Amp-hosted a1.small is $0.17/h for 2 CPU / 4 GiB; E2B about $0.33/h for 4 vCPU / 8 GiB.
- **Yours.** One CLI, no cluster, no extra API keys. Orbs, snapshots and logs stay in your Cloudflare account.

Known limits, measured: writes of new data on the root disk are slower (512 MB with fsync 0.9 s with `hugePages`, was 1.3 s; Amp-hosted 0.6 s; use `/mnt/fast` for caches, see `fastTmpfsGb`); 4 vCPU / 12 GiB / 20 GB per orb; the first spawn on a new Cloudflare host pulls the 1.8 GB image (40-50 s, then cached). Details in [docs/05](docs/benchmarks.md).

## What it is

An Amp orb is the machine where an Amp agent runs its tools: it clones your repo, runs commands and edits files. Amp runs orbs on its own servers by default. With a self-hosted provider, the orbs run on your infrastructure instead.

cf-orbs makes each orb a Cloudflare Container: a microVM with its own kernel, network and disk, started from Amp's orb image. It has three parts, all in your Cloudflare account:

- **A Worker** (`cf-orbs`) with Durable Objects. It starts, pauses and deletes orbs and keeps track of their snapshots.
- **A provider container.** It runs `amp orb provider`, which takes orb jobs from Amp over an outbound connection.
- **The orbs.** One container per Amp thread.

When Amp pauses an orb, cf-orbs saves the disk as a snapshot and stops the container, so a paused orb has no compute charge. The next message restores the disk. Amp project snapshots work too: a new thread on a known repo starts from the disk that Amp already set up.

## Prerequisites

| You need | Check |
| --- | --- |
| Node 22 or later (wrangler 4 needs it) | `node --version` |
| Docker, running. wrangler builds the orb image on your machine | `docker info` |
| A Cloudflare account on **Workers Paid** ($5/month; Containers need it) | Dashboard → Workers & Pages → Plans |
| wrangler logged in to that account | `npx wrangler login`, then `npx wrangler whoami` |
| An Amp provider token (`aop_live_…`) | Amp → Settings → Orbs → Add Provider. Note the provider name you type there |

A personal provider needs no workspace admin. Make it in your personal Amp settings.

## Quick start

```sh
mkdir my-orbs && cd my-orbs
npx cf-orbs init --provider-name <name from Amp>
```

`init` asks for the Amp provider token. It does not show what you type, and the token does not go into your shell history.

Measured on 2026-10-30 in an empty directory: **4 min 41 s** from `init` to a running provider. That includes the push of the 1.8 GB orb image (the whole deploy took 247 s). A slow uplink takes longer. The Cloudflare registry sometimes times out on a large push, or answers `Unauthorized` after image preparation. `init` retries both automatically, up to 3 times, and keeps the layers that it already pushed.

What `init` does:

1. Checks Node, Docker, the wrangler login and the account.
2. Writes `cf-orbs.config.jsonc`, `image/Dockerfile` and `.cf-orbs/` (generated files, the control token and state).
3. Registers a workers.dev subdomain if the account has none (it asks for a name, or takes `--subdomain`).
4. Runs `wrangler deploy`: builds and pushes the orb image and the provider image, then deploys the Worker.
5. Checks `/v1/health` and `/v1/status`.
6. Starts the provider and waits until it runs for 15 s with a clean log.
7. Prints a command to try:

```sh
amp -ox "hello from cf-orbs" --orb-provider <name>
```

The name after `--orb-provider` must match the provider name in Amp Settings. In the Amp app, pick the provider under **Self-Hosted** when you start a thread.

`init` is safe to run again. It keeps the control token, and it keeps the Amp token secret unless you give a new one.

Non-interactive (CI or an agent): put the token in a file with mode 600 and pass `--token-file`. In CI, `AMP_ORB_PROVIDER_TOKEN` from a secret store also works.

```sh
npx cf-orbs init --non-interactive --token-file <file> --provider-name <name> --subdomain <name> \
  --account-id <id>   # only if wrangler sees more than one account
```

Orb size: `init` writes 4 vCPU, 12 GiB, 20 GB disk. For a cheaper orb add `--vcpu 2` (2 vCPU, 6 GiB, about half the memory cost). `--vcpu <1|2|3|4>` writes N vCPU and N x 3 GiB. For any other size, edit `instance` in `cf-orbs.config.jsonc`.

An AI agent that installs cf-orbs for you can follow [AGENTS.md](AGENTS.md).

### From a clone

To run the CLI from source (for development, or to try a change):

```sh
git clone https://github.com/meirdick/cf-orbs && cd cf-orbs
npm ci && npm run build -w cli
mkdir ../my-orbs
node cli/bin/cf-orbs.js init ../my-orbs --provider-name <name>   # asks for the token
```

Then use `node <repo>/cli/bin/cf-orbs.js` wherever this README says `cf-orbs`, with `--dir ../my-orbs` or from inside that directory.

## What you get

- Orbs that run on your Cloudflare account. The repo checkout, build output and saved disks stay there.
- One orb size per install. Default: 4 vCPU, 12 GiB memory, 20 GB disk. Set it with `init --vcpu` or in `cf-orbs.config.jsonc`.
- Pause and resume through disk snapshots, and Amp project snapshots for fast new threads.
- A watchdog: it pauses an orb that stays awake longer than `maxAwakeHours` (default 12) and caps awake orbs at `maxRunning` (default 20).
- `status`, `logs` and `doctor` commands. Every failure is one line: `Failed: <cause> — fix: <what to do>`.

## Pause and resume

Amp decides when an orb pauses: after the agent is idle and nobody interacts with the thread for about 20 minutes (we saw 20-25 min). An archived thread pauses too. A deleted thread deletes its orb.

On pause, cf-orbs stops the Amp processes, takes a snapshot of the disk and stops the container. On the next message, Amp sends a spawn and cf-orbs restores the disk. Measured: spawn from a snapshot in 2.3 s (container ready in 0.6 s).

| Kept | Lost |
| --- | --- |
| Files, the repo, installed packages, build caches (everything on the disk) | Running processes: dev servers, watchers, terminal sessions |
| | Memory |

Warm pause (`warmMinutes`, default 10): cf-orbs saves the disk at the pause but keeps the container and Amp's processes running for 10 more minutes. A message in that time reuses them: no restore, no restart. After that the orb stops. A warm orb counts toward `maxRunning` and is billed like an awake orb. `cf-orbs status` shows `warm` and the time left.

Amp runs `.agents/resume` on wake, and portal services restart when you open them. Amp-hosted orbs keep memory across a pause; cf-orbs does not.

Other things to know:

- A paused orb can wake when somebody views its thread, with no new message. It pauses again later.
- A snapshot is kept for 30 days after its last restore. An orb paused longer than that starts fresh, and Amp sets up the repo again.
- Each pause makes a new snapshot, and storage is billed. `cf-orbs snapshots prune` lists the old ones that no orb uses; `--yes` deletes them through `wrangler containers images delete` (works, but Cloudflare does not document it). `cf-orbs status` shows `prunable: N (X GB)`.
- Work done after the last pause can be lost if Cloudflare stops a container without warning. To limit that, set `checkpointMinutes` (15 or more) to snapshot awake orbs that have changes.
- The restore is lazy. The first read of a large build cache after a wake is slower than later reads (about 230 MB/s).
- A project snapshot goes stale after an Amp CLI release (each new thread then spends 4-5 s on the amp update) or after a `cf-orbs deploy` with a new image. With `projectSnapshotRefresh: "on-change"`, cf-orbs checks for this when a new thread starts from the snapshot. If it is stale, cf-orbs forgets the mapping (at most once per project per 24 h), so the next new thread boots the image and Amp runs setup.
- This is off by default because cf-orbs never starts threads or orbs for it, so nothing extra shows in your Amp UI. Also, Amp does not always save a new snapshot after a forget. Until it does, each new thread runs setup, and `cf-orbs status` shows the snapshot as stale.
- To do it by hand: delete the cached snapshot in Amp → Orb Settings → Snapshots, then run `cf-orbs snapshots forget --all-project`.

## Costs

Rates: [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) and [Amp orb pricing](https://ampcode.com/docs/orbs/sizes-and-costs). Measured speed and cost: [docs/benchmarks.md](docs/benchmarks.md).

| Item | Cost (USD) |
| --- | --- |
| Workers Paid plan | $5.00/month |
| Provider container (`lite`, always on) | ~$2.01/month |
| Default orb (4 vCPU, 12 GiB, 20 GB), awake | $0.113/h fixed + CPU: ~$0.171/h at 20% CPU, ~$0.401/h at 100% |
| Orb with `--vcpu 2` (2 vCPU, 6 GiB, 20 GB), awake | $0.059/h fixed + CPU: ~$0.088/h at 20% CPU, ~$0.203/h at 100% |
| Paused orb | No compute charge. Snapshot storage price is not published yet (beta) |
| Egress | $0.025/GB in NA/EU after the first 1 TB |
| Amp fee | $0 on non-Enterprise workspaces. Enterprise workspaces pay Amp's self-hosted orb rate |

Example: 120 awake hours a month at 20% CPU costs about $27.50 a month in total on the default size, or $17.55 with `--vcpu 2`. Amp-hosted a1.small (2 vCPU, 4 GiB) is $20.40 and a1.medium (4 vCPU, 8 GiB) is $39.60 for the same hours. On an Enterprise workspace cf-orbs costs more than Amp-hosted orbs: the reason to use it there is that your code stays in your account, not price.

## Commands

| Command | Does |
| --- | --- |
| `cf-orbs init [dir]` | Scaffold, deploy and check a provider. Flags: `--provider cloudflare\|external`, `--token-file`, `--account-id`, `--provider-name`, `--subdomain`, `--vcpu <1\|2\|3\|4>` |
| `cf-orbs status [orb]` | Install status (provider, awake orbs, snapshots), or one orb |
| `cf-orbs logs <orb>` | Redacted bootstrap log of one orb. `--lines N` (default 200) |
| `cf-orbs logs --provider` | Redacted provider log (last 20 lines) |
| `cf-orbs doctor` | PASS/FAIL per check, each with a one-line fix. Never starts anything |
| `cf-orbs deploy` | Regenerate `.cf-orbs/wrangler.jsonc` from the config and deploy |
| `cf-orbs snapshots list` | Project snapshot mappings: Amp snapshot id → Cloudflare snapshot |
| `cf-orbs snapshots forget <id>` / `forget --all-project` | Drop mappings. The next thread on that project runs setup again |
| `cf-orbs snapshots prune [--older-than 7d] [--all] [--yes]` | List snapshot data that no orb and no project mapping uses, unused for 7 days. `--yes` deletes it. `--all` removes only the age limit |
| `cf-orbs upgrade --digest sha256:…` | Move the orb image to a new Amp orb image digest. Keeps the old image key |
| `cf-orbs uninstall [--yes]` | List (dry run) or delete the Worker, container apps and images |

Every command takes `--json`, `--dir <project>` and `--non-interactive`. Orb ids are `amp-<thread id>`; `cf-orbs status` lists the awake ones.

## Configuration

`cf-orbs.config.jsonc` in your project directory. Edit it, then run `cf-orbs deploy`. Do not edit `.cf-orbs/wrangler.jsonc`: deploy writes it again.

| Key | Default | Meaning |
| --- | --- | --- |
| `name` | `cf-orbs` | Worker name. A second install needs another name |
| `instance` | `{vcpu: 4, memoryMib: 12288, diskMb: 20000}` | Orb size: custom (1-4 vCPU, at least 3 GiB per vCPU, up to 12 GiB, 8-20 GB disk) or `standard-1`..`standard-4`. `init --vcpu N` writes `{vcpu: N, memoryMib: N*3072, diskMb: 20000}` |
| `maxRunning` | 20 | Cap on awake orbs. The next spawn fails with a clear message |
| `maxAwakeHours` | 12 | The watchdog pauses an orb that is awake longer than this |
| `checkpointMinutes` | 0 (off) | Snapshot an awake orb with changes every N minutes (15 or more) |
| `warmMinutes` | 10 | After an Amp pause, keep the orb running this many minutes (0-120). The disk is saved first. A message in that time wakes it in under 1 s. Billed like an awake orb (default size ≈ $0.11/h, ≤ $0.02 per pause). 0 = stop at once |
| `hugePages` | `true` | Each spawn sets transparent huge pages to `always` in the orb (the guest kernel default is `never`). New memory is 3-4x faster to allocate; the work bench 512 MB write went from 1.33 to 0.91 s. `false` leaves the kernel default |
| `prewarm` | 2 | After each deploy, start N throwaway instances (0-5) from the new image, wait until they answer, destroy them. This raises the odds that the next spawn finds the 1.8 GB image on its host (6 s, not 40-50 s). Cloudflare picks the host, so it is no guarantee. Cost: about 1 min of the orb size per instance. 0 = off |
| `fastTmpfsGb` | 0 (off) | Each spawn mounts a memory-backed tmpfs of N GiB (`huge=always`) at `/mnt/fast`, for caches and temp data. 512 MB writes in 0.06-0.21 s there, 1.3 s on the root disk. Not in snapshots: lost on pause. Uses memory only for the files in it. 0-8, and at most the orb memory in GiB minus 3 |
| `projectSnapshotRefresh` | `"off"` | `"on-change"`: when a new thread starts from a project snapshot, cf-orbs forgets the snapshot if amp updated itself or the orb image digest changed (at most once per project per 24 h). The next new thread runs setup. If Amp keeps its cached copy, delete it in Amp → Orb Settings → Snapshots |
| `providerHost` | `cloudflare` | Where `amp orb provider` runs: in your Worker, or `external` (your own host; see [provider/README.md](provider/README.md)) |
| `images` | `{}` | Extra `ORB_IMAGE` refs → image keys. Each key needs `image/<key>.Dockerfile` |
| `debugExec` | `false` | Turns on the exec and bench routes. Only for the substrate benchmark |
| `debugSsh` | `false` | Turns on `wrangler containers ssh` for orbs |

To add toolchains to every orb, edit `image/Dockerfile` (see [image/README.md](image/README.md)). Repo setup for one project belongs in that repo's `.agents/setup`.

After `cf-orbs deploy`, an orb that is awake keeps the old Worker code until it pauses (a Cloudflare behaviour). Config changes reach it at the same time.

`cf-orbs deploy` then starts `prewarm` throwaway instances in the background (`prewarm: started 2 instances in the background`); `cf-orbs status` shows how fast they were ready.

## Troubleshooting

Run `cf-orbs doctor` first.

| You see | Do this |
| --- | --- |
| `Docker is not running` | Start Docker, check `docker info`, run the command again |
| `wrangler is not logged in` | `npx wrangler login`, run again |
| `this login has N Cloudflare accounts` | Add `--account-id <id>` or set `CLOUDFLARE_ACCOUNT_ID` |
| `Containers need the Workers Paid plan` | Upgrade the account, run the same command again |
| `this account has no workers.dev subdomain yet` | Run `init` in a terminal (it asks), or add `--subdomain <name>` |
| `registry push timed out` or `image preparation returned 401`, with `retry n of 3` | Nothing. `init` and `deploy` retry by themselves |
| `image push to registry.cloudflare.com kept failing (timeout or 401)` | Run `cf-orbs deploy` again. The registry keeps the layers that it already has |
| Amp's setup log shows `Repository configuration failed` | Amp reuses a cached project snapshot for 72 h, also a bad one. Delete it in Amp → Orb Settings → Snapshots (or `amp projects snapshots delete <owner/repo> --resource <size>`), then `cf-orbs snapshots forget --all-project`. Do the same after any change to `image/Dockerfile` or `.agents/setup` |
| `Amp rejected the provider token` | Make a new token in Amp Settings → Orbs, then `cf-orbs init --token-file <file>` |
| `another amp orb provider already uses this token` | Two providers on one token: the second one waits and takes no jobs. Stop the other one (or use a separate token), then run `init` again |
| `no Amp provider token (the Worker has none after external mode)` | Set `AMP_ORB_PROVIDER_TOKEN` or add `--token-file` |
| `provider did not report running` | `cf-orbs logs --provider`. A cron restarts the provider every 5 min |
| An orb does not start | `cf-orbs logs <orb>` shows its redacted bootstrap log; `cf-orbs status <orb>` shows its state and last spawns |
| `<n>/<max> orbs already running` | Raise `maxRunning`, or let idle threads pause |

Worker logs: `npx wrangler tail --config .cf-orbs/wrangler.jsonc`.

## Security

What leaves your network, and what stays:

- The provider connects out to Amp (`ampcode.com`) for jobs. Nothing connects in.
- Each orb connects out to `ampcode.com` (tools) and `tunnel.ampcode.com` (portals, Terminal).
- Amp runs the agent and the model on its own servers. What the agent reads in an orb (code, command output) goes to Amp and its model providers, as with Amp-hosted orbs.
- The repo checkout, build output and orb disks stay in your Cloudflare account.

Tokens:

- **Amp provider token.** A Worker secret, passed only to the provider container. In external mode it stays on your host. Never in an orb, never logged.
- **Control token.** `.cf-orbs/control-token` (mode 600, gitignored) and the Worker secret `CONTROL_TOKEN`. It is the bearer for the public API at `https://<worker>.<subdomain>.workers.dev/v1`. Whoever has it can start, pause and delete orbs and read their redacted logs. Keep it like a password.
- **ORB_TOKEN.** Amp makes a new one for each spawn. cf-orbs passes it to `amp orb bootstrap` in memory and never writes it to disk.
- Logs and API responses go through redaction (`aop_live_…`, tokens, JWTs, long base64 strings).

Other notes:

- **Egress is open.** An orb can reach any host on the internet, the same as a laptop. There is no allowlist mode in v1.
- Keep `debugExec` off. When it is on, the control token can run any command in any orb.
- The container API cannot delete snapshots. Cloudflare keeps snapshot data for up to 30 days after the last restore, also after `cf-orbs uninstall`, unless `cf-orbs snapshots prune --yes` deletes it.
- The orb user has passwordless sudo (Amp's image needs it).

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Status and known gaps

v0.1. The control plane, dispatch program, provider host and CLI are built and unit tested. On 2026-10-30 a real Amp thread ran end to end on a fresh install: spawn from the image, setup, pause with a project snapshot, wake from the snapshot in 2.3 s, first answer 41 s after the message.

Known gaps:

- The plan check before the first deploy is best effort: it asks wrangler to list Containers and stops only on a clear plan or login error. Any other error is a warning, and a Free account may still find out from the deploy error.
- Paused orbs restore after an image rebuild. A restored disk keeps its old content; new image content reaches only orbs started from the image.
- Orb lost mid-turn: Amp spawns the orb again and the agent runs the failed tool call again. The disk is kept; running processes and shell state are lost.
- Not tested yet: the provider's memory on `lite` over 24 h, restore after the source image is deleted from the registry, the Desktop pane, and Docker inside an orb. Snapshot storage has no published price (beta).
- Seen once: an orb's Durable Object reset during a long spawn wait. The op failed and Amp retried.
- Limits: 4 vCPU, 12 GiB memory and 20 GB disk per orb at most (Amp-hosted orbs have 60 GB). One size per install.
- Writes of new data are slower on the root disk; use `/mnt/fast` for caches (set `fastTmpfsGb`). See [docs/benchmarks.md](docs/benchmarks.md#known-limits-measured).

Both platforms are young: Amp self-hosted orbs shipped on Oct 22, 2026, and Container snapshots are in beta. Expect changes.

## Benchmarks

Method, results and costs: [docs/benchmarks.md](docs/benchmarks.md). The substrate bench (cold start, restore, pause, parallel restores) runs from a clone of this repo and needs no Amp thread. Steps are in that file.

## Docs

| Doc | Covers |
| --- | --- |
| [AGENTS.md](AGENTS.md) | Install guide for an AI agent at a terminal |
| [Provider host](provider/README.md) | Cloudflare-hosted vs external provider, token rotation |
| [Orb image](image/README.md) | The pinned image, toolchains, why snapshots are tied to it |
| [Dispatch](dispatch/README.md) | The program Amp runs per job, and its protocol |
| [Architecture](docs/architecture.md) | Parts, control flow, spawn and pause, billing |
| [Benchmarks](docs/benchmarks.md) | Method, results, costs, how to run the substrate bench |
| [Amp orb provider contract](docs/01-amp-orb-provider-contract.md) | The Amp side: dispatch contract, images, pause, project snapshots |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Dev setup and tests |

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The Amp CLI (`@ampcode/cli`) is proprietary: the provider image installs it from npm; this repo does not include it.
