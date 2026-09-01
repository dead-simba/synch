# Next Obsidian plugin release

## Added

- The version you are running is now shown beside the Syncali heading in settings, so you can tell at a glance whether a device is up to date.

## Fixed

- A failure to decrypt reported only "OperationError", which named neither the file nor the problem. It now says which entry failed and that the data may be damaged or the vault password may not match.
- Server problems were reported as "Unexpected token 'e', ... is not valid JSON" instead of what the server actually said.
