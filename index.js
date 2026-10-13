import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import mammoth from 'mammoth';
import XLSX from 'xlsx';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';

// ---------- Config ----------
const GEMINI_KEY = process.env.GOOGLE_API_KEY_AGENT;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;

// The WhatsApp login (auth_info) and knowledge base live here.
// Keeping them on disk means nodemon restarts do NOT require a new QR scan.
const DATA_DIR = process.env.DATA_DIR || '.';
const KB_FILE = path.join(DATA_DIR, 'knowledge_base.txt');
const AUTH_DIR = path.join(DATA_DIR, 'auth_info');
fs.mkdirSync(DATA_DIR, { recursive: true });

const MAX_KB_CHARS = 150000;

const SYSTEM_PROMPT = `You are the customer assistant for our business. You reply to customers on WhatsApp.

Rules:
- Answer ONLY using the knowledge base below.
- If the answer is not in the knowledge base, say you don't have that information yet and that a team member will follow up. Do not invent prices, products or policies.
- Reply in the same language the customer writes in (French or English).
- Keep answers short and friendly, suitable for a WhatsApp chat.

KNOWLEDGE BASE:
{kb}`;

let waStatus = 'Starting...';

// ---------- Knowledge base ----------
function readKb() {
  return fs.existsSync(KB_FILE) ? fs.readFileSync(KB_FILE, 'utf8') : '';
}

function writeKb(text) {
  fs.writeFileSync(KB_FILE, text, 'utf8');
}

// Converts an uploaded file to plain text. Returns null for unsupported types.
async function extractText(file) {
  const name = file.originalname.toLowerCase();
  if (name.endsWith('.pdf')) {
    const data = await pdfParse(file.buffer);
    return data.text;
  }
  if (name.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value;
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    return wb.SheetNames
      .map((sheet) => `## Sheet: ${sheet}\n${XLSX.utils.sheet_to_csv(wb.Sheets[sheet])}`)
      .join('\n\n');
  }
  if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv')) {
    return file.buffer.toString('utf8');
  }
  return null;
}

// ---------- Google Gemini ----------
async function askGemini(question) {
  const kb = readKb().slice(0, MAX_KB_CHARS);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const prompt = SYSTEM_PROMPT.replace('{kb}', () => kb || '(empty)');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: prompt }] },
      contents: [{ role: 'user', parts: [{ text: question }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
    }),
  });

  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text?.trim() || "Désolé, je ne peux pas répondre pour le moment. Un membre de l'équipe vous recontactera.";
}

// ---------- WhatsApp (Baileys) ----------
async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      waStatus = 'Waiting for QR scan (see the server logs)';
      console.log('Scan this QR code: WhatsApp > Settings > Linked devices > Link a device');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      waStatus = 'Connected';
      console.log('WhatsApp connected.');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        waStatus = 'Logged out. Delete the auth_info folder and restart to link again.';
        console.log(waStatus);
      } else {
        waStatus = 'Reconnecting...';
        console.log('Connection closed (code', code, '), reconnecting...');
        setTimeout(() => startWhatsApp(), 5000);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const jid = msg.key.remoteJid;
      if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      try {
        if (!text) {
          await sock.sendMessage(jid, { text: 'Désolé, je ne peux lire que les messages texte pour le moment.' });
          continue;
        }
        await sock.sendPresenceUpdate('composing', jid);
        const answer = await askGemini(text);
        await sock.sendMessage(jid, { text: answer });
      } catch (err) {
        console.error('Failed to handle message from', jid, err.message);
      }
    }
  });
}

// ---------- Admin page ----------
const app = express();
app.use(express.urlencoded({ extended: true }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function requireAdmin(req, res, next) {
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && b64) {
    const [user, ...rest] = Buffer.from(b64, 'base64').toString().split(':');
    if (user === ADMIN_USER && rest.join(':') === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Admin"').status(401).send('Login required');
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderPage({ msg = '', answer = '' } = {}) {
  const content = readKb();
  const connected = waStatus === 'Connected';
  const statusFr = (s) => {
    if (s.startsWith('Logged out')) return 'Déconnecté. Supprimez auth_info et redémarrez.';
    return ({
      'Starting...': 'Démarrage...',
      'Waiting for QR scan (see the server logs)': 'Scan du QR code requis (voir les logs)',
      'Connected': 'Connecté',
      'Reconnecting...': 'Reconnexion...',
    })[s] || s;
  };
  const fmt = (n) => n.toLocaleString('fr-FR');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Base de connaissances</title>
<style>
:root{--bg:#f4f6fb;--text:#1f2937;--muted:#6b7280;--border:#e5e7eb;--accent:#4f46e5;--accent-hover:#4338ca;--ok:#15803d;--ok-bg:#dcfce7;--warn:#b45309;--warn-bg:#fef3c7}
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text);font-size:14px;display:flex;flex-direction:column;height:100vh;overflow:hidden}
header{display:flex;align-items:center;justify-content:space-between;gap:12px;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:10px 18px;flex-shrink:0}
header h1{margin:0;font-size:1rem;font-weight:700}
.pill{background:#fff;padding:4px 12px;border-radius:999px;font-size:.78rem;font-weight:600;color:var(--warn);white-space:nowrap}
.pill.ok{color:var(--ok)}
main{flex:1;min-height:0;display:grid;grid-template-columns:290px 1fr;gap:12px;padding:12px 18px 14px}
.side{display:flex;flex-direction:column;gap:12px;min-height:0}
.card{background:#fff;border-radius:12px;padding:14px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card h2{font-size:.9rem;margin:0 0 2px}
.hint{color:var(--muted);font-size:.78rem;margin:0 0 10px;line-height:1.4}
.flash{background:var(--ok-bg);color:#14532d;padding:8px 12px;border-radius:8px;font-size:.82rem}
input[type=file]{font-size:.78rem;width:100%}
input[type=text]{flex:1;min-width:0;padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:.85rem;font-family:inherit}
input:focus,textarea:focus{outline:2px solid #c7d2fe;border-color:var(--accent)}
button{background:var(--accent);color:#fff;border:0;padding:7px 14px;border-radius:8px;font-weight:600;font-size:.84rem;cursor:pointer;white-space:nowrap}
button:hover{background:var(--accent-hover)}
.mt{margin-top:8px}
.row{display:flex;gap:6px}
.answer{background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:10px;white-space:pre-wrap;line-height:1.45;font-size:.8rem;max-height:200px;overflow:auto}
.kb{display:flex;flex-direction:column;min-height:0}
.kb form{flex:1;display:flex;flex-direction:column;min-height:0}
textarea{flex:1;min-height:0;width:100%;padding:12px;border:1px solid var(--border);border-radius:8px;font-family:ui-monospace,Consolas,monospace;font-size:.82rem;line-height:1.5;resize:none}
.foot{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
.counter{color:var(--muted);font-size:.76rem}
.counter.over{color:var(--warn);font-weight:600}
@media (max-width:760px){body{height:auto;overflow:auto}main{grid-template-columns:1fr}textarea{min-height:300px;flex:none}}
</style></head><body>
<header>
  <h1>Assistant WhatsApp</h1>
  <span class="pill ${connected ? 'ok' : ''}">${esc(statusFr(waStatus))}</span>
</header>
<main>
  <div class="side">
    ${msg ? `<div class="flash">${esc(msg)}</div>` : ''}
    <div class="card">
      <h2>Ajouter des documents</h2>
      <p class="hint">PDF, Word (.docx), Excel, CSV, TXT, Markdown. Les .doc doivent être en .docx.</p>
      <form method="post" action="/upload" enctype="multipart/form-data">
        <input type="file" name="files" accept=".pdf,.docx,.xlsx,.xls,.csv,.txt,.md" multiple>
        <button class="mt">Importer</button>
      </form>
    </div>
    <div class="card">
      <h2>Tester le bot</h2>
      <p class="hint">Posez une question comme le ferait un client.</p>
      <form method="post" action="/test">
        <div class="row">
          <input type="text" name="question" placeholder="ex. Quels sont vos horaires ?">
          <button>Demander</button>
        </div>
      </form>
      ${answer ? `<div class="answer">${esc(answer)}</div>` : ''}
    </div>
  </div>
  <div class="card kb">
    <h2>Base de connaissances</h2>
    <p class="hint">Tout ce que le bot sait sur votre entreprise. Modifiez le texte, puis enregistrez.</p>
    <form method="post" action="/save">
      <textarea name="content">${esc(content)}</textarea>
      <div class="foot">
        <span class="counter ${content.length > MAX_KB_CHARS ? 'over' : ''}">${fmt(content.length)} / ${fmt(MAX_KB_CHARS)} caractères${content.length > MAX_KB_CHARS ? ' (limite dépassée : le texte en trop est ignoré)' : ''}</span>
        <button>Enregistrer</button>
      </div>
    </form>
  </div>
</main>
</body></html>`;
}

app.get('/health', (req, res) => res.send('ok'));
app.get('/', requireAdmin, (req, res) => res.send(renderPage()));

app.post('/upload', requireAdmin, upload.array('files'), async (req, res) => {
  let added = 0;
  const skipped = [];
  for (const f of req.files || []) {
    try {
      const text = (await extractText(f))?.trim();
      if (!text) {
        skipped.push(f.originalname);
        continue;
      }
      writeKb(readKb() + `\n\n--- Source: ${f.originalname} ---\n${text}\n`);
      added++;
    } catch (err) {
      console.error('Could not read', f.originalname, err.message);
      skipped.push(f.originalname);
    }
  }
  let msg = `${added} fichier(s) ajouté(s).`;
  if (skipped.length) msg += ` Lecture impossible : ${skipped.join(', ')}`;
  res.send(renderPage({ msg }));
});

app.post('/save', requireAdmin, (req, res) => {
  writeKb(req.body.content || '');
  res.send(renderPage({ msg: 'Base de connaissances enregistrée.' }));
});

app.post('/test', requireAdmin, async (req, res) => {
  const q = (req.body.question || '').trim();
  let answer = "Écrivez d'abord une question.";
  if (q) {
    try {
      answer = await askGemini(q);
    } catch (err) {
      answer = 'Erreur : ' + err.message;
    }
  }
  res.send(renderPage({ answer }));
});

// ---------- Start ----------
if (!GEMINI_KEY) console.warn('WARNING: GOOGLE_API_KEY_AGENT is missing');
if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is missing');

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
startWhatsApp().catch((err) => console.error('WhatsApp start failed:', err));
