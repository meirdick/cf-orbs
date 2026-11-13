# Contributing to cf-orbs

Thank you for your help. Bug reports, fixes, docs and benchmark runs are all welcome.

Before a large change, open an issue first. [docs/architecture.md](docs/architecture.md) holds the design rules. A change that goes against one of them needs a reason in the issue.

## Dev setup

You need:

- Node 22 or later (wrangler 4 needs 22). The substrate bench script needs Node 22.18 or later.
- Docker, for the Docker tests and for a real deploy.
- `shellcheck`, for the shell scripts.
- `bash`, `sh` and `curl` on your PATH (the dispatch and provider tests run the real scripts).

```sh
git clone https://github.com/meirdick/cf-orbs
cd cf-orbs
npm ci
```

## Layout

| Path | What |
| --- | --- |
| `worker/` | The Worker: control plane, `OrbSession`, `Registry` and `ProviderHost` Durable Objects |
| `cli/` | The `cf-orbs` npm package. `cli/templates/` is generated from `worker/src`, `image`, `provider` and `dispatch` at build time. Do not edit it |
| `dispatch/` | `dispatch.sh`, the program `amp orb provider` runs once per job (POSIX `sh` + `curl`) |
| `provider/` | The provider container: Dockerfile and `entry.sh` |
| `image/` | The orb image: the pinned Amp image plus `tini` |
| `bench/` | The substrate bench. Raw results go in `bench/results/` |
| `docs/` | Architecture, benchmarks, the Amp provider contract, install guides. `docs/button-template/` is the README and `.dev.vars.example` that `cf-orbs template` writes into the button repo (synced into `cli/templates/button/` at build time) |

## Checks

Run these before you open a pull request. CI runs the same ones.

```sh
npm run typecheck
npm run lint            # npm run lint:fix applies the fixes
npx vitest run          # unit tests; the Docker tests skip
npm run shellcheck
npm run build -w cli
```

### Docker tests

`worker/test/scripts.docker.test.ts` runs the orb scripts (bootstrap, status, quiesce, log tail) in the pinned Amp orb image. They skip unless `CF_ORBS_DOCKER=1`. The image is about 1.8 GB to pull and 6 GB on disk.

```sh
docker pull us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb@sha256:378c5e2188f00960eca36dc806aa04e1cacd92c2341665bcdf4692326c462d6d
CF_ORBS_DOCKER=1 npx vitest run worker/test/scripts.docker.test.ts

# Same tests in the image cf-orbs deploys (tini as PID 1):
docker build -t cf-orbs-orb:dev image
CF_ORBS_DOCKER=1 CF_ORBS_DOCKER_IMAGE=cf-orbs-orb:dev npx vitest run worker/test/scripts.docker.test.ts
```

Run them when you change `worker/src/orb/scripts.ts` or `image/Dockerfile`. The `Docker tests` workflow runs them weekly and on demand.

## Try a change on a real account

Use a test Cloudflare account on Workers Paid, and a separate Amp provider token for it. One token can drive only one provider at a time, so do not reuse the token of an install you depend on.

```sh
npm run build -w cli                  # syncs cli/templates from your working tree, builds cli/dist
mkdir -p ~/orbs-dev
node cli/bin/cf-orbs.js init ~/orbs-dev --provider-name cf-orbs-dev   # asks for the token
node cli/bin/cf-orbs.js doctor --dir ~/orbs-dev
amp -ox "hello" --orb-provider cf-orbs-dev
```

After each code change, run `npm run build -w cli`, then `node cli/bin/cf-orbs.js deploy --dir ~/orbs-dev`.

Things that catch people out:

- A Durable Object that holds a running container keeps the old Worker code after a deploy. Your change reaches an orb only after its DO is evicted. So pause or delete the orb, or test on a new thread. It also means ops must work across code versions.
- Amp caches one project snapshot per provider for 72 h (Amp → Orb Settings → Snapshots). After you change the bootstrap, `.agents/setup` or the image, delete that snapshot, or new threads will start from the old disk.
- `/etc/hosts` is read-only after a snapshot restore.

Remove the test install with `node cli/bin/cf-orbs.js uninstall --dir ~/orbs-dev --yes`.

## Style

- TypeScript strict, ESM. Biome formats and lints (`npm run lint:fix`).
- Tests with vitest. A bug fix comes with a test that fails without it.
- Every failure the user sees is one line: `Failed: <cause> — fix: <action>`. No stack traces in API responses.
- Never log, store or print a token. Use the shared redaction for every log line that can hold one.
- Docs, comments, commit messages and error text: short, plain sentences, one idea each. Use the terms the docs already use (orb, provider, control plane, snapshot, handle).

## Code you did not write

Only send code you wrote or code under a license that allows it (Apache-2.0, MIT, BSD and similar). Do not paste code from a repo that has no license or from a source that does not allow reuse. If you adapt code from a licensed project, say so in the pull request and add the attribution to [NOTICE](NOTICE).

## Sign-off

No CLA and no DCO sign-off. By opening a pull request you agree that your contribution is licensed under Apache-2.0, as section 5 of the [LICENSE](LICENSE) says.

## Benchmarks

Benchmark runs cost money on your account, and every run is kept, failures included. See [docs/benchmarks.md](docs/benchmarks.md).

## Releases

Maintainers only. See the comments at the top of [.github/workflows/release.yml](.github/workflows/release.yml).
