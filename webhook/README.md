# TV-Telegram Webhook Server

Webhook relay server: TradingView Alert → Telegram Bot

## Deploy ke Railway (Gratis)

### Step 1: Buat akun Railway
1. Buka https://railway.app
2. Sign up pakai GitHub

### Step 2: Deploy
1. Klik **"New Project"** → **"Deploy from GitHub repo"**
2. Connect repository ini
3. Railway otomatis detect Node.js

### Step 3: Set Environment Variables
Di Railway dashboard → **Variables** tab, tambahkan:
```
BOT_TOKEN = token_dari_botfather
CHAT_ID   = chat_id_kamu
```

### Step 4: Dapatkan URL
Klik **Settings** → **Networking** → **Generate Domain**
URL kamu: `https://xxx.up.railway.app`

### Step 5: Setup TradingView
1. Buka TradingView → buat Alert
2. Centang **Webhook URL**
3. Isi: `https://xxx.up.railway.app/webhook`
4. Done! ✅

---

## Cara Dapat BOT_TOKEN & CHAT_ID

### BOT_TOKEN:
1. Buka Telegram → cari **@BotFather**
2. Ketik `/newbot`
3. Beri nama bot → dapat token seperti: `7123456789:AAH...`

### CHAT_ID:
1. Kirim pesan apa saja ke bot kamu
2. Buka browser: `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Cari `"chat":{"id": 123456789}` → itu CHAT_ID kamu

---

## Test Manual
```bash
curl -X POST https://xxx.up.railway.app/webhook \
  -H "Content-Type: application/json" \
  -d '{"type":"SNR_TOUCH","zone":"Support","price":2650.50,"level":2645.00,"symbol":"XAUUSD","tf":"240"}'
```
