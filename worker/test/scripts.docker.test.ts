// Tests for worker/src/orb/scripts.ts.
// Unit part (always): redact() rules, bash syntax, shell/TS redaction parity.
// Docker part (CF_ORBS_DOCKER=1): runs the scripts in the pinned Amp orb image as uid 1000, with PID 1 =
// `sleep infinity` (no reaping). CF_ORBS_DOCKER_IMAGE=<tag> runs them in a built image/Dockerfile instead,
// with its own tini entrypoint, as on Cloudflare.
// A stub `amp` in ~/.local/bin (the login profile puts it first on PATH) stands in for the real binary,
// except in the last test, which runs the real amp with a fake token and expects a rejection.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AMP_VERSION_FNS,
  BOOT_CONNECTED_RE,
  BOOTSTRAP_SH,
  FAST_MEMORY,
  LOGTAIL_SH,
  PIN_CPUS,
  QUIESCE_SH,
  RESUME_SH,
  redact,
  SCRUB_SH,
  STATUS_SH,
  WAIT_CONNECTED_SH,
} from "../src/orb/scripts";

const SCRIPTS = { BOOTSTRAP_SH, LOGTAIL_SH, QUIESCE_SH, RESUME_SH, SCRUB_SH, STATUS_SH, WAIT_CONNECTED_SH };

describe("redact", () => {
  it("removes token shapes", () => {
    expect(redact("key aop_live_AbC123xyz end")).toBe("key aop_live_<redacted> end");
    expect(redact("t=orb_0123456789abcdef0123 ok")).toBe("t=orb_<redacted> ok");
    expect(redact("Authorization: Bearer abc.def-ghi x")).toBe("Authorization: Bearer <redacted> x");
    expect(redact("tok eyJhbGciOi.test.sig done")).toBe("tok <redacted-jwt> done");
    expect(redact(`h ${"a".repeat(64)} h`)).toBe("h <redacted> h");
  });
  it("redacts exact secrets first", () => {
    expect(redact("x=hunter2-token y", ["hunter2-token"])).toBe("x=<redacted> y");
    expect(redact("x=ab y", ["ab"])).toBe("x=ab y"); // too short to be a secret
  });
  it("keeps ordinary ids", () => {
    const s =
      "orb_id=5 boot 12769d89-94eb-4fb0-9779-775aebed1ab5 T-0193f2e8-3b4c-7d9e-8f1a-2b3c4d5e6f70 " +
      "5421c2f791ed54a99bd743e19e095f959413d93b /home/user/.cache/amp/logs/cli.log";
    expect(redact(s)).toBe(s);
  });
});

describe("scripts", () => {
  it("parse with bash -n", () => {
    for (const [name, sh] of Object.entries(SCRIPTS)) {
      const r = spawnSync("bash", ["-n", "-c", sh], { encoding: "utf8" });
      expect(r.status, `${name}: ${r.stderr}`).toBe(0);
    }
  });
  it("contain no unescaped template output", () => {
    for (const sh of Object.values(SCRIPTS)) expect(sh).not.toMatch(/undefined|\[object /);
  });
  it("quiesce text does not match its own amp sweep (pgrep -f '/[.]amp/')", () => {
    // Its subshells carry the script text as their command line; a match makes quiesce signal itself.
    expect(QUIESCE_SH).not.toMatch(/\/[.]amp\//);
  });
  it("shell redaction matches redact()", () => {
    const home = mkdtempSync(join(tmpdir(), "cf-orbs-redact-"));
    try {
      const lines = [
        "plain line",
        "key aop_live_AbC123xyz end",
        "t=orb_0123456789abcdef0123 ok and orb_id=5",
        "Authorization: Bearer abc.def-ghi x",
        "tok eyJhbGciOi.test.sig done",
        `h ${"f".repeat(64)} h`,
        '{"message":"Connected to thread actor; announcing sandbox"}',
      ];
      mkdirSync(join(home, ".cf-orbs"));
      mkdirSync(join(home, ".cache/amp/logs"), { recursive: true });
      writeFileSync(join(home, ".cf-orbs/bootstrap.log"), `${lines.join("\n")}\n`);
      writeFileSync(join(home, ".cache/amp/logs/cli.log"), `${lines.join("\n")}\n`);
      const r = spawnSync("bash", ["-c", LOGTAIL_SH], {
        encoding: "utf8",
        env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", LINES: "50" },
      });
      expect(r.status, r.stderr).toBe(0);
      const want = lines.map((l) => redact(l)).join("\n");
      expect(r.stdout).toBe(`== bootstrap.log\n${want}\n== cli.log\n${want}\n`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("scrub_logs (R19)", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.abcDEF123_-xyz.sigSIG123_-";
  const lines = [
    "plain line stays",
    `key aop_live_AbC123xyz-_9 end`,
    "t=orb_0123456789abcdef0123 ok and orb_id=5",
    "Authorization: Bearer abc.def-ghi x",
    `tok ${jwt} done`,
    '{"message":"Connected to thread actor; announcing sandbox"}',
  ];
  const run = (home: string) =>
    spawnSync("bash", ["-c", SCRUB_SH], {
      encoding: "utf8",
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });

  it("masks token shapes in the logs, keeps length and inode, leaves other lines", () => {
    const home = mkdtempSync(join(tmpdir(), "cf-orbs-scrub-"));
    try {
      mkdirSync(join(home, ".cf-orbs"));
      mkdirSync(join(home, ".cache/amp/logs"), { recursive: true });
      const files = [".cf-orbs/bootstrap.log", ".cache/amp/logs/cli.log", ".cache/amp/logs/other.log"];
      const before = `${lines.join("\n")}\n`;
      for (const f of files) writeFileSync(join(home, f), before);
      const ino = statSync(join(home, files[1]!)).ino;
      const r = run(home);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.split("\n")[0]).toBe("scrubbed 3 log file(s)");
      for (const f of files) {
        const after = readFileSync(join(home, f), "utf8");
        expect(after.length).toBe(before.length);
        for (const secret of ["AbC123xyz", "0123456789abcdef0123", "abc.def-ghi", jwt])
          expect(after).not.toContain(secret);
        const a = after.split("\n");
        expect(a[0]).toBe(lines[0]);
        expect(a[2]).toContain("orb_id=5");
        expect(a[5]).toBe(lines[5]);
        expect(a[3]).toMatch(/^Authorization: Bearer x+ x$/);
      }
      expect(statSync(join(home, files[1]!)).ino).toBe(ino);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does nothing, and fails nothing, when no log exists or no log has a secret", () => {
    const home = mkdtempSync(join(tmpdir(), "cf-orbs-scrub-"));
    try {
      let r = run(home);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.split("\n")[0]).toBe("scrubbed 0 log file(s)");
      mkdirSync(join(home, ".cache/amp/logs"), { recursive: true });
      writeFileSync(join(home, ".cache/amp/logs/cli.log"), "nothing here\n");
      r = run(home);
      expect(r.stdout.split("\n")[0]).toBe("scrubbed 0 log file(s)");
      expect(readFileSync(join(home, ".cache/amp/logs/cli.log"), "utf8")).toBe("nothing here\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("pin_cpus", () => {
  // Fake sysfs as measured in a 2 vCPU orb: cpu0-7 online, affinity 0-1, cpuset 0-7.
  // cpu0 has no online file, as on real hardware. A stub sudo on PATH runs its command without sudo.
  let root = "";
  const cpu = (n: number) => join(root, `sys/cpu${n}`);
  const onlineOf = (n: number) => readFileSync(join(cpu(n), "online"), "utf8").trim();
  function setup(allowed: string, cpuset = "0-7", sudoOk = true) {
    root = mkdtempSync(join(tmpdir(), "cf-orbs-cpus-"));
    for (let n = 0; n < 8; n++) {
      mkdirSync(cpu(n), { recursive: true });
      if (n > 0) writeFileSync(join(cpu(n), "online"), "1\n");
    }
    mkdirSync(join(root, "sys/cpufreq"));
    writeFileSync(join(root, "status"), `Name:\tbash\nCpus_allowed:\tff\nCpus_allowed_list:\t${allowed}\n`);
    writeFileSync(join(root, "cpuset"), `${cpuset}\n`);
    mkdirSync(join(root, "bin"));
    const stub = sudoOk ? '#!/bin/bash\n[ "$1" = -n ] && shift\nexec "$@"\n' : "#!/bin/bash\nexit 1\n";
    writeFileSync(join(root, "bin/sudo"), stub);
    chmodSync(join(root, "bin/sudo"), 0o755);
  }
  function pin(env: Record<string, string> = {}) {
    return spawnSync("bash", ["-c", `set -u\n${PIN_CPUS}\npin_cpus; echo "rc=$?"`], {
      encoding: "utf8",
      env: {
        PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CPU_SYS: join(root, "sys"),
        CPU_STATUS: join(root, "status"),
        CPU_CPUSET: join(root, "cpuset"),
        ...env,
      },
    });
  }
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });
  const clean = () => {
    rmSync(root, { recursive: true, force: true });
    root = "";
  };

  it("offlines CPUs outside the affinity list, then reports already", () => {
    setup("0-1");
    let r = pin();
    expect(r.stdout, r.stderr).toBe("cpus: 2 allowed of 8 online; offlined 6\nrc=0\n");
    expect(r.stderr).toBe("");
    expect(onlineOf(1)).toBe("1");
    for (let n = 2; n < 8; n++) expect(onlineOf(n)).toBe("0");
    r = pin();
    expect(r.stdout).toBe("cpus: already 2\nrc=0\n");
    clean();
  });
  it("expands comma lists and never offlines cpu0", () => {
    setup("3-4,6");
    const r = pin();
    expect(r.stdout, r.stderr).toBe("cpus: 3 allowed of 8 online; offlined 4\nrc=0\n");
    expect([1, 2, 3, 4, 5, 6, 7].map(onlineOf).join("")).toBe("0011010");
    clean();
  });
  it("reports sudo failures and still returns 0", () => {
    setup("0-1", "0-7", false);
    const r = pin();
    expect(r.stdout).toBe("cpus: 2 allowed of 8 online; offlined 0; could not offline 6 (sudo?)\nrc=0\n");
    expect(onlineOf(7)).toBe("1");
    clean();
  });
  it("skips a container cpuset limit", () => {
    setup("0-1", "0-1");
    const r = pin();
    expect(r.stdout).toBe("cpus: 2 allowed of 8 online; limit is a cgroup cpuset, skipped\nrc=0\n");
    expect(onlineOf(7)).toBe("1");
    clean();
  });
  it("skips when the affinity list is missing or bad", () => {
    setup("0-1");
    expect(pin({ CPU_STATUS: join(root, "nope") }).stdout).toBe(
      "cpus: no Cpus_allowed_list; skipped\nrc=0\n",
    );
    writeFileSync(join(root, "status"), "Cpus_allowed_list:\t0-x\n");
    const r = pin();
    expect(r.stdout).toBe("cpus: no Cpus_allowed_list; skipped\nrc=0\n");
    expect(r.stderr).toBe("");
    expect(onlineOf(7)).toBe("1");
    clean();
  });
  it("is called once by BOOTSTRAP_SH, after the hostname fix and before the launch", () => {
    const call = /^pin_cpus 2>\/dev\/null \|\| true$/m;
    expect(BOOTSTRAP_SH).toMatch(call);
    const at = BOOTSTRAP_SH.search(call);
    expect(at).toBeGreaterThan(BOOTSTRAP_SH.indexOf("sudo -n hostname localhost"));
    expect(at).toBeLessThan(BOOTSTRAP_SH.indexOf("setsid -f"));
    for (const sh of [LOGTAIL_SH, QUIESCE_SH, RESUME_SH, STATUS_SH, WAIT_CONNECTED_SH]) {
      expect(sh).toContain("pin_cpus() {");
      expect(sh).not.toMatch(/^\s*pin_cpus(?!\(\))/m);
    }
  });
});

describe("huge_pages and fast_tmpfs", () => {
  // Fake THP file and mounts file. A stub sudo runs its command without sudo and logs each call;
  // a stub mount logs its args and adds the mount to the mounts file.
  let root = "";
  const thp = () => join(root, "thp");
  const mounts = () => join(root, "mounts");
  const log = (f: string) => {
    try {
      return readFileSync(join(root, f), "utf8");
    } catch {
      return "";
    }
  };
  function setup(opts: { sudoOk?: boolean; mountOk?: boolean; thp?: string } = {}) {
    root = mkdtempSync(join(tmpdir(), "cf-orbs-mem-"));
    writeFileSync(thp(), `${opts.thp ?? "always madvise [never]"}\n`);
    writeFileSync(mounts(), "/dev/vdb / btrfs rw,compress=zstd:3 0 0\n");
    mkdirSync(join(root, "bin"));
    const sudo =
      opts.sudoOk === false
        ? "#!/bin/bash\nexit 1\n"
        : `#!/bin/bash\necho "$*" >> "${root}/sudo.log"\n[ "$1" = -n ] && shift\nexec "$@"\n`;
    writeFileSync(join(root, "bin/sudo"), sudo);
    const mount =
      opts.mountOk === false
        ? "#!/bin/bash\nexit 32\n"
        : `#!/bin/bash\necho "$*" >> "${root}/mount.log"\necho "tmpfs \${!#} tmpfs rw 0 0" >> "$FAST_MOUNTS"\n`;
    writeFileSync(join(root, "bin/mount"), mount);
    chmodSync(join(root, "bin/sudo"), 0o755);
    chmodSync(join(root, "bin/mount"), 0o755);
  }
  function mem(env: Record<string, string> = {}) {
    return spawnSync("bash", ["-c", `set -u\n${FAST_MEMORY}\nhuge_pages; fast_tmpfs; echo "rc=$?"`], {
      encoding: "utf8",
      env: {
        PATH: `${join(root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        THP_FILE: thp(),
        FAST_DIR: join(root, "fast"),
        FAST_MOUNTS: mounts(),
        ...env,
      },
    });
  }
  const clean = () => {
    rmSync(root, { recursive: true, force: true });
    root = "";
  };
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("does nothing when both are off or unset", () => {
    setup();
    expect(mem().stdout).toBe("rc=0\n");
    expect(mem({ HUGE_PAGES: "0", FAST_TMPFS_GB: "0" }).stdout).toBe("rc=0\n");
    expect(mem({ FAST_TMPFS_GB: "x1" }).stdout).toBe("rc=0\n");
    expect(log("sudo.log")).toBe("");
    expect(readFileSync(thp(), "utf8")).toBe("always madvise [never]\n");
    clean();
  });
  it("sets THP to always with one sudo; no sudo when it is already always", () => {
    setup();
    const r = mem({ HUGE_PAGES: "1" });
    expect(r.stdout, r.stderr).toBe("thp: always\nrc=0\n");
    expect(r.stderr).toBe("");
    expect(readFileSync(thp(), "utf8")).toBe("always\n");
    expect(log("sudo.log").trim().split("\n")).toHaveLength(1);
    writeFileSync(thp(), "[always] madvise never\n");
    expect(mem({ HUGE_PAGES: "1" }).stdout).toBe("thp: always\nrc=0\n");
    expect(log("sudo.log").trim().split("\n")).toHaveLength(1);
    clean();
  });
  it("reports a THP sudo failure and still returns 0", () => {
    setup({ sudoOk: false });
    const r = mem({ HUGE_PAGES: "1" });
    expect(r.stdout).toBe("thp: unchanged (sudo?)\nrc=0\n");
    expect(r.stderr).toBe("");
    clean();
  });
  it("mounts the tmpfs with huge=always once, then reports already mounted", () => {
    setup();
    const dir = join(root, "fast");
    let r = mem({ FAST_TMPFS_GB: "4" });
    expect(r.stdout, r.stderr).toBe(`tmpfs: ${dir} 4 GiB\nrc=0\n`);
    expect(log("mount.log")).toBe(`-t tmpfs -o size=4g,huge=always,mode=1777 tmpfs ${dir}\n`);
    expect(log("sudo.log").trim().split("\n")).toHaveLength(1);
    r = mem({ FAST_TMPFS_GB: "4" });
    expect(r.stdout).toBe("tmpfs: already mounted\nrc=0\n");
    expect(log("mount.log").trim().split("\n")).toHaveLength(1);
    clean();
  });
  it("reports a failed mount and still returns 0", () => {
    setup({ mountOk: false });
    const r = mem({ HUGE_PAGES: "1", FAST_TMPFS_GB: "2" });
    expect(r.stdout).toBe("thp: always\ntmpfs: mount failed\nrc=0\n");
    expect(r.stderr).toBe("");
    clean();
    setup({ sudoOk: false });
    expect(mem({ FAST_TMPFS_GB: "2" }).stdout).toBe("tmpfs: mount failed\nrc=0\n");
    clean();
  });
  it("runs in BOOTSTRAP_SH after pin_cpus and before the launch, and in RESUME_SH only", () => {
    for (const fn of ["huge_pages", "fast_tmpfs"]) {
      const call = new RegExp(`^${fn} 2>/dev/null \\|\\| true$`, "m");
      const at = BOOTSTRAP_SH.search(call);
      expect(at, fn).toBeGreaterThan(BOOTSTRAP_SH.search(/^pin_cpus 2>\/dev\/null/m));
      expect(at, fn).toBeLessThan(BOOTSTRAP_SH.indexOf("setsid -f"));
      expect(RESUME_SH.search(call), fn).toBeGreaterThan(RESUME_SH.indexOf('> "$STATE.tmp"'));
      for (const sh of [LOGTAIL_SH, QUIESCE_SH, STATUS_SH, WAIT_CONNECTED_SH]) {
        expect(sh).toContain(`${fn}() {`);
        expect(sh).not.toMatch(call);
      }
    }
  });
});

describe("amp_record and amp_check (projectSnapshotRefresh)", () => {
  // A stub amp binary prints "<version> (released …)" and logs each call. Never touches real amp processes.
  let root = "";
  const p = (f: string) => join(root, f);
  const calls = () =>
    existsSync(p("calls")) ? readFileSync(p("calls"), "utf8").trim().split("\n").length : 0;
  let mtime = 1_800_000_000;
  function setAmp(version: string) {
    const stub = `#!/bin/bash\necho x >> "${root}/calls"\necho "${version} (released 2026-10-30T19:16:50.000Z, 1h ago)"\n`;
    writeFileSync(p("amp"), stub);
    chmodSync(p("amp"), 0o755);
    mtime += 100; // a self-update writes a new file: new mtime
    utimesSync(p("amp"), mtime, mtime);
  }
  function setup(version = "0.0.1") {
    root = mkdtempSync(join(tmpdir(), "cf-orbs-amp-"));
    mkdirSync(p("d"));
    writeFileSync(p("cli.log"), "");
    setAmp(version);
  }
  function fns(body: string) {
    const prelude = `set -u\nD="${p("d")}"; CLI="${p("cli.log")}"; AMPB="${p("amp")}"; AMPV="$D/amp-version"\n`;
    const r = spawnSync("bash", ["-c", `${prelude}${AMP_VERSION_FNS}\n${body}`], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    return r.stdout;
  }
  const id = () => fns("amp_id").trim();
  const record = () => readFileSync(p("d/amp-version"), "utf8");
  const clean = () => {
    rmSync(root, { recursive: true, force: true });
    root = "";
  };
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("amp_record writes <amp_id> <version> and prints one line", () => {
    setup("0.0.1793387810-g5421c2");
    expect(fns("amp_record")).toBe("amp: version 0.0.1793387810-g5421c2\n");
    expect(record()).toBe(`${id()} 0.0.1793387810-g5421c2\n`);
    clean();
  });

  it("amp_record with an odd or missing amp prints unknown and writes nothing", () => {
    setup();
    writeFileSync(p("amp"), "#!/bin/bash\necho 'x;y'\n");
    expect(fns("amp_record")).toBe("amp: version unknown\n");
    expect(existsSync(p("d/amp-version"))).toBe(false);
    rmSync(p("amp"));
    expect(fns("amp_record")).toBe("amp: version unknown\n");
    expect(fns("amp_id")).toBe("none\n");
    clean();
  });

  it("same binary as the record and at launch: current, without running amp", () => {
    setup();
    fns("amp_record");
    const n = calls();
    expect(fns(`amp_check 0 "$(amp_id)"`)).toBe("amp: current 0.0.1\n");
    expect(calls()).toBe(n);
    clean();
  });

  it("binary replaced after launch: updated <record version> -> <new version>; the record follows", () => {
    setup();
    fns("amp_record");
    const launch = id();
    setAmp("0.0.2-gnew");
    expect(fns(`amp_check 0 "${launch}"`)).toBe("amp: updated 0.0.1 -> 0.0.2-gnew\n");
    expect(record()).toBe(`${id()} 0.0.2-gnew\n`);
    // the next check on this disk sees the new binary as current
    expect(fns(`amp_check 0 "$(amp_id)"`)).toBe("amp: current 0.0.2-gnew\n");
    clean();
  });

  it("no launch id (state file from older code): compares with the record", () => {
    setup();
    fns("amp_record");
    setAmp("0.0.2");
    expect(fns(`amp_check 0 ""`)).toBe("amp: updated 0.0.1 -> 0.0.2\n");
    clean();
  });

  it("cli.log marker after the launch offset counts as updated; one before it does not", () => {
    setup();
    fns("amp_record");
    const marker = '{"message":"Binary updated successfully"}\n';
    writeFileSync(p("cli.log"), marker);
    const off = readFileSync(p("cli.log")).length;
    expect(fns(`amp_check ${off} "$(amp_id)"`)).toBe("amp: current 0.0.1\n");
    writeFileSync(p("cli.log"), `${marker}{"hasUpdate":true}\n${marker}`);
    expect(fns(`amp_check ${off} "$(amp_id)"`)).toBe("amp: updated unknown -> 0.0.1\n");
    clean();
  });

  it("no record and no launch id: current, from amp --version, and writes the record", () => {
    setup("0.0.9");
    expect(fns(`amp_check 0 ""`)).toBe("amp: current 0.0.9\n");
    expect(record()).toBe(`${id()} 0.0.9\n`);
    clean();
  });

  it("is wired in: launch id in the state file, check only with AMP_CHECK, record only with AMP_VERSION", () => {
    expect(BOOTSTRAP_SH).toMatch(/^AMPID=\$\(amp_id\)$/m);
    expect(BOOTSTRAP_SH.indexOf("AMPID=$(amp_id)")).toBeLessThan(BOOTSTRAP_SH.indexOf("setsid -f"));
    expect(BOOTSTRAP_SH).toContain('echo "$PID $BOOT $SHA $OFF $AMPID" > "$STATE.tmp"');
    expect(RESUME_SH).toContain(`echo "$S_PID $S_BOOT $SHA $S_OFF\${S_AMP:+ $S_AMP}" > "$STATE.tmp"`);
    expect(WAIT_CONNECTED_SH).toContain(`if [ "\${AMP_CHECK:-0}" = 1 ]; then amp_check "$S_OFF" "$S_AMP"`);
    expect(QUIESCE_SH).toContain(`if [ "\${AMP_VERSION:-0}" = 1 ]; then amp_record`);
    for (const sh of [BOOTSTRAP_SH, RESUME_SH, STATUS_SH, LOGTAIL_SH]) {
      expect(sh).not.toMatch(/then amp_check|then amp_record/);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------

const BASE_IMAGE =
  "us-central1-docker.pkg.dev/amp-prod-0/amp-orb/amp-orb@sha256:378c5e2188f00960eca36dc806aa04e1cacd92c2341665bcdf4692326c462d6d";
const BUILT_IMAGE = process.env.CF_ORBS_DOCKER_IMAGE;
const NAME = `cf-orbs-scripts-${randomBytes(4).toString("hex")}`;
const BASE_ENV = { HOME: "/home/user", USER: "user", LANG: "C.UTF-8" };

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function dockerArgs(script: string, env: Record<string, string>, user: string): string[] {
  const e = Object.entries({ ...BASE_ENV, ...env }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  return ["exec", "-u", user, ...e, NAME, "bash", "-c", script];
}

function run(script: string, env: Record<string, string> = {}, user = "1000:1000"): Run {
  const r = spawnSync("docker", dockerArgs(script, env, user), { encoding: "utf8", timeout: 90_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function runAsync(script: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn("docker", dockerArgs(script, env, "1000:1000"));
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

const sh = (cmd: string) => run(cmd).out.trim();
const sha16 = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
const jwtToken = () =>
  `eyJhbGciOiJIUzI1NiJ9.${randomBytes(12).toString("hex")}.${randomBytes(8).toString("hex")}`;
const orbToken = () => `orb_${randomBytes(20).toString("hex")}`;
/** live (non-zombie) pids with this comm; with PID 1 = sleep nothing reaps */
const live = (comm: string) =>
  sh(`ps -eo pid=,stat=,comm= | awk '$2 !~ /^Z/ && $3 == "${comm}" { print $1 }'`)
    .split("\n")
    .filter(Boolean);
/** live amp pids whose command line runs "orb bootstrap" */
const bootstrapPids = () => live("amp").filter((p) => sh(`ps -o args= -p ${p}`).includes(" orb bootstrap"));
const setMode = (m: "silent" | "connect" | "pidfile" | "pidfile-other-boot") => sh(`echo ${m} > ~/stub-mode`);
const bootstrap = (token: string, extra: Record<string, string> = {}) =>
  run(BOOTSTRAP_SH, { ORB_TOKEN: token, ORB_TOKEN_SHA: sha16(token), ALIVE_SECONDS: "2", ...extra });
const readState = () => sh("cat ~/.cf-orbs/bootstrap").split(" ");

const STUB = `#!/bin/bash
log="$HOME/.cache/amp/logs/cli.log"
mkdir -p "\${log%/*}"
if [ "\${1:-}" = "--headless" ]; then while :; do sleep 1; done; fi
echo "{\\"message\\":\\"Starting Amp CLI.\\",\\"dbg\\":\\"token=$ORB_TOKEN key=aop_live_SECRETKEY123 auth=Bearer abc.def-ghi\\"}" >> "$log"
echo "stub bootstrap token=$ORB_TOKEN"
mode=$(cat "$HOME/stub-mode" 2>/dev/null)
if [ "$mode" = connect ]; then
  (sleep 1; echo '{"level":"INFO","message":"Connected to thread actor; announcing sandbox"}' >> "$log") &
fi
# Amp's pid file, as amp writes it right before it connects.
if [ "$mode" = pidfile ] || [ "$mode" = pidfile-other-boot ]; then
  b=$(cat /proc/sys/kernel/random/boot_id)
  [ "$mode" = pidfile ] || b=00000000-0000-0000-0000-000000000000
  pf="$HOME/.cache/amp/pids/headless-bootstrap.pid"
  (sleep 0.3; mkdir -p "\${pf%/*}"; echo "{\\"pid\\":$$,\\"bootId\\":\\"$b\\"}" > "$pf") &
fi
trap 'exit 0' TERM
while :; do sleep 1; done
`;

describe.skipIf(process.env.CF_ORBS_DOCKER !== "1")("scripts in the orb image (docker)", () => {
  let boot = "";
  let pid1 = "";
  const tokA = jwtToken();
  const tokB = orbToken();
  const tokC = jwtToken();
  let pidA = "";
  let pidB = "";

  beforeAll(() => {
    const args = BUILT_IMAGE
      ? ["run", "-d", "--name", NAME, BUILT_IMAGE]
      : ["run", "-d", "--name", NAME, "--entrypoint", "sleep", BASE_IMAGE, "infinity"];
    const r = spawnSync("docker", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
    const w = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        "-u",
        "1000:1000",
        NAME,
        "bash",
        "-c",
        "mkdir -p ~/.local/bin && cat > ~/.local/bin/amp && chmod +x ~/.local/bin/amp",
      ],
      { input: STUB, encoding: "utf8" },
    );
    if (w.status !== 0) throw new Error(`stub install failed: ${w.stderr}`);
    boot = sh("cat /proc/sys/kernel/random/boot_id");
    pid1 = sh("ps -o args= -p 1");
    // An old connected marker from a previous boot must not count for a new bootstrap.
    sh(
      `mkdir -p ~/.cache/amp/logs && echo '{"level":"INFO","message":"Connected to thread actor; announcing sandbox"}' >> ~/.cache/amp/logs/cli.log`,
    );
  }, 120_000);

  afterAll(() => {
    spawnSync("docker", ["rm", "-f", NAME]);
  });

  it("status is none before any bootstrap", () => {
    const r = run(STATUS_SH);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("none");
  });

  it("bootstrap starts a process group and writes the state file", () => {
    setMode("silent");
    sh("mkdir -p ~/.cache/amp/pids && touch ~/.cache/amp/pids/T-x.pid ~/.amp/http-headless-1.pid");
    const r = bootstrap(tokA);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/^cpus: (already \d+|.*limit is a cgroup cpuset, skipped|.*could not offline)/m);
    pidA = /bootstrap running \(pid (\d+)\)/.exec(r.out)?.[1] ?? "";
    expect(pidA).not.toBe("");
    const [pid, b, sha, off, ampId] = readState();
    expect(ampId).toMatch(/^\d+\.\d+$/); // size.mtime of ~/.amp/bin/amp at launch
    expect(pid).toBe(pidA);
    expect(b).toBe(boot);
    expect(sha).toBe(sha16(tokA));
    expect(Number(off)).toBeGreaterThan(0);
    expect(sh(`ps -o pgid= -p ${pidA}`)).toBe(pidA);
    expect(bootstrapPids()).toEqual([pidA]);
    // What the scripts write (state file, log header) has no token. The stub echoes it on purpose.
    expect(sh("cat ~/.cf-orbs/bootstrap; grep '^===' ~/.cf-orbs/bootstrap.log; ls ~/.cf-orbs")).not.toContain(
      tokA,
    );
    expect(sh("ls ~/.cf-orbs | tr '\\n' ' '")).toBe("bootstrap bootstrap.log lock");
  });

  it("an old connected line in cli.log does not count", () => {
    const r = run(WAIT_CONNECTED_SH, { WAIT_SECONDS: "2" });
    expect(r.code).toBe(1);
    expect(r.out.split("\n")[0]).toBe("not connected; last log lines:");
    expect(r.out).toMatch(/reason: timeout after 2s/);
    expect(r.out).not.toContain(tokA.split(".")[1]);
    expect(r.out).not.toContain("SECRETKEY123");
  });

  it("same token again starts no new process", () => {
    const r = bootstrap(tokA);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(`bootstrap already running (pid ${pidA})`);
    expect(bootstrapPids()).toEqual([pidA]);
  });

  it("a new token replaces the process group; concurrent calls start one process", async () => {
    setMode("connect");
    const env = { ORB_TOKEN: tokB, ORB_TOKEN_SHA: sha16(tokB), ALIVE_SECONDS: "2" };
    const [r1, r2] = await Promise.all([runAsync(BOOTSTRAP_SH, env), runAsync(BOOTSTRAP_SH, env)]);
    expect(r1.code, r1.out).toBe(0);
    expect(r2.code, r2.out).toBe(0);
    const outs = [r1.out, r2.out].join("\n");
    expect(outs).toMatch(/replacing bootstrap pid \d+ \(new token\)/);
    expect(outs).toMatch(/bootstrap already running/);
    pidB = readState()[0] ?? "";
    expect(pidB).not.toBe(pidA);
    expect(readState()[2]).toBe(sha16(tokB));
    expect(bootstrapPids()).toEqual([pidB]);
    // Same boot: amp pid files belong to live processes and stay.
    expect(sh("ls ~/.cache/amp/pids/T-x.pid ~/.amp/http-headless-1.pid | wc -l")).toBe("2");
  }, 60_000);

  it("connected check passes on a marker written after launch", () => {
    const r = run(WAIT_CONNECTED_SH, { WAIT_SECONDS: "10" });
    expect(r.code, r.out).toBe(0);
    expect(r.out.trim()).toMatch(/^connected after \d+s$/);
  });

  it("AMP_CHECK adds one amp line from the real binary; a changed launch id reads as an update", () => {
    let r = run(WAIT_CONNECTED_SH, { WAIT_SECONDS: "10", AMP_CHECK: "1" });
    expect(r.code, r.out + r.err).toBe(0);
    const [conn, amp] = r.out.trim().split("\n");
    expect(conn).toMatch(/^connected after \d+s$/);
    expect(amp).toMatch(/^amp: current 0\.0\.\d+-g[0-9a-f]+$/);
    const ver = amp?.split(" ")[2];
    expect(sh("cat ~/.cf-orbs/amp-version")).toMatch(new RegExp(`^\\d+\\.\\d+ ${ver}$`));
    // Same record, same binary: no amp --version run, same answer.
    expect(run(WAIT_CONNECTED_SH, { WAIT_SECONDS: "10", AMP_CHECK: "1" }).out).toContain(
      `amp: current ${ver}`,
    );
    // A launch id that differs from the binary now = amp replaced itself after launch.
    const state = sh("cat ~/.cf-orbs/bootstrap");
    const fields = state.split(" ");
    sh(`echo "${fields.slice(0, 4).join(" ")} 1.1" > ~/.cf-orbs/bootstrap`);
    r = run(WAIT_CONNECTED_SH, { WAIT_SECONDS: "10", AMP_CHECK: "1" });
    expect(r.out.trim().split("\n")[1]).toBe(`amp: updated unknown -> ${ver}`);
    sh(`echo "${state}" > ~/.cf-orbs/bootstrap`);
  });

  it("status reports alive with sha and boot", () => {
    const r = run(STATUS_SH);
    const out = r.out.trim().split("\n");
    expect(out.slice(0, 2)).toEqual([`alive ${pidB}`, `sha ${sha16(tokB)} boot current`]);
    expect(out[2]).toMatch(/^act [1-9]\d*$/);
  });

  it("resume reuses a connected bootstrap and takes the new sha; a retry then starts nothing", () => {
    const tokD = jwtToken();
    const r = run(RESUME_SH, { ORB_TOKEN_SHA: sha16(tokD) });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out.trim()).toBe(`warm bootstrap pid ${pidB} still connected`);
    expect(readState().slice(0, 3)).toEqual([pidB, boot, sha16(tokD)]);
    expect(bootstrapPids()).toEqual([pidB]);
    const b = bootstrap(tokD);
    expect(b.out.trim()).toBe(`bootstrap already running (pid ${pidB})`);
    // Back to tokB's sha for the tests below.
    expect(run(RESUME_SH, { ORB_TOKEN_SHA: sha16(tokB) }).code).toBe(0);
  });

  it("resume refuses a bad sha and a dead bootstrap", () => {
    expect(run(RESUME_SH, { ORB_TOKEN_SHA: "xyz" }).out).toMatch(/^reason: ORB_TOKEN_SHA is not hex$/m);
    const saved = sh("cat ~/.cf-orbs/bootstrap");
    sh(`echo "999999 ${boot} ${sha16(tokB)} 0" > ~/.cf-orbs/bootstrap`);
    const r = run(RESUME_SH, { ORB_TOKEN_SHA: sha16(tokB) });
    expect(r.code).toBe(1);
    expect(r.out.trim()).toBe("reason: bootstrap pid 999999 exited");
    sh(`echo "${saved}" > ~/.cf-orbs/bootstrap`);
  });

  it("log tail has no secrets", () => {
    const r = run(LOGTAIL_SH, { LINES: "100" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("== bootstrap.log");
    expect(r.out).toContain("== cli.log");
    expect(r.out).toContain("aop_live_<redacted>");
    for (const secret of [
      tokA,
      tokB,
      tokA.split(".")[1] ?? "x",
      tokB.slice(4),
      "SECRETKEY123",
      "abc.def-ghi",
    ]) {
      expect(r.out).not.toContain(secret);
    }
  });

  it("quiesce stops bootstrap, headless amp and the supervisor; leaves PID 1 and other processes", () => {
    sh(
      "printf '#!/bin/bash\\nwhile :; do sleep 1; done\\n' > ~/.amp/http-headless-supervisor.sh && " +
        "setsid -f bash ~/.amp/http-headless-supervisor.sh </dev/null >/dev/null 2>&1; " +
        "setsid -f amp --headless </dev/null >/dev/null 2>&1; setsid -f sleep 1000 </dev/null >/dev/null 2>&1",
    );
    expect(live("amp").length).toBeGreaterThanOrEqual(2);
    sh("rm -f ~/.cf-orbs/amp-version");
    const r = run(QUIESCE_SH, { AMP_VERSION: "1" });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out.split("\n")[0]).toMatch(/^amp: version 0\.0\.\d+-g[0-9a-f]+$/);
    expect(sh("cat ~/.cf-orbs/amp-version")).toMatch(/^\d+\.\d+ 0\.0\.\d+-g[0-9a-f]+$/);
    expect(r.out).toContain(`stopping bootstrap pid ${pidB}`);
    expect(r.out.trim().split("\n").at(-1)).toBe("quiesced; remaining amp processes: 0");
    expect(live("amp")).toEqual([]);
    expect(sh("ps -eo stat=,args= | grep -v '^Z' | grep -c '[h]ttp-headless-supervisor'; true")).toBe("0");
    expect(sh("pgrep -x sleep -a | grep -c 'sleep 1000'")).toBe("1");
    expect(sh("ps -o args= -p 1")).toBe(pid1);
    expect(run(STATUS_SH).out.split("\n")[0]).toBe("dead");
  }, 60_000);

  it("state from another boot: quiesce signals nothing, bootstrap removes stale amp pid files", () => {
    const victim = sh("pgrep -f 'sleep 1000'");
    sh(`echo "${victim} 00000000-0000-0000-0000-000000000000 ${sha16(tokB)} 0" > ~/.cf-orbs/bootstrap`);
    const q = run(QUIESCE_SH);
    expect(q.out).toContain(`state file is from another boot; not signalling pid ${victim}`);
    expect(sh(`kill -0 ${victim} && echo alive`)).toBe("alive");
    expect(run(STATUS_SH).out.trim().split("\n").slice(0, 2)).toEqual([
      "dead",
      `sha ${sha16(tokB)} boot other`,
    ]);
    const r = bootstrap(tokC);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("removing stale amp pid files");
    expect(sh("ls ~/.cache/amp/pids/*.pid ~/.amp/http-headless*.pid 2>/dev/null | wc -l")).toBe("0");
    expect(sh(`kill -0 ${victim} && echo alive`)).toBe("alive");
    expect(readState()[1]).toBe(boot);
  }, 60_000);

  it("quiesce ignores bad pids in the state file", () => {
    for (const bad of ["-1", "abc", "0", "1"]) {
      sh(`echo "${bad} ${boot} ${sha16(tokC)} 0" > ~/.cf-orbs/bootstrap`);
      const r = run(QUIESCE_SH);
      expect(r.code, `${bad}: ${r.out}${r.err}`).toBe(0);
      expect(r.out).not.toContain("stopping bootstrap pid");
      expect(sh("ps -o args= -p 1")).toBe(pid1);
    }
    expect(live("amp")).toEqual([]); // the amp sweep still ran
    expect(sh("pgrep -c -f 'sleep 1000'")).toBe("1");
  }, 90_000);

  it("sets the hostname to localhost when the hostname is not in /etc/hosts", () => {
    run(
      `h=$(hostname); grep -v "$h" /etc/hosts > /tmp/hosts.new; cat /tmp/hosts.new > /etc/hosts`,
      {},
      "0:0",
    );
    expect(run("getent hosts $(hostname)").code).not.toBe(0);
    const r = bootstrap(jwtToken());
    expect(r.code, r.out).toBe(0);
    // Docker without CAP_SYS_ADMIN cannot rename the host; the script must not fail because of it.
    // When the rename works (the microVM), the name resolves through the existing /etc/hosts line.
    const h = sh("hostname");
    if (h === "localhost") expect(run("getent hosts $(hostname)").code).toBe(0);
    run(QUIESCE_SH);
  }, 60_000);

  it("huge pages and tmpfs each print one line and never fail the bootstrap", () => {
    setMode("silent");
    const r = bootstrap(jwtToken(), { HUGE_PAGES: "1", FAST_TMPFS_GB: "1" });
    expect(r.code, r.out).toBe(0);
    // Docker has a read-only /sys and no CAP_SYS_ADMIN; the microVM allows both.
    expect(r.out).toMatch(/^thp: (always|unchanged \(sudo\?\))$/m);
    expect(r.out).toMatch(/^tmpfs: (\/mnt\/fast 1 GiB|mount failed|already mounted)$/m);
    expect(r.out).toMatch(/^bootstrap running \(pid \d+\)$/m);
    run(QUIESCE_SH);
  }, 60_000);

  it("bootstrap reports connected when Amp's pid file names it on this boot; another boot does not count", () => {
    run(QUIESCE_SH);
    setMode("pidfile");
    let r = bootstrap(jwtToken());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(
      /^timing: script to launch \d+ ms \(prelude \d+, state\+host \d+, cpus \d+, memory \d+, start \d+\); launch to connected \d+ ms$/m,
    );
    const ms = Number(BOOT_CONNECTED_RE.exec(r.out)?.[1]);
    expect(ms).toBeGreaterThanOrEqual(300);
    expect(ms).toBeLessThan(1500);
    expect(run(WAIT_CONNECTED_SH, { WAIT_SECONDS: "2" }).code).toBe(0);
    run(QUIESCE_SH);
    setMode("pidfile-other-boot");
    r = bootstrap(jwtToken());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/; launch to still waiting \d+ ms$/m);
    expect(BOOT_CONNECTED_RE.test(r.out)).toBe(false);
    run(QUIESCE_SH);
    sh("rm -f ~/.cache/amp/pids/headless-bootstrap.pid");
    setMode("silent");
  }, 60_000);

  it("real amp with a fake token: bootstrap fails fast with a redacted reason", () => {
    sh("rm -f ~/.local/bin/amp");
    run(QUIESCE_SH);
    const tok = jwtToken();
    const r = bootstrap(tok, { ALIVE_SECONDS: "20" });
    expect(r.code, r.out).toBe(1);
    // Line 1 is the pin_cpus line; the failure follows it.
    expect(r.out.split("\n")[0]).toMatch(/^cpus: /);
    expect(r.out.split("\n")[1]).toMatch(/^Failed: amp orb bootstrap exited within \d+s — fix: /);
    expect(r.out).toMatch(/rejected/);
    expect(r.out).not.toContain(tok.split(".")[1]);
    expect(run(STATUS_SH).out.split("\n")[0]).toBe("dead");
    const w = run(WAIT_CONNECTED_SH, { WAIT_SECONDS: "2" });
    expect(w.code).toBe(1);
    expect(w.out).toMatch(/reason: bootstrap pid \d+ exited/);
  }, 60_000);
});
