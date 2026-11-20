'use strict';
/**
 * QuizLive server
 * - REST API to create / edit / export quizzes
 * - Socket.IO for realtime play, host dashboard and leaderboard
 * - Quizzes run automatically once started (question -> reveal -> next ...)
 * - Data persisted to data/quizzes.json (survives restarts)
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'quizzes.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 20000,
  pingTimeout: 30000,
  maxHttpBufferSize: 1e6,
  perMessageDeflate: { threshold: 2048 },
});

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Persistence                                                        */
/* ------------------------------------------------------------------ */
let quizzes = {};
const byCode = {};
const rt = {}; // runtime-only data per quiz (timers, throttles)

function load() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) quizzes = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  } catch (e) {
    console.error('Could not load data file, starting empty:', e.message);
    quizzes = {};
  }
  for (const q of Object.values(quizzes)) {
    byCode[q.code] = q.id;
    for (const p of Object.values(q.players || {})) p.online = 0;
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(quizzes), (e) => {
      if (e) return console.error('save failed', e);
      fs.rename(tmp, DATA_FILE, (e2) => e2 && console.error('rename failed', e2));
    });
  }, 1000);
}
function saveNow() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(quizzes)); } catch (e) { console.error(e); }
}
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const rid = (n) => crypto.randomBytes(n).toString('hex');
const clampInt = (v, lo, hi, def) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
};

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do {
    c = '';
    for (let i = 0; i < 6; i++) c += A[crypto.randomInt(A.length)];
  } while (byCode[c]);
  return c;
}

function cleanQuestions(arr) {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('Add at least one question.');
  if (arr.length > 2000) throw new Error('Maximum 2000 questions per quiz.');
  return arr.map((x, i) => {
    const n = i + 1;
    const q = String((x && x.q) || '').trim();
    if (!q) throw new Error(`Question ${n}: text is empty.`);
    const options = (Array.isArray(x.options) ? x.options : []).map((o) => String(o ?? '').trim()).filter(Boolean);
    if (options.length < 2) throw new Error(`Question ${n}: needs at least 2 options.`);
    if (options.length > 6) throw new Error(`Question ${n}: maximum 6 options.`);
    const answer = parseInt(x.answer, 10);
    if (!(answer >= 0 && answer < options.length)) throw new Error(`Question ${n}: answer key is missing or invalid.`);
    const time = x.time ? clampInt(x.time, 5, 600, null) : null;
    const image = x.image ? String(x.image).trim().slice(0, 1000) : '';
    const explanation = x.explanation ? String(x.explanation).trim().slice(0, 1000) : '';
    return { q: q.slice(0, 2000), options: options.map((o) => o.slice(0, 500)), answer, time, image, explanation };
  });
}

function cleanSettings(b, prev = {}) {
  return {
    defaultTime: clampInt(b.defaultTime ?? prev.defaultTime, 5, 600, 20),
    revealTime: clampInt(b.revealTime ?? prev.revealTime, 3, 120, 6),
    speedBonus: b.speedBonus === undefined ? (prev.speedBonus ?? true) : !!b.speedBonus,
    allowLateJoin: false,
    shuffleQuestions: b.shuffleQuestions === undefined ? (prev.shuffleQuestions ?? false) : !!b.shuffleQuestions,
  };
}

const qTime = (quiz, i) => quiz.questions[i].time || quiz.settings.defaultTime;
const playerCount = (quiz) => Object.keys(quiz.players).length;
const R = (quiz) => (rt[quiz.id] ||= { timer: null, earlyTimer: null, hostTimer: null, tickTimer: null, rankCache: null });

function ranked(quiz) {
  const r = R(quiz);
  if (r.rankCache) return r.rankCache;
  const list = Object.entries(quiz.players)
    .map(([pid, p]) => ({ pid, p }))
    .sort((a, b) => b.p.score - a.p.score || a.p.totalMs - b.p.totalMs || a.p.joinedAt - b.p.joinedAt);
  const rankOf = new Map();
  list.forEach((x, i) => rankOf.set(x.pid, i + 1));
  r.rankCache = { list, rankOf };
  return r.rankCache;
}
const invalidateRank = (quiz) => { R(quiz).rankCache = null; };

const AVATARS = ['🦊', '🐼', '🦁', '🐯', '🐸', '🦉', '🦄', '🐙', '🐝', '🦋', '🚀', '⚡', '🎯', '🌟', '🔥', '🧠'];
const cleanAvatar = (a) => (typeof a === 'string' && AVATARS.includes(a.trim()) ? a.trim() : AVATARS[0]);

function topList(quiz, n) {
  return ranked(quiz).list.slice(0, n).map((x, i) => ({
    rank: i + 1, name: x.p.name, avatar: x.p.avatar || AVATARS[0], score: x.p.score, correct: x.p.correct,
  }));
}

function distribution(quiz, qi) {
  const q = quiz.questions[qi];
  const d = new Array(q.options.length).fill(0);
  let attempted = 0, correct = 0;
  for (const p of Object.values(quiz.players)) {
    const a = p.answers[qi];
    if (a) { attempted++; d[a.c]++; if (a.ok) correct++; }
  }
  return { dist: d, attempted, correct };
}

function attemptsFor(quiz, qi) {
  const list = [], notAttempted = [];
  for (const [pid, p] of Object.entries(quiz.players)) {
    const a = p.answers[qi];
    if (a) list.push({ pid, name: p.name, avatar: p.avatar || AVATARS[0], c: a.c, ok: a.ok, ms: a.ms, pts: a.pts });
    else notAttempted.push({ pid, name: p.name, avatar: p.avatar || AVATARS[0], online: p.online > 0 });
  }
  list.sort((a, b) => a.ms - b.ms);
  notAttempted.sort((a, b) => a.name.localeCompare(b.name));
  return { qIndex: qi, attempts: list, notAttempted };
}

/* What every player sees (never leaks the answer during the question phase) */
function publicState(quiz) {
  const s = {
    status: quiz.status, title: quiz.title, code: quiz.code,
    total: quiz.questions.length, qIndex: quiz.current, phase: quiz.phase,
    endsAt: quiz.phaseEndsAt, now: Date.now(), players: playerCount(quiz),
  };
  if (quiz.status === 'running' && quiz.current >= 0) {
    const q = quiz.questions[quiz.current];
    s.question = { text: q.q, options: q.options, image: q.image, time: qTime(quiz, quiz.current) };
    if (quiz.phase === 'reveal') {
      const d = distribution(quiz, quiz.current);
      s.answer = q.answer;
      s.explanation = q.explanation;
      s.dist = d.dist; s.attempted = d.attempted; s.correctCount = d.correct;
      s.top = topList(quiz, 10);
      s.nextIsLast = quiz.current + 1 >= quiz.questions.length;
    }
  }
  if (quiz.status === 'ended') s.top = topList(quiz, 10);
  return s;
}

function personal(quiz, pid) {
  const p = quiz.players[pid];
  if (!p) return null;
  const revealOk = quiz.phase === 'reveal' || quiz.status === 'ended';
  const a = quiz.current >= 0 ? p.answers[quiz.current] : null;
  return {
    name: p.name, avatar: p.avatar || AVATARS[0], score: p.score, correct: p.correct,
    qIndex: quiz.current,
    rank: revealOk ? ranked(quiz).rankOf.get(pid) : null,
    players: playerCount(quiz),
    answer: a ? { c: a.c, ok: revealOk ? a.ok : undefined, pts: revealOk ? a.pts : undefined } : null,
  };
}

function hostState(quiz) {
  const r = ranked(quiz);
  const perQuestion = quiz.questions.map((q, i) => {
    const d = distribution(quiz, i);
    return { attempted: d.attempted, correct: d.correct };
  });
  const s = {
    ...publicState(quiz),
    id: quiz.id, settings: quiz.settings,
    startedAt: quiz.startedAt, endedAt: quiz.endedAt,
    questions: quiz.questions,
    online: Object.values(quiz.players).filter((p) => p.online > 0).length,
    perQuestion,
    leaderboard: r.list.map((x, i) => ({
      pid: x.pid, rank: i + 1, name: x.p.name, avatar: x.p.avatar || AVATARS[0], score: x.p.score, correct: x.p.correct,
      answered: Object.keys(x.p.answers).length, online: x.p.online > 0,
    })),
  };
  if (quiz.status === 'running' && quiz.current >= 0) {
    const q = quiz.questions[quiz.current];
    const d = distribution(quiz, quiz.current);
    s.answer = q.answer;
    s.dist = d.dist; s.attempted = d.attempted; s.correctCount = d.correct;
    s.current = attemptsFor(quiz, quiz.current);
  }
  return s;
}

/* ---------- throttled broadcasters (scale to many players) ---------- */
function hostDirty(quiz, delay = 400) {
  const r = R(quiz);
  if (r.hostTimer) return;
  r.hostTimer = setTimeout(() => {
    r.hostTimer = null;
    io.to('host:' + quiz.id).emit('host:state', hostState(quiz));
  }, delay);
}

function tickDirty(quiz) {
  const r = R(quiz);
  if (r.tickTimer) return;
  r.tickTimer = setTimeout(() => {
    r.tickTimer = null;
    const t = { players: playerCount(quiz) };
    if (quiz.status === 'running' && quiz.phase === 'question') t.answered = distribution(quiz, quiz.current).attempted;
    io.to('play:' + quiz.id).emit('tick', t);
  }, 1000);
}

function broadcastState(quiz, withPersonal) {
  const room = 'play:' + quiz.id;
  if (withPersonal) {
    const ids = io.sockets.adapter.rooms.get(room);
    if (ids) for (const sid of ids) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.pid) s.emit('you', personal(quiz, s.data.pid));
    }
  }
  io.to(room).emit('state', publicState(quiz));
  hostDirty(quiz, 50);
}

/* ------------------------------------------------------------------ */
/* Game engine – runs on its own once started                         */
/* ------------------------------------------------------------------ */
function schedule(quiz, ms, fn) {
  const r = R(quiz);
  clearTimeout(r.timer);
  clearTimeout(r.earlyTimer);
  r.earlyTimer = null;
  r.timer = setTimeout(fn, ms);
}

function allOnlineAnswered(quiz) {
  if (quiz.status !== 'running' || quiz.phase !== 'question' || quiz.current < 0) return false;
  const online = Object.values(quiz.players).filter((p) => p.online > 0);
  if (online.length === 0) return false;
  return online.every((p) => !!p.answers[quiz.current]);
}

function maybeEarlyReveal(quiz) {
  if (!allOnlineAnswered(quiz)) return;
  const r = R(quiz);
  if (r.earlyTimer) return;
  const cur = quiz.current;
  r.earlyTimer = setTimeout(() => {
    r.earlyTimer = null;
    if (quiz.status === 'running' && quiz.phase === 'question' && quiz.current === cur && allOnlineAnswered(quiz)) {
      goReveal(quiz);
    }
  }, 1200);
}

function startQuiz(quiz) {
  if (quiz.status !== 'lobby') return false;
  if (quiz.settings.shuffleQuestions) {
    for (let i = quiz.questions.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [quiz.questions[i], quiz.questions[j]] = [quiz.questions[j], quiz.questions[i]];
    }
  }
  quiz.status = 'running';
  quiz.startedAt = Date.now();
  // 3-second "get ready" countdown before Q1
  quiz.current = -1;
  quiz.phase = 'countdown';
  quiz.phaseEndsAt = Date.now() + 3000;
  broadcastState(quiz);
  schedule(quiz, 3000, () => goQuestion(quiz, 0));
  save();
  return true;
}

function goQuestion(quiz, i) {
  if (quiz.status !== 'running') return;
  if (i >= quiz.questions.length) return endQuiz(quiz);
  const t = qTime(quiz, i) * 1000;
  quiz.current = i;
  quiz.phase = 'question';
  quiz.phaseStartedAt = Date.now();
  quiz.phaseEndsAt = quiz.phaseStartedAt + t;
  schedule(quiz, t, () => goReveal(quiz));
  broadcastState(quiz, true);
  save();
}

function goReveal(quiz) {
  if (quiz.status !== 'running' || quiz.phase !== 'question') return;
  invalidateRank(quiz);
  const t = quiz.settings.revealTime * 1000;
  quiz.phase = 'reveal';
  quiz.phaseEndsAt = Date.now() + t;
  schedule(quiz, t, () => goQuestion(quiz, quiz.current + 1));
  broadcastState(quiz, true);
  save();
}

function endQuiz(quiz) {
  const r = R(quiz);
  clearTimeout(r.timer);
  clearTimeout(r.earlyTimer);
  r.earlyTimer = null;
  invalidateRank(quiz);
  quiz.status = 'ended';
  quiz.phase = null;
  quiz.endedAt = Date.now();
  broadcastState(quiz, true);
  saveNow();
}

function resetQuiz(quiz) {
  const r = R(quiz);
  clearTimeout(r.timer);
  clearTimeout(r.earlyTimer);
  r.earlyTimer = null;
  quiz.status = 'lobby';
  quiz.current = -1;
  quiz.phase = null;
  quiz.phaseEndsAt = 0;
  quiz.startedAt = null;
  quiz.endedAt = null;
  quiz.players = {};
  invalidateRank(quiz);
  io.to('play:' + quiz.id).emit('reset');
  // disconnect players from the old session
  io.in('play:' + quiz.id).socketsLeave('play:' + quiz.id);
  broadcastState(quiz);
  save();
}

/* resume quizzes that were running when the server restarted */
function resumeAll() {
  for (const quiz of Object.values(quizzes)) {
    if (quiz.status !== 'running') continue;
    if (quiz.phase === 'reveal') goQuestion(quiz, quiz.current + 1);
    else goQuestion(quiz, Math.max(0, quiz.current));
  }
}

/* ------------------------------------------------------------------ */
/* REST API                                                           */
/* ------------------------------------------------------------------ */
function hostQuiz(req, res) {
  const quiz = quizzes[req.params.id];
  const key = req.get('x-host-key') || req.query.key;
  if (!quiz || key !== quiz.hostKey) { res.status(404).json({ error: 'Quiz not found or wrong host key.' }); return null; }
  return quiz;
}

app.post('/api/quizzes', (req, res) => {
  try {
    const b = req.body || {};
    const questions = cleanQuestions(b.questions);
    const id = rid(8);
    const quiz = {
      id, code: newCode(), hostKey: rid(16),
      title: String(b.title || 'Untitled Quiz').trim().slice(0, 150) || 'Untitled Quiz',
      settings: cleanSettings(b),
      questions,
      status: 'lobby', current: -1, phase: null, phaseStartedAt: 0, phaseEndsAt: 0,
      players: {}, createdAt: Date.now(), startedAt: null, endedAt: null,
    };
    quizzes[id] = quiz;
    byCode[quiz.code] = id;
    save();
    res.json({ id, code: quiz.code, hostKey: quiz.hostKey });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/quizzes/:id', (req, res) => {
  const quiz = hostQuiz(req, res); if (!quiz) return;
  if (quiz.status === 'running') return res.status(409).json({ error: 'Cannot edit while the quiz is running.' });
  try {
    const b = req.body || {};
    if (b.questions) quiz.questions = cleanQuestions(b.questions);
    if (b.title) quiz.title = String(b.title).trim().slice(0, 150);
    quiz.settings = cleanSettings(b, quiz.settings);
    save();
    hostDirty(quiz, 10);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/quizzes/:id', (req, res) => {
  const quiz = hostQuiz(req, res); if (!quiz) return;
  clearTimeout(R(quiz).timer);
  io.to('play:' + quiz.id).emit('reset');
  delete byCode[quiz.code];
  delete quizzes[quiz.id];
  delete rt[quiz.id];
  save();
  res.json({ ok: true });
});

app.get('/api/join/:code', (req, res) => {
  const quiz = quizzes[byCode[String(req.params.code).toUpperCase()]];
  if (!quiz) return res.status(404).json({ error: 'No quiz with that code.' });
  res.json({ title: quiz.title, status: quiz.status, players: playerCount(quiz), total: quiz.questions.length, allowLateJoin: false });
});

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
app.get('/api/quizzes/:id/results.csv', (req, res) => {
  const quiz = hostQuiz(req, res); if (!quiz) return;
  const L = 'ABCDEF';
  const head = ['Rank', 'Name', 'Score', 'Correct', 'Attempted', 'Total time (s)'];
  quiz.questions.forEach((q, i) => head.push(`Q${i + 1} (key ${L[q.answer]})`));
  const rows = [head];
  ranked(quiz).list.forEach((x, i) => {
    const p = x.p;
    const row = [i + 1, p.name, p.score, p.correct, Object.keys(p.answers).length, (p.totalMs / 1000).toFixed(1)];
    quiz.questions.forEach((q, qi) => {
      const a = p.answers[qi];
      row.push(a ? `${L[a.c]} ${a.ok ? '✓' : '✗'} (${(a.ms / 1000).toFixed(1)}s)` : '-');
    });
    rows.push(row);
  });
  const fname = quiz.title.replace(/[^a-z0-9]+/gi, '_').slice(0, 50) || 'quiz';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}_results.csv"`);
  res.send('﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'));
});

app.get('/api/qr.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(String(req.query.text || '').slice(0, 500), { type: 'svg', margin: 1, width: 300 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(svg);
  } catch (e) { res.status(400).end(); }
});

app.get('/health', (req, res) => res.json({ ok: true, quizzes: Object.keys(quizzes).length }));

/* pretty URLs */
app.get('/host/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get(['/join', '/join/:code', '/play/:code'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'play.html')));

/* ------------------------------------------------------------------ */
/* Sockets                                                            */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
  const ackFn = (ack) => (typeof ack === 'function' ? ack : () => {});

  /* ---------------- host ---------------- */
  const asHost = (ack) => {
    const quiz = quizzes[socket.data.quizId];
    if (!quiz || socket.data.role !== 'host') { ackFn(ack)({ error: 'Not authorised' }); return null; }
    return quiz;
  };

  socket.on('host:join', ({ id, key } = {}, ack) => {
    const quiz = quizzes[id];
    if (!quiz || key !== quiz.hostKey) return ackFn(ack)({ error: 'Quiz not found or wrong host key.' });
    socket.data = { quizId: id, role: 'host' };
    socket.join('host:' + id);
    ackFn(ack)({ ok: true, state: hostState(quiz) });
  });

  socket.on('host:start', (_, ack) => {
    const quiz = asHost(ack); if (!quiz) return;
    if (!startQuiz(quiz)) return ackFn(ack)({ error: 'Quiz is not in the lobby.' });
    ackFn(ack)({ ok: true });
  });

  socket.on('host:skip', (_, ack) => {
    const quiz = asHost(ack); if (!quiz) return;
    if (quiz.status !== 'running') return ackFn(ack)({ error: 'Not running' });
    if (quiz.phase === 'question') goReveal(quiz);
    else if (quiz.phase === 'reveal') goQuestion(quiz, quiz.current + 1);
    else if (quiz.phase === 'countdown') goQuestion(quiz, 0);
    ackFn(ack)({ ok: true });
  });

  socket.on('host:end', (_, ack) => {
    const quiz = asHost(ack); if (!quiz) return;
    if (quiz.status === 'running') endQuiz(quiz);
    ackFn(ack)({ ok: true });
  });

  socket.on('host:reset', (_, ack) => {
    const quiz = asHost(ack); if (!quiz) return;
    resetQuiz(quiz);
    ackFn(ack)({ ok: true });
  });

  socket.on('host:kick', ({ pid } = {}, ack) => {
    const quiz = asHost(ack); if (!quiz) return;
    if (!quiz.players[pid]) return ackFn(ack)({ error: 'No such player' });
    delete quiz.players[pid];
    invalidateRank(quiz);
    const ids = io.sockets.adapter.rooms.get('play:' + quiz.id);
    if (ids) for (const sid of ids) {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.pid === pid) { s.emit('kicked'); s.leave('play:' + quiz.id); s.data.pid = null; }
    }
    hostDirty(quiz, 10); tickDirty(quiz); save();
    maybeEarlyReveal(quiz);
    ackFn(ack)({ ok: true });
  });

  socket.on('host:attempts', ({ qIndex } = {}, ack) => {
    const quiz = asHost(ack); if (!quiz) return;
    const qi = parseInt(qIndex, 10);
    if (!(qi >= 0 && qi < quiz.questions.length)) return ackFn(ack)({ error: 'Bad question' });
    ackFn(ack)({ ok: true, ...attemptsFor(quiz, qi), question: quiz.questions[qi] });
  });

  /* ---------------- player ---------------- */
  socket.on('player:join', ({ code, name, avatar, pid } = {}, ack) => {
    const quiz = quizzes[byCode[String(code || '').toUpperCase().trim()]];
    if (!quiz) return ackFn(ack)({ error: 'Quiz not found. Check the link or code.' });
    let p = pid && quiz.players[pid];
    if (!p) {
      if (quiz.status === 'ended') return ackFn(ack)({ error: 'This quiz has already ended.' });
      if (quiz.status !== 'lobby') return ackFn(ack)({ error: 'This quiz has already started. Joining mid-way is not allowed.' });
      name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 30);
      if (!name) return ackFn(ack)({ error: 'Please enter your name.' });
      const taken = new Set(Object.values(quiz.players).map((x) => x.name.toLowerCase()));
      let final = name, n = 2;
      while (taken.has(final.toLowerCase())) final = `${name} (${n++})`;
      pid = rid(8);
      p = quiz.players[pid] = {
        name: final,
        avatar: cleanAvatar(avatar),
        score: 0, correct: 0, totalMs: 0, answers: {}, joinedAt: Date.now(), online: 0,
      };
      invalidateRank(quiz);
      save();
    }
    if (socket.data.pid && socket.data.quizId) leavePlayer(socket);
    socket.data = { quizId: quiz.id, pid, role: 'player' };
    socket.join('play:' + quiz.id);
    p.online++;
    ackFn(ack)({ ok: true, pid, state: publicState(quiz), you: personal(quiz, pid) });
    hostDirty(quiz); tickDirty(quiz);
  });

  socket.on('player:answer', ({ qIndex, choice } = {}, ack) => {
    const done = ackFn(ack);
    const quiz = quizzes[socket.data.quizId];
    const pid = socket.data.pid;
    const p = quiz && pid && quiz.players[pid];
    if (!p) return done({ error: 'Not in this quiz.' });
    if (quiz.status !== 'running' || quiz.phase !== 'question' || qIndex !== quiz.current) return done({ error: 'Time is up for this question.' });
    const now = Date.now();
    if (now > quiz.phaseEndsAt + 300) return done({ error: 'Time is up for this question.' });
    if (p.answers[quiz.current]) return done({ error: 'You already answered.' });
    const q = quiz.questions[quiz.current];
    const c = parseInt(choice, 10);
    if (!(c >= 0 && c < q.options.length)) return done({ error: 'Invalid option.' });
    const T = qTime(quiz, quiz.current) * 1000;
    const ms = Math.max(0, Math.min(T, now - quiz.phaseStartedAt));
    const ok = c === q.answer;
    const pts = ok ? (quiz.settings.speedBonus ? Math.round(500 + 500 * (1 - ms / T)) : 1000) : 0;
    p.answers[quiz.current] = { c, ok, pts, ms };
    p.score += pts;
    p.totalMs += ms;
    if (ok) p.correct++;
    invalidateRank(quiz);
    done({ ok: true });
    hostDirty(quiz); tickDirty(quiz); save();
    // all remaining online players answered? reveal early (after a short pause)
    maybeEarlyReveal(quiz);
  });

  function leavePlayer(s) {
    const quiz = quizzes[s.data.quizId];
    const p = quiz && quiz.players[s.data.pid];
    if (p) {
      p.online = Math.max(0, p.online - 1);
      hostDirty(quiz);
      tickDirty(quiz);
    }
    if (quiz) {
      s.leave('play:' + quiz.id);
      if (quiz.status === 'running' && quiz.phase === 'question') {
        maybeEarlyReveal(quiz);
      }
    }
  }

  socket.on('disconnect', () => {
    if (socket.data && socket.data.role === 'player') leavePlayer(socket);
  });
});

load();
resumeAll();
server.listen(PORT, '0.0.0.0', () => console.log(`QuizLive running on http://localhost:${PORT}`));
