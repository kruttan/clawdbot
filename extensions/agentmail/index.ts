import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { agentmailPlugin } from "./src/channel.js";
import { setAgentMailRuntime } from "./src/runtime.js";

const plugin = {
  id: "agentmail",
  name: "AgentMail",
  description: "AgentMail email channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setAgentMailRuntime(api.runtime);
    api.registerChannel({ plugin: agentmailPlugin });
  },
};

export default plugin;
