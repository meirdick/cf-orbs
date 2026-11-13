# One-click install (Deploy to Cloudflare button)

The [Deploy to Cloudflare button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) installs cf-orbs from a public template repo in one click: Cloudflare clones the template into the user's own GitHub or GitLab account, builds both container images with Workers Builds and deploys the Worker. No Node, Docker or wrangler on their machine.

The template repo lives at [meirdick/cf-orbs-template](https://github.com/meirdick/cf-orbs-template) and is generated from this repo by `npx cf-orbs template` (below). Its README is [docs/button-template/README.md](button-template/README.md).

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/meirdick/cf-orbs-template)
```

This path is a preview, like [the Workers Builds path](install-workers-builds.md) it is built on (same build machinery, same caveats), and it does not change the default install (`cf-orbs init`, local Docker).

## What the user does

1. **Click the button** on the template repo (or any page that embeds it). Requirements: a Cloudflare account on Workers Paid. On the setup page they pick a repo name and a Worker name; keep the default `cf-orbs`, or set the same `"name"` in `cf-orbs.config.jsonc` afterwards — the button rewrites `.cf-orbs/wrangler.jsonc` in their clone, not `cf-orbs.config.jsonc`, and a mismatch makes the next deploy create a second Worker. The first build takes 10-15 min (measured for the Workers Builds path: 10.6 min, plus 2-4 min in the queue).
2. **Set the secrets.** The template deploys with none, so the provider takes no jobs until, in a clone of the repo the button made:
   ```sh
   npx wrangler login          # once, to the account they deployed to
   npx cf-orbs init --no-deploy --adopt
   ```
   `init --adopt` asks for the Amp provider token (Enter skips; set it later with `--token-file`), generates the control token, sets both as Worker secrets, and writes `.cf-orbs/state.json` so `status`, `logs` and `doctor` work. It prints Workers Builds dashboard steps the button already did — ignore those. The alternative is setting both secrets by hand in the dashboard (Worker → Settings → Variables and Secrets) and writing `.cf-orbs/control-token` and `.cf-orbs/state.json` yourself, but the adopt command does all of it in one step.
3. **Check and try it:** `npx cf-orbs status` (the 5-min cron starts the provider), `npx cf-orbs doctor`, then `amp -ox "hello from cf-orbs" --orb-provider <name>`.

From there, upgrades and config changes go through git like the Workers Builds path: edit, `npx cf-orbs init --no-deploy` to regenerate `.cf-orbs/wrangler.jsonc`, commit, push.

## Why the secrets are not in the template

The template repo is public, and both secrets are per-user: the Amp token is personal, and the control token must be random per install (a checked-in value would let anyone reach the API of every deployment that kept it). So the deploy itself needs no secrets, and `init --adopt` sets them afterwards. The template's `.dev.vars.example` lists both keys commented out, and `package.json` carries `cloudflare.bindings` descriptions for them, so the setup page explains them if it prompts.

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
