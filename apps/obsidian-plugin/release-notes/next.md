# Next Obsidian plugin release

## Changed

- An item that cannot be read is no longer announced as "Automatic sync failed". Sync did not fail: one item was skipped and everything else synced. The notice now says that.
- That notice is shown once per item rather than once per revision. A backlog delivers every revision of a record in turn, so one unreadable item committed five times produced five near-identical notices in half a minute, which read like five broken files.
- When an unreadable item has never reached this device, the notice now says when it was written ("An item written today at 08:00...") and whether it was a deletion. The path is inside the metadata that will not decrypt, so it cannot be named - but the write time is not encrypted, and it is enough to find the file on the device that does have it. A bare entry id was not.
- Conflicts, path collisions and rejected rollbacks are now kept in **Recent problems** too. They were shown as ordinary notices, so the one message that names the file needing a decision was the one fading away unread.

## Fixed

- A conflict copy of a file whose name contains a dot but no real extension put the marker in the middle of the name: `V2.2 Ground Floor` became `V2.sync-conflict-20260901-081141.2 Ground Floor`. The copy no longer read as a copy of anything, and sorted nowhere near the file it came from. A run of characters containing a space is not an extension.
