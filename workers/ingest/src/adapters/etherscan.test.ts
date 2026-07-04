import { describe, expect, it } from "vitest";
import { parseUsdtMints, type EtherscanTokenTxResponse } from "./etherscan.js";

describe("parseUsdtMints", () => {
  it("keeps only transfers from the zero address (mints) and converts by tokenDecimal", () => {
    const resp: EtherscanTokenTxResponse = {
      status: "1",
      message: "OK",
      result: [
        {
          hash: "0xmint",
          timeStamp: "1704067200",
          from: "0x0000000000000000000000000000000000000000",
          to: "0x5754284f345afc66a98fbb0a0afe71e0f007b9d",
          value: "1000000000000",
          tokenDecimal: "6"
        },
        {
          hash: "0xordinarytransfer",
          timeStamp: "1704067300",
          from: "0x5754284f345afc66a98fbb0a0afe71e0f007b9d",
          to: "0xsomeexchange",
          value: "500000000",
          tokenDecimal: "6"
        }
      ]
    };
    expect(parseUsdtMints(resp)).toEqual([{ ts: 1704067200000, txHash: "0xmint", amountUsd: 1_000_000 }]);
  });

  it("is case-insensitive when matching the zero address", () => {
    const resp: EtherscanTokenTxResponse = {
      status: "1",
      message: "OK",
      result: [
        {
          hash: "0xmint",
          timeStamp: "1704067200",
          from: "0x0000000000000000000000000000000000000000".toUpperCase(),
          to: "0x5754284f345afc66a98fbb0a0afe71e0f007b9d",
          value: "1000000",
          tokenDecimal: "6"
        }
      ]
    };
    expect(parseUsdtMints(resp)).toHaveLength(1);
  });

  it("returns an empty array when the API reports an error status", () => {
    expect(parseUsdtMints({ status: "0", message: "NOTOK", result: [] })).toEqual([]);
  });
});
