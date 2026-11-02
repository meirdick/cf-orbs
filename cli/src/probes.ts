// Environment probes shared by init, deploy and doctor.
import { CliError } from "./errors.js";
import { makeWrangler, parseWhoami, type Runner, type WhoAmI } from "./wrangler.js";

export function nodeMajor(version = process.versions.node): number {
  return Number.parseInt(version.split(".")[0] ?? "0", 10);
}

export async function dockerOk(run: Runner): Promise<boolean> {
  const r = await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 20_000 });
  return r.code === 0;
}

export async function requireDocker(run: Runner): Promise<void> {
  if (!(await dockerOk(run))) {
    throw new CliError(
      "Docker is not running (wrangler builds the orb image locally)",
      "start Docker Desktop or the docker daemon, check `docker info`, then rerun",
    );
  }
}

export async function whoami(run: Runner): Promise<WhoAmI> {
  const r = await makeWrangler(run).run(["whoami", "--json"], { timeoutMs: 60_000 });
  if (r.code !== 0) return { loggedIn: false, accounts: [] };
  return parseWhoami(r.stdout);
}
