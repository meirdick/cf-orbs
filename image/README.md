# Orb image

`image/Dockerfile` builds the image every orb runs. It is the Amp orb image, pinned by digest, plus
`tini` as PID 1 and `sleep infinity` as the command. `cf-orbs deploy` builds it and stores it under the
image key `orb`.

In an installed project the file is `image/Dockerfile` in your project directory (`cf-orbs init` writes it
once and never overwrites it). The build context is `image/`. An extra image key `<key>` from `images` in
`cf-orbs.config.jsonc` builds from `image/<key>.Dockerfile` with the same context.

## What cf-orbs needs from the image

Keep these when you change the file:

- `FROM` an Amp orb image (or an image that meets Amp's
  [bring-your-own-image rules](https://ampcode.com/docs/orbs/self-hosted#bring-your-own-image)).
- User `user`, uid 1000, HOME `/home/user`, passwordless `sudo`.
- `amp`, `bash`, `sudo`, `hostname`, `setsid`, `flock`, `ps`, `pgrep`, `sha256sum` and `stat` on PATH
  (the start and stop scripts in `worker/src/orb/scripts.ts` use them; the Amp image has them).
- `localhost` in `/etc/hosts`. The deployed hostname does not resolve, so the bootstrap script runs
  `sudo hostname localhost`. It cannot add a line instead: `/etc/hosts` is read-only after a snapshot
  restore.
- `ENTRYPOINT ["/usr/bin/tini", "-s", "--"]` and `CMD ["sleep", "infinity"]`. Without an init that
  reaps, stopped `amp` processes stay as zombies. Without a long-running command the container exits.
- linux/amd64. Cloudflare Containers run amd64 only.

## Add toolchains

1. Add `RUN` lines between `USER root` and `USER user`:

   ```dockerfile
   RUN apt-get update \
    && apt-get install -y --no-install-recommends golang-go \
    && rm -rf /var/lib/apt/lists/*
   ```

   Pin versions where you can (`pkg=<version>`; `apt-cache policy <pkg>` in the image shows the
   version), because a rebuild with unpinned packages can give a different image (see below).
2. Check it locally:

   ```sh
   docker build --platform linux/amd64 -t cf-orbs-orb:dev image/
   docker run --rm cf-orbs-orb:dev bash -lc 'ps -o args= -p 1; id -u; amp --version'
   ```

   Expect `/usr/bin/tini -s -- sleep infinity`, `1000` and an amp version.
3. Run `cf-orbs deploy`. The image push is about 1.8 GB the first time. The registry sometimes times out
   on a large layer or answers `Unauthorized` after image preparation; `deploy` retries both up to 3
   times. If it still fails, run `cf-orbs deploy` again: the registry keeps the layers it got.
4. Clear the project snapshot caches, or new threads keep starting from a disk made with the old image:
   - Amp caches one project snapshot per provider for 72 h. Delete it in Amp → Orb Settings → Snapshots
     (or `amp projects snapshots delete <owner/repo> --resource <size>`).
   - Then `cf-orbs snapshots forget --all-project`.

   Do the same after a change to a repo's `.agents/setup`.

Repo setup that is specific to one project belongs in that repo's `.agents/setup`, not here. Amp runs it
when an orb starts, and project snapshots keep the result.

## Snapshots and the image

A snapshot (a pause, or an Amp project snapshot) holds an orb's disk. The image still matters for
paused orbs, so:

- Never use a tag such as `:latest` in `FROM`. Keep the digest pin.
- A change to this file, or a rebuild without cache, gives a new image under the same key `orb`. Tested: snapshots from the old image still restore on the new one, and a restored disk keeps its old content. New image content reaches only orbs started from the image. If a restore fails with "snapshot not found", the orb starts from the new image and Amp sets the repo up again.
- Do not remove an image key while a snapshot that uses it is younger than 30 days.
- To move to a newer Amp orb image, run `cf-orbs upgrade --digest sha256:<new>`. It bumps the digest
  and keeps the old image buildable under a new key `orb-<short>` (`image/orb-<short>.Dockerfile` and
  an `images` entry). Paused orbs and project snapshots still name key `orb`, which is now the new image.
  They restore on it, as tested above. `upgrade` still warns that they may not, and asks you to push or
  commit their work first. `upgrade` prints the cache steps from
  "Add toolchains" step 4; do them.
- Orbs that are awake during a deploy keep the old Worker code until they pause (a Cloudflare
  behaviour). They keep running on the image they started from.

## Run the script tests against your image

The scripts that start and stop `amp orb bootstrap` are tested in Docker
(`worker/test/scripts.docker.test.ts`). To run them against your build:

```sh
CF_ORBS_DOCKER=1 CF_ORBS_DOCKER_IMAGE=cf-orbs-orb:dev npx vitest run worker/test/scripts.docker.test.ts
```
