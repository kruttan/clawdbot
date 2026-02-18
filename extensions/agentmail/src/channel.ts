import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  normalizeAccountId,
  normalizePluginHttpPath,
  registerPluginHttpRoute,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk";
import { AgentMailConfigSchema } from "./config-schema.js";
import { probeAgentMail } from "./probe.js";
import { getAgentMailRuntime } from "./runtime.js";
import { sendMessageAgentMail } from "./send.js";
import { resolveAgentMailToken } from "./token.js";
import {
  listAgentMailAccountIds,
  resolveDefaultAgentMailAccountId,
  resolveAgentMailAccount,
  type ResolvedAgentMailAccount,
  type AgentMailAccountConfig,
} from "./types.js";

const AGENTMAIL_API_BASE = "https://api.agentmail.to/v1";
const DEFAULT_TEXT_CHUNK_LIMIT = 10000;
const SVIX_TOLERANCE_MS = 5 * 60 * 1000;

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
    // AgentMail now expects event_types; keep events for backwards compatibility.
    event_types: events,
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

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function formatTokenHint(token: string): string {
  if (!token) return "missing";
  const tail = token.length > 4 ? token.slice(-4) : token;
  return `…${tail}`;
}

function extractHeaderValue(header: string | string[] | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  if (Array.isArray(header)) {
    return header[0];
  }
  return header;
}

function buildSvixSecretKey(secret: string): Buffer {
  const trimmed = secret.trim();
  if (!trimmed) {
    return Buffer.alloc(0);
  }
  const base = trimmed.startsWith("whsec_") ? trimmed.slice(6) : trimmed;
  const decoded = Buffer.from(base, "base64");
  if (decoded.length > 0) {
    return decoded;
  }
  return Buffer.from(trimmed);
}

type SvixVerification = {
  status: "skip" | "pass" | "fail";
  reason?: string;
};

type HeaderVerification = {
  status: "pass" | "fail";
  reason?: string;
};

function normalizeSecretHeaderName(headerName?: string): string | undefined {
  const trimmed = headerName?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

function normalizeBearerToken(value: string): string {
  const trimmed = value.trim();
  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

function verifyHeaderSecret(params: {
  headers: IncomingMessage["headers"];
  headerName: string;
  secret: string;
}): HeaderVerification {
  const headerKey = normalizeSecretHeaderName(params.headerName);
  if (!headerKey) {
    return { status: "fail", reason: "empty webhook secret header name" };
  }
  const headerValue = extractHeaderValue(params.headers[headerKey]);
  if (!headerValue) {
    return { status: "fail", reason: `missing ${params.headerName} header` };
  }
  const secret = params.secret.trim();
  if (!secret) {
    return { status: "fail", reason: "empty webhook secret" };
  }
  const candidate = normalizeBearerToken(headerValue);
  if (safeEqual(candidate, secret)) {
    return { status: "pass" };
  }
  return { status: "fail", reason: `${params.headerName} token mismatch` };
}

function verifySvixSignature(params: {
  headers: IncomingMessage["headers"];
  payload: string;
  secret: string;
}): SvixVerification {
  const id = extractHeaderValue(params.headers["svix-id"]);
  const timestamp = extractHeaderValue(params.headers["svix-timestamp"]);
  const signatureHeader = extractHeaderValue(params.headers["svix-signature"]);

  const hasAnyHeader = Boolean(id || timestamp || signatureHeader);
  if (!hasAnyHeader) {
    return { status: "skip" };
  }

  if (!id || !timestamp || !signatureHeader) {
    return { status: "fail", reason: "missing svix headers" };
  }

  const timestampSec = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSec)) {
    return { status: "fail", reason: "invalid svix timestamp" };
  }
  const now = Date.now();
  const skewMs = Math.abs(now - timestampSec * 1000);
  if (skewMs > SVIX_TOLERANCE_MS) {
    return { status: "fail", reason: "svix timestamp outside tolerance" };
  }

  const secretKey = buildSvixSecretKey(params.secret);
  if (secretKey.length === 0) {
    return { status: "fail", reason: "empty webhook secret" };
  }

  const signedContent = `${id}.${timestamp}.${params.payload}`;
  const digest = createHmac("sha256", secretKey).update(signedContent).digest("base64");

  const signatures = signatureHeader
    .split(" ")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith("v1,") ? entry.slice(3) : ""))
    .filter(Boolean);

  for (const signature of signatures) {
    if (safeEqual(signature, digest)) {
      return { status: "pass" };
    }
  }

  return { status: "fail", reason: "svix signature mismatch" };
}

function normalizeAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  const lower = trimmed.toLowerCase();
  if (lower === "*" || lower.startsWith("*@")) {
    return lower;
  }
  return normalizeEmail(lower.replace(/^(agentmail|email|mail):/i, ""));
}

function normalizeAllowList(entries: Array<string | number>): string[] {
  const normalized = entries.map((entry) => normalizeAllowEntry(String(entry))).filter(Boolean);
  return Array.from(new Set(normalized));
}

function isSenderAllowed(senderEmail: string, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) {
    return false;
  }
  if (allowFrom.includes("*")) {
    return true;
  }
  for (const entry of allowFrom) {
    if (!entry) {
      continue;
    }
    if (entry === senderEmail) {
      return true;
    }
    if (entry.startsWith("*@")) {
      const domain = entry.slice(2);
      if (domain && senderEmail.endsWith(`@${domain}`)) {
        return true;
      }
    }
  }
  return false;
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
  configSchema: buildChannelConfigSchema(AgentMailConfigSchema),
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
      allowFrom.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, name }) => {
      const trimmed = name?.trim();
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          agentmail: {
            ...(cfg.channels?.agentmail ?? {}),
            ...(trimmed ? { name: trimmed } : {}),
          },
        },
      };
    },
    validateInput: ({ cfg, accountId, input }) => {
      if (accountId !== DEFAULT_ACCOUNT_ID) {
        return "AgentMail currently supports only the default account.";
      }
      const token = input.token?.trim();
      const tokenFile = input.tokenFile?.trim();
      const hasExistingToken = resolveAgentMailAccount({ cfg, accountId }).hasToken;
      if (!input.useEnv && !token && !tokenFile && !hasExistingToken) {
        return "AgentMail requires --token, --token-file, or --use-env.";
      }
      const webhookUrl = input.webhookUrl?.trim();
      if (webhookUrl) {
        try {
          const parsed = new URL(webhookUrl);
          if (!/^https?:$/i.test(parsed.protocol)) {
            return "AgentMail webhook URL must use http:// or https://.";
          }
        } catch {
          return "AgentMail webhook URL must be a valid URL.";
        }
      }
      return null;
    },
    applyAccountConfig: ({ cfg, input }) => {
      const token = input.token?.trim();
      const tokenFile = input.tokenFile?.trim();
      const webhookPath = input.webhookPath?.trim();
      const webhookUrl = input.webhookUrl?.trim();
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          agentmail: {
            ...(cfg.channels?.agentmail ?? {}),
            enabled: true,
            ...(input.name?.trim() ? { name: input.name.trim() } : {}),
            ...(input.useEnv ? {} : { ...(token ? { apiKey: token } : {}) }),
            ...(input.useEnv ? {} : { ...(tokenFile ? { tokenFile } : {}) }),
            ...(webhookPath ? { webhookPath } : {}),
            ...(webhookUrl ? { webhookUrl } : {}),
          },
        },
      };
    },
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
        normalizeEntry: (raw) =>
          normalizeEmail(raw.replace(/^(agentmail|email|mail):/i, "").trim()),
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
      const webhookSecretHeader = agentmailCfg?.webhookSecretHeader?.trim();
      ctx.log?.info(
        `[agentmail] webhook auth configured: header=${webhookSecretHeader ?? "none"} secret=${webhookSecret ? formatTokenHint(webhookSecret) : "none"}`,
      );
      const statusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) =>
        ctx.setStatus({ accountId: ctx.accountId, ...patch });

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

        const subject = data.subject ?? "(no subject)";
        const bodyText = data.text ?? data.html ?? "";
        const senderEmail = normalizeEmail(from.email);
        const senderLabel = buildSenderLabel({ email: senderEmail, name: from.name?.trim() });
        const rawBody = bodyText.trim()
          ? `Subject: ${subject}\n\n${bodyText}`
          : `Subject: ${subject}`;
        const timestampMs = data.date ? Date.parse(data.date) : undefined;
        const timestamp = Number.isFinite(timestampMs) ? timestampMs : undefined;

        const dmPolicy = agentmailCfg?.dmPolicy ?? "pairing";
        const configAllowFrom = normalizeAllowList(agentmailCfg?.allowFrom ?? []);
        const shouldComputeAuth = runtime.channel.commands.shouldComputeCommandAuthorized(
          rawBody,
          cfg,
        );
        const storeAllowFrom =
          dmPolicy !== "open" || shouldComputeAuth
            ? await runtime.channel.pairing.readAllowFromStore("agentmail").catch(() => [])
            : [];
        const effectiveAllowFrom = normalizeAllowList([...configAllowFrom, ...storeAllowFrom]);
        const senderAllowed = isSenderAllowed(senderEmail, effectiveAllowFrom);
        const useAccessGroups = cfg.commands?.useAccessGroups !== false;
        const commandAuthorized = shouldComputeAuth
          ? runtime.channel.commands.resolveCommandAuthorizedFromAuthorizers({
              useAccessGroups,
              authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
            })
          : undefined;

        if (dmPolicy === "disabled") {
          ctx.log?.debug(`agentmail blocked sender ${senderEmail} (dmPolicy=disabled)`);
          return;
        }

        if (dmPolicy !== "open" && !senderAllowed) {
          if (dmPolicy === "pairing") {
            const { code, created } = await runtime.channel.pairing.upsertPairingRequest({
              channel: "agentmail",
              id: senderEmail,
              meta: { name: from.name?.trim() },
            });
            if (created) {
              ctx.log?.info(`agentmail pairing request sender=${senderEmail}`);
              try {
                await sendMessageAgentMail(
                  senderEmail,
                  runtime.channel.pairing.buildPairingReply({
                    channel: "agentmail",
                    idLine: `Your email: ${senderEmail}`,
                    code,
                  }),
                  {
                    apiKey,
                    inboxId,
                    subject: "OpenClaw pairing code",
                    cfg,
                  },
                );
                statusSink({ lastOutboundAt: Date.now() });
              } catch (err) {
                ctx.log?.warn(`agentmail pairing reply failed for ${senderEmail}: ${String(err)}`);
              }
            }
          } else {
            ctx.log?.debug(
              `agentmail blocked unauthorized sender ${senderEmail} (dmPolicy=${dmPolicy})`,
            );
          }
          return;
        }

        ctx.log?.debug(
          `[${account.accountId}] Email from ${senderLabel}: ${subject.slice(0, 50)}...`,
        );

        statusSink({ lastInboundAt: timestamp ?? Date.now() });

        const route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "agentmail",
          accountId: account.accountId,
          peer: {
            kind: "dm",
            id: senderEmail,
          },
        });

        const storePath = runtime.channel.session.resolveStorePath(cfg.session?.store, {
          agentId: route.agentId,
        });
        const envelopeOptions = runtime.channel.reply.resolveEnvelopeFormatOptions(cfg);
        const previousTimestamp = runtime.channel.session.readSessionUpdatedAt({
          storePath,
          sessionKey: route.sessionKey,
        });
        const body = runtime.channel.reply.formatAgentEnvelope({
          channel: "AgentMail",
          from: senderLabel,
          timestamp,
          previousTimestamp,
          envelope: envelopeOptions,
          body: rawBody,
        });

        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: rawBody,
          CommandBody: rawBody,
          From: `agentmail:${senderEmail}`,
          To: `agentmail:${senderEmail}`,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "direct",
          ConversationLabel: senderLabel,
          SenderName: from.name?.trim() || undefined,
          SenderId: senderEmail,
          Provider: "agentmail",
          Surface: "agentmail",
          MessageSid: messageId,
          MessageThreadId: data.thread_id,
          Timestamp: timestamp,
          OriginatingChannel: "agentmail",
          OriginatingTo: `agentmail:${senderEmail}`,
          CommandAuthorized: commandAuthorized,
        });

        await runtime.channel.session.recordInboundSession({
          storePath,
          sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
          ctx: ctxPayload,
          onRecordError: (err) => {
            ctx.log?.warn(`agentmail failed updating session meta: ${String(err)}`);
          },
        });

        const tableMode = runtime.channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "agentmail",
          accountId: account.accountId,
        });

        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            deliver: async (payload) => {
              if (!payload.text) {
                return;
              }
              const text = runtime.channel.text.convertMarkdownTables(payload.text, tableMode);
              await sendMessageAgentMail(senderEmail, text, {
                apiKey,
                inboxId,
                subject: `Re: ${subject}`,
                inReplyTo: messageId,
                cfg,
              });
              statusSink({ lastOutboundAt: Date.now() });
            },
            onError: (err, info) => {
              ctx.log?.warn(`agentmail ${info.kind} reply failed: ${String(err)}`);
            },
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

          // Parse request body
          let body = "";
          for await (const chunk of req) {
            body += chunk;
          }

          // Verify webhook secret if configured.
          if (webhookSecretHeader || webhookSecret) {
            let verified = false;
            let reason: string | undefined;

            if (webhookSecretHeader) {
              if (!webhookSecret?.trim()) {
                reason = "missing webhookSecret for header auth";
              } else {
                const headerCheck = verifyHeaderSecret({
                  headers: req.headers,
                  headerName: webhookSecretHeader,
                  secret: webhookSecret,
                });
                verified = headerCheck.status === "pass";
                reason = headerCheck.reason;
              }
            } else if (webhookSecret) {
              const legacySignature = extractHeaderValue(req.headers["x-agentmail-signature"]);
              const svixResult = verifySvixSignature({
                headers: req.headers,
                payload: body,
                secret: webhookSecret,
              });
              const legacyOk =
                typeof legacySignature === "string" && safeEqual(legacySignature, webhookSecret);
              verified = svixResult.status === "pass" || legacyOk;
              if (!verified) {
                reason = svixResult.status === "fail" ? svixResult.reason : "missing signature";
              }
            }

            if (!verified) {
              ctx.log?.warn(`agentmail webhook signature mismatch (${reason ?? "unknown"})`);
              res.statusCode = 401;
              res.end("Unauthorized");
              return;
            }
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
