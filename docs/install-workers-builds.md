# Install without Docker: Workers Builds (preview)

This path needs no Docker on your machine. [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) builds the two images in your Cloudflare account from a GitHub or GitLab repo, and deploys the Worker on each push.

It is a preview. The default install (`cf-orbs init`, local Docker) does not change. Tested end to end on 2026-11-02 (Worker `cf-orbs-wb`, two builds: a first install and an upgrade).

## You need

| You need | Check |
| --- | --- |
| Node 22 or later | `node --version` |
| A GitHub or GitLab account | You make one empty repo |
| A Cloudflare account on **Workers Paid** | Dashboard → Workers & Pages → Plans |
| wrangler logged in to that account | `npx wrangler login`, then `npx wrangler whoami` |
| An Amp provider token (`aop_live_…`) and its provider name | Amp → Settings → Orbs → Add Provider. You can also set the token later |
| git | `git --version` |

You do not need Docker.

## Steps

### 1. Make the project

```sh
mkdir my-orbs && cd my-orbs
npx cf-orbs init --no-deploy --provider-name <name from Amp> --token-file <file>
```

Put the token in a file with mode 600. Without `--token-file` (and without `AMP_ORB_PROVIDER_TOKEN`), `init` asks in a terminal; press Enter to skip and set it later. Add `--non-interactive` for an agent or CI. `--name <worker>` sets the Worker name (default `cf-orbs`). `--vcpu`, `--subdomain` and `--account-id` work as in the default install. `--provider external` does not work with `--no-deploy`.

`init --no-deploy` does this, in about 10 s:

1. Checks Node, the wrangler login and the account. It does not look for Docker. It runs `wrangler containers list` and stops on a clear plan or login error.
2. Writes `cf-orbs.config.jsonc`, `image/Dockerfile`, `.cf-orbs/` (Worker source, provider image, dispatch, `wrangler.jsonc`) and the control token (`.cf-orbs/control-token`, mode 600).
3. Registers a workers.dev subdomain if the account has none.
4. Writes `package.json` (wrangler pinned to the version the CLI uses), `package-lock.json` and `.gitignore`. The `.gitignore` keeps out `.cf-orbs/control-token`, `.cf-orbs/state.json`, `.wrangler/` and `node_modules/`. Workers Builds needs the other files in `.cf-orbs/`, so they go into git.
5. If the directory is not in a git repo: `git init -b main` and a first commit. Before the commit, it looks for an `aop_live_` token or the control token in the staged files, and stops if it finds one.
6. Creates the Worker (a placeholder until the first build) and sets the secrets `CONTROL_TOKEN` and `AMP_ORB_PROVIDER_TOKEN` with `wrangler secret bulk` from a temporary 0600 file. Secrets stay on the Worker across builds.
7. Writes `.cf-orbs/state.json` with the Worker URL (`https://<name>.<subdomain>.workers.dev`) and `"mode": "git"`, so `status`, `logs` and `doctor` work after the first build.
8. Skips the orb self-test: the build runs later. A rerun after a build shows the last prewarm result as the self-test.
9. Prints the next steps and the settings below.

`init --no-deploy` is safe to run again. It keeps the control token and makes no second commit.

### 2. Push the repo

Make an empty repo on GitHub or GitLab, then:

```sh
git remote add origin <repo URL>
git push -u origin main
```

The repo can be private. It holds no secrets.

### 3. Connect the repo to the Worker

Cloudflare dashboard → **Workers & Pages** → your Worker → **Settings** → **Builds** → **Connect**. The first time, the dashboard asks you to install the Cloudflare GitHub (or GitLab) app.

| Setting | Value |
| --- | --- |
| Repository | the repo from step 2 |
| Branch | `main` |
| Build command | empty |
| Deploy command | `npx wrangler deploy --config .cf-orbs/wrangler.jsonc` |
| Root directory | `/` |
| Previews (builds for non-production branches) | off |
| API token | the default build token |
| Build watch paths (include) | `image/**`, `.cf-orbs/**`, `cf-orbs.config.jsonc`, `package*.json` |

The Worker name in the dashboard must be the `name` in `cf-orbs.config.jsonc`. `init` makes them the same.

Keep previews off. A Containers Worker gets no preview URL, and a preview build on a branch must never run `wrangler deploy` on the live Worker.

If no build starts, push a commit.

### 4. Wait for the first build

Measured on 2026-11-02:

| Build | Build time | Push to live |
| --- | --- | --- |
| First install (both images, 1.8 GB orb image) | 10 min 35 s | 14 min |
| Upgrade (new orb image) | 5 min 39 s | 7.5 min |

A build can also wait 2-4 min in the queue first. Builds have a 20 min limit; both builds were well under it.

### 5. Check

```sh
npx cf-orbs status     # provider: running
npx cf-orbs doctor     # every line PASS (INFO, SKIP and WARN do not fail)
```

The Worker starts the provider on its 5-min cron, so `status` can show it as not running for up to 5 min after the first build. Then the first thread (this spends Amp credits):

```sh
amp -ox "hello from cf-orbs" --orb-provider <name>
```

## Set the Amp token later

If you did not give a token in step 1:

```sh
npx cf-orbs init --no-deploy --token-file <file>
```

This sets the secret on the Worker. No build is needed. The cron starts the provider within 5 min. (The plain wrangler way also works: `npx wrangler secret put AMP_ORB_PROVIDER_TOKEN --config .cf-orbs/wrangler.jsonc`.)

## Upgrades

Every change goes through git: edit, commit, push. Workers Builds builds and deploys.

| Change | Do |
| --- | --- |
| Config (size, `maxRunning`, `warmMinutes`, …) | Edit `cf-orbs.config.jsonc`. Then `npx cf-orbs init --no-deploy` to write `.cf-orbs/wrangler.jsonc` again. Commit both, push |
| Toolchains in the orb image | Edit `image/Dockerfile`. Commit, push |
| New Amp orb image | `npx cf-orbs upgrade --digest sha256:<hex> --no-deploy` (in git mode it also writes `.cf-orbs/wrangler.jsonc`). Commit, push |
| New cf-orbs version | Update the CLI, then `npx cf-orbs init --no-deploy` (writes `.cf-orbs/` again). Commit, push |

A new provider image (a new cf-orbs version) restarts the provider at the next 5-min cron check.

## Caveats

- **No Docker layer cache.** Each build builds the orb image again, so each push makes a new orb image digest. The first spawn on each Cloudflare host then pulls the 1.8 GB image again (40-50 s), also when nothing in the image changed. The path filters keep docs-only pushes from building.
- **No prewarm.** `cf-orbs deploy` asks the Worker to prewarm after a deploy; a Workers Builds deploy does not. To prewarm after a build, send the request yourself (it puts the control token on the command line of `curl`):

  ```sh
  curl -fsS -X POST -H "Authorization: Bearer $(cat .cf-orbs/control-token)" \
    "$(node -p 'require("./.cf-orbs/state.json").url')/v1/warm"
  ```

- **`account_id` is in the repo.** `.cf-orbs/wrangler.jsonc` names your account. This is not a secret, but keep the repo private if you do not want it seen.
- **Manual steps.** cf-orbs cannot do these for you: install the Cloudflare GitHub or GitLab app, connect the repo, and (if you skipped it) set the Amp token once.
- **Builds use the account's build token.** The default build token can deploy any Worker in the account.
- **Awake orbs keep old Worker code** until they pause, as with `cf-orbs deploy`.

## Troubleshooting

| You see | Do this |
| --- | --- |
| `doctor`: health `route not found (404)` with fix `wait for the Workers Builds build` | The first build has not finished. Look at Workers & Pages → your Worker → Deployments, or the build log |
| Build log: `Missing entry-point` | Root directory is not `/`, or `.cf-orbs/` is not in the repo. Check `.gitignore`; `cf-orbs doctor` checks it |
| Build log: `Could not route to /client/v4/accounts/…` | `account_id` in `.cf-orbs/wrangler.jsonc` is another account. Run `init --no-deploy --account-id <id>` again, commit, push |
| Build log: `Containers need the Workers Paid plan` | Upgrade the account, then retry the build |
| Build timed out (20 min) | Retry the build. Measured builds took 6-11 min |
| `doctor`: `wrangler pin` fails | `package.json` pins another wrangler. Set it to the version in the fix line, `npm install`, commit, push |
| `doctor`: `gitignore` or `secrets in git` fails | Do the fix in the line. If a token was pushed, make a new one |

## Remove

`npx cf-orbs uninstall` lists what it would delete; `--yes` deletes it. Disconnect the repo first (Workers & Pages → your Worker → Settings → Builds → Disconnect), or the next push deploys the Worker again.
