/**
 * engine/indicators.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure indicator calculations — no side effects, no I/O.
 *
 * All functions accept a chronologically-ordered candle array:
 *   [{ openTime, open, high, low, close, volume }, ...]
 *
 * Returns are plain numbers or arrays (newest value last).
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

// ── Heikin Ashi ───────────────────────────────────────────────────────────────

/**
 * Convert a standard OHLCV candle array into Heikin Ashi candles.
 *
 * HA Formula:
 *   haClose = (O + H + L + C) / 4
 *   haOpen  = (prev_haOpen + prev_haClose) / 2      (seed: first O)
 *   haHigh  = max(H, haOpen, haClose)
 *   haLow   = min(L, haOpen, haClose)
 *
 * @param {object[]} candles
 * @returns {object[]} HA candle array (same length, same index mapping)
 */
function calcHeikinAshi(candles) {
  const ha = [];

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen  = i === 0
      ? c.open
      : (ha[i - 1].open + ha[i - 1].close) / 2;
    const haHigh  = Math.max(c.high,  haOpen, haClose);
    const haLow   = Math.min(c.low,   haOpen, haClose);

    ha.push({
      openTime: c.openTime,
      open    : haOpen,
      high    : haHigh,
      low     : haLow,
      close   : haClose,
      volume  : c.volume,
      bullish : haClose >= haOpen,    // convenience flag
    });
  }

  return ha;
}

// ── Smoothed Moving Average (SMMA / RMA) ─────────────────────────────────────

/**
 * Calculate Smoothed Moving Average array (same length as input).
 * First `period` values are seeded with the simple average.
 *
 * @param {number[]} values
 * @param {number} period
 * @returns {number[]}
 */
function calcSMMA(values, period) {
  const result = new Array(values.length).fill(NaN);
  if (values.length < period) return result;

  // Seed value: simple average of first `period` elements
  let smma = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  result[period - 1] = smma;

  for (let i = period; i < values.length; i++) {
    smma = (smma * (period - 1) + values[i]) / period;
    result[i] = smma;
  }

  return result;
}

// ── Williams Alligator — Jaw (Blue Line) ─────────────────────────────────────

/**
 * Calculate the Alligator Jaw line (13-period SMMA, offset 8 bars into future).
 * Since we work on historical data, the offset means we shift values 8 positions
 * backward (i.e. the jaw value at bar N was calculated 8 bars ago).
 *
 * In practice for live signals we use the latest non-NaN jaw value — the
 * 8-bar future-shift is inapplicable for real-time; we treat it as the
 * last valid SMMA(13) of the HA midpoints.
 *
 * @param {object[]} haCandles  Heikin Ashi candles
 * @param {number}   [period=13]
 * @returns {number[]}  Jaw values array (same length as haCandles)
 */
function calcAlligatorJaw(haCandles, period = 13) {
  const midpoints = haCandles.map(c => (c.high + c.low) / 2);
  return calcSMMA(midpoints, period);
}

// ── ATR ───────────────────────────────────────────────────────────────────────

/**
 * Average True Range over `period` bars.
 *
 * TR = max(H-L, |H-prevC|, |L-prevC|)
 *
 * @param {object[]} candles  Standard or HA candles (same shape)
 * @param {number}   [period=14]
 * @returns {number[]}  ATR array, same length as candles (NaN for first bar)
 */
function calcATR(candles, period = 14) {
  const atr   = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return atr;

  const trs = [NaN]; // index 0 has no previous close

  for (let i = 1; i < candles.length; i++) {
    const h  = candles[i].high;
    const l  = candles[i].low;
    const pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // Seed: simple average of first `period` TRs (starting at index 1)
  let atrVal = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  atr[period] = atrVal;

  for (let i = period + 1; i < candles.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
    atr[i] = atrVal;
  }

  return atr;
}

// ── Fractals ──────────────────────────────────────────────────────────────────

/**
 * Williams Fractals (5-bar pattern).
 * An UP fractal: middle bar's high is highest of 5 bars.
 * A DOWN fractal: middle bar's low  is lowest  of 5 bars.
 *
 * Returns the most recent up-fractal HIGH and down-fractal LOW prices.
 * These serve as opposing fractal SL reference levels.
 *
 * @param {object[]} candles
 * @returns {{ lastUpFractal: number|null, lastDownFractal: number|null }}
 */
function calcFractals(candles) {
  let lastUpFractal   = null;
  let lastDownFractal = null;

  for (let i = 2; i < candles.length - 2; i++) {
    const mid = candles[i];

    // Up fractal
    if (
      mid.high > candles[i - 1].high &&
      mid.high > candles[i - 2].high &&
      mid.high > candles[i + 1].high &&
      mid.high > candles[i + 2].high
    ) {
      lastUpFractal = mid.high;
    }

    // Down fractal
    if (
      mid.low < candles[i - 1].low &&
      mid.low < candles[i - 2].low &&
      mid.low < candles[i + 1].low &&
      mid.low < candles[i + 2].low
    ) {
      lastDownFractal = mid.low;
    }
  }

  return { lastUpFractal, lastDownFractal };
}

// ── EMA ───────────────────────────────────────────────────────────────────────

/**
 * Exponential Moving Average.
 *
 * @param {number[]} values
 * @param {number}   period
 * @returns {number[]}
 */
function calcEMA(values, period) {
  const ema = new Array(values.length).fill(NaN);
  if (values.length < period) return ema;

  // Seed with SMA
  const k   = 2 / (period + 1);
  let prev  = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev   = values[i] * k + prev * (1 - k);
    ema[i] = prev;
  }

  return ema;
}

// ── RSI ───────────────────────────────────────────────────────────────────────

/**
 * Relative Strength Index.
 *
 * @param {object[]} candles
 * @param {number}   [period=14]
 * @returns {number[]}  RSI values (0-100), same length as candles
 */
function calcRSI(candles, period = 14) {
  const rsi = new Array(candles.length).fill(NaN);
  if (candles.length < period + 1) return rsi;

  const closes = candles.map(c => c.close);
  let gains = 0, losses = 0;

  // Seed
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains  += diff;
    else           losses -= diff;
  }

  let avgGain = gains  / period;
  let avgLoss = losses / period;

  const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  rsi[period] = 100 - 100 / (1 + rs);

  for (let i = period + 1; i < candles.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ?  diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const r = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    rsi[i] = 100 - 100 / (1 + r);
  }

  return rsi;
}

// ── Williams %R ───────────────────────────────────────────────────────────────

/**
 * Williams %R oscillator.
 *
 * %R = (Highest High - Close) / (Highest High - Lowest Low) * -100
 * Range: -100 (most oversold) to 0 (most overbought).
 *
 * @param {object[]} candles
 * @param {number}   [period=14]
 * @returns {number[]}  %R values, same length as candles
 */
function calcWilliamsR(candles, period = 14) {
  const wr = new Array(candles.length).fill(NaN);
  if (candles.length < period) return wr;

  for (let i = period - 1; i < candles.length; i++) {
    const window = candles.slice(i - period + 1, i + 1);
    const hh = Math.max(...window.map(c => c.high));
    const ll = Math.min(...window.map(c => c.low));
    const range = hh - ll;

    wr[i] = range === 0 ? -50 : ((hh - candles[i].close) / range) * -100;
  }

  return wr;
}

// ── Trend Alignment Helpers ───────────────────────────────────────────────────

/**
 * Count consecutive bullish or bearish Heikin Ashi bars from the last bar
 * going backward. Useful for measuring trend persistence.
 *
 * @param {object[]} haCandles
 * @param {'bull'|'bear'} direction
 * @returns {number}
 */
function countConsecutiveHA(haCandles, direction) {
  let count = 0;
  for (let i = haCandles.length - 1; i >= 0; i--) {
    const isBull = haCandles[i].bullish;
    if ((direction === 'bull' && isBull) || (direction === 'bear' && !isBull)) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Determine if the close price is above or below the Alligator Jaw.
 *
 * @param {number} price
 * @param {number[]} jawValues
 * @returns {'above'|'below'|'on'}
 */
function priceVsJaw(price, jawValues) {
  const jaw = jawValues.filter(v => !isNaN(v)).at(-1);
  if (jaw == null) return 'on';
  if (price > jaw * 1.0001) return 'above';
  if (price < jaw * 0.9999) return 'below';
  return 'on';
}

/**
 * Get the current (latest valid) Jaw value.
 *
 * @param {number[]} jawValues
 * @returns {number|null}
 */
function getLatestJaw(jawValues) {
  for (let i = jawValues.length - 1; i >= 0; i--) {
    if (!isNaN(jawValues[i])) return jawValues[i];
  }
  return null;
}

module.exports = {
  calcHeikinAshi,
  calcAlligatorJaw,
  calcATR,
  calcFractals,
  calcEMA,
  calcRSI,
  calcWilliamsR,
  countConsecutiveHA,
  priceVsJaw,
  getLatestJaw,
};
