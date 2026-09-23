#!/usr/bin/env node
/*
 * send-invite.js — envia o e-mail de convite "usuário pioneiro" do fari
 * para uma lista em CSV, via API da Resend (https://resend.com).
 *
 * Zero dependências. Requer Node 18+ (fetch global).
 *
 * Uso:
 *   node scripts/send-invite.js                 # dry-run (simula, não envia)
 *   node scripts/send-invite.js --send          # envia de verdade
 *   node scripts/send-invite.js --send --limit=5
 *
 * Env:
 *   RESEND_API_KEY   obrigatório para --send
 *   FROM_EMAIL       default contact@medrixai.com
 *   FROM_NAME        default "fari"
 *   SITE_URL         default http://127.0.0.1:61880 (URL pública do site)
 *   DAILY_CAP        default 100 (limite do plano gratuito da Resend)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const INVITES = path.join(DATA, 'invites.csv');
const SUPPRESSED = path.join(DATA, 'suppressed.csv');
const LOG = path.join(DATA, 'invite-log.json');
const HTML_TPL = path.join(__dirname, 'invite-email.html');
const TXT_TPL = path.join(__dirname, 'invite-email.txt');

const args = new Set(process.argv.slice(2));
const doSend = args.has('--send');
const limitArg = (process.argv.find(a => a.startsWith('--limit=')) || '').split('=');
const limit = limitArg[1] ? parseInt(limitArg[1], 10) : 0;

const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'contact@medrixai.com';
const FROM_NAME = process.env.FROM_NAME || 'fari';
const SITE_URL = (process.env.SITE_URL || 'http://127.0.0.1:61880').replace(/\/$/, '');
const DAILY_CAP = parseInt(process.env.DAILY_CAP || '100', 10);
const EMAIL_RE = /^\S+@\S+\.\S+$/;

function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [email, ...rest] = l.split(',').map(s => s.trim());
      return { email: (email || '').toLowerCase(), name: (rest[0] || '').trim() };
    });
}

function loadSuppressed() {
  return new Set(readCsv(SUPPRESSED).map(r => r.email));
}

function render(tpl, { name, siteUrl }) {
  return tpl
    .replace(/\{\{NAME\}\}/g, name ? ` ${name}` : '')
    .replace(/\{\{SITE_URL\}\}/g, siteUrl);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendOne(recipient, html, text) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json',
      'List-Unsubscribe': '<mailto:contact@medrixai.com?subject=Cancelar%20inscri%C3%A7%C3%A3o>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to: [recipient.email],
      subject: 'Você é dos primeiros. Bem-vindo ao fari 🇧🇷',
      html,
      text
    })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body?.message || JSON.stringify(body)}`);
  return body.id;
}

(async () => {
  if (doSend && !RESEND_KEY) {
    console.error('✖ --send exige RESEND_API_KEY. Crie a chave em https://resend.com e exporte: export RESEND_API_KEY=re_xxx');
    process.exit(1);
  }

  const rows = readCsv(INVITES);
  if (!rows.length) {
    console.error(`✖ Nenhum destinatário em ${INVITES}.\n  Exporte sua planilha para data/invites.csv (colunas: email,name). Veja data/invites.csv.example.`);
    process.exit(1);
  }

  const suppressed = loadSuppressed();
  const valid = rows.filter(r => EMAIL_RE.test(r.email) && !suppressed.has(r.email));
  const skipped = rows.length - valid.length;
  const capped = (limit ? valid.slice(0, limit) : valid.slice(0, DAILY_CAP));
  const remaining = valid.length - capped.length;

  console.log(`Destinatários: ${rows.length} | válidos: ${valid.length} | pulados(inválidos/suprimidos): ${skipped} | a enviar: ${capped.length}${limit ? ` (limit ${limit})` : ''}${remaining ? ` | +${remaining} num próximo lote` : ''}${doSend ? ' [SEND]' : ' [DRY-RUN]'}`);

  const htmlTpl = fs.readFileSync(HTML_TPL, 'utf8');
  const txtTpl = fs.readFileSync(TXT_TPL, 'utf8');
  const log = { startedAt: new Date().toISOString(), mode: doSend ? 'send' : 'dry-run', sent: [], failed: [] };
  let sent = 0;

  for (const r of capped) {
    const html = render(htmlTpl, { name: r.name, siteUrl: SITE_URL });
    const text = render(txtTpl, { name: r.name, siteUrl: SITE_URL });
    try {
      if (doSend) {
        const id = await sendOne(r, html, text);
        log.sent.push({ email: r.email, id });
        sent++;
        console.log(`  ✓ ${r.email} — id ${id}`);
        await sleep(300);
      } else {
        log.sent.push({ email: r.email, id: 'dry-run' });
        console.log(`  · ${r.email} (simulado)`);
      }
    } catch (e) {
      log.failed.push({ email: r.email, error: e.message });
      console.error(`  ✖ ${r.email} — ${e.message}`);
    }
  }

  log.endedAt = new Date().toISOString();
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
  console.log(`\nConcluído. enviados: ${sent} | falhas: ${log.failed.length} | log: ${LOG}`);
  if (!doSend) console.log('Para enviar de verdade: node scripts/send-invite.js --send');
  if (remaining) console.log(`Restam ${remaining} para o próximo lote (reenvie amanhã, ou suba o plano da Resend).`);
})();
