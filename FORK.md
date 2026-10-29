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

### real-frp-tests

Real FRP tests are disabled by default across the client, host daemon, server,
Connect Next gateway, and Connect Next plugin. They require
`BB_RUN_REAL_FRP_TESTS=1` in an approved test environment. Routine tests retain
unit coverage and report the binary-backed cases as skipped. The fixture
helpers reject download, installation, and launch before side effects when
opt-in is absent. Cached archives and binaries do not bypass the guard.

Turbo declares the variable for every affected test task and includes it in
the cache key.

- Upstream status: candidate.
- Upstream files: `packages/frp-client/src/testing/frp-fixture.ts`, its binary,
  cache, and supervisor tests; the host-daemon Connect Next test; the server
  tunnel-ingress test; the Connect Next plugin FRP test; the Connect Next
  gateway binary fixture and harness; `turbo.json`.
- Owned files: `packages/frp-client/test/fixture-safety.test.ts` and
  `apps/connect-next/test/frp-binaries.test.ts`.
- Check: `pnpm exec turbo run typecheck test --filter=@bb/frp-client --filter=@bb/connect-next --filter=bb-plugin-bb--connect-next --filter=@bb/host-daemon --filter=@bb/server`.
  Leave `BB_RUN_REAL_FRP_TESTS` unset for routine verification. Guard regression
  tests use mocked effects and do not unpack or run FRP.

### fork-test-safety

Fork sync refuses to verify a tree containing the FRP client or Connect Next
packages unless the rebased fork includes the `real-frp-tests` safety patch.
The preceding patch-list and line-drift checks must pass first. Verification
always sets `BB_RUN_REAL_FRP_TESTS=0`.

- Upstream status: fork-only.
- Owned files: `scripts/fork/test-policy.mjs` and its test.
- Upstream files: `scripts/fork/sync`.
- Check: `node --test scripts/fork/test-policy.test.mjs` and
  `bash -n scripts/fork/sync`.

### container-literal

A `:::name` container directive that no plugin claims renders as literal
text: its opener and closer lines stay visible and its contents render as
ordinary Markdown, in lists and nested containers too. Upstream drops the
markers and renders the contents in a bare `<div>`.

- Upstream status: candidate.
- Upstream files: `apps/app/src/components/ui/markdown-message-directives.tsx`
  and its two test files.
- Check: `pnpm exec turbo run typecheck --filter=@bb/app`, then
  `pnpm exec turbo run test --filter=@bb/app -- src/components/ui/markdown-message-directives`.

### container-streaming

While a reply streams, the split between its settled part and its tail never
falls inside an open `:::name` container, and the incremental renderer caches
a top-level container's opener, closer, and inner pieces separately, so each
update re-parses only the last inner piece. Depends on container-literal.

- Upstream status: candidate.
- Owned files: `apps/app/src/components/ui/markdown-container-fences.ts`.
- Upstream files:
  `apps/app/src/components/thread/timeline/streaming-markdown-split.ts`,
  `apps/app/src/components/ui/markdown-incremental-pieces.ts`, and their tests.
- Check: `pnpm exec turbo run typecheck --filter=@bb/app`, then
  `pnpm exec turbo run test --filter=@bb/app -- src/components/ui/markdown src/components/thread/timeline/streaming-markdown-split`.

### message-blocks

Adds `app.slots.experimental_messageBlock`: a plugin claims a `:::name{v="1"}`
… `:::` container in assistant and nested-agent messages, gets the raw text
and bb's Markdown tree through a pure `parse`, and draws a component in its
place, with the literal block as fallback (`Original`) and a short note when a
registered plugin cannot draw it. The host keeps one component instance per
block through streaming, sharing the portal bookkeeping of
`experimental_codeFenceRenderer` (moved into `markdown-slot-portals.tsx`).
Includes the SDK types and harness capture, the `docs/api_to_audit.md` entry,
the Plugin Guide card, the plugin-authoring skill references, and the bundled
reference plugin `plugins/message-block-demo` (off by default). Depends on
container-literal and container-streaming. Workstreams' `reply` block is the
first consumer.

- Upstream status: fork-only unless upstream wants the slot.
- Owned files: `apps/app/src/components/ui/markdown-message-blocks.*`,
  `markdown-message-block-parts.ts`, `markdown-slot-portals.tsx`, and
  `plugins/message-block-demo/`.
- Upstream files: in `apps/app/src`, `markdown-preview.tsx`,
  `markdown-incremental-pieces.ts`, `markdown-message-directives.tsx`,
  `markdown-code-fence-renderers.tsx`, `markdown-html.tsx`,
  `ConversationMessageContent.tsx`, `ThreadTimelineRows.tsx`,
  `PluginCapabilities.tsx`, `lib/plugin-slots.ts`,
  `lib/plugin-slot-resolvers.ts`, and tests and fixtures beside them; in
  `packages/plugin-sdk`, `package.json` (`@types/mdast`),
  `scripts/build-bundled-dts.mjs`, `src/app-contract.ts`,
  `src/internal/composer-customization-validation.ts`,
  `src/internal/plugin-app-registration-collector.ts`, `src/testing/app.tsx`,
  and the harness test; `apps/server/src/services/plugins/builtin-registry.ts`
  and `plugin-authoring-docs.test.ts`; `docs/api_to_audit.md`; the
  plugin-authoring references in `plugins/bb-guide`; the Plugin Guide sources
  in `plugins/plugin-api-docs`; `plugins/bb-official.json`;
  `packages/bundled-plugins/package.json`; `turbo.json`; `pnpm-lock.yaml`.
- Check: `pnpm exec turbo run typecheck test --filter=@get-bb/plugin-sdk --filter=bb-plugin-bb--message-block-demo --filter=bb-plugin-plugin-api-docs --filter=bb-plugin-bb-guide`,
  `pnpm exec turbo run typecheck --filter=@bb/app`, then
  `pnpm exec turbo run test --filter=@bb/app -- src/components/ui src/components/thread/timeline src/lib/plugin`
  and `GIT_CONFIG_GLOBAL=/dev/null pnpm exec turbo run test --filter=@bb/server -- test/services/plugins/plugin-authoring-docs test/services/plugins/builtin test/skills`.

### slot-status-text-complete

Assistant timeline rows carry `textComplete`, true once the provider completes
the message item, its turn ends, or the thread stops (the event projection's
message status). Code fence and message block status follow it instead of
"this message is the last row of a running turn": `streaming` until the closer
arrives or the text is complete, `unclosed` only when the text is complete
without a closer. Each placeholder reports the flag together with its text, so
a reply that ends and is followed by a tool row in one update goes from
`streaming` to `closed` with no `unclosed` render in between. Depends on
message-blocks for the block half and the shared portal host.

- Upstream status: candidate for the fence half (it fixes upstream's
  `experimental_codeFenceRenderer`); the block half is fork-only with
  message-blocks.
- Owned files: `apps/app/src/components/ui/message-slot-status.test.tsx`.
- Upstream files: `packages/server-contract/src/thread-timeline.ts`,
  `packages/thread-view/src/build-thread-timeline.ts`,
  `packages/client-core/src/timeline/timelineRowSignatures.ts`,
  `apps/app/src/components/ui/markdown-code-fence-renderers.tsx`,
  `ConversationMessageContent.tsx`, `ThreadTimelineRows.tsx`,
  `docs/api_to_audit.md`, `frontend-renderer-slots.md`, and timeline row
  fixtures, stories, and tests in `apps/app`, `apps/server`,
  `apps/demo-server`, `packages/thread-view`, and `tests/integration`.
- Check: `pnpm exec turbo run typecheck --filter=...@bb/server-contract`,
  `pnpm exec turbo run test --filter=@bb/thread-view --filter=@bb/client-core --filter=@bb/server-contract --filter=@bb/demo-server`,
  `pnpm exec turbo run test --filter=@bb/app -- src/components/ui src/components/thread`,
  and `GIT_CONFIG_GLOBAL=/dev/null pnpm exec turbo run test --filter=@bb/server -- test/services/threads`.

### preview-container-markers

Notification previews (push, web, and desktop share one body) skip container
directive lines (`:::name{...}`, `:::`, and longer markers such as
`::::name`) the way leaf directives are skipped, and strip task-list markers.
A level-1 heading on the first line inside a container block is the block's
headline and becomes the preview, so a reply ending in a `:::reply` block
previews its headline instead of the opener line. A message with no prose
paragraph previews its first heading instead of the generic fallback; prose
still wins over a leading heading in ordinary Markdown.

- Upstream status: candidate.
- Owned files: `plugins/push-notifications/notification-text.test.ts`.
- Upstream files: `plugins/push-notifications/notification-text.ts`.
- Check: `pnpm exec turbo run typecheck lint test --filter=bb-plugin-push-notifications`.

### acp-steer-message-break

When a steer ends a running ACP prompt, the shared ACP bridge closes that
prompt's open assistant and reasoning items before it sends the steer, so the
steered reply starts a new message. Upstream closes only open tool calls, so
the last text of the steered-away prompt and the next reply run together in
one message (`…must satisfy.:::reply{…}`), and a reply block that should start
on its own line does not render. The bridge marks the prompt boundary even
when the agent finished before it saw the cancel request. Plugins that bundle
the published SDK's bridge, such as fx, get this only once they build against
an SDK that includes it.

- Upstream status: candidate.
- Upstream files: `packages/provider-bridge-acp/src/bridge/bridge.ts`,
  `delta-translation.ts`, and their tests.
- Check: `pnpm exec turbo run typecheck lint test --filter=@bb/provider-bridge-acp`.

### plugin-sdk-version

Sets `@get-bb/plugin-sdk` one patch above upstream's version, the next version
not on npm, so plugins that use the fork's SDK additions (message-blocks) can
require a host that has them; the reference plugin requires it. Kept as its
own change because every upstream SDK bump changes the same two lines.
When a sync reports line drift here, rebase with upstream's version, run
`node scripts/bump-plugin-sdk.mjs --patch` (check that the result is not on
npm), and update `engines.bbPluginSdk` in this change and in Workstreams
(toolbelt `bb-plugin-workstreams`).

- Upstream status: fork-only.
- Upstream files: `packages/domain/src/plugin-sdk-version.ts`,
  `packages/plugin-sdk/package.json`; also
  `plugins/message-block-demo/package.json`, owned by message-blocks.
- Check: `node .github/workflows/check-plugin-sdk-version.mjs`,
  `node packages/plugin-sdk/scripts/check-npm-version-guard.mjs`, and
  `pnpm exec turbo run test --filter=@bb/domain --filter=@get-bb/plugin-sdk`.

### message-block-markdown

SDK `Markdown` inside a message block renders registered inline and leaf
message directives with the original message identity and workspace-file
opener. Embedded visualizations can resolve thread-storage files from the
message's thread. Each Markdown fragment has its own code-fence host, so
registered fences in different sections cannot replace one another when their
source offsets coincide. Fence status follows the original message's text
completion. Standalone and document Markdown stay literal; nested message
blocks and a directive renderer's own Markdown do not inherit directive
rendering, preventing recursive interpretation of source previews.

- Upstream status: fork-only; depends on message-blocks.
- Owned files: `apps/app/src/components/ui/message-block-markdown.tsx`.
- Upstream files: `apps/app/src/components/plugin/PluginMarkdown.tsx`,
  `ConversationMessageContent.tsx`; also `markdown-message-blocks.tsx` and its
  tests, owned by message-blocks.
- Check: `pnpm exec turbo run typecheck build --filter=@bb/app` and
  `pnpm exec turbo run test --filter=@bb/app -- src/components/ui src/components/thread/timeline src/components/plugin`.

## Syncing with upstream

`scripts/fork/sync` runs the whole sync. It prints nothing when `personal`
already contains `upstream/main`. Otherwise it:

1. Rebases `origin/personal` onto `upstream/main` in a scratch worktree under
   `${XDG_STATE_HOME:-~/.local/state}/bb-fork-sync/`, replaying recorded
   conflict resolutions with rerere. The rebased commits are not signed.
2. Fails if the list of `Fork-Patch` changes changed, or if any change now adds
   or removes different lines than before.
3. Runs `pnpm install --frozen-lockfile`, the workspace typecheck, and the tests
   of every package the fork touches, one package at a time, with real FRP
   tests disabled, retrying failed packages once.
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
