# Amp self-hosted orbs: the provider contract

> Revised 2026-10-30 after plan review (see [06-plan-review.md](06-plan-review.md)).
>
> Revised 2026-10-30 after M1 E2E ([e2e/results/2026-10-30-m1.md](../e2e/results/2026-10-30-m1.md)): observed pause timing, readiness signal (Amp's pid file, not `cli.log`), the project snapshot cache in the Amp UI, and the umask Amp needs.
>
> Revised 2026-10-31: CPU count fix (R7), amp binary download on cold spawn, headless executor start after bootstrap connects.

Research date: 2026-10-30. Sources: [Self-Hosted Orbs](https://ampcode.com/docs/orbs/self-hosted) (docs; the page shows no last-modified date), [Self-Hosted Orbs](https://ampcode.com/news/self-hosted-orbs) (announcement, Oct 22), [Personal Self-Hosted Orbs](https://ampcode.com/news/personal-self-hosted-orbs) (announcement, Oct 28), [Sizes & Costs](https://ampcode.com/docs/orbs/sizes-and-costs), [Customizing Orbs](https://ampcode.com/docs/orbs/customizing), [Self-Hosted Orbs on Kubernetes](https://ampcode.com/docs/orbs/self-hosted/kubernetes). Some facts come from the docs bundle (`bundle.zip`), strings in the `amp` binary, a local `docker image inspect` of the orb image, and reverse-engineered behavior (swairshah/agent-sandboxes). Each such fact names its source.

## What self-hosted orbs are

You provide the compute; Amp turns it into orbs. `amp orb provider` runs on a machine in your network, **connects out to ampcode.com**, and waits for jobs. Only outbound HTTPS is required. Amp never connects in and needs no cloud credentials, cluster access, or inbound ports.

Amp's qualitative requirements for the infrastructure (verbatim from the docs):

- quickly start new machines
- put them to sleep and resume them equally fast
- keep them around for a long time
- scale them to zero, so no one has to worry about having a lot of them sleeping

Amp's caution: not all compute makes a good orb. Amp-hosted orbs save **disk and memory**, so processes keep running when the orb wakes; Docker-backed orbs cannot save memory. Amp supports its end of the dispatch contract only, and says plainly that Amp-hosted orbs still give the best experience.

**Who self-hosts for:** enterprises that need code to stay in their cloud account, private-network access, region/account restrictions, or custom hardware.

**Pricing (changed Oct 29, 2026):** self-hosted orbs were free for all workspaces until Oct 29, 2026. Enterprise billing is now on: Enterprise workspaces pay 100% of the standard Amp-hosted price for the CPUs and memory the orb reports, billed by the minute while connected to a thread. Only the thread's orb is billed, not its tools sandbox. Thread usage shows runtime and size even at $0. ([pricing](https://ampcode.com/docs/orbs/self-hosted#pricing))

**Measured in M0**: thread usage reports **8 cores** for a 1 vCPU standard-1 orb on Cloudflare (Amp reads the host's `/proc/cpuinfo`; `nproc` in the orb gives 1). Memory (4047 MiB) and disk are reported correctly. So the Enterprise fee for a cf-orbs orb can use the host CPU count, not the instance size (06 R7).

**Fixed 2026-10-31 (R7, v0.1.1):** in the orb, `/proc/cpuinfo`, `/sys/devices/system/cpu/online` and `cpuset.cpus.effective` all show the host's 8 CPUs (0-7). Only the scheduler affinity mask (`Cpus_allowed_list`) holds the instance vCPUs. So `nproc` and Node `os.availableParallelism()` give 2 on a 2 vCPU orb, but `os.cpus()` gives 8. Amp counts `os.cpus()` (or `/proc/cpuinfo`). The bootstrap now writes 0 to `/sys/devices/system/cpu/cpuN/online` with `sudo -n` for each CPU outside the affinity mask. Measured on a 2 vCPU orb: after this, `/proc/cpuinfo` and `os.cpus()` show 2, and Amp's next metric samples showed 2 cores, not 8. The microVM is new on every spawn (snapshots keep the disk only), so the bootstrap does this on every spawn.

## The dispatch contract

Setup: a workspace admin creates an orb provider in **Settings → Orbs → Add Orb Provider**, names it, and copies a one-time `aop_live_…` token. Since Oct 28 there are also **personal providers**: any user creates one in personal **Settings → Orbs → Add Provider**, with no admin. The workspace setting **Personal Orb Providers** controls their use on workspace threads. ([announcement](https://ampcode.com/news/personal-self-hosted-orbs)) Then:

```sh
export AMP_ORB_PROVIDER_TOKEN="<token>"
amp orb provider /abs/path/dispatch.sh
```

Rules:

- Run **exactly one** `amp orb provider` per token, under a service manager that restarts it after reboot. Two providers on one token split jobs between themselves, so a thread's orb lands on one while its next job goes to the other. `--allow-multiple` exists only for dispatch programs that share state across all of them. A new provider with no TTY logs the old one and **waits** for it to stop, so a stop-then-start rollout needs nothing special. ([set up a provider](https://ampcode.com/docs/orbs/self-hosted#set-up-a-provider))
- The provider announces its start and stop to Amp; Amp notices a killed provider.
- Members pick the provider in the thread composer (**Orb → Self-Hosted**) or with `amp -ox "<msg>" --orb-provider <name>`.
- Selecting the provider as the workspace default is a workspace setting; self-hosted orbs can be disabled per workspace; personal providers are controlled separately.

### Jobs

The provider runs the dispatch program **once per job, with no arguments**. The job arrives as environment variables:

| Variable | Value |
| --- | --- |
| `ORB_OPERATION` | `spawn`, `pause`, or `delete` |
| `ORB_ID` | The orb's ID, like `amp-<thread id>`. Use it as the machine name so repeated jobs find the same machine |
| `ORB_IMAGE` | `spawn` only. The image to boot: your `ORB_IMAGE` override or Amp's default |
| `ORB_SNAPSHOT_ID` | The project snapshot to boot from on `spawn`, or to save on `pause`. Unset when the job has none |
| `ORB_TOKEN` | `spawn` only. A short-lived credential that authorizes this orb's connection to its thread. Pass it into the orb. Amp mints it for **one** spawn and it expires: never store or reuse it (`amp` binary strings). M0: a bad token fails with `Error: ORB_TOKEN was rejected by Amp. It is minted for one spawn job and expires after 15 minutes` |
| `AMP_URL` | `spawn` only. The Amp server to connect to when it is not ampcode.com. Pass it into the orb with the token |

**No size reaches dispatch.** No variable carries the Amp orb size. One provider = one size. Amp's Kubernetes chart says: "One size per cluster; every Amp size gets it." (`bundle.zip`, "Chart values")

### Operation semantics

| Operation | What the dispatch program does |
| --- | --- |
| `spawn` | Make the orb run. Start it again if it exists. Otherwise create it from `ORB_SNAPSHOT_ID` if you have that snapshot, or from `ORB_IMAGE`. Then start `amp orb bootstrap` inside it **as the image's default user, detached**, with `ORB_TOKEN` (and `AMP_URL` if set) |
| `pause` | Stop the orb and keep its disk. When `ORB_SNAPSHOT_ID` is set, also save a copy of the disk under that ID for later `spawn` jobs. Full text: "If your platform cannot keep the disk, delete the orb instead; the next spawn boots a fresh one and Amp sets the repository up again. If your platform also saves memory, processes keep running after the next spawn. Otherwise they stop with the orb." ([dispatch contract](https://ampcode.com/docs/orbs/self-hosted#dispatch-contract)) |
| `delete` | Remove the orb and its disk |

Hard rules for every operation: **safe to repeat (idempotent)**, and **finish within five minutes**. Program output goes to the provider log; `spawn` output also shows in the thread's setup log, which is the first place to look when an orb does not start.

Jobs repeat. A claim not finished within 30 s of its last heartbeat is offered again, so a job can run more than once. A nonzero exit may still show "done". Amp re-issues a failed spawn about 2.5-3 min later (reverse-engineered). (`bundle.zip` self-hosted.md; swairshah/agent-sandboxes)

`spawn` is the resume operation too: when a paused orb's thread gets a new message, Amp sends `spawn` again for the same `ORB_ID`.

When each operation comes ([when an orb pauses](https://ampcode.com/docs/orbs/sizes-and-costs#when-an-orb-pauses)):

- **Archive** of a thread sends `pause`, not `delete`.
- **Delete** of a thread sends `delete`.
- **Idle pause** comes when the agent is idle for 5 min AND there is no interaction for 20 min.
- Observed (M0, M1): the idle `pause` came about 20-25 min after the agent finished. A Terminal interaction resets the idle clock. A paused orb can get a `spawn` with no new message, likely when someone views the thread (M0: a `spawn` 5 min after an idle pause, with no user action). So a paused orb can wake and then pause again, and each cycle costs a restore and a snapshot.

## The orb machine

`amp orb bootstrap` is the process that connects the orb to its thread; Amp then sets up the environment and runs the agent's tools. Division of labor: **Amp runs the agent loop and model inference on its own servers; the orb runs the tools** (file reads/edits, commands). The repository checkout, build output, and saved orb disks stay on your infrastructure.

Measured in M0: `amp orb bootstrap` prints nothing to stdout. It logs to `~/.cache/amp/logs/cli.log` (JSON lines). The line with `"message":"Connected to thread actor; announcing sandbox"` marks a connected bootstrap (3.2 s after process start); `Bootstrap request` lines follow as Amp sets up. **M1:** amp flushes `cli.log` late (minutes, in one case), so this marker is not a usable readiness signal. `~/.cache/amp/pids/headless-bootstrap.pid` is: Amp writes it synchronously with the bootstrap pid and boot id, right before it connects. cf-orbs checks that file first and uses the log marker only as a slow path. After setup the orb runs `amp orb bootstrap`, `~/.amp/http-headless-supervisor.sh` and `~/.amp/bin/amp --headless=T-…`, with PID files in `~/.cache/amp/pids/` and `~/.amp/http-headless*.pid`. Amp also writes `setup.log`, `resume.log` and `headless.log`. These files live on the root disk, so they are in every pause snapshot.

Measured 2026-10-31: on a cold spawn, `amp orb bootstrap` downloads the current amp binary (162 MB, to `~/.amp/bin/amp`) when the copy in the image is older. This adds about 5 s to the cold spawn. A wake from a per-orb snapshot keeps the binary on disk, so it does not download it again.

Measured 2026-10-31 (one wake from a per-orb snapshot, N = 1; [05 §5, Where wake time goes](05-benchmarks.md#where-wake-time-goes)): after `amp orb bootstrap` connects, it starts a second node process, Amp's headless executor (`~/.amp/http-headless.pid`), about 3.8 s later. The agent's first tool call runs only when that process is up. In that wake the model issued the tool call 0.05 s after bootstrap connected, and the tool ran 5.4 s later. Amp-hosted orbs resume a memory image with the executor already connected, so they do not wait for it.

### Images

| Image | Platform |
| --- | --- |
| `us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb:latest` | Linux x64 (the default) |
| `us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb-arm64:latest` | Linux ARM64 |

Set `ORB_IMAGE` in the provider's environment to use your own image (Amp passes the value to every `spawn` job). The docs: "Changing ORB_IMAGE affects only new orbs. Existing orbs and project snapshots keep the image they started from." The easiest path is building **from Amp's orb image** and adding language toolchains or CA certificates. A custom base must be glibc Linux x64/ARM64 (**Alpine does not work**) and include:

| Requirement | Needed for |
| --- | --- |
| Bash, coreutils, util-linux, CA certificates | Every orb |
| Git at `/usr/bin/git` or `/opt/git/bin/git` (2.34+ only to **sign** commits) | Every orb |
| Linux `amp` binary at `/usr/local/bin/amp` | Every orb |
| A `user` user/group as the default user, writable `/home/user` | Every orb |
| Passwordless sudo for `user` (rule: `user ALL=(ALL) NOPASSWD: ALL`) | Every orb |
| Node.js ≥ 18 | Portals, external agents |
| tmux ≥ 2.9 | Terminal, external agents |
| curl | External agents |
| `/opt/amp-wayland`, xwayland, dbus, gsettings-desktop-schemas, xsettingsd, wlr-randr, pulseaudio, ffmpeg, fonts-dejavu-core | Desktop pane |
| ripgrep, gh, openssh-client | Recommended |

Amp uses passwordless sudo inside the orb to configure Git settings, prepare runtime files, and manage services on systemd images. ([bring your own image](https://ampcode.com/docs/orbs/self-hosted#bring-your-own-image))

Measured facts about the default amd64 image (local `docker image inspect`, 2026-10-30):

| Fact | Value |
| --- | --- |
| Size | ~1.78 GB compressed, ~3.7 GB unpacked, 31 layers. Docker shows 6.17 GB because it counts layers twice |
| Base | Debian 12 |
| User | `user`, uid:gid 1000:1000 |
| Entrypoint / Cmd | Entrypoint null, Cmd `python3` (exits at once with no TTY) |
| Init | **No init binary** in the image |
| Desktop browser | Needs `/dev/shm` larger than 64 MB |

### BYO repository checkout

By default Amp clones the project repo into each new orb and configures Git/`gh` with short-lived tokens. Providers can turn **Repository Setup** off and ship the checkout in the image. It must live at `/home/user/workspace/repo` with `origin` and `origin/HEAD` set, with a credential helper that refreshes tokens.

## Networking

Allow this outbound access (proxies must allow long-lived connections):

| Source | Destination | Purpose |
| --- | --- | --- |
| Orb provider | `ampcode.com` 443 | Receiving jobs, reporting results |
| Provider + orbs | `static.ampcode.com` 443 | Amp CLI updates |
| Orbs | `ampcode.com` HTTPS + WSS 443 | Bootstrap and tool connections |
| Orbs | `tunnel.ampcode.com` WSS 443 | **Amp Tunnel** for portals, Terminal, Desktop |
| Orbs | Your Git host 443 | Clone/push |
| Orbs | `storage.googleapis.com` 443 | ripgrep download if the image lacks `rg` |
| Orbs | `*.nscluster.cloud` WSS 443 | macOS satellites |

**Portals, Terminal, and Desktop all ride Amp Tunnel** (an outbound WSS from the orb), so they work on self-hosted orbs with no inbound ports. A portal can be opened only by a signed-in Amp user with thread access unless **Public Portals** is enabled for the provider (off by default, since a public portal is an anonymous tunnel into your network).

What leaves your network: tool output the agent produces, such as file contents read, command output, the diff, screenshots/attachments. That is stored with the thread on Amp's side.

## Pause fidelity and project snapshots

| Infrastructure | Memory | Disk | Project snapshots |
| --- | --- | --- | --- |
| Amp-hosted orbs | Yes | Yes | Yes |
| Docker | No | Yes | On one host |
| Apple containers | No | Yes | One Mac (`container` ≥ 1.6.0) |
| Kubernetes (Helm chart) | No | Yes | Yes |
| E2B | Yes | Yes | Not in example |
| exe.dev | Yes | Yes | Not in example |
| Modal | No | Yes | Not in example |
| Vercel | No | Yes | Not in example |
| Daytona | No | Yes | Not in example |
| Boat | No guarantee | Partial | Not in example |
| **Cloudflare (cf-orbs)** | **No** | **Yes** (container snapshot per orb, 30-day TTL, restore only in the same `OrbSession` DO class) | **Yes, cf-orbs implements it** (shared `Registry` DO maps `ORB_SNAPSHOT_ID` to a snapshot handle; any `OrbSession` restores it; 72 h GC) |

Source: [caution](https://ampcode.com/docs/orbs/self-hosted#caution).

Memory loss means: on wake, portal services restart when opened, and Terminal sessions and Desktop apps are gone. Files and installed software survive, so a waking orb runs `.agents/resume`, not `.agents/setup`. `/tmp` does not survive pause on file-only providers.

**Project snapshots** are Amp's mechanism for fast thread starts: a saved copy of a prepared orb (repo cloned, `.agents/setup` already run). Amp sends a `pause` with `ORB_SNAPSHOT_ID` set and then a `spawn` for the same orb; the dispatch program stores a copy of the disk under that ID on `pause` and boots from the copy when a later `spawn` names it. If the dispatch program ignores `ORB_SNAPSHOT_ID`, every new thread runs full setup. Manage them with `amp projects snapshots list|delete <project>`.

Project snapshot rules ([customizing](https://ampcode.com/docs/orbs/customizing)):

- Project snapshots are keyed per **orb size**.
- Amp reuses one for up to **72 h**, then names a new one.
- Amp never deletes provider-side copies. The provider must clean up its own.
- A failed setup publishes no snapshot.
- Observed (M1): the Amp UI lists one cached project snapshot per provider under Orb Settings → Snapshots, kept for 72 h. A setup that Amp counted as done but left a bad disk was published, and the next two threads reused it. After a change to the image or to `.agents/setup`, delete the cached snapshot there; Amp does not notice the change by itself.
- In Amp's Docker example, an existing orb wins over the snapshot.
- Stale snapshots (2026-10-31, `projectSnapshotRefresh`): a project snapshot keeps the amp binary and the image content that it was saved with. After an Amp CLI release, every spawn from it spends 4-5 s on amp's self-update ([05](05-benchmarks.md)). After a deploy with a new image digest, it keeps the old image content. Question: when a spawn has `ORB_SNAPSHOT_ID` but boots fresh (the provider dropped its copy), does Amp save a new snapshot? **The contract does not say so.** Amp sends a pause with `ORB_SNAPSHOT_ID` only when it decides to publish a snapshot. M0 saw that only for a project with no cached snapshot. M1 saw Amp reuse a cached snapshot for later threads. The `amp` binary names server-side calls (`planProjectSandboxSnapshot`, `claimProjectSandboxSnapshotPublication`, `publishProjectSandboxSnapshot` with `previousSnapshotId`, `staleSourceRevision`, `rootMaxAgeMs`). So Amp decides when to publish again, by rules it does not document. After cf-orbs forgets a stale mapping, new threads can run full setup until Amp names a new snapshot (72 h at most) or the user deletes the cached snapshot in Amp → Orb Settings → Snapshots. cf-orbs writes the forget to the setup log and shows the stale flag in `cf-orbs status`. FR6 still applies: case 3 needs a live mapping, so a forgotten mapping gives case 4 (the image). A new pause with that id writes a fresh mapping.
- Measured in M0: for a new project Amp sends `spawn` (no `ORB_SNAPSHOT_ID`) → sets up the repo → `pause` with `ORB_SNAPSHOT_ID=snap-<project>-<hash>` about 10 s after the spawn job ends → `spawn` again on the **same** orb with no `ORB_SNAPSHOT_ID` → the agent runs. So the project snapshot is taken right after setup, before the first agent turn, and the re-spawn restores the per-orb handle (D6 case 2). A later thread on the same project gets `ORB_SNAPSHOT_ID` in its first spawn (D6 case 3); M0 restored it from the Registry map in 3.6 s.

Setup writes system files such as `/etc/gitconfig`. **M1:** with `umask 077` inherited from the launch script, `/etc/gitconfig` came out mode 0600, git could not read it, and setup failed with "Repository configuration failed". Start `amp orb bootstrap` with `umask 022`.

`.agents/setup` runs on orb init; `.agents/resume` runs on every wake; `amp orb service` manages supervised services (e.g. a Docker daemon) that Amp restarts after wake.

Timeouts and hooks ([customizing](https://ampcode.com/docs/orbs/customizing)):

- `.agents/setup` stops after 20 min.
- A clone that takes more than 15 min fails the orb.
- Amp waits 10 s for `.agents/resume`. Resume also runs on reconnect without a pause.
- The workspace **Resume Script** runs on self-hosted Linux orbs.

## Implications for the Cloudflare provider

1. The dispatch program is a thin HTTP client (POSIX `sh` + `curl`). The real orchestration lives in one Cloudflare Worker with three Durable Object classes: `OrbSession` (extends `DurableObject` from `cloudflare:workers`, one class for all orbs, owns the orb container), `Registry` (no container, single name `registry`), and `ProviderHost` (runs `amp orb provider` in its own container). The `@cloudflare/containers` `Container` class does not support the durable_object policy. See [requirements](03-requirements.md) and [plan review](06-plan-review.md) D2.
2. Pause = snapshot + destroy, matching Cloudflare Container snapshots (files, not memory). Amp's own Docker and Kubernetes examples behave the same way, so tooling and expectations already accept it. The contract also allows disk loss: if a snapshot is gone, the orb boots fresh and Amp sets the repo up again.
3. `ORB_ID` names the orb's DO: `orb:<ORB_ID>`. Same ID → same DO → same container and snapshot state. All orbs use one DO class because a snapshot restores only in a DO of the same class.
4. Project snapshots need our own bookkeeping in a **shared `Registry` DO**, not in the per-orb DO: the `pause` that saves `ORB_SNAPSHOT_ID` hits orb A, and the `spawn` that uses it hits orb B. `Registry` holds the map `ORB_SNAPSHOT_ID → {id, size, imageKey, instance, createdAt, lastUsedAt, sourceOrbId}`, an index of every snapshot ID ever created (Cloudflare has no list or delete API, and Amp never deletes provider-side copies), and the running-orb heartbeat set. Maps unused for 72 h are dropped (D3).
5. The 5-minute, idempotent requirements drive the design. Snapshot timing must fit the budget. Every operation must tolerate replays and partial failure, because Amp re-offers a claim after 30 s without a heartbeat and re-issues failed spawns. `ORB_TOKEN` changes on every spawn: pass it in the exec env only, never write it to disk.
6. Spawn precedence (D6): (1) container running → reuse it; (2) per-orb snapshot handle, not expired → restore it; (3) no orb record and `ORB_SNAPSHOT_ID` maps to a live handle in `Registry` → restore it; (4) else start from the image. An `ORB_SNAPSHOT_ID` on an orb with its own handle is ignored (logged), so a thread never rewinds to its setup state.
7. Images (D4, D5): Cloudflare rejects external registry refs, so the orb image is `image/Dockerfile` `FROM` the digest-pinned `amp-orb`, plus `tini` as init and `CMD ["sleep","infinity"]` (the base `python3` Cmd exits and the base has no init). Named image key `orb`. Any `ORB_IMAGE` ref to `…/amp-orb/amp-orb` maps to `orb`; other refs must be listed in `cf-orbs.config.jsonc`, else spawn fails with a clear error. Snapshots are tied to the image they came from, so image keys stay while a live snapshot uses them.
8. One size per provider (D17). No size reaches dispatch, so two sizes need two installs or two provider tokens. A project snapshot is keyed per Amp size, which matches this.
9. Portals and Terminal need nothing extra, because Amp Tunnel is outbound from the orb. v1 orbs have open egress, so WSS to `tunnel.ampcode.com` is not blocked. M0 confirmed the connection: from a Cloudflare container with open egress, `amp orb bootstrap` connected, the agent edited files, and the files survived pause and re-spawn (06 R1 resolved). Still open: the Terminal pane and a long WSS soak (R13, task 2.7). The Desktop pane is untested in v1 (it needs `/dev/shm` larger than 64 MB).
