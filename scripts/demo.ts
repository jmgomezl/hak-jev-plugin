import { AgentMode, type Context } from "@hashgraph/hedera-agent-kit";
import { TokenAssociateTransaction } from "@hiero-ledger/sdk";
import { type GateDecisionEvent, JevGatePolicy, hashscanTransactionUrl } from "../src";
import { DemoSaucerSwapTool, demoTokenId, ensureAssociated } from "./lib/demo-swap-tool";
import { testnetClient } from "./lib/env";

/**
 * Two swaps through the gate on Hedera testnet:
 *   1. a sane one that passes and executes
 *   2. an absurd one (50% slippage) that gets blocked before anything is signed
 * Each decision is printed with the HashScan link of its HCS receipt.
 */

const INTENT = "Swap 5 HBAR for SAUCE";

const line = (label: string, value: string | number) =>
  console.log(`  ${label.padEnd(10)} ${value}`);

const printDecision = ({ receipt, published, publishError }: GateDecisionEvent) => {
  const a = receipt.answers;
  line("decision", receipt.decision.toUpperCase());
  line("provider", `${receipt.provider} (${receipt.model}), ${receipt.latencyMs} ms`);
  if (a) {
    line(
      "answers",
      `action=${a.action} P(execute)=${a.p.execute} slippage_ok=${a.slippage_ok} intent_match=${a.intent_match}`,
    );
  }
  line("reason", receipt.reason);
  if (receipt.txId) {
    line("swap tx", hashscanTransactionUrl(receipt.txId));
  }
  if (published) {
    line(
      "receipt",
      `${hashscanTransactionUrl(published.transactionId)} (message #${published.sequenceNumber})`,
    );
  } else {
    line("receipt", `not published${publishError ? `: ${publishError}` : " (no HCS_TOPIC_ID)"}`);
  }
};

const main = async () => {
  const { client, accountId } = testnetClient();
  if (!process.env.HCS_TOPIC_ID) {
    throw new Error("Set HCS_TOPIC_ID in .env first (run: npm run create-topic).");
  }

  // One-time setup: the account must be associated with SAUCE to receive it.
  if (!(await ensureAssociated(accountId.toString(), "SAUCE"))) {
    console.log("Associating account with SAUCE (one time)...");
    await (
      await new TokenAssociateTransaction()
        .setAccountId(accountId)
        .setTokenIds([demoTokenId("SAUCE")])
        .execute(client)
    ).getReceipt(client);
  }

  const decisions: GateDecisionEvent[] = [];
  const gate = new JevGatePolicy({ intent: INTENT, onDecision: (e) => decisions.push(e) });
  const context: Context = {
    accountId: accountId.toString(),
    mode: AgentMode.AUTONOMOUS,
    hooks: [gate],
  };
  const swap = new DemoSaucerSwapTool();

  console.log("hak-jev-plugin demo: Jev judges, HAK executes, HCS notarizes");
  console.log(
    `  provider   ${gate.provider.name}${gate.provider.name === "rules" ? " (no TYPESAFE_API_KEY set)" : ""}`,
  );
  console.log(
    `  threshold  ${gate.config.threshold}, timeout ${gate.config.timeoutMs} ms, fail mode ${gate.config.failMode}`,
  );
  console.log(`  topic      https://hashscan.io/testnet/topic/${gate.config.topicId}`);
  console.log(`  intent     "${INTENT}"`);

  const cases = [
    {
      title: "1) Sane swap: 5 HBAR -> SAUCE, 0.5% slippage",
      params: { fromToken: "HBAR", toToken: "SAUCE", amount: "5", slippageTolerance: 0.5 },
    },
    {
      title: "2) Bad swap: 5 HBAR -> SAUCE, 50% slippage",
      params: { fromToken: "HBAR", toToken: "SAUCE", amount: "5", slippageTolerance: 50 },
    },
  ];

  for (const c of cases) {
    console.log(`\n${c.title}`);
    const before = decisions.length;
    const result = await swap.execute(client, context, c.params);
    const event = decisions[before];
    if (event) {
      printDecision(event);
    } else {
      line("result", result?.humanMessage ?? JSON.stringify(result));
    }
  }

  console.log(`\nAll receipts: https://hashscan.io/testnet/topic/${gate.config.topicId}`);
  console.log(`Receipt list page: open web/receipts.html?topic=${gate.config.topicId}`);
  client.close();
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
