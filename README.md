# WhatsApp Knowledge-Base Bot

Reads .pdf, .docx, .xlsx, .xls, .csv, .txt and .md files and answers WhatsApp messages with Google Gemini.
WhatsApp connection uses the free Baileys library (WhatsApp Web protocol).

## Setup (Windows, VS Code)
1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env` and fill in your values.
3. In the terminal: `npm install`

## Daily use
- `npm run dev`: starts the bot with nodemon. The bot restarts automatically when you save `index.js`,
  `package.json` or `.env`. Changes to the knowledge base do NOT restart it.
- `npm start`: starts the bot without auto-restart.
- Admin page: http://localhost:3000 (login with ADMIN_USER / ADMIN_PASSWORD).

## Staying linked (no QR rescan)
The WhatsApp login is saved in the `auth_info` folder. Nodemon restarts do not delete it, so you only
scan the QR code once. Do not delete `auth_info` unless you want to unlink the bot.

To scan: WhatsApp > Settings > Linked devices > Link a device.

## Deploy on Render (free)
1. Push the folder to GitHub (`.env` is excluded by `.gitignore`).
2. Render: New > Blueprint, select the repository.
3. Enter `GOOGLE_API_KEY_AGENT` and `ADMIN_PASSWORD`.
4. Scan the QR code shown in the Render logs.
5. Keep it awake with a free cron-job.org job that opens `https://YOUR-SERVICE.onrender.com/health` every 14 minutes.
Note: the free plan has no persistent disk, so a restart or redeploy erases the login and knowledge base.

## Better always-on hosting
A VPS keeps its disk and needs no pings. Use `whatsapp-bot.service` (systemd) and `Caddyfile` (HTTPS).
Set `DATA_DIR=/opt/whatsapp-bot/data` so the login survives reboots.
