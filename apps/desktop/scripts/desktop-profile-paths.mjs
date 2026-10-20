import { accessSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function expandProfilePath(path, homeDir) {
  if (path === "~") return homeDir;
  if (path.startsWith("~/")) return resolve(homeDir, path.slice(2));
  return resolve(path);
}

function canonicalPath(path) {
  let existingPath = path;
  while (true) {
    try {
      accessSync(existingPath);
      break;
    } catch {
      const parentPath = dirname(existingPath);
      if (parentPath === existingPath) {
        throw new Error(`Private desktop path has no existing parent: ${path}`);
      }
      existingPath = parentPath;
    }
  }
  return resolve(
    realpathSync.native(existingPath),
    path.slice(existingPath.length).replace(/^\/+/, ""),
  );
}

export function resolveIsolatedProfilePath({ homeDir = homedir(), path }) {
  const resolvedPath = expandProfilePath(path, homeDir);
  const dailyDataDir = canonicalPath(join(homeDir, ".bb"));
  const canonicalRequestedPath = canonicalPath(resolvedPath);
  if (
    canonicalRequestedPath === dailyDataDir ||
    canonicalRequestedPath.startsWith(`${dailyDataDir}/`)
  ) {
    throw new Error(
      "Private desktop paths must not alias the normal ~/.bb directory",
    );
  }
  return resolvedPath;
}
