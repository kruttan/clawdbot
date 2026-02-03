import fs from "node:fs";

import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { AgentMailAccountConfig } from "./types.js";

export type AgentMailTokenSource = "env" | "tokenFile" | "config" | "none";

export type AgentMailTokenResolution = {
  token: string;
  source: AgentMailTokenSource;
};

type ResolveAgentMailTokenOpts = {
  envToken?: string | null;
  logMissingFile?: (message: string) => void;
};

export function resolveAgentMailToken(
  cfg?: OpenClawConfig,
  opts: ResolveAgentMailTokenOpts = {},
): AgentMailTokenResolution {
  const envToken = (opts.envToken ?? process.env.AGENTMAIL_API_KEY)?.trim();
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  const agentmailCfg = (cfg?.channels as Record<string, unknown> | undefined)?.agentmail as
    | AgentMailAccountConfig
    | undefined;

  const tokenFile = agentmailCfg?.tokenFile?.trim();
  if (tokenFile) {
    if (!fs.existsSync(tokenFile)) {
      opts.logMissingFile?.(`agentmail.tokenFile not found: ${tokenFile}`);
      return { token: "", source: "none" };
    }
    try {
      const token = fs.readFileSync(tokenFile, "utf-8").trim();
      if (token) {
        return { token, source: "tokenFile" };
      }
    } catch (err) {
      opts.logMissingFile?.(`agentmail.tokenFile read failed: ${String(err)}`);
      return { token: "", source: "none" };
    }
    return { token: "", source: "none" };
  }

  const configToken = agentmailCfg?.apiKey?.trim();
  if (configToken) {
    return { token: configToken, source: "config" };
  }

  return { token: "", source: "none" };
}
