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
const RISK_PCT                = 0.005;        // 0.5% per trade
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

app.get('/', (_req, res) => {
  res.json({ name: 'Wicktor Bybit Bot', status: 'running' });
});

app.listen(PORT, () => {
  log('HTTP', `Health server listening on port ${PORT}`);
});

// ── Position Monitor ──────────────────────────────────────────────────────────

/**
 * Iterate all open/partial positions.
 * For each:
 *   1. Fetch live price.
 *   2. Check Jaw invalidation (immediate full exit).
 *   3. Check TP1 (1.25R) → partial close + move SL to breakeven.
 *   4. Check TP2 (2.0R) → close remaining.
 */
async function monitorPositions() {
  const openPositions = [...activePositions.values()].filter(
    p => p.status === 'OPEN' || p.status === 'PARTIAL'
  );

  if (openPositions.length === 0) return;

  log('MONITOR', `Checking ${openPositions.length} position(s)…`);

  for (const pos of openPositions) {
    try {
      await checkPosition(pos);
    } catch (err) {
      log('MONITOR', `Error checking ${pos.symbol}:`, { error: err.message });
    }
  }
}

async function checkPosition(pos) {
  const livePrice = await getLastPrice(pos.symbol);
  if (!livePrice) return;

  const isBull = pos.side === 'Buy';
  const sl     = pos.slPrice;
  const entry  = pos.entryPrice;
  const dist   = pos.slDistance;

  // ── Jaw Invalidation ─────────────────────────────────────────────────────
  // Re-fetch fresh candles to get latest Jaw value
  const candles5m = await getKlines(pos.symbol, '5', 100);
  const ha5m      = calcHeikinAshi(candles5m);
  const jaw5m     = calcAlligatorJaw(ha5m);
  const liveJaw   = getLatestJaw(jaw5m);

  if (liveJaw != null) {
    const jawCross = (isBull && livePrice < liveJaw) || (!isBull && livePrice > liveJaw);

    if (jawCross) {
      log('JAW-EXIT', `⚡ ${pos.symbol} price ${livePrice} crossed Jaw ${liveJaw.toFixed(4)} — immediate exit`);
      await executeExit(pos, 'JAW_INVALIDATION', livePrice, liveJaw);
      return;
    }
  }

  // ── TP1 Check (1.25R) ─────────────────────────────────────────────────────
  if (pos.status === 'OPEN') {
    const tp1Price = isBull
      ? entry + dist * TP1_R
      : entry - dist * TP1_R;

    const tp1Hit = (isBull && livePrice >= tp1Price) || (!isBull && livePrice <= tp1Price);

    if (tp1Hit) {
      log('TP1', `🎯 ${pos.symbol} hit 1.25R at ${livePrice} (tp1=${tp1Price.toFixed(4)})`);
      await executePartialClose(pos, livePrice);
      return;
    }
  }

  // ── TP2 Check (2.0R) ─────────────────────────────────────────────────────
  if (pos.status === 'PARTIAL') {
    const tp2Price = isBull
      ? entry + dist * TP2_R
      : entry - dist * TP2_R;

    const tp2Hit = (isBull && livePrice >= tp2Price) || (!isBull && livePrice <= tp2Price);

    if (tp2Hit) {
      log('TP2', `🏁 ${pos.symbol} hit 2.0R at ${livePrice} (tp2=${tp2Price.toFixed(4)})`);
      await executeFullClose(pos, 'TP2', livePrice);
      return;
    }
  }

  // ── SL check (safety net in case exchange SL missed) ─────────────────────
  const slBreached = (isBull && livePrice <= sl) || (!isBull && livePrice >= sl);
  if (slBreached) {
    log('SL-HIT', `🛑 ${pos.symbol} SL breached at ${livePrice} (sl=${sl})`);
    await executeExit(pos, 'STOP_LOSS', livePrice, sl);
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
  // Check position cap
  const openCount = [...activePositions.values()].filter(p => p.status !== 'CLOSED').length;
  if (openCount >= MAX_POSITIONS) {
    log('SCAN', `Position cap reached (${openCount}/${MAX_POSITIONS}). Skipping scan.`);
    return;
  }

  log('SCAN', `Starting universe scan… (${openCount} positions open)`);

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
    // Skip if already have an open position on this coin
    if (activePositions.has(symbol)) continue;

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

  for (const { symbol, signal } of qualified) {
    const nowOpen = [...activePositions.values()].filter(p => p.status !== 'CLOSED').length;
    if (nowOpen >= MAX_POSITIONS) break;
    if (activePositions.has(symbol)) continue;

    await enterPosition(symbol, signal);
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

  // 15M fallback if 5M direction is unclear
  if (signal.direction === null || signal.band === 'AVOID') {
    const candles15m = await getKlines(symbol, '15', 200);
    if (candles15m && candles15m.length >= 60) {
      signal = scoreSignal(candles5m, candles15m);
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
  const riskAmount   = virtualCapital * RISK_PCT;    // $0.50 base (grows with capital)
  const slDistance   = Math.abs(signal.entryPrice - signal.slPrice);

  if (slDistance <= 0) {
    log('ENTRY', `${symbol}: SL distance is zero — skipping`);
    return;
  }

  let positionQty = riskAmount / slDistance;
  positionQty     = roundQty(positionQty, instrInfo.qtyStep);

  if (positionQty < instrInfo.minQty) {
    log('ENTRY', `${symbol}: Qty ${positionQty} below minQty ${instrInfo.minQty} — skipping`);
    return;
  }

  // ── Place Market Entry Order ─────────────────────────────────────────────
  let order;
  try {
    order = await placeMarketOrder(client, symbol, signal.direction, positionQty, false);
  } catch (err) {
    log('ENTRY', `⚠️ Order placement failed for ${symbol}:`, { error: err.message });
    return;
  }

  // ── Build Position State ─────────────────────────────────────────────────
  const posState = {
    symbol          : symbol,
    side            : signal.direction,
    entryPrice      : signal.entryPrice,
    slPrice         : signal.slPrice,
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

async function runCycle() {
  log('CYCLE', '═══ Cycle start ═══');
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
}

// ── Utility ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  logDivider();
  log('BOOT', '🚀 Wicktor Bybit Demo Bot starting…');
  log('BOOT', `VirtualCapital: $${virtualCapital.toFixed(2)} | Risk/Trade: ${(RISK_PCT * 100).toFixed(1)}% | Leverage: ${LEVERAGE}x`);
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

  // Run the first cycle immediately, then on interval
  await runCycle();
  setInterval(runCycle, SCAN_INTERVAL_MS);
}

boot().catch(err => {
  console.error('[BOOT] Fatal error:', err);
  process.exit(1);
});
