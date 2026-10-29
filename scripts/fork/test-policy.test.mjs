import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const policy = fileURLToPath(new URL("./test-policy.mjs", import.meta.url));

for (const directory of [
  "packages/frp-client",
  "apps/connect-next",
  "plugins/connect-next",
]) {
  test(`verification requires the FRP safety patch for ${directory}`, (t) => {
    const worktree = mkdtempSync(
      path.join(os.tmpdir(), "bb-fork-test-policy-"),
    );
    t.after(() => rmSync(worktree, { recursive: true, force: true }));
    mkdirSync(path.join(worktree, directory), { recursive: true });

    const blocked = spawnSync(
      process.execPath,
      [policy, worktree, "fork-sync"],
      { encoding: "utf8" },
    );
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /real-frp-tests/);

    const allowed = spawnSync(
      process.execPath,
      [policy, worktree, "fork-sync", "real-frp-tests"],
      { encoding: "utf8" },
    );
    assert.equal(allowed.status, 0, allowed.stderr);
  });
}

test("verification accepts a tree without FRP packages", (t) => {
  const worktree = mkdtempSync(path.join(os.tmpdir(), "bb-fork-test-policy-"));
  t.after(() => rmSync(worktree, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [policy, worktree, "fork-sync"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("verification rejects a missing worktree", () => {
  const result = spawnSync(process.execPath, [policy], { encoding: "utf8" });
  assert.equal(result.status, 1);
});
