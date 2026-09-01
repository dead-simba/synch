# Next Obsidian plugin release

## Fixed

- Server problems were reported as "Unexpected token 'e', ... is not valid JSON" instead of what the server actually said. When infrastructure fails it replies in plain text, and reading that as JSON threw a parse error that described our parser rather than your problem. The server's own words now come through.
