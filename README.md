# ReplyLayer plugins

Plugin packages for [ReplyLayer](https://replylayer.ai), email for AI agents.

| Path | What it is |
|---|---|
| `skills/` | The one source for the ReplyLayer skill text |
| `claude/replylayer/` | Claude plugin bundle (skills plus the ReplyLayer MCP server reference) |
| `openai/replylayer/` | Package source for an OpenAI "With MCP plus skills" submission |

The skills are written once in `skills/` and copied into each package by `scripts/sync-skills.mjs`. Symlinks are not used, because each submitted folder must be self-contained.

## Working on this repository

Requires Node 20 or newer. No dependencies.

```sh
node scripts/sync-skills.mjs          # copy skills/ into each package
node scripts/sync-skills.mjs --check  # fail if any copy has drifted
node scripts/validate.mjs             # structure, manifest and content checks
node --test scripts/*.test.mjs        # validator tests
```

The expected MCP URL defaults to production (`https://api.replylayer.ai/v1/mcp/oauth`). To validate a tree that points elsewhere, set `REPLYLAYER_EXPECTED_MCP_URL` or pass `--url <url>`.

Every change to a submitted folder raises its `version` (`claude/replylayer/.claude-plugin/plugin.json` and `openai/replylayer/plugin.json`, kept equal).

## License

MIT. See `LICENSE`.
