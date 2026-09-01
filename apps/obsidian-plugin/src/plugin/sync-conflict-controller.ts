import { TFile, type Plugin } from "obsidian";

import { parseConflictCopyPath } from "../sync/core/conflict-file";

/**
 * Finding and settling conflict copies.
 *
 * A conflict copy is written beside its original and then left entirely to the
 * user. Finding it means knowing it exists, remembering the name, and hunting
 * through the file explorer - and it sorts next to the original only when the
 * name came out right, which for a while it did not. So the copies pile up
 * unread, which defeats the point of keeping both versions in the first place.
 */

export interface SynchSyncConflict {
  /** The file the copy was made from - the one still carrying the real name. */
  originalPath: string;
  conflictPath: string;
  detectedAt: number;
  originalModifiedAt: number;
  conflictModifiedAt: number;
  originalSizeBytes: number;
  conflictSizeBytes: number;
  /** Whether the two can be shown as a diff rather than just dates and sizes. */
  comparable: boolean;
}

export interface SynchSyncConflictComparison {
  originalText: string;
  conflictText: string;
}

/** Which version to keep. The other is sent to the vault's trash, never erased. */
export type SynchSyncConflictChoice = "original" | "conflict";

const COMPARABLE_EXTENSIONS = new Set(["md", "txt", "canvas", "json", "csv"]);

export class SynchSyncConflictController {
  constructor(private readonly deps: { plugin: Plugin }) {}

  listConflicts(): SynchSyncConflict[] {
    const vault = this.deps.plugin.app.vault;
    const conflicts: SynchSyncConflict[] = [];

    for (const file of vault.getFiles()) {
      const parsed = parseConflictCopyPath(file.path);
      if (!parsed) {
        continue;
      }

      // A copy whose original has since been deleted or renamed is still worth
      // showing - it may be the only surviving version - but there is nothing
      // to compare it against.
      const original = vault.getAbstractFileByPath(parsed.originalPath);
      const originalFile = original instanceof TFile ? original : null;

      conflicts.push({
        originalPath: parsed.originalPath,
        conflictPath: file.path,
        detectedAt: parsed.detectedAt,
        originalModifiedAt: originalFile?.stat.mtime ?? 0,
        conflictModifiedAt: file.stat.mtime,
        originalSizeBytes: originalFile?.stat.size ?? 0,
        conflictSizeBytes: file.stat.size,
        comparable: originalFile !== null && isComparable(file.extension),
      });
    }

    return conflicts.sort((left, right) => right.detectedAt - left.detectedAt);
  }

  async compareConflict(
    conflict: SynchSyncConflict,
  ): Promise<SynchSyncConflictComparison | null> {
    if (!conflict.comparable) {
      return null;
    }

    const original = this.requireFile(conflict.originalPath);
    const copy = this.requireFile(conflict.conflictPath);
    if (!original || !copy) {
      return null;
    }

    return {
      originalText: await this.deps.plugin.app.vault.cachedRead(original),
      conflictText: await this.deps.plugin.app.vault.cachedRead(copy),
    };
  }

  /**
   * Keep one version and trash the other.
   *
   * Keeping the copy writes its bytes over the original rather than renaming
   * it: the original path is the one the rest of the vault links to, and it is
   * the one sync already knows about, so an ordinary edit is all that has to
   * travel. The losing version goes to the vault's trash, so a wrong choice
   * costs an undo rather than the writing.
   */
  async resolveConflict(
    conflict: SynchSyncConflict,
    choice: SynchSyncConflictChoice,
  ): Promise<void> {
    const app = this.deps.plugin.app;
    const copy = this.requireFile(conflict.conflictPath);
    if (!copy) {
      throw new Error(`"${conflict.conflictPath}" is no longer in the vault.`);
    }

    if (choice === "conflict") {
      const original = this.requireFile(conflict.originalPath);
      const bytes = await app.vault.readBinary(copy);
      if (original) {
        await app.vault.modifyBinary(original, bytes);
      } else {
        await app.vault.createBinary(conflict.originalPath, bytes);
      }
    }

    await app.fileManager.trashFile(copy);
  }

  /** Open both versions side by side, for a conflict that wants a real merge. */
  async openConflictPair(conflict: SynchSyncConflict): Promise<void> {
    const workspace = this.deps.plugin.app.workspace;
    const original = this.requireFile(conflict.originalPath);
    const copy = this.requireFile(conflict.conflictPath);

    if (original) {
      await workspace.getLeaf(false).openFile(original);
    }
    if (copy) {
      await workspace.getLeaf("split").openFile(copy);
    }
  }

  private requireFile(path: string): TFile | null {
    const file = this.deps.plugin.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  }
}

function isComparable(extension: string): boolean {
  return COMPARABLE_EXTENSIONS.has(extension.toLowerCase());
}
