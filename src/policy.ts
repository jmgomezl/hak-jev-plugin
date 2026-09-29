import {
  AbstractPolicy,
  type PostCoreActionParams,
  type PostSecondaryActionParams,
} from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { type GateConfig, type GateConfigInput, resolveGateConfig } from "./config";
import { decide } from "./decide";
import { HcsReceiptSink, type PublishedReceipt, type ReceiptSink } from "./hcs";
import { JevProvider } from "./providers/jev";
import { RulesProvider } from "./providers/rules";
import {
  type Decision,
  type GateReceipt,
  RECEIPT_VERSION,
  compactAnswers,
  hashParams,
  serializeReceipt,
  sha256Hex,
} from "./receipt";
import type { GateAnswers, GateProvider, GateVerdict, SwapGateState } from "./types";

/** Method name of the swap tool in hak-saucerswap-plugin. */
export const SAUCERSWAP_SWAP_TOOL = "saucerswap_swap_tokens";

export interface GateDecisionEvent {
  receipt: GateReceipt;
  /** Where the receipt landed, or null if no sink is configured or publishing failed. */
  published: PublishedReceipt | null;
  publishError?: string;
}

export interface JevGatePolicyOptions extends GateConfigInput {
  /** Tools to gate. v0 understands the SaucerSwap swap tool only. */
  relevantTools?: string[];
  /** Override provider selection (Jev when a key is set, rules otherwise). */
  provider?: GateProvider;
  /** Where receipts go. Defaults to HCS when a topic id is configured. */
  sink?: ReceiptSink;
  /** Dedicated client for HCS receipts. Defaults to the agent's client. */
  loggingClient?: Client;
  /** The user's original instruction. A string or a getter called at decision time. */
  intent?: string | (() => string | undefined | null);
  /** Called after every decision, after the receipt was published (or failed to). */
  onDecision?: (event: GateDecisionEvent) => void;
}

/** Thrown to stop the tool. HAK turns it into an error result the agent can read. */
export class GateBlockedError extends Error {
  constructor(tool: string, reason: string) {
    super(`JevGate blocked ${tool}: ${reason}`);
    this.name = "GateBlockedError";
  }
}

interface SwapPayloadExtras {
  estimatedOutput?: unknown;
  minOutput?: unknown;
  priceImpact?: unknown;
  route?: unknown;
}

interface PendingDecision {
  receipt: Omit<GateReceipt, "decision">;
}

const isSwapPayload = (
  value: unknown,
): value is { transaction: unknown; extras?: SwapPayloadExtras } =>
  typeof value === "object" && value !== null && "transaction" in value;

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : null;

const withTimeout = async <T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`provider timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * HAK policy that asks a GateProvider (Jev or rules) whether a swap should run,
 * blocks it when the answers fall below the threshold, and writes one HCS receipt
 * per decision.
 *
 * It runs at the post-core-action stage: the swap transaction is built and the
 * quote is known, but nothing has been signed or submitted yet.
 */
export class JevGatePolicy extends AbstractPolicy {
  name = "JevGatePolicy";
  description = "AI decision gate: Jev judges, HAK executes, HCS notarizes";
  relevantTools: string[];

  readonly config: GateConfig;
  readonly provider: GateProvider;
  private readonly sink?: ReceiptSink;
  private intent: JevGatePolicyOptions["intent"];
  private readonly onDecision?: (event: GateDecisionEvent) => void;
  private readonly pending = new Map<string, PendingDecision[]>();

  constructor(options: JevGatePolicyOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    super();
    this.config = resolveGateConfig(options, env);
    this.relevantTools = options.relevantTools ?? [SAUCERSWAP_SWAP_TOOL];
    this.provider =
      options.provider ??
      (this.config.typesafeApiKey
        ? new JevProvider({
            apiKey: this.config.typesafeApiKey,
            model: this.config.jevModel,
            baseUrl: this.config.jevBaseUrl,
          })
        : new RulesProvider(this.config.rules));
    this.sink =
      options.sink ??
      (this.config.topicId
        ? new HcsReceiptSink(this.config.topicId, options.loggingClient)
        : undefined);
    this.intent = options.intent;
    this.onDecision = options.onDecision;
  }

  /** Set the user's instruction for the next gated call(s). */
  setIntent(intent: JevGatePolicyOptions["intent"]): void {
    this.intent = intent;
  }

  private readIntent(): string | null {
    const value = typeof this.intent === "function" ? this.intent() : this.intent;
    return value ? value : null;
  }

  protected override async shouldBlockPostCoreAction(
    params: PostCoreActionParams,
    method: string,
  ): Promise<boolean> {
    // The tool failed before building a transaction, so nothing can execute. Nothing to gate.
    if (!isSwapPayload(params.coreActionResult)) {
      return false;
    }

    const userInstruction = this.readIntent();
    const state = buildSwapState(
      method,
      params.normalisedParams,
      params.coreActionResult.extras,
      userInstruction,
    );

    const started = Date.now();
    let model = this.provider.name === "jev" ? this.config.jevModel : "rules-v0";
    let answers: GateAnswers | null = null;
    let verdict: GateVerdict;
    try {
      const result = await withTimeout(
        (signal) => this.provider.evaluate(state, { signal }),
        this.config.timeoutMs,
      );
      model = result.model;
      answers = result.answers;
      verdict = decide(result.answers, this.config.threshold);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      verdict =
        this.config.failMode === "block"
          ? { allow: false, reason: `fail closed: ${message}` }
          : { allow: true, reason: `fail open: ${message}` };
    }
    const latencyMs = Date.now() - started;

    const base: Omit<GateReceipt, "decision"> = {
      v: RECEIPT_VERSION,
      ts: new Date().toISOString(),
      network: this.config.network,
      accountId: params.client?.operatorAccountId?.toString() ?? params.context?.accountId ?? null,
      tool: method,
      paramsHash: hashParams(state.params),
      intentHash: userInstruction ? sha256Hex(userInstruction) : null,
      provider: this.provider.name,
      model,
      answers: answers ? compactAnswers(answers) : null,
      reason: verdict.reason,
      latencyMs,
    };

    if (!verdict.allow) {
      await this.emit({ ...base, decision: "blocked" }, params.client);
      throw new GateBlockedError(method, verdict.reason);
    }

    const queue = this.pending.get(base.paramsHash) ?? [];
    queue.push({ receipt: base });
    this.pending.set(base.paramsHash, queue);
    return false;
  }

  protected override async shouldBlockPostSecondaryAction(
    params: PostSecondaryActionParams,
    method: string,
  ): Promise<boolean> {
    const state = buildSwapState(method, params.normalisedParams, undefined, null);
    const key = hashParams(state.params);
    const pending = this.pending.get(key)?.shift();
    if (!pending) {
      return false;
    }
    if (this.pending.get(key)?.length === 0) {
      this.pending.delete(key);
    }

    const raw = (
      params.toolResult as { raw?: { transactionId?: unknown; status?: unknown } } | undefined
    )?.raw;
    const decision: Decision = "executed";
    await this.emit(
      {
        ...pending.receipt,
        decision,
        txId: str(raw?.transactionId) ?? undefined,
        txStatus: str(raw?.status) ?? undefined,
      },
      params.client,
    );
    return false;
  }

  private async emit(receipt: GateReceipt, client: Client): Promise<void> {
    let published: PublishedReceipt | null = null;
    let publishError: string | undefined;
    if (this.sink) {
      try {
        published = await this.sink.publish(serializeReceipt(receipt), client);
      } catch (error) {
        // Same stance as HAK's HcsAuditTrailHook: a failed receipt is logged, not fatal.
        publishError = error instanceof Error ? error.message : String(error);
        console.error(`[JevGatePolicy] failed to publish receipt: ${publishError}`);
      }
    }
    this.onDecision?.({ receipt, published, publishError });
  }
}

/** Shape the tool's params and quote into the state sent to the provider. */
export const buildSwapState = (
  tool: string,
  normalisedParams: unknown,
  extras: SwapPayloadExtras | undefined,
  userInstruction: string | null,
): SwapGateState => {
  const p = (normalisedParams ?? {}) as Record<string, unknown>;
  const impact = extras?.priceImpact;
  return {
    tool,
    params: {
      fromToken: str(p.fromToken) ?? "",
      toToken: str(p.toToken) ?? "",
      amount: str(p.amount) ?? "",
      slippageTolerancePercent: typeof p.slippageTolerance === "number" ? p.slippageTolerance : 0.5,
    },
    quote: {
      estimatedOutput: str(extras?.estimatedOutput),
      minOutput: str(extras?.minOutput),
      priceImpactPercent: typeof impact === "number" && Number.isFinite(impact) ? impact : null,
      route: Array.isArray(extras?.route) ? extras.route.map(String) : [],
    },
    userInstruction,
  };
};
