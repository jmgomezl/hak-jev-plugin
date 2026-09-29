/** Options for the `action` Choice question. */
export const ACTIONS = ["execute", "wait", "abort"] as const;
export type GateAction = (typeof ACTIONS)[number];

/** What the gate knows about a pending swap. This is what gets sent to a provider. */
export interface SwapGateState {
  tool: string;
  params: {
    fromToken: string;
    toToken: string;
    amount: string;
    slippageTolerancePercent: number;
  };
  /** Pool snapshot taken from the quote the swap tool built. */
  quote: {
    estimatedOutput: string | null;
    minOutput: string | null;
    priceImpactPercent: number | null;
    route: string[];
  };
  /** The user's original instruction, when the app supplies one. */
  userInstruction: string | null;
}

/** Typed answers every provider must return. Probabilities are in [0, 1]. */
export interface GateAnswers {
  action: {
    choice: GateAction;
    probabilities: Record<GateAction, number>;
  };
  /** Probability that the expected slippage is acceptable. */
  slippage_ok: number;
  /** Probability that the call matches the user's stated intent. */
  intent_match: number;
}

export type ProviderName = "jev" | "rules";

export interface ProviderResult {
  /** Model id that answered, e.g. `jev-1.13.0` or `rules-v0`. */
  model: string;
  answers: GateAnswers;
}

export interface GateProvider {
  readonly name: ProviderName;
  evaluate(state: SwapGateState, options: { signal: AbortSignal }): Promise<ProviderResult>;
}

export type FailMode = "block" | "allow";

export interface GateVerdict {
  allow: boolean;
  reason: string;
}
