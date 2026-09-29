import { DEFAULT_RULES, type RulesConfig } from "../config";
import type { GateProvider, ProviderResult, SwapGateState } from "../types";

/**
 * Deterministic fallback provider. Used when TYPESAFE_API_KEY is missing and as the
 * baseline to compare Jev against. Answers are always 0 or 1.
 *
 * It cannot read natural language, so `intent_match` only checks that both tokens
 * of the swap appear in the user's instruction. With no instruction it answers 1.
 */
export class RulesProvider implements GateProvider {
  readonly name = "rules" as const;
  readonly rules: RulesConfig;

  constructor(rules: Partial<RulesConfig> = {}) {
    this.rules = { ...DEFAULT_RULES, ...rules };
  }

  async evaluate(state: SwapGateState): Promise<ProviderResult> {
    const { params, quote } = state;
    const failures: string[] = [];

    const slippageBps = Math.round(params.slippageTolerancePercent * 100);
    const impact = quote.priceImpactPercent;
    const slippageOk =
      slippageBps <= this.rules.maxSlippageBps &&
      (impact === null || Math.abs(impact) <= this.rules.maxPriceImpactPercent);
    if (!slippageOk) {
      failures.push("slippage");
    }

    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > this.rules.maxAmount) {
      failures.push("amount");
    }

    const allowlist = this.rules.tokenAllowlist.map((t) => t.toLowerCase());
    if (
      allowlist.length > 0 &&
      !(
        allowlist.includes(params.fromToken.toLowerCase()) &&
        allowlist.includes(params.toToken.toLowerCase())
      )
    ) {
      failures.push("allowlist");
    }

    const intentMatch = matchesIntent(state);
    if (!intentMatch) {
      failures.push("intent");
    }

    const execute = failures.length === 0;
    return {
      model: "rules-v0",
      answers: {
        action: {
          choice: execute ? "execute" : "abort",
          probabilities: { execute: execute ? 1 : 0, wait: 0, abort: execute ? 0 : 1 },
        },
        slippage_ok: slippageOk ? 1 : 0,
        intent_match: intentMatch ? 1 : 0,
      },
    };
  }
}

const matchesIntent = (state: SwapGateState): boolean => {
  const text = state.userInstruction?.toLowerCase();
  if (!text) {
    return true;
  }
  const mentions = (token: string) => text.includes(token.toLowerCase());
  return mentions(state.params.fromToken) && mentions(state.params.toToken);
};
