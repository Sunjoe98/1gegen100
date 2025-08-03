// 1 gegen 100 – Backend (Express + Socket.IO)
// Features:
// - Antworten änderbar bis Fragenende (kein Lock beim 1. Klick)
// - Eliminierte erhalten keine neuen Fragen (Room 'alive')
// - Live-Stats (alive/total) für alle Clients
// - Präsentationsseite: sequentielle Elimination (rot-puls -> permanent rot)
// - Zufällige Fragen, nie doppelt (asked.json persistent)
// - Spieler bekommen anonyme Nummer (player.number) und sehen ihre eigene

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*", methods: ["GET","POST"] } });

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const ASKED_FILE     = path.join(__dirname, 'asked.json');

app.use(cors());
app.use(express.json());

// Statische Auslieferung (u. a. /questions.json und /asked.json)
app.use(express.static(path.join(__dirname)));

// ---- State
let players = []; // {sid,name,number,alive,lastAnswer}
let nextPlayerNumber = 1;
let registrationOpen = true;
let gameActive = false;
let currentQuestion = null;
let questions = [];     // {id,text,answers[3],correct}
let askedIds = new Set();

// ---- Helpers
function loadQuestions() {
  if (!fs.existsSync(QUESTIONS_FILE)) {
    console.error('questions.json fehlt.');
    questions = [];
    return;
  }
  const raw = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  questions = raw.map((q, idx) => ({
    id: q.id ?? idx,
    text: q.text,
    answers: q.answers,
    correct: q.correct
  })).filter(q =>
    q && q.text && Array.isArray(q.answers) &&
    q.answers.length === 3 && q.answers.includes(q.correct)
  );
  console.log('Fragen geladen:', questions.length);
}
function loadAsked() {
  if (fs.existsSync(ASKED_FILE)) {
    try { askedIds = new Set(JSON.parse(fs.readFileSync(ASKED_FILE,'utf8'))); }
    catch { askedIds = new Set(); }
  } else {
    fs.writeFileSync(ASKED_FILE, JSON.stringify([]), 'utf8');
    askedIds = new Set();
  }
  console.log('Schon gestellt:', askedIds.size);
}
function persistAsked() {
  try { fs.writeFileSync(ASKED_FILE, JSON.stringify([...askedIds]), 'utf8'); }
  catch(e){ console.error('asked.json write fail:', e.message); }
}
function pickNextQuestion() {
  const pool = questions.filter(q => !askedIds.has(q.id));
  if (!pool.length) return null;
  const q = pool[Math.floor(Math.random()*pool.length)];
  askedIds.add(q.id); persistAsked();
  return q;
}
function stats() {
  const alive = players.filter(p=>p.alive).length;
  return { alive, total: players.length, gameActive, registrationOpen };
}
function broadcastStats() { io.emit('stats', stats()); }
function publicPlayers() {
  // nur anonyme Infos für Frontend/Präsentation
  return players.map(p => ({ number: p.number, alive: p.alive, lastAnswer: p.lastAnswer }));
}
function emitPlayers() { io.emit('updatePlayers', publicPlayers()); }

// ---- Health
app.get('/', (_,res)=>res.send('1 gegen 100 Backend läuft.'));

// ---- Sockets
io.on('connection', (socket) => {
  const sid = socket.id;
  console.log('Verbunden:', sid);

  // Spieler beitreten
  socket.on('joinGame', (name) => {
    if (!registrationOpen) {
      socket.emit('joinRejected', 'Registrierung ist geschlossen.');
      return;
    }
    const exists = players.find(p=>p.sid===sid);
    if (exists) {
      socket.emit('youAre', { number: exists.number });
      return;
    }
    const player = {
      sid,
      name: String(name || 'Spieler'),
      number: nextPlayerNumber++,
      alive: true,
      lastAnswer: null
    };
    players.push(player);

    socket.join('alive');                 // nur Lebende erhalten neue Fragen
    socket.emit('youAre', { number: player.number }); // eigene Nummer anzeigen

    emitPlayers();
    broadcastStats();
  });

  // Admin: Registrierung schließen (Spielstart)
  socket.on('startGame', () => {
    registrationOpen = false;
    io.emit('registrationClosed');
    broadcastStats();
  });

  // Admin: Registrierung öffnen (neue Lobby)
  socket.on('openRegistration', () => {
    registrationOpen = true;
    io.emit('registrationOpened');
    broadcastStats();
  });

  // Admin: nächste Frage (zufällig, nie doppelt)
  socket.on('nextQuestion', () => {
    const q = pickNextQuestion();
    if (!q) { io.emit('noQuestionsLeft'); return; }
    currentQuestion = q;
    gameActive = true;

    // Antworten nur für Lebende zurücksetzen
    players.forEach(p => { if (p.alive) p.lastAnswer = null; });

    emitPlayers();
    broadcastStats();

    const payload = { id: q.id, text: q.text, answers: q.answers };
    io.to('alive').emit('newQuestion', payload); // nur Lebende sehen Frage
    io.emit('displayQuestion', payload);         // für Admin/Display
  });

  // Spieler: Antwort (änderbar bis gesperrt)
  socket.on('answer', (answer) => {
    if (!gameActive || !currentQuestion) return;
    const p = players.find(p=>p.sid===sid);
    if (!p || !p.alive) return; // eliminierte ignorieren
    if (!currentQuestion.answers.includes(answer)) return;

    p.lastAnswer = answer;
    socket.emit('answerAck', answer); // Feedback an diesen Spieler
    emitPlayers();                    // Admin/Präsentation sehen anonymen Stand
  });

  // Admin: Frage beenden -> sperren & eliminieren
  socket.on('endQuestion', () => {
    if (!currentQuestion) return;
    const correct = currentQuestion.correct;

    // Lock-Info an Clients
    io.emit('questionLocked', { correct });

    // Eliminierte bestimmen (keine oder falsche Antwort)
    const eliminated = [];
    players.forEach(p => {
      if (!p.alive) return;
      if (p.lastAnswer === null || p.lastAnswer !== correct) {
        p.alive = false;
        eliminated.push(p.number);
      }
    });

    // Aus Room 'alive' entfernen (bekommen keine neue Frage mehr)
    eliminated.forEach(num => {
      const pl = players.find(pp=>pp.number===num);
      if (pl) io.sockets.sockets.get(pl.sid)?.leave('alive');
    });

    gameActive = false;

    // Präsentation: sequentielle Elimination (eine Nummer nach der anderen)
    io.emit('eliminationSequence', { eliminatedNumbers: eliminated, correct });

    // Ergebnis
    io.emit('questionEnded', { correct });
    emitPlayers();
    broadcastStats();
  });

  // Disconnect
  socket.on('disconnect', () => {
    const before = players.length;
    players = players.filter(p=>p.sid!==sid);
    if (players.length !== before) {
      emitPlayers();
      broadcastStats();
    }
  });
});

// ---- Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  loadQuestions();
  loadAsked();
  console.log('Server läuft auf Port', PORT);
});
