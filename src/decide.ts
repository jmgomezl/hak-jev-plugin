import type { GateAnswers, GateVerdict } from "./types";

const fmt = (p: number) => p.toFixed(2);

/**
 * Execute only if P(execute) and both yes/no probabilities reach the threshold.
 * The reason lists every check that failed so the agent can explain the block.
 */
export const decide = (answers: GateAnswers, threshold: number): GateVerdict => {
  const failed: string[] = [];
  const pExecute = answers.action.probabilities.execute;

  if (pExecute < threshold) {
    failed.push(`P(execute)=${fmt(pExecute)} (model chose ${answers.action.choice})`);
  }
  if (answers.slippage_ok < threshold) {
    failed.push(`P(slippage_ok)=${fmt(answers.slippage_ok)}`);
  }
  if (answers.intent_match < threshold) {
    failed.push(`P(intent_match)=${fmt(answers.intent_match)}`);
  }

  if (failed.length === 0) {
    return { allow: true, reason: `all checks >= ${threshold}` };
  }
  return { allow: false, reason: `below threshold ${threshold}: ${failed.join(", ")}` };
};
