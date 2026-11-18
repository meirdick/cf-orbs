# One-click install (Deploy to Cloudflare button)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/meirdick/cf-orbs-template)

The button installs cf-orbs with no tools on your machine. Cloudflare clones the [template repo](https://github.com/meirdick/cf-orbs-template) into your GitHub or GitLab account, builds both container images with Workers Builds and deploys the Worker to your account. The provider then starts by itself.

## Before you start

| You need | Where |
| --- | --- |
| A Cloudflare account on **Workers Paid** ($5/month; Containers need it) | Dashboard → Workers & Pages → Plans |
| A workers.dev subdomain on that account. Most accounts have one, and the deploy needs it | Dashboard → Workers & Pages |
| A GitHub or GitLab account | The button makes a repo in it |
| An Amp provider token (`aop_live_…`) | Amp → Settings → Orbs → Add Provider. Note the provider name you type there |

## Install

1. Click the button.
2. Fill in the setup page:

   | Setting | What to pick |
   | --- | --- |
   | **Project name** | Any name. The Worker and its containers take it |
   | **AMP_ORB_PROVIDER_TOKEN** | Your Amp provider token. It is the only secret the page asks for |
   | **Enable Preview builds** | Off. This Worker gets no preview URL, so a branch build only uses build minutes |
   | **Create private Git repository** | Your choice. The repo holds no secrets; they live on the Worker |

   The page may say *"No Wrangler configuration detected"*. That is expected: the config is at `.cf-orbs/wrangler.jsonc` and the deploy finds it. Leave the advanced settings as they are.
3. Wait for the build: 10-15 min, plus 2-4 min in the queue. Watch it under Workers & Pages → your Worker → Deployments.

When the build finishes, the provider starts within 5 min and registers with Amp. There is nothing else to set up.

If you left the token empty, the Worker idles until you add `AMP_ORB_PROVIDER_TOKEN` in the dashboard (Worker → Settings → Variables and Secrets).

## Try it

This spends Amp credits:

```sh
amp -ox "hello from cf-orbs" --orb-provider <the provider name from Amp Settings>
```

In the Amp app, pick the provider under **Self-Hosted** when you start a thread. The first orb on each Cloudflare host pulls the 1.8 GB orb image (40-50 s).

## A second install

Click the button again and pick another project name. Each install is its own Worker with its own containers. Give each one its own Amp provider token: two providers must not share a token.

## Changes and upgrades

Workers Builds redeploys your repo on every push to `main`. To change the orb image, edit `image/Dockerfile` and push. To rotate the Amp token, paste a new one in the dashboard (Worker → Settings → Variables and Secrets).

## Add the CLI later

The install needs no CLI. Add it if you want `status`, `logs`, `doctor` or `upgrade`, or to change `cf-orbs.config.jsonc` (orb size, caps, prewarm). In a clone of the repo the button made:

```sh
npx wrangler login          # once, to the account you deployed to
npx cf-orbs init --no-deploy --adopt --name <your project name>
```

`init --adopt` makes the control token the CLI authenticates with, sets it as a Worker secret and writes `.cf-orbs/state.json`. Until then the Worker's control API answers 404 to everyone. It also updates the generated files to the CLI's version; commit and push them. It asks for the Amp token: press Enter to keep the one you set. It prints Workers Builds dashboard steps too; the button already did those.

## Caveats

The button uses Workers Builds, so [the Workers Builds caveats](install-workers-builds.md#caveats) apply: no Docker layer cache, no prewarm after a build, the build token's scope, and awake orbs keep the old Worker code.

- **The template can lag the CLI.** The button deploys what the template repo holds. `init --adopt` brings a clone up to the CLI's current files.
- **The repo keeps the name `cf-orbs-template` in its config.** The build writes your project name into `.cf-orbs/wrangler.jsonc` in its own checkout and commits nothing, because wrangler names the container applications from that file and not from the project name ([workers-sdk#15827](https://github.com/cloudflare/workers-sdk/issues/15827)). `init --adopt --name` writes the name into your repo.
