/**
 * engine/scoring.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Signal quality scoring engine.
 *
 * Takes pre-computed indicator arrays and produces:
 *   - continuationScore  (0-100)
 *   - exhaustionScore    (0-100)
 *   - reversalScore      (0-100)
 *   - band: 'EXCELLENT' | 'WATCH' | 'NEUTRAL' | 'AVOID'
 *   - direction: 'Buy' | 'Sell' | null
 *   - confidence: composite quality number
 *
 * Band Classification
 * ───────────────────
 *   EXCELLENT : continuation dominant, continuation >= 75, margin >= 20
 *   WATCH     : continuation dominant, continuation >= 55, margin >= 10
 *   NEUTRAL   : continuation not dominant OR score 40-55
 *   AVOID     : exhaustion/reversal dominant, or score < 40
 *
 * Pass-through contract (enforced in bot.js):
 *   band ∈ {EXCELLENT, WATCH}
 *   continuationScore > exhaustionScore AND continuationScore > reversalScore
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';

const {
  calcHeikinAshi,
  calcAlligatorJaw,
  calcATR,
  calcFractals,
  calcRSI,
  calcWilliamsR,
  countConsecutiveHA,
  priceVsJaw,
  getLatestJaw,
} = require('./indicators');

// ── Band thresholds ───────────────────────────────────────────────────────────
const BAND = {
  EXCELLENT_MIN_CONT  : 75,
  EXCELLENT_MIN_MARGIN: 20,
  WATCH_MIN_CONT      : 55,
  WATCH_MIN_MARGIN    : 10,
};

// ── Williams %R zones ─────────────────────────────────────────────────────────
const WR_OVERBOUGHT = -20;   // above this → overbought
const WR_OVERSOLD   = -80;   // below this → oversold
const WR_BULL_ZONE  = -50;   // above this and trending up → bullish momentum
const WR_BEAR_ZONE  = -50;   // below this and trending down → bearish momentum

// ── RSI zones ─────────────────────────────────────────────────────────────────
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD   = 30;
const RSI_BULL_MIN   = 50;   // RSI > 50 supports bull continuation

// ── ATR floor multiplier ──────────────────────────────────────────────────────
// SL distance must be at least ATR_FLOOR_MULT * ATR
const ATR_FLOOR_MULT = 0.5;

/**
 * Main scoring function.
 *
 * @param {object[]} candles5m  Standard 5M OHLCV candles (≥ 100 bars recommended)
 * @param {object[]} [candles15m] Optional 15M candles for trend alignment fallback
 * @returns {object} Signal descriptor
 */
function scoreSignal(candles5m, candles15m = null) {
  if (!candles5m || candles5m.length < 50) {
    return _nullSignal('Insufficient candle data');
  }

  // ── Compute indicators ──────────────────────────────────────────────────────
  const ha5m     = calcHeikinAshi(candles5m);
  const jaw5m    = calcAlligatorJaw(ha5m);
  const atr5m    = calcATR(candles5m);
  const wr5m     = calcWilliamsR(candles5m);
  const rsi5m    = calcRSI(candles5m);
  const frac5m   = calcFractals(candles5m);

  // Latest values (last completed bar = second-to-last; last bar may be open)
  const lastIdx  = candles5m.length - 2;  // confirmed closed bar
  if (lastIdx < 14) return _nullSignal('Not enough confirmed bars');

  const lastHA   = ha5m[lastIdx];
  const lastJaw  = getLatestJaw(jaw5m);
  const lastATR  = atr5m.filter(v => !isNaN(v)).at(-1) ?? 0;
  const lastWR   = wr5m[lastIdx];
  const lastRSI  = rsi5m[lastIdx];
  const lastPrice= candles5m[lastIdx].close;

  if (lastJaw == null || isNaN(lastWR) || isNaN(lastRSI)) {
    return _nullSignal('Indicator warm-up incomplete');
  }

  // ── Trend alignment check ──────────────────────────────────────────────────
  // Primary: 5M HA direction
  // Fallback: 15M HA direction when 5M is ambiguous
  let primaryDirection = _haDirection(ha5m);

  if (primaryDirection === null && candles15m && candles15m.length >= 50) {
    const ha15m         = calcHeikinAshi(candles15m);
    primaryDirection    = _haDirection(ha15m);
    if (primaryDirection === null) return _nullSignal('No clear trend on 5M or 15M');
  } else if (primaryDirection === null) {
    return _nullSignal('No clear 5M trend and no 15M fallback');
  }

  const isBull = primaryDirection === 'Buy';

  // ── Jaw position relative to price ────────────────────────────────────────
  const jawPosition = priceVsJaw(lastPrice, jaw5m);

  // ── HA momentum streak ─────────────────────────────────────────────────────
  const haStreak = countConsecutiveHA(ha5m, isBull ? 'bull' : 'bear');

  // ── Fractal SL reference ───────────────────────────────────────────────────
  const { lastUpFractal, lastDownFractal } = frac5m;

  // ── Continuation Score (0-100) ─────────────────────────────────────────────
  let contScore = 0;

  // 1. HA direction aligned with our bias (40 pts max)
  if (isBull) {
    contScore += lastHA.bullish ? 40 : 0;
  } else {
    contScore += !lastHA.bullish ? 40 : 0;
  }

  // 2. Price above/below Jaw (25 pts)
  if (isBull && jawPosition === 'above') contScore += 25;
  if (!isBull && jawPosition === 'below') contScore += 25;

  // 3. Williams %R momentum zone (20 pts)
  if (isBull && lastWR > WR_BULL_ZONE && lastWR < WR_OVERBOUGHT) contScore += 20;
  if (!isBull && lastWR < -WR_BEAR_ZONE + (-100) && lastWR > WR_OVERSOLD) {
    // Bear: %R between -50 and -80 (momentum zone toward oversold but not extreme)
    contScore += 20;
  }
  // Simpler bear zone check
  if (!isBull && lastWR < WR_BEAR_ZONE && lastWR > WR_OVERSOLD) contScore += 20;

  // 4. RSI supports direction (15 pts)
  if (isBull && lastRSI > RSI_BULL_MIN) contScore += 15;
  if (!isBull && lastRSI < (100 - RSI_BULL_MIN)) contScore += 15;

  // 5. HA streak bonus (bonus up to 10 extra pts, capped)
  contScore = Math.min(100, contScore + Math.min(haStreak * 2, 10));

  // ── Exhaustion Score (0-100) ───────────────────────────────────────────────
  let exhScore = 0;

  // 1. WR extreme zone signals potential exhaustion (35 pts)
  if (isBull && lastWR >= WR_OVERBOUGHT) exhScore += 35;
  if (!isBull && lastWR <= WR_OVERSOLD)  exhScore += 35;

  // 2. RSI extreme (30 pts)
  if (isBull && lastRSI >= RSI_OVERBOUGHT)  exhScore += 30;
  if (!isBull && lastRSI <= RSI_OVERSOLD)   exhScore += 30;

  // 3. Price near opposing fractal (proximity check) (20 pts)
  if (isBull && lastUpFractal != null) {
    const fracDist = Math.abs(lastPrice - lastUpFractal) / lastPrice;
    if (fracDist < 0.005) exhScore += 20; // within 0.5% of up fractal = resistance
  }
  if (!isBull && lastDownFractal != null) {
    const fracDist = Math.abs(lastPrice - lastDownFractal) / lastPrice;
    if (fracDist < 0.005) exhScore += 20;
  }

  // 4. Long HA streak = possible exhaustion (15 pts)
  if (haStreak >= 8) exhScore += 15;
  else if (haStreak >= 5) exhScore += 8;

  exhScore = Math.min(100, exhScore);

  // ── Reversal Score (0-100) ────────────────────────────────────────────────
  let revScore = 0;

  // 1. HA colour flip (40 pts)
  const prev1 = ha5m[lastIdx - 1];
  const prev2 = ha5m[lastIdx - 2];
  const flipDetected = (isBull && !prev1.bullish && !prev2.bullish && lastHA.bullish)
    || (!isBull && prev1.bullish && prev2.bullish && !lastHA.bullish);
  // Actually a flip INTO our direction is continuation, not reversal;
  // a flip AGAINST is reversal risk
  const flipAgainst = (isBull && !lastHA.bullish)
    || (!isBull && lastHA.bullish);
  if (flipAgainst) revScore += 40;

  // 2. Price crossing Jaw (30 pts)
  if ((isBull && jawPosition === 'below') || (!isBull && jawPosition === 'above')) {
    revScore += 30;
  }

  // 3. WR crossing momentum threshold against bias (30 pts)
  if (isBull && lastWR <= WR_OVERSOLD)    revScore += 30;
  if (!isBull && lastWR >= WR_OVERBOUGHT) revScore += 30;

  revScore = Math.min(100, revScore);

  // ── Band Classification ────────────────────────────────────────────────────
  const contDominant = contScore > exhScore && contScore > revScore;
  const margin       = contScore - Math.max(exhScore, revScore);

  let band;
  if (contDominant && contScore >= BAND.EXCELLENT_MIN_CONT && margin >= BAND.EXCELLENT_MIN_MARGIN) {
    band = 'EXCELLENT';
  } else if (contDominant && contScore >= BAND.WATCH_MIN_CONT && margin >= BAND.WATCH_MIN_MARGIN) {
    band = 'WATCH';
  } else if (!contDominant || contScore < 40) {
    band = 'AVOID';
  } else {
    band = 'NEUTRAL';
  }

  // ── SL Level Calculation ──────────────────────────────────────────────────
  // Anchor: Jaw line, with ATR floor enforcement.
  const atrFloor = lastATR * ATR_FLOOR_MULT;

  let slPrice;
  if (isBull) {
    // Bull: SL below jaw, using down fractal if it's lower
    const jawSl = lastJaw;
    const fracSl = lastDownFractal ?? jawSl;
    slPrice = Math.min(jawSl, fracSl);
    // ATR floor: ensure SL is at least ATR_FLOOR away from entry
    if (lastPrice - slPrice < atrFloor) {
      slPrice = lastPrice - atrFloor;
    }
  } else {
    // Bear: SL above jaw, using up fractal if it's higher
    const jawSl = lastJaw;
    const fracSl = lastUpFractal ?? jawSl;
    slPrice = Math.max(jawSl, fracSl);
    if (slPrice - lastPrice < atrFloor) {
      slPrice = lastPrice + atrFloor;
    }
  }

  // ── Signal age ─────────────────────────────────────────────────────────────
  // The "age" of the signal is the time since the last confirmed bar opened.
  const lastBarTime  = candles5m[lastIdx].openTime;   // ms timestamp
  const signalAgeMs  = Date.now() - lastBarTime;
  const signalAgeMin = signalAgeMs / 60_000;

  // ── Confidence (composite) ─────────────────────────────────────────────────
  const confidence = parseFloat(
    ((contScore * 0.6) + ((100 - exhScore) * 0.25) + ((100 - revScore) * 0.15)).toFixed(1)
  );

  return {
    direction         : primaryDirection,        // 'Buy' | 'Sell'
    band,                                         // 'EXCELLENT' | 'WATCH' | 'NEUTRAL' | 'AVOID'
    continuationScore : Math.round(contScore),
    exhaustionScore   : Math.round(exhScore),
    reversalScore     : Math.round(revScore),
    confidence,
    signalAgeMin      : parseFloat(signalAgeMin.toFixed(1)),
    entryPrice        : lastPrice,
    slPrice           : parseFloat(slPrice.toFixed(8)),
    jawValue          : parseFloat(lastJaw.toFixed(8)),
    atr               : parseFloat(lastATR.toFixed(8)),
    haStreak,
    lastWR            : parseFloat(lastWR.toFixed(2)),
    lastRSI           : parseFloat(lastRSI.toFixed(2)),
    lastUpFractal,
    lastDownFractal,
    reason            : null,
  };
}

/**
 * Determine the dominant HA direction from the last 3 confirmed bars.
 * Returns null if mixed.
 *
 * @param {object[]} haCandles
 * @returns {'Buy'|'Sell'|null}
 */
function _haDirection(haCandles) {
  if (haCandles.length < 4) return null;
  const n   = haCandles.length;
  const last = haCandles[n - 2]; // confirmed closed bar
  const p1   = haCandles[n - 3];
  const p2   = haCandles[n - 4];

  const bullCount = [last, p1, p2].filter(c => c.bullish).length;
  const bearCount = 3 - bullCount;

  if (bullCount >= 2) return 'Buy';
  if (bearCount >= 2) return 'Sell';
  return null;
}

/**
 * Build a null/rejected signal descriptor.
 *
 * @param {string} reason
 * @returns {object}
 */
function _nullSignal(reason) {
  return {
    direction         : null,
    band              : 'AVOID',
    continuationScore : 0,
    exhaustionScore   : 0,
    reversalScore     : 0,
    confidence        : 0,
    signalAgeMin      : null,
    entryPrice        : null,
    slPrice           : null,
    jawValue          : null,
    atr               : null,
    haStreak          : 0,
    lastWR            : null,
    lastRSI           : null,
    lastUpFractal     : null,
    lastDownFractal   : null,
    reason,
  };
}

module.exports = {
  scoreSignal,
};
