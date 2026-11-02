## What and why

<!-- What this changes and why. Link the issue: Fixes #123 -->

## How I tested it

<!-- Commands you ran. For a change to the orb scripts or image: the Docker tests. For a change that only a real account can show: what you ran with cf-orbs init on a test account, and the result. -->

## Checklist

- [ ] `npm run typecheck`, `npm run lint` and `npx vitest run` pass
- [ ] `npm run shellcheck` passes (if I changed a shell script)
- [ ] `CF_ORBS_DOCKER=1 npx vitest run worker/test/scripts.docker.test.ts` passes (if I changed `worker/src/orb/scripts.ts` or `image/`)
- [ ] New behaviour has a test; a bug fix has a test that fails without the fix
- [ ] User-facing errors are one line: `Failed: <cause> — fix: <action>`
- [ ] No token can reach a log, argv, the orb disk or a response
- [ ] Docs and `CHANGELOG.md` (under Unreleased) are updated
- [ ] The code is mine or comes from a source whose license allows it (see CONTRIBUTING.md)
