# Security policy

## Report a vulnerability

Report it privately through GitHub: [Security → Report a vulnerability](https://github.com/meirdick/cf-orbs/security/advisories/new). Do not open a public issue, pull request or discussion for it.

Include the cf-orbs version (`cf-orbs --version`), the provider mode (`cloudflare` or `external`), the steps to reproduce and what an attacker gets. Remove tokens from logs before you send them (see [Token handling](#token-handling)).

This is a community project with one maintainer. Expect a first reply within 7 days. We fix the latest release only.

A problem in Cloudflare Containers, Workers or Amp itself goes to that vendor: [Cloudflare](https://www.cloudflare.com/disclosure/) or Amp support.

## What the control token protects

`cf-orbs init` makes a random control token. The Worker keeps it as the secret `CONTROL_TOKEN`. It is the bearer for the public API at `https://<worker>.<subdomain>.workers.dev/v1`. Without the right token every route returns 401. If the secret is not set, every public route returns 404.

A holder of the control token can:

- spawn, pause and delete any orb. Spawns run on your account and cost money. Delete drops the orb's snapshot handle, so its paused work is lost.
- read the status of the install and of each orb, and read each orb's redacted bootstrap log and the provider log.
- when `"debugExec": true` is in `cf-orbs.config.jsonc`: run any command in any orb (`/v1/orbs/<id>/exec`) and start `bench-*` orbs. That is full access to the code and files in your orbs. Keep `debugExec` off except while you run the substrate benchmark.

The control token does not give access to your Cloudflare account, your Amp account or the Amp provider token.

In Cloudflare-hosted mode the provider container reaches the control plane at `http://control.internal`. That route stays inside your Worker and needs no token.

## Token handling

cf-orbs deals with three secrets:

| Secret | Where it lives | Never |
| --- | --- | --- |
| Amp provider token (`aop_live_…`) | Cloudflare-hosted mode: Worker secret `AMP_ORB_PROVIDER_TOKEN`, passed only to the provider container env. External mode: an env file on your host | In an orb, in a log, in argv, on disk in the Cloudflare project |
| Control token | Worker secret `CONTROL_TOKEN`; `.cf-orbs/control-token` in your project (mode 0600, gitignored); `CF_ORBS_CONTROL_TOKEN` or `CF_ORBS_CONTROL_TOKEN_FILE` on an external provider host | In `cf-orbs.config.jsonc`, `.cf-orbs/state.json` or git |
| `ORB_TOKEN` | Minted by Amp for one spawn, expires after 15 min. Passed to the orb in the bootstrap exec env only | On the orb disk or in a log |

`init` sends secrets to wrangler in a temporary secrets file that it deletes when it ends. Every log line that cf-orbs stores or prints goes through one redaction: the exact token values, then `aop_live_*`, `orb_*`, bearer values, JWTs and long base64 or hex runs. `dispatch.sh` never prints its environment and passes the bearer to `curl` on stdin.

Before each snapshot, pause masks token shapes (`aop_live_`, `orb_`, bearer values, JWTs) in `~/.cf-orbs/bootstrap.log` and `~/.cache/amp/logs/*.log`. Checked on 2026-11-02 on a live orb with a real `ORB_TOKEN`: a scan of the home dot-directories and `/tmp` found no token shape, and the pause masked 0 files. The scan cannot prove that Amp never writes the token in another form. A pause keeps the disk in a snapshot, and a project snapshot is shared by later threads on that project. `ORB_TOKEN` expires after 15 min.

### If a token leaks

- Control token: delete `.cf-orbs/control-token` and run `cf-orbs init` again in the same directory. It makes a new token and deploys it. On an external provider host, update `CF_ORBS_CONTROL_TOKEN` and restart the provider.
- Amp provider token: revoke it in Amp → Settings → Orbs, make a new one, then run `cf-orbs init --token-file <file>`.
- Before you post `cf-orbs doctor`, `status` or `logs` output in an issue, check it for anything that looks like a token. The redaction is a safety net, not a promise.
