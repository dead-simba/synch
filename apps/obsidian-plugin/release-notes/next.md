# Next Obsidian plugin release

## Fixed

- Sync could stay busy forever without ever reporting itself up to date. A file the rules exclude - a conflict copy synced before conflict copies were excluded - left a record claiming this device held it. Cleaning that record up only worked when nothing on the server pointed at it, so the record survived every attempt and each vault scan found the same path and swept it again. One copy from three weeks earlier was being rewritten eighty times in a single session. The record now forgets the local copy on the first pass.
- A file that never reached the server was never noticed again, so it silently did not sync while the status sat at "syncing 99% - 1527 / 1529" and never finished. A queued upload that gets dropped - which a rename or delete between queueing and pushing used to cause - leaves a record that looks settled: the file's hash matches what was recorded, nothing is queued, and nothing on the server sits behind it. Both the scan's stat cache and its hash check treated that as up to date. They now ask whether the file ever actually reached the server.
