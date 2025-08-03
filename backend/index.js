// 1 gegen 100 – Backend (Express + Socket.IO)
// Themenmodus + Solo-Spieler (kein Zeitlimit):
// - 15 Topics, Fragen haben { topic, ... }; asked.json verhindert Wiederholung
// - Admin setzt Solo-Spieler einmalig (fix)
// - Zwei zufällige Themen werden angeboten; Solo wählt; Admin bestätigt
// - Frage aus gewähltem Thema; Mob (alle außer Solo) 10s Antwortfenster
// - Solo ohne Zeitlimit; Admin speichert Solo-Antwort; dann Auflösung + Show
// - Danach zurück zur Frageansicht mit richtig/falsch

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
app.use(express.static(path.join(__dirname)));

const TOPICS = [
  "Musik","Film & TV","Sport","Geschichte","Geografie",
  "Wissenschaft","Technik & IT","Literatur","Kunst","Popkultur",
  "Natur & Tiere","Politik","Wirtschaft","Alltagswissen","Spiele & Comics"
];

// ---- State
let players = []; // {sid,name,number,alive,lastAnswer}
let nextPlayerNumber = 1;
let registrationOpen = true;

let soloNumber = null;         // fix definierter Einzelspieler (Spielernummer)
let gamePhase = "lobby";       // lobby | topicOffer | question | reveal | show
let currentQuestion = null;
let questions = [];            // {id, topic, text, answers[3], correct}
let askedIds = new Set();

let offeredTopics = [];        // aktuell angebotene 2 Themen
let chosenTopic = null;        // vom Solo gewähltes Thema
let mobAnsweringOpen = false;  // 10s Fenster für Mob
let soloAnswer = null;         // vom Admin gespeicherte Solo-Antwort

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
    topic: q.topic,
    text: q.text,
    answers: q.answers,
    correct: q.correct
  })).filter(q =>
    q && TOPICS.includes(q.topic) &&
    q.text && Array.isArray(q.answers) && q.answers.length===3 &&
    q.answers.includes(q.correct)
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
function pickNextQuestionByTopic(topic) {
  const pool = questions.filter(q => q.topic===topic && !askedIds.has(q.id));
  if (!pool.length) return null;
  const q = pool[Math.floor(Math.random()*pool.length)];
  askedIds.add(q.id); persistAsked();
  return q;
}
function stats() {
  const alive = players.filter(p=>p.alive).length;
  return {
    alive, total: players.length,
    registrationOpen,
    gamePhase, soloNumber, chosenTopic
  };
}
function broadcastStats() { io.emit('stats', stats()); }
function publicPlayers() {
  return players.map(p => ({ number: p.number, alive: p.alive, lastAnswer: p.lastAnswer }));
}
function emitPlayers() { io.emit('updatePlayers', publicPlayers()); }
function getSoloPlayer() { return players.find(p=>p.number===soloNumber); }

// ---- HTTP
app.get('/', (_,res)=>res.send('1 gegen 100 Backend läuft (Themenmodus).'));

// ---- Sockets
io.on('connection', (socket) => {
  const sid = socket.id;

  // Spieler beitreten
  socket.on('joinGame', (name) => {
    if (!registrationOpen) {
      socket.emit('joinRejected', 'Registrierung ist geschlossen. Spiel läuft.');
      return;
    }
    const exists = players.find(p=>p.sid===sid);
    if (exists) { socket.emit('youAre', { number: exists.number }); return; }

    const player = {
      sid,
      name: String(name || 'Spieler'),
      number: nextPlayerNumber++,
      alive: true,
      lastAnswer: null
    };
    players.push(player);
    socket.join('alive');
    socket.emit('youAre', { number: player.number });

    emitPlayers();
    broadcastStats();
  });

  // Admin: Solo-Spieler fix setzen (nur einmal sinnvoll)
  socket.on('setSoloPlayer', (number) => {
    const n = Number(number);
    if (!players.find(p=>p.number===n)) { socket.emit('adminError','Spielernummer existiert nicht.'); return; }
    soloNumber = n;
    io.emit('soloSet', { soloNumber });
    broadcastStats();
  });

  // Admin: Registrierung schließen / öffnen
  socket.on('startGame', () => {
    registrationOpen = false;
    gamePhase = 'topicOffer';
    offeredTopics = [];
    chosenTopic = null;
    currentQuestion = null;
    soloAnswer = null;
    io.emit('registrationClosed');
    io.emit('phaseChanged', { gamePhase });
    broadcastStats();
  });
  socket.on('openRegistration', () => {
    registrationOpen = true;
    gamePhase = 'lobby';
    offeredTopics = [];
    chosenTopic = null;
    currentQuestion = null;
    soloAnswer = null;
    // Reset Spieler (optional beibehalten – hier behalten wir)
    io.emit('registrationOpened');
    io.emit('phaseChanged', { gamePhase });
    broadcastStats();
  });

  // Admin: zwei zufällige Themen anbieten
  socket.on('offerTopics', () => {
    if (gamePhase!=='topicOffer') gamePhase='topicOffer';
    // 2 zufällige, unterschiedliche
    const shuffled = TOPICS.slice().sort(()=>Math.random()-0.5);
    offeredTopics = shuffled.slice(0,2);
    chosenTopic = null;
    io.emit('topicOffered', { options: offeredTopics });
    io.emit('phaseChanged', { gamePhase });
    broadcastStats();
  });

  // Solo (oder Admin stellvertretend): Thema auswählen
  socket.on('chooseTopic', (topic) => {
    if (!offeredTopics.includes(topic)) return;
    chosenTopic = topic;
    io.emit('topicChosen', { chosenTopic });
    broadcastStats();
  });

  // Admin: Thema bestätigen und Frage starten
  socket.on('startQuestionWithTopic', () => {
    if (!chosenTopic) { socket.emit('adminError','Kein Thema gewählt.'); return; }
    const q = pickNextQuestionByTopic(chosenTopic);
    if (!q) { io.emit('noQuestionsLeftForTopic', { topic: chosenTopic }); return; }

    currentQuestion = q;
    gamePhase = 'question';
    soloAnswer = null;

    // Reset Antworten nur für Lebende
    players.forEach(p => { if (p.alive) p.lastAnswer = null; });

    emitPlayers();
    io.emit('displayQuestion', { id: q.id, topic: q.topic, text: q.text, answers: q.answers });
    io.to('alive').emit('newQuestion', { id: q.id, topic: q.topic, text: q.text, answers: q.answers });

    // Mob-10s Fenster öffnen
    mobAnsweringOpen = true;
    io.emit('mobTimerStart', { seconds: 10 });
    setTimeout(() => {
      mobAnsweringOpen = false;
      io.emit('mobTimerEnd');
    }, 10000);

    io.emit('phaseChanged', { gamePhase });
    broadcastStats();
  });

  // Spieler (Mob): Antwort (nur wenn Fenster offen & Spieler nicht Solo & alive)
  socket.on('answer', (answer) => {
    if (gamePhase!=='question' || !currentQuestion) return;
    const p = players.find(p=>p.sid===sid);
    if (!p || !p.alive) return;
    if (p.number===soloNumber) return; // Solo nicht hier
    if (!mobAnsweringOpen) return;
    if (!currentQuestion.answers.includes(answer)) return;
    p.lastAnswer = answer;
    socket.emit('answerAck', answer);
    emitPlayers();
  });

// Admin: Solo-Antwort manuell speichern (kein Zeitlimit, bis Auflösung änderbar)
socket.on('setSoloAnswer', ({ index, answer }) => {
  if (!currentQuestion) return;
  if (index == null || !currentQuestion.answers[index]) return;
  if (currentQuestion.answers[index] !== answer) return; // Konsistenz
  soloAnswer = answer;
  io.emit('soloAnswerSet', { index, answer }); // Präsentation markiert "eingeloggt"
});

  // Admin: Auflösen -> Bewertung + Eliminationsliste
  socket.on('revealAndEliminate', () => {
    if (!currentQuestion) return;
    const correct = currentQuestion.correct;

    // Frage sperren
    io.emit('questionLocked', { correct });

    // Ermitteln, wer raus ist (Mob + ggf. Solo)
    const eliminated = [];
    players.forEach(p => {
      if (!p.alive) return;
      // Solo wird separat bewertet: wenn soloAnswer gesetzt und falsch -> raus
      if (p.number === soloNumber) {
        if (soloAnswer && soloAnswer !== correct) {
          p.alive = false;
          eliminated.push({ number: p.number, sid: p.sid });
        }
        return;
      }
      // Mob: wenn keine oder falsche Antwort -> raus
      if (p.lastAnswer === null || p.lastAnswer !== correct) {
        p.alive = false;
        eliminated.push({ number: p.number, sid: p.sid });
      }
    });

    // aus Room 'alive' entfernen & individuelle Nachricht
    eliminated.forEach(({sid}) => {
      io.sockets.sockets.get(sid)?.leave('alive');
      io.to(sid).emit('youAreOut');
    });

    // Show
    gamePhase = 'show';
    const order = eliminated.map(e => e.number).sort(()=>Math.random()-0.5);
    io.emit('eliminationSequence', { eliminatedNumbers: order, correct });
    io.emit('phaseChanged', { gamePhase });
    emitPlayers();
    broadcastStats();
  });

  // Admin: Zurück zur Frageansicht mit Ergebnisbanner
  socket.on('backToQuestionView', () => {
    if (!currentQuestion) return;
    gamePhase = 'reveal';
    io.emit('questionEnded', { correct: currentQuestion.correct, soloAnswer });
    io.emit('phaseChanged', { gamePhase });
    broadcastStats();
  });

  // Admin: Nächste Themenrunde (zurück zur Auswahl)
  socket.on('nextRound', () => {
    currentQuestion = null;
    chosenTopic = null;
    offeredTopics = [];
    soloAnswer = null;
    gamePhase = 'topicOffer';
    io.emit('phaseChanged', { gamePhase });
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
