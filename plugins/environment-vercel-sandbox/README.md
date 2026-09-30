# Vercel Sandbox

Run BB threads on disposable Vercel Sandbox machines. Install **Vercel Sandbox [Experimental]** from BB Official, configure its credentials, and select **Vercel Sandbox** when creating a thread. The plugin registers machine provider `vercel-sandbox` and an environment composition with `project-checkout`.

## Configure and launch

In the plugin settings, set a secret Vercel `token`, a canonical `teamId` (`team_…`), and `projectId` (`prj_…`). Use a long-lived Vercel access token that authorizes Sandbox operations in that team and project. Short-lived OIDC/JWT tokens are rejected because the SDK can refresh them from local context and change account scope. Settings `defaultVcpus` and `defaultTimeoutMinutes` default to 2 and 30. Editing defaults affects future allocations; recovery keeps the recorded allocation settings.

The server must be reachable from the sandbox. Configure core machine server access in Settings → Machines. BB owns daemon installation, private enrollment, credentials, work draining, checkout cloning, and `.bb-env-setup.sh`. Agent authentication uses BB's ordinary machine environment and provider configuration. A sandbox image's installed CLIs do not supply agent account credentials.

```sh
bb vercel-sandbox account inspect --json
bb vercel-sandbox launch options --json
bb machine create --provider vercel-sandbox --inputs '{"vcpus":2,"timeoutMinutes":30}' --json
bb thread spawn --project PROJECT --environment-provider vercel-sandbox --machine-inputs '{"vcpus":2,"timeoutMinutes":30}' --prompt 'Work on the project'
bb vercel-sandbox machine inspect HOST --json
bb machine show HOST --json
bb machine remove HOST --yes
```

Use `bb machine list --all` to include disposable machines. `account inspect` proves authenticated sandbox listing; allocation permissions, spend capacity, image availability, and plan entitlements are checked by Vercel at launch. All diagnostics are read-only and allocate no compute. Settings are also available through the core plugin settings SDK and CLI; keep tokens in the secret setting rather than machine inputs.

Launch inputs accept `null` or a strict object with optional integer `vcpus` (1 or an even count up to 32) and `timeoutMinutes` (5–1440). Unknown fields are rejected. Memory is 2048 MiB per vCPU. Vercel plan limits apply: SDK 3.5.1 documents Hobby limits of 4 vCPUs and 45 minutes, Pro limits of 8 vCPUs and 24 hours, and Enterprise limits of 32 vCPUs and 24 hours. BB validates the provider maxima; it does not infer the account's plan.

## Files and lifetime

Compute uses `persistent:false` and `vercel/sandbox/universal:latest`. Files and running processes are disposable. Save important changes to Git before expiry or removal. This provider offers creation and removal; it has no suspension, restoration, idle pause, or automatic lifetime extension. Core retires an unused composed machine after its last live thread is archived. Standalone machines remain recorded until explicitly removed, even after vendor compute expires.

The current universal image's source declares Node 24, npm, pnpm, Git, GitHub CLI, curl, Python, and Claude, Codex, Pi, and OpenCode CLIs. `latest` is mutable: this source describes expected tooling, not proof of the deployed image's contents. Core bootstrap invokes Node before downloading the installer; the installer requires Node 22.19 or newer and does not install Node. The image source's Node 24 meets that requirement. Core's installer can start the daemon without systemd. Bootstrap errors remain visible and trigger cleanup. The repository setup hook installs project-specific dependencies; core machine CLI controls can inspect or install agent CLIs when needed.

Diagnostics use SDK `expiresAt`: a running session's vendor `startedAt` (or `createdAt`) plus vendor session timeout, with vendor sandbox `expiresAt` as the SDK fallback. An unavailable timestamp is `null`; BB does not substitute a deadline based on its own request time. Expiry does not imply that BB has removed the recorded machine.

## Durable allocation and cleanup

A server-local UUID in plugin KV storage and the core creation key determine a hashed sandbox name. The plugin saves secret-free allocation intent before submitting a request, records vendor ownership tags, and awaits the core machine-resource checkpoint before enrollment. Recovery reads the original named allocation, verifies team/project scope and ownership, and keeps the same session. A stopped, expired, missing, or replaced session is never silently rebuilt. After confirmed removal, a deliberate core launch may reuse the creation key; the old session identity protects replacement compute from stale cleanup.

Mutations are submitted once through the SDK transport. A lost response, abort, rate limit, or server error leaves submission uncertain; BB reads the durable name to recover an accepted allocation. When the outcome remains unknown, cleanup stays failed and retries rather than declaring absence from one lookup or allocating replacement compute. An allocation that never becomes visible can require operator investigation. Preserve the machine record and original account settings until cleanup resolves; `bb machine retry-cleanup HOST` retries removal immediately. HTTP status alone does not prove a submission had no side effects; create errors retain recovery intent.

Removal verifies tags, allocation generation, and session identity. It persists stop intent before requesting termination, records an acknowledged stop separately, and reads fresh vendor session state. Only an observed `stopped` state becomes durable stop confirmation before named metadata deletion. Each attempt performs bounded, abortable requests; pending termination or failed observation remains retryable. Confirmed stop survives reload and a lost deletion response. Operations on the same creation key are serialized, and allocation generations fence stale cleanup from replacement compute.

Vendor metadata deletion schedules asynchronous pruning. Named and direct-session lookups can return 404 while compute is still running, so a missing allocation without prior stop confirmation stays unresolved. Diagnostics retain the recorded session ID and vendor expiry; elapsed time is informational and does not complete cleanup. Keep the BB machine record and original scope, inspect that session in the Vercel dashboard or contact Vercel support to investigate, and use `bb machine retry-cleanup HOST` when observations recover. BB cannot verify termination of compute hidden by deleted metadata; it retains the durable tombstone rather than claiming removal. A different team/project setting blocks cleanup until the original scope is restored. Token rotation within the original scope is supported. Plugin reload and reinstall retain the allocation namespace in core KV storage; uninstall removes settings and secrets, so reinstall requires restoring credentials in the original scope. Retained identity does not guarantee vendor compute survives. Deleting BB's database or plugin KV loses this identity and requires operator investigation.

Bootstrap stdin is uploaded to a unique 0600 temporary file, opened and unlinked before command execution, and cleaned up on failure where reachable. Exec uses the existing session directly, without SDK automatic resume, a vendor-enforced command timeout, bounded streaming output, and an abort signal. Cancellation attempts SIGKILL when a command receipt exists. An interrupted submission may lack a process receipt; successful remote termination is then unverified, and durable machine removal remains the cleanup path. Closing a CLI/SDK follower stops following; core machine removal cancels the durable creation operation.

## Typed RPC

`rpc.ts` exports `vercelRpcContract`. SDK callers use `sdk.plugins.callRpc` with plugin ID `environment-vercel-sandbox`, the relevant output schema, and explicit inputs:

| Method            | Input      | Output                                                                                                                                 |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `launch.options`  | `{}`       | Image, default inputs, allowed vCPU choices and provider duration limits, memory per vCPU                                              |
| `account.inspect` | `{}`       | `available`, sanitized `message`, nullable `teamId` and `projectId`                                                                    |
| `machine.inspect` | `{hostId}` | Summary, fresh session state and `computeEnded` proof, recorded identity and nullable vendor expiry, resource size/image, team/project |

`computeEnded` is true only when a fresh, owned direct-session observation reports `stopped`. Missing metadata, failed/aborted vendor states, passed expiry, and metadata deletion acknowledgement do not establish that proof.

`bb vercel-sandbox launch options`, `account inspect`, and `machine inspect HOST` expose the same results with `--json`. Core `hosts.experimental_create`, `hosts.delete`, and `threads.spawn` provide launch/removal parity. Use `bb plugin rpc inspect environment-vercel-sandbox` to inspect the registered schemas.

## Vendor evidence and verification

The dependency is pinned to [`@vercel/sandbox` 3.5.1](https://www.npmjs.com/package/@vercel/sandbox/v/3.5.1), Apache-2.0. Its [published artifact](https://registry.npmjs.org/@vercel/sandbox/-/sandbox-3.5.1.tgz) supplies the actual SDK types, image selector, named allocation, `persistent:false`, exec timeout, and expiry contracts. The artifact README states the plan/resource limits. [Vendor SDK reference](https://vercel.com/docs/vercel-sandbox/sdk-reference).

Expected tooling is documented by the [universal image Dockerfile](https://github.com/vercel/sandbox/blob/6fc8e16fd606beab8f99546482f11cc40c3e5a8e/images/universal/Dockerfile). Runtime inspection of this moving image and a full live enrollment/checkout/agent turn remain unverified. The community cloud-sandbox repository has no declared license; this implementation does not copy its code.

```sh
pnpm exec turbo run test typecheck lint --filter=bb-plugin-environment-vercel-sandbox
pnpm exec turbo run test --filter=@bb/plugin-build -- src/builtin-server-artifacts.test.ts -t environment-vercel-sandbox
```

Tests run the real vendor SDK against mocked HTTP transport and use BB's SDK plugin harness. They allocate no paid compute and require no vendor credentials. Core catalog verification uses the existing real migrated database harness.
