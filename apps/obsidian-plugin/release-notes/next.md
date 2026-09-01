# Next Obsidian plugin release

## Fixed

- Sync could stay busy forever without ever reporting itself up to date. A file the rules exclude - a conflict copy synced before conflict copies were excluded - left a record claiming this device held it. Cleaning that record up only worked when nothing on the server pointed at it, so the record survived every attempt and each vault scan found the same path and swept it again. One copy from three weeks earlier was being rewritten eighty times in a single session. The record now forgets the local copy on the first pass.
