import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setAgentMailRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getAgentMailRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("AgentMail runtime not initialized");
  }
  return runtime;
}
