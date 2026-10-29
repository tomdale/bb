# tomdale/bb fork

This repository is a personal fork of [get-bb/bb](https://github.com/get-bb/bb).
The `personal` branch holds the fork: the current `upstream/main`, then the
commit that adds this file, then one commit per change listed under
[Changes](#changes), in that order.
Every sync rebases that list onto the latest `upstream/main`, so
`git log upstream/main..personal` always shows the whole fork.

`personal` is the default branch on GitHub. `main` is an exact copy of
`upstream/main` and never carries fork commits; branches meant for upstream
pull requests start from it.

Build and deploy bb Personal from a checkout of `personal`.

## Changes

Each commit carries a `Fork-Patch: <id>` trailer that matches an entry below.
"Upstream files" lists the files the change edits but does not own; those are
where sync conflicts happen. Changes that only add files rarely conflict.

### desktop-profiles

Adds the Personal and Lab macOS build profiles, selected at build time with
`BB_DESKTOP_BUILD_PROFILE`. Personal (`com.tomdale.bb.personal`) runs against
the normal `~/.bb` runtime. Lab (`com.tomdale.bb.lab`) runs an isolated runtime
in `~/.bb-lab` on ports 38890 and 38891. Neither profile checks for or installs
upstream desktop updates. The user-facing description is in
`docs/configuration.md` under "Private Desktop Builds".

- Upstream status: fork-only.
- Owned files: `apps/desktop/scripts/desktop-build-profiles.*`,
  `desktop-profile-paths.*`, `lab-runtime-config.*`,
  `smoke-owned-lab-runtime.mjs`, `apps/desktop/src/desktop-build-profile.ts`,
  the `icon-personal.*` and `icon-lab.*` assets, and their tests.
- Upstream files: `apps/desktop/src/main.ts`,
  `apps/desktop/scripts/{build,run-electron-builder,run-packaged-app,smoke-packaged-app}.mjs`,
  `apps/desktop/src/desktop-update-provider.ts`, `apps/desktop/package.json`,
  `apps/desktop/README.md`, `turbo.json`, `docs/configuration.md`,
  `packages/templates/src/templates/bb-guide-overview.md`, and two desktop
  tests.
- Must not delete upstream code. In particular, upstream's Windows packaging
  and `desktop-release-channel.*` stay unmodified.
- Check: `pnpm exec turbo run typecheck test --filter=@bb/desktop`. On macOS,
  also run `pnpm exec turbo run package:personal --filter=@bb/desktop` and then
  `pnpm exec turbo run smoke:packaged:personal --filter=@bb/desktop`.

### personal-deploy

Adds `pnpm --filter @bb/desktop run deploy:personal`. It rebuilds and smokes
Personal, waits until no thread is busy, then replaces and relaunches
`/Applications/bb Personal.app`. If the new build does not come up, it rolls
back to the previous bundle. Depends on desktop-profiles.

- Upstream status: fork-only.
- Owned files: `apps/desktop/scripts/deploy-personal-app.mjs`,
  `apps/desktop/scripts/personal-app-deploy.*`, and their test.
- Upstream files: `apps/desktop/package.json`, `apps/desktop/README.md`,
  `docs/configuration.md`.
- Check: `pnpm exec turbo run test --filter=@bb/desktop`, then
  `pnpm --filter @bb/desktop run deploy:personal --dry-run`.

### local-test-fixes

Makes the workspace test suite pass on macOS when Git commit signing is enabled
globally. It disables signing in the temporary repositories tests create, waits
for complete SSH fixture log records, and anchors profiler CPU captures to the
stall collector's clock.

- Upstream status: candidate. Nothing here depends on the fork; send it upstream
  and drop it once it lands.
- Upstream files: `packages/process-utils/src/profile-worker.ts` and test
  files in `apps/host-daemon`, `apps/server`, and
  `plugins/environment-git-worktree`.
- Check: `pnpm exec turbo run test --filter=@bb/process-utils --filter=@bb/host-daemon --filter=@bb/server --filter=bb-plugin-environment-git-worktree`.

### fork-sync

Adds `scripts/fork/sync`, which performs the sync described below. A daily bb
automation runs it from the `personal` checkout.

- Upstream status: fork-only.
- Owned files: `scripts/fork/sync`.
- Check: `scripts/fork/sync --onto <ref> --no-verify` against a test commit on
  top of `upstream/main`.

### fork-test-safety

Fork sync refuses to verify a tree containing the FRP client or Connect Next
packages unless the rebased fork includes the `real-frp-tests` safety patch.
The preceding patch-list and line-drift checks must pass first. Verification
always sets `BB_RUN_REAL_FRP_TESTS=0` and stops on the first failed test run.

- Upstream status: fork-only.
- Owned files: `scripts/fork/test-policy.mjs` and its test.
- Upstream files: `scripts/fork/sync`.
- Check: `node --test scripts/fork/test-policy.test.mjs` and
  `bash -n scripts/fork/sync`.

## Syncing with upstream

`scripts/fork/sync` runs the whole sync. It prints nothing when `personal`
already contains `upstream/main`. Otherwise it:

1. Rebases `origin/personal` onto `upstream/main` in a scratch worktree under
   `${XDG_STATE_HOME:-~/.local/state}/bb-fork-sync/`, replaying recorded
   conflict resolutions with rerere. The rebased commits are not signed.
2. Fails if the list of `Fork-Patch` changes changed, or if any change now adds
   or removes different lines than before.
3. Runs `pnpm install --frozen-lockfile`, the workspace typecheck, and the tests
   of every package the fork touches, with real FRP tests disabled.
4. Tags the previous `personal` as `personal/<date>`, force-pushes `personal`
   and the tag, and sets `origin/main` to `upstream/main`.
5. Moves the local `personal` and `main` branches. A checkout of `personal` is
   reset to the new commits only when it is clean and was at the previous tip.

When it fails, nothing is pushed, and it prints the reason and a log path. To
sync by hand:

```sh
git fetch upstream
git tag personal/$(date +%Y-%m-%d) personal
git rebase upstream/main personal
git range-diff personal/$(date +%Y-%m-%d)...personal
pnpm install --frozen-lockfile
pnpm exec turbo run typecheck test
git push --force-with-lease origin personal personal/$(date +%Y-%m-%d)
git push origin upstream/main:main
```

The tag records the previous state, so a bad sync can be reset to it. Read the
`range-diff` output before pushing: a change that grew or lost lines it did not
have before means a conflict was resolved wrongly. Conflicts resolved by hand
are recorded by rerere, so the next automated sync replays them.

When resolving a conflict, combine both sides. Never resolve by taking a whole
file from one side, because that silently reverts whichever side was dropped.
If upstream has shipped equivalent behavior, drop the fork commit and update
this file in the same sync.

## Changing the fork

- Start new fork work from `personal`, and work meant for upstream from
  `main`.
- Keep one commit per change. Amend a change with `git commit --fixup=<commit>`
  and `git rebase -i --autosquash upstream/main`, and add the change's
  `Fork-Patch` trailer to any new commit.
- To undo a change, drop or edit its commit. Do not add revert commits.
- Put new behavior in new files, and keep edits to upstream files to the
  smallest call or import needed to reach it.
- Add, update, or remove the matching entry in this file in the same commit.
