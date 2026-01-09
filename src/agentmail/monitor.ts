import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { chunkText, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import type { TypingController } from "../auto-reply/reply/typing.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { loadConfig } from "../config/config.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getChildLogger } from "../logging.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveAgentMailToken } from "./token.js";
import { sendMessageAgentMail } from "./send.js";

const AGENTMAIL_API_BASE = "https://api.agentmail.to/v1";

const logger = getChildLogger({ module: "agentmail-monitor" });

export type MonitorAgentMailOpts = {
  apiKey?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  webhookPath?: string;
  webhookPort?: number;
  webhookUrl?: string;
  webhookSecret?: string;
  inboxIds?: string[];
  defaultInboxId?: string;
};

export type AgentMailWebhookEvent = {
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

export async function monitorAgentMailProvider(
  opts: MonitorAgentMailOpts = {},
): Promise<void> {
  const cfg = loadConfig();
  const { token: apiKey } = resolveAgentMailToken(cfg, {
    envToken: opts.apiKey,
  });

  if (!apiKey) {
    throw new Error(
      "AGENTMAIL_API_KEY or agentmail.apiKey/tokenFile is required for AgentMail provider",
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? defaultRuntime;
  const path = opts.webhookPath ?? cfg.agentmail?.webhookPath ?? "/agentmail-webhook";
  const port = opts.webhookPort ?? cfg.agentmail?.webhookPort ?? 8788;
  const healthPath = "/healthz";
  const textLimit = resolveTextChunkLimit(cfg, "agentmail");
  const allowFrom = cfg.agentmail?.allowFrom;
  const defaultInboxId = opts.defaultInboxId ?? cfg.agentmail?.defaultInboxId;

  // Webhook event handler
  const processWebhookEvent = async (event: AgentMailWebhookEvent) => {
    if (event.event !== "message.received") {
      logVerbose(`agentmail ignoring event type: ${event.event}`);
      return;
    }

    const data = event.data;
    const inboxId = data.inbox_id;
    const messageId = data.message_id;
    const threadId = data.thread_id;
    const from = data.from;

    if (!from?.email) {
      logVerbose("agentmail ignoring message without from address");
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
        logVerbose(`agentmail blocked unauthorized sender: ${senderEmail}`);
        return;
      }
    }

    const subject = data.subject ?? "(no subject)";
    const bodyText = data.text ?? data.html ?? "";
    const senderLabel = buildSenderLabel(from);
    const timestamp = data.date ? new Date(data.date).getTime() : Date.now();

    // Format message body with envelope
    const body = formatAgentEnvelope({
      provider: "Email",
      from: senderLabel,
      timestamp,
      body: `Subject: ${subject}\n\n${bodyText}`,
    });

    const ctxPayload = {
      Body: body,
      From: `agentmail:${from.email}`,
      To: `agentmail:${inboxId}`,
      ChatType: "direct" as const,
      SenderName: from.name ?? from.email,
      SenderId: from.email,
      Surface: "agentmail",
      MessageSid: messageId,
      ThreadId: threadId,
      Subject: subject,
      Timestamp: timestamp,
      InboxId: inboxId,
    };

    if (shouldLogVerbose()) {
      const preview = body.slice(0, 200).replace(/\n/g, "\\n");
      logVerbose(
        `agentmail inbound: from=${from.email} inbox=${inboxId} subject="${subject}" preview="${preview}"`,
      );
    }

    let typingController: TypingController | undefined;

    const dispatcher = createReplyDispatcher({
      responsePrefix: cfg.messages?.responsePrefix,
      deliver: async (payload: ReplyPayload) => {
        await deliverReplies({
          replies: [payload],
          inboxId,
          to: from.email,
          apiKey,
          runtime,
          subject: `Re: ${subject}`,
          inReplyTo: messageId,
          textLimit,
        });
      },
      onIdle: () => {
        typingController?.markDispatchIdle();
      },
      onError: (err, info) => {
        runtime.error?.(
          danger(`agentmail ${info.kind} reply failed: ${String(err)}`),
        );
      },
    });

    const { queuedFinal } = await dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        onTypingController: (typing) => {
          typingController = typing;
        },
      },
    });

    typingController?.markDispatchIdle();
    if (!queuedFinal) return;
  };

  // HTTP server for webhook
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }

    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }

    // Verify webhook secret if configured
    const webhookSecret = opts.webhookSecret ?? cfg.agentmail?.webhookSecret;
    if (webhookSecret) {
      const signature = req.headers["x-agentmail-signature"];
      if (!signature || signature !== webhookSecret) {
        logger.warn("agentmail webhook signature mismatch");
        res.writeHead(401);
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
    res.writeHead(200);
    res.end("ok");

    // Process event asynchronously
    try {
      const event = JSON.parse(body) as AgentMailWebhookEvent;
      await processWebhookEvent(event);
    } catch (err) {
      logger.error({ err }, "agentmail webhook processing failed");
    }
  });

  // Start server
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));

  const publicUrl =
    opts.webhookUrl ?? cfg.agentmail?.webhookUrl ?? `http://localhost:${port}${path}`;

  runtime.log?.(`agentmail webhook server listening on port ${port}`);
  runtime.log?.(`agentmail webhook URL: ${publicUrl}`);

  // Register webhook with AgentMail
  let registeredWebhookId: string | undefined;
  try {
    const { webhookId, secret } = await registerWebhook(
      apiKey,
      publicUrl,
      ["message.received"],
      "clawdbot-webhook",
    );
    registeredWebhookId = webhookId;
    runtime.log?.(`agentmail webhook registered: ${webhookId}`);
    if (secret) {
      runtime.log?.(`agentmail webhook secret: ${secret}`);
    }
  } catch (err) {
    runtime.error?.(
      danger(`agentmail webhook registration failed: ${formatErrorMessage(err)}`),
    );
  }

  // Shutdown handler
  const shutdown = () => {
    server.close();
    if (registeredWebhookId) {
      deleteWebhook(apiKey, registeredWebhookId).catch((err) => {
        logVerbose(`agentmail webhook cleanup failed: ${formatErrorMessage(err)}`);
      });
    }
  };

  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  inboxId: string;
  to: string;
  apiKey: string;
  runtime: RuntimeEnv;
  subject?: string;
  inReplyTo?: string;
  textLimit: number;
}): Promise<void> {
  const { replies, inboxId, to, apiKey, runtime, subject, inReplyTo, textLimit } =
    params;

  for (const reply of replies) {
    if (!reply?.text) {
      runtime.error?.(danger("agentmail reply missing text"));
      continue;
    }

    // Chunk long messages
    const chunks = chunkText(reply.text, textLimit);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isFirst = i === 0;

      try {
        await sendMessageAgentMail(to, chunk, {
          apiKey,
          inboxId,
          subject: isFirst ? subject : undefined,
          inReplyTo: isFirst ? inReplyTo : undefined,
        });

        if (shouldLogVerbose()) {
          logVerbose(
            `agentmail sent: to=${to} chunk=${i + 1}/${chunks.length} len=${chunk.length}`,
          );
        }
      } catch (err) {
        runtime.error?.(
          danger(`agentmail send failed: ${formatErrorMessage(err)}`),
        );
      }
    }
  }
}
