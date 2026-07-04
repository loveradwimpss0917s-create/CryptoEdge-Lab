// Etherscan free API (docs/03 §2.4 `etherscan`). Feeds the `usdt_mint`
// event (docs/02, seed edge, 2026-07 design audit TASK-4): a large fresh
// USDT issuance to Tether's Ethereum Treasury is a leading indicator of
// incoming exchange liquidity (PDF 031).
//
// CAVEAT: USDT_TREASURY_ADDRESS below is Tether's well-known Ethereum
// Treasury address from public knowledge, not verified against a live
// block explorer in this sandbox (no outbound network access here, same
// caveat jobs/lake_sync.py's module docstring carries for data.binance.
// vision). Confirm it against etherscan.io before relying on this in
// production, and re-check it periodically -- Tether has rotated
// treasury addresses before.

import { upsertEvent } from "../db.js";
import type { Adapter, AdapterRunResult } from "./types.js";
import { fetchJson } from "./types.js";

const STREAM_ID = "etherscan:usdt_mint";

export const USDT_TREASURY_ADDRESS = "0x5754284f345afc66a98fbb0a0afe71e0f007b9d";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface EtherscanTokenTxResponse {
  status: string;
  message: string;
  result: { hash: string; timeStamp: string; from: string; to: string; value: string; tokenDecimal: string }[];
}

export interface UsdtMintEvent {
  ts: number;
  txHash: string;
  amountUsd: number;
}

/** A `Transfer` from the zero address is an ERC-20 mint (new supply, not
 * a transfer of existing tokens) -- filters Tether Treasury's transfer
 * history down to just those. */
export function parseUsdtMints(resp: EtherscanTokenTxResponse): UsdtMintEvent[] {
  if (resp.status !== "1") return [];
  return resp.result
    .filter((tx) => tx.from.toLowerCase() === ZERO_ADDRESS)
    .map((tx) => ({
      ts: Number(tx.timeStamp) * 1000,
      txHash: tx.hash,
      amountUsd: Number(tx.value) / 10 ** Number(tx.tokenDecimal)
    }));
}

export const etherscanUsdtMintAdapter: Adapter = {
  sourceId: "etherscan",
  streamId: STREAM_ID,
  requestBudget: 1,
  async run(env): Promise<AdapterRunResult> {
    if (!env.ETHERSCAN_API_KEY) {
      // Fails soft (env.ts: "adapters that need one must fail soft ...
      // rather than throw when absent") -- a freshly cloned/deployed repo
      // has no key configured yet.
      return { streamId: STREAM_ID, rowsWritten: 0, watermarkTs: Date.now() };
    }
    const url =
      `https://api.etherscan.io/api?module=account&action=tokentx&address=${USDT_TREASURY_ADDRESS}` +
      `&sort=desc&page=1&offset=20&apikey=${env.ETHERSCAN_API_KEY}`;
    const mints = parseUsdtMints(await fetchJson<EtherscanTokenTxResponse>(url));

    const results = await Promise.all(
      mints.map((mint) =>
        upsertEvent(env, {
          eventType: "usdt_mint",
          ts: mint.ts,
          magnitude: mint.amountUsd,
          payload: { tx_hash: mint.txHash },
          sourceId: "etherscan",
          dedupeKey: `usdt_mint:${mint.txHash}`
        })
      )
    );
    const written = results.filter(Boolean).length;
    return { streamId: STREAM_ID, rowsWritten: written, watermarkTs: Date.now() };
  }
};
