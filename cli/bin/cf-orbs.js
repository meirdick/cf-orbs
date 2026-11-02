#!/usr/bin/env node
import { main } from "../dist/index.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(
      `Failed: ${e?.message ?? e} — fix: rerun with CF_ORBS_DEBUG=1 and report the output\n`,
    );
    process.exitCode = 1;
  },
);
