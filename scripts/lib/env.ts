import "dotenv/config";
import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
};

/** Accepts DER, or raw hex for ECDSA (0x prefixed) and ED25519 keys. */
const parseKey = (raw: string): PrivateKey => {
  if (raw.startsWith("0x")) {
    return PrivateKey.fromStringECDSA(raw);
  }
  try {
    return PrivateKey.fromStringDer(raw);
  } catch {
    return PrivateKey.fromStringED25519(raw);
  }
};

/** Testnet client for the operator in .env. The demo never touches mainnet. */
export const testnetClient = () => {
  const network = process.env.HEDERA_NETWORK ?? "testnet";
  if (network !== "testnet") {
    throw new Error(`The demo is testnet only (HEDERA_NETWORK=${network}).`);
  }
  const accountId = AccountId.fromString(required("HEDERA_ACCOUNT_ID"));
  const privateKey = parseKey(required("HEDERA_PRIVATE_KEY"));
  const client = Client.forTestnet().setOperator(accountId, privateKey);
  return { client, accountId, privateKey };
};
