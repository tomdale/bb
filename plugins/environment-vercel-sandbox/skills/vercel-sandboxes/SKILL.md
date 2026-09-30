---
name: vercel-sandboxes
description: Configure, launch, inspect, and remove disposable BB machines on Vercel Sandbox.
---

# Vercel Sandbox machines

Install `builtin:environment-vercel-sandbox` from BB Official. Configure secret
`token` and canonical `teamId` (`team_…`) / `projectId` (`prj_…`) in the plugin
settings. Use a long-lived access token; OIDC/JWT credentials are rejected because
the SDK can refresh them from local context and change account scope.
Core machine server access must let the sandbox reach the BB server.
Use the core secret settings flow for the token; launch inputs and diagnostics
are secret-free. Keep runtime credentials in core machine environment settings.

Run `bb vercel-sandbox account inspect --json` to test authenticated scoped
listing without compute. Successful listing does not prove allocation permission
or plan capacity. `bb vercel-sandbox launch options --json` reads image, resource
limits, and launch defaults without vendor allocation.

Create a standalone machine with `bb machine create --provider vercel-sandbox
--inputs '{"vcpus":2,"timeoutMinutes":30}' --json`. Create a thread with
`bb thread spawn --project PROJECT --environment-provider vercel-sandbox
--machine-inputs '{"vcpus":2,"timeoutMinutes":30}' --prompt 'TASK'`.
Machine inputs are a strict object with optional whole `vcpus` (1 or an even count up to 32) and
`timeoutMinutes` (5–1440), or null for defaults. Defaults are plugin settings
`defaultVcpus` (2) and `defaultTimeoutMinutes` (30). Memory is 2048 MiB per vCPU.
Vercel plan caps apply: Hobby 4 CPUs / 45 minutes, Pro 8 CPUs / 24 hours,
Enterprise 32 CPUs / 24 hours, per pinned SDK 3.5.1 documentation.

BB installs and enrolls the daemon; the project-checkout composition clones the
project and runs its owned-path setup hook. The mutable universal image supplies
expected Node and coding tools; agent authentication uses BB's normal provider
and machine configuration. Project dependencies belong in `.bb-env-setup.sh`.
Read the plugin README for tooling provenance and operating constraints.

Inspect with `bb vercel-sandbox machine inspect HOST --json` and
`bb machine show HOST --json`. Include disposable machines with
`bb machine list --all`. Vendor timestamps determine expiry; null means the SDK
has no timestamp. Save important files to Git before expiry or removal.
Compute is disposable and has a fixed lifetime; this provider supports creation
and removal. Archiving the last live composed thread retires its machine.
Remove explicitly with `bb machine remove HOST --yes`.

Allocation intent and vendor identity are durable. A missing or stopped session
fails recovery rather than replacing lost files. An uncertain submission stays
pending cleanup until the owned named allocation is visible. Cleanup records stop
intent, acknowledged stop, and observed stopped state separately; durable stop
confirmation precedes metadata deletion. Missing names or sessions cannot prove
compute termination because vendor pruning is asynchronous. Diagnostics retain
the known session ID and vendor expiry; elapsed time does not resolve cleanup.
Inspect the recorded session in Vercel or contact Vercel support when metadata
is missing, retaining the BB record and original scope for investigation. Inspect lifecycle
errors and use `bb machine retry-cleanup HOST` after fixing credentials or
connectivity. Retain the machine record and original team/project settings while
cleanup is unresolved. Restore the original account scope for cleanup; rotating
the token within that scope is supported. Reinstall preserves core plugin KV
allocation identity but requires reconfiguring settings and credentials.

CLI diagnostics have typed RPC equivalents in `vercelRpcContract` (`rpc.ts`):
`account.inspect` and `launch.options` take `{}`, `machine.inspect` takes
`{hostId}`. Call `sdk.plugins.callRpc` with plugin ID
`environment-vercel-sandbox` and the matching output schema. Core SDK launches
use `hosts.experimental_create({machineProviderId:"vercel-sandbox",inputs})` or
`threads.spawn` with composed `environmentProviderId:"vercel-sandbox"` and
explicit `machine:{type:"new",machineProviderId:"vercel-sandbox",inputs}`.
Core removal is `hosts.delete({hostId})`; inspect lifecycle completion because
cleanup failure can remain retryable after that request succeeds.
