# Changelog

All notable changes to cf-orbs are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). Before 1.0, a minor version can break config or the control-plane API.

## [Unreleased]

### Added

- `cf-orbs template [dir]`: write a repo that a [Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) installs in one click — the `init --no-deploy` scaffold with no account id, a button README and `.dev.vars.example`, git-inited with a first commit. No Cloudflare login, Docker or tokens needed to generate it. Push it to a public repo and point the button at it. The button is the whole install: the setup page prompts for the Amp provider token (the one uncommented `.dev.vars.example` entry) and sets it as a Worker secret, so the provider starts on its own — no CLI, no terminal. The Worker is named after the template repo (`cf-orbs-template`) so the setup page's default project name matches with no edits and the container applications cannot collide with a `cf-orbs` CLI install in the same account (wrangler derives their names from the config's `name`, not the project name — [workers-sdk#15827](https://github.com/cloudflare/workers-sdk/issues/15827); a second install in one account edits `name` first). The CLI stays optional (`init --no-deploy --adopt` adds `status`/`logs`/`doctor` to a clone). Docs: [docs/install-button.md](docs/install-button.md).

## [0.2.6] - 2026-11-12

### Added

- `cf-orbs status <orb>` shows `disk image`: the image the orb's disk came from, and whether it is older than the image now deployed under that key. A paused orb that restores after `cf-orbs upgrade` or a `deploy` with a new digest keeps its old disk content; this shows it. A handle saved before this version has no image ref and shows `unknown`.

### Fixed

- `cf-orbs upgrade` warned that paused orbs may not restore after an upgrade. They do restore (R18); the warning now says they keep the old disk content and that new image content reaches only orbs started from the image.

## [0.2.5] - 2026-11-10

### Fixed

- New threads did not start on an install whose provider container had become slow. A spawn that takes 1 s took the dispatch program more than 90 s, Amp timed out after 300 s and sent the spawn again with a new token, and the orb never got its setup requests. The cause of the slow container is not known: it had run for 7 days, and a new `lite` container handled 10 spawns at once and 200 jobs in 15 min in tests. Three changes make the provider safe against it:
  - Watchdog: every 5 min the Worker asks the provider container to run `true`. If it does not answer in 5 s two times in a row, the Worker restarts the container. No check in the first 10 min after a start, and at most one such restart in 30 min.
  - `dispatch.sh` starts 2 processes for a job that is already done (was about 25). It reads the Worker's new plain-text replies (`?format=text`) with shell builtins and needs only `sh`, `curl` and `sleep` (no `awk` or `sed`).
  - The Worker sends progress lines in groups, so dispatch polls less often.
- `/v1/status` no longer waits on a provider container that does not answer. The log read stops after 5 s and the log tail says so. Before, one slow read blocked `cf-orbs status`, `cf-orbs doctor`, `cf-orbs logs --provider` and the 5-min provider check.

### Added

- Config `providerInstance`: size of the provider container, `"lite"` (default), `"standard-1"` or `"standard-2"`. `cf-orbs deploy` restarts a running provider when the size changes.
- `cf-orbs doctor` fails the `provider` check when the provider container runs but does not answer a log read.
- `GET /v1/ops/<id>` and `POST /v1/orbs/<orb>/ops` accept `?format=text`. The JSON replies are unchanged, so an older `dispatch.sh` on an external host keeps working.

### Changed

- External provider hosts: copy the new `dispatch/dispatch.sh` after you deploy the Worker. The new script needs a Worker from 0.2.5 or later.

## [0.2.4] - 2026-11-03

### Added

- `init --adopt`: take over a Worker of the same name that this folder did not create. A new control token replaces the old one, and this folder's config and `image/` are deployed. `init` prints one warning.

### Fixed

- `init` in a folder with no saved deployment and no control token now stops when a Worker of the same name already exists in the account. Before, it deployed over that Worker: new control token, default config and image, old image keys dropped. The check runs `wrangler deployments list --json --name <name>` before any token, secret or deploy, in every mode. If the check cannot run, `init` warns and goes on. A rerun in the same folder is not checked. Neither is a folder that has `.cf-orbs/control-token` (a run that failed before it saved the URL, or a restored backup): it keeps the same token. Restoring on a new machine without the control token needs `--adopt`.

## [0.2.3] - 2026-11-03

### Changed

- The default Amp provider name is `cloudflare`, not `cf-orbs`. The order is `--provider-name`, `AMP_ORB_PROVIDER_NAME`, the saved name, then `cloudflare`. A second install with its own Worker name no longer takes that name as its provider name: pass `--provider-name`. The Worker name default is still `cf-orbs`.

### Added

- `init` prints one `back up:` line before the final `amp` command. It names the files to keep and links the guide.
- README: a Back up section. Docs: [Back up and restore](https://cf-orbs-site.mdick85.workers.dev/docs/guides/back-up-and-restore/).

## [0.2.2] - 2026-11-03

### Changed

- The `init` token prompt names the Amp page where you create the token: Amp Settings → Orbs → Add Provider.
- `init` warns when the provider name is not given explicitly, that is, when it comes from the config `name` or the default `cf-orbs`. The name must match the one in Amp. A name from `--provider-name`, `AMP_ORB_PROVIDER_NAME` or a previous run gives no warning.
- `init --help` lists the full provider-name fallback order.
- The comments in `image/Dockerfile`, `provider/Dockerfile`, `provider/entry.sh` and `dispatch/dispatch.sh` no longer contain internal requirement codes. `init` copies these files into your project.

### Docs

- `cf-orbs.config.example.jsonc` lists `debugExec`, `inactivityTimeoutMinutes`, `alarmSeconds` and `ampImageDigest`.
- README: `instance.vcpu` accepts fractions between 1 and 4. The README links the docs site.

## [0.2.1] - 2026-11-02

### Fixed

- `cf-orbs doctor` read the provider Dockerfile from the CLI templates only. In a source checkout before `npm run build` that file does not exist, so the check failed. It now reads the source file in that case. 0.2.0 was tagged but not published because of this test failure.

## [0.2.0] - 2026-11-02

### Added

- `cf-orbs init --no-deploy` (preview): install without Docker. Workers Builds builds the orb and provider images in your Cloudflare account from your git repo and deploys on each push. See [docs/install-workers-builds.md](docs/install-workers-builds.md). Without the flag, `init` deploys with local Docker as before.
- `init --no-deploy` writes `package.json` (wrangler pinned to the CLI's version), `package-lock.json`, a `.gitignore` and a first git commit. It stops if a staged file holds a token.
- `init --no-deploy` creates the Worker, sets its secrets and prints the dashboard settings to connect the repo. `--json` gives `mode: "git"` and a `settings` object. The Amp token is optional; a later `init --no-deploy --token-file <file>` sets it.
- `cf-orbs init --name <worker>` sets the Worker name.
- `init` plan check: before it builds the image, `init` runs `wrangler containers list`. A clear plan or login error stops `init` in seconds, not after the 1.8 GB push. Any other error is a warning.
- `init` self-test: after the deploy, `init` waits up to 3 min for the prewarm instances and prints `self-test: orb image starts (N of N ready in X s)`. It fails with a fix line when none starts. It is skipped when `prewarm` is 0.
- `init --no-deploy` skips the self-test, because the build runs later. A rerun after a build shows the last prewarm result.
- `cf-orbs upgrade --no-deploy` writes `.cf-orbs/wrangler.jsonc` and says to commit and push.
- `cf-orbs doctor` checks the project files: Dockerfiles pinned by digest, `debugExec` off (WARN when on), and no Amp or control token in files that git tracks.
- `cf-orbs doctor` in a `--no-deploy` project also checks that `.gitignore` keeps out the control token and `state.json`, and that `package.json` pins the CLI's wrangler.

### Changed

- `.cf-orbs/wrangler.jsonc` sets `workers_dev: true` and `preview_urls: false`. Wrangler no longer warns about them.
- In a `--no-deploy` project, a failed health check points to the Workers Builds build.

### Docs

- New: [docs/install-workers-builds.md](docs/install-workers-builds.md), the Docker-free install with Workers Builds. Measured: first build 10 min 35 s, upgrade 5 min 39 s.
- AGENTS.md: the Workers Paid check is now done by `init`; the Docker-free path is linked.

### Upgrade from 0.1.x

Run `npx cf-orbs@0.2.0 upgrade` (or `npx cf-orbs@0.2.0 deploy`). Your config does not change. Paused orbs survive. The provider restarts once only if its image changed.

## [0.1.1] - 2026-11-02

### Fixed

- `package.json` `bin` path has no `./` prefix, so npm no longer warns when it publishes.

## [0.1.0] - 2026-11-02

### Added

- `cf-orbs snapshots prune [--older-than 7d] [--all] [--yes]`: lists snapshot data that no orb and no live project mapping uses, unused for 7 days (`--all`: any age). `--yes` deletes each one with `wrangler containers images delete <repo>:rootfs-snapshot-<sha256 of id>` (an undocumented path; a failure on one id is reported and skipped) and drops it from the Registry index. `cf-orbs status` shows `prunable: N (X GB)`. New routes `GET /v1/snapshots?candidates=1` and `POST /v1/snapshots/forget-many`.
- Config `prewarm` (default 2, 0-5; 0 = off). After `cf-orbs deploy`, `upgrade` or `init`, the Worker starts N throwaway instances from the new image, waits until they answer, and destroys them (cap 3 min each). The first spawn on a host without the image takes 37-52 s (1.8 GB pull); this raises the odds of a host that has it. No guarantee: Cloudflare picks the host. Cost: about 1 min of the orb size per instance. Amp never sees these instances. `cf-orbs status` shows the last run (`prewarm: 2 of 2 ready in 41 s and 39 s, 3m ago`); `GET /v1/warm` gives it as JSON.
- Warm pause, config `warmMinutes` (default 10, 0-120; 0 = old behaviour). On an Amp pause, cf-orbs saves the disk but keeps the container and Amp's processes running for `warmMinutes`. A message in that time needs no restore and no restart: Amp uses the still-connected executor and sends no spawn. Measured: message → first tool result 3.88 and 3.94 s (was 9.6 s p50), tool use → result 0.36 and 0.32 s (was 5.1 s). A warm orb bills like an awake one (default size ≈ $0.11/h, ≤ $0.02 per pause), holds a `maxRunning` slot, and counts toward `maxAwakeHours`. A pause with `ORB_SNAPSHOT_ID` stays cold (quiesced disk). `cf-orbs status` shows `warm (Nm left)`.
- Config `hugePages` (default `true`): each spawn sets transparent huge pages to `always` in the orb. The guest kernel ships with `never`, so new memory was slow to allocate (docs/benchmarks.md "Disk: fsync cost"). The bootstrap prints `thp: always`. Work bench (N = 5): 512 MB write with fsync 1.33 → 0.91 s p50; CPU, git clone and npm install not worse. `false` keeps the kernel default.
- Config `fastTmpfsGb` (default 0 = off, max 8 and memory GiB − 3): each spawn mounts a memory-backed tmpfs with `huge=always` at `/mnt/fast`, for caches and temp data. 512 MB writes in 0.06-0.21 s there against 1.3 s on the root disk. Not in snapshots.
- Config `projectSnapshotRefresh` (`"off"` default, or `"on-change"`). After a spawn from a project snapshot, cf-orbs checks whether amp updated itself (bootstrap line `amp: updated <old> -> <new>`) or the image digest changed since the project pause. If so, it marks the mapping stale and forgets it, at most once per project per 24 h. It never starts threads or orbs and changes nothing on Amp's side. Amp does not always save a new snapshot after that, so `cf-orbs status` shows the stale flag and says to delete the cached snapshot in Amp settings. A project pause now records the amp version and the image digest in the mapping, and `cf-orbs status` shows them per project snapshot.
- `cf-orbs init --vcpu <1-4>` sets the orb size to N vCPU, N × 3 GiB, 20 GB disk. `--vcpu 2` gives the cheaper custom 2/6/20 ($0.059/h fixed for memory and disk).

### Security

- Pause masks token shapes (`aop_live_`, `orb_`, `Bearer`, JWT) in `~/.cf-orbs/bootstrap.log` and `~/.cache/amp/logs/*.log` before it snapshots the disk, for cold and warm pauses (R19). Masks keep the length of the match, so log offsets stay valid.

### Changed

- Wake path: shorter polls. Measured live after the provider restart fix (one restore wake, N = 1): provider claim → job completed 4082 ms (was 4535 ms), spawn op 2.1 s (was 2.0 s), op end → job completed 820 ms (was 1792 ms). Expected 0.6-0.8 s less; got 0.45 s less claim → completed, because claim → op start was 1.1 s this time. `dispatch.sh` polls again at once after a reply with new lines (it slept up to 1 s). The op's last line and result wake the long-poll once, and a notify during the read no longer waits 1 s. Spawn skips the second connected check when the bootstrap saw the connect. Bootstrap polls 10 ms (child pid) and 20 ms (Amp's pid file), was 50 and 100 ms; Docker: script to launch 66 → 33 ms, connect detection 51 → 13 ms (means, N = 30). The readiness probe retries after 0.1, 0.2, 0.4, 0.8 s, then every 1 s (was every 1 s). The `timing:` line shows each prelude step.
- Restore wake: spawn op 1.5-1.7 s (was 2.4 s in the wake trace). Spawn reads the amp binary in parallel with the bootstrap script (launch → connected median 783 → 384 ms, N = 4 and 6), and the CPU step uses one `sudo` for all CPUs. The bootstrap prints a `timing:` line.
- Default orb size is custom 4 vCPU / 12 GiB / 20 GB ($0.113/h fixed for memory and disk). Was 2/6/20. CPU is billed on active use only.

### Fixed

- `cf-orbs deploy` did not restart the provider container for a new provider image, so fixes in `dispatch.sh` or `entry.sh` did not go live (only a token change restarted it). Now `deploy` writes a hash of the provider image inputs to the Worker (`CF_ORBS_PROVIDER_BUILD`). ProviderHost stores the build and image it started with. `deploy` and `upgrade` call the new `POST /v1/provider/restart?ifImageChanged=1`, and the 5-min cron does the same check. `deploy` prints `provider: restarted for the new image` or `provider: image unchanged`. The Worker log gets `provider: image changed <old8> -> <new8>; restarted`. `cf-orbs status` shows the provider start time and image digest. A provider DO on an older build stops its container and is reset so the new code starts the new image. A provider DO on code from before this fix is stopped, and `deploy` starts it again once it unloads. Verified live: two deploys restarted the provider for a new image. In both, the provider DO ran the new code at once (R17 did not apply), so the reset and old-code paths are covered by unit tests only. Amp accepted the new provider 33-37 s after the restart, when it saw the old connection go; jobs wait in that time.
- Amp reported the host CPU count (8) for an orb, not its vCPUs (R7). The bootstrap now takes offline each CPU outside the affinity mask, on every spawn. Verified live: Amp metrics went from 8 to 2 cores on a 2 vCPU orb. After deploy, the bootstrap log shows `cpus: 2 allowed of 8 online; offlined 6`, and `nproc` gives 2. The Enterprise fee now follows the instance size.

### Docs

- R6 tested: after an orb is lost mid-turn, Amp spawns it again and the agent runs the failed tool call again. Disk kept; running processes lost.
- A cold spawn downloads the current amp binary (162 MB, about 5 s) when the copy in the image is older.
- Benchmarks: harness commit caveat. The next round reruns both sides from one clean commit.
- R18 resolved: a paused orb restored after `cf-orbs deploy` pushed a new image digest. Snapshots are not bound to the digest, so upgrade with paused orbs is safe. The 0.1.0 known gap "Upgrade with paused orbs" no longer applies. A restored disk keeps its old content; new image content reaches only orbs started from the image.
- Wake trace (N = 1) in docs/benchmarks.md: of a 9.1 s wake to first tool, cf-orbs takes about 2.6 s. Most of the rest is Amp starting its headless executor after bootstrap connects.
- Benchmark baselines: the Docker reference provider has no CPU or memory limit; E2B reference 4 vCPU / 8 GB; Vercel reference 4 vCPU (R23). The next round adds E2B and Vercel Sandbox, N = 10 each.

## Before 0.1.0 (pre-release builds)

First public release.

### Added

- Control plane on Cloudflare Workers. One `OrbSession` Durable Object and container per orb, a `Registry` Durable Object for the run-slot cap and project snapshot maps, and a `ProviderHost` Durable Object.
- Amp orb operations `spawn`, `pause` and `delete` as async ops (`POST /v1/orbs/:id/ops`, long-poll `GET /v1/ops/:opId`). A replayed job attaches to the op already running.
- Pause takes a disk snapshot and stops the container. Spawn restores the per-orb snapshot (about 1 s to ready in M0 and M1 tests), else the project snapshot from `ORB_SNAPSHOT_ID`, else boots the image.
- Project snapshots: a new thread on a known repo starts from the disk Amp already set up.
- Bootstrap guard: `setsid` launch with a boot-id-checked pid file, readiness from Amp's headless pid file, `umask 022`, short hostname. A retried spawn with the same token starts no second process.
- Watchdog alarm: pauses an orb awake longer than `maxAwakeHours`. Optional checkpoint snapshots every `checkpointMinutes`.
- `dispatch.sh`: POSIX `sh` + `curl` dispatch program. Step lines, one final `Failed: <cause> — fix: <action>` line, no secrets in argv or output.
- Provider host in two modes: `cloudflare` (a `lite` container in the Worker, restarted by an alarm and a 5-min cron) and `external` (your own host, systemd unit in [provider/README.md](provider/README.md)).
- Public `/v1` API behind the `CONTROL_TOKEN` bearer. Every public route is 404 when the secret is not set.
- Redaction of tokens in every stored or printed log line, with the same rules in the Worker and in the shell scripts.
- CLI `cf-orbs` with `init`, `deploy`, `status`, `logs`, `doctor`, `snapshots`, `upgrade` and `uninstall`. Every command takes `--json` and `--dir`. `init` is re-runnable and has a `--non-interactive` mode for CI.
- Pinned orb image (Amp image digest plus pinned `tini`) and `cf-orbs upgrade --digest` that keeps the old image key while snapshots still use it.
- Debug exec and benchmark routes behind `"debugExec": true`, off by default.
- Benchmark harness: substrate, E2E and wake benchmarks against Amp-hosted orbs, and a renderer that writes [docs/benchmarks.md](docs/benchmarks.md) from the raw JSON in `bench/results/`.
- CI (typecheck, lint, unit tests, CLI build, Worker dry run, shellcheck), a weekly Docker test workflow and an npm release workflow with provenance.

### Fixed (found in M1 end-to-end tests)

- Bootstrap no longer passes `umask 077` to Amp. Amp wrote `/etc/gitconfig` as 0600 and setup failed with "Repository configuration failed".
- Spawn readiness uses Amp's `~/.cache/amp/pids/headless-bootstrap.pid`. The "Connected" line in `cli.log` can be flushed minutes late.
- Bootstrap sets `hostname localhost`, because `/etc/hosts` is read-only after a snapshot restore.
- The generic redaction rule no longer removes snapshot ids.

### Known gaps

- `init` does not run the orb self-test yet (start an orb, `amp --version`, DNS and TLS to Amp, snapshot and restore) and does not pre-warm the image.
- No Workers Paid check before the first deploy. A Free account learns it from the deploy error.
- Upgrade with paused orbs: their snapshots may not restore on a new image (R18). Push or commit work first.
- Not yet checked whether Amp writes `ORB_TOKEN` into files that a snapshot keeps (R19). The token expires after 15 min.
- A Durable Object that holds a running container keeps the old Worker code after a deploy until it is evicted.
- Amp caches one project snapshot per provider for 72 h. After a change to the image or `.agents/setup`, delete it in Amp → Orb Settings → Snapshots.
- Amp reports the host CPU count (8) for an orb, not its vCPUs (R7). This matters if Amp bills by reported size.
- One orb size per install. Egress is open; no allowlist mode.
- Once in M1, an `OrbSession` reset during the connect wait (the op ended as failed). Cause not yet found; the API now logs 5xx causes.
- Amp does not show dispatch progress lines in the thread setup log. Use `cf-orbs logs <orb>`.

[Unreleased]: https://github.com/meirdick/cf-orbs/compare/v0.2.6...HEAD
[0.2.6]: https://github.com/meirdick/cf-orbs/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/meirdick/cf-orbs/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/meirdick/cf-orbs/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/meirdick/cf-orbs/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/meirdick/cf-orbs/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/meirdick/cf-orbs/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/meirdick/cf-orbs/releases/tag/v0.2.0
[0.1.1]: https://github.com/meirdick/cf-orbs/releases/tag/v0.1.1
[0.1.0]: https://github.com/meirdick/cf-orbs/releases/tag/v0.1.0
