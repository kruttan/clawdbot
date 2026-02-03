import type { IncomingMessage, ServerResponse } from "node:http";
import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  normalizePluginHttpPath,
  registerPluginHttpRoute,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";

import { getAgentMailRuntime } from "./runtime.js";
import {
  listAgentMailAccountIds,
  resolveDefaultAgentMailAccountId,
  resolveAgentMailAccount,
  type ResolvedAgentMailAccount,
  type AgentMailAccountConfig,
} from "./types.js";
import { resolveAgentMailToken } from "./token.js";
import { sendMessageAgentMail } from "./send.js";
import { probeAgentMail } from "./probe.js";

const AGENTMAIL_API_BASE = "https://api.agentmail.to/v1";
const DEFAULT_TEXT_CHUNK_LIMIT = 10000;

type AgentMailWebhookEvent = {
  event: string;
  data: {
    inbox_id: string;
    message_id: string;
    thread_id?: string;
    from?: {
      email: string;
      name?: string;
    };
    to?: Array<{ email: string; name?: string }>;
    cc?: Array<{ email: string; name?: string }>;
    subject?: string;
    text?: string;
    html?: string;
    date?: string;
    labels?: string[];
    attachments?: Array<{
      filename: string;
      content_type: string;
      size: number;
    }>;
  };
};

async function registerWebhook(
  apiKey: string,
  url: string,
  events: string[] = ["message.received"],
  clientId?: string,
): Promise<{ webhookId: string; secret?: string }> {
  const body: Record<string, unknown> = {
    url,
    events,
  };
  if (clientId) {
    body.client_id = clientId;
  }

  const res = await fetch(`${AGENTMAIL_API_BASE}/webhooks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Failed to register webhook: ${res.status} ${errBody}`);
  }

  const json = (await res.json()) as {
    webhook_id: string;
    secret?: string;
  };

  return {
    webhookId: json.webhook_id,
    secret: json.secret,
  };
}

async function deleteWebhook(apiKey: string, webhookId: string): Promise<void> {
  await fetch(`${AGENTMAIL_API_BASE}/webhooks/${webhookId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

function buildSenderLabel(from: { email: string; name?: string }): string {
  if (from.name) {
    return `${from.name} <${from.email}>`;
  }
  return from.email;
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function resolveAgentMailWebhookPath(webhookPath?: string, webhookUrl?: string): string {
  const normalizedPath = normalizePluginHttpPath(webhookPath, null);
  if (normalizedPath) {
    return normalizedPath;
  }
  const trimmedUrl = webhookUrl?.trim();
  if (trimmedUrl) {
    try {
      const url = new URL(trimmedUrl);
      return normalizePluginHttpPath(url.pathname, "/agentmail-webhook") ?? "/agentmail-webhook";
    } catch {
      // Fall through to default if webhookUrl is invalid.
    }
  }
  return "/agentmail-webhook";
}

export const agentmailPlugin: ChannelPlugin<ResolvedAgentMailAccount> = {
  id: "agentmail",
  meta: {
    id: "agentmail",
    label: "AgentMail",
    selectionLabel: "AgentMail",
    docsPath: "/channels/agentmail",
    docsLabel: "agentmail",
    blurb: "Email via AgentMail API with webhook-based inbound",
    aliases: ["email", "mail"],
    order: 110,
    quickstartAllowFrom: true,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.agentmail"] },
  defaults: {
    queue: {
      debounceMs: 5000, // Longer debounce for email
    },
  },

  config: {
    listAccountIds: (cfg) => listAgentMailAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveAgentMailAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultAgentMailAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      hasToken: account.hasToken,
      defaultInboxId: account.defaultInboxId,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveAgentMailAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean),
  },

  pairing: {
    idLabel: "email",
    normalizeAllowEntry: (entry) => normalizeEmail(entry.replace(/^(agentmail|email|mail):/i, "")),
    notifyApproval: async () => {
      // Email doesn't support easy notification; skip
    },
  },

  security: {
    resolveDmPolicy: ({ account }) => {
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: "channels.agentmail.dmPolicy",
        allowFromPath: "channels.agentmail.allowFrom",
        approveHint: formatPairingApproveHint("agentmail"),
        normalizeEntry: (raw) => normalizeEmail(raw.replace(/^(agentmail|email|mail):/i, "").trim()),
      };
    },
  },

  messaging: {
    normalizeTarget: (target) => {
      const cleaned = target.replace(/^(agentmail|email|mail):/i, "").trim();
      return normalizeEmail(cleaned);
    },
    targetResolver: {
      looksLikeId: (input) => {
        const trimmed = input.trim();
        return trimmed.includes("@") && trimmed.includes(".");
      },
      hint: "<email address>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: DEFAULT_TEXT_CHUNK_LIMIT,
    sendText: async ({ to, text, accountId }) => {
      const runtime = getAgentMailRuntime();
      const cfg = runtime.config.loadConfig() as OpenClawConfig;
      const account = resolveAgentMailAccount({ cfg, accountId });
      const { token: apiKey } = resolveAgentMailToken(cfg);

      if (!apiKey) {
        throw new Error("AgentMail API key not configured");
      }

      const result = await sendMessageAgentMail(to, text, {
        apiKey,
        inboxId: account.defaultInboxId,
        cfg,
      });

      return { channel: "agentmail", to, messageId: result.messageId };
    },
  },

  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "agentmail",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      hasToken: snapshot.hasToken ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ cfg, timeoutMs }) => {
      const { token: apiKey } = resolveAgentMailToken(cfg);
      if (!apiKey) {
        return { ok: false, error: "API key not configured", elapsedMs: 0 };
      }
      return probeAgentMail(apiKey, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      hasToken: account.hasToken,
      defaultInboxId: account.defaultInboxId,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
      probe,
      lastProbeAt: probe ? Date.now() : null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        hasToken: account.hasToken,
        defaultInboxId: account.defaultInboxId,
      });
      ctx.log?.info(`[${account.accountId}] starting AgentMail provider`);

      if (!account.configured) {
        throw new Error("AgentMail API key not configured");
      }

      const runtime = getAgentMailRuntime();
      const cfg = runtime.config.loadConfig() as OpenClawConfig;
      const { token: apiKey } = resolveAgentMailToken(cfg);

      if (!apiKey) {
        throw new Error("AgentMail API key not configured");
      }

      const agentmailCfg = (cfg.channels as Record<string, unknown> | undefined)?.agentmail as
        | AgentMailAccountConfig
        | undefined;

      const webhookPath = resolveAgentMailWebhookPath(
        agentmailCfg?.webhookPath,
        agentmailCfg?.webhookUrl,
      );
      const webhookSecret = agentmailCfg?.webhookSecret;
      const allowFrom = agentmailCfg?.allowFrom;

      // Webhook event handler
      const processWebhookEvent = async (event: AgentMailWebhookEvent) => {
        if (event.event !== "message.received") {
          ctx.log?.debug(`agentmail ignoring event type: ${event.event}`);
          return;
        }

        const data = event.data;
        const inboxId = data.inbox_id;
        const messageId = data.message_id;
        const from = data.from;

        if (!from?.email) {
          ctx.log?.debug("agentmail ignoring message without from address");
          return;
        }

        // AllowFrom check
        if (Array.isArray(allowFrom) && allowFrom.length > 0) {
          const senderEmail = from.email.toLowerCase();
          const allowed = allowFrom.some((entry) => {
            const pattern = String(entry).toLowerCase();
            if (pattern === "*") return true;
            if (pattern === senderEmail) return true;
            // Domain wildcard: *@example.com
            if (pattern.startsWith("*@")) {
              const domain = pattern.slice(2);
              return senderEmail.endsWith(`@${domain}`);
            }
            return false;
          });
          if (!allowed) {
            ctx.log?.debug(`agentmail blocked unauthorized sender: ${senderEmail}`);
            return;
          }
        }

        const subject = data.subject ?? "(no subject)";
        const bodyText = data.text ?? data.html ?? "";
        const senderLabel = buildSenderLabel(from);

        ctx.log?.debug(
          `[${account.accountId}] Email from ${senderLabel}: ${subject.slice(0, 50)}...`,
        );

        // Forward to OpenClaw's message pipeline
        await runtime.channel.reply.handleInboundMessage({
          channel: "agentmail",
          accountId: account.accountId,
          senderId: from.email,
          chatType: "direct",
          chatId: from.email,
          text: `Subject: ${subject}\n\n${bodyText}`,
          reply: async (responseText: string) => {
            await sendMessageAgentMail(from.email, responseText, {
              apiKey,
              inboxId,
              subject: `Re: ${subject}`,
              inReplyTo: messageId,
              cfg,
            });
          },
        });
      };

      const unregisterHttp = registerPluginHttpRoute({
        path: webhookPath,
        pluginId: "agentmail",
        accountId: account.accountId,
        log: (message) => ctx.log?.info(message),
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Allow", "POST");
            res.end();
            return;
          }

          // Verify webhook secret if configured
          if (webhookSecret) {
            const signature = req.headers["x-agentmail-signature"];
            if (typeof signature !== "string" || signature !== webhookSecret) {
              ctx.log?.warn("agentmail webhook signature mismatch");
              res.statusCode = 401;
              res.end("Unauthorized");
              return;
            }
          }

          // Parse request body
          let body = "";
          for await (const chunk of req) {
            body += chunk;
          }

          // Respond immediately (AgentMail best practice)
          res.statusCode = 200;
          res.end("ok");

          // Process event asynchronously
          try {
            const event = JSON.parse(body) as AgentMailWebhookEvent;
            await processWebhookEvent(event);
          } catch (err) {
            ctx.log?.error(`agentmail webhook processing failed: ${err}`);
          }
        },
      });

      ctx.log?.info(`agentmail webhook handler registered at ${webhookPath}`);

      // Register webhook with AgentMail
      let registeredWebhookId: string | undefined;
      try {
        const publicUrl = agentmailCfg?.webhookUrl?.trim();
        if (!publicUrl) {
          ctx.log?.warn("agentmail webhookUrl not configured; skipping webhook registration");
        } else {
          let parsedUrl: URL | null = null;
          try {
            parsedUrl = new URL(publicUrl);
          } catch (err) {
            ctx.log?.warn(`agentmail webhookUrl is invalid: ${String(err)}`);
          }

          if (parsedUrl) {
            const urlPath = parsedUrl.pathname;
            if (urlPath && urlPath !== webhookPath) {
              ctx.log?.warn(
                `agentmail webhookUrl path (${urlPath}) does not match webhookPath (${webhookPath})`,
              );
            }

            const { webhookId, secret } = await registerWebhook(
              apiKey,
              publicUrl,
              ["message.received"],
              "openclaw-webhook",
            );
            registeredWebhookId = webhookId;
            ctx.log?.info(`agentmail webhook registered: ${webhookId}`);
            if (secret) {
              ctx.log?.debug(`agentmail webhook secret: ${secret}`);
            }
          }
        }
      } catch (err) {
        ctx.log?.error(`agentmail webhook registration failed: ${err}`);
      }

      ctx.log?.info(`[${account.accountId}] AgentMail provider started`);

      // Return cleanup function
      return {
        stop: () => {
          unregisterHttp();
          if (registeredWebhookId) {
            deleteWebhook(apiKey, registeredWebhookId).catch((err) => {
              ctx.log?.debug(`agentmail webhook cleanup failed: ${err}`);
            });
          }
          ctx.log?.info(`[${account.accountId}] AgentMail provider stopped`);
        },
      };
    },
  },
};
