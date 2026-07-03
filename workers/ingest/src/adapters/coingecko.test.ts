import { describe, expect, it } from "vitest";
import { BINANCE_INSTRUMENTS, parseDerivatives, parseSimplePrice, type DerivativesTicker } from "./coingecko.js";

describe("parseSimplePrice (docs/03 §7 pure-parse contract)", () => {
  it("fans one price point out to every instrument sharing that base asset", () => {
    const raw = {
      bitcoin: { usd: 65000.5, last_updated_at: 1_700_000_000 },
      ethereum: { usd: 3200.25, last_updated_at: 1_700_000_005 }
    };
    const rows = parseSimplePrice(raw, BINANCE_INSTRUMENTS);
    expect(rows).toEqual([
      { instrumentId: "BTCUSDT.BINANCE.PERP", price: 65000.5, ts: 1_700_000_000_000 },
      { instrumentId: "BTCUSDT.BINANCE.SPOT", price: 65000.5, ts: 1_700_000_000_000 },
      { instrumentId: "ETHUSDT.BINANCE.PERP", price: 3200.25, ts: 1_700_000_005_000 }
    ]);
  });

  it("skips instruments with no matching CoinGecko price point", () => {
    expect(parseSimplePrice({}, BINANCE_INSTRUMENTS)).toEqual([]);
  });
});

describe("parseDerivatives", () => {
  const raw: DerivativesTicker[] = [
    {
      market: "Binance (Futures)",
      symbol: "BTCUSDT",
      contract_type: "perpetual",
      funding_rate: 0.0001,
      open_interest: 5_000_000_000,
      last_traded_at: 1_700_000_010
    },
    {
      market: "Binance (Futures)",
      symbol: "BTCUSD_PERP",
      contract_type: "perpetual",
      funding_rate: 0.0002,
      open_interest: 1_000_000_000,
      last_traded_at: 1_700_000_010
    },
    {
      market: "Deepcoin (Derivatives)",
      symbol: "BTCUSDT",
      contract_type: "perpetual",
      funding_rate: 0.0005,
      open_interest: 100_000_000,
      last_traded_at: 1_700_000_010
    },
    {
      market: "Binance (Futures)",
      symbol: "ETHUSDT",
      contract_type: "perpetual",
      funding_rate: -0.00005,
      open_interest: 2_000_000_000,
      last_traded_at: 1_700_000_020
    }
  ];

  it("picks the Binance USDT-margined perpetual entry per futures instrument, ignoring other venues and coin-margined contracts", () => {
    const rows = parseDerivatives(raw, BINANCE_INSTRUMENTS);
    expect(rows).toEqual([
      { instrumentId: "BTCUSDT.BINANCE.PERP", symbol: "BTCUSDT", fundingRate: 0.0001, openInterestUsd: 5_000_000_000, ts: 1_700_000_010_000 },
      { instrumentId: "ETHUSDT.BINANCE.PERP", symbol: "ETHUSDT", fundingRate: -0.00005, openInterestUsd: 2_000_000_000, ts: 1_700_000_020_000 }
    ]);
  });

  it("skips a futures instrument with no matching entry", () => {
    const rows = parseDerivatives(
      raw.filter((t) => t.symbol !== "ETHUSDT"),
      BINANCE_INSTRUMENTS
    );
    expect(rows.map((r) => r.instrumentId)).toEqual(["BTCUSDT.BINANCE.PERP"]);
  });
});
