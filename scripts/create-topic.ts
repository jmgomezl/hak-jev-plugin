import { TopicCreateTransaction } from "@hiero-ledger/sdk";
import { testnetClient } from "./lib/env";

/**
 * Creates the HCS topic that holds gate receipts. The submit key is the operator's key,
 * so only this account can write receipts; anyone can read them.
 */
const main = async () => {
  const { client, privateKey } = testnetClient();
  const response = await new TopicCreateTransaction()
    .setTopicMemo("hak-jev-plugin gate receipts v1")
    .setSubmitKey(privateKey.publicKey)
    .execute(client);
  const receipt = await response.getReceipt(client);
  const topicId = receipt.topicId?.toString();
  if (!topicId) {
    throw new Error("Topic creation returned no topic id.");
  }

  console.log(`Topic created: ${topicId}`);
  console.log(`HashScan: https://hashscan.io/testnet/topic/${topicId}`);
  console.log("\nAdd this line to your .env:");
  console.log(`HCS_TOPIC_ID=${topicId}`);
  client.close();
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
