import { describe, expect, it } from "vitest";
import { decide } from "../src/decide";
import { JevProvider } from "../src/providers/jev";
import { RulesProvider } from "../src/providers/rules";
import {
  type GateReceipt,
  MAX_RECEIPT_BYTES,
  canonicalJson,
  compactAnswers,
  hashParams,
  serializeReceipt,
} from "../src/receipt";
import type { SwapGateState } from "../src/types";
import { answers } from "./helpers";

const state: SwapGateState = {
  tool: "saucerswap_swap_tokens",
  params: { fromToken: "HBAR", toToken: "SAUCE", amount: "10", slippageTolerancePercent: 0.5 },
  quote: { estimatedOutput: "12.5", minOutput: "1243", priceImpactPercent: 0.2, route: [] },
  userInstruction: "swap 10 HBAR for SAUCE",
};

const receipt = (overrides: Partial<GateReceipt> = {}): GateReceipt => ({
  v: 1,
  ts: "2026-09-29T00:00:00.000Z",
  network: "testnet",
  accountId: "0.0.1234567",
  tool: "saucerswap_swap_tokens",
  paramsHash: "a".repeat(64),
  intentHash: "b".repeat(64),
  provider: "jev",
  model: "jev-1.13.0",
  answers: compactAnswers(answers(0.912345, 0.87654, 0.99999)),
  decision: "executed",
  reason: "all checks >= 0.7",
  latencyMs: 312,
  txId: "0.0.1234567@1700000000.123456789",
  txStatus: "SUCCESS",
  ...overrides,
});

describe("receipt", () => {
  it("fits in one HCS message with every field filled", () => {
    const json = serializeReceipt(receipt());
    expect(Buffer.byteLength(json)).toBeLessThan(MAX_RECEIPT_BYTES);
  });

  it("truncates a long reason instead of going over 1024 bytes", () => {
    const json = serializeReceipt(receipt({ reason: "x".repeat(5000) }));
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_RECEIPT_BYTES);
    expect(JSON.parse(json).reason.endsWith("...")).toBe(true);
    expect(JSON.parse(json).paramsHash).toBe("a".repeat(64));
  });

  it("hashes params canonically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
    expect(hashParams({ a: 1, b: 2 })).toBe(hashParams({ b: 2, a: 1 }));
  });

  it("rounds probabilities to 3 decimals", () => {
    expect(compactAnswers(answers(0.912345, 0.5, 0.5))?.p.execute).toBe(0.912);
  });
});

describe("decide", () => {
  it("passes at exactly the threshold", () => {
    expect(decide(answers(0.7, 0.7, 0.7), 0.7).allow).toBe(true);
  });

  it("lists every failing check", () => {
    const verdict = decide(answers(0.2, 0.9, 0.1), 0.7);
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toContain("P(execute)=0.20");
    expect(verdict.reason).toContain("P(intent_match)=0.10");
    expect(verdict.reason).not.toContain("slippage_ok");
  });
});

describe("RulesProvider", () => {
  const signal = new AbortController().signal;
  const rules = new RulesProvider();

  it("approves a sane swap", async () => {
    const { answers: a } = await rules.evaluate(state);
    expect(a.action.choice).toBe("execute");
    expect(decide(a, 0.7).allow).toBe(true);
  });

  it("rejects an amount over the limit", async () => {
    const { answers: a } = await rules.evaluate({
      ...state,
      params: { ...state.params, amount: "5000" },
    });
    expect(a.action.choice).toBe("abort");
    expect(a.slippage_ok).toBe(1);
  });

  it("rejects high price impact", async () => {
    const { answers: a } = await rules.evaluate({
      ...state,
      quote: { ...state.quote, priceImpactPercent: 12 },
    });
    expect(a.slippage_ok).toBe(0);
  });

  it("rejects tokens outside the allowlist", async () => {
    const strict = new RulesProvider({ tokenAllowlist: ["HBAR", "USDC"] });
    const { answers: a } = await strict.evaluate(state);
    expect(a.action.choice).toBe("abort");
  });

  it("flags a swap whose tokens are not in the instruction", async () => {
    const { answers: a } = await rules.evaluate({ ...state, userInstruction: "buy some USDC" });
    expect(a.intent_match).toBe(0);
    expect(signal.aborted).toBe(false);
  });
});

describe("JevProvider", () => {
  it("sends the documented request and maps the typed answers", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetchMock = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: {
            action: {
              type: "choice",
              choice: "execute",
              probabilities: { execute: 0.9, wait: 0.07, abort: 0.03 },
              confidence: 0.8,
            },
            slippage_ok: { type: "noul", noul: 0.85 },
            intent_match: { type: "noul", noul: 0.97 },
          },
          usage: { input_tokens: 400, output_tokens: 30 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const jev = new JevProvider({ apiKey: "k", fetch: fetchMock });
    const result = await jev.evaluate(state, { signal: new AbortController().signal });

    expect(sent?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect((sent?.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(sent?.init.body as string);
    expect(body.model).toBe("jev-latest");
    expect(Object.keys(body.questions)).toEqual(["action", "slippage_ok", "intent_match"]);
    expect(body.questions.action.type).toBe("choice");
    expect(body.questions.slippage_ok.type).toBe("noul");
    expect(body.state.userInstruction).toBe("swap 10 HBAR for SAUCE");
    expect(result).toEqual({
      model: "jev-1.13.0",
      answers: {
        action: { choice: "execute", probabilities: { execute: 0.9, wait: 0.07, abort: 0.03 } },
        slippage_ok: 0.85,
        intent_match: 0.97,
      },
    });
  });

  it("throws on an HTTP error so the gate can fail closed", async () => {
    const fetchMock = (async () =>
      new Response("overloaded", { status: 529 })) as unknown as typeof fetch;
    const jev = new JevProvider({ apiKey: "k", fetch: fetchMock });
    await expect(jev.evaluate(state, { signal: new AbortController().signal })).rejects.toThrow(
      /HTTP 529/,
    );
  });

  it("throws on a malformed answer", async () => {
    const fetchMock = (async () =>
      new Response(JSON.stringify({ model: "x", answers: { action: { type: "choice" } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    const jev = new JevProvider({ apiKey: "k", fetch: fetchMock });
    await expect(jev.evaluate(state, { signal: new AbortController().signal })).rejects.toThrow();
  });
});
