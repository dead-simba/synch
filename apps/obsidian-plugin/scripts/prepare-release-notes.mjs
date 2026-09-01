import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("Usage: node scripts/prepare-release-notes.mjs <x.y.z>");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptDir, "..");
const sourcePath = path.join(pluginRoot, "release-notes", "next.md");
const releaseDir = path.join(pluginRoot, "dist");
const releaseNotesPath = path.join(releaseDir, "release-notes.md");

const source = await fs.readFile(sourcePath, "utf8");
const body = source.replace(/^# Next Obsidian plugin release\s*/u, "").trim();

if (!/^[-*]\s+\S/m.test(body)) {
  throw new Error(`${sourcePath} must contain at least one release note bullet.`);
}

await fs.mkdir(releaseDir, { recursive: true });
await fs.writeFile(
  releaseNotesPath,
  `# Syncali ${version}\n\nReleased ${new Date().toISOString().slice(0, 10)}.\n\n${body}\n`,
);

console.log(releaseNotesPath);
