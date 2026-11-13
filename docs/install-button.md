# One-click install (Deploy to Cloudflare button)

The [Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) installs cf-orbs from a public template repo in one click: Cloudflare clones the template into the user's own GitHub or GitLab account, builds both container images with Workers Builds and deploys the Worker. No Node, Docker or wrangler on their machine.

The template repo lives at [meirdick/cf-orbs-template](https://github.com/meirdick/cf-orbs-template) and is generated from this repo by `npx cf-orbs template` (below). Its README is [docs/button-template/README.md](button-template/README.md).

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/meirdick/cf-orbs-template)
```

This path is a preview, like [the Workers Builds path](install-workers-builds.md) it is built on (same build machinery, same caveats), and it does not change the default install (`cf-orbs init`, local Docker).

## What the user does

1. **Click the button** on the template repo (or any page that embeds it). Requirements: a Cloudflare account on Workers Paid and an Amp provider token (`aop_live_…` from Amp → Settings → Orbs → Add Provider). On the setup page they pick a repo name, keep the **default Project name `cf-orbs-template`** (it matches the Worker the config deploys; renaming it leaves a stray empty project beside the real Worker), turn **Preview builds off** (a Containers Worker gets no preview URL, so with previews on a branch push just burns build minutes uploading an unreleased Worker version; never change the non-production branch command to `wrangler deploy`), and **paste the Amp token** — `.dev.vars.example` leaves only that key uncommented, so it is the one secret the page asks for, with the `package.json` description explaining where it comes from. The repo the button creates can be private; it holds no secrets. The page may say *"No Wrangler configuration detected"* — that is expected, and the redirect below makes the deploy work anyway. The first build takes 10-15 min (measured for the Workers Builds path: 10.6 min, plus 2-4 min in the queue).
2. **Nothing.** The deploy sets the pasted token as the Worker secret `AMP_ORB_PROVIDER_TOKEN`; the provider starts by itself within 5 min (the Worker cron) and registers with Amp. The install is set-it-and-forget-it: no terminal, no CLI, no further secrets. If the token is left empty the Worker idles safely (it treats an empty token as unset) until one is pasted in the dashboard (Worker → Settings → Variables and Secrets).
3. **Try it:** in Amp, `amp -ox "hello from cf-orbs" --orb-provider <name from Amp Settings>` (spends Amp credits).

From there, upgrades go through git: Workers Builds redeploys the user's clone on every push. Token rotation is a dashboard edit.

## Why CONTROL_TOKEN is not prompted

The template repo is public, and both secrets are per-user. The Amp token is prompted at click time — it is the one input no deploy flow can invent, because it is minted in the user's Amp account. The control token is **only** used by the cf-orbs CLI as the bearer for the control API; with it unset every public route 404s (a safe default) and the provider still runs, since the container talks to the control plane over `control.internal` inside Cloudflare. So the button path leaves it commented out in `.dev.vars.example`, and the setup page never asks for it. Users who want `status`, `logs` or `doctor` can add it later in one command:

```sh
npx wrangler login && npx cf-orbs init --no-deploy --adopt
```

`init --adopt` generates the control token, sets it as a Worker secret and writes `.cf-orbs/state.json` in the clone. It asks for the Amp token too — press Enter to keep the one the deploy set. It prints Workers Builds dashboard steps that the button already did — ignore those.

## Why no wrangler.jsonc at the root

The button's setup page only detects a Wrangler config at the repo root; ours is `.cf-orbs/wrangler.jsonc`, so the page says *"No Wrangler configuration detected"*. Moving it to the root would go stale the moment `cf-orbs init`/`deploy` regenerates the `.cf-orbs` one, so the template instead commits [`.wrangler/deploy/config.json`](https://developers.cloudflare.com/workers/wrangler/configuration/) (`{ "configPath": "../../.cf-orbs/wrangler.jsonc" }`), wrangler's documented redirect: a bare `npx wrangler deploy` — the button's default deploy command — loads the real config through it, with all paths still relative to the config. The `deploy` script in `package.json` passes `--config .cf-orbs/wrangler.jsonc` explicitly, so both deploy commands work.

## Make or refresh the template

```sh
npx cf-orbs template <dir>
```

Writes the same scaffold as `init --no-deploy` with three differences: `.cf-orbs/wrangler.jsonc` has no `account_id` (the button deploys to whichever account clicks it), no Worker is created and no secrets are set (nothing talks to Cloudflare), and it adds the button README, `.dev.vars.example` and the license files. It git-inits and makes a first commit, so the next step is only `git remote add origin … && git push` to a public repo.

To publish a new template version: run the command from the CLI version you want to ship, then push the result to the template repo. Regenerating is safe in an existing checkout: user-owned files (`cf-orbs.config.jsonc`, `image/`, `README.md`, `package.json`) keep their edits, and generated files (`.cf-orbs/worker`, `provider`, `dispatch`, `wrangler.jsonc`) are replaced.

## Caveats

Everything in [the Workers Builds caveats](install-workers-builds.md#caveats) applies (no Docker layer cache, no prewarm after a build, build token scope, awake orbs keep old Worker code). Two more for the button path:

- **Subdomain.** The button needs the account to have a workers.dev subdomain. `init --adopt` checks and registers one if missing, but until then the Worker URL is unknown.
- **The template lags the CLI.** The button deploys whatever the template repo holds. Users who run `init --adopt` get the CLI's current files and push them; users who never do keep the template's Worker code until the template repo is refreshed.
