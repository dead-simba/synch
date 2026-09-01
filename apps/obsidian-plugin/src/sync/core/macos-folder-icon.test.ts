import { describe, expect, it } from "vitest";

import { isNeverSyncReservedPath } from "./reserved-paths";

/**
 * macOS writes a custom folder icon to a file named "Icon" followed by a
 * carriage return. Android cannot create a filename containing one, so every
 * sync pass on the phone failed with FILE_NOTCREATED - forever, over a file
 * that is not anyone's note.
 */
describe("the macOS folder icon file", () => {
  it("is never synced", () => {
    expect(isNeverSyncReservedPath("Icon\r")).toBe(true);
    expect(isNeverSyncReservedPath("My Knowledge Base/Icon\r")).toBe(true);
  });

  it("does not catch a note that merely starts with the word", () => {
    // "Icon" alone is a legal, ordinary filename and someone's note may be it.
    expect(isNeverSyncReservedPath("Icons.md")).toBe(false);
    expect(isNeverSyncReservedPath("Design/Icon.png")).toBe(false);
    expect(isNeverSyncReservedPath("Icon")).toBe(false);
  });
});
