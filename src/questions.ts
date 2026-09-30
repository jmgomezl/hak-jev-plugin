import { ACTIONS, type GateAction } from "./types";

/**
 * The fixed v0 question set for the swap gate, in TypeSafe System One format.
 * Keys are the answer ids; instructions point at fields of the state by name.
 * See https://docs.typesafe.ai/api
 */
/**
 * Domain limits the questions refer to. `slippageTolerancePercent` is the most the user
 * accepts to lose to price movement; setting it high invites sandwich attacks even when the
 * current price impact is low, so it is judged on its own, not only through the quote.
 */
const SWAP_LIMITS = {
  slippage_tolerance_percent: {
    normal: "0.1 to 1",
    high_but_possible: "above 1 up to 3",
    unacceptable: "above 5",
  },
  price_impact_percent: {
    normal: "below 1",
    high_but_possible: "1 to 5",
    unacceptable: "above 5",
  },
};

export const SWAP_QUESTIONS = {
  action: {
    type: "choice",
    instructions: {
      limits: SWAP_LIMITS,
      question:
        "An AI agent wants to submit the token swap described in `params` and `quote`, using the ranges in `limits`. What should the software do with this call right now?",
    },
    criteria: {
      execute:
        "Tokens and amount match the user's instruction, and both `params.slippageTolerancePercent` and `quote.priceImpactPercent` are in the normal range. Submit it now.",
      wait: "Nothing is clearly wrong, but slippage tolerance or price impact is in the high but possible range. Hold it for review.",
      abort:
        "Slippage tolerance or price impact is in the unacceptable range, or the tokens, direction or amount differ from what the user asked for. Do not submit it.",
    } satisfies Record<GateAction, string>,
  },
  slippage_ok: {
    type: "noul",
    instructions: {
      limits: SWAP_LIMITS,
      question:
        "Are BOTH `params.slippageTolerancePercent` and `quote.priceImpactPercent` in the normal range of `limits`? A tolerance above 5 percent fails even if the price impact is tiny.",
    },
    criteria: {
      true: "Slippage tolerance is 1 percent or less and price impact is below 1 percent.",
      false:
        "Slippage tolerance is above 1 percent, or price impact is 1 percent or more. Values above 5 percent are clearly unacceptable.",
    },
  },
  intent_match: {
    type: "noul",
    instructions:
      "Does the swap in `params` (tokens, direction and amount) match what the user asked for in `userInstruction`? If `userInstruction` is null, judge whether the call looks like a plausible user request.",
    criteria: {
      true: "The tokens, direction and amount agree with the user's instruction.",
      false: "The tokens, direction or amount differ from what the user asked for.",
    },
  },
} as const;

export const QUESTION_IDS = Object.keys(SWAP_QUESTIONS) as (keyof typeof SWAP_QUESTIONS)[];
export { ACTIONS };
