# Forex Signal AI Pro v4

## What changed
- 5m + 15m + 1h + 4h + Daily multi-timeframe engine.
- 4h is resampled from 1h candles to avoid requiring a separate provider endpoint.
- Swing-high/low structure and liquidity high/low sweep detection.
- Dynamic support/resistance clustering around recent pivots using ATR tolerance.
- London / New York session filter configuration.
- News-risk blocking window using Alpha Vantage NEWS_SENTIMENT.
- ATR/RSI/EMA/ADX regime and trend features.
- Risk-aware simulated fills with configurable spread/slippage.
- Backtest metrics: trades, win rate, expectancy in R, profit factor, max drawdown, ending equity.
- Walk-forward validation with multiple chronological folds.
- Persistent paper-trading book and trade journal in `data/`.
- Same signal logic is exposed through API endpoints for future broker adapters.

## Run
1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Put your Alpha Vantage key in `.env`.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000`.

## Important quant caveats
This is a research/paper-trading framework, not a profit guarantee. Alpha Vantage free/limited plans can restrict history and API frequency. Candle-only data cannot reproduce true bid/ask microstructure, real spread changes, fills, latency, or news-event execution. Before live use, add a broker adapter, broker-native bid/ask data, order-state reconciliation, hard risk limits at the broker, and independent monitoring.

The backtest currently uses the same deterministic signal rules and configurable spread/slippage assumptions; it does not claim institutional-grade execution simulation.


## API
- `GET /api/health`
- `GET /api/analyze?pair=EURUSD`
- `GET /api/news?pair=EURUSD`
- `GET /api/backtest?pair=EURUSD&tf=d1`
- `GET /api/walk-forward?pair=EURUSD&tf=d1`
- `GET /api/journal`
- `POST /api/journal`
- `GET /api/paper`
- `POST /api/paper/order`
- `POST /api/paper/close`

## Architecture
`Provider → Cache → Timeframe normalization → Indicators/Structure → MTF signal → Session/News/Risk filters → Simulated execution → Backtest/Paper Journal`

For production/live deployment, keep broker execution as a separate adapter. Never let a UI signal directly place a live order without server-side risk checks and reconciliation.


## Mobile hosted deployment (Render)
1. Create a GitHub repository and upload this project.
2. Create a Render Web Service from that repository, or use the included `render.yaml`.
3. Add the secret environment variable `ALPHAVANTAGE_API_KEY` in Render.
4. Deploy. Render will use the Dockerfile and `/api/health` health check.
5. Open the generated HTTPS URL on Android Chrome.
6. Use the dashboard's **Install App** button (or Chrome menu → Add to Home screen) to use it like a mobile app.

### Important hosting note
The included `data/journal.json` and `data/paper.json` are local JSON storage. On an ephemeral/free web host, these files are not reliable as permanent storage across redeploys/restarts. For persistent journal/paper history, replace them with a managed database such as PostgreSQL/Supabase/Neon before treating the hosted version as a permanent trading journal.

### Security
- Never commit `.env`.
- Keep `ALPHAVANTAGE_API_KEY` only in the hosting provider's secret/environment settings.
- The current app is paper-trading only; do not expose a live broker secret until broker-side risk controls and order reconciliation are implemented.


## v4 mobile upgrade
- Mobile-first dashboard with bottom navigation and safe-area support.
- Live lightweight price chart without extra frontend dependencies.
- One-tap signal copy and paper-trade creation.
- Risk calculator based on account balance and chosen risk percentage.
- Automatic 60-second refresh of signal/health.
- Research snapshot with backtest and walk-forward controls.
- News panel, session/news block visibility, and MTF confidence bars.
- PWA install support for Android Chrome.
- Paper order validation and a 10-open-order safety cap.
- New `/api/candles` and `/api/summary` endpoints.

### Android phone use
1. Deploy the project to a Node-compatible host (the included Render config is one option).
2. Open the HTTPS service URL in Chrome on Android.
3. Tap **Analyze** to calculate the current research signal.
4. Use **Risk calculator** after setting account size and risk %.
5. Use **Add paper trade** to record a simulated order. It does not place a broker order.
6. To install it like an app, open Chrome menu → **Add to Home screen** (or use the install prompt when available).
7. Keep the Alpha Vantage API key only in the hosting provider's environment/secret settings.

### Important
This is still a research/paper-trading application. A higher version number does not make signals more accurate or guarantee profit. Live trading requires a broker adapter, broker-native bid/ask data, server-side hard risk limits, order reconciliation, authentication, and monitoring.
