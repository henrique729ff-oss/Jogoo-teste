'use strict';
// Servidor do Gladiadores: login (nome + senha), busca de jogador por ID, convite x1.
// Roda no Render (ou em qualquer lugar com Node 18+). Também entrega o jogo (index.html).
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'accounts.json');
const HTML = path.join(__dirname, 'index.html');
const HTMLGZ = path.join(__dirname, 'index.html.gz');   // versão compactada (cabe no limite de 25MB do GitHub)
const MAX_ACC = 900;                 // IDs de 3 números (100 a 999)
const INVITE_MS = 40000;
const NAME_RE = /^[\p{L}\p{N} ._-]{3,12}$/u;

// ---------- contas (arquivo JSON) ----------
// ATENÇÃO: no Render grátis o disco é apagado quando o servidor reinicia.
// Para as contas não sumirem, aponte DATA_FILE para um disco permanente ou troque por um banco.
let acc = {};
try { acc = JSON.parse(fs.readFileSync(DATA, 'utf8')) || {}; } catch (e) { acc = {}; }
let saveT = 0;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { fs.writeFileSync(DATA + '.tmp', JSON.stringify(acc)); fs.renameSync(DATA + '.tmp', DATA); }
    catch (e) { console.error('Não consegui salvar as contas:', e.message); }
  }, 400);
}
const cleanName = s => String(s == null ? '' : s).replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 12);
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function checkPw(a, pw) {
  const x = Buffer.from(hashPw(pw, a.s), 'hex'), y = Buffer.from(a.h, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function newId() {
  const used = new Set(Object.values(acc).map(a => a.id));
  let id; do { id = String(100 + Math.floor(Math.random() * 900)); } while (used.has(id));
  return id;
}
const findById = id => Object.values(acc).find(a => a.id === id);

// ---------- site (entrega o jogo) ----------
let gz = null;
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  try {
    if (!gz) gz = fs.existsSync(HTMLGZ) ? fs.readFileSync(HTMLGZ) : zlib.gzipSync(fs.readFileSync(HTML));
    const ok = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
    if (ok) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); res.end(gz); }
    else { res.writeHead(200, h); res.end(zlib.gunzipSync(gz)); }
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor do Gladiadores no ar. (Coloque o jogo como index.html ao lado do server.js para ele abrir aqui.)');
  }
});

// ---------- jogadores online ----------
const wss = new WebSocketServer({ server, maxPayload: 4096 });
const online = new Map();   // id -> cliente
const pending = new Map();  // idDoQueConvidou -> { to, ts }
const fresh = p => p && Date.now() - p.ts < INVITE_MS;
const send = (c, o) => { try { if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(o)); } catch (e) { } };
const pendingIn = id => { for (const [, p] of pending) if (p.to === id && fresh(p)) return true; return false; };

// fila do START: quem aperta START espera aqui até outro jogador apertar também
const queue = [];
const unq = c => { const i = queue.indexOf(c); if (i >= 0) queue.splice(i, 1); };
function begin(a, b) {   // a = slot 0 (spawn 1), b = slot 1 (spawn 2)
  unq(a); unq(b); a.opp = b.id; b.opp = a.id;
  for (const [from, p] of [...pending]) if (from === a.id || from === b.id || p.to === a.id || p.to === b.id) pending.delete(from);
  send(a, { t: 'match', id: b.id, name: b.name, slot: 0 });
  send(b, { t: 'match', id: a.id, name: a.name, slot: 1 });
}

function endMatch(c) {
  if (!c.opp) return;
  const o = online.get(c.opp); c.opp = null;
  if (o && o.opp === c.id) { o.opp = null; send(o, { t: 'oppLeft', id: c.id }); }
}
function drop(c) {
  if (!c.id) return;
  if (online.get(c.id) === c) online.delete(c.id);
  unq(c);
  pending.delete(c.id);
  for (const [from, p] of [...pending]) {
    if (p.to === c.id) { pending.delete(from); send(online.get(from), { t: 'inviteResult', id: c.id, r: 'offline' }); }
  }
  endMatch(c);
}

function handle(c, m) {
  if (m.t === 'ping') return send(c, { t: 'pong' });

  if (m.t === 'auth') {
    if (c.id) return;
    const name = cleanName(m.name), pass = String(m.pass == null ? '' : m.pass);
    if (!NAME_RE.test(name) || pass.length < 4 || pass.length > 32) return send(c, { t: 'auth', ok: false, err: 'Nome ou senha inválidos.' });
    const key = name.toLowerCase();
    let a = acc[key], created = false;
    if (a) {
      if (!checkPw(a, pass)) {
        send(c, { t: 'auth', ok: false, err: 'Senha errada. Tente de novo.' });
        if (++c.fails >= 8) c.ws.close();
        return;
      }
    } else {
      if (Object.keys(acc).length >= MAX_ACC) return send(c, { t: 'auth', ok: false, err: 'O servidor está cheio.' });
      const s = crypto.randomBytes(16).toString('hex');
      a = acc[key] = { n: name, id: newId(), s, h: hashPw(pass, s) };
      created = true; save();
    }
    const old = online.get(a.id);
    if (old && old !== c) { send(old, { t: 'kick' }); drop(old); try { old.ws.close(); } catch (e) { } }
    c.id = a.id; c.name = a.n; online.set(c.id, c);
    return send(c, { t: 'auth', ok: true, id: a.id, name: a.n, created });
  }

  if (!c.id) return;

  if (m.t === 'lookup') {
    const id = String(m.id || '');
    const a = /^\d{3}$/.test(id) ? findById(id) : null;
    return send(c, a ? { t: 'lookup', id, ok: true, name: a.n } : { t: 'lookup', id, ok: false });
  }

  if (m.t === 'invite') {
    const id = String(m.id || ''), to = online.get(id);
    if (!to || to === c) return send(c, { t: 'inviteResult', id, r: 'offline' });
    if (c.opp || to.opp || pendingIn(to.id)) return send(c, { t: 'inviteResult', id, r: 'busy' });
    pending.set(c.id, { to: to.id, ts: Date.now() });
    return send(to, { t: 'invite', id: c.id, name: c.name });
  }

  if (m.t === 'inviteCancel') {
    const p = pending.get(c.id);
    if (p && p.to === String(m.id)) { pending.delete(c.id); send(online.get(p.to), { t: 'inviteCancel', id: c.id }); }
    return;
  }

  if (m.t === 'inviteReply') {
    const id = String(m.id || ''), inv = online.get(id), p = pending.get(id);
    if (!inv || !fresh(p) || p.to !== c.id) return send(c, { t: 'oppLeft', id });   // convite não existe mais
    pending.delete(id);
    const r = m.r === 'accepted' || m.r === 'busy' ? m.r : 'declined';
    if (r === 'accepted') {
      if (c.opp || inv.opp) { send(inv, { t: 'inviteResult', id: c.id, r: 'busy' }); return send(c, { t: 'oppLeft', id }); }
      unq(c); unq(inv);
    }
    send(inv, { t: 'inviteResult', id: c.id, r });
    if (r === 'accepted') begin(inv, c);
    return;
  }

  if (m.t === 'queue') {
    endMatch(c); unq(c);
    const w = queue.find(q => q !== c && q.id && q.id !== c.id && !q.opp && q.ws.readyState === 1);
    if (w) begin(w, c); else queue.push(c);
    return;
  }
  if (m.t === 'queueCancel') return unq(c);

  // durante a partida o servidor só repassa as mensagens para o oponente
  if (m.t === 'st' || m.t === 'dmg' || m.t === 'died' || m.t === 'shot' || m.t === 'rematch') {
    const o = c.opp && online.get(c.opp);
    if (!o || o.opp !== c.id) return;
    const n = x => (typeof x === 'number' && isFinite(x)) ? x : 0, v3 = a => Array.isArray(a) ? [n(a[0]), n(a[1]), n(a[2])] : [0, 0, 0];
    if (m.t === 'st') return send(o, { t: 'st', x: n(m.x), y: n(m.y), z: n(m.z), ry: n(m.ry), hp: Math.max(0, Math.min(200, n(m.hp))) });
    if (m.t === 'dmg') return send(o, { t: 'dmg', d: Math.max(0, Math.min(300, n(m.d))) });
    if (m.t === 'shot') return send(o, { t: 'shot', a: v3(m.a), b: v3(m.b) });
    return send(o, { t: m.t });
  }

  if (m.t === 'leave' || m.t === 'lobby') { unq(c); return endMatch(c); }
}

wss.on('connection', ws => {
  const c = { ws, id: null, name: null, opp: null, fails: 0, alive: true };
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(c, m); } catch (e) { console.error('erro:', e.message); }
  });
  ws.on('close', () => drop(c));
  ws.on('error', () => { });
});

// derruba conexões mortas (celular que perdeu o sinal)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch (e) { }
  }
}, 30000);
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; }); });

server.listen(PORT, () => console.log('Gladiadores no ar na porta ' + PORT));
