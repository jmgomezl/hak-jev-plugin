# Hedera Agent Kit - Jev Gate Plugin

**Jev judges, HAK executes, HCS notarizes.**

An AI decision gate for [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit-js) tool calls.
Before a sensitive tool call is signed, the gate asks
[TypeSafe's Jev](https://docs.typesafe.ai) a few typed questions about it, then lets it execute or
blocks it. Every decision is written as a compact receipt to a Hedera Consensus Service (HCS) topic,
so anyone can audit it on HashScan.

v0 gates one tool: `saucerswap_swap_tokens`, the swap tool of
[hak-saucerswap-plugin](https://github.com/jmgomezl/hak-saucerswap-plugin).

Sibling of [hak-uniswap-plugin](https://github.com/jmgomezl/hak-uniswap-plugin), whose optional
Ledger approval puts a human in front of a swap. This plugin puts a model there instead.

## Why

- **Agents make mistakes quietly.** A wrong token, an extra zero or a 50% slippage setting is still a
  valid transaction. A gate that sees the call *after it is built and before it is signed* catches
  these with no change to the agent or the tool.
- **Typed answers, not text.** Jev returns probabilities for fixed questions, so the policy is plain
  code: execute only if every probability clears a threshold.
- **Auditable.** Each decision (executed or blocked) becomes one HCS message with the answers, the
  model version, the latency and a hash of the params. No keys and no raw user text are ever stored.

## How it works

`JevGatePolicy` is a native HAK v4 [policy](https://github.com/hashgraph/hedera-agent-kit-js/blob/main/docs/HOOKS_AND_POLICIES.md)
(`AbstractPolicy`). You add it to `context.hooks` and HAK runs it inside the tool lifecycle. No
wrapper, no fork of the tool.

```text
agent calls saucerswap_swap_tokens
  |
  [core action]    tool builds the swap tx and the quote
  |
  [gate]           JevGatePolicy.shouldBlockPostCoreAction
  |                  state  = params + quote (pool snapshot) + user instruction
  |                  ask    = Jev (or rules), 2 s timeout
  |                  decide = P(execute), P(slippage_ok), P(intent_match) >= 0.7 ?
  |                  no  -> HCS receipt "blocked", throw, agent gets the reason
  |
  [secondary]      tx is signed and submitted
  |
  [post tool]      HCS receipt "executed" with the transaction id
```

### Questions (v0, fixed)

| id             | type                             | question                                               |
| -------------- | -------------------------------- | ------------------------------------------------------ |
| `action`       | Choice: `execute`/`wait`/`abort` | What should the software do with this call right now? |
| `slippage_ok`  | Noul (yes/no probability)        | Is the expected slippage acceptable for this size?     |
| `intent_match` | Noul (yes/no probability)        | Does the call match the user's stated instruction?     |

The gate executes only if `P(execute)`, `slippage_ok` and `intent_match` are all at or above
`GATE_THRESHOLD` (default `0.7`). Otherwise it blocks and returns every failed check to the agent,
for example:

```text
JevGate blocked saucerswap_swap_tokens: below threshold 0.7: P(execute)=0.00 (model chose abort), P(slippage_ok)=0.00
```

### Providers

| provider        | when                           | what it does                                                                                   |
| --------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `JevProvider`   | `TYPESAFE_API_KEY` is set      | `POST https://api.typesafe.ai/v1/systemone` with the three questions, model `jev-latest`.      |
| `RulesProvider` | no key (default)               | Deterministic 0/1 answers: slippage bps limit, price impact limit, max amount, token allowlist. |

`RulesProvider` also doubles as a baseline: run the same calls through both and compare.

### Fail closed

If the provider times out (`GATE_TIMEOUT_MS`, default 2000) or errors, the call is **blocked** and the
receipt says why. Set `GATE_FAIL_MODE=allow` only if you accept unchecked swaps during an outage.

### Receipt

One HCS message per decision, compact JSON, always under 1024 bytes (one HCS chunk). If a receipt
would go over, only the free-text `reason` is shortened.

```json
{
  "v": 1,
  "ts": "2026-09-29T20:14:03.512Z",
  "network": "testnet",
  "accountId": "0.0.1234567",
  "tool": "saucerswap_swap_tokens",
  "paramsHash": "9f2c...64 hex",
  "intentHash": "41aa...64 hex",
  "provider": "jev",
  "model": "jev-1.13.0",
  "answers": {
    "action": "execute",
    "p": { "execute": 0.91, "wait": 0.06, "abort": 0.03 },
    "slippage_ok": 0.88,
    "intent_match": 0.97
  },
  "decision": "executed",
  "reason": "all checks >= 0.7",
  "latencyMs": 312,
  "txId": "0.0.1234567@1790712843.120000000",
  "txStatus": "SUCCESS"
}
```

`paramsHash` is sha256 of the canonical (sorted keys) JSON of the swap params. `intentHash` is sha256
of the user's instruction. The instruction itself is never written on chain.

## Installation

```bash
npm install hak-jev-plugin
```

Peer dependencies: `@hashgraph/hedera-agent-kit` (v4) and `@hiero-ledger/sdk`.

## Quick start

```ts
import { JevGatePolicy } from "hak-jev-plugin";
import { saucerswapPlugin } from "hak-saucerswap-plugin";

const gate = new JevGatePolicy({
  topicId: process.env.HCS_TOPIC_ID, // or read from env
  intent: () => lastUserMessage, // the user's instruction, hashed in the receipt
});

const toolkit = new HederaLangchainToolkit({
  client,
  configuration: {
    plugins: [saucerswapPlugin],
    context: {
      mode: AgentMode.AUTONOMOUS,
      hooks: [gate],
    },
  },
});
```

Update the instruction on every user turn with `gate.setIntent(text)` or pass a getter as above.

### Options

| option          | env var            | default                    | meaning                                                 |
| --------------- | ------------------ | -------------------------- | ------------------------------------------------------- |
| `threshold`     | `GATE_THRESHOLD`   | `0.7`                      | Minimum probability for every check.                    |
| `timeoutMs`     | `GATE_TIMEOUT_MS`  | `2000`                     | Provider timeout.                                       |
| `failMode`      | `GATE_FAIL_MODE`   | `block`                    | `block` or `allow` on provider timeout or error.        |
| `topicId`       | `HCS_TOPIC_ID`     | none                       | Receipts topic. Without it, no receipts are written.    |
| `typesafeApiKey`| `TYPESAFE_API_KEY` | none                       | Uses Jev when set, rules otherwise.                     |
| `jevModel`      |                    | `jev-latest`               | Pin a version (e.g. `jev-1.13.0`) if you tuned the threshold. |
| `rules`         |                    | see below                  | Limits for `RulesProvider`.                             |
| `provider`      |                    | auto                       | Any object implementing `GateProvider`.                 |
| `sink`          |                    | HCS                        | Any object implementing `ReceiptSink`.                  |
| `loggingClient` |                    | agent client               | Separate client that pays for receipts.                 |
| `relevantTools` |                    | `["saucerswap_swap_tokens"]` | Tool names to gate.                                   |
| `onDecision`    |                    | none                       | Callback with each receipt and its HCS location.        |

Rules defaults: `maxSlippageBps: 100` (1%), `maxPriceImpactPercent: 5`, `maxAmount: 1000`,
`tokenAllowlist: []` (any token).

### Swapping the provider

```ts
import { JevGatePolicy, type GateProvider } from "hak-jev-plugin";

const myProvider: GateProvider = {
  name: "rules",
  async evaluate(state, { signal }) {
    // state: tool, params, quote, userInstruction
    return {
      model: "my-model-v1",
      answers: {
        action: { choice: "execute", probabilities: { execute: 0.9, wait: 0.05, abort: 0.05 } },
        slippage_ok: 0.9,
        intent_match: 0.9,
      },
    };
  },
};

new JevGatePolicy({ provider: myProvider });
```

## Demo (testnet, under 3 minutes)

The demo runs two real swaps on Hedera testnet through the gate:

1. **Sane:** 5 HBAR to SAUCE with 0.5% slippage. Passes, executes, receipt `executed` with the tx id.
2. **Bad:** 5 HBAR to SAUCE with 50% slippage. Blocked before anything is signed, receipt `blocked`.

```bash
git clone https://github.com/jmgomezl/hak-jev-plugin.git
cd hak-jev-plugin
npm install
cp .env.example .env        # fill HEDERA_ACCOUNT_ID and HEDERA_PRIVATE_KEY (testnet)
npm run create-topic        # prints HCS_TOPIC_ID, add it to .env
npm run demo
```

You need a testnet account with about 10 HBAR ([portal.hedera.com](https://portal.hedera.com)). The
first run associates the account with SAUCE. Add `TYPESAFE_API_KEY` to run the same demo with Jev
instead of the rules provider.

The demo swaps through `scripts/lib/demo-swap-tool.ts`, a small testnet-only tool that uses the same
tool name and payload shape as the SaucerSwap plugin's swap tool. It quotes with the SaucerSwap V1
router's `getAmountsOut` through the mirror node, so it needs no SaucerSwap API key. It is not part of
the published package.

### Receipt list page

`web/receipts.html` is a single static file. It reads every message of a topic from the testnet
mirror node, base64-decodes it and lists executed and blocked decisions with HashScan links.

```bash
open "web/receipts.html?topic=0.0.1234567"
```

## Environment variables

| variable             | required | notes                                              |
| -------------------- | -------- | -------------------------------------------------- |
| `HEDERA_ACCOUNT_ID`  | demo     | Testnet operator.                                  |
| `HEDERA_PRIVATE_KEY` | demo     | DER, or hex (`0x` prefix for ECDSA).               |
| `HEDERA_NETWORK`     | no       | Must be `testnet` in v0.                           |
| `HCS_TOPIC_ID`       | yes      | Receipts topic.                                    |
| `TYPESAFE_API_KEY`   | no       | Enables Jev.                                       |
| `GATE_THRESHOLD`     | no       | Default `0.7`.                                     |
| `GATE_TIMEOUT_MS`    | no       | Default `2000`.                                    |
| `GATE_FAIL_MODE`     | no       | `block` (default) or `allow`.                      |

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Tests use a mocked provider and run the real HAK `BaseTool` lifecycle. They cover pass, block by
threshold, block on timeout, block on provider error, fail open, rules fallback when there is no key,
and receipt size under 1024 bytes.

## Limitations

- **Testnet only** in v0. Any other `HEDERA_NETWORK` is rejected.
- **One tool.** Only `saucerswap_swap_tokens` and tools with the same `{ transaction, extras }` core
  payload are understood. The question set is fixed.
- **Tools must extend `BaseTool`.** HAK only runs hooks and policies for `BaseTool` subclasses.
- **Pool snapshot is the tool's quote** (expected output, min output, price impact, route). The gate
  does not fetch extra market data.
- **Rules cannot read language.** `RulesProvider` only checks that both tokens appear in the
  instruction, and answers yes when there is no instruction.
- **Missing receipt on submit failure.** If the swap passes the gate but the submission throws, HAK
  skips post-tool hooks, so no `executed` receipt is written for that call.
- **Receipts are best effort.** If publishing to HCS fails, the error is logged and the decision
  stands, the same as HAK's `HcsAuditTrailHook`.
- **Jev accuracy** is best in English, and answers behind `jev-latest` change when TypeSafe ships a
  new version. Pin a version id if you tune the threshold. See
  [Jev models](https://docs.typesafe.ai/models).
- **HCS fees.** Each decision costs one topic message fee, paid by the agent's client unless you set
  `loggingClient`.

## License

MIT
