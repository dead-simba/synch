# Next Obsidian plugin release

## Added

- The version you are running is now shown beside the Syncali heading in settings, so you can tell at a glance whether a device is up to date.

## Fixed

- Server problems were reported as "Unexpected token 'e', ... is not valid JSON" instead of what the server actually said. When infrastructure fails it replies in plain text, and reading that as JSON threw a parse error that described our parser rather than your problem.
