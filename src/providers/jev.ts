import { SWAP_QUESTIONS } from "../questions";
import {
  ACTIONS,
  type GateAction,
  type GateAnswers,
  type GateProvider,
  type ProviderResult,
  type SwapGateState,
} from "../types";

export interface JevProviderOptions {
  apiKey: string;
  /** Model or alias. Pin a versioned id (e.g. `jev-1.13.0`) if you tuned the threshold against it. */
  model?: string;
  baseUrl?: string;
  /** Injected for tests. Defaults to the global `fetch` (Node 20+). */
  fetch?: typeof fetch;
}

const isProbability = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

const readNoul = (answers: Record<string, unknown>, id: string): number => {
  const answer = answers[id] as { type?: string; noul?: unknown } | undefined;
  if (answer?.type !== "noul" || !isProbability(answer.noul)) {
    throw new Error(`Jev response has no valid noul answer for "${id}".`);
  }
  return answer.noul;
};

const readAction = (answers: Record<string, unknown>): GateAnswers["action"] => {
  const answer = answers.action as
    | { type?: string; choice?: unknown; probabilities?: Record<string, unknown> }
    | undefined;
  if (answer?.type !== "choice" || !answer.probabilities) {
    throw new Error('Jev response has no valid choice answer for "action".');
  }
  const probabilities = {} as Record<GateAction, number>;
  for (const option of ACTIONS) {
    const p = answer.probabilities[option];
    probabilities[option] = isProbability(p) ? p : 0;
  }
  const choice = ACTIONS.includes(answer.choice as GateAction)
    ? (answer.choice as GateAction)
    : "abort";
  return { choice, probabilities };
};

/** Calls TypeSafe's System One endpoint (`POST /v1/systemone`) with the fixed swap questions. */
export class JevProvider implements GateProvider {
  readonly name = "jev" as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: JevProviderOptions) {
    if (!options.apiKey) {
      throw new Error("JevProvider requires a TypeSafe API key.");
    }
    this.apiKey = options.apiKey;
    this.model = options.model ?? "jev-latest";
    this.baseUrl = (options.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  async evaluate(
    state: SwapGateState,
    { signal }: { signal: AbortSignal },
  ): Promise<ProviderResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: this.model, questions: SWAP_QUESTIONS }),
      signal,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `TypeSafe API returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }

    const body = (await response.json()) as { model?: unknown; answers?: Record<string, unknown> };
    if (!body.answers || typeof body.answers !== "object") {
      throw new Error("TypeSafe API response has no answers.");
    }

    return {
      model: typeof body.model === "string" ? body.model : this.model,
      answers: {
        action: readAction(body.answers),
        slippage_ok: readNoul(body.answers, "slippage_ok"),
        intent_match: readNoul(body.answers, "intent_match"),
      },
    };
  }
}
