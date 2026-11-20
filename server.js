// GiftsUP «Ракетка»: общий раунд для всех игроков.
// Запуск: npm i && PORT=8080 BOT_TOKEN=123:abc node server.js   (за nginx/Caddy с TLS → wss://)
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SPEED = 0.17;                 // тот же CR_SPEED, что в index.html
const WAIT_MS = +process.env.WAIT_MS || 6000, PAUSE_MS = 3500;
const MIN_BET = 1, MAX_BET = 100000;

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Точка вылета выводится из seed; клиенту заранее отдаётся только sha256(seed).
function crashFrom(seed) {
  const r = parseInt(sha(seed + ':crash').slice(0, 13), 16) / 2 ** 52;
  return Math.min(500, Math.max(1.01, Math.floor(.99 / (1 - r) * 100) / 100));
}
function verifyInit(initData) {       // проверка подписи Telegram initData
  try {
    if (!BOT_TOKEN || !initData) return null;
    const p = new URLSearchParams(initData), hash = p.get('hash'); p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (crypto.createHmac('sha256', key).update(str).digest('hex') !== hash) return null;
    const u = JSON.parse(p.get('user')); return { id: 'tg' + u.id, nm: u.username || u.first_name || 'user' };
  } catch { return null; }
}

const http = require('http');
// HTTP-эндпоинт для проверки живости (Render/UptimeRobot) + WebSocket на том же порту
const httpServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, '0.0.0.0');
let round = null, hist = [];
const clients = new Set();
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const all = o => clients.forEach(c => send(c, o));
const list = () => round ? [...round.bets.values()].map(b => ({ id: b.id, nm: b.nm, bet: b.amount, gb: b.gb, m: b.m })) : [];
let pt = null; const pushPlayers = () => { if (!pt) pt = setTimeout(() => { pt = null; all({ t: 'players', list: list() }); }, 250); };

function startRound() {
  const seed = crypto.randomBytes(16).toString('hex');
  round = { seed, hash: sha(seed), point: crashFrom(seed), phase: 'wait', bets: new Map(), startAt: Date.now() + WAIT_MS };
  all({ t: 'wait', hash: round.hash, startAt: round.startAt });
  setTimeout(fly, WAIT_MS);
}
function fly() {
  round.phase = 'fly'; round.flyAt = Date.now();
  all({ t: 'fly', startAt: round.flyAt });
  setTimeout(crash, Math.log(round.point) / SPEED * 1000);
}
function crash() {
  round.phase = 'crash';
  hist = [round.point, ...hist].slice(0, 14);
  all({ t: 'crash', point: round.point, seed: round.seed, hist });
  setTimeout(startRound, PAUSE_MS);
}

// ===== АРЕНА: только реальные игроки, победитель выбирается по хешу =====
const AR_BET = +process.env.AR_BET_MS || 10000, AR_SPIN = +process.env.AR_SPIN_MS || 6500, AR_RES = +process.env.AR_RES_MS || 5500;
const AR_PRIZE = .85, AR_JP = .10, AR_MIN = 1, AR_MAX = 100000, AR_PLAYERS = 40; // 5% комиссия + 10% в джекпот
const A = { n: 0, jp: 0, phase: 'bet', bets: new Map(), seed: '', hash: '', end: 0, off: 0, winner: null };
const arList = () => [...A.bets.values()].map(b => ({ id: b.id, nm: b.nm, bet: b.bet, c: b.c }));
const arState = () => ({ t: 'ar_state', phase: A.phase, n: A.n, off: A.off, end: A.end, hash: A.hash, jp: A.jp, list: arList(), winner: A.winner });
let apt = null; const arPush = () => { if (!apt) apt = setTimeout(() => { apt = null; all({ t: 'ar_players', jp: A.jp, list: arList() }); }, 250); };
function arStart() {
  A.n++; A.seed = crypto.randomBytes(16).toString('hex'); A.hash = sha(A.seed);
  A.phase = 'bet'; A.bets = new Map(); A.winner = null; A.off = Math.random() * 4; A.end = Date.now() + AR_BET;
  all(arState()); setTimeout(arClose, AR_BET);
}
function arClose() {
  if (A.bets.size < 2) {                       // одному играть не с кем: возврат ставки
    for (const b of A.bets.values()) clients.forEach(c => { if (c.user.id === b.id) send(c, { t: 'ar_refund', amount: b.bet }); });
    return arStart();
  }
  const list = arList(), pot = list.reduce((a, p) => a + p.bet, 0);
  const r = parseInt(sha(A.seed + ':arena').slice(0, 13), 16) / 2 ** 52 * pot;
  let acc = 0, w = list[list.length - 1];
  for (const p of list) { acc += p.bet; if (r < acc) { w = p; break; } }
  A.winner = w.id; A.phase = 'spin'; A.jp += pot * AR_JP;
  all({ t: 'ar_spin', n: A.n, list, winner: w.id, jp: A.jp, seed: A.seed });
  if (A.n % 100 === 0) A.jp = 0;               // джекпот уходит победителю раунда №100, 200, …
  setTimeout(arStart, AR_SPIN + AR_RES);
}
function arBet(ws, m) {
  const a = Math.round(+m.amount * 100) / 100, id = ws.user.id;
  const err = msg => { send(ws, { t: 'ar_err', refund: a > 0 ? a : 0, msg }); send(ws, { t: 'ar_players', jp: A.jp, list: arList() }); };
  if (!(a >= AR_MIN && a <= AR_MAX)) return err('Ставка отклонена');
  if (A.phase !== 'bet' || Date.now() >= A.end) return err('Ставки закрыты');
  let b = A.bets.get(id);
  if (!b) {
    if (A.bets.size >= AR_PLAYERS) return err('В раунде максимум ' + AR_PLAYERS + ' игроков');
    const used = new Set([...A.bets.values()].map(x => x.c)); let c = 0; while (used.has(c)) c++;
    b = { id, nm: ws.user.nm, bet: 0, c }; A.bets.set(id, b);
  }
  b.bet = Math.round((b.bet + a) * 100) / 100; arPush();
}

wss.on('connection', ws => {
  ws.user = { id: 'g' + crypto.randomBytes(4).toString('hex') }; ws.user.nm = 'Guest_' + ws.user.id.slice(1, 5);
  ws.msgs = 0; const rl = setInterval(() => ws.msgs = 0, 1000);
  clients.add(ws);
  send(ws, { t: 'hi', id: ws.user.id, now: Date.now(), hist });
  if (round) {
    send(ws, { t: 'wait', hash: round.hash, startAt: round.startAt });
    if (round.phase === 'fly') send(ws, { t: 'fly', startAt: round.flyAt });
    send(ws, { t: 'players', list: list() });
  }
  send(ws, arState());
  ws.on('message', raw => {
    if (++ws.msgs > 20) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    const id = ws.user.id;
    if (m.t === 'ar_bet') return arBet(ws, m);
    if (m.t === 'ar_sync') return send(ws, arState());
    if (m.t === 'hello') {
      const u = verifyInit(m.initData); if (u) { clients.forEach(c => { if (c !== ws && c.user.id === u.id) c.close(); }); ws.user = u; send(ws, { t: 'hi', id: u.id, now: Date.now(), hist }); send(ws, arState()); }
    } else if (m.t === 'bet') {
      const a = Math.round(+m.amount * 100) / 100;
      if (!round || round.phase !== 'wait') return send(ws, { t: 'err', refund: 1, msg: 'Раунд уже начался' });
      if (round.bets.has(id) || !(a >= MIN_BET && a <= MAX_BET)) return send(ws, { t: 'err', refund: 1, msg: 'Ставка отклонена' });
      round.bets.set(id, { id, nm: ws.user.nm, amount: a, gb: typeof m.gb === 'string' ? m.gb.slice(0, 8) : null, m: 0 });
      pushPlayers();
    } else if (m.t === 'cancel') {
      if (round && round.phase === 'wait') { round.bets.delete(id); pushPlayers(); }
    } else if (m.t === 'cash') {
      const b = round && round.bets.get(id);
      if (!b || b.m || round.phase !== 'fly') return;
      const el = (Date.now() - round.flyAt) / 1000, mult = Math.floor(Math.exp(SPEED * el) * 100) / 100;
      if (mult >= round.point) return;            // опоздал: ракета уже улетела
      b.m = mult; send(ws, { t: 'cashed', m: mult }); all({ t: 'out', id, m: mult });
    }
  });
  ws.on('close', () => { clients.delete(ws); clearInterval(rl); });
});

startRound(); arStart();
console.log('crash server on :' + PORT);
