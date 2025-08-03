// 1 gegen 100 – Backend (Express + Socket.IO)
// Features:
// - Registrierung kann gesperrt/geöffnet werden
// - Zufällige Fragen; keine Wiederholung dank asked.json (persistente IDs)
// - Spieler sehen ihre eingeloggt Antwort (lastAnswer)
// - Admin steuert Start/Ende/Nächste Frage; keine Auswahl mehr nötig
// - Statische Auslieferung von questions.json / asked.json

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// ---- Pfade/Dateien
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const ASKED_FILE = path.join(__dirname, 'asked.json');

// ---- State
let players = [];                 // {id, name, alive: true, lastAnswer: null}
let gameActive = false;
let registrationOpen = true;
let currentQuestion = null;
let questions = [];               // [{id, text, answers:[A,B,C], correct}]
let askedIds = new Set();         // persistente IDs der schon gestellten Fragen

// ---- Middleware
app.use(cors());
app.use(express.json());

// Statische Dateien ausliefern (damit /questions.json & /asked.json abrufbar sind)
app.use(express.static(path.join(__dirname)));

// ---- Helper
function loadQuestions() {
  if (!fs.existsSync(QUESTIONS_FILE)) {
    console.error('questions.json fehlt. Bitte anlegen.');
    questions = [];
    return;
  }
  const data = fs.readFileSync(QUESTIONS_FILE, 'utf8');
  const raw = JSON.parse(data);
  questions = raw.map((q, idx) => ({
    id: q.id ?? idx,     // falls id fehlt, Index als id
    text: q.text,
    answers: q.answers,
    correct: q.correct
  }));
  // einfache Validierung
  questions = questions.filter(q =>
    q && q.text && Array.isArray(q.answers) &&
    q.answers.length === 3 && q.answers.includes(q.correct)
  );
  console.log(`Fragen geladen: ${questions.length}`);
}

function loadAsked() {
  if (fs.existsSync(ASKED_FILE)) {
    try {
      askedIds = new Set(JSON.parse(fs.readFileSync(ASKED_FILE, 'utf8')));
    } catch {
      askedIds = new Set();
    }
  } else {
    askedIds = new Set();
    fs.writeFileSync(ASKED_FILE, JSON.stringify([]), 'utf8');
  }
  console.log(`Bereits gestellte Fragen (persistiert): ${askedIds.size}`);
}

function persistAsked() {
  try {
    fs.writeFileSync(ASKED_FILE, JSON.stringify([...askedIds]), 'utf8');
  } catch (e) {
    console.error('asked.json konnte nicht geschrieben werden:', e.message);
  }
}

function pickNextQuestion() {
  const available = questions.filter(q => !askedIds.has(q.id));
  if (available.length === 0) return null;
  const q = available[Math.floor(Math.random() * available.length)];
  askedIds.add(q.id);
  persistAsked();
  return q;
}

// ---- Health
app.get('/', (req, res) => {
  res.send('1 gegen 100 Backend läuft.');
});

// ---- (Optional) Reset-Endpoint (nur manuell nutzen, z. B. via curl)
// ACHTUNG: setzt asked.json zurück!
// app.post('/admin/reset-asked', (req, res) => {
//   askedIds = new Set();
//   persistAsked();
//   res.json({ ok: true, askedCount: askedIds.size });
// });

// ---- Socket.IO
io.on('connection', (socket) => {
  console.log('Verbunden:', socket.id);

  // Spieler versucht beizutreten
  socket.on('joinGame', (name) => {
    if (!registrationOpen) {
      socket.emit('joinRejected', 'Registrierung ist geschlossen.');
      return;
    }
    if (!players.find(p => p.id === socket.id)) {
      players.push({
        id: socket.id,
        name: String(name || 'Spieler'),
        alive: true,
        lastAnswer: null
      });
      io.emit('updatePlayers', players);
    }
  });

  // Admin: Registrierung schließen (Spielstart)
  socket.on('startGame', () => {
    registrationOpen = false;
    io.emit('registrationClosed');
  });

  // Admin: Registrierung wieder öffnen (neues Spiel/Lobby)
  socket.on('openRegistration', () => {
    registrationOpen = true;
    io.emit('registrationOpened');
  });

  // Admin: nächste zufällige Frage
  socket.on('nextQuestion', () => {
    currentQuestion = pickNextQuestion();
    if (!currentQuestion) {
      io.emit('noQuestionsLeft');
      return;
    }
    gameActive = true;
    // Pro Runde: letzte Antworten zurücksetzen
    players.forEach(p => p.lastAnswer = null);
    io.emit('updatePlayers', players);

    const { id, text, answers } = currentQuestion;
    io.emit('newQuestion', { id, text, answers }); // korrekt NICHT mitsenden
  });

  // Spieler: antwortet
  socket.on('answer', (answer) => {
    if (!gameActive || !currentQuestion) return;
    const player = players.find(p => p.id === socket.id && p.alive);
    if (!player) return;
    // nur 1. Antwort zählt
    if (player.lastAnswer !== null) return;
    player.lastAnswer = answer;
    io.to(socket.id).emit('answerAck', answer); // Feedback an diesen Spieler
    io.emit('updatePlayers', players);          // Admin/Display updaten
  });

  // Admin: Frage beenden -> falsche fliegen raus
  socket.on('endQuestion', () => {
    if (!currentQuestion) return;
    const correct = currentQuestion.correct;

    players.forEach(p => {
      if (p.alive) {
        if (p.lastAnswer === null) {
          // keine Antwort = raus (optional)
          p.alive = false;
        } else if (p.lastAnswer !== correct) {
          p.alive = false;
        }
      }
    });

    gameActive = false;
    io.emit('questionEnded', { correct });
    io.emit('updatePlayers', players);
  });

  // Verbindung abgebaut
  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', players);
  });
});

// ---- Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  loadQuestions();
  loadAsked();
  console.log(`Server läuft auf Port ${PORT}`);
});
