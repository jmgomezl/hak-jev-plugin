import type { FailMode } from "./types";

export interface RulesConfig {
  /** Highest slippage tolerance allowed, in basis points. 100 bps = 1%. */
  maxSlippageBps: number;
  /** Highest price impact allowed, in percent. */
  maxPriceImpactPercent: number;
  /** Largest input amount allowed, in whole token units. */
  maxAmount: number;
  /** When non-empty, both tokens must be in this list (ids or symbols, case-insensitive). */
  tokenAllowlist: string[];
}

export interface GateConfig {
  network: "testnet";
  threshold: number;
  timeoutMs: number;
  failMode: FailMode;
  topicId?: string;
  typesafeApiKey?: string;
  jevModel: string;
  jevBaseUrl: string;
  rules: RulesConfig;
}

export const DEFAULT_RULES: RulesConfig = {
  maxSlippageBps: 100,
  maxPriceImpactPercent: 5,
  maxAmount: 1000,
  tokenAllowlist: [],
};

export const DEFAULT_CONFIG: Omit<GateConfig, "topicId" | "typesafeApiKey"> = {
  network: "testnet",
  threshold: 0.7,
  timeoutMs: 2000,
  failMode: "block",
  jevModel: "jev-latest",
  jevBaseUrl: "https://api.typesafe.ai",
  rules: DEFAULT_RULES,
};

export type GateConfigInput = Partial<Omit<GateConfig, "rules" | "network">> & {
  rules?: Partial<RulesConfig>;
};

const readNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readFailMode = (value: string | undefined): FailMode | undefined => {
  if (value === "block" || value === "allow") {
    return value;
  }
  return undefined;
};

/**
 * Merge explicit options over env vars over defaults.
 * v0 is testnet only: any other HEDERA_NETWORK value is rejected.
 */
export const resolveGateConfig = (
  input: GateConfigInput = {},
  env: NodeJS.ProcessEnv = process.env,
): GateConfig => {
  const network = env.HEDERA_NETWORK ?? "testnet";
  if (network !== "testnet") {
    throw new Error(`hak-jev-plugin v0 is testnet only (HEDERA_NETWORK=${network}).`);
  }

  const threshold = input.threshold ?? readNumber(env.GATE_THRESHOLD) ?? DEFAULT_CONFIG.threshold;
  if (threshold < 0 || threshold > 1) {
    throw new Error(`GATE_THRESHOLD must be between 0 and 1 (got ${threshold}).`);
  }

  const timeoutMs = input.timeoutMs ?? readNumber(env.GATE_TIMEOUT_MS) ?? DEFAULT_CONFIG.timeoutMs;
  if (timeoutMs <= 0) {
    throw new Error(`GATE_TIMEOUT_MS must be positive (got ${timeoutMs}).`);
  }

  return {
    network: "testnet",
    threshold,
    timeoutMs,
    failMode: input.failMode ?? readFailMode(env.GATE_FAIL_MODE) ?? DEFAULT_CONFIG.failMode,
    topicId: input.topicId ?? (env.HCS_TOPIC_ID || undefined),
    typesafeApiKey: input.typesafeApiKey ?? (env.TYPESAFE_API_KEY || undefined),
    jevModel: input.jevModel ?? DEFAULT_CONFIG.jevModel,
    jevBaseUrl: input.jevBaseUrl ?? DEFAULT_CONFIG.jevBaseUrl,
    rules: { ...DEFAULT_RULES, ...input.rules },
  };
};
