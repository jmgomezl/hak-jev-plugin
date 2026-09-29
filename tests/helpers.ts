import { BaseTool, type Context } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { z } from "zod";
import type { PublishedReceipt, ReceiptSink } from "../src/hcs";
import type { GateAnswers, GateProvider, ProviderResult, SwapGateState } from "../src/types";

const schema = z.object({
  fromToken: z.string(),
  toToken: z.string(),
  amount: z.string(),
  slippageTolerance: z.number().optional().default(0.5),
});
type Params = z.infer<typeof schema>;

/** Stand-in for SaucerSwap's SwapTool: same method name and core payload shape. */
export class FakeSwapTool extends BaseTool<Params, Params> {
  method = "saucerswap_swap_tokens";
  name = "Fake Swap";
  description = "test double";
  parameters = schema;
  submitted = 0;

  async normalizeParams(params: Params) {
    return schema.parse(params);
  }
  async coreAction() {
    return {
      transaction: {},
      extras: { estimatedOutput: "12.5", minOutput: "1243", priceImpact: 0.2, route: ["A", "B"] },
    };
  }
  override async secondaryAction() {
    this.submitted += 1;
    return {
      raw: { status: "SUCCESS", transactionId: "0.0.1234@1700000000.000000001" },
      humanMessage: "swapped",
    };
  }
}

export const fakeClient = {
  operatorAccountId: { toString: () => "0.0.1234" },
} as unknown as Client;

export const contextWith = (hooks: Context["hooks"]): Context => ({ hooks }) as Context;

export class MemorySink implements ReceiptSink {
  messages: string[] = [];
  async publish(message: string): Promise<PublishedReceipt> {
    this.messages.push(message);
    return {
      topicId: "0.0.999",
      sequenceNumber: String(this.messages.length),
      transactionId: "tx",
    };
  }
}

export const answers = (pExecute: number, slippage: number, intent: number): GateAnswers => ({
  action: {
    choice: pExecute >= 0.5 ? "execute" : "abort",
    probabilities: { execute: pExecute, wait: 0, abort: 1 - pExecute },
  },
  slippage_ok: slippage,
  intent_match: intent,
});

export class MockProvider implements GateProvider {
  readonly name = "jev" as const;
  calls: SwapGateState[] = [];
  constructor(private readonly respond: (signal: AbortSignal) => Promise<ProviderResult>) {}
  async evaluate(state: SwapGateState, { signal }: { signal: AbortSignal }) {
    this.calls.push(state);
    return this.respond(signal);
  }
}

export const swapParams = {
  fromToken: "HBAR",
  toToken: "SAUCE",
  amount: "10",
  slippageTolerance: 0.5,
};

/** Env with nothing set, so tests never pick up a real .env. */
export const emptyEnv = {} as NodeJS.ProcessEnv;
