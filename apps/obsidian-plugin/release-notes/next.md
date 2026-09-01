# Next Obsidian plugin release

## Added

- The version you are running is now shown beside the Syncali heading in settings.

## Fixed

- A single item that could not be read stopped everything else from syncing, permanently. It is now skipped and reported, and the rest of your vault continues.
- A failure to decrypt reported only "OperationError", which named neither the file nor the problem. It now says which entry failed and what to check.
- Server problems were reported as "Unexpected token 'e', ... is not valid JSON" instead of what the server actually said.
