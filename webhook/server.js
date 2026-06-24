/**
 * ══════════════════════════════════════════════════════════════
 *  TradingView Webhook → Telegram Bot Relay Server
 *  SNR • SBR • RBS Alert System
 * ══════════════════════════════════════════════════════════════
 *
 *  Flow:  TradingView Alert → Webhook POST → Server ini → Telegram Bot
 *
 *  Setup:
 *    1. Set BOT_TOKEN & CHAT_ID di .env atau environment variable
 *    2. Deploy ke Railway/Render/VPS
 *    3. Pakai URL server sebagai webhook di TradingView Alert
 *
 * ══════════════════════════════════════════════════════════════
 */

const express = require('express');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ──
const BOT_TOKEN = process.env.BOT_TOKEN || 'ISI_BOT_TOKEN_KAMU';
const CHAT_ID   = process.env.CHAT_ID   || 'ISI_CHAT_ID_KAMU';

app.use(express.json());
app.use(express.text());

// ══════════════════════════════════════════════════════════════
//  EMOJI & FORMAT
// ══════════════════════════════════════════════════════════════

const EMOJI = {
    SNR_TOUCH_Support:    '🟦',
    SNR_TOUCH_Resistance: '🟥',
    SBR_FORMED:           '🟧',
    RBS_FORMED:           '🟩',
    SBR_MITIGATED:        '❌🟧',
    RBS_MITIGATED:        '❌🟩',
};

function formatAlert(data) {
    const emoji = EMOJI[`${data.type}_${data.zone || ''}`] || EMOJI[data.type] || '📊';
    const time  = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    let title = '';
    let body  = '';

    switch (data.type) {
        case 'SNR_TOUCH':
            title = `${emoji} SNR ${data.zone} Touched!`;
            body  = [
                `<b>Symbol:</b> ${data.symbol}`,
                `<b>Timeframe:</b> ${data.tf}`,
                `<b>Harga:</b> ${data.price}`,
                `<b>Level:</b> ${data.level}`,
                `<b>Zone:</b> ${data.zone_top} — ${data.zone_bot}`,
                ``,
                `💡 <i>Harga menyentuh area ${data.zone}. Cari konfirmasi entry!</i>`
            ].join('\n');
            break;

        case 'SBR_FORMED':
            title = `${emoji} SBR Terbentuk!`;
            body  = [
                `<b>Symbol:</b> ${data.symbol}`,
                `<b>Timeframe:</b> ${data.tf}`,
                `<b>Harga:</b> ${data.price}`,
                `<b>Zone:</b> ${data.zone_top} — ${data.zone_bot}`,
                ``,
                `⚠️ <i>Support BREAK → jadi Resistance. Waspadai rejection di zona ini!</i>`
            ].join('\n');
            break;

        case 'RBS_FORMED':
            title = `${emoji} RBS Terbentuk!`;
            body  = [
                `<b>Symbol:</b> ${data.symbol}`,
                `<b>Timeframe:</b> ${data.tf}`,
                `<b>Harga:</b> ${data.price}`,
                `<b>Zone:</b> ${data.zone_top} — ${data.zone_bot}`,
                ``,
                `✅ <i>Resistance BREAK → jadi Support. Cari peluang BUY di retest!</i>`
            ].join('\n');
            break;

        case 'SBR_MITIGATED':
            title = `${emoji} SBR Termitigasi`;
            body  = [
                `<b>Symbol:</b> ${data.symbol}`,
                `<b>Timeframe:</b> ${data.tf}`,
                `<b>Harga:</b> ${data.price}`,
                ``,
                `<i>Zona SBR sudah ditembus kembali. Level tidak valid lagi.</i>`
            ].join('\n');
            break;

        case 'RBS_MITIGATED':
            title = `${emoji} RBS Termitigasi`;
            body  = [
                `<b>Symbol:</b> ${data.symbol}`,
                `<b>Timeframe:</b> ${data.tf}`,
                `<b>Harga:</b> ${data.price}`,
                ``,
                `<i>Zona RBS sudah ditembus kembali. Level tidak valid lagi.</i>`
            ].join('\n');
            break;

        default:
            title = `📊 Trading Alert`;
            body  = `<pre>${JSON.stringify(data, null, 2)}</pre>`;
    }

    return `<b>${title}</b>\n${'─'.repeat(24)}\n${body}\n\n🕐 ${time} WIB`;
}

// ══════════════════════════════════════════════════════════════
//  SEND TO TELEGRAM
// ══════════════════════════════════════════════════════════════

function sendTelegram(text) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            chat_id:    CHAT_ID,
            text:       text,
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });

        const options = {
            hostname: 'api.telegram.org',
            path:     `/bot${BOT_TOKEN}/sendMessage`,
            method:   'POST',
            headers: {
                'Content-Type':   'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                const result = JSON.parse(data);
                if (result.ok) {
                    console.log('✅ Telegram sent');
                    resolve(result);
                } else {
                    console.error('❌ Telegram error:', result.description);
                    reject(new Error(result.description));
                }
            });
        });

        req.on('error', (err) => {
            console.error('❌ Request error:', err.message);
            reject(err);
        });

        req.write(payload);
        req.end();
    });
}

// ══════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'TV-Telegram Webhook', uptime: process.uptime() });
});

// ── Main webhook endpoint ──
app.post('/webhook', async (req, res) => {
    try {
        let data = req.body;

        // TradingView bisa kirim sebagai text atau JSON
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch {
                // Jika bukan JSON, kirim sebagai pesan biasa
                await sendTelegram(`📊 <b>TradingView Alert</b>\n\n${data}`);
                return res.json({ ok: true });
            }
        }

        console.log('📨 Received:', JSON.stringify(data));

        const message = formatAlert(data);
        await sendTelegram(message);

        res.json({ ok: true, message: 'Alert sent to Telegram' });

    } catch (err) {
        console.error('❌ Error:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ══════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║  🚀 TV-Telegram Webhook Server                  ║
║  Port: ${PORT}                                      ║
║  Endpoint: POST /webhook                        ║
║  Bot: XAUUSD Alert (H4 + D1)                    ║
╚══════════════════════════════════════════════════╝
    `);

    if (BOT_TOKEN === 'ISI_BOT_TOKEN_KAMU') {
        console.log('⚠️  Set BOT_TOKEN & CHAT_ID di environment variable!');
    } else {
        // Auto-start alert bot
        try {
            require('./bot.js');
            console.log('🤖 XAUUSD Alert Bot started!');
        } catch (err) {
            console.log('ℹ️  Bot not loaded:', err.message);
        }
    }
});
