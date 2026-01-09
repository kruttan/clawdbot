import { formatErrorMessage } from "../infra/errors.js";
import { loadConfig } from "../config/config.js";
import { resolveAgentMailToken } from "./token.js";

const AGENTMAIL_API_BASE = "https://api.agentmail.to/v1";

export type AgentMailSendOpts = {
  apiKey?: string;
  inboxId?: string;
  subject?: string;
  html?: string;
  cc?: string[];
  bcc?: string[];
  inReplyTo?: string;
  threadId?: string;
  verbose?: boolean;
};

export type AgentMailSendResult = {
  messageId: string;
  inboxId: string;
  threadId?: string;
};

function resolveApiKey(explicit?: string): string {
  const cfg = loadConfig();
  const { token } = resolveAgentMailToken(cfg, { envToken: explicit });
  if (!token) {
    throw new Error(
      "AGENTMAIL_API_KEY or agentmail.apiKey/tokenFile is required for AgentMail sends",
    );
  }
  return token;
}

/**
 * Normalize recipient address.
 * Accepts:
 * - Plain email: user@example.com
 * - Prefixed: agentmail:user@example.com or email:user@example.com
 */
function normalizeRecipient(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Recipient is required for AgentMail sends");

  // Strip common prefixes
  let normalized = trimmed
    .replace(/^(agentmail|email|mail):/i, "")
    .trim();

  if (!normalized) throw new Error("Recipient is required for AgentMail sends");

  // Basic email validation
  if (!normalized.includes("@")) {
    throw new Error(`Invalid email address: ${normalized}`);
  }

  return normalized;
}

/**
 * Resolve inbox ID from config or explicit option.
 * Returns the default inbox if not specified.
 */
async function resolveInboxId(
  apiKey: string,
  explicitInboxId?: string,
): Promise<string> {
  if (explicitInboxId) return explicitInboxId;

  const cfg = loadConfig();
  if (cfg.agentmail?.defaultInboxId) {
    return cfg.agentmail.defaultInboxId;
  }

  // Fallback: fetch first available inbox
  const res = await fetch(`${AGENTMAIL_API_BASE}/inboxes?limit=1`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to list inboxes: ${res.status}`);
  }

  const json = (await res.json()) as {
    inboxes?: Array<{ inbox_id: string }>;
  };

  const first = json.inboxes?.[0];
  if (!first?.inbox_id) {
    throw new Error(
      "No inbox found. Create one first or specify agentmail.defaultInboxId in config.",
    );
  }

  return first.inbox_id;
}

export async function sendMessageAgentMail(
  to: string,
  text: string,
  opts: AgentMailSendOpts = {},
): Promise<AgentMailSendResult> {
  const apiKey = resolveApiKey(opts.apiKey);
  const recipient = normalizeRecipient(to);
  const inboxId = await resolveInboxId(apiKey, opts.inboxId);

  const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

  const sendWithRetry = async <T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const errText = formatErrorMessage(err);
        const terminal =
          attempt === 3 ||
          !/429|timeout|connect|reset|closed|unavailable|temporarily/i.test(
            errText,
          );
        if (terminal) break;
        const backoff = 400 * attempt;
        if (opts.verbose) {
          console.warn(
            `agentmail send retry ${attempt}/2 for ${label} in ${backoff}ms: ${errText}`,
          );
        }
        await sleep(backoff);
      }
    }
    throw lastErr ?? new Error(`AgentMail send failed (${label})`);
  };

  // Handle reply vs new message
  const isReply = Boolean(opts.inReplyTo || opts.threadId);

  const body: Record<string, unknown> = {
    to: [recipient],
    text: text,
  };

  if (opts.subject) {
    body.subject = opts.subject;
  } else if (!isReply) {
    // Default subject for new messages
    body.subject = "Message from Clawdbot";
  }

  if (opts.html) {
    body.html = opts.html;
  }

  if (opts.cc?.length) {
    body.cc = opts.cc;
  }

  if (opts.bcc?.length) {
    body.bcc = opts.bcc;
  }

  // For replies, use the reply endpoint
  if (opts.inReplyTo) {
    const result = await sendWithRetry(async () => {
      const res = await fetch(
        `${AGENTMAIL_API_BASE}/inboxes/${inboxId}/messages/${opts.inReplyTo}/reply`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ text, html: opts.html }),
        },
      );

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`AgentMail reply failed: ${res.status} ${errBody}`);
      }

      return res.json() as Promise<{
        message_id: string;
        thread_id?: string;
      }>;
    }, "reply");

    return {
      messageId: result.message_id,
      inboxId,
      threadId: result.thread_id,
    };
  }

  // Send new message
  const result = await sendWithRetry(async () => {
    const res = await fetch(
      `${AGENTMAIL_API_BASE}/inboxes/${inboxId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`AgentMail send failed: ${res.status} ${errBody}`);
    }

    return res.json() as Promise<{
      message_id: string;
      thread_id?: string;
    }>;
  }, "message");

  return {
    messageId: result.message_id,
    inboxId,
    threadId: result.thread_id,
  };
}
