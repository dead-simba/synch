# Next Obsidian plugin release

## Added

- The version you are running is now shown beside the Syncali heading in settings.

## Fixed

- A single file that could not be read while scanning your vault failed the entire scan, which is what the engine uses to work out what to sync. Files are renamed, saved and moved constantly while you work, so this happened often. Such a file is now skipped and picked up on the next scan.
- A single item that could not be read stopped everything else from syncing, permanently. It is now skipped and reported.
- A failure to decrypt reported only "OperationError". It now says which entry failed and what to check.
- Server problems were reported as "Unexpected token 'e', ... is not valid JSON" instead of what the server actually said.
