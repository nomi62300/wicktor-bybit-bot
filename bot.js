/**
 * bot.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Wicktor — 24/7 Headless Bybit Demo USDT Perpetual Trading Bot
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Architecture overview
 * ─────────────────────
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  Express /health endpoint  (keeps Render/Railway dyno alive)        │
 *  ├─────────────────────────────────────────────────────────────────────┤
 *  │  setInterval  every 3 minutes                                       │
 *  │   ├── monitorPositions()   — TP1 (1.25R) / TP2 (2.0R) / Jaw exit  │
 *  │   └── scanForEntries()     — universe scan → filter → open trade   │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 * Virtual Capital
 * ───────────────
 *  Starts at 100 USDT.  Each trade risks 0.5% ($0.50).
 *  Unrealised PnL accumulates in virtualCapital as positions close.
 *
 * Position state machine
 * ──────────────────────
 *  OPEN  →  (1.25R hit)  → PARTIAL  →  (2.0R hit or Jaw cross)  →  CLOSED
 *                       ↓
 *                  (Jaw cross)
 *                       ↓
 *                    CLOSED
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

require('dotenv').config();

const express         = require('express');
const { RestClientV5} = require('bybit-api');

const {
  getTop60Symbols,
  getKlines,
  getLastPrice,
  setSymbolLeverage,
  placeMarketOrder,
  getInstrumentInfo,
  roundQty,
  roundPrice,
} = require('./engine/api');

const { scoreSignal } = require('./engine/scoring');
const { getLatestJaw, calcHeikinAshi, calcAlligatorJaw } = require('./engine/indicators');

// ── Environment ───────────────────────────────────────────────────────────────
const apiKey = (process.env.BYBIT_DEMO_API_KEY || '').trim();
console.log(`[INIT] Loaded Bybit Key: ${apiKey ? apiKey.slice(0, 4) + '...' + apiKey.slice(-4) : 'MISSING'}`);

const API_KEY    = apiKey;
const API_SECRET = (process.env.BYBIT_DEMO_API_SECRET || '').trim();
const PORT       = parseInt(process.env.PORT ?? '3000', 10);

if (!API_KEY || !API_SECRET) {
  console.error('[BOOT] Missing BYBIT_DEMO_API_KEY or BYBIT_DEMO_API_SECRET in .env');
  process.exit(1);
}

// ── Bybit Client (Demo mode) ──────────────────────────────────────────────────
const restClient = new RestClientV5({
  key: (process.env.BYBIT_DEMO_API_KEY || '').trim(),
  secret: (process.env.BYBIT_DEMO_API_SECRET || '').trim(),
  demoTrading: true,  // Forces SDK to connect to api-demo.bybit.com
  testnet: false,
  recv_window: 10000
});
const client = restClient;

// ── Trading Parameters ────────────────────────────────────────────────────────
const VIRTUAL_CAPITAL_INITIAL = 100.0;        // USDT
const RISK_PCT                = 0.0015;        // 0.15% risk per trade
const LEVERAGE                = 5;            // 5x forced leverage
const MAX_POSITIONS           = 20;           // max concurrent open positions
const SCAN_INTERVAL_MS        = 3 * 60_000;   // 3 minutes

const TP1_R                   = 1.25;         // primary target (1.25 × SL distance)
const TP1_CLOSE_PCT           = 0.65;         // close 65% at TP1
const TP2_R                   = 2.0;          // runner target (2.0 × SL distance)
const TP2_CLOSE_PCT           = 1.0;          // close remaining 100% at TP2

const SIGNAL_MAX_AGE_MIN      = 20;           // max signal age in minutes
const ALLOWED_BANDS           = new Set(['EXCELLENT', 'WATCH']);

// ── Virtual Capital State ─────────────────────────────────────────────────────
let virtualCapital = VIRTUAL_CAPITAL_INITIAL;

/**
 * Active positions map: symbol → positionState
 *
 * positionState = {
 *   symbol        : string
 *   side          : 'Buy' | 'Sell'
 *   entryPrice    : number
 *   slPrice       : number
 *   jawValue      : number        (jaw at entry — for invalidation check)
 *   slDistance    : number        (|entry - sl|)
 *   totalQty      : number        (original base qty)
 *   remainQty     : number        (qty still open)
 *   riskAmount    : number        ($)
 *   status        : 'OPEN' | 'PARTIAL' | 'CLOSED'
 *   band          : string
 *   confidence    : number
 *   continuationScore: number
 *   entryOrderId  : string
 *   openedAt      : number        (Date.now())
 *   breakevenSet  : boolean
 * }
 */
const activePositions = new Map();
const tradeHistory = [];
const activeSymbolsSet = new Set();

// ── Logging Helpers ───────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function log(tag, msg, data = '') {
  const dataStr = data ? ' ' + JSON.stringify(data) : '';
  console.log(`[${ts()}] [${tag}] ${msg}${dataStr}`);
}

function logDivider() {
  console.log('─'.repeat(70));
}

function logPnL() {
  const open = [...activePositions.values()].filter(p => p.status !== 'CLOSED').length;
  log('STAT', `VirtualCapital: $${virtualCapital.toFixed(4)} | OpenPositions: ${open}/${MAX_POSITIONS}`);
}

// ── Express Health Server ─────────────────────────────────────────────────────

const app = express();

app.get('/health', (_req, res) => {
  const openCount = [...activePositions.values()].filter(p => p.status !== 'CLOSED').length;
  res.json({
    status          : 'active',
    activePositions : openCount,
    virtualBalance  : parseFloat(virtualCapital.toFixed(4)),
    timestamp       : new Date().toISOString(),
  });
});

app.get('/performance', (_req, res) => {
  const total = tradeHistory.length;
  
  // Calculate total wins (PnL > 0)
  const wins = tradeHistory.filter(t => t.realizedPnl > 0).length;
  const overallWinRate = total > 0 ? ((wins / total) * 100).toFixed(2) : '0.00';
  const totalPnl = tradeHistory.reduce((sum, t) => sum + t.realizedPnl, 0);

  // Quality Band Splits
  const excellentTrades = tradeHistory.filter(t => t.qualityBand === 'EXCELLENT');
  const watchTrades = tradeHistory.filter(t => t.qualityBand === 'WATCH');
  
  const excellentWins = excellentTrades.filter(t => t.realizedPnl > 0).length;
  const excellentWinRate = excellentTrades.length > 0 ? ((excellentWins / excellentTrades.length) * 100).toFixed(2) : '0.00';
  const excellentPnl = excellentTrades.reduce((sum, t) => sum + t.realizedPnl, 0);

  const watchWins = watchTrades.filter(t => t.realizedPnl > 0).length;
  const watchWinRate = watchTrades.length > 0 ? ((watchWins / watchTrades.length) * 100).toFixed(2) : '0.00';
  const watchPnl = watchTrades.reduce((sum, t) => sum + t.realizedPnl, 0);

  // Timeframe Splits
  const m5Trades = tradeHistory.filter(t => t.timeframe === '5M');
  const m15Trades = tradeHistory.filter(t => t.timeframe === '15M');

  const m5Wins = m5Trades.filter(t => t.realizedPnl > 0).length;
  const m5WinRate = m5Trades.length > 0 ? ((m5Wins / m5Trades.length) * 100).toFixed(2) : '0.00';
  const m5Pnl = m5Trades.reduce((sum, t) => sum + t.realizedPnl, 0);

  const m15Wins = m15Trades.filter(t => t.realizedPnl > 0).length;
  const m15WinRate = m15Trades.length > 0 ? ((m15Wins / m15Trades.length) * 100).toFixed(2) : '0.00';
  const m15Pnl = m15Trades.reduce((sum, t) => sum + t.realizedPnl, 0);

  // Exit Reason Breakdown
  const exitReasons = {
    'STOP_LOSS_HIT': 0,
    'JAW_INVALIDATION': 0,
    'TP_1.25R_PARTIAL': 0,
    'TP_2.0R_FINAL': 0
  };
  tradeHistory.forEach(t => {
    if (exitReasons[t.exitReason] !== undefined) {
      exitReasons[t.exitReason]++;
    }
  });

  // Render HTML response with modern styling
  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Wicktor Bot Performance Journal</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          background-color: #0d1117;
          color: #c9d1d9;
          margin: 0;
          padding: 40px 20px;
        }
        .container {
          max-width: 900px;
          margin: 0 auto;
        }
        h1 {
          color: #58a6ff;
          border-bottom: 1px solid #21262d;
          padding-bottom: 10px;
          font-weight: 500;
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
          gap: 20px;
          margin-bottom: 40px;
        }
        .card {
          background-color: #161b22;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 20px;
        }
        .card h3 {
          margin-top: 0;
          color: #8b949e;
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .card .value {
          font-size: 32px;
          font-weight: bold;
          color: #f0f6fc;
        }
        .card .subtext {
          font-size: 14px;
          color: #8b949e;
          margin-top: 5px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          margin-bottom: 40px;
          background-color: #161b22;
          border: 1px solid #30363d;
          border-radius: 6px;
          overflow: hidden;
        }
        th, td {
          padding: 12px 15px;
          text-align: left;
          border-bottom: 1px solid #30363d;
        }
        th {
          background-color: #21262d;
          color: #f0f6fc;
          font-weight: 500;
        }
        tr:last-child td {
          border-bottom: none;
        }
        .pnl-positive {
          color: #3fb950;
        }
        .pnl-negative {
          color: #f85149;
        }
        .btn {
          display: inline-block;
          background-color: #238636;
          color: #ffffff;
          padding: 10px 20px;
          border-radius: 6px;
          text-decoration: none;
          font-weight: 500;
          transition: background-color 0.2s;
        }
        .btn:hover {
          background-color: #2ea043;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Wicktor Bot Performance Analytics</h1>
        
        <div class="stats-grid">
          <div class="card">
            <h3>Overall Overview</h3>
            <div class="value">${total}</div>
            <div class="subtext">Total Executed Trades</div>
          </div>
          <div class="card">
            <h3>Overall Win Rate</h3>
            <div class="value">${overallWinRate}%</div>
            <div class="subtext">${wins} Wins / ${total - wins} Losses</div>
          </div>
          <div class="card">
            <h3>Total Realized PnL</h3>
            <div class="value ${totalPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${totalPnl.toFixed(4)}</div>
            <div class="subtext">Accumulated USDT</div>
          </div>
        </div>

        <h2>Quality Band Performance</h2>
        <table>
          <thead>
            <tr>
              <th>Band</th>
              <th>Trades Count</th>
              <th>Win Rate</th>
              <th>Realized PnL</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>EXCELLENT</strong></td>
              <td>${excellentTrades.length}</td>
              <td>${excellentWinRate}%</td>
              <td class="${excellentPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${excellentPnl.toFixed(4)}</td>
            </tr>
            <tr>
              <td><strong>WATCH</strong></td>
              <td>${watchTrades.length}</td>
              <td>${watchWinRate}%</td>
              <td class="${watchPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${watchPnl.toFixed(4)}</td>
            </tr>
          </tbody>
        </table>

        <h2>Timeframe Performance</h2>
        <table>
          <thead>
            <tr>
              <th>Timeframe</th>
              <th>Trades Count</th>
              <th>Win Rate</th>
              <th>Realized PnL</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>5M</strong></td>
              <td>${m5Trades.length}</td>
              <td>${m5WinRate}%</td>
              <td class="${m5Pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${m5Pnl.toFixed(4)}</td>
            </tr>
            <tr>
              <td><strong>15M (Fallback)</strong></td>
              <td>${m15Trades.length}</td>
              <td>${m15WinRate}%</td>
              <td class="${m15Pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">$${m15Pnl.toFixed(4)}</td>
            </tr>
          </tbody>
        </table>

        <h2>Exit Distribution</h2>
        <table>
          <thead>
            <tr>
              <th>Exit Reason</th>
              <th>Count</th>
              <th>Percentage</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Stop Loss Hit</td>
              <td>${exitReasons['STOP_LOSS_HIT']}</td>
              <td>${total > 0 ? ((exitReasons['STOP_LOSS_HIT'] / total) * 100).toFixed(1) : 0}%</td>
            </tr>
            <tr>
              <td>Jaw Invalidation (Early Exit)</td>
              <td>${exitReasons['JAW_INVALIDATION']}</td>
              <td>${total > 0 ? ((exitReasons['JAW_INVALIDATION'] / total) * 100).toFixed(1) : 0}%</td>
            </tr>
            <tr>
              <td>Take Profit 1 (1.25R Partial)</td>
              <td>${exitReasons['TP_1.25R_PARTIAL']}</td>
              <td>${total > 0 ? ((exitReasons['TP_1.25R_PARTIAL'] / total) * 100).toFixed(1) : 0}%</td>
            </tr>
            <tr>
              <td>Take Profit 2 (2.0R Final)</td>
              <td>${exitReasons['TP_2.0R_FINAL']}</td>
              <td>${total > 0 ? ((exitReasons['TP_2.0R_FINAL'] / total) * 100).toFixed(1) : 0}%</td>
            </tr>
          </tbody>
        </table>

        <div style="margin-top: 30px; text-align: center;">
          <a href="/trades.csv" class="btn">Download Excel-Compatible CSV Journal</a>
        </div>
      </div>
    </body>
    </html>
  `;
  res.send(html);
});

app.get('/trades.csv', (_req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=wicktor_trades.csv');
  
  const csvData = convertToCSV(tradeHistory);
  res.send(csvData);
});

function convertToCSV(arr) {
  const headers = ['Timestamp', 'Symbol', 'Side', 'QualityBand', 'Timeframe', 'EntryPrice', 'ExitPrice', 'ExitReason', 'RealizedPnL', 'R_Multiple'];
  const rows = arr.map(t => [
    t.timestamp,
    t.symbol,
    t.side,
    t.qualityBand,
    t.timeframe,
    t.entryPrice,
    t.exitPrice,
    t.exitReason,
    t.realizedPnl.toFixed(4),
    t.rMultiple.toFixed(4)
  ]);
  return [headers.join(','), ...rows.map(r => r.map(val => `"${val}"`).join(','))].join('\n');
}

app.get('/close-all', async (_req, res) => {
  let closedCount = 0;
  try {
    const livePositions = await getLivePositions();
    
    for (const p of livePositions) {
      try {
        const closeSide = p.side === 'Buy' ? 'Sell' : 'Buy';
        await placeMarketOrder(client, p.symbol, closeSide, p.size, true);
        closedCount++;
        
        if (activePositions.has(p.symbol)) {
          activePositions.delete(p.symbol);
        }
        
        // Pause 100ms between individual close requests to prevent Bybit API rate limits
        await new Promise(r => setTimeout(r, 100));
      } catch (err) {
        log('CLOSE-ALL', `Error closing position for ${p.symbol}: ${err.message}`);
      }
    }
    
    res.json({
      success: true,
      closedCount,
      message: "All positions closed & sync complete"
    });
  } catch (err) {
    log('CLOSE-ALL', `Fatal error during close-all execution: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    isCycleRunning = false;
    await syncLivePositions();
  }
});

app.get('/', (_req, res) => {
  res.json({ name: 'Wicktor Bybit Bot', status: 'running' });
});

app.listen(PORT, () => {
  log('HTTP', `Health server listening on port ${PORT}`);
});

/**
 * Helper to fetch live positions from Bybit.
 * Only returns positions where size > 0.
 */
async function getLivePositions() {
  try {
    const res = await restClient.getPositionInfo({ category: 'linear' });
    if (res.retCode === 0 && res.result?.list) {
      return res.result.list.filter(p => parseFloat(p.size) > 0);
    }
  } catch (err) {
    log('SCAN', `Error fetching live positions: ${err.message}`);
  }
  return [];
}

/**
 * Helper to fetch the number of currently active positions from the exchange.
 *
 * @returns {Promise<number>} count of active positions
 */
async function getLiveActivePositionCount() {
  try {
    const livePositions = await getLivePositions();
    return livePositions.length;
  } catch (err) {
    log('CAP', `Error getting active position count: ${err.message}`);
    // Fallback to local tracked count if exchange query fails
    return [...activePositions.values()].filter(p => p.status !== 'CLOSED').length;
  }
}

/**
 * Helper to fetch currently open position symbols as a Set.
 *
 * @returns {Promise<Set<string>>} Set of active symbols
 */
async function getOpenPositionSymbols() {
  try {
    const res = await restClient.getPositionInfo({ category: 'linear' });
    if (res.retCode === 0 && res.result?.list) {
      const positions = res.result.list.filter(p => parseFloat(p.size) > 0);
      return new Set(positions.map(p => p.symbol));
    }
  } catch (err) {
    log('SCAN', `Error fetching open position symbols: ${err.message}`);
  }
  // Fallback to local active positions map if query fails
  const localSymbols = [...activePositions.values()]
    .filter(p => p.status !== 'CLOSED')
    .map(p => p.symbol);
  return new Set(localSymbols);
}

/**
 * Startup Position Reconciliation.
 * Synchronizes with Bybit to find active positions and populates activeSymbolsSet.
 */
async function syncLivePositions() {
  try {
    const livePositions = await getLivePositions();
    activeSymbolsSet.clear();
    for (const p of livePositions) {
      activeSymbolsSet.add(p.symbol);
    }
    log('RECONCILE', `Synced with Bybit: Found ${activeSymbolsSet.size} currently open positions on exchange.`);
  } catch (err) {
    log('RECONCILE', `Error in syncLivePositions: ${err.message}`);
  }
}

// ── Position Monitor ──────────────────────────────────────────────────────────

/**
 * Iterate all open/partial positions.
 * Synchronizes with the exchange and monitors for 1.25R partial closes.
 */
async function monitorPositions() {
  const openPositions = [...activePositions.values()].filter(
    p => p.status === 'OPEN' || p.status === 'PARTIAL'
  );

  if (openPositions.length === 0) return;

  const livePositions = await getLivePositions();

  log('MONITOR', `Checking ${openPositions.length} position(s)…`);

  for (const pos of openPositions) {
    const livePos = livePositions.find(p => p.symbol === pos.symbol);
    
    if (!livePos) {
      // Position was closed on the exchange (e.g. hit native SL or TP)
      log('MONITOR', `Position for ${pos.symbol} is no longer open on exchange. Reconciling...`);
      
      const lastPrice = await getLastPrice(pos.symbol) || pos.entryPrice;
      let realizedPnl = (pos.side === 'Buy')
        ? (lastPrice - pos.entryPrice) * pos.remainQty
        : (pos.entryPrice - lastPrice) * pos.remainQty;
      
      let exitReason = 'STOP_LOSS_HIT';
      
      if (pos.status === 'PARTIAL') {
        const hitBreakeven = Math.abs(lastPrice - pos.entryPrice) / pos.entryPrice < 0.005; // within 0.5%
        if (hitBreakeven) {
          exitReason = 'BREAKEVEN_HIT';
        } else {
          exitReason = 'TP_2.0R_FINAL';
        }
      } else {
        const distToSl = Math.abs(lastPrice - pos.slPrice) / pos.entryPrice;
        const distToTp = Math.abs(lastPrice - pos.tpPrice) / pos.entryPrice;
        if (distToTp < distToSl) {
          exitReason = 'TP_2.0R_FINAL';
        }
      }

      const rMultiple = (pos.side === 'Buy' ? (lastPrice - pos.entryPrice) : (pos.entryPrice - lastPrice)) / pos.slDistance;
      tradeHistory.push({
        timestamp   : new Date().toISOString(),
        symbol      : pos.symbol,
        side        : pos.side,
        qualityBand : pos.qualityBand || pos.band || 'WATCH',
        timeframe   : pos.timeframe || '5M',
        entryPrice  : pos.entryPrice,
        exitPrice   : lastPrice,
        exitReason  : exitReason,
        realizedPnl : realizedPnl,
        rMultiple   : parseFloat(rMultiple.toFixed(4))
      });

      pos.status = 'CLOSED';
      activePositions.delete(pos.symbol);
      log('MONITOR', `Reconciled ${pos.symbol} exit: ${exitReason} @ ${lastPrice}. PnL: $${realizedPnl.toFixed(4)}`);
      logPnL();
      continue;
    }

    try {
      await checkPosition(pos, livePos);
    } catch (err) {
      log('MONITOR', `Error checking ${pos.symbol}:`, { error: err.message });
    }
  }
}

async function checkPosition(pos, livePos) {
  const livePrice = parseFloat(livePos.markPrice || livePos.entryPrice || await getLastPrice(pos.symbol));
  if (!livePrice) return;

  const isBull = pos.side === 'Buy';
  const entry  = pos.entryPrice;
  const dist   = pos.slDistance;

  // ── TP1 Check (1.25R) ─────────────────────────────────────────────────────
  if (pos.status === 'OPEN') {
    const tp1Price = isBull
      ? entry + dist * TP1_R
      : entry - dist * TP1_R;

    const tp1Hit = (isBull && livePrice >= tp1Price) || (!isBull && livePrice <= tp1Price);

    if (tp1Hit) {
      log('TP1', `🎯 ${pos.symbol} hit 1.25R at ${livePrice} (tp1=${tp1Price.toFixed(4)})`);
      await executePartialClose(pos, livePrice);
    }
  }
}

/**
 * Execute 65% partial close at TP1 and move SL to breakeven.
 */
async function executePartialClose(pos, livePrice) {
  const instrInfo  = await getInstrumentInfo(pos.symbol);
  const closeQty   = roundQty(pos.remainQty * TP1_CLOSE_PCT, instrInfo.qtyStep);
  const closeSide  = pos.side === 'Buy' ? 'Sell' : 'Buy';

  if (closeQty < instrInfo.minQty) {
    log('TP1', `${pos.symbol} partial qty ${closeQty} below minQty ${instrInfo.minQty}, skipping partial`);
    return;
  }

  let orderId = null;
  try {
    const order = await placeMarketOrder(client, pos.symbol, closeSide, closeQty, true);
    orderId = order.orderId;
    log('TP1', `✅ Partial close ${pos.symbol} qty=${closeQty} orderId=${orderId}`);
  } catch (err) {
    log('TP1', `⚠️ Partial close order failed for ${pos.symbol}:`, { error: err.message });
    return;
  }

  // Calculate realised PnL on closed portion
  const pnl = (pos.side === 'Buy')
    ? (livePrice - pos.entryPrice) * closeQty
    : (pos.entryPrice - livePrice) * closeQty;

  virtualCapital += pnl;

  // Update position state
  pos.remainQty  -= closeQty;
  pos.slPrice     = pos.entryPrice;   // move SL to breakeven
  pos.breakevenSet= true;
  pos.status      = 'PARTIAL';

  // Update the remaining position's Stop-Loss on Bybit to Breakeven (Entry Price)
  try {
    const roundedSl = roundPrice(pos.entryPrice, instrInfo.tickSize);
    await client.setTradingStop({
      category: 'linear',
      symbol: pos.symbol,
      stopLoss: String(roundedSl),
      positionIdx: 0
    });
    log('TP1', `Updated stopLoss to breakeven (${roundedSl}) on Bybit for ${pos.symbol}`);
  } catch (err) {
    log('TP1', `⚠️ Failed to update exchange stopLoss for ${pos.symbol}:`, { error: err.message });
  }

  // Add to trade journal
  const rMultiple = (pos.side === 'Buy' ? (livePrice - pos.entryPrice) : (pos.entryPrice - livePrice)) / pos.slDistance;
  tradeHistory.push({
    timestamp   : new Date().toISOString(),
    symbol      : pos.symbol,
    side        : pos.side,
    qualityBand : pos.qualityBand || pos.band || 'WATCH',
    timeframe   : pos.timeframe || '5M',
    entryPrice  : pos.entryPrice,
    exitPrice   : livePrice,
    exitReason  : 'TP_1.25R_PARTIAL',
    realizedPnl : pnl,
    rMultiple   : parseFloat(rMultiple.toFixed(4))
  });

  log('TP1', `💰 PnL +$${pnl.toFixed(4)} | RemainQty=${pos.remainQty.toFixed(6)} | SL→Breakeven`);
  logPnL();
}

/**
 * Close the remaining runner at TP2 or any full-close scenario.
 */
async function executeFullClose(pos, reason, livePrice) {
  const instrInfo = await getInstrumentInfo(pos.symbol);
  const closeQty  = roundQty(pos.remainQty, instrInfo.qtyStep);
  const closeSide = pos.side === 'Buy' ? 'Sell' : 'Buy';

  if (closeQty < instrInfo.minQty) {
    log(reason, `${pos.symbol} qty ${closeQty} below minQty — treating as closed`);
    pos.status = 'CLOSED';
    activePositions.delete(pos.symbol);
    return;
  }

  let orderId = null;
  try {
    const order = await placeMarketOrder(client, pos.symbol, closeSide, closeQty, true);
    orderId = order.orderId;
    log(reason, `✅ Full close ${pos.symbol} qty=${closeQty} orderId=${orderId}`);
  } catch (err) {
    log(reason, `⚠️ Full close order failed for ${pos.symbol}:`, { error: err.message });
    return;
  }

  const pnl = (pos.side === 'Buy')
    ? (livePrice - pos.entryPrice) * closeQty
    : (pos.entryPrice - livePrice) * closeQty;

  virtualCapital += pnl;
  pos.status      = 'CLOSED';
  activePositions.delete(pos.symbol);

  // Add to trade journal
  const rMultiple = (pos.side === 'Buy' ? (livePrice - pos.entryPrice) : (pos.entryPrice - livePrice)) / pos.slDistance;
  tradeHistory.push({
    timestamp   : new Date().toISOString(),
    symbol      : pos.symbol,
    side        : pos.side,
    qualityBand : pos.qualityBand || pos.band || 'WATCH',
    timeframe   : pos.timeframe || '5M',
    entryPrice  : pos.entryPrice,
    exitPrice   : livePrice,
    exitReason  : 'TP_2.0R_FINAL',
    realizedPnl : pnl,
    rMultiple   : parseFloat(rMultiple.toFixed(4))
  });

  log(reason, `💰 Closed ${pos.symbol} | PnL +$${pnl.toFixed(4)} | orderId=${orderId}`);
  logPnL();
}

/**
 * Execute an immediate full exit (Jaw invalidation or SL breach).
 */
async function executeExit(pos, reason, livePrice, refLevel) {
  const instrInfo  = await getInstrumentInfo(pos.symbol);
  const closeQty   = roundQty(pos.remainQty, instrInfo.qtyStep);
  const closeSide  = pos.side === 'Buy' ? 'Sell' : 'Buy';

  if (closeQty < instrInfo.minQty) {
    log(reason, `${pos.symbol} qty below minQty — marking CLOSED`);
    pos.status = 'CLOSED';
    activePositions.delete(pos.symbol);
    return;
  }

  let orderId = null;
  try {
    const order = await placeMarketOrder(client, pos.symbol, closeSide, closeQty, true);
    orderId = order.orderId;
  } catch (err) {
    log(reason, `⚠️ Exit order failed for ${pos.symbol}:`, { error: err.message });
    return;
  }

  const pnl = (pos.side === 'Buy')
    ? (livePrice - pos.entryPrice) * closeQty
    : (pos.entryPrice - livePrice) * closeQty;

  virtualCapital += pnl;
  pos.status      = 'CLOSED';
  activePositions.delete(pos.symbol);

  // Add to trade journal
  let loggedReason = 'STOP_LOSS_HIT';
  if (reason === 'JAW_INVALIDATION') loggedReason = 'JAW_INVALIDATION';
  if (reason === 'STOP_LOSS') loggedReason = 'STOP_LOSS_HIT';

  const rMultiple = (pos.side === 'Buy' ? (livePrice - pos.entryPrice) : (pos.entryPrice - livePrice)) / pos.slDistance;
  tradeHistory.push({
    timestamp   : new Date().toISOString(),
    symbol      : pos.symbol,
    side        : pos.side,
    qualityBand : pos.qualityBand || pos.band || 'WATCH',
    timeframe   : pos.timeframe || '5M',
    entryPrice  : pos.entryPrice,
    exitPrice   : livePrice,
    exitReason  : loggedReason,
    realizedPnl : pnl,
    rMultiple   : parseFloat(rMultiple.toFixed(4))
  });

  const pnlSign = pnl >= 0 ? '+' : '';
  log(reason, `🚪 Exit ${pos.symbol} @ ${livePrice} | refLevel=${refLevel?.toFixed(4)} | PnL ${pnlSign}$${pnl.toFixed(4)} | orderId=${orderId}`);
  logPnL();
}

// ── Entry Scanner ─────────────────────────────────────────────────────────────

/**
 * Scan the top-60 universe for qualified entry signals.
 * Enforces all filtering rules before executing an order.
 */
async function scanForEntries() {
  // Check position cap directly on the exchange first
  const livePositions = await getLivePositions();
  if (livePositions.length >= 20) {
    log('CAP REACHED', `Exchange already has ${livePositions.length} active positions (>= 20 cap). Skipping new entries.`);
    return;
  }

  log('SCAN', `Starting universe scan… (${livePositions.length} positions open on exchange)`);

  let universe;
  try {
    universe = await getTop60Symbols(60);
    log('SCAN', `Evaluating ${universe.length} symbols`);
  } catch (err) {
    log('SCAN', 'Failed to fetch universe:', { error: err.message });
    return;
  }

  const qualified = [];

  for (const symbol of universe) {
    // Skip if already open locally or on the exchange
    if (activePositions.has(symbol) || livePositions.some(p => p.symbol === symbol)) continue;

    // Check position cap again mid-loop
    const curOpen = [...activePositions.values()].filter(p => p.status !== 'CLOSED').length;
    if (curOpen >= MAX_POSITIONS) break;

    try {
      const signal = await evaluateSymbol(symbol);
      if (signal) qualified.push(signal);
    } catch (err) {
      // Per-symbol errors are non-fatal; log and continue
      log('SCAN', `${symbol} eval error: ${err.message}`);
    }

    // Polite delay to avoid rate limits (200ms between symbols)
    await sleep(200);
  }

  if (qualified.length === 0) {
    log('SCAN', 'No qualified signals this cycle.');
    return;
  }

  // Sort by confidence descending; enter best signals first
  qualified.sort((a, b) => b.signal.confidence - a.signal.confidence);

  log('SCAN', `${qualified.length} qualified signal(s) found:`);
  for (const q of qualified) {
    log('SCAN', `  → ${q.symbol} ${q.signal.direction} | Band=${q.signal.band} | Cont=${q.signal.continuationScore} Exh=${q.signal.exhaustionScore} Rev=${q.signal.reversalScore} | Age=${q.signal.signalAgeMin}m`);
  }

  for (const setup of qualified) {
    // 1. Fetch live active symbols set
    const activeSymbols = await getOpenPositionSymbols();

    // 2. CHECK HARD CAP (20 MAX)
    if (activeSymbols.size >= 20) {
      console.log(`[CAP ENFORCED] Already at ${activeSymbols.size}/20 active positions on Bybit. Stopping order execution.`);
      break; // Exit loop completely
    }

    // 3. CHECK DUPLICATE SYMBOL GUARD
    if (activeSymbols.has(setup.symbol)) {
      console.log(`[DUPLICATE SKIPPED] Position for ${setup.symbol} is already open on Bybit. Skipping.`);
      continue; // Move to next setup
    }

    await enterPosition(setup.symbol, setup.signal);
    await sleep(500);
  }
}

/**
 * Evaluate a single symbol.
 * Returns { symbol, signal } if it passes all filters, or null.
 *
 * @param {string} symbol
 * @returns {Promise<{symbol: string, signal: object}|null>}
 */
async function evaluateSymbol(symbol) {
  // Fetch 5M candles (200 bars)
  const candles5m = await getKlines(symbol, '5', 200);
  if (!candles5m || candles5m.length < 60) return null;

  // Score the signal
  let signal = scoreSignal(candles5m);
  let timeframe = '5M';

  // 15M fallback if 5M direction is unclear
  if (signal.direction === null || signal.band === 'AVOID') {
    const candles15m = await getKlines(symbol, '15', 200);
    if (candles15m && candles15m.length >= 60) {
      signal = scoreSignal(candles5m, candles15m);
      timeframe = '15M';
    }
  }

  // ── Apply all filters ────────────────────────────────────────────────────

  // Filter 1: Band must be EXCELLENT or WATCH
  if (!ALLOWED_BANDS.has(signal.band)) return null;

  // Filter 2: Continuation must dominate both sub-scores
  if (
    signal.continuationScore <= signal.exhaustionScore ||
    signal.continuationScore <= signal.reversalScore
  ) return null;

  // Filter 3: Signal age must be ≤ 20 minutes
  if (signal.signalAgeMin == null || signal.signalAgeMin > SIGNAL_MAX_AGE_MIN) return null;

  // Filter 4: Must have a clear direction
  if (!signal.direction) return null;

  // Filter 5: SL must be valid
  if (!signal.slPrice || !signal.entryPrice) return null;

  signal.timeframe = timeframe;
  return { symbol, signal };
}

/**
 * Execute a new position entry.
 *
 * @param {string} symbol
 * @param {object} signal  — from scoreSignal()
 */
async function enterPosition(symbol, signal) {
  logDivider();
  log('ENTRY', `Entering ${symbol} ${signal.direction} | Band=${signal.band} | Conf=${signal.confidence}`);

  // Set 5x leverage
  await setSymbolLeverage(client, symbol, LEVERAGE);

  // Fetch instrument info for lot size
  let instrInfo;
  try {
    instrInfo = await getInstrumentInfo(symbol);
  } catch (err) {
    log('ENTRY', `Could not fetch instrInfo for ${symbol}:`, { error: err.message });
    return;
  }

  // ── Order Size Calculation ───────────────────────────────────────────────
  const accountBalance = virtualCapital;
  const riskAmount     = accountBalance * RISK_PCT;           // 0.15% risk per trade
  const maxNotionalCap = accountBalance * 0.12;               // 12% max position value cap per coin
  const minSlPct       = 0.006;                              // 0.6% minimum stop loss distance floor

  const entryPrice = signal.entryPrice;
  const slPrice    = signal.slPrice;
  const slDistance = Math.abs(entryPrice - slPrice);

  if (slDistance <= 0) {
    log('ENTRY', `${symbol}: SL distance is zero — skipping`);
    return;
  }

  const rawSlPct = slDistance / entryPrice;
  const slPct = Math.max(rawSlPct, minSlPct); // Enforce 0.6% floor

  let calculatedNotional = riskAmount / slPct;
  let finalNotional = Math.min(calculatedNotional, maxNotionalCap);

  let positionQty = finalNotional / entryPrice;
  positionQty     = roundQty(positionQty, instrInfo.qtyStep);

  if (positionQty < instrInfo.minQty) {
    log('ENTRY', `${symbol}: Qty ${positionQty} below minQty ${instrInfo.minQty} — skipping`);
    return;
  }

  // ── Place Market Entry Order with native SL/TP ───────────────────────────
  let order;
  try {
    const isBull = signal.direction === 'Buy';
    const tpPrice = isBull ? entryPrice + slDistance * TP2_R : entryPrice - slDistance * TP2_R;
    const roundedSl = roundPrice(signal.slPrice, instrInfo.tickSize);
    const roundedTp = roundPrice(tpPrice, instrInfo.tickSize);

    order = await placeMarketOrder(
      client,
      symbol,
      signal.direction,
      positionQty,
      false,
      roundedTp,
      roundedSl
    );
  } catch (err) {
    log('ENTRY', `⚠️ Order placement failed for ${symbol}:`, { error: err.message });
    return;
  }

  // ── Build Position State ─────────────────────────────────────────────────
  const posState = {
    symbol          : symbol,
    side            : signal.direction,
    qualityBand     : signal.band,
    timeframe       : signal.timeframe || '5M',
    entryPrice      : signal.entryPrice,
    entryTime       : Date.now(),
    slPrice         : signal.slPrice,
    tpPrice         : parseFloat((signal.entryPrice + (signal.direction === 'Buy' ? 1 : -1) * slDistance * TP2_R).toFixed(6)),
    
    // Existing tracking fields:
    jawValue        : signal.jawValue,
    slDistance,
    totalQty        : positionQty,
    remainQty       : positionQty,
    riskAmount,
    status          : 'OPEN',
    band            : signal.band,
    confidence      : signal.confidence,
    continuationScore: signal.continuationScore,
    entryOrderId    : order.orderId,
    openedAt        : Date.now(),
    breakevenSet    : false,
  };

  activePositions.set(symbol, posState);

  log('ENTRY', `✅ Entered ${symbol}`, {
    orderId   : order.orderId,
    side      : signal.direction,
    qty       : positionQty,
    entry     : signal.entryPrice,
    sl        : signal.slPrice,
    tp1       : parseFloat((signal.entryPrice + (signal.direction === 'Buy' ? 1 : -1) * slDistance * TP1_R).toFixed(6)),
    tp2       : parseFloat((signal.entryPrice + (signal.direction === 'Buy' ? 1 : -1) * slDistance * TP2_R).toFixed(6)),
    risk      : `$${riskAmount.toFixed(4)}`,
    atr       : signal.atr,
  });

  logPnL();
  logDivider();
}

// ── Main Scan Loop ────────────────────────────────────────────────────────────

/**
 * Live Bybit Wallet Balance Fetching.
 * Calls Bybit V5 API: restClient.getWalletBalance({ accountType: 'UNIFIED', coin: 'USDT' })
 * Extracts totalEquity or walletBalance for USDT from the response list.
 * Fallback: If API query fails or returns 0, default to 100.0 USDT to prevent division errors.
 */
async function getLiveWalletBalance() {
  try {
    const res = await restClient.getWalletBalance({
      accountType: 'UNIFIED',
      coin: 'USDT'
    });

    if (res.retCode === 0 && res.result?.list?.length > 0) {
      const account = res.result.list[0];
      let balance = parseFloat(account.totalEquity || account.totalWalletBalance || '0');

      if (account.coin && account.coin.length > 0) {
        const usdtCoin = account.coin.find(c => c.coin === 'USDT');
        if (usdtCoin) {
          balance = parseFloat(usdtCoin.equity || usdtCoin.walletBalance || balance || '0');
        }
      }

      if (balance > 0) {
        return balance;
      }
    }
  } catch (err) {
    log('BALANCE', `Failed to fetch live balance: ${err.message}`);
  }
  return 100.0; // Fallback
}

let isCycleRunning = false;

async function runScanCycle() {
  if (isCycleRunning) {
    log('CYCLE', 'Scan cycle already in progress, skipping.');
    return;
  }

  isCycleRunning = true;
  log('CYCLE', '═══ Cycle start ═══');

  try {
    // Dynamically fetch account balance at the start of every scan cycle
    const accountBalance = await getLiveWalletBalance();
    virtualCapital = accountBalance; // keep virtualCapital in sync with live equity

    try {
      await monitorPositions();
    } catch (err) {
      log('CYCLE', 'monitorPositions error:', { error: err.message });
    }
    try {
      await scanForEntries();
    } catch (err) {
      log('CYCLE', 'scanForEntries error:', { error: err.message });
    }

    log('CYCLE', '═══ Cycle end ═══');
    logPnL();
  } catch (err) {
    log('CYCLE', 'Fatal error inside scan cycle:', { error: err.message });
  } finally {
    isCycleRunning = false;
    setTimeout(runScanCycle, SCAN_INTERVAL_MS);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  logDivider();
  log('BOOT', '🚀 Wicktor Bybit Demo Bot starting…');

  // Fetch startup balance
  const accountBalance = await getLiveWalletBalance();
  virtualCapital = accountBalance;
  console.log(`[BALANCE] Current Live Bybit USDT Equity: $${virtualCapital.toFixed(2)}`);

  // Run Startup reconciliation
  await syncLivePositions();

  log('BOOT', `VirtualCapital: $${virtualCapital.toFixed(2)} | Risk/Trade: ${(RISK_PCT * 100).toFixed(2)}% | Leverage: ${LEVERAGE}x`);
  log('BOOT', `MaxPositions: ${MAX_POSITIONS} | ScanInterval: ${SCAN_INTERVAL_MS / 60000} min`);
  log('BOOT', `API Key: ${API_KEY ? API_KEY.slice(0, 4) + '...' + API_KEY.slice(-4) : 'MISSING'} | Demo: true`);
  logDivider();

  // Test connectivity
  try {
    const serverTime = await client.getServerTime();
    log('BOOT', `Bybit server time: ${new Date(parseInt(serverTime.result.timeNano) / 1_000_000).toISOString()}`);
  } catch (err) {
    log('BOOT', `⚠️ Server time check failed (network?): ${err.message}`);
  }

  log('SYSTEM', 'Self-healing scanner initialized. Scanning every 3 minutes.');

  // Run the first scan cycle
  await runScanCycle();
}

boot().catch(err => {
  console.error('[BOOT] Fatal error:', err);
  process.exit(1);
});
