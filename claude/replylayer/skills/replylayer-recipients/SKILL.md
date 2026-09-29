---
name: replylayer-recipients
description: Who a ReplyLayer account can email, and how to add someone. Explains the free-trial recipient rule, add_recipient with confirmation first, the inbound allowlist and blocklist (who may email the mailbox, not who it may email), and the add-only do-not-contact list. Use when a send is refused for the recipient, or the user wants to email someone new or block a sender.
license: MIT
---

# Recipients, allowlists and do-not-contact

Use these tools only when the user's request needs them. Two separate things are easy to confuse: who the account may email (outbound), and who may email the mailbox (inbound). The tools for one never affect the other.

## Who the account can email on the free trial

On the free trial, an account can send only to recipients it has a basis for:

- the account's own email address;
- ReplyLayer's simulator scenario addresses;
- a reply, or a continuation of a thread, to someone whose inbound message passed sender authentication with a matching domain;
- a person who confirmed by clicking a link;
- a person the user vouched for.

A reply to a sender who authenticated but whose domain did not match is refused, so that sender needs one of the other routes. Any other recipient is refused with `SANDBOX_RECIPIENT_NOT_VERIFIED`. `list_recipients` shows who is confirmed. On the free trial, the four simulator addresses are for testing: mail to them reaches no one.

## Adding a recipient

When the user asks you to email someone who is not sendable yet:

1. Call `add_recipient` with just the `email`. ReplyLayer emails that person a confirmation link. Tell the user this happens, because it contacts a third party. You can send to them once they click it, so tell the user to ask them to.
2. Use `attest: true` only when the user has told you they know the person and want them added right now. It sends no email and makes the person sendable at once, but it spends one of the account's limited trial attestations, which are never refunded. Say so before you do it. If someone added this way reports the address as spam, the account loses the ability to add people without confirmation, and a second report suspends the account. Never attest on your own judgment.

If `add_recipient` is refused, the connection or mailbox is not allowed to add people. Ask the user to add the person in the ReplyLayer dashboard.

## Accounts with an approved-recipients list

On some accounts a mailbox is restricted to people the account owner approves, and that list binds sends made by an agent. A send to anyone else fails with `RECIPIENT_NOT_ON_ALLOWLIST` or `RECIPIENT_AGENT_CONTAINED`. `list_allowlist` shows a mailbox's approved list and `list_allowlist_blocked_attempts` shows recent refused sends. No tool here adds to it. Stop and ask the user to approve the address in the ReplyLayer dashboard.

## Who may email the mailbox (inbound)

- `list_inbound_allowlist` and `add_inbound_allowlist_entry` (or `add_inbound_allowlist_bulk`) set which senders a mailbox in allowlist mode accepts. Add an entry only when the user names the sender.
- `list_inbound_blocklist` and `add_inbound_blocklist` (or `add_inbound_blocklist_bulk`) refuse a sender or a whole `@domain` account-wide.

These lists control what reaches the mailbox. They do not approve anyone as a recipient. Never add an inbound allowlist entry to get a blocked send through: it does not do that.

## Do-not-contact list

`list_suppressions` shows addresses ReplyLayer will not send to, including hard bounces and spam complaints. `add_suppression` (or `add_suppressions_bulk`) adds an address or `@domain` when the user asks. There is no tool to remove an entry; tell the user that removing one is done in the ReplyLayer dashboard. A send to a suppressed address fails with `RECIPIENT_SUPPRESSED`: tell the user and do not retry.
