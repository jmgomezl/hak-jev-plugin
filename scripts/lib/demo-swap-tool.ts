import { BaseTool, type Context, handleTransaction } from "@hashgraph/hedera-agent-kit";
import {
  type Client,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  HbarUnit,
} from "@hiero-ledger/sdk";
import { Interface } from "ethers";
import Long from "long";
import { z } from "zod";

/**
 * Demo-only swap tool: HBAR -> token on the SaucerSwap V1 router on Hedera testnet.
 *
 * It exists so the demo has a real swap to gate. It uses the same method name as
 * hak-saucerswap-plugin (`saucerswap_swap_tokens`) and the same core payload shape
 * (`{ transaction, extras }`), so JevGatePolicy treats it exactly like the real tool.
 * Quotes come from the router's `getAmountsOut` through the mirror node, which is free
 * and needs no API key. Not part of the published package.
 */

const MIRROR = "https://testnet.mirrornode.hedera.com";
const ROUTER_V1 = "0.0.19264";
const WHBAR = { id: "0.0.15058", decimals: 8 };
const TOKENS: Record<string, { id: string; decimals: number; pair: string }> = {
  SAUCE: { id: "0.0.1183558", decimals: 6, pair: "0.0.2656382" },
};
const GAS = 1_500_000;

const abi = new Interface([
  "function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 ts)",
  "function token0() view returns (address)",
]);

const evmAddress = (id: string): string =>
  `0x${BigInt(id.split(".")[2] ?? "0")
    .toString(16)
    .padStart(40, "0")}`;

const mirrorCall = async (to: string, data: string): Promise<string> => {
  const response = await fetch(`${MIRROR}/api/v1/contracts/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to, data, estimate: false, block: "latest" }),
  });
  const body = (await response.json()) as { result?: string };
  if (!response.ok || !body.result) {
    throw new Error(`Mirror node contract call failed (HTTP ${response.status}).`);
  }
  return body.result;
};

/**
 * Where the router should send the output. Accounts with an EVM alias (ECDSA keys) must
 * receive at the alias; the long-zero address makes the HTS transfer revert
 * ("Safe token transfer failed!").
 */
const recipientAddress = async (accountId: string): Promise<string> => {
  const response = await fetch(`${MIRROR}/api/v1/accounts/${accountId}`);
  const body = (await response.json()) as { evm_address?: string };
  return body.evm_address ?? evmAddress(accountId);
};

const toUnits = (amount: string, decimals: number): bigint => {
  const [whole = "0", fraction = ""] = amount.split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0").slice(0, decimals));
};

const fromUnits = (value: bigint, decimals: number): string => {
  const s = value.toString().padStart(decimals + 1, "0");
  const fraction = s.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${s.slice(0, -decimals)}.${fraction}` : s.slice(0, -decimals);
};

const schema = z.object({
  fromToken: z.string().describe("Only HBAR is supported by this demo tool"),
  toToken: z.string().describe("Token symbol, e.g. SAUCE"),
  amount: z.string().describe("HBAR amount, decimal"),
  slippageTolerance: z.number().optional().default(0.5).describe("Percent"),
});
type Params = z.infer<typeof schema>;

export class DemoSaucerSwapTool extends BaseTool<Params, Params> {
  method = "saucerswap_swap_tokens";
  name = "SaucerSwap Swap (testnet demo)";
  description = "Swap HBAR for a token on SaucerSwap V1, Hedera testnet only.";
  parameters = schema;

  async normalizeParams(params: Params) {
    const parsed = schema.parse(params);
    if (parsed.fromToken.toUpperCase() !== "HBAR") {
      throw new Error("The demo swap tool only swaps from HBAR.");
    }
    if (!TOKENS[parsed.toToken.toUpperCase()]) {
      throw new Error(`Unknown token ${parsed.toToken}. Known: ${Object.keys(TOKENS).join(", ")}`);
    }
    return parsed;
  }

  async coreAction(params: Params, _context: Context, client: Client) {
    const token = TOKENS[params.toToken.toUpperCase()];
    const operator = client.operatorAccountId?.toString();
    if (!token || !operator) {
      throw new Error("Demo swap needs a known token and a client with an operator.");
    }
    const path = [evmAddress(WHBAR.id), evmAddress(token.id)];
    const amountIn = toUnits(params.amount, WHBAR.decimals);

    const quoted = abi.decodeFunctionResult(
      "getAmountsOut",
      await mirrorCall(
        evmAddress(ROUTER_V1),
        abi.encodeFunctionData("getAmountsOut", [amountIn, path]),
      ),
    )[0] as bigint[];
    const amountOut = quoted[1] ?? 0n;

    // Price impact against the pool's spot price (includes the 0.3% LP fee).
    const pairEvm = evmAddress(token.pair);
    const [r0, r1] = abi.decodeFunctionResult(
      "getReserves",
      await mirrorCall(pairEvm, abi.encodeFunctionData("getReserves")),
    ) as unknown as [bigint, bigint];
    const token0 = (
      abi.decodeFunctionResult(
        "token0",
        await mirrorCall(pairEvm, abi.encodeFunctionData("token0")),
      )[0] as string
    ).toLowerCase();
    const [reserveIn, reserveOut] = token0 === path[0] ? [r0, r1] : [r1, r0];
    const spotOut = (Number(amountIn) * Number(reserveOut)) / Number(reserveIn);
    const priceImpact = spotOut > 0 ? (1 - Number(amountOut) / spotOut) * 100 : null;

    const slippageBps = BigInt(Math.round(params.slippageTolerance * 100));
    const minOut =
      (amountOut * (10_000n - (slippageBps > 10_000n ? 10_000n : slippageBps))) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 20 * 60);

    const transaction = new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(ROUTER_V1))
      .setGas(GAS)
      .setPayableAmount(Hbar.from(params.amount, HbarUnit.Hbar))
      .setFunction(
        "swapExactETHForTokens",
        new ContractFunctionParameters()
          .addUint256(Long.fromString(minOut.toString(), true))
          .addAddressArray(path)
          .addAddress(await recipientAddress(operator))
          .addUint256(Long.fromString(deadline.toString(), true)),
      );

    return {
      transaction,
      extras: {
        estimatedOutput: fromUnits(amountOut, token.decimals),
        minOutput: fromUnits(minOut, token.decimals),
        priceImpact: priceImpact === null ? null : Math.round(priceImpact * 1000) / 1000,
        route: ["HBAR", params.toToken.toUpperCase()],
      },
    };
  }

  override async secondaryAction(
    payload: { transaction: ContractExecuteTransaction; extras: Record<string, unknown> },
    client: Client,
    context: Context,
  ) {
    const result = await handleTransaction(
      payload.transaction,
      client,
      context,
      (r) => `Swap submitted. Status: ${r.status}. Transaction ID: ${r.transactionId}`,
    );
    return { ...(result as Record<string, unknown>), ...payload.extras };
  }
}

/** Make sure the operator can receive the token (HTS association). Safe to call twice. */
export const ensureAssociated = async (accountId: string, symbol: string): Promise<boolean> => {
  const token = TOKENS[symbol.toUpperCase()];
  if (!token) {
    throw new Error(`Unknown token ${symbol}`);
  }
  const response = await fetch(
    `${MIRROR}/api/v1/accounts/${accountId}/tokens?token.id=${token.id}`,
  );
  const body = (await response.json()) as { tokens?: unknown[] };
  return (body.tokens?.length ?? 0) > 0;
};

export const demoTokenId = (symbol: string): string => {
  const token = TOKENS[symbol.toUpperCase()];
  if (!token) {
    throw new Error(`Unknown token ${symbol}`);
  }
  return token.id;
};
