import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

export interface AgentMailAccountConfig {
  enabled?: boolean;
  name?: string;
  apiKey?: string;
  tokenFile?: string;
  defaultInboxId?: string;
  allowFrom?: string[];
  textChunkLimit?: number;
  webhookPath?: string;
  webhookPort?: number;
  webhookUrl?: string;
  webhookSecret?: string;
  timeoutSeconds?: number;
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high";
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
}

export interface ResolvedAgentMailAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  hasToken: boolean;
  defaultInboxId?: string;
  config: AgentMailAccountConfig;
}

const DEFAULT_ACCOUNT_ID = "default";

export function listAgentMailAccountIds(cfg: ClawdbotConfig): string[] {
  const agentmailCfg = (cfg.channels as Record<string, unknown> | undefined)?.agentmail as
    | AgentMailAccountConfig
    | undefined;

  // If apiKey or tokenFile is configured, we have a default account
  if (agentmailCfg?.apiKey || agentmailCfg?.tokenFile) {
    return [DEFAULT_ACCOUNT_ID];
  }

  // Also check env var
  if (process.env.AGENTMAIL_API_KEY) {
    return [DEFAULT_ACCOUNT_ID];
  }

  return [];
}

export function resolveDefaultAgentMailAccountId(cfg: ClawdbotConfig): string {
  const ids = listAgentMailAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveAgentMailAccount(opts: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedAgentMailAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const agentmailCfg = (opts.cfg.channels as Record<string, unknown> | undefined)?.agentmail as
    | AgentMailAccountConfig
    | undefined;

  const baseEnabled = agentmailCfg?.enabled !== false;
  const hasApiKey = Boolean(agentmailCfg?.apiKey?.trim());
  const hasTokenFile = Boolean(agentmailCfg?.tokenFile?.trim());
  const hasEnvKey = Boolean(process.env.AGENTMAIL_API_KEY?.trim());
  const hasToken = hasApiKey || hasTokenFile || hasEnvKey;
  const configured = hasToken;

  return {
    accountId,
    name: agentmailCfg?.name?.trim() || undefined,
    enabled: baseEnabled,
    configured,
    hasToken,
    defaultInboxId: agentmailCfg?.defaultInboxId?.trim() || undefined,
    config: {
      enabled: agentmailCfg?.enabled,
      name: agentmailCfg?.name,
      apiKey: agentmailCfg?.apiKey,
      tokenFile: agentmailCfg?.tokenFile,
      defaultInboxId: agentmailCfg?.defaultInboxId,
      allowFrom: agentmailCfg?.allowFrom,
      textChunkLimit: agentmailCfg?.textChunkLimit,
      webhookPath: agentmailCfg?.webhookPath,
      webhookPort: agentmailCfg?.webhookPort,
      webhookUrl: agentmailCfg?.webhookUrl,
      webhookSecret: agentmailCfg?.webhookSecret,
      timeoutSeconds: agentmailCfg?.timeoutSeconds,
      thinkingDefault: agentmailCfg?.thinkingDefault,
      dmPolicy: agentmailCfg?.dmPolicy,
    },
  };
}
