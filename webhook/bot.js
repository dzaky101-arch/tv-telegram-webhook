/**
 * ══════════════════════════════════════════════════════════════════
 *  XAUUSD SNR • SBR • RBS Alert Bot (Standalone)
 *  Runs 24/7 on Railway — No external dependencies
 * ══════════════════════════════════════════════════════════════════
 *
 *  Data:   TwelveData Free API (H4 + D1 candles)
 *  Alerts: Telegram Bot API
 *  Logic:  Ported from Pine Script SNR_SBR_RBS_Zones.pine
 *
 *  ENV VARS:
 *    BOT_TOKEN      – Telegram Bot token
 *    CHAT_ID        – Telegram chat/group ID
 *    TWELVEDATA_KEY – TwelveData API key (free tier: 800 req/day)
 *
 * ══════════════════════════════════════════════════════════════════
 */

'use strict';

const https = require('https');
const http  = require('http');

// ══════════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════════

const BOT_TOKEN      = process.env.BOT_TOKEN      || '';
const CHAT_ID        = process.env.CHAT_ID         || '';
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY  || '';
const PORT           = process.env.PORT            || 3000;

const SYMBOL         = 'XAU/USD';
const SCAN_INTERVAL  = 5 * 60 * 1000;                 // 5 minutes
const COOLDOWN_MS    = 4 * 60 * 60 * 1000;             // 4 hours
const ZONE_THRESHOLD = 0.003;                          // 0.3% cluster threshold
const MAX_ZONES      = 5;                              // per side
const ATR_PERIOD     = 14;
const ZONE_ATR_MULT  = 0.5;

const TIMEFRAMES = [
  { label: 'H4',  interval: '4h',   outputsize: 100, pivotLen: 3 },
  { label: 'D1',  interval: '1day', outputsize: 100, pivotLen: 5 },
];

// ══════════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════════

// Alert cooldown map: key → last alert timestamp
const alertCooldowns = new Map();

// Persistent zone state per timeframe
const tfState = {};
for (const tf of TIMEFRAMES) {
  tfState[tf.label] = {
    snrZones:  [],   // { top, bot, type: 'support'|'resistance', strength }
    flipZones: [],   // { top, bot, type: 'sbr'|'rbs' }
  };
}

let cycleCount  = 0;
let startTime   = null;

// ══════════════════════════════════════════════════════════════════
//  HTTP HELPERS (built-in https only)
// ══════════════════════════════════════════════════════════════════

/**
 * Generic HTTPS GET → returns parsed JSON
 */
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message} | Raw: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * HTTPS POST JSON → returns parsed JSON
 */
function httpsPostJson(hostname, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length':  Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════════════════════════

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('⚠️  BOT_TOKEN or CHAT_ID not set — skipping Telegram');
    return null;
  }

  try {
    const result = await httpsPostJson('api.telegram.org', `/bot${BOT_TOKEN}/sendMessage`, {
      chat_id:    CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    if (result.ok) {
      console.log('  ✅ Telegram sent');
    } else {
      console.error('  ❌ Telegram error:', result.description);
    }
    return result;
  } catch (err) {
    console.error('  ❌ Telegram request failed:', err.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════
//  TWELVEDATA — FETCH CANDLES
// ══════════════════════════════════════════════════════════════════

async function fetchCandles(interval, outputsize) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL)}`
    + `&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVEDATA_KEY}`;

  const data = await httpsGet(url);

  if (data.status === 'error') {
    throw new Error(`TwelveData error: ${data.message || JSON.stringify(data)}`);
  }

  if (!data.values || !Array.isArray(data.values)) {
    throw new Error(`TwelveData: unexpected response shape — ${JSON.stringify(data).substring(0, 300)}`);
  }

  // TwelveData returns newest first — reverse to chronological order
  const candles = data.values.reverse().map((v) => ({
    datetime: v.datetime,
    open:     parseFloat(v.open),
    high:     parseFloat(v.high),
    low:      parseFloat(v.low),
    close:    parseFloat(v.close),
  }));

  return candles;
}

// ══════════════════════════════════════════════════════════════════
//  TECHNICAL — ATR
// ══════════════════════════════════════════════════════════════════

function calcATR(candles, period) {
  if (candles.length < period + 1) return 0;

  const trList = [];
  for (let i = 1; i < candles.length; i++) {
    const c  = candles[i];
    const pc = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - pc.close),
      Math.abs(c.low - pc.close)
    );
    trList.push(tr);
  }

  // Simple moving average of TR for initial ATR, then EMA-style
  if (trList.length < period) return trList.reduce((a, b) => a + b, 0) / trList.length;

  let atr = 0;
  for (let i = 0; i < period; i++) atr += trList[i];
  atr /= period;

  for (let i = period; i < trList.length; i++) {
    atr = (atr * (period - 1) + trList[i]) / period;
  }

  return atr;
}

// ══════════════════════════════════════════════════════════════════
//  TECHNICAL — PIVOT DETECTION
// ══════════════════════════════════════════════════════════════════

/**
 * Detect pivot highs and lows.
 * A pivot high at index i means: high[i] is the highest of [i-leftBars .. i+rightBars]
 * A pivot low at index i means:  low[i] is the lowest of [i-leftBars .. i+rightBars]
 *
 * Returns: { pivotHighs: [{index, price}], pivotLows: [{index, price}] }
 */
function findPivots(candles, leftBars, rightBars) {
  const pivotHighs = [];
  const pivotLows  = [];

  for (let i = leftBars; i < candles.length - rightBars; i++) {
    // Pivot High check
    let isHigh = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) {
        isHigh = false;
        break;
      }
    }
    if (isHigh) pivotHighs.push({ index: i, price: candles[i].high });

    // Pivot Low check
    let isLow = true;
    for (let j = i - leftBars; j <= i + rightBars; j++) {
      if (j === i) continue;
      if (candles[j].low <= candles[i].low) {
        isLow = false;
        break;
      }
    }
    if (isLow) pivotLows.push({ index: i, price: candles[i].low });
  }

  return { pivotHighs, pivotLows };
}

// ══════════════════════════════════════════════════════════════════
//  ZONE CONSTRUCTION
// ══════════════════════════════════════════════════════════════════

/**
 * Cluster nearby pivot prices into zones.
 * Threshold = ZONE_THRESHOLD (0.3%) — pivots within this range merge.
 *
 * Each zone: { top, bot, type, strength, avgPrice }
 */
function clusterPivots(pivots, type, atr) {
  if (pivots.length === 0) return [];

  // Sort by price
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const zones = [];
  let cluster = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = cluster[cluster.length - 1].price;
    const curr = sorted[i].price;
    const pctDiff = Math.abs(curr - prev) / prev;

    if (pctDiff <= ZONE_THRESHOLD) {
      cluster.push(sorted[i]);
    } else {
      zones.push(buildZone(cluster, type, atr));
      cluster = [sorted[i]];
    }
  }
  zones.push(buildZone(cluster, type, atr));

  // Sort by strength descending, take top MAX_ZONES, then sort by price
  zones.sort((a, b) => b.strength - a.strength);
  const topZones = zones.slice(0, MAX_ZONES);
  topZones.sort((a, b) => a.avgPrice - b.avgPrice);

  return topZones;
}

function buildZone(cluster, type, atr) {
  const prices  = cluster.map((c) => c.price);
  const avg     = prices.reduce((a, b) => a + b, 0) / prices.length;
  const w       = atr * ZONE_ATR_MULT;

  // Mirror Pine Script zone width logic
  let top, bot;
  if (type === 'resistance') {
    top = avg + w * 0.3;
    bot = avg - w * 0.7;
  } else {
    top = avg + w * 0.7;
    bot = avg - w * 0.3;
  }

  return {
    top,
    bot,
    type,         // 'support' or 'resistance'
    strength:  cluster.length,
    avgPrice:  avg,
  };
}

// ══════════════════════════════════════════════════════════════════
//  SNR / SBR / RBS ANALYSIS ENGINE
// ══════════════════════════════════════════════════════════════════

/**
 * Full analysis for one timeframe.
 * Returns an array of alert objects to send.
 */
function analyzeTimeframe(tfConfig, candles) {
  const { label, pivotLen } = tfConfig;
  const state = tfState[label];

  const atr = calcATR(candles, ATR_PERIOD);
  if (atr <= 0) {
    console.log(`  ⚠️  [${label}] ATR is zero — not enough data`);
    return [];
  }

  const lastCandle = candles[candles.length - 1];
  const { open, high, low, close } = lastCandle;

  // ── 1) Detect Pivots & Build SNR Zones ──
  const { pivotHighs, pivotLows } = findPivots(candles, pivotLen, pivotLen);

  const resistanceZones = clusterPivots(pivotHighs, 'resistance', atr);
  const supportZones    = clusterPivots(pivotLows,  'support',    atr);

  const newSnrZones = [...supportZones, ...resistanceZones];

  // ── 2) Detect SBR / RBS Flips ──
  const newFlipZones = [...state.flipZones]; // carry forward
  const alertsToSend = [];

  for (const zone of newSnrZones) {
    // Support broken below → SBR
    if (zone.type === 'support' && close < zone.bot) {
      const alreadyFlipped = newFlipZones.some(
        (f) => f.type === 'sbr' && Math.abs(f.avgPrice - zone.avgPrice) / zone.avgPrice < ZONE_THRESHOLD
      );
      if (!alreadyFlipped) {
        const flipZone = { top: zone.top, bot: zone.bot, type: 'sbr', avgPrice: zone.avgPrice };
        newFlipZones.push(flipZone);
        alertsToSend.push({
          alertType: 'SBR_FORMED',
          emoji:     '🟧',
          title:     'SBR Formed (Support → Resistance)',
          zone:      flipZone,
          tf:        label,
          price:     close,
        });
      }
    }

    // Resistance broken above → RBS
    if (zone.type === 'resistance' && close > zone.top) {
      const alreadyFlipped = newFlipZones.some(
        (f) => f.type === 'rbs' && Math.abs(f.avgPrice - zone.avgPrice) / zone.avgPrice < ZONE_THRESHOLD
      );
      if (!alreadyFlipped) {
        const flipZone = { top: zone.top, bot: zone.bot, type: 'rbs', avgPrice: zone.avgPrice };
        newFlipZones.push(flipZone);
        alertsToSend.push({
          alertType: 'RBS_FORMED',
          emoji:     '🟩',
          title:     'RBS Formed (Resistance → Support)',
          zone:      flipZone,
          tf:        label,
          price:     close,
        });
      }
    }
  }

  // ── 3) Mitigate flip zones ──
  const survivingFlips = [];
  for (const fz of newFlipZones) {
    if (fz.type === 'sbr' && close > fz.top) {
      // SBR mitigated — price closed back above → remove
      continue;
    }
    if (fz.type === 'rbs' && close < fz.bot) {
      // RBS mitigated — price closed back below → remove
      continue;
    }
    survivingFlips.push(fz);
  }

  // ── 4) Touch Detection on active SNR zones ──
  // Only zones that are NOT broken
  const activeSupport    = newSnrZones.filter((z) => z.type === 'support' && close >= z.bot);
  const activeResistance = newSnrZones.filter((z) => z.type === 'resistance' && close <= z.top);

  for (const zone of activeSupport) {
    if (low <= zone.top && close >= zone.bot) {
      alertsToSend.push({
        alertType: 'SNR_SUPPORT_TOUCH',
        emoji:     '🟦',
        title:     'SNR Support Touched',
        zone,
        tf:        label,
        price:     close,
      });
    }
  }

  for (const zone of activeResistance) {
    if (high >= zone.bot && close <= zone.top) {
      alertsToSend.push({
        alertType: 'SNR_RESISTANCE_TOUCH',
        emoji:     '🟥',
        title:     'SNR Resistance Touched',
        zone,
        tf:        label,
        price:     close,
      });
    }
  }

  // ── 5) Cap flip zones ──
  const cappedFlips = survivingFlips.slice(-MAX_ZONES);

  // ── 6) Save state ──
  state.snrZones  = newSnrZones;
  state.flipZones = cappedFlips;

  return alertsToSend;
}

// ══════════════════════════════════════════════════════════════════
//  ALERT DEDUPLICATION
// ══════════════════════════════════════════════════════════════════

function cooldownKey(alert) {
  const zoneId = alert.zone ? `${alert.zone.top.toFixed(2)}_${alert.zone.bot.toFixed(2)}` : 'none';
  return `${alert.alertType}|${alert.tf}|${zoneId}`;
}

function shouldSendAlert(alert) {
  const key  = cooldownKey(alert);
  const last = alertCooldowns.get(key);
  const now  = Date.now();

  if (last && (now - last) < COOLDOWN_MS) {
    return false;
  }

  alertCooldowns.set(key, now);
  return true;
}

// Clean up old cooldown entries periodically
function cleanCooldowns() {
  const now = Date.now();
  for (const [key, ts] of alertCooldowns) {
    if ((now - ts) > COOLDOWN_MS * 2) {
      alertCooldowns.delete(key);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
//  MESSAGE FORMATTING
// ══════════════════════════════════════════════════════════════════

function formatWIB() {
  return new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function formatAlertMessage(alert) {
  const sep   = '─'.repeat(26);
  const time  = formatWIB();
  const price = alert.price.toFixed(2);
  const top   = alert.zone.top.toFixed(2);
  const bot   = alert.zone.bot.toFixed(2);

  let hint = '';
  switch (alert.alertType) {
    case 'SNR_SUPPORT_TOUCH':
      hint = '💡 <i>Price touching support area. Look for BUY confirmation!</i>';
      break;
    case 'SNR_RESISTANCE_TOUCH':
      hint = '💡 <i>Price touching resistance area. Look for SELL confirmation!</i>';
      break;
    case 'SBR_FORMED':
      hint = '⚠️ <i>Support BROKEN → became Resistance. Watch for rejection at this zone!</i>';
      break;
    case 'RBS_FORMED':
      hint = '✅ <i>Resistance BROKEN → became Support. Look for BUY on retest!</i>';
      break;
  }

  return [
    `<b>${alert.emoji} ${alert.title}</b>`,
    sep,
    `<b>Symbol:</b> ${SYMBOL}`,
    `<b>Timeframe:</b> ${alert.tf}`,
    `<b>Price:</b> ${price}`,
    `<b>Zone:</b> ${top} — ${bot}`,
    `<b>Strength:</b> ${alert.zone.strength || '—'}`,
    '',
    hint,
    '',
    `🕐 ${time} WIB`,
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════════
//  MAIN SCAN CYCLE
// ══════════════════════════════════════════════════════════════════

async function runScan() {
  cycleCount++;
  const timeStr = formatWIB();
  console.log(`\n📡 [Cycle #${cycleCount}] Scan started at ${timeStr} WIB`);

  let totalAlerts = 0;

  for (const tf of TIMEFRAMES) {
    try {
      console.log(`  📊 Fetching ${tf.label} candles (${tf.interval})...`);
      const candles = await fetchCandles(tf.interval, tf.outputsize);
      console.log(`  📊 Got ${candles.length} candles for ${tf.label}`);

      const alerts = analyzeTimeframe(tf, candles);
      console.log(`  🔍 [${tf.label}] ${alerts.length} raw alert(s) detected`);

      // Log zone counts
      const state = tfState[tf.label];
      const supCount = state.snrZones.filter((z) => z.type === 'support').length;
      const resCount = state.snrZones.filter((z) => z.type === 'resistance').length;
      const sbrCount = state.flipZones.filter((z) => z.type === 'sbr').length;
      const rbsCount = state.flipZones.filter((z) => z.type === 'rbs').length;
      console.log(`  📋 [${tf.label}] Zones: ${supCount} Support, ${resCount} Resistance, ${sbrCount} SBR, ${rbsCount} RBS`);

      for (const alert of alerts) {
        if (shouldSendAlert(alert)) {
          const msg = formatAlertMessage(alert);
          await sendTelegram(msg);
          totalAlerts++;

          // Small delay between messages to respect Telegram rate limit
          await sleep(500);
        } else {
          console.log(`  ⏳ Cooldown active for: ${alert.alertType} [${tf.label}]`);
        }
      }

    } catch (err) {
      console.error(`  ❌ [${tf.label}] Error: ${err.message}`);
    }

    // Delay between TF fetches to respect TwelveData rate limits
    if (TIMEFRAMES.indexOf(tf) < TIMEFRAMES.length - 1) {
      await sleep(2000);
    }
  }

  cleanCooldowns();

  console.log(`✅ [Cycle #${cycleCount}] Complete — ${totalAlerts} alert(s) sent`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ══════════════════════════════════════════════════════════════════
//  HEALTH SERVER (keeps Railway alive)
// ══════════════════════════════════════════════════════════════════

function startHealthServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
      const uptime    = process.uptime();
      const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status:  'ok',
        service: 'XAUUSD SNR/SBR/RBS Alert Bot',
        uptime:  uptimeStr,
        cycles:  cycleCount,
        started: startTime,
        zones: Object.fromEntries(
          TIMEFRAMES.map((tf) => [
            tf.label,
            {
              support:    tfState[tf.label].snrZones.filter((z) => z.type === 'support').length,
              resistance: tfState[tf.label].snrZones.filter((z) => z.type === 'resistance').length,
              sbr:        tfState[tf.label].flipZones.filter((z) => z.type === 'sbr').length,
              rbs:        tfState[tf.label].flipZones.filter((z) => z.type === 'rbs').length,
            }
          ])
        ),
      }));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  server.listen(PORT, () => {
    console.log(`🌐 Health server listening on port ${PORT}`);
  });
}

// ══════════════════════════════════════════════════════════════════
//  STARTUP
// ══════════════════════════════════════════════════════════════════

async function main(standalone) {
  startTime = new Date().toISOString();

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🤖 XAUUSD SNR • SBR • RBS Alert Bot                   ║
║  Data:     TwelveData API (H4 + D1)                     ║
║  Alerts:   Telegram Bot                                 ║
║  Interval: Every 5 minutes                              ║
║  Cooldown: 4 hours per alert type+zone                  ║
╚══════════════════════════════════════════════════════════╝
  `);

  // Validate env
  const missing = [];
  if (!BOT_TOKEN)      missing.push('BOT_TOKEN');
  if (!CHAT_ID)        missing.push('CHAT_ID');
  if (!TWELVEDATA_KEY) missing.push('TWELVEDATA_KEY');

  if (missing.length > 0) {
    console.error(`❌ Missing environment variables: ${missing.join(', ')}`);
    console.error('   Set them in Railway dashboard or .env file.');
    if (standalone) process.exit(1);
    return;
  }

  console.log('✅ All environment variables loaded');

  // Start health server ONLY when running standalone (not from server.js)
  if (standalone) {
    startHealthServer();
  }

  // Send startup message
  const startMsg = [
    '<b>🤖 XAUUSD Alert Bot Started</b>',
    '─'.repeat(26),
    `<b>Symbol:</b> ${SYMBOL}`,
    `<b>Timeframes:</b> ${TIMEFRAMES.map((t) => t.label).join(', ')}`,
    `<b>Scan Interval:</b> 5 min`,
    `<b>Cooldown:</b> 4 hours`,
    `<b>Zones per side:</b> ${MAX_ZONES}`,
    '',
    `🕐 ${formatWIB()} WIB`,
  ].join('\n');

  await sendTelegram(startMsg);

  // Initial scan
  console.log('\n🚀 Running initial scan...');
  await runScan();

  // Schedule recurring scans
  setInterval(async () => {
    try {
      await runScan();
    } catch (err) {
      console.error('❌ Scan cycle error:', err.message);
    }
  }, SCAN_INTERVAL);

  console.log(`\n⏱️  Next scan in ${SCAN_INTERVAL / 1000}s — bot is running 24/7`);
}

// ── Graceful shutdown ──
process.on('SIGINT',  () => { console.log('\n👋 Bot shutting down (SIGINT)');  process.exit(0); });
process.on('SIGTERM', () => { console.log('\n👋 Bot shutting down (SIGTERM)'); process.exit(0); });

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Unhandled rejection:', reason);
});

// ── Detect: standalone (node bot.js) vs required (from server.js) ──
const isStandalone = require.main === module;

if (isStandalone) {
  // Running directly: node bot.js
  main(true).catch((err) => {
    console.error('💥 Fatal startup error:', err.message);
    process.exit(1);
  });
} else {
  // Required from server.js — no health server, just start bot
  main(false).catch((err) => {
    console.error('💥 Bot startup error:', err.message);
  });
}

