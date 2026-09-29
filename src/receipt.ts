import { createHash } from "node:crypto";
import type { GateAction, GateAnswers, ProviderName } from "./types";

/** HCS accepts up to 1024 bytes in a single-chunk message. */
export const MAX_RECEIPT_BYTES = 1024;
export const RECEIPT_VERSION = 1;

export type Decision = "executed" | "blocked";

/** One HCS message per gate decision. Never holds keys or raw instruction text. */
export interface GateReceipt {
  v: number;
  ts: string;
  network: string;
  accountId: string | null;
  tool: string;
  paramsHash: string;
  /** sha256 of the user's instruction, or null when none was supplied. */
  intentHash: string | null;
  provider: ProviderName;
  model: string;
  answers: {
    action: GateAction;
    p: Record<GateAction, number>;
    slippage_ok: number;
    intent_match: number;
  } | null;
  decision: Decision;
  reason: string;
  latencyMs: number;
  txId?: string;
  txStatus?: string;
}

/** JSON with object keys sorted at every level, so equal params always hash the same. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
};

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input, "utf8").digest("hex");

export const hashParams = (params: unknown): string => sha256Hex(canonicalJson(params));

const round = (p: number) => Math.round(p * 1000) / 1000;

export const compactAnswers = (answers: GateAnswers): GateReceipt["answers"] => ({
  action: answers.action.choice,
  p: {
    execute: round(answers.action.probabilities.execute),
    wait: round(answers.action.probabilities.wait),
    abort: round(answers.action.probabilities.abort),
  },
  slippage_ok: round(answers.slippage_ok),
  intent_match: round(answers.intent_match),
});

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Serialize a receipt to compact JSON under MAX_RECEIPT_BYTES.
 * If it is too large, the free-text `reason` is truncated; every other field is kept.
 */
export const serializeReceipt = (receipt: GateReceipt): string => {
  let json = JSON.stringify(receipt);
  if (byteLength(json) <= MAX_RECEIPT_BYTES) {
    return json;
  }
  const overflow = byteLength(json) - MAX_RECEIPT_BYTES;
  const keep = Math.max(0, receipt.reason.length - overflow - 3);
  json = JSON.stringify({ ...receipt, reason: `${receipt.reason.slice(0, keep)}...` });
  if (byteLength(json) > MAX_RECEIPT_BYTES) {
    throw new Error(
      `Gate receipt is ${byteLength(json)} bytes, over the ${MAX_RECEIPT_BYTES} byte HCS limit.`,
    );
  }
  return json;
};
