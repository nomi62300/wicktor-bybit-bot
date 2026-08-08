/**
 * engine/api.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Bybit V5 REST helpers.
 * All functions accept the already-initialised RestClientV5 instance from
 * bot.js so no second client is created here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const axios = require('axios');

// ── Constants ─────────────────────────────────────────────────────────────────
const CATEGORY      = 'linear';
const BYBIT_BASE    = 'https://api-demo.bybit.com';   // demo endpoint for public data

const MIN_TURNOVER_24H = 15_000_000; // 15M USDT 24h turnover liquidity floor

/**
 * Fetch the top N USDT-Perpetual symbols by 24-hour USDT volume.
 * Filters out any coins with 24h USDT turnover below 15,000,000 USDT.
 * Uses the public tickers endpoint so no auth is needed.
 *
 * @param {number} [limit=60]
 * @returns {Promise<string[]>} e.g. ['BTCUSDT', 'ETHUSDT', ...]
 */
async function getTop60Symbols(limit = 60) {
  const url = `${BYBIT_BASE}/v5/market/tickers?category=${CATEGORY}`;
  const res = await axios.get(url, { timeout: 10_000 });

  if (res.data?.retCode !== 0) {
    throw new Error(`Tickers error: ${res.data?.retMsg}`);
  }

  const tickers = res.data.result.list;

  // Filter to USDT-margined perps only with 24h turnover >= 15,000,000 USDT, sorted descending
  const sorted = tickers
    .filter(t => {
      if (!t.symbol.endsWith('USDT')) return false;
      const turnover = parseFloat(t.turnover24h || '0');
      const calcTurnover = parseFloat(t.volume24h || '0') * parseFloat(t.lastPrice || '0');
      const effectiveTurnover = turnover > 0 ? turnover : calcTurnover;
      return effectiveTurnover >= MIN_TURNOVER_24H;
    })
    .sort((a, b) => parseFloat(b.turnover24h || '0') - parseFloat(a.turnover24h || '0'))
    .slice(0, limit)
    .map(t => t.symbol);

  return sorted;
}

const getUniverse = getTop60Symbols;

/**
 * Fetch OHLCV kline data for a symbol.
 *
 * @param {string} symbol   e.g. 'BTCUSDT'
 * @param {string} interval Bybit interval code: '1','3','5','15','30','60','D'
 * @param {number} [limit=200]
 * @returns {Promise<Array>} Chronological array of candle objects:
 *   { openTime, open, high, low, close, volume }
 */
async function getKlines(symbol, interval, limit = 200) {
  const url = `${BYBIT_BASE}/v5/market/kline?category=${CATEGORY}&symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await axios.get(url, { timeout: 10_000 });

  if (res.data?.retCode !== 0) {
    throw new Error(`Klines error for ${symbol}: ${res.data?.retMsg}`);
  }

  // Bybit returns newest-first; reverse to chronological order.
  const raw = res.data.result.list.reverse();

  return raw.map(c => ({
    openTime : parseInt(c[0], 10),
    open     : parseFloat(c[1]),
    high     : parseFloat(c[2]),
    low      : parseFloat(c[3]),
    close    : parseFloat(c[4]),
    volume   : parseFloat(c[5]),
  }));
}

/**
 * Get the latest ticker price for a symbol (public endpoint).
 *
 * @param {string} symbol
 * @returns {Promise<number>}
 */
async function getLastPrice(symbol) {
  const url = `${BYBIT_BASE}/v5/market/tickers?category=${CATEGORY}&symbol=${symbol}`;
  const res = await axios.get(url, { timeout: 8_000 });

  if (res.data?.retCode !== 0) {
    throw new Error(`Price error for ${symbol}: ${res.data?.retMsg}`);
  }

  return parseFloat(res.data.result.list[0]?.lastPrice ?? 0);
}

/**
 * Set leverage for a symbol on both sides.
 * Silently ignores the "leverage not modified" error code (110043).
 *
 * @param {import('bybit-api').RestClientV5} client
 * @param {string} symbol
 * @param {number} [leverage=5]
 */
async function setSymbolLeverage(client, symbol, leverage = 5) {
  try {
    const lev = String(leverage);
    const res = await client.setLeverage({
      category    : CATEGORY,
      symbol,
      buyLeverage : lev,
      sellLeverage: lev,
    });

    // 110043 = "leverage not modified" — not a real error
    if (res.retCode !== 0 && res.retCode !== 110043) {
      console.warn(`[API] setLeverage ${symbol}: ${res.retMsg}`);
    }
  } catch (err) {
    // Non-fatal — log and continue
    console.warn(`[API] setLeverage exception for ${symbol}:`, err.message);
  }
}

/**
 * Place a market order.
 *
 * @param {import('bybit-api').RestClientV5} client
 * @param {string} symbol
 * @param {'Buy'|'Sell'} side
 * @param {number} qty  — base-asset quantity, already rounded to lot size
 * @param {boolean} [reduceOnly=false]
 * @returns {Promise<object>} Full Bybit response
 */
async function placeMarketOrder(client, symbol, side, qty, reduceOnly = false, takeProfit = null, stopLoss = null) {
  const params = {
    category   : CATEGORY,
    symbol,
    side,
    orderType  : 'Market',
    qty        : String(qty),
    timeInForce: 'IOC',
    reduceOnly,
    positionIdx: 0,   // one-way mode
  };

  if (takeProfit != null) params.takeProfit = String(takeProfit);
  if (stopLoss != null) params.stopLoss = String(stopLoss);

  const res = await client.submitOrder(params);

  if (res.retCode !== 0) {
    throw new Error(`Order failed for ${symbol} ${side} ${qty}: ${res.retMsg}`);
  }

  return res.result;
}

/**
 * Fetch all open linear positions.
 *
 * @param {import('bybit-api').RestClientV5} client
 * @returns {Promise<object[]>}
 */
async function getOpenPositions(client) {
  const res = await client.getPositionInfo({ category: CATEGORY, settleCoin: 'USDT' });

  if (res.retCode !== 0) {
    throw new Error(`getPositions error: ${res.retMsg}`);
  }

  // Return only positions with non-zero size
  return (res.result?.list ?? []).filter(p => parseFloat(p.size) > 0);
}

/**
 * Get instrument info (lot size, tick size, min qty) for a symbol.
 * Used to round qty / price correctly before submitting orders.
 *
 * @param {string} symbol
 * @returns {Promise<{qtyStep: number, minQty: number, tickSize: number}>}
 */
async function getInstrumentInfo(symbol) {
  const url = `${BYBIT_BASE}/v5/market/instruments-info?category=${CATEGORY}&symbol=${symbol}`;
  const res = await axios.get(url, { timeout: 8_000 });

  if (res.data?.retCode !== 0) {
    throw new Error(`InstrumentInfo error for ${symbol}: ${res.data?.retMsg}`);
  }

  const info = res.data.result.list[0];
  const lot  = info?.lotSizeFilter ?? {};
  const price = info?.priceFilter ?? {};

  return {
    qtyStep : parseFloat(lot.qtyStep  ?? '0.001'),
    minQty  : parseFloat(lot.minOrderQty ?? '0.001'),
    tickSize: parseFloat(price.tickSize ?? '0.01'),
  };
}

/**
 * Round a quantity DOWN to the nearest allowed lot step.
 *
 * @param {number} qty
 * @param {number} step
 * @returns {number}
 */
function roundQty(qty, step) {
  if (step <= 0) return qty;
  const precision = countDecimals(step);
  const floored   = Math.floor(qty / step) * step;
  return parseFloat(floored.toFixed(precision));
}

/**
 * Round a price to the nearest tick size.
 *
 * @param {number} price
 * @param {number} tickSize
 * @returns {number}
 */
function roundPrice(price, tickSize) {
  if (tickSize <= 0) return price;
  const precision = countDecimals(tickSize);
  const rounded   = Math.round(price / tickSize) * tickSize;
  return parseFloat(rounded.toFixed(precision));
}

function countDecimals(value) {
  const str = value.toString();
  const idx = str.indexOf('.');
  return idx === -1 ? 0 : str.length - idx - 1;
}

module.exports = {
  getTop60Symbols,
  getUniverse,
  getKlines,
  getLastPrice,
  setSymbolLeverage,
  placeMarketOrder,
  getOpenPositions,
  getInstrumentInfo,
  roundQty,
  roundPrice,
};
