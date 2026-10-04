# ReplyLayer plugin for Cursor and Grok Bot

The ReplyLayer plugin gives an AI agent its own email mailbox. It connects Grok Bot and Cursor to ReplyLayer's hosted MCP server, so the agent can send, reply to, and read security-scanned transactional email.

This package uses an agent API key that you paste into a setup field. It is not a sign-in. It is separate from the Claude and OpenAI packages in this repository, which sign in with OAuth.

## What the plugin contains

- `mcp.json`: one remote MCP server, `https://api.replylayer.ai/v1/mcp`. It sends your key as `Authorization: Bearer <key>`.
- `skills/replylayer-email/SKILL.md`: the rules the agent follows when it uses ReplyLayer.
- `.cursor-plugin/plugin.json`: the manifest. It declares one setup value, `REPLYLAYER_API_KEY`.

The plugin has no hooks, scripts, commands, or binaries. In this version of the package the server URL is fixed and cannot be set, so the key is sent only to `api.replylayer.ai`.

## Set it up

1. In the [ReplyLayer dashboard](https://app.replylayer.ai), create a mailbox for the agent.
2. Under **API keys**, create an **agent** key bound to that one mailbox. The full key is shown once.
3. In Grok Bot, open **Plugins**, find **ReplyLayer**, and choose **Add**. In Cursor, do the same from the Cursor Marketplace once the plugin is listed there, or from your team's marketplace before then.
4. The plugin asks for **ReplyLayer agent API key**. Paste the key only, without the word `Bearer`, and save.

**Never press Authorize or Authenticate on the ReplyLayer connector.** ReplyLayer uses the API key from the setup field, not a sign-in, so that button can only fail. If the connector asks you to authorize, the key is wrong or has been revoked: enter a valid key under **Configure** instead.

**Never paste the key into chat, and never ask the agent to install the plugin for you.** When a chat-driven install is missing a value, the agent is told to ask you for it in chat. Always add the plugin from the Plugins screen.

An installed plugin is available to every bot on your account. If you use a team bot, its plugin values are saved for every user of that bot.

## Rotate or revoke the key

1. Create a new agent key bound to the same mailbox.
2. Open **Plugins → ReplyLayer → Configure** and enter the new key. Saving replaces every stored value, and stored values are never shown again.
3. Turn the plugin off and on again, or start a new chat, so the connector picks up the new key. Then confirm the agent can call `list_mailboxes`.
4. Revoke the old key in the dashboard.

To cut off access immediately, revoke the key in the dashboard. The agent's next call fails with an authentication error.

## Team marketplaces

Cursor Teams and Enterprise admins can import this repository as a team marketplace. Leave the `REPLYLAYER_API_KEY` value unset in the team settings, so that each member supplies their own agent key. A team-configured value is shared by every member.

If you turn on Auto Refresh, your team tracks `main`. Leave it off if you want to review each release before it reaches your team.

## Limits

- The hosted server cannot attach files from the agent's computer. Sends with `attachments` are refused.
- `sent` means ReplyLayer accepted the message. It is not proof that a person received it.

## Documentation

- [MCP server](https://replylayer.ai/docs/mcp)
- [Authentication and API keys](https://replylayer.ai/docs/authentication)

## Support

- Email [support@replylayer.ai](mailto:support@replylayer.ai).
- Documentation: [replylayer.ai/docs/mcp](https://replylayer.ai/docs/mcp).

## Security

Report vulnerabilities to [support@replylayer.ai](mailto:support@replylayer.ai), the contact published in ReplyLayer's [security.txt](https://replylayer.ai/.well-known/security.txt). See [replylayer.ai/security](https://replylayer.ai/security) for how ReplyLayer protects your mail.

## Terms and privacy

Using ReplyLayer through this plugin is covered by the [ReplyLayer Terms of Service](https://replylayer.ai/legal/terms) and the [Privacy Policy](https://replylayer.ai/legal/privacy).

## Development

From the repository root, `node scripts/validate.mjs` checks this package: the marketplace file, the exact set of files, the pinned MCP URL, the setup value, and the skill. It also rejects any key-shaped string. CI runs it on every pull request. This package is not part of the skill sync, so its skill is edited by hand, and any change to this folder raises the `version` in `.cursor-plugin/plugin.json`.

## License

MIT
