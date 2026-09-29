import { type Client, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

export interface PublishedReceipt {
  topicId: string;
  sequenceNumber: string | null;
  transactionId: string;
}

/** Where receipts go. Swap it out in tests or to log somewhere other than HCS. */
export interface ReceiptSink {
  publish(message: string, client: Client): Promise<PublishedReceipt>;
}

/** Submits each receipt as one HCS message to a pre-created topic. */
export class HcsReceiptSink implements ReceiptSink {
  constructor(
    private readonly topicId: string,
    /** Optional dedicated client for receipts. Defaults to the agent's client. */
    private readonly loggingClient?: Client,
  ) {}

  async publish(message: string, client: Client): Promise<PublishedReceipt> {
    const signer = this.loggingClient ?? client;
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(this.topicId)
      .setMessage(message)
      .execute(signer);
    const receipt = await response.getReceipt(signer);
    return {
      topicId: this.topicId,
      sequenceNumber: receipt.topicSequenceNumber?.toString() ?? null,
      transactionId: response.transactionId.toString(),
    };
  }
}

/** HashScan link for a testnet transaction, e.g. the HCS submit that carried a receipt. */
export const hashscanTransactionUrl = (transactionId: string): string =>
  `https://hashscan.io/testnet/transaction/${transactionId}`;
