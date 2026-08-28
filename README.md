# Price Prediction Terminal

Production-ready, responsive, real-time technical analysis and **deterministic**
price projection terminal for BTC/USD, XAU/USD, ETH/USDT, and ETH/BTC. Built with
Next.js 14 + TypeScript, designed to deploy to Vercel with zero backend costs.

**No AI is used at runtime.** All signals, scores, levels, zones, structures,
projections, and liquidation estimates are computed by deterministic algorithms
running entirely in the browser (or in a Web Worker for heavy analysis).

## Features

- **Real-time market data** via pluggable providers (Binance public REST + WebSocket,
  CoinGecko REST as fallback). The Vercel-deployed app uses Next.js API routes as
  CORS-bypassing proxies; no API key required.
- **Professional trading chart** built on `lightweight-charts` with candlesticks,
  line, area, OHLC, volume, crosshair, zoom/pan (mouse + touch), fullscreen,
  current-price tag, and OHLC legend.
- **22 technical indicators** (SMA, EMA, WMA, VWAP, MACD, ADX, Supertrend, RSI,
  Stochastic RSI, Stochastic, CCI, ROC, Williams %R, MFI, ATR, Bollinger Bands +
  Width, Keltner, Volume, Volume SMA, OBV, CMF) — every indicator can be
  enabled/disabled, configured, and color-tuned.
- **SNR / Support & Resistance engine**: horizontal S/R, swing-based levels,
  previous-period high/low/close, psychological round numbers, clustering
  with strength scoring.
- **SND / Supply & Demand engine**: base-rally, base-drop, RBR, DBD patterns
  with fresh / tested / broken status.
- **Market structure engine**: HH / HL / LH / LL / EQH / EQL + BOS / CHOCH
  detection and liquidity sweeps.
- **Fibonacci tools**: auto retracement, auto extension, manual drawing.
- **Drawing tools**: trendline, ray, horizontal/vertical line, rectangle,
  fib retracement / extension, arrow, text, measure.
- **5 deterministic strategies**: trend-following, mean-reversion, breakout,
  supply/demand, multi-timeframe trend.
- **Weighted scoring** (8 categories, all configurable) with a 7-step bias
  label (Strong Bullish → Strong Bearish).
- **Technical projection**: entry zone, support / resistance, TP1 / TP2 / TP3,
  invalidation, risk/reward, expected volatility, and an explicit disclaimer.
- **Multi-timeframe dashboard** with weighted bias across 1D / 4H / 1H / 15M / 5M.
- **Liquidation heatmap** (Binance USDⓈ-M Futures): live `forceOrder`
  WebSocket stream + REST history + a deterministic synthetic fallback derived
  from public Open Interest, Funding Rate, L/S Ratio, Taker Buy/Sell Ratio,
  and mark price.
- **Alerts** (client-side, browser notifications) for price-cross, BOS, CHOCH,
  RSI threshold, MACD / EMA crossover, SNR break, S/D entry, strategy signal.
- **Local persistence** via Zustand persist + IndexedDB cache.
- **Responsive**: full desktop 3-column layout, dedicated mobile bottom-tab
  layout, dark / light theme, touch-friendly.

## Data sources (all free, no API key)

| Source | What | Auth |
|---|---|---|
| Binance Spot | Candles, ticker | public |
| Binance USDⓈ-M Futures | Open Interest, funding rate, mark price, L/S ratio, taker buy/sell, top trader ratio, **force orders (liquidations)** | public |
| CoinGecko | Historical candles, ticker, supply data | free tier (rate-limited) |

The futures REST + WebSocket endpoints used by the liquidation heatmap:

- `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=...`
- `https://fapi.binance.com/fapi/v1/allForceOrders?symbol=...`
- `https://fapi.binance.com/futures/data/openInterestHist?symbol=...`
- `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=...`
- `https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=...`
- `wss://fstream.binance.com/ws/<symbol>@forceOrder` (real-time liquidations)

The browser fetches these through a `/api/futures/[...path]` Next.js route
that adds CORS + cache headers + a per-IP token bucket. **No API key
required for any of these.**

## Running locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Scripts

- `npm run dev` — Next.js dev server
- `npm run build` — production build
- `npm run start` — production server
- `npm run lint` — ESLint
- `npm run typecheck` — `tsc --noEmit`
- `npm run test` — Vitest (386 tests)

## Project layout

```
src/
├── app/                  # Next.js App Router (pages + API proxies)
│   ├── api/{binance,coingecko,futures}/[...path]/route.ts
│   ├── layout.tsx
│   ├── page.tsx
│   └── globals.css
├── components/
│   ├── chart/            # lightweight-charts wrapper
│   ├── dashboard/        # Header, Sidebar, ChartArea, RightPanel
│   ├── indicators/       # Indicator panel
│   ├── overlays/         # Overlay toggles
│   ├── drawings/         # Drawing tools
│   ├── alerts/           # Alerts UI
│   ├── strategies/       # Strategies UI
│   ├── signals/          # ScorePanel, ProjectionPanel, LevelsPanel,
│   │                     # MarketStructurePanel, SignalsPanel, LiquidationHeatmapPanel
│   ├── mtf/              # Multi-timeframe dashboard
│   └── mobile/           # Mobile tab-bar layout
├── core/                 # Deterministic analysis engines
│   ├── indicators/       # 22 indicator implementations + dispatcher
│   ├── snr/              # Support & resistance detection
│   ├── snd/              # Supply & demand zone detection
│   ├── market-structure/ # Swings, BOS/CHOCH, liquidity
│   ├── strategies/       # 5 strategy engines
│   ├── scoring/          # Weighted scoring + breakdown
│   ├── prediction/       # Technical projection builder
│   ├── mtf/              # Multi-timeframe analyzer
│   ├── fibonacci/        # Auto + manual Fibonacci
│   └── utils/            # Numeric + candle helpers
├── market-data/
│   ├── cache.ts          # IndexedDB historical cache
│   ├── alerts-engine.ts  # Client-side alert evaluator
│   ├── liquidation-heatmap.ts  # Synthesis + REST fetcher
│   └── liquidation-stream.ts   # WebSocket subscription
├── providers/            # Binance + CoinGecko + manager
├── hooks/                # useProviderManager, useAnalysisWorker,
│                         # useLiquidationHeatmap, useMediaQuery, …
├── stores/               # zustand stores (settings, market, drawings,
│                         # alerts, liquidations)
├── workers/              # Web worker for heavy analysis
├── types/                # All shared TypeScript types
├── config/               # Symbol definitions, scoring defaults
└── styles/               # Globals
```

## License

MIT
