
// GiftsUP «Ракетка»: общий раунд для всех игроков.
// Запуск: npm i && PORT=8080 BOT_TOKEN=123:abc node server.js
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SPEED = 0.17;
const WAIT_MS = +process.env.WAIT_MS || 6000, PAUSE_MS = 3500;
const MIN_BET = 1, MAX_BET = 100000;

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function crashFrom(seed) {
  const r = parseInt(sha(seed + ':crash').slice(0, 13), 16) / 2 ** 52;
  return Math.min(500, Math.max(1.01, Math.floor(.99 / (1 - r) * 100) / 100));
}

function verifyInit(initData) {
  try {
    if (!BOT_TOKEN || !initData) return null;
    const p = new URLSearchParams(initData), hash = p.get('hash');
    p.delete('hash');
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const key = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    if (crypto.createHmac('sha256', key).update(str).digest('hex') !== hash) return null;
    const u = JSON.parse(p.get('user'));
    return { id: 'tg' + u.id, nm: u.username ? '@' + u.username : (u.first_name || 'user') };
  } catch {
    return null;
  }
}

const http = require('http');
const fs = require('fs');
const path = require('path');

// Промокоды хранятся в JSON.
// Для сохранения между деплоями Render подключите Disk:
// Mount Path=/var/data, DATA_DIR=/var/data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PROMO_FILE = path.join(DATA_DIR, 'promos.json');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const adminSessions = new Map();

let promoStore = { promos: {} };

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(PROMO_FILE)) {
    const parsed = JSON.parse(fs.readFileSync(PROMO_FILE, 'utf8'));
    if (parsed && parsed.promos && typeof parsed.promos === 'object') promoStore = parsed;
  } else {
    fs.writeFileSync(PROMO_FILE, JSON.stringify(promoStore, null, 2));
  }
} catch (e) {
  console.error('Promo storage init error:', e.message);
}

function savePromos() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = PROMO_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(promoStore, null, 2));
  fs.renameSync(tmp, PROMO_FILE);
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 65536) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function reply(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(payload));
}

function getAdmin(req) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = adminSessions.get(token);
  if (!session || session.expires < Date.now()) {
    if (token) adminSessions.delete(token);
    return null;
  }
  return session;
}

function promoApi(req, res) {
  if (req.method === 'OPTIONS') return reply(res, 204, {});

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/health') {
    return reply(res, 200, { ok: true });
  }

  if (url.pathname === '/api/admin/login' && req.method === 'POST') {
    return readBody(req).then(body => {
      const telegramUser = verifyInit(body.initData);

      if (!telegramUser) {
        return reply(res, 401, {
          ok: false,
          error: 'Откройте админ-панель внутри Telegram Mini App'
        });
      }

      if (!ADMIN_KEY || !safeEqual(body.key, ADMIN_KEY)) {
        return reply(res, 403, {
          ok: false,
          error: 'Неверный админ-ключ'
        });
      }

      const token = crypto.randomBytes(32).toString('hex');
      adminSessions.set(token, {
        id: telegramUser.id,
        expires: Date.now() + 8 * 60 * 60 * 1000
      });

      return reply(res, 200, { ok: true, token });
    }).catch(e => reply(res, 400, { ok: false, error: e.message }));
  }

  if (url.pathname.startsWith('/api/admin/')) {
    const admin = getAdmin(req);

    if (!admin) {
      return reply(res, 401, {
        ok: false,
        error: 'Сессия истекла. Войдите снова.'
      });
    }

    if (url.pathname === '/api/admin/promos' && req.method === 'GET') {
      const promos = Object.values(promoStore.promos).map(p => ({
        code: p.code,
        rewardType: p.rewardType,
        amount: p.amount,
        limit: p.limit,
        used: p.users.length,
        active: p.active
      }));

      return reply(res, 200, { ok: true, promos });
    }

    if (url.pathname === '/api/admin/promos/create' && req.method === 'POST') {
      return readBody(req).then(body => {
        const code = String(body.code || '')
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 24);

        const rewardType =
          body.rewardType === 'chest' ? 'chest' :
          body.rewardType === 'gram' ? 'gram' : '';

        const amount = Number(body.amount);
        const limit = Math.floor(Number(body.limit));

        if (
          code.length < 4 ||
          !rewardType ||
          !Number.isFinite(amount) ||
          amount <= 0 ||
          amount > 1000000 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 1000000
        ) {
          return reply(res, 400, {
            ok: false,
            error: 'Проверьте код, награду и лимит'
          });
        }

        if (
          promoStore.promos[code] ||
          Object.prototype.hasOwnProperty.call(PROMO_CODES_RESERVED, code)
        ) {
          return reply(res, 409, {
            ok: false,
            error: 'Такой промокод уже существует'
          });
        }

        promoStore.promos[code] = {
          code,
          rewardType,
          amount,
          limit,
          users: [],
          active: true,
          createdAt: Date.now(),
          createdBy: admin.id
        };

        try {
          savePromos();
        } catch (e) {
          delete promoStore.promos[code];
          return reply(res, 500, {
            ok: false,
            error: 'Не удалось сохранить промокод'
          });
        }

        return reply(res, 200, { ok: true });
      }).catch(e => reply(res, 400, { ok: false, error: e.message }));
    }

    if (url.pathname === '/api/admin/promos/disable' && req.method === 'POST') {
      return readBody(req).then(body => {
        const code = String(body.code || '').toUpperCase();
        const p = promoStore.promos[code];

        if (!p) {
          return reply(res, 404, {
            ok: false,
            error: 'Промокод не найден'
          });
        }

        p.active = false;

        try {
          savePromos();
        } catch {
          p.active = true;
          return reply(res, 500, {
            ok: false,
            error: 'Не удалось сохранить изменение'
          });
        }

        return reply(res, 200, { ok: true });
      }).catch(e => reply(res, 400, { ok: false, error: e.message }));
    }

    return reply(res, 404, { ok: false, error: 'Неизвестный метод' });
  }

  if (url.pathname === '/api/promo/redeem' && req.method === 'POST') {
    return readBody(req).then(body => {
      const user = verifyInit(body.initData);

      if (!user) {
        return reply(res, 401, {
          ok: false,
          error: 'Для активации откройте сайт через Telegram'
        });
      }

      const code = String(body.code || '')
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 24);

      const p = promoStore.promos[code];

      if (!p || !p.active) {
        return reply(res, 404, {
          ok: false,
          error: 'Промокод не найден или отключён'
        });
      }

      if (p.users.includes(user.id)) {
        return reply(res, 200, {
          ok: true,
          rewardType: p.rewardType,
          amount: p.amount,
          alreadyRedeemed: true
        });
      }

      if (p.users.length >= p.limit) {
        return reply(res, 409, {
          ok: false,
          error: 'Лимит активаций промокода исчерпан'
        });
      }

      p.users.push(user.id);

      try {
        savePromos();
      } catch (e) {
        p.users.pop();
        return reply(res, 500, {
          ok: false,
          error: 'Не удалось сохранить активацию. Попробуйте ещё раз.'
        });
      }

      return reply(res, 200, {
        ok: true,
        rewardType: p.rewardType,
        amount: p.amount
      });
    }).catch(e => reply(res, 400, { ok: false, error: e.message }));
  }

  reply(res, 200, { ok: true, service: 'GiftsUP server' });
}

// Запрещаем повторное создание старых промокодов.
const PROMO_CODES_RESERVED = Object.fromEntries([
  '2WT6VJTS','37CQUR6P','3BBF3UVD','3LCKT7VK','3Z33J4HD',
  '439DW7GQ','44C2M996','5FUPDXUZ','5RQ2V8ZL','5VMTQTZA',
  '5YSP39FP','65PR5W3Z','6BVNL4CT','6RC5VK7N','74DDNXUN',
  '77576287','7AVTDWE7','7X5SYDC6','82U7FGJE','89Z4FJMU',
  '8T56LZMR','8U42T595','9E5TJLD9','9FZS2BB6','A7YAUZKP',
  'ADWVK98U','AMLQHA2D','ATG9C38M','BNZ4LPFU','BS3FCM7F',
  'BYQEFHG7','C3L55QJX','CER47VC4','CJKPU3BF','DRZQGS8X',
  'FU6A6733','FZXGH9TD','G774F3B3','HH4C6LSK','J8C49CTY',
  'J8ZENMBA','JR42LEPS','KJGS6S4M','LD7G93B6','LH2BNDTP',
  'LPCGMLKX','LYBBKYV9','LZXBLZ2D','MER2G5W3','MXLDMBJE',
  'MXP9AB22','N3D3MLTL','NJU7QYX5','NL4LGTR7','NRBZ2AYW',
  'PDMHUWDH','PK5JATSG','PRBA3KH4','QB6R8J9L','QJUG8DTV',
  'R6AX2PGM','RJ9PPH9P','RRC2D6AP','S3YGFNNZ','SAHBVJ5Z',
  'SB9QHSTK','SG8TSZ69','SHWM78JR','SZX9MHVV','TK8B5PJW',
  'U9H9MGLA','UZVQHPTD','VQUYKXHK','VY39AGCX','VY9BHUBE',
  'VYUPSDTA','W43YZD8D','W7RPWNA3','W9T58KMR','WB9FLXNT',
  'Z6LJWHMQ','ZUADKUQT'
].map(x => [x, true]));

// HTTP API + WebSocket на одном порту.
const httpServer = http.createServer((req, res) => {
  try {
    promoApi(req, res);
  } catch (e) {
    console.error(e);
    reply(res, 500, { ok: false, error: 'server error' });
  }
});

const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT, '0.0.0.0');

let round = null, hist = [];
const clients = new Set();

const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const all = o => clients.forEach(c => send(c, o));

const list = () => round
  ? [...round.bets.values()].map(b => ({
      id: b.id,
      nm: b.nm,
      bet: b.amount,
      gb: b.gb,
      m: b.m
    }))
  : [];

let pt = null;

const pushPlayers = () => {
  if (!pt) {
    pt = setTimeout(() => {
      pt = null;
      all({ t: 'players', list: list() });
    }, 250);
  }
};

// ===== РАКЕТКА =====

function startRound() {
  const seed = crypto.randomBytes(16).toString('hex');

  round = {
    seed,
    hash: sha(seed),
    point: crashFrom(seed),
    phase: 'wait',
    bets: new Map(),
    startAt: Date.now() + WAIT_MS
  };

  all({ t: 'wait', hash: round.hash, startAt: round.startAt });
  setTimeout(fly, WAIT_MS);
}

function fly() {
  round.phase = 'fly';
  round.flyAt = Date.now();

  all({ t: 'fly', startAt: round.flyAt });

  setTimeout(crash, Math.log(round.point) / SPEED * 1000);
}

function crash() {
  round.phase = 'crash';
  hist = [round.point, ...hist].slice(0, 14);

  all({
    t: 'crash',
    point: round.point,
    seed: round.seed,
    hist
  });

  setTimeout(startRound, PAUSE_MS);
}

// ===== АРЕНА =====

const AR_BET = +process.env.AR_BET_MS || 30000;
const AR_SPIN = +process.env.AR_SPIN_MS || 6500;
const AR_RES = +process.env.AR_RES_MS || 5500;

const AR_PRIZE = .85;
const AR_JP = .10;
const AR_MIN = 1;
const AR_MAX = 100000;
const AR_PLAYERS = 40;

const A = {
  n: 0,
  jp: 0,
  phase: 'bet',
  bets: new Map(),
  seed: '',
  hash: '',
  end: 0,
  off: 0,
  winner: null
};

const arList = () => [...A.bets.values()].map(b => ({
  id: b.id,
  nm: b.nm,
  bet: b.bet,
  c: b.c
}));

const arState = () => ({
  t: 'ar_state',
  phase: A.phase,
  n: A.n,
  off: A.off,
  end: A.end,
  hash: A.hash,
  jp: A.jp,
  list: arList(),
  winner: A.winner
});

let apt = null;

const arPush = () => {
  if (!apt) {
    apt = setTimeout(() => {
      apt = null;
      all({ t: 'ar_players', jp: A.jp, list: arList() });
    }, 250);
  }
};

function arStart() {
  A.n++;
  A.seed = crypto.randomBytes(16).toString('hex');
  A.hash = sha(A.seed);
  A.phase = 'bet';
  A.bets = new Map();
  A.winner = null;
  A.off = Math.random() * 4;
  A.end = 0;

  // Таймер ставок начнётся после ставок двух разных игроков.
  all(arState());
}

function arClose() {
  if (A.bets.size < 2) {
    // Одному играть не с кем: возврат ставки.
    for (const b of A.bets.values()) {
      clients.forEach(c => {
        if (c.user.id === b.id) {
          send(c, { t: 'ar_refund', amount: b.bet });
        }
      });
    }

    return arStart();
  }

  const list = arList();
  const pot = list.reduce((a, p) => a + p.bet, 0);
  const r = parseInt(sha(A.seed + ':arena').slice(0, 13), 16) / 2 ** 52 * pot;

  let acc = 0;
  let w = list[list.length - 1];

  for (const p of list) {
    acc += p.bet;
    if (r < acc) {
      w = p;
      break;
    }
  }

  A.winner = w.id;
  A.phase = 'spin';
  A.jp += pot * AR_JP;

  all({
    t: 'ar_spin',
    n: A.n,
    list,
    winner: w.id,
    jp: A.jp,
    seed: A.seed
  });

  if (A.n % 100 === 0) A.jp = 0;

  // Следующий раунд начинается после прокрутки и показа результата.
  setTimeout(arStart, AR_SPIN + AR_RES);
}

function arBet(ws, m) {
  const a = Math.round(+m.amount * 100) / 100;
  const id = ws.user.id;

  const err = msg => {
    send(ws, {
      t: 'ar_err',
      refund: a > 0 ? a : 0,
      msg
    });

    send(ws, {
      t: 'ar_players',
      jp: A.jp,
      list: arList()
    });
  };

  if (!(a >= AR_MIN && a <= AR_MAX)) {
    return err('Ставка отклонена');
  }

  if (A.phase !== 'bet' || (A.end !== 0 && Date.now() >= A.end)) {
    return err('Ставки закрыты');
  }

  let b = A.bets.get(id);

  if (!b) {
    if (A.bets.size >= AR_PLAYERS) {
      return err('В раунде максимум ' + AR_PLAYERS + ' игроков');
    }

    const used = new Set([...A.bets.values()].map(x => x.c));
    let c = 0;
    while (used.has(c)) c++;

    b = {
      id,
      nm: ws.user.nm,
      bet: 0,
      c
    };

    A.bets.set(id, b);
  }

  b.bet = Math.round((b.bet + a) * 100) / 100;

  // 30 секунд на ставки отсчитываются с момента,
  // когда поставили два разных игрока.
  if (A.bets.size >= 2 && A.end === 0) {
    A.end = Date.now() + AR_BET;
    all(arState());
    setTimeout(arClose, AR_BET);
  }

  arPush();
}

// ===== ПОДКЛЮЧЕНИЯ И ИГРОВЫЕ СООБЩЕНИЯ =====

wss.on('connection', ws => {
  ws.user = {
    id: 'g' + crypto.randomBytes(4).toString('hex')
  };

  ws.user.nm = 'Guest_' + ws.user.id.slice(1, 5);

  ws.msgs = 0;
  const rl = setInterval(() => ws.msgs = 0, 1000);

  clients.add(ws);

  send(ws, {
    t: 'hi',
    id: ws.user.id,
    now: Date.now(),
    hist
  });

  if (round) {
    send(ws, {
      t: 'wait',
      hash: round.hash,
      startAt: round.startAt
    });

    if (round.phase === 'fly') {
      send(ws, {
        t: 'fly',
        startAt: round.flyAt
      });
    }

    send(ws, {
      t: 'players',
      list: list()
    });
  }

  send(ws, arState());

  ws.on('message', raw => {
    if (++ws.msgs > 20) return;

    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    const id = ws.user.id;

    if (m.t === 'ar_bet') {
      return arBet(ws, m);
    }

    if (m.t === 'ar_sync') {
      return send(ws, arState());
    }

    if (m.t === 'hello') {
      const u = verifyInit(m.initData);

      if (u) {
        clients.forEach(c => {
          if (c !== ws && c.user.id === u.id) c.close();
        });

        ws.user = u;

        send(ws, {
          t: 'hi',
          id: u.id,
          now: Date.now(),
          hist
        });

        send(ws, arState());
      }
    } else if (m.t === 'bet') {
      const a = Math.round(+m.amount * 100) / 100;

      if (!round || round.phase !== 'wait') {
        return send(ws, {
          t: 'err',
          refund: 1,
          msg: 'Раунд уже начался'
        });
      }

      if (round.bets.has(id) || !(a >= MIN_BET && a <= MAX_BET)) {
        return send(ws, {
          t: 'err',
          refund: 1,
          msg: 'Ставка отклонена'
        });
      }

      round.bets.set(id, {
        id,
        nm: ws.user.nm,
        amount: a,
        gb: typeof m.gb === 'string' ? m.gb.slice(0, 8) : null,
        m: 0
      });

      pushPlayers();
    } else if (m.t === 'cancel') {
      if (round && round.phase === 'wait') {
        round.bets.delete(id);
        pushPlayers();
      }
    } else if (m.t === 'cash') {
      const b = round && round.bets.get(id);

      if (!b || b.m || round.phase !== 'fly') return;

      const el = (Date.now() - round.flyAt) / 1000;
      const mult = Math.floor(Math.exp(SPEED * el) * 100) / 100;

      if (mult >= round.point) return;

      b.m = mult;

      send(ws, {
        t: 'cashed',
        m: mult
      });

      all({
        t: 'out',
        id,
        m: mult
      });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    clearInterval(rl);
  });
});

startRound();
arStart();

console.log('crash server on :' + PORT);
