import { ACTIONS, type GateAction } from "./types";

/**
 * The fixed v0 question set for the swap gate, in TypeSafe System One format.
 * Keys are the answer ids; instructions point at fields of the state by name.
 * See https://docs.typesafe.ai/api
 */
export const SWAP_QUESTIONS = {
  action: {
    type: "choice",
    instructions:
      "An AI agent wants to submit the token swap described in `params` and `quote`. What should the software do with this call right now?",
    criteria: {
      execute: "The swap is reasonable for its size, slippage and price impact. Submit it now.",
      wait: "The swap may be fine but conditions look unfavorable. Hold it for later or for more information.",
      abort:
        "The swap is unsafe, unreasonable, or does not match what the user asked for. Do not submit it.",
    } satisfies Record<GateAction, string>,
  },
  slippage_ok: {
    type: "noul",
    instructions:
      "Given `params.slippageTolerancePercent`, `quote.priceImpactPercent` and the trade size in `params.amount`, is the expected slippage acceptable for this swap?",
    criteria: {
      true: "Slippage tolerance and price impact are within normal ranges for a swap of this size.",
      false:
        "Slippage tolerance or price impact is unusually high and could lose the user a meaningful share of value.",
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
