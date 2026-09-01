# Next Obsidian plugin release

## Changed

- An item that cannot be read is no longer announced as "Automatic sync failed". Sync did not fail: one item was skipped and everything else synced. The notice now says that.
- That notice is shown once per item rather than once per revision. A backlog delivers every revision of a record in turn, so one unreadable item committed five times produced five near-identical notices in half a minute, which read like five broken files.
- When an unreadable item has never reached this device, the notice now says when it was written ("An item written today at 08:00...") and whether it was a deletion. The path is inside the metadata that will not decrypt, so it cannot be named - but the write time is not encrypted, and it is enough to find the file on the device that does have it. A bare entry id was not.
