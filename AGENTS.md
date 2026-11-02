# AGENTS.md: install cf-orbs from a terminal

For an AI agent that installs cf-orbs for a user. Run the commands in order. Stop and report when a check fails. Every cf-orbs error is one line, `Failed: <cause> — fix: <action>`: do the action, then run the same command again.

Developing this repo instead of installing it? Read [CONTRIBUTING.md](CONTRIBUTING.md).

## 0. Ask the user for

1. An Amp provider token (`aop_live_…`) and the provider name. The user makes both in Amp → Settings → Orbs → Add Provider. Do not make up a name; it must match Amp.
2. The Cloudflare account id, if their wrangler login has more than one account.
3. A project directory (default `~/cf-orbs-install`).

Never print the token, never put it in a command line that is logged, never commit it. Put it in a file with mode 600 and use `--token-file`.

## 1. Check prerequisites

```sh
node --version          # must be v22 or later
docker info >/dev/null && echo docker-ok
npx wrangler whoami     # must show "You are logged in" and the account
```

- Node too old: ask the user to install Node 22+.
- Docker fails: ask the user to start Docker.
- Not logged in: `npx wrangler login` opens a browser. Ask the user to finish it, then run `npx wrangler whoami` again.
- The account must be on Workers Paid. `init` asks wrangler to list Containers before the image build and stops with `Containers need the Workers Paid plan` on a clear plan error. The check is best effort: the deploy fails with the same message if it misses.

## 2. Install

```sh
mkdir -p ~/cf-orbs-install && cd ~/cf-orbs-install
tok="$(mktemp)"                                # outside the project, mode 600
trap 'rm -f "$tok"' EXIT                       # removed also when init fails
printf '%s' "$TOKEN_FROM_USER" > "$tok"        # or write the file with your file tool
npx cf-orbs init --non-interactive \
  --token-file "$tok" \
  --provider-name "<name from Amp>" \
  --subdomain "<name>" \
  --account-id "<id>"                          # only if whoami lists several accounts
```

- `--subdomain` is used only if the account has no workers.dev subdomain yet. Pick a short lowercase name.
- Orb size: the default is 4 vCPU, 12 GiB, 20 GB disk. If the user wants a cheaper orb, add `--vcpu 2` (2 vCPU, 6 GiB, about half the memory cost). `--vcpu` takes 1, 2, 3 or 4 and writes N vCPU, N x 3 GiB.
- Expect 5-15 min. Measured: 4 min 41 s, most of it the push of a 1.8 GB image. Use a command timeout of at least 20 min, or run it in the background and wait for it to exit.
- Lines like `deploy: registry push timed out; retry 1 of 3` are normal. `init` retries by itself.

Success: exit code 0, a line `provider: running — …`, and a last line `amp -ox "hello from cf-orbs" --orb-provider <name>`. With `--json` the result is one JSON object with `"ok": true`, `url` and `next`.

## 3. Verify

```sh
npx cf-orbs doctor      # every line PASS (INFO and SKIP are fine); exit code 0
npx cf-orbs status      # "provider: running"
```

Then the first thread. This spends the user's Amp credits, so ask first:

```sh
amp -ox "hello from cf-orbs" --orb-provider "<name>"
```

The first spawn on a new host starts from the image (about 45 s), then Amp sets up the repo.

## 4. If something fails

| Symptom | Do |
| --- | --- |
| `Failed: … — fix: …` | Do the fix, run the same command again. `init` is safe to rerun |
| `image push to registry.cloudflare.com kept failing` | `npx cf-orbs deploy` |
| `Amp rejected the provider token` | Ask the user for a new token, write it to a new `mktemp` file as in step 2, `npx cf-orbs init --non-interactive --token-file "$tok"` |
| `another amp orb provider already uses this token` | Another provider runs on this token. Ask the user to stop it or make a new token |
| Thread setup log says `Repository configuration failed` | Ask the user to delete the cached snapshot in Amp → Orb Settings → Snapshots, then `npx cf-orbs snapshots forget --all-project` |
| Orb does not start | `npx cf-orbs logs <orb id>` and `npx cf-orbs status <orb id>`. Orb ids are `amp-<thread id>` |

## Where things are

| What | Where |
| --- | --- |
| Config (edit, then `npx cf-orbs deploy`) | `cf-orbs.config.jsonc` |
| Orb image (edit, then `npx cf-orbs deploy`) | `image/Dockerfile` |
| Generated files, do not edit | `.cf-orbs/wrangler.jsonc`, `.cf-orbs/worker/`, `.cf-orbs/provider/`, `.cf-orbs/dispatch/` |
| Worker URL, account, provider name | `.cf-orbs/state.json` |
| Control token (secret, mode 600, gitignored) | `.cf-orbs/control-token` |
| Provider log (redacted, last 20 lines) | `npx cf-orbs logs --provider` |
| One orb's bootstrap log (redacted) | `npx cf-orbs logs <orb id> --lines 200` |
| Worker logs, live | `npx wrangler tail --config .cf-orbs/wrangler.jsonc` |
| Machine-readable output | add `--json` to any command |
| Old snapshot data (`prunable` in `status`) | `npx cf-orbs snapshots prune` lists it. Ask the user before you add `--yes`: it deletes data |

## Do not

- Do not set `"debugExec": true` unless the user asks for the substrate benchmark. It lets the control token run commands in orbs.
- Do not run `npx cf-orbs uninstall --yes` without the user's go-ahead. Without `--yes` it only lists what it would delete.
- Do not start a second `amp orb provider` on the same token.
- Do not edit `.cf-orbs/wrangler.jsonc`. `deploy` writes it again.
