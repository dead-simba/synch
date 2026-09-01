export interface ConflictFileWriter {
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  writeBinary(path: string, content: Uint8Array): Promise<void>;
}

export async function writeConflictCopy(
  writer: ConflictFileWriter,
  path: string,
  bytes: Uint8Array,
  now = Date.now,
): Promise<string> {
  const conflictPath = await getAvailableConflictCopyPath(writer, path, now);
  await ensureParentDirectories(writer, conflictPath);
  await writer.writeBinary(conflictPath, bytes);
  return conflictPath;
}

export async function getAvailableConflictCopyPath(
  writer: Pick<ConflictFileWriter, "exists">,
  path: string,
  now = Date.now,
): Promise<string> {
  const timestamp = formatConflictTimestamp(now());
  let attempt = 0;
  let conflictPath = buildConflictCopyPath(path, timestamp, attempt);
  while (await writer.exists(conflictPath)) {
    attempt += 1;
    conflictPath = buildConflictCopyPath(path, timestamp, attempt);
  }

  return conflictPath;
}

async function ensureParentDirectories(
  writer: Pick<ConflictFileWriter, "exists" | "mkdir">,
  path: string,
): Promise<void> {
  const parts = path.split("/").slice(0, -1);
  let current = "";
  for (const part of parts) {
    if (!part) {
      continue;
    }

    current = current ? `${current}/${part}` : part;
    if (!(await writer.exists(current))) {
      await writer.mkdir(current);
    }
  }
}

function buildConflictCopyPath(
  path: string,
  timestamp: string,
  attempt: number,
): string {
  const slashIndex = path.lastIndexOf("/");
  const parent = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const dotIndex = fileName.lastIndexOf(".");
  // A dot does not make an extension. "V2.2 Ground Floor" has its last dot at
  // index 2, so splitting there put the marker in the middle of the name:
  // "V2.sync-conflict-20260901-081141.2 Ground Floor". The result no longer
  // reads as a copy of anything, and sorts nowhere near the file it came from.
  // A real extension has no spaces in it.
  const hasExtension = dotIndex > 0 && !/\s/.test(fileName.slice(dotIndex));
  const stem = hasExtension ? fileName.slice(0, dotIndex) : fileName;
  const extension = hasExtension ? fileName.slice(dotIndex) : "";
  const prefix = parent ? `${parent}/` : "";
  const baseName = `${prefix}${stem}.sync-conflict-${timestamp}`;
  if (attempt === 0) {
    return `${baseName}${extension}`;
  }

  return `${baseName}-${attempt + 1}${extension}`;
}

function formatConflictTimestamp(value: number): string {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

/**
 * A conflict copy, read back from its name.
 *
 * Resolving a conflict means comparing two files and deleting one. Finding
 * them by hand in the file explorer - where the copy sorts next to the
 * original only if the name came out right - is the part people give up on.
 */
export interface ParsedConflictCopy {
  /** The file this is a copy of. */
  originalPath: string;
  /** When the conflict was noticed, not when the writing happened. */
  detectedAt: number;
}

const CONFLICT_MARKER =
  /\.sync-conflict-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?/;

export function parseConflictCopyPath(path: string): ParsedConflictCopy | null {
  const slashIndex = path.lastIndexOf("/");
  const parent = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;

  const match = CONFLICT_MARKER.exec(fileName);
  if (!match || match.index === undefined) {
    return null;
  }

  // Everything on either side of the marker belongs to the original name.
  // Older copies put the marker mid-name - "V2.sync-conflict-....2 Ground
  // Floor" - and those still have to lead back to the file they came from.
  const originalName =
    fileName.slice(0, match.index) + fileName.slice(match.index + match[0].length);
  if (!originalName) {
    return null;
  }

  const [, year, month, day, hours, minutes, seconds] = match;
  const detectedAt = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  ).getTime();

  return {
    originalPath: `${parent}${originalName}`,
    detectedAt: Number.isFinite(detectedAt) ? detectedAt : 0,
  };
}
