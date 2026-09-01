const NEVER_SYNC_RESERVED_SEGMENTS = new Set([
  ".git",
  ".trash",
  ".synch",
  "node_modules",
]);

const MACOS_FOLDER_ICON = /^Icon[\r\n]$/;

export type SyncPathSafetyClass =
  | "normal"
  | "reserved-never-sync"
  | "reserved-config-managed";

export function classifySyncPath(
  path: string,
  configDir = ".obsidian",
): SyncPathSafetyClass {
  const normalized = normalizeReservedPath(path);
  if (!normalized) {
    return "normal";
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => NEVER_SYNC_RESERVED_SEGMENTS.has(segment))) {
    return "reserved-never-sync";
  }

  // macOS writes a custom folder icon to a file literally named "Icon" with a
  // trailing carriage return. It is not anyone's note, and Android cannot
  // create a filename containing one - so syncing it produced FILE_NOTCREATED
  // on every pass, forever, on a file no one would miss.
  if (segments.some((segment) => MACOS_FOLDER_ICON.test(segment))) {
    return "reserved-never-sync";
  }

  if (segments[0] === configDir) {
    return "reserved-config-managed";
  }

  return "normal";
}

export function isReservedSyncPath(path: string): boolean {
  return classifySyncPath(path) !== "normal";
}

export function isNeverSyncReservedPath(path: string): boolean {
  return classifySyncPath(path) === "reserved-never-sync";
}

function normalizeReservedPath(path: string): string {
  // Not trimmed: a leading or trailing space is part of a real filename, and
  // rewriting it here would classify a path that does not exist.
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}
