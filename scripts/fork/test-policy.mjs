import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function assertSafeTestWorktree(worktree, forkPatchIds) {
  const frpPackages = [
    "packages/frp-client",
    "apps/connect-next",
    "plugins/connect-next",
  ];
  if (
    frpPackages.some((directory) =>
      existsSync(path.join(worktree, directory)),
    ) &&
    !forkPatchIds.includes("real-frp-tests")
  ) {
    throw new Error(
      "The rebased tree contains FRP tests without the real-frp-tests fork patch. Integrate and review that patch before verification.",
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [worktree, ...forkPatchIds] = process.argv.slice(2);
    if (!worktree || !existsSync(worktree)) {
      throw new Error("An existing verification worktree is required.");
    }
    assertSafeTestWorktree(worktree, forkPatchIds);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
