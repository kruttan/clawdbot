import type { ClawdbotConfig } from "../config/config.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;
// Email is more "fire and forget" - default to 30 minutes
const DEFAULT_AGENTMAIL_TIMEOUT_SECONDS = 1800;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.floor(value)
    : undefined;

/**
 * Resolve timeout for a specific surface, falling back to global config.
 */
function resolveSurfaceTimeoutSeconds(
  cfg?: ClawdbotConfig,
  surface?: string,
): number | undefined {
  if (!surface) return undefined;
  const normalized = surface.trim().toLowerCase();
  if (normalized === "agentmail" || normalized === "email") {
    return normalizeNumber(cfg?.agentmail?.timeoutSeconds);
  }
  // Add other surfaces here as needed
  return undefined;
}

/**
 * Get the default timeout for a surface (before global config).
 */
function getDefaultTimeoutForSurface(surface?: string): number {
  if (!surface) return DEFAULT_AGENT_TIMEOUT_SECONDS;
  const normalized = surface.trim().toLowerCase();
  if (normalized === "agentmail" || normalized === "email") {
    return DEFAULT_AGENTMAIL_TIMEOUT_SECONDS;
  }
  return DEFAULT_AGENT_TIMEOUT_SECONDS;
}

export function resolveAgentTimeoutSeconds(
  cfg?: ClawdbotConfig,
  surface?: string,
): number {
  // Surface-specific config takes priority
  const surfaceTimeout = resolveSurfaceTimeoutSeconds(cfg, surface);
  if (surfaceTimeout !== undefined && surfaceTimeout > 0) {
    return Math.max(surfaceTimeout, 1);
  }
  // Then global config
  const raw = normalizeNumber(cfg?.agent?.timeoutSeconds);
  if (raw !== undefined) {
    return Math.max(raw, 1);
  }
  // Then surface-specific default
  return getDefaultTimeoutForSurface(surface);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: ClawdbotConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
  surface?: string;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const defaultMs = resolveAgentTimeoutSeconds(opts.cfg, opts.surface) * 1000;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs <= 0) return defaultMs;
    return Math.max(overrideMs, minMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds <= 0) return defaultMs;
    return Math.max(overrideSeconds * 1000, minMs);
  }
  return Math.max(defaultMs, minMs);
}
