const AGENTMAIL_API_BASE = "https://api.agentmail.to/v1";

export type AgentMailProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
  elapsedMs: number;
  account?: {
    inboxCount?: number | null;
  };
  webhook?: {
    id?: string | null;
    url?: string | null;
  };
};

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  opts: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeAgentMail(
  apiKey: string,
  timeoutMs: number,
): Promise<AgentMailProbe> {
  const started = Date.now();

  const result: AgentMailProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  try {
    // Probe by listing inboxes (minimal call)
    const inboxRes = await fetchWithTimeout(
      `${AGENTMAIL_API_BASE}/inboxes?limit=1`,
      timeoutMs,
      { headers },
    );

    if (!inboxRes.ok) {
      result.status = inboxRes.status;
      const body = await inboxRes.text().catch(() => "");
      result.error = body || `API returned ${inboxRes.status}`;
      return { ...result, elapsedMs: Date.now() - started };
    }

    const inboxJson = (await inboxRes.json()) as {
      inboxes?: Array<unknown>;
    };

    result.account = {
      inboxCount: inboxJson.inboxes?.length ?? null,
    };

    // Optionally probe webhooks
    try {
      const webhookRes = await fetchWithTimeout(
        `${AGENTMAIL_API_BASE}/webhooks?limit=1`,
        timeoutMs,
        { headers },
      );
      if (webhookRes.ok) {
        const webhookJson = (await webhookRes.json()) as {
          webhooks?: Array<{ webhook_id?: string; url?: string }>;
        };
        const first = webhookJson.webhooks?.[0];
        if (first) {
          result.webhook = {
            id: first.webhook_id ?? null,
            url: first.url ?? null,
          };
        }
      }
    } catch {
      // Ignore webhook probe errors
    }

    result.ok = true;
    result.status = null;
    result.error = null;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      status: err instanceof Response ? err.status : result.status,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}
