# Benchmarks

Numbers in the README come from these runs. The full tables, with every run and every failure, are on the [results page](https://cf-orbs-site.mdick85.workers.dev/#compare). The raw run files and the E2E harness are not in this repo. The substrate bench is, and you can run it on your own account.

## Method

- Date: 2026-10-31, same night for every provider.
- Task: one fixed prompt in a real Amp thread (`amp -ox`), on one project that the Amp workspace can clone. The same prompt and project for every provider.
- Runs: N = 10 new threads per provider. A work prompt, N = 5. Wake rounds send a follow-up to a paused thread 25 minutes or more after the last message.
- Providers: cf-orbs (4 vCPU, 12 GiB, 20 GB), Amp-hosted a1.small, and Amp's reference providers for Docker, E2B and Vercel.
- Every run is kept, failures included. Tables show min, p50, p95 and max, never the best run.
- Time that belongs to Amp and the model (not the orb) is shown apart from orb time.

## Results

Values are from the README; the results page has the full per-provider tables.

| Measure | cf-orbs | Amp-hosted a1.small | E2B | Vercel |
| --- | --- | --- | --- | --- |
| Orb setup before the first turn, new thread | about 12 s (project snapshot) | see results page | 36-45 s (reference script rebuilds the repo each thread) | 36-45 s (same) |
| First tool after a follow-up, warm orb | 0.3-0.5 s | 0.85 s | see results page | see results page |
| First tool after a follow-up, cold restore | 1.5-2 s plus process start | see results page | see results page | see results page |
| git clone | 0.26 s | 0.54 s | 0.44 s | see results page |
| npm install of express | 7.7 s | 15.2 s | 10.1 s | see results page |
| Tool round trip on a live orb | 0.8-0.9 s | 0.8-0.9 s | 0.8-0.9 s | 0.8-0.9 s |
| Threads finished | 10 of 10 in every round | see results page | see results page | see results page |

## Cost, running 4 vCPU / 12 GiB / 20 GB

| | USD per hour |
| --- | --- |
| cf-orbs, idle | about 0.11 |
| cf-orbs, 20% CPU | about 0.17 |
| cf-orbs, paused | no compute charge |
| Amp-hosted a1.small (2 vCPU, 4 GiB) | 0.17 |
| E2B (4 vCPU, 8 GiB) | about 0.33 |

Snapshot storage has no published rate (beta) and is not in these numbers. Rates: [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) and [Amp orb pricing](https://ampcode.com/docs/orbs/sizes-and-costs).

## What does not compare

- Sizes differ. The Docker reference gives the container no limit (it sees the whole host). E2B is 4 vCPU / 8 GB. Amp-hosted a1.small is 2 vCPU / 4 GiB. Compare CPU first.
- Amp-hosted orbs keep memory across a pause. cf-orbs keeps only the disk.
- Amp-hosted orbs have 60 GB disk. cf-orbs has 20 GB.
- Cloudflare picks the host. The container can run in another colo than its Durable Object.
- Wake time has an Amp part: after a restore, Amp starts its headless executor (about 3.8 s).

## Known limits, measured

- Writes of new data to the root disk are slower: 512 MB with fsync takes 0.9 s with `hugePages`, 1.3 s without. Amp-hosted takes 0.6 s. Use `/mnt/fast` for caches (`fastTmpfsGb`): 0.06-0.21 s.
- The first spawn on a new Cloudflare host pulls the 1.8 GB image (40-50 s), then it is cached. `prewarm` raises the chance of a host that has it.
- Snapshot cost: a snapshot takes about 8 s plus 6 s per GB of changed data. Restore takes 0.6-1.3 s, then reads lazily at about 230 MB/s.

## Run the substrate bench

It measures cold start from the image, restore at several sizes, pause, and parallel restores. It needs no Amp thread and starts only `bench-*` orbs that Amp never uses. It prints a cost estimate and asks first.

1. Set `"debugExec": true` in `cf-orbs.config.jsonc` and run `cf-orbs deploy`. This lets the control token run commands in orbs.
2. In a clone of this repo (Node 22.18 or later):

   ```sh
   npm ci
   npm run bench:substrate -- --dir <install dir> --runs 10 --sizes 1,5,10 --parallel 10
   ```

3. Set `"debugExec": false` and run `cf-orbs deploy` again.

Results go to `bench/results/` as JSON.
