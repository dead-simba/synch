import { describe, expect, it } from "vitest";

import { getAvailableConflictCopyPath, parseConflictCopyPath } from "./conflict-file";
import { shouldSyncPath } from "./file-rules";
import { DEFAULT_SYNC_FILE_RULES } from "./file-rules";

/**
 * A conflict copy has one job beyond holding the bytes: saying what it is a
 * copy of. A name that hides that is a file the user will not recognise later.
 */

const never = { exists: async () => false };
const at = () => new Date(2026, 8, 1, 8, 11, 41).getTime();

describe("naming a conflict copy", () => {
  it("keeps the marker at the end when the dot is not an extension", async () => {
    // Observed in the vault: "V2.2 Ground Floor" has its last dot at index 2,
    // so ".2 Ground Floor" was taken for an extension and the marker landed in
    // the middle - "V2.sync-conflict-20260901-081141.2 Ground Floor".
    const path = await getAvailableConflictCopyPath(
      never,
      "Images/V2.2 Ground Floor",
      at,
    );

    expect(path).toBe("Images/V2.2 Ground Floor.sync-conflict-20260901-081141");
    expect(path).not.toContain("sync-conflict-20260901-081141.2");
  });

  it("still puts the marker before a real extension", async () => {
    const path = await getAvailableConflictCopyPath(never, "Notes/Plan.md", at);

    expect(path).toBe("Notes/Plan.sync-conflict-20260901-081141.md");
  });

  it("leaves a name that ends in a space alone", async () => {
    // Trailing spaces are legal in a vault and have broken this codebase
    // before. Trimming here would produce a path that does not exist.
    const path = await getAvailableConflictCopyPath(
      never,
      "Images/V2.2 Ground Floor ",
      at,
    );

    expect(path).toBe("Images/V2.2 Ground Floor .sync-conflict-20260901-081141");
  });

  it("never syncs the copies it names, however they are named", async () => {
    // A conflict copy that syncs multiplies across every device. Whichever
    // shape the name takes, the exclusion has to still recognise it.
    for (const original of [
      "Notes/Plan.md",
      "Images/V2.2 Ground Floor",
      "Images/V2.2 Ground Floor ",
    ]) {
      const conflictPath = await getAvailableConflictCopyPath(never, original, at);
      expect(shouldSyncPath(conflictPath, DEFAULT_SYNC_FILE_RULES)).toBe(false);
    }
  });
});

describe("reading a conflict copy's name back", () => {
  it("leads back to the file it is a copy of", () => {
    expect(
      parseConflictCopyPath("Notes/Plan.sync-conflict-20260901-081141.md")?.originalPath,
    ).toBe("Notes/Plan.md");
    expect(
      parseConflictCopyPath("Notes/Plan.sync-conflict-20260901-081141-2.md")?.originalPath,
    ).toBe("Notes/Plan.md");
    expect(
      parseConflictCopyPath("Images/V2.2 Ground Floor.sync-conflict-20260901-081141")
        ?.originalPath,
    ).toBe("Images/V2.2 Ground Floor");
  });

  it("still leads back from the names the old bug wrote", () => {
    // These are sitting in real vaults with the marker mid-name. They are
    // exactly the copies hardest to find by hand, so they are the ones that
    // most need to appear in the list.
    expect(
      parseConflictCopyPath("Images/V2.sync-conflict-20260901-081141.2 Ground Floor ")
        ?.originalPath,
    ).toBe("Images/V2.2 Ground Floor ");
  });

  it("reads the time the conflict was noticed", () => {
    expect(parseConflictCopyPath("Notes/Plan.sync-conflict-20260901-081141.md")?.detectedAt).toBe(
      new Date(2026, 8, 1, 8, 11, 41).getTime(),
    );
  });

  it("ignores a file that is not a conflict copy", () => {
    expect(parseConflictCopyPath("Notes/Plan.md")).toBeNull();
    expect(parseConflictCopyPath("Notes/sync-conflict notes.md")).toBeNull();
  });

  it("round-trips a name it just wrote", async () => {
    for (const original of [
      "Notes/Plan.md",
      "Images/V2.2 Ground Floor",
      "Images/V2.2 Ground Floor ",
      "Deep/Folder/Note.canvas",
    ]) {
      const conflictPath = await getAvailableConflictCopyPath(never, original, at);
      expect(parseConflictCopyPath(conflictPath)?.originalPath).toBe(original);
    }
  });
});
