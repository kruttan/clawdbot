---
summary: "AgentMail email channel setup and webhook requirements"
read_when:
  - You want to receive email via AgentMail
  - You need webhook + config details for the AgentMail channel
title: "AgentMail"
---

# AgentMail (plugin)

AgentMail lets OpenClaw send and receive email via the AgentMail API. Inbound emails arrive through
AgentMail webhooks and are routed into the standard message pipeline (as DMs from the sender address).

Status: supported via plugin. Direct messages only. Attachments are not yet ingested.

## Plugin required

AgentMail ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
openclaw plugins install @openclaw/agentmail
```

Local checkout (when running from a git repo):

```bash
openclaw plugins install ./extensions/agentmail
```

Details: [Plugins](/plugin)

## Setup

1. Install the plugin (see above).
2. Create an AgentMail account and inbox.
3. Generate an AgentMail API key.
4. Expose the Gateway webhook endpoint publicly (reverse proxy, Tailscale Funnel, etc.).
5. Set `channels.agentmail.webhookUrl` to the public URL.
6. Start the Gateway (`openclaw gateway run` or `openclaw up`).
7. Send an email to the inbox; it should appear as a DM from the sender.

Minimal config:

```json5
{
  channels: {
    agentmail: {
      enabled: true,
      apiKey: "am_live_***",
      defaultInboxId: "inbox_***",
      webhookUrl: "https://gateway.example.com/agentmail-webhook",
      dmPolicy: "pairing",
    },
  },
}
```

Token file instead of inline key:

```json5
{
  channels: {
    agentmail: {
      enabled: true,
      tokenFile: "/path/to/agentmail.key",
      defaultInboxId: "inbox_***",
      webhookUrl: "https://gateway.example.com/agentmail-webhook",
    },
  },
}
```

## Webhook options

- `webhookUrl` (required for auto-registration): public URL AgentMail should post to.
- `webhookPath` (optional): override the path portion (default: `/agentmail-webhook`).
- `webhookSecret` (optional): shared secret for `x-agentmail-signature` verification.

If `webhookUrl` is set, the gateway will register the webhook with AgentMail on startup.
If you register webhooks manually in the AgentMail dashboard, you can omit `webhookUrl`
and keep only `webhookPath` + `webhookSecret`.

## Access control (DMs)

- Default: `channels.agentmail.dmPolicy = "pairing"`. Unknown senders get a pairing code.
- Approve via:
  - `openclaw pairing list agentmail`
  - `openclaw pairing approve agentmail <CODE>`
- Public DMs: set `channels.agentmail.dmPolicy = "open"` and `channels.agentmail.allowFrom = ["*"]`.
- Allowlist entries can be full emails (`user@example.com`) or domain wildcards (`*@example.com`).

## Capabilities

| Feature         | Status        |
| --------------- | ------------- |
| Direct messages | ✅ Supported  |
| Group chat      | ❌ N/A (email) |
| Media           | ❌ Not yet    |
| Reactions       | ❌ Not yet    |
