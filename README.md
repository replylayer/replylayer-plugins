# ReplyLayer plugins

Plugin packages for [ReplyLayer](https://replylayer.ai), email for AI agents.

| Path | What it is |
|---|---|
| `skills/` | The one source for the ReplyLayer skill text |
| `claude/replylayer/` | Claude plugin bundle (skills plus the ReplyLayer MCP server reference) |
| `openai/replylayer/` | Package source for an OpenAI "With MCP plus skills" submission |
| `cursor/replylayer/` | Cursor and Grok Bot plugin (agent API key, hosted MCP server, one hand-maintained skill) |

The skills are written once in `skills/` and copied into each package by `scripts/sync-skills.mjs`. Symlinks are not used, because each submitted folder must be self-contained.

`cursor/replylayer/` is outside the skill sync. Its skill is hand-maintained and covers only the API-key path, because the shared skills describe sign-in and API-key modes together and this package has no sign-in. `scripts/sync-skills.mjs` does not touch it, and `scripts/validate.mjs` checks it with its own rules: the exact marketplace keys, the exact file set, the pinned MCP config and setup value, a character allowlist for the skill, and a content pin. The content pin (`CURSOR_CONTENT_PINS` in `scripts/validate.mjs`) is the SHA-256 of the raw bytes of every file in `cursor/replylayer/` and of `.cursor-plugin/marketplace.json`, so any change to them fails until the pin is edited in the same pull request. After a deliberate change, run `node scripts/validate.mjs --print-cursor-hashes` and paste its output over the constant.

## Working on this repository

Requires Node 20 or newer. No dependencies.

```sh
node scripts/sync-skills.mjs          # copy skills/ into each package
node scripts/sync-skills.mjs --check  # fail if any copy has drifted
node scripts/validate.mjs             # structure, manifest and content checks
node --test scripts/*.test.mjs        # validator tests
node scripts/check-cursor-version-bump.mjs <base-ref>  # Cursor package version rule (CI runs it on pull requests)
```

Every change to a submitted folder raises its `version` (`claude/replylayer/.claude-plugin/plugin.json` and `openai/replylayer/plugin.json`, kept equal).

`cursor/replylayer/` is versioned on its own, in `cursor/replylayer/.cursor-plugin/plugin.json`, and raises its version on any change to its folder or to `.cursor-plugin/marketplace.json`; `metadata.version` there must equal it. CI checks both on pull requests, and also runs Cursor's own validator, pinned to one commit and to a SHA-256.

## License

MIT. See `LICENSE`.
