// Test helper: real git with a fixed identity and no global config, so commits work on any machine.
import { type Runner, runProcess } from "../src/wrangler";

export const gitRun: Runner = (cmd, args, o = {}) =>
  runProcess(cmd, args, {
    ...o,
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...o.env,
    },
  });
