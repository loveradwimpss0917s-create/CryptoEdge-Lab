// Source data transcribed from the reference PDF ("CryptoEdge Research
// Themes: 54 BTCUSDT Alpha Candidates and Structural Edge Analysis",
// docs/00 §2) into the edges/edge_versions schema (docs/02 §2.5). All 54
// candidates are seeded as origin='pdf_seed', status='IDEA' — the
// platform's job (docs/00 §2.2) is to run each through the Edge
// Evaluation Protocol, not to trust the PDF's star ratings, which are
// carried over verbatim into `priors` for reference only.
//
// `priors` star axes (docs/00 §2.1 footnote): originality / feasibility /
// verifiability / lowCost (inverse of setup cost) / dataEase / durability
// / humanOps, each 1-5.
//
// The five P0 seeds (docs/09 §3) additionally carry a `version` with a
// concrete signal_spec DSL (docs/05 §9) so they can go straight into a
// screen run once transitioned out of IDEA.

export const PDF_EDGES = [
  {
    ref: "001",
    title: "Order Flow Imbalance (OFI) mid-price prediction",
    category: "microstructure",
    hypothesis:
      "Binance perp top-of-book OFI over 1-5 minutes moves mid-price in the same direction.",
    rationale:
      "OFI reflects one-sided pressure that market makers must absorb before re-quoting, creating short-lived directional drift.",
    counterEvidence: "Only shown via correlation (0.94) between futures mid-price and spot order-book imbalance, not a walk-forward backtest.",
    evidence: [{ kind: "paper", ref: "arXiv:2602.00776", note: "Explainable Patterns in Cryptocurrency Microstructure" }],
    priors: { originality: 3, feasibility: 2, verifiability: 3, lowCost: 2, dataEase: 4, durability: 3, humanOps: 2 }
  },
  {
    ref: "002",
    title: "VPIN-based jump prediction",
    category: "microstructure",
    hypothesis: "Elevated VPIN (order-flow toxicity) precedes price jumps with positive serial correlation.",
    rationale: "Informed-trader order flow accumulates before liquidity providers reprice, so toxicity measures lead realized jumps.",
    counterEvidence: "VPIN's volume-bucketing parameterization is a known source of look-ahead/overfitting risk in retrospective studies.",
    evidence: [{ kind: "paper", ref: "ScienceDirect S0275531925004192", note: "VPIN significantly predicts future price jumps" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "003",
    title: "Cross-exchange OFI lead-lag (Coinbase -> Binance)",
    category: "microstructure",
    hypothesis: "Coinbase spot order flow leads Binance futures order flow by a few seconds.",
    rationale: "Coinbase's US-hours liquidity concentration lets its flow inform Binance's global futures market before arbitrage closes the gap.",
    counterEvidence: "Lead-lag windows this short are highly sensitive to venue latency and may have decayed since data collection.",
    evidence: [{ kind: "internal", ref: "Granger causality analysis", note: "Coinbase vs Binance OFI, second-level ticks" }],
    priors: { originality: 4, feasibility: 2, verifiability: 3, lowCost: 3, dataEase: 3, durability: 3, humanOps: 2 }
  },
  {
    ref: "004",
    title: "Order-book depth regression on spread returns",
    category: "microstructure",
    hypothesis: "Binance depth-imbalance regressions forecast very short-horizon spread returns.",
    rationale: "Market-maker inventory skew shows up in depth before it shows up in trades.",
    counterEvidence: "Statistical significance of the regression coefficients has not been established.",
    evidence: [{ kind: "internal", ref: "Binance depth snapshots", note: "spread z-score regression" }],
    priors: { originality: 2, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 2, humanOps: 3 }
  },
  {
    ref: "005",
    title: "CVD / price divergence",
    category: "microstructure",
    hypothesis: "Cumulative Volume Delta diverging from price (delta up, price flat/down) precedes a reversal.",
    rationale: "Persistent one-sided taker aggression that isn't reflected in price implies passive absorption that eventually breaks.",
    counterEvidence: "CVD's absolute level is non-stationary; divergence detection is sensitive to the normalization window chosen.",
    evidence: [{ kind: "internal", ref: "Binance aggTrades CVD", note: "divergence detection heuristic" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "006",
    title: "Liquidation-cascade rebound",
    category: "liquidation",
    hypothesis: "After a large 24h liquidation z-score spike coinciding with an OI drop, BTC rebounds over the next 24-72h.",
    rationale: "Liquidations are price-insensitive forced selling/buying; once the deleveraging is exhausted, the price snaps back toward fair value (Brunnermeier & Pedersen liquidity spiral).",
    counterEvidence: "Binance forceOrder liquidation feed is a 2021+ sampled stream, not a complete record — magnitude estimates are approximate.",
    evidence: [{ kind: "paper", ref: "SSRN 5611392", note: "Oct 2025 cascade analysis, GARCH alpha+beta approx 0.90" }],
    priors: { originality: 4, feasibility: 4, verifiability: 3, lowCost: 3, dataEase: 3, durability: 4, humanOps: 4 },
    p0: true,
    version: {
      semver: "1.0.0",
      direction: "long",
      horizon: "72h",
      when: { and: [{ cmp: [{ feature: "liq_long_z_24h" }, ">", 3] }, { cmp: [{ feature: "oi_chg_24h" }, "<", -5] }] }
    }
  },
  {
    ref: "007",
    title: "Funding rate mean reversion",
    category: "liquidation",
    hypothesis: "Extreme funding rates (top/bottom percentile) revert over the following 8-72h.",
    rationale: "Overcrowded leveraged positioning becomes self-defeating once the funding cost outweighs the directional conviction.",
    counterEvidence: "Cited effect size is modest (beta approx -0.087, R^2 approx 0.003) — most of the variance is unexplained.",
    evidence: [{ kind: "internal", ref: "Fulgur Ventures / SSRN 5576424", note: "BitMEX funding -> next 8h BTC return" }],
    priors: { originality: 2, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 5, durability: 3, humanOps: 4 }
  },
  {
    ref: "008",
    title: "Liquidation heatmap magnet",
    category: "liquidation",
    hypothesis: "Price gravitates toward dense liquidation-cluster levels within a session.",
    rationale: "Market makers and liquidity hunters have an incentive to trigger nearby stop/liquidation clusters, pulling price toward them.",
    counterEvidence: "Precise heatmap granularity requires paid CoinGlass data; free-tier approximations are coarse.",
    evidence: [{ kind: "internal", ref: "CoinGlass heatmap construction", note: "OI + liquidation distance" }],
    priors: { originality: 4, feasibility: 3, verifiability: 2, lowCost: 2, dataEase: 3, durability: 3, humanOps: 3 }
  },
  {
    ref: "009",
    title: "Open interest / price divergence",
    category: "liquidation",
    hypothesis: "Price rising while OI falls (short covering, not new longs) is a weaker, less durable rally than price+OI both rising.",
    rationale: "New-money-driven rallies (rising OI) reflect fresh conviction; covering-driven rallies run out of fuel once shorts are closed.",
    counterEvidence: "Classifying rally 'quality' after the fact is easier than identifying it causally in real time.",
    evidence: [{ kind: "internal", ref: "Binance OI + CoinGlass", note: "OI/return divergence classification" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 4, durability: 3, humanOps: 4 }
  },
  {
    ref: "010",
    title: "Three-exchange basis convergence",
    category: "liquidation",
    hypothesis: "When Binance/OKX/Deribit futures basis diverges beyond a threshold, it converges back within days to weeks.",
    rationale: "Basis is a proxy for aggregate speculative sentiment; cross-exchange arbitrage bounds how far it can persistently diverge.",
    counterEvidence: "CME basis normalization (25% in 2024 to near-zero in 2025 per CF Benchmarks) suggests the historical relationship may be regime-dependent.",
    evidence: [{ kind: "internal", ref: "CF Benchmarks basis series", note: "cross-venue basis convergence" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "011",
    title: "Top-trader long/short ratio extremes",
    category: "liquidation",
    hypothesis: "Extreme top-trader L/S account ratios precede reversals.",
    rationale: "Even 'smart money' cohorts become crowded at extremes, and crowded positioning is fragile to any adverse catalyst.",
    counterEvidence: "The account-ratio metric weights accounts equally regardless of size, which can misrepresent actual capital positioning.",
    evidence: [{ kind: "internal", ref: "Binance topLongShortAccountRatio", note: "extreme-ratio reversal" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 4, durability: 3, humanOps: 4 }
  },
  {
    ref: "012",
    title: "Funding settlement microstructure pattern",
    category: "liquidation",
    hypothesis: "Positioning adjustments immediately before 00:00/08:00/16:00 UTC funding settlement create a predictable micro pattern.",
    rationale: "Traders adjust positions just before settlement to avoid paying/collect funding, creating mechanical, recurring flow.",
    counterEvidence: "Effect size at 1-minute granularity is small and may not clear transaction costs consistently.",
    evidence: [{ kind: "internal", ref: "Binance 1m + fundingRate", note: "pre/post settlement microstructure" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 5, durability: 2, humanOps: 4 }
  },
  {
    ref: "013",
    title: "Variance risk premium (VRP) selling",
    category: "options",
    hypothesis: "Deribit 30-day implied vol (DVOL) systematically exceeds realized vol, so short-vol carries positive expected value.",
    rationale: "Persistent hedging demand from option buyers pays a structural premium to sellers, much like equity index VRP.",
    counterEvidence: "Tail risk is severe and asymmetric — VRP-selling strategies can suffer catastrophic drawdowns in vol spikes (e.g. Mar 2020).",
    evidence: [
      { kind: "paper", ref: "Amberdata/Deribit Insights", note: "IV>RV ~70% of the time since 2019" },
      { kind: "paper", ref: "arXiv:2410.15195", note: "Bitcoin VRP exceeds S&P 500's" }
    ],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 4, humanOps: 3 },
    // docs/09 §3: V1 keeps this as an observation-only dashboard metric
    // (options_surface.vrp), not a tradeable signal_spec — the DSL's
    // signal_spec.direction enum (long/short/signal_sign, docs/05 §9) has
    // no "vol" variant, and delta-hedged execution is out of scope for V1
    // (roadmap: "戦略化はV2判断"). Stays IDEA with no edge_version.
    p0: true
  },
  {
    ref: "014",
    title: "25-delta skew as a realized-vol forecaster",
    category: "options",
    hypothesis: "Option skew predicts next-period realized volatility (not returns) at weekly frequency.",
    rationale: "Skew encodes the market's tail-hedging demand, which correlates with near-term realized turbulence even when it says nothing about direction.",
    counterEvidence: "The same study finds skew has no predictive power for returns, only for volatility — direction-based use would be a misapplication.",
    evidence: [{ kind: "paper", ref: "Chen, Deng & Nie 2024, Operations Research Letters", note: "skew forecasts weekly RV, not returns" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "015",
    title: "25-delta risk-reversal selling",
    category: "options",
    hypothesis: "Selling the 25-delta risk reversal (short calls, long puts, or vice versa depending on skew sign) has the best risk-adjusted return among simple option overlays.",
    rationale: "Persistent one-sided directional hedging demand keeps skew rich, similar to the VRP mechanism.",
    counterEvidence: "The source result appears to be dominated by the March 2020 'Black Thursday' tail event; excluding that outlier needs separate verification.",
    evidence: [{ kind: "paper", ref: "Amberdata", note: "risk-reversal selling has best risk-adjusted return" }],
    priors: { originality: 3, feasibility: 2, verifiability: 2, lowCost: 2, dataEase: 4, durability: 3, humanOps: 2 }
  },
  {
    ref: "016",
    title: "Dealer gamma exposure (GEX) regime",
    category: "options",
    hypothesis: "Dealer gamma positioning (long/short gamma regime) predicts volatility amplification vs. dampening.",
    rationale: "In a short-gamma regime, dealer hedging is pro-cyclical (buys rallies, sells dips), amplifying moves; long-gamma dampens them.",
    counterEvidence: "GEX is a modeled/estimated quantity, not directly observable, and different providers' estimates can disagree materially.",
    evidence: [{ kind: "paper", ref: "Bitfinex Alpha", note: "2026 dealer gamma estimate, ~-143,000 BTC net" }],
    priors: { originality: 5, feasibility: 2, verifiability: 2, lowCost: 3, dataEase: 3, durability: 4, humanOps: 2 }
  },
  {
    ref: "017",
    title: "Options expiry (SQ) / max-pain gravitational pull",
    category: "options",
    hypothesis: "Price drifts toward the max-pain strike before large options expiries, then can reverse sharply once the pin risk unwinds.",
    rationale: "Dealer hedging flow near a large expiry creates a pull toward the strike that minimizes aggregate option payout.",
    counterEvidence: "The 'pin' effect competes with dealer gamma regime (EC-016); the two need to be studied jointly rather than in isolation.",
    evidence: [{ kind: "internal", ref: "Deribit OI + CoinGlass", note: "expiry-window volatility/return decomposition" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 3, durability: 3, humanOps: 3 }
  },
  {
    ref: "018",
    title: "21:00-23:00 UTC intraday drift",
    category: "seasonality",
    hypothesis: "BTC has a statistically positive return in the 21:00-23:00 UTC window, in a bull (above 200-day SMA) regime.",
    rationale: "US-afternoon/evening liquidity and flow patterns recur daily; QuantPedia documents +33% annualized return isolating this window.",
    counterEvidence: "Pure calendar-effect data mining risk is high; must be confirmed out of the 2020-heavy sample and re-verified against ETF-era flow changes.",
    evidence: [{ kind: "paper", ref: "QuantPedia: The Seasonality of Bitcoin", note: "21:00-23:00 UTC window, ~33% annualized" }],
    priors: { originality: 3, feasibility: 5, verifiability: 5, lowCost: 2, dataEase: 5, durability: 3, humanOps: 5 },
    p0: true,
    version: {
      semver: "1.0.0",
      direction: "long",
      horizon: "2h",
      when: { and: [{ time: { utc_hour_in: [21, 22] } }, { regime: { trend: ["up"] } }] }
    }
  },
  {
    ref: "019",
    title: "Monday Asia-open effect",
    category: "seasonality",
    hypothesis: "BTC shows a recurring directional tendency around the Monday 19:00 UTC (Asia funding-market open) window.",
    rationale: "Weekend illiquidity resolves as Asian institutional flow returns at the start of the week.",
    counterEvidence: "Effect timing was matched to a 2020-era study; needs reverification post-ETF given shifted market structure.",
    evidence: [{ kind: "paper", ref: "Concretum Group: Monday Asia Open Effect", note: "matches 2020-era timing" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 5, durability: 3, humanOps: 3 }
  },
  {
    ref: "020",
    title: "NYSE-open day-of-week effect",
    category: "seasonality",
    hypothesis: "Return decomposition into intraday vs. overnight legs around NYSE open shows a day-of-week pattern with overnight-heavy weeks.",
    rationale: "Traditional-market participants' hedging/rebalancing bleeds into crypto trading hours at the NYSE open.",
    counterEvidence: "Intraday/overnight decomposition is sensitive to how the boundary is defined.",
    evidence: [{ kind: "paper", ref: "Padysak & Vojtko, paperswithbacktest", note: "NYSE-open overnight/intraday decomposition" }],
    priors: { originality: 4, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 5, durability: 3, humanOps: 4 }
  },
  {
    ref: "021",
    title: "CME futures gap fill",
    category: "seasonality",
    hypothesis: "CME BTC futures gaps (Friday close vs. Sunday open) fill within a bounded window at a high rate, especially small gaps.",
    rationale: "CME trades a five-day week while spot trades 24/7; the mismatch mechanically creates gaps that magnet-fill as spot/futures arbitrage re-links the two.",
    counterEvidence: "Large gaps (>5%) fill far less reliably (~52%) than small ones (~92% for <2% gaps); position sizing must respect this.",
    evidence: [{ kind: "paper", ref: "Phemex / Bitget gap-fill statistics", note: "~77% overall fill rate 2018-2026; <2% gaps ~92% within 30 days" }],
    priors: { originality: 3, feasibility: 5, verifiability: 5, lowCost: 4, dataEase: 4, durability: 4, humanOps: 5 },
    p0: true,
    version: {
      semver: "1.0.0",
      direction: "long",
      horizon: "72h",
      when: { event: { type: "cme_gap", min_magnitude: 0 } }
    }
  },
  {
    ref: "022",
    title: "Month-end rebalance flow",
    category: "seasonality",
    hypothesis: "BTC shows recurring flow around month-end, consistent with institutional rebalancing.",
    rationale: "Index-tracking and multi-asset portfolios rebalance on a monthly cycle, creating recurring calendar-linked flow.",
    counterEvidence: "This is more speculative than the other seasonality candidates; needs a dedicated event study before further investment.",
    evidence: [{ kind: "internal", ref: "Binance daily return + calendar", note: "month-end return decomposition" }],
    priors: { originality: 2, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 5, durability: 3, humanOps: 4 }
  },
  {
    ref: "023",
    title: "Weekly breakout continuation",
    category: "seasonality",
    hypothesis: "Breakouts from the prior week's range tend to continue rather than mean-revert.",
    rationale: "Weekly ranges concentrate accumulated positioning; a genuine breakout reflects a real supply/demand shift rather than noise.",
    counterEvidence: "Breakout-continuation strategies are a well-known crowded style; edge durability is uncertain.",
    evidence: [{ kind: "internal", ref: "Binance weekly range breakout", note: "continuation-vs-reversion study" }],
    priors: { originality: 2, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 5, durability: 2, humanOps: 4 }
  },
  {
    ref: "024",
    title: "Coinbase premium as an ETF-flow proxy",
    category: "etf_flow",
    hypothesis: "The Coinbase/Binance price premium correlates with US spot ETF net flows and can serve as a real-time proxy before official flow data is published.",
    rationale: "Coinbase is the primary US institutional on-ramp and ETF authorized-participant venue, so its premium reflects US buying pressure ahead of official reporting.",
    counterEvidence: "Correlation with ETF flow is moderate (R^2 approx 0.32), so the proxy is noisy on any single day.",
    evidence: [{ kind: "internal", ref: "ainvest analysis", note: "Coinbase premium vs US ETF net flow, R^2~0.32" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 4, durability: 3, humanOps: 4 }
  },
  {
    ref: "025",
    title: "ETF T+1 sell pressure",
    category: "etf_flow",
    hypothesis: "Large ETF creation/redemption activity produces spot sell pressure via Coinbase Prime the following trading day (T+1 settlement).",
    rationale: "Authorized participants source/dispose of BTC through Coinbase Prime on a T+1 cycle, so flow effects on spot lag the official ETF flow print by one day.",
    counterEvidence: "Evidence is a single illustrative case (IBIT ~2,791 BTC), not a systematic backtest.",
    evidence: [{ kind: "internal", ref: "SoSoValue/ETF flow + Coinbase next-day return", note: "T+1 sell-pressure case study" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 3, durability: 3, humanOps: 3 }
  },
  {
    ref: "026",
    title: "ETF flow / sentiment divergence",
    category: "etf_flow",
    hypothesis: "When Fear & Greed is fearful but ETF inflows continue, that divergence (institutions accumulating into retail fear) precedes upside.",
    rationale: "Institutional ETF buyers on multi-day mandates are less reactive to short-term sentiment swings than retail, so their continued buying against fear is informative.",
    counterEvidence: "Sentiment-vs-flow divergence signals are inherently low-frequency and sample-limited (ETFs only exist since 2024).",
    evidence: [{ kind: "internal", ref: "alternative.me F&G + ETF flow", note: "divergence-conditioned forward return" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 4, durability: 3, humanOps: 4 }
  },
  {
    ref: "027",
    title: "CME COT positioning reversal",
    category: "etf_flow",
    hypothesis: "Extreme CFTC Commitment of Traders net positioning (Leveraged Funds vs. Asset Managers) precedes reversals.",
    rationale: "Leveraged funds represent short-term speculative positioning that becomes a forced-unwind risk once sufficiently crowded.",
    counterEvidence: "COT data is weekly and reported with a lag, limiting timing precision.",
    evidence: [{ kind: "internal", ref: "CFTC COT + CoinGlass CFTC", note: "extreme-positioning reversal" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "028",
    title: "Exchange netflow signal",
    category: "onchain",
    hypothesis: "Large net inflows to exchanges precede downside (deposit-to-sell); net outflows precede upside (accumulation).",
    rationale: "Moving coins onto an exchange is a necessary precondition for selling on that exchange, so netflow is a leading indicator of intent.",
    counterEvidence: "Free-tier data cannot label exchange wallets precisely, limiting classification accuracy versus paid providers.",
    evidence: [{ kind: "internal", ref: "Glassnode (free tier) / CryptoQuant", note: "netflow-conditioned forward return" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 2, durability: 3, humanOps: 3 }
  },
  {
    ref: "029",
    title: "Whale Alert transfer reaction",
    category: "onchain",
    hypothesis: "Large publicized whale transfers spark a short-horizon (6-24h) volatility/return spillover as the market reacts to the alert.",
    rationale: "Whale Alert's wide Telegram distribution makes large transfers a shared, salient signal that triggers a reflexive trading reaction, independent of the transfer's true intent.",
    counterEvidence: "The spillover is a reaction to the *alert* being seen, not necessarily to the underlying transfer's economic meaning — a purely reflexive, possibly decaying effect.",
    evidence: [{ kind: "paper", ref: "Magner & Sanhueza 2025, Finance Research Letters", note: "spillover rises from 2.78% at 1h to 4.68% at 24h" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 3, durability: 3, humanOps: 3 }
  },
  {
    ref: "030",
    title: "Exchange whale ratio",
    category: "onchain",
    hypothesis: "A high ratio of top-10-wallet inflow to total exchange inflow (concentration among whales) precedes distribution/selling.",
    rationale: "Concentrated large-wallet deposits are more likely to represent a single actor's imminent sell decision than broad-based small-wallet deposits.",
    counterEvidence: "Claimed threshold ('>85% precedes selling') needs independent verification; the source notes it as anecdotal.",
    evidence: [{ kind: "internal", ref: "CryptoQuant Exchange Whale Ratio", note: "ratio-conditioned forward return" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 2, dataEase: 2, durability: 3, humanOps: 3 }
  },
  {
    ref: "031",
    title: "USDT mint event drift",
    category: "stablecoin",
    hypothesis: "Large USDT Treasury mint events produce a positive BTC drift over 5-30 minutes that decays after 60 minutes; burns show no comparable (asymmetric) effect.",
    rationale: "New stablecoin issuance is a precondition for fresh exchange buying power; the FOMO/anticipation reaction to a well-publicized mint (via Whale Alert) amplifies the pure liquidity effect.",
    counterEvidence: "Griffin & Shams' (2020) Tether-manipulation hypothesis has a published rebuttal (Wei 2018) finding minting cannot move price — the mechanism is contested, so treat as a short-horizon (<=60min) event effect, not a structural thesis.",
    evidence: [{ kind: "paper", ref: "Saggu 2022, Finance Research Letters vol.49", note: "+0.24% at 5min, +0.68% at 30min, decaying by 60min" }],
    priors: { originality: 5, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 3, durability: 3, humanOps: 3 },
    p0: true,
    version: {
      semver: "1.0.0",
      direction: "long",
      horizon: "30m",
      when: { event: { type: "usdt_mint", min_magnitude: 1000000000 } }
    }
  },
  {
    ref: "032",
    title: "Stablecoin Supply Ratio (SSR) low reversal",
    category: "stablecoin",
    hypothesis: "A low SSR (large stablecoin 'dry powder' relative to BTC market cap) precedes upside as that capital deploys.",
    rationale: "Stablecoin balances represent capital parked on the sidelines ready to buy; when that pool is large relative to BTC's cap, incremental buying power is high.",
    counterEvidence: "SSR is a slow-moving macro-liquidity indicator; timing precision at anything shorter than weeks is unlikely.",
    evidence: [{ kind: "internal", ref: "CryptoQuant / DefiLlama SSR", note: "low-SSR-conditioned forward return" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 4, durability: 3, humanOps: 4 }
  },
  {
    ref: "033",
    title: "Stablecoin issuance acceleration",
    category: "stablecoin",
    hypothesis: "An accelerating (not just positive) growth rate in total stablecoin supply precedes BTC inflow over days to weeks.",
    rationale: "Acceleration (second derivative) captures a regime change in capital formation intent more cleanly than the level or first-difference alone.",
    counterEvidence: "DefiLlama's stablecoin supply series is itself subject to periodic revisions (bitemporal handling required, docs/02 §1).",
    evidence: [{ kind: "internal", ref: "DefiLlama stablecoin supply, second derivative", note: "acceleration-conditioned forward return" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 4, durability: 3, humanOps: 4 }
  },
  {
    ref: "034",
    title: "USDT depeg risk-off signal",
    category: "stablecoin",
    hypothesis: "USDT trading meaningfully below $1 (depeg) precedes a BTC decline as capital flees stablecoins broadly (flight to safety away from crypto, not into BTC).",
    rationale: "A stablecoin depeg signals systemic/counterparty stress in crypto market infrastructure, prompting broad de-risking rather than rotation.",
    counterEvidence: "Depeg events are rare and each has idiosyncratic causes (e.g., banking-sector contagion in 2023); generalizability across events is unproven.",
    evidence: [{ kind: "internal", ref: "Binance USDT/USDC + CoinGecko", note: "depeg-event forward return" }],
    priors: { originality: 3, feasibility: 4, verifiability: 3, lowCost: 3, dataEase: 4, durability: 2, humanOps: 4 }
  },
  {
    ref: "035",
    title: "Nasdaq cross-asset regime linkage",
    category: "cross_asset",
    hypothesis: "BTC-Nasdaq correlation strengthens in risk-off regimes; the correlation regime itself (not the raw correlation) is informative.",
    rationale: "As ETF ownership has grown, BTC increasingly trades as a high-beta macro-risk asset during stress, tightening its equity linkage.",
    counterEvidence: "A Chow test finds a structural break around ETF approval, meaning the pre/post relationship cannot be pooled naively.",
    evidence: [{ kind: "paper", ref: "arXiv:2512.12815", note: "Chow test structural break, BTC-S&P500, p=0.0000" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "036",
    title: "DXY correlation regime",
    category: "cross_asset",
    hypothesis: "BTC/DXY correlation is regime-dependent and only informative for direction while the regime is stably negative.",
    rationale: "Dollar strength/weakness is a standard macro-liquidity proxy, but the BTC linkage strengthens/weakens with the prevailing macro narrative.",
    counterEvidence: "Correlation dropped from ~0.7 (2014-2020) to ~0.45 recently per JPMorgan (2026); using this without regime-conditioning would be unstable.",
    evidence: [{ kind: "internal", ref: "FRED DXY + Binance, OSL / JPMorgan commentary", note: "correlation regime shift" }],
    priors: { originality: 2, feasibility: 3, verifiability: 3, lowCost: 2, dataEase: 4, durability: 2, humanOps: 3 }
  },
  {
    ref: "037",
    title: "Global M2 liquidity linkage",
    category: "cross_asset",
    hypothesis: "Changes in global M2 money supply lead BTC price with a multi-week lag, as a liquidity-driven risk asset.",
    rationale: "BTC behaves as a liquidity-sensitive, long-duration risk asset, so aggregate money-supply expansion/contraction should lead it the way it leads other risk assets.",
    counterEvidence: "M2 data is low-frequency (monthly) and revised, making this only useful as a slow-moving conditioning variable, not a standalone signal.",
    evidence: [{ kind: "internal", ref: "FRED M2 + TradingEconomics + Binance", note: "lagged M2-BTC relationship" }],
    priors: { originality: 3, feasibility: 3, verifiability: 2, lowCost: 2, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "038",
    title: "Round-number price clustering",
    category: "behavioral",
    hypothesis: "Prices cluster at round numbers ($1,000 increments) due to anchoring and stop/limit placement, but returns after touching a round number show no significant pattern.",
    rationale: "Anchoring bias (Harris 1991-style round-number effect) drives order placement to cluster at round levels.",
    counterEvidence: "The source paper explicitly finds no significant return pattern after round-number touches — clustering is real, but not directly tradeable as stated.",
    evidence: [{ kind: "paper", ref: "Urquhart 2017, Economics Letters vol.159", note: "10.81% of Bitstamp prices end in 00; no significant post-touch return pattern" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "039",
    title: "Price momentum continuation",
    category: "behavioral",
    hypothesis: "Recent multi-day/weekly momentum continues rather than reverts, driven by attention and FOMO/short-covering dynamics.",
    rationale: "Rising attention begets more attention (media, social, search) which begets more buying, a reflexive momentum loop distinct from fundamentals.",
    counterEvidence: "Momentum is one of the most widely exploited styles in all of finance; crowding risk is high and durability is uncertain.",
    evidence: [{ kind: "internal", ref: "Binance daily/weekly momentum", note: "continuation-conditioned forward return" }],
    priors: { originality: 2, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 5, durability: 3, humanOps: 4 }
  },
  {
    ref: "040",
    title: "Google Trends overheat / FOMO fade",
    category: "behavioral",
    hypothesis: "A sharp spike in 'Bitcoin' search volume marks retail FOMO and precedes a local top / pullback.",
    rationale: "Retail search interest peaks near euphoric tops as media coverage and word-of-mouth attention lag the actual price move.",
    counterEvidence: "Prior literature (arXiv:1408.1494) finds search spikes preceded *declines*, but the causal direction (search causing price vs. price causing search) is unresolved.",
    evidence: [{ kind: "paper", ref: "arXiv:1408.1494", note: "search-volume spikes precede price declines" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 2, dataEase: 4, durability: 2, humanOps: 3 }
  },
  {
    ref: "041",
    title: "Pre-FOMC drift",
    category: "event",
    hypothesis: "BTC rises the day before an FOMC announcement and falls on the announcement day itself.",
    rationale: "Pre-announcement risk premium / information-leakage dynamics (Cieslak, Morse & Vissing-Jorgensen 2019) documented in equities extend to BTC's now-more-macro-linked behavior.",
    counterEvidence: "Effect size (~+0.96% pre-day, ~-1% announcement day) is modest relative to typical daily BTC volatility.",
    evidence: [{ kind: "paper", ref: "Pyo & Lee 2020, Finance Research Letters vol.37", note: "+0.96% day before, -1% on announcement day" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 3, dataEase: 5, durability: 3, humanOps: 4 }
  },
  {
    ref: "042",
    title: "'Sell the news' FOMC drift",
    category: "event",
    hypothesis: "BTC tends to decline in the 48h after an FOMC announcement, regardless of the actual decision content.",
    rationale: "Pre-positioned expectations ('buy the rumor') unwind mechanically once the event passes, independent of whether the news itself was hawkish or dovish.",
    counterEvidence: "Cited support (7 of 8 2025 FOMC meetings) is a small, recency-dependent sample from a single secondary source, not an independently reproduced study.",
    evidence: [{ kind: "internal", ref: "Coinmonks analysis", note: "7 of 8 2025 FOMC meetings showed post-announcement decline" }],
    priors: { originality: 3, feasibility: 4, verifiability: 4, lowCost: 2, dataEase: 5, durability: 2, humanOps: 4 }
  },
  {
    ref: "043",
    title: "CPI / macro-print volatility compression",
    category: "event",
    hypothesis: "BTC realized volatility compresses ahead of major macro data prints (CPI, PPI, FOMC) and expands afterward.",
    rationale: "Pre-print positioning caution suppresses realized moves; the print's resolution of uncertainty releases pent-up volatility.",
    counterEvidence: "BTC vol responds meaningfully to only about 10 of 29 tested macro indicators — most prints show no measurable effect.",
    evidence: [{ kind: "paper", ref: "ScienceDirect S1059056025006720", note: "significant vol response to CPI/PPI/FOMC among 29 tested indicators" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "044",
    title: "Altcoin sideways-breakout drift (BTC pair)",
    category: "event",
    hypothesis: "Range breakouts in major altcoin/BTC pairs show a recurring statistical pattern relevant to BTC-denominated flow.",
    rationale: "Attention and liquidity rotation between BTC and alts follows recurring cyclical patterns tied to relative-strength breakouts.",
    counterEvidence: "This is the least developed candidate in the set — needs a dedicated event study before further investment.",
    evidence: [{ kind: "internal", ref: "exchange-provided BTC-pair data", note: "breakout-conditioned forward return" }],
    priors: { originality: 2, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 3, durability: 2, humanOps: 3 }
  },
  {
    ref: "045",
    title: "GARCH volatility-regime clustering",
    category: "vol_regime",
    hypothesis: "BTC volatility exhibits strong GARCH clustering (alpha+beta approx 0.90), so regime persistence itself is a tradeable/conditioning signal.",
    rationale: "Volatility clustering reflects persistent information flow and position-sizing feedback; once elevated, vol tends to stay elevated.",
    counterEvidence: "High persistence (alpha+beta near 1) implies near-integrated variance, making regime-switch timing (not just clustering) the harder, unsolved part.",
    evidence: [{ kind: "paper", ref: "SSRN 5611392", note: "GARCH alpha+beta ~0.90 persistence" }, { kind: "paper", ref: "Takaishi 2021, PLOS ONE", note: "regime-switching GARCH" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 5, durability: 4, humanOps: 3 }
  },
  {
    ref: "046",
    title: "Inverted leverage effect (BTC vol asymmetry)",
    category: "vol_regime",
    hypothesis: "Unlike equities, BTC volatility reacts more to positive returns than negative ones (inverted asymmetry).",
    rationale: "Crypto's buy-side FOMO/momentum-chasing dynamic dominates over the equity-style leverage effect (where negative returns raise vol more).",
    counterEvidence: "Effect is documented on an earlier, smaller BTC market; needs reverification on the current, more institutionally-dominated market structure.",
    evidence: [{ kind: "paper", ref: "Takaishi 2021, PLOS ONE", note: "inverted asymmetry: vol reacts more to positive returns" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 5, durability: 3, humanOps: 3 }
  },
  {
    ref: "047",
    title: "Jump dynamics via Lee-Mykland detection",
    category: "vol_regime",
    hypothesis: "Statistically detected price jumps (Lee-Mykland test) cluster with order-flow-imbalance extremes, i.e. jumps are partly information-driven and partly liquidity-driven.",
    rationale: "Jumps reflect either genuine information shocks or a liquidity air-pocket; distinguishing the two via OFI context could make jump risk partially forecastable.",
    counterEvidence: "Historical illustrative case (Mt. Gox) is an extreme, non-representative tail event.",
    evidence: [{ kind: "internal", ref: "Lee-Mykland jump detection + Binance", note: "jump/OFI co-occurrence" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "048",
    title: "Session open/close volatility seasonality",
    category: "vol_regime",
    hypothesis: "5-minute realized volatility peaks around the 12:00 EST US equity session open/close, tracking traditional-market session boundaries.",
    rationale: "Traditional-market session boundaries concentrate institutional order flow even in a 24/7 crypto market, since much liquidity still originates from US-hours desks.",
    counterEvidence: "Effect is one of the most robust in the set (durability 4, verifiability 4) but has limited standalone trading value (vol timing, not direction).",
    evidence: [{ kind: "paper", ref: "ScienceDirect S1059056025006720", note: "5-min vol peaks at 12:00 EST session open/close" }],
    priors: { originality: 2, feasibility: 4, verifiability: 4, lowCost: 4, dataEase: 5, durability: 4, humanOps: 4 }
  },
  {
    ref: "049",
    title: "Perp/spot volume ratio leverage regime",
    category: "cross_venue",
    hypothesis: "A high perp/spot traded-volume ratio signals leverage-dominated (fragile) markets prone to sharp reversals.",
    rationale: "When derivatives volume dwarfs spot, price discovery is leverage-driven rather than cash-driven, raising the risk of a forced-deleveraging reversal.",
    counterEvidence: "Bybit's perp share is already structurally very high (~92.5%) most of the time, so the 'high ratio' threshold needs careful, venue-specific calibration.",
    evidence: [{ kind: "internal", ref: "CCN / Kapar & Olmo", note: "perp/spot ratio ~60-80% typical range" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "050",
    title: "Cross-exchange funding divergence",
    category: "cross_venue",
    hypothesis: "Persistent funding-rate divergence between Binance/Bybit/OKX/Hyperliquid is informative about structural, venue-specific positioning imbalances.",
    rationale: "Different venues attract different trader cohorts (retail vs. pro, regional bases), so persistent divergence reflects real segmentation, not just noise.",
    counterEvidence: "A cited industry view holds such divergences 'often reflect structural design differences... rather than arbitrageable mispricings' — treat as a conditioning variable, not a standalone arbitrage.",
    evidence: [{ kind: "internal", ref: "MetaMask commentary + exchange funding APIs", note: "cross-venue funding divergence" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 2, humanOps: 3 }
  },
  {
    ref: "051",
    title: "Hyperliquid on-chain positioning transparency",
    category: "cross_venue",
    hypothesis: "Hyperliquid's fully on-chain order book/position data (unavailable on CEXs) gives an information edge on aggregate positioning.",
    rationale: "Full transaction/position transparency on an L1 orderbook is structurally unique among major derivatives venues.",
    counterEvidence: "Hyperliquid is a newer, smaller venue; whether its positioning generalizes to broader market structure is unproven.",
    evidence: [{ kind: "internal", ref: "coinmarketman + Hyperliquid public API", note: "on-chain position-distribution tracking" }],
    priors: { originality: 5, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 4, durability: 3, humanOps: 3 }
  },
  {
    ref: "052",
    title: "Kimchi premium (Korea exchange spread)",
    category: "cross_venue",
    hypothesis: "The Upbit/Bithumb vs. global exchange price premium ('kimchi premium') reflects Korean retail sentiment and capital-control friction.",
    rationale: "Korean won capital controls prevent frictionless arbitrage, so the premium is a persistent, regionally-segmented retail-sentiment gauge.",
    counterEvidence: "KRW/USD conversion adds an FX-timing dependency to the signal.",
    evidence: [{ kind: "internal", ref: "Upbit/Bithumb + Binance + FRED KRW/USD", note: "premium-conditioned forward return" }],
    priors: { originality: 3, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 3, durability: 2, humanOps: 3 }
  },
  {
    ref: "053",
    title: "Regional CEX flow divergence (Coinbase vs. Binance)",
    category: "cross_venue",
    hypothesis: "Coinbase-led moves (US hours) vs. Binance-led moves (global/Asia hours) have systematically different follow-through characteristics.",
    rationale: "Regional flow originates from different trader cohorts (US institutional via Coinbase vs. global retail/leverage via Binance) with different persistence.",
    counterEvidence: "Attribution of 'which exchange led' is itself a modeling choice sensitive to the lead-lag window used.",
    evidence: [{ kind: "internal", ref: "cross-exchange aggTrades", note: "lead-exchange-conditioned forward return" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 3, dataEase: 3, durability: 3, humanOps: 3 }
  },
  {
    ref: "054",
    title: "ETH cross-sectional feature transfer from BTC",
    category: "cross_venue",
    hypothesis: "Microstructure features (OFI, etc.) learned on BTC transfer to ETH and other large-cap assets, implying a scale-invariant microstructure mechanism.",
    rationale: "If order-flow-imbalance dynamics are a structural feature of centralized limit order books rather than BTC-specific, the same feature ranking/SHAP importance should hold across assets.",
    counterEvidence: "Source study's cross-asset set (BTC, LTC, ETC, ENJ, ROSE) is heterogeneous in liquidity; ETH-specific generalization still needs direct testing.",
    evidence: [{ kind: "paper", ref: "arXiv:2602.00776", note: "feature ranking/SHAP stable across BTC, LTC, ETC, ENJ, ROSE" }],
    priors: { originality: 4, feasibility: 3, verifiability: 3, lowCost: 4, dataEase: 4, durability: 4, humanOps: 3 }
  }
];
