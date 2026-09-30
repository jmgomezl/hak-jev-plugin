import { AgentMode, type Context } from "@hashgraph/hedera-agent-kit";
import { describe, expect, it } from "vitest";
import { JevGatePolicy } from "../src/policy";
import { RulesProvider } from "../src/providers/rules";
import type { GateReceipt } from "../src/receipt";
import {
  FakeSwapTool,
  MemorySink,
  MockProvider,
  answers,
  contextWith,
  emptyEnv,
  fakeClient,
  realClient,
  swapParams,
} from "./helpers";

const lastReceipt = (sink: MemorySink): GateReceipt =>
  JSON.parse(sink.messages[sink.messages.length - 1] as string);

describe("JevGatePolicy", () => {
  it("lets a swap through when every probability clears the threshold", async () => {
    const sink = new MemorySink();
    const provider = new MockProvider(async () => ({
      model: "jev-1.13.0",
      answers: answers(0.92, 0.88, 0.95),
    }));
    const policy = new JevGatePolicy(
      { provider, sink, intent: "swap 10 HBAR for SAUCE" },
      emptyEnv,
    );
    const tool = new FakeSwapTool();

    const result = await tool.execute(fakeClient, contextWith([policy]), swapParams);

    expect(tool.submitted).toBe(1);
    expect(result.raw.status).toBe("SUCCESS");
    expect(sink.messages).toHaveLength(1);
    const receipt = lastReceipt(sink);
    expect(receipt).toMatchObject({
      decision: "executed",
      provider: "jev",
      model: "jev-1.13.0",
      accountId: "0.0.1234",
      tool: "saucerswap_swap_tokens",
      txId: "0.0.1234@1700000000.000000001",
      txStatus: "SUCCESS",
    });
    expect(receipt.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.intentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(receipt)).not.toContain("swap 10 HBAR");
    expect(provider.calls[0]?.quote.priceImpactPercent).toBe(0.2);
  });

  it("blocks when one probability is under the threshold and tells the agent why", async () => {
    const sink = new MemorySink();
    const provider = new MockProvider(async () => ({
      model: "jev-1.13.0",
      answers: answers(0.9, 0.3, 0.9),
    }));
    const policy = new JevGatePolicy({ provider, sink }, emptyEnv);
    const tool = new FakeSwapTool();

    const result = await tool.execute(fakeClient, contextWith([policy]), swapParams);

    expect(tool.submitted).toBe(0);
    expect(result.raw.status).toBe("ERROR");
    expect(result.humanMessage).toContain("JevGate blocked saucerswap_swap_tokens");
    expect(result.humanMessage).toContain("P(slippage_ok)=0.30");
    const receipt = lastReceipt(sink);
    expect(receipt.decision).toBe("blocked");
    expect(receipt.txId).toBeUndefined();
  });

  it("honours a custom threshold", async () => {
    const sink = new MemorySink();
    const provider = new MockProvider(async () => ({
      model: "m",
      answers: answers(0.8, 0.8, 0.8),
    }));
    const policy = new JevGatePolicy({ provider, sink, threshold: 0.85 }, emptyEnv);
    const tool = new FakeSwapTool();

    await tool.execute(fakeClient, contextWith([policy]), swapParams);

    expect(tool.submitted).toBe(0);
    expect(lastReceipt(sink).decision).toBe("blocked");
  });

  it("fails closed when the provider times out", async () => {
    const sink = new MemorySink();
    let aborted = false;
    const provider = new MockProvider(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
          setTimeout(() => resolve({ model: "late", answers: answers(1, 1, 1) }), 500);
        }),
    );
    const policy = new JevGatePolicy({ provider, sink, timeoutMs: 50 }, emptyEnv);
    const tool = new FakeSwapTool();

    const result = await tool.execute(fakeClient, contextWith([policy]), swapParams);

    expect(tool.submitted).toBe(0);
    expect(aborted).toBe(true);
    expect(result.humanMessage).toContain("fail closed: provider timed out after 50 ms");
    const receipt = lastReceipt(sink);
    expect(receipt.decision).toBe("blocked");
    expect(receipt.answers).toBeNull();
  });

  it("fails closed when the provider errors", async () => {
    const sink = new MemorySink();
    const provider = new MockProvider(async () => {
      throw new Error("TypeSafe API returned HTTP 529");
    });
    const policy = new JevGatePolicy({ provider, sink }, emptyEnv);
    const tool = new FakeSwapTool();

    await tool.execute(fakeClient, contextWith([policy]), swapParams);

    expect(tool.submitted).toBe(0);
    expect(lastReceipt(sink).reason).toContain("HTTP 529");
  });

  it("can fail open when GATE_FAIL_MODE=allow", async () => {
    const sink = new MemorySink();
    const provider = new MockProvider(async () => {
      throw new Error("down");
    });
    const policy = new JevGatePolicy({ provider, sink }, { GATE_FAIL_MODE: "allow" });
    const tool = new FakeSwapTool();

    await tool.execute(fakeClient, contextWith([policy]), swapParams);

    expect(tool.submitted).toBe(1);
    expect(lastReceipt(sink)).toMatchObject({ decision: "executed", reason: "fail open: down" });
  });

  it("falls back to the rules provider when there is no TypeSafe key", () => {
    const policy = new JevGatePolicy({}, emptyEnv);
    expect(policy.provider).toBeInstanceOf(RulesProvider);
    expect(policy.provider.name).toBe("rules");
  });

  it("uses Jev when a TypeSafe key is set", () => {
    const policy = new JevGatePolicy({}, { TYPESAFE_API_KEY: "test-key" });
    expect(policy.provider.name).toBe("jev");
  });

  it("rules provider blocks absurd slippage end to end", async () => {
    const sink = new MemorySink();
    const policy = new JevGatePolicy({ sink }, emptyEnv);
    const tool = new FakeSwapTool();

    const result = await tool.execute(fakeClient, contextWith([policy]), {
      ...swapParams,
      slippageTolerance: 50,
    });

    expect(tool.submitted).toBe(0);
    expect(result.humanMessage).toContain("P(slippage_ok)=0.00");
    expect(lastReceipt(sink)).toMatchObject({
      provider: "rules",
      model: "rules-v0",
      decision: "blocked",
    });
  });

  it("ignores tools it does not gate", async () => {
    const sink = new MemorySink();
    const provider = new MockProvider(async () => ({ model: "m", answers: answers(0, 0, 0) }));
    const policy = new JevGatePolicy(
      { provider, sink, relevantTools: ["some_other_tool"] },
      emptyEnv,
    );
    const tool = new FakeSwapTool();

    await tool.execute(fakeClient, contextWith([policy]), swapParams);

    expect(tool.submitted).toBe(1);
    expect(provider.calls).toHaveLength(0);
    expect(sink.messages).toHaveLength(0);
  });

  it("rejects non-testnet networks", () => {
    expect(() => new JevGatePolicy({}, { HEDERA_NETWORK: "mainnet" })).toThrow(/testnet only/);
  });
  it("notarizes before submission in autonomous mode, so a failed submit still has a receipt", async () => {
    const sink = new MemorySink();
    const provider = new MockProvider(async () => ({
      model: "m",
      answers: answers(0.9, 0.9, 0.9),
    }));
    const policy = new JevGatePolicy({ provider, sink }, emptyEnv);
    const tool = new FakeSwapTool({ realTx: true, failSubmit: true });

    const result = await tool.execute(realClient, contextWith([policy]), swapParams);

    expect(tool.submitted).toBe(1);
    expect(result.raw.status).toBe("ERROR");
    expect(sink.messages).toHaveLength(1);
    const receipt = lastReceipt(sink);
    expect(receipt.decision).toBe("executed");
    expect(receipt.txId).toMatch(/^0\.0\.1234@\d+\.\d+$/);
    expect(receipt.txId).toBe(tool.lastTransaction?.transactionId?.toString());
  });

  it("keeps the post-execution receipt outside autonomous mode", async () => {
    const sink = new MemorySink();
    const provider = new MockProvider(async () => ({
      model: "m",
      answers: answers(0.9, 0.9, 0.9),
    }));
    const policy = new JevGatePolicy({ provider, sink }, emptyEnv);
    const tool = new FakeSwapTool({ realTx: true });
    const context = { hooks: [policy], mode: AgentMode.RETURN_BYTES } as Context;

    await tool.execute(realClient, context, swapParams);

    expect(tool.lastTransaction?.transactionId).toBeNull();
    expect(lastReceipt(sink)).toMatchObject({
      decision: "executed",
      txId: "0.0.1234@1700000000.000000001",
      txStatus: "SUCCESS",
    });
  });
});
