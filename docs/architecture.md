# Architecture

cf-orbs is a self-hosted Amp orb provider. Amp sends it orb jobs, and cf-orbs runs each orb as a Cloudflare Container and saves its disk as a snapshot when the orb pauses. For the Amp side of the contract, read [the provider contract](01-amp-orb-provider-contract.md).

## Parts

```
Amp ──outbound──> provider container (amp orb provider → dispatch.sh)
                        │ POST /v1/orbs/<id>/ops   (bearer: control token)
                        ▼
        Worker `cf-orbs`
          ├─ OrbSession Durable Object, one per orb ── Container (microVM: own kernel, network, disk)
          ├─ Registry Durable Object ── project-snapshot map, snapshot index, awake-orb set
          └─ ProviderHost Durable Object ── the provider container
```

| Part | Job |
| --- | --- |
| Worker `cf-orbs` | HTTP API under `/v1`. Holds all state in Durable Objects. |
| `OrbSession` (one per Amp thread, named `orb:<ORB_ID>`) | Runs spawn, pause and delete for one orb. Owns that orb's container, snapshot handle and alarm. |
| `Registry` (one, named `registry`) | Maps an Amp `ORB_SNAPSHOT_ID` to a Cloudflare snapshot. Lists every snapshot, because Cloudflare has no list API. Counts awake orbs for `maxRunning`. |
| `ProviderHost` | Starts the provider container and keeps it running. |
| Provider container | Runs `amp orb provider` with the provider token. Amp sends each job over an outbound connection, so no inbound port is open. For each job, `dispatch.sh` calls the Worker. |
| Orb container | Amp's orb image plus `tini` as PID 1. One per thread. |

## Control

- Amp gives the provider three operations: `spawn`, `pause` and `delete`. `dispatch.sh` (POSIX `sh` and `curl`) turns each into one Worker op: `POST /v1/orbs/<id>/ops`, then a long poll on `GET /v1/ops/<opId>` that prints progress lines into Amp's setup log. The same inputs return the same op, so a retry attaches to the running op.
- The CLI and the provider use the same API with a control token (`.cf-orbs/control-token`, mode 600). It is a Worker secret and is never in argv.
- Every container action runs in a queue inside the `OrbSession`. An op journal lets a restarted Durable Object resume or fail an op by its phase.
- A 60 s alarm checks an awake orb, extends its inactivity timeout, and pauses it if it stays awake longer than `maxAwakeHours` or its bootstrap died.

## Spawn

The first match wins:

1. The container runs: reuse it.
2. The orb has its own snapshot: restore it.
3. This is a new orb and `ORB_SNAPSHOT_ID` maps to a snapshot: restore that (Amp's project snapshot, so repo setup is skipped).
4. Start from the orb image.

Then `amp orb bootstrap` starts in its own process group with the orb token from Amp. The token goes only into the process environment, and the state file keeps only a hash. Spawn succeeds when the bootstrap is alive and Amp reports it connected.

## Pause and billing

Pause stops the Amp processes, masks token shapes in the log files, takes a snapshot of the disk and destroys the container. A paused orb has no compute charge. The next message restores the disk (about 0.6 s for the container, 2-3 s for the whole spawn). With `warmMinutes` above 0, the container and Amp's processes stay up for a while after the disk is saved, so a quick follow-up needs no restore.

Compute is billed while an orb runs: memory and disk for the whole time, CPU only on active use. See [the price table in the README](../README.md#costs). Cloudflare publishes no snapshot storage rate yet. `cf-orbs status` shows the retained snapshot size, and `cf-orbs snapshots prune` removes snapshots that nothing uses.

## Rules that shape the code

- Core logic is written against a `ContainerPort` interface. Tests use a fake that models the verified Cloudflare semantics, because snapshots do not run under `wrangler dev`.
- Stored records carry a schema version. A Durable Object that holds a running container keeps old Worker code after a deploy, so readers accept older versions.
- No secret goes into argv or a log. Log tails are redacted with the same rules in the Worker and in the shell scripts.
- One orb size per install. Amp sends no size in a job.
- Orb image: pinned to one Amp image digest. See [image/README.md](../image/README.md).

## Known limits

- The Durable Object that holds a container can reset during a long spawn wait. The op fails and Amp retries.
- Cloudflare picks the host. The first spawn on a host without the image pulls it (about 45 s).
- Snapshots restore lazily: the first read of a large cache is slower than later reads.
