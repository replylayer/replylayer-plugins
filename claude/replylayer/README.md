# ReplyLayer for Claude

ReplyLayer gives an AI agent a mailbox of its own, with every message it sends or receives screened for unsafe content. This plugin adds three skills that teach Claude how to use ReplyLayer safely, and connects Claude to the ReplyLayer server so it can read, reply to and send mail from the mailboxes you choose. It is for transactional and operational email, not bulk or marketing mail.

## What it does

- `replylayer-email`: the core rules. Start from your mailboxes, send only from an approved one, read the outcome of every send, and never resend a message that was held.
- `replylayer-inbox-triage`: reading, searching and summarizing mail and threads, waiting for a reply, and explaining held or blocked mail.
- `replylayer-recipients`: who your account can email, how to add a recipient, and the difference between who may email a mailbox and who it may email.

Claude uses the skills only when your request needs email.

## Connecting

You sign in to ReplyLayer when you connect. ReplyLayer asks you to choose the mailboxes Claude may use and to approve the connection. Claude can only reach the mailboxes you chose, and it cannot change your account, your keys or a mailbox's approval rules. ReplyLayer emails you each time you approve a new connection.

You need a ReplyLayer account.

### Claude Code

The ReplyLayer tools in this plugin sign in through claude.ai. In Claude Code, connect with a ReplyLayer agent API key instead, following https://replylayer.ai/docs/mcp. The skills still apply.

## The free-trial recipient rule

On the free trial, an account can send only to people it has a basis for: your own email address, ReplyLayer's simulator addresses, a reply to someone whose message passed sender authentication, a person who confirmed by clicking a link, or a person you vouched for. Any other recipient is refused, and Claude will tell you and offer to send that person a confirmation link.

## What this plugin connects to and where data goes

- The plugin itself connects only to ReplyLayer's MCP server at `https://api.replylayer.ai/v1/mcp/oauth`. It calls no other service.
- Email you ask Claude to send is delivered by ReplyLayer to its recipients through ReplyLayer's mail-delivery providers, as the Privacy Policy describes.
- ReplyLayer stores your account's mail and related records under the Privacy Policy.
- The plugin collects no chat or conversation data. It holds no secrets and stores nothing itself.
- ReplyLayer is not for users under 18.

## Publisher and links

ReplyLayer is operated by ReplyLayer LLC.

- Privacy Policy: https://replylayer.ai/legal/privacy
- Terms: https://replylayer.ai/legal/terms
- Security contact: https://replylayer.ai/.well-known/security.txt
- Support: https://replylayer.ai/support
- Documentation: https://replylayer.ai/docs/mcp

License: MIT.
