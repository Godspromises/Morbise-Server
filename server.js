'use strict';

/**
 * MORBISE QUIZ ENGINE — LIVE SERVER v1.0
 * ═══════════════════════════════════════
 * Handles:
 *   • Session creation + management
 *   • Participant registration (phone join)
 *   • Real-time WebSocket sync (moderator ↔ projector ↔ participants)
 *   • Answer submission + live scoring
 *   • Round and total leaderboards
 *
 * Deploy to Railway / Render / any Node host.
 * Local dev: node server.js  (runs on PORT 3000)
 */

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const cors       = require('cors');
const path       = require('path');
const { v4: uuidv4 } = require('uuid');

// ── Database: in-memory only (no native compilation needed)
// Sessions and answers live in RAM. On Railway, the filesystem is ephemeral
// anyway, so in-memory is the correct approach. Phase 7 will add PostgreSQL
// via Railway's managed DB plugin (no compilation required).
let db = null; // null = use in-memory maps only (already the primary store)
console.log('[DB] Running in-memory mode — no SQLite compilation required');

// ─────────────────────────────────────────────
// DATABASE — in-memory only (see db declaration above)
// All state lives in the sessions and wsClients Maps below.
// PostgreSQL will be added in Phase 7 via Railway's DB plugin.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// IN-MEMORY STATE (fast runtime cache)
// ─────────────────────────────────────────────
// sessions  : Map<code, SessionState>
// wsClients : Map<code, Set<WSClient>>
const sessions  = new Map();
const wsClients = new Map();

function getSession(code) { return sessions.get(code.toUpperCase()); }

function createSessionState(id, code, quizData, mode) {
  return {
    id, code, mode,
    quizTitle:    quizData.title  || 'Untitled',
    quiz:         quizData,
    status:       'waiting',    // waiting | active | paused | finished
    currentRound: 0,
    currentQ:     0,
    timerValue:   0,
    timerRunning: false,
    revealedQuestion: false,
    optionsRevealed:  0,
    answerRevealed:   false,
    projectorView:    'question',
    participants:     new Map(), // participantId → ParticipantState
    answers:          new Map(), // `${ri}:${qi}:${pid}` → optionIndex
    scoredQuestions:  new Set(), // `${ri}:${qi}` (once revealed)
    createdAt:        Date.now(),
  };
}

function participantState(id, name, team) {
  return { id, name, team: team || '', score: 0, connected: false };
}

// ─────────────────────────────────────────────
// EXPRESS APP
// ─────────────────────────────────────────────
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Join page — serves join.html for any /join/:code URL
// The code is read by join.html from the URL path via JS
app.get('/join/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

app.get('/join', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// ── Health check
app.get('/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0', sessions: sessions.size });
});

// ─────────────────────────────────────────────
// SESSION ROUTES
// ─────────────────────────────────────────────

// POST /api/session/create
// Called by the desktop app when host clicks "Run Quiz" (Live/Hybrid mode)
app.post('/api/session/create', (req, res) => {
  const { quizData, mode } = req.body;
  if (!quizData || !quizData.rounds) {
    return res.status(400).json({ error: 'quizData with rounds required' });
  }

  const id   = uuidv4();
  const code = generateCode();
  const m    = mode || quizData.mode || 'live';

  // Persist to DB
  

  // Cache in memory
  const state = createSessionState(id, code, quizData, m);
  sessions.set(code, state);
  wsClients.set(code, new Set());

  console.log(`[SESSION] Created: ${code} — "${quizData.title}" (${m})`);
  res.json({ id, code, joinUrl: buildJoinUrl(req, code) });
});

// GET /api/session/:code
// Polled by phones to check session exists before joining
app.get('/api/session/:code', (req, res) => {
  const code = req.params.code.toUpperCase();
  const s = getSession(code);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({
    code,
    quizTitle: s.quizTitle,
    mode:      s.mode,
    status:    s.status,
    rounds:    s.quiz.rounds.map(r => ({ name: r.name, questions: r.questions.length })),
    participants: s.participants.size,
  });
});

// POST /api/session/:code/join
// Called when a phone submits the join form
app.post('/api/session/:code/join', (req, res) => {
  const code = req.params.code.toUpperCase();
  const s = getSession(code);
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status === 'finished') return res.status(400).json({ error: 'Session has ended' });

  const { name, team, deviceId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

  // Check if device already joined (reconnect)
  let existing = null;
  if (deviceId) {
    for (const [, p] of s.participants) {
      if (p.deviceId === deviceId) { existing = p; break; }
    }
  }

  let pid;
  if (existing) {
    pid = existing.id;
    existing.name = name.trim();
    existing.team = (team || '').trim();
  } else {
    pid = uuidv4();
    const p = participantState(pid, name.trim(), (team || '').trim());
    p.deviceId = deviceId || null;
    s.participants.set(pid, p);

    
  }

  // Notify all moderator/projector clients of new participant
  broadcast(code, { type: 'participantJoined', participants: participantList(s) });

  console.log(`[JOIN] ${name} joined session ${code}`);
  res.json({
    participantId: pid,
    sessionCode:   code,
    quizTitle:     s.quizTitle,
    mode:          s.mode,
    currentRound:  s.currentRound,
    currentQ:      s.currentQ,
    status:        s.status,
  });
});

// POST /api/session/:code/answer
// Called by phone when participant submits an answer
app.post('/api/session/:code/answer', (req, res) => {
  const code = req.params.code.toUpperCase();
  const s = getSession(code);
  if (!s) return res.status(404).json({ error: 'Session not found' });

  const { participantId, roundIndex, questionIndex, optionIndex } = req.body;
  if (participantId === undefined || roundIndex === undefined ||
      questionIndex === undefined || optionIndex === undefined) {
    return res.status(400).json({ error: 'Missing answer fields' });
  }

  const p = s.participants.get(participantId);
  if (!p) return res.status(404).json({ error: 'Participant not found in session' });

  // Only accept if question is not yet scored (answer revealed)
  const qKey = `${roundIndex}:${questionIndex}`;
  if (s.scoredQuestions.has(qKey)) {
    return res.status(400).json({ error: 'Answer already revealed — too late' });
  }

  const aKey = `${qKey}:${participantId}`;
  s.answers.set(aKey, { optionIndex, submittedAt: Date.now() });

  // Notify moderator that this participant answered
  broadcast(code, {
    type: 'answerReceived',
    participantId, participantName: p.name,
    roundIndex, questionIndex, optionIndex,
    answeredCount: countAnswered(s, roundIndex, questionIndex),
    totalParticipants: s.participants.size,
  });

  res.json({ ok: true });
});

// GET /api/session/:code/state
// Polled by phone to get current quiz state (fallback when WS drops)
app.get('/api/session/:code/state', (req, res) => {
  const code = req.params.code.toUpperCase();
  const s = getSession(code);
  if (!s) return res.status(404).json({ error: 'Not found' });

  const { participantId } = req.query;
  res.json(buildParticipantState(s, participantId));
});

// GET /api/session/:code/leaderboard
app.get('/api/session/:code/leaderboard', (req, res) => {
  const code = req.params.code.toUpperCase();
  const s = getSession(code);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json({ leaderboard: buildLeaderboard(s) });
});

// POST /api/session/:code/end
// Called by desktop when quiz is finished
app.post('/api/session/:code/end', (req, res) => {
  const code = req.params.code.toUpperCase();
  const s = getSession(code);
  if (!s) return res.status(404).json({ error: 'Not found' });
  s.status = 'finished';
  // Status stored in-memory only
  broadcast(code, { type: 'sessionEnded', leaderboard: buildLeaderboard(s) });
  console.log(`[SESSION] Ended: ${code}`);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────
// WEBSOCKET SERVER
// ─────────────────────────────────────────────
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/live' });

wss.on('connection', (ws, req) => {
  // URL: /live?code=ABC123&role=moderator|projector|participant&participantId=...
  const url    = new URL(req.url, 'http://localhost');
  const code   = (url.searchParams.get('code') || '').toUpperCase();
  const role   = url.searchParams.get('role') || 'participant';
  const pid    = url.searchParams.get('participantId') || null;

  if (!code) { ws.close(1008, 'code required'); return; }

  const s = getSession(code);
  if (!s) { ws.close(1008, 'session not found'); return; }

  // Register client
  ws._mqeCode = code;
  ws._mqeRole = role;
  ws._mqePid  = pid;
  wsClients.get(code)?.add(ws);

  // Mark participant as connected
  if (role === 'participant' && pid) {
    const p = s.participants.get(pid);
    if (p) { p.connected = true; broadcast(code, { type: 'participantStatus', participantId: pid, connected: true }); }
  }

  console.log(`[WS] ${role} connected to ${code} (${wsClients.get(code)?.size} clients)`);

  // Send current state immediately on connect
  ws.send(JSON.stringify({
    type: 'init',
    state: role === 'participant' ? buildParticipantState(s, pid) : buildModeratorState(s),
    participants: participantList(s),
  }));

  // Handle incoming messages
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    handleWsMessage(ws, code, role, pid, msg, s);
  });

  ws.on('close', () => {
    wsClients.get(code)?.delete(ws);
    if (role === 'participant' && pid) {
      const p = s.participants.get(pid);
      if (p) { p.connected = false; broadcast(code, { type: 'participantStatus', participantId: pid, connected: false }); }
    }
    console.log(`[WS] ${role} disconnected from ${code}`);
  });

  ws.on('error', err => console.error('[WS] error:', err.message));
});

// ─────────────────────────────────────────────
// WS MESSAGE HANDLER
// ─────────────────────────────────────────────
function handleWsMessage(ws, code, role, pid, msg, s) {
  // Only moderator can send control messages
  if (role === 'moderator') {
    switch (msg.type) {

      case 'moderatorState': {
        // Desktop pushes its full projector state — relay to projector + participants
        const { state } = msg;
        if (!state) return;
        // Update server-side session state
        s.currentRound      = state.currentRound      ?? s.currentRound;
        s.currentQ          = state.currentQ           ?? s.currentQ;
        s.timerValue        = state.timer              ?? s.timerValue;
        s.timerRunning      = state.running            ?? s.timerRunning;
        s.revealedQuestion  = state.revealedQuestion   ?? s.revealedQuestion;
        s.optionsRevealed   = state.optionsRevealed    ?? s.optionsRevealed;
        s.answerRevealed    = state.answerRevealed     ?? s.answerRevealed;
        s.projectorView     = state.view               ?? s.projectorView;
        s.status = 'active';

        // Score answers if answer just revealed
        if (state.answerRevealed && state.view === 'question') {
          scoreQuestion(s, s.currentRound, s.currentQ);
        }

        // Broadcast to projector (full state) and participants (their view)
        broadcastToRole(code, 'projector', { type: 'projectorState', state });
        broadcastParticipantUpdates(code, s);
        break;
      }

      case 'revealAnswer': {
        scoreQuestion(s, s.currentRound, s.currentQ);
        broadcastParticipantUpdates(code, s);
        break;
      }

      case 'nextQuestion': {
        const { roundIndex, questionIndex } = msg;
        s.currentRound = roundIndex;
        s.currentQ     = questionIndex;
        s.revealedQuestion = false;
        s.optionsRevealed  = 0;
        s.answerRevealed   = false;
        s.timerRunning = false;
        broadcastParticipantUpdates(code, s);
        break;
      }

      case 'kickParticipant': {
        const { participantId } = msg;
        s.participants.delete(participantId);
        // Close their WS connection if open
        wsClients.get(code)?.forEach(c => {
          if (c._mqePid === participantId) c.close(1000, 'Removed by moderator');
        });
        broadcast(code, { type: 'participantList', participants: participantList(s) });
        break;
      }
    }
  }

  // Participants can send answers via WS (alternative to HTTP POST)
  if (role === 'participant' && msg.type === 'submitAnswer') {
    const { roundIndex, questionIndex, optionIndex } = msg;
    const qKey = `${roundIndex}:${questionIndex}`;
    if (s.scoredQuestions.has(qKey)) return; // too late
    const aKey = `${qKey}:${pid}`;
    s.answers.set(aKey, { optionIndex, submittedAt: Date.now() });
    const p = s.participants.get(pid);
    broadcast(code, {
      type: 'answerReceived',
      participantId: pid, participantName: p?.name || '',
      roundIndex, questionIndex, optionIndex,
      answeredCount: countAnswered(s, roundIndex, questionIndex),
      totalParticipants: s.participants.size,
    });
    // Confirm back to participant
    ws.send(JSON.stringify({ type: 'answerConfirmed', roundIndex, questionIndex, optionIndex }));
  }
}

// ─────────────────────────────────────────────
// SCORING
// ─────────────────────────────────────────────
function scoreQuestion(s, ri, qi) {
  const qKey = `${ri}:${qi}`;
  if (s.scoredQuestions.has(qKey)) return; // already scored

  const round = s.quiz.rounds[ri];
  if (!round) return;
  const qq = round.questions[qi];
  if (!qq) return;

  const correctPts = s.quiz.scores?.correct ?? 10;
  const wrongPts   = s.quiz.scores?.wrong   ?? 0;

  for (const [pid, p] of s.participants) {
    const aKey = `${qKey}:${pid}`;
    const a = s.answers.get(aKey);
    if (a === undefined) continue;
    const isCorrect = a.optionIndex === qq.answer;
    p.score += isCorrect ? correctPts : wrongPts;

    
  }

  s.scoredQuestions.add(qKey);
  console.log(`[SCORE] Session ${s.code} R${ri}Q${qi} scored`);
}

// ─────────────────────────────────────────────
// STATE BUILDERS
// ─────────────────────────────────────────────
function buildModeratorState(s) {
  return {
    code:          s.code,
    status:        s.status,
    mode:          s.mode,
    currentRound:  s.currentRound,
    currentQ:      s.currentQ,
    timerValue:    s.timerValue,
    participants:  participantList(s),
    answerSummary: buildAnswerSummary(s),
    leaderboard:   buildLeaderboard(s),
  };
}

function buildParticipantState(s, pid) {
  const round = s.quiz.rounds[s.currentRound];
  const qq    = round?.questions[s.currentQ];
  const myAnswer = pid ? s.answers.get(`${s.currentRound}:${s.currentQ}:${pid}`) : null;
  const p = pid ? s.participants.get(pid) : null;

  return {
    type:              'quizState',
    status:            s.status,
    quizTitle:         s.quizTitle,
    mode:              s.mode,
    currentRound:      s.currentRound,
    roundName:         round?.name || '',
    currentQ:          s.currentQ,
    totalQuestions:    round?.questions.length || 0,
    question:          s.revealedQuestion ? (qq?.question || '') : null,
    options:           s.optionsRevealed > 0 ? (qq?.options?.slice(0, s.optionsRevealed) || []) : [],
    optionsRevealed:   s.optionsRevealed,
    answerRevealed:    s.answerRevealed,
    correctAnswer:     s.answerRevealed ? (qq?.answer ?? null) : null,
    timerValue:        s.timerValue,
    timerRunning:      s.timerRunning,
    myAnswer:          myAnswer?.optionIndex ?? null,
    myScore:           p?.score || 0,
    leaderboard:       s.answerRevealed ? buildLeaderboard(s).slice(0, 5) : null,
    projectorView:     s.projectorView,
  };
}

function participantList(s) {
  return [...s.participants.values()].map(p => ({
    id: p.id, name: p.name, team: p.team, score: p.score, connected: p.connected,
  }));
}

function buildAnswerSummary(s) {
  // For each option: how many participants chose it for current question
  const round = s.quiz.rounds[s.currentRound];
  const qq    = round?.questions[s.currentQ];
  if (!qq) return [];
  const counts = [0, 0, 0, 0];
  for (const [pid] of s.participants) {
    const a = s.answers.get(`${s.currentRound}:${s.currentQ}:${pid}`);
    if (a !== undefined && a.optionIndex >= 0 && a.optionIndex <= 3) counts[a.optionIndex]++;
  }
  return counts.map((c, i) => ({
    option: 'ABCD'[i], text: qq.options[i] || '', count: c,
    isCorrect: i === qq.answer,
  }));
}

function buildLeaderboard(s) {
  return [...s.participants.values()]
    .map(p => ({ id: p.id, name: p.name, team: p.team, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function countAnswered(s, ri, qi) {
  let n = 0;
  for (const [pid] of s.participants) {
    if (s.answers.has(`${ri}:${qi}:${pid}`)) n++;
  }
  return n;
}

// ─────────────────────────────────────────────
// BROADCAST HELPERS
// ─────────────────────────────────────────────
function broadcast(code, msg) {
  const clients = wsClients.get(code);
  if (!clients) return;
  const data = JSON.stringify(msg);
  clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}

function broadcastToRole(code, role, msg) {
  const clients = wsClients.get(code);
  if (!clients) return;
  const data = JSON.stringify(msg);
  clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN && ws._mqeRole === role) ws.send(data);
  });
}

function broadcastParticipantUpdates(code, s) {
  const clients = wsClients.get(code);
  if (!clients) return;
  clients.forEach(ws => {
    if (ws.readyState !== WebSocket.OPEN || ws._mqeRole !== 'participant') return;
    ws.send(JSON.stringify(buildParticipantState(s, ws._mqePid)));
  });
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (sessions.has(code));
  return code;
}

function buildJoinUrl(req, code) {
  // Use env var if set (production domain), else derive from request
  if (process.env.BASE_URL) return `${process.env.BASE_URL}/join/${code}`;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host  = req.headers['x-forwarded-host']  || req.headers.host || 'localhost:3000';
  return `${proto}://${host}/join/${code}`;
}

// Clean up old finished sessions every hour
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000; // 6h
  for (const [code, s] of sessions) {
    if (s.status === 'finished' && s.createdAt < cutoff) {
      sessions.delete(code);
      wsClients.delete(code);
      console.log(`[GC] Session ${code} removed`);
    }
  }
}, 60 * 60 * 1000);

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   MORBISE SERVER  —  listening :${PORT}   ║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`   REST   → http://localhost:${PORT}/api`);
  console.log(`   WS     → ws://localhost:${PORT}/live`);
  console.log(`   Join   → http://localhost:${PORT}/join/:code`);
  console.log(`   Health → http://localhost:${PORT}/health\n`);
});
