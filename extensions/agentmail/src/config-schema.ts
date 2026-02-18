import { DmPolicySchema, requireOpenAllowFrom } from "openclaw/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

export const AgentMailConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    apiKey: z.string().optional(),
    tokenFile: z.string().optional(),
    defaultInboxId: z.string().optional(),
    allowFrom: z.array(allowFromEntry).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    webhookPath: z.string().optional(),
    webhookPort: z.number().int().positive().optional(),
    webhookUrl: z.string().optional(),
    webhookSecret: z.string().optional(),
    webhookSecretHeader: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
    thinkingDefault: z.enum(["off", "minimal", "low", "medium", "high"]).optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
  })
  .superRefine((value, ctx) => {
    requireOpenAllowFrom({
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      path: ["allowFrom"],
      message:
        'channels.agentmail.dmPolicy="open" requires channels.agentmail.allowFrom to include "*"',
    });
  });
