// 1 gegen 100 – Backend (Express + Socket.IO)
// Themenmodus + Solo-Spieler (kein Zeitlimit) + 2-stufige Auflösung

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
app.use(express.static(path.join(__dirname))); // /questions.json, /asked.json

const TOPICS = [
  "Musik","Film & TV","Sport","Geschichte","Geografie",
  "Wissenschaft","Technik & IT","Literatur","Kunst","Popkultur",
  "Natur & Tiere","Politik","Wirtschaft","Alltagswissen","Spiele & Comics"
];

const MOB_TIMER_SECONDS  = 20;   // Mobilgeräte: 20s Antwortfenster für den Mob
const SOLO_TIMER_SECONDS = 25;   // Einzelkandidat: 25s Lock-In wie in der Show
const REWARD_PER_MOB     = 100;  // Punkte/CHF pro eliminiertem Herausforderer

// ---- State
let players = []; // {sid,name,number,alive,lastAnswer}
let nextPlayerNumber = 1;
let registrationOpen = true;

let soloNumber = null;         // fix definierter Einzelspieler (Spielernummer)
let gamePhase = "lobby";       // lobby | topicOffer | question | show | reveal
let currentQuestion = null;
let questions = [];            // {id, topic, text, answers[3], correct}
let askedIds = new Set();

let offeredTopics = [];        // aktuell angebotene 2 Themen
let chosenTopic = null;        // vom Solo gewähltes Thema
let mobAnsweringOpen = false;  // 10s Fenster für Mob
let mobTimerHandle = null;     // Timeout-Handle für Mob-Fenster
let mobTimerEndsAt = null;     // Zeitstempel, bis wann das Mob-Fenster offen ist
let soloAnswer = null;         // vom Admin gespeicherte Solo-Antwort
let soloTimerHandle = null;
let soloTimerEndsAt = null;
let soloAnsweringOpen = false; // darf der Solo noch antworten?
let soloTimedOut = false;      // Lock-In verpasst

let prizePool = 0;
let lastGain = 0;
let jokerState = { buyUsed: false, doubleUsed: false, doubleActive: false };
let eliminatedAnswers = [];    // Indexe, die der Joker entfernt hat

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
    gamePhase, soloNumber, chosenTopic,
    prizePool, lastGain,
    jokers: jokerState
  };
}
function broadcastStats(target = io) { target.emit('stats', stats()); }
function publicPlayers() {
  return players.map(p => ({ number: p.number, alive: p.alive, lastAnswer: p.lastAnswer }));
}
function emitPlayers(target = io) { target.emit('updatePlayers', publicPlayers()); }

function resetMobTimer() {
  mobAnsweringOpen = false;
  if (mobTimerHandle) {
    clearTimeout(mobTimerHandle);
    mobTimerHandle = null;
  }
  mobTimerEndsAt = null;
}

function resetSoloTimer({ markTimedOut = false } = {}) {
  soloAnsweringOpen = false;
  if (soloTimerHandle) {
    clearTimeout(soloTimerHandle);
    soloTimerHandle = null;
  }
  if (markTimedOut) soloTimedOut = true;
  soloTimerEndsAt = null;
}

function resetJokersForGame() {
  jokerState = { buyUsed: false, doubleUsed: false, doubleActive: false };
  eliminatedAnswers = [];
}

function resetSoloState() {
  soloAnswer = null;
  resetSoloTimer();
  soloTimedOut = false;
}

function resetBank() {
  prizePool = 0;
  lastGain = 0;
}

function resetRoundState() {
  resetMobTimer();
  resetSoloTimer();
  offeredTopics = [];
  chosenTopic = null;
  currentQuestion = null;
  resetSoloState();
  jokerState.doubleActive = false;
  eliminatedAnswers = [];
  lastGain = 0;
}

function setPhase(phase) {
  gamePhase = phase;
  io.emit('phaseChanged', { gamePhase });
}

function currentQuestionPayload() {
  if (!currentQuestion) return null;
  return {
    id: currentQuestion.id,
    topic: currentQuestion.topic,
    text: currentQuestion.text,
    answers: currentQuestion.answers
  };
}

function emitBank(target = io) {
  target.emit('bankUpdate', { prizePool, lastGain });
}

function emitJokers(target = io) {
  target.emit('jokerUpdate', { ...jokerState });
}

function emitEliminatedAnswers(target = io) {
  if (eliminatedAnswers.length) {
    target.emit('eliminatedAnswers', { indices: eliminatedAnswers });
  }
}

function syncSocket(socket) {
  broadcastStats(socket);
  emitPlayers(socket);
  emitBank(socket);
  emitJokers(socket);
  socket.emit('phaseChanged', { gamePhase });
  if (soloNumber != null) socket.emit('soloSet', { soloNumber });
  if (offeredTopics.length) socket.emit('topicOffered', { options: offeredTopics });
  if (chosenTopic) socket.emit('topicChosen', { chosenTopic });
  const payload = currentQuestionPayload();
  if (payload) {
    socket.emit('displayQuestion', payload);
    emitEliminatedAnswers(socket);
    if (mobAnsweringOpen) {
      const remainingMs = mobTimerEndsAt ? mobTimerEndsAt - Date.now() : 0;
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
      if (remainingSec > 0) {
        socket.emit('mobTimerStart', { seconds: remainingSec });
      } else {
        mobAnsweringOpen = false;
        socket.emit('questionLocked');
      }
    } else {
      socket.emit('questionLocked');
    }
    if (soloTimerEndsAt) {
      const remainingMs = soloTimerEndsAt - Date.now();
      const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
      if (remainingSec > 0 && soloAnsweringOpen) {
        socket.emit('soloTimerStart', { seconds: remainingSec });
      } else {
        socket.emit('soloTimerEnd');
      }
    }
    if (soloAnswer) {
      const index = currentQuestion.answers.findIndex(a => a === soloAnswer);
      if (index >= 0) socket.emit('soloAnswerSet', { index, answer: soloAnswer });
    }
  }
}

function startSoloTimer() {
  soloAnsweringOpen = true;
  soloTimedOut = false;
  soloTimerEndsAt = Date.now() + SOLO_TIMER_SECONDS * 1000;
  io.emit('soloTimerStart', { seconds: SOLO_TIMER_SECONDS });
  soloTimerHandle = setTimeout(() => {
    soloTimerHandle = null;
    resetSoloTimer({ markTimedOut: true });
    io.emit('soloTimerEnd');
  }, SOLO_TIMER_SECONDS * 1000);
}

// ---- HTTP
app.get('/', (_,res)=>res.send('1 gegen 100 Backend läuft (Themenmodus).'));

// ---- Sockets
io.on('connection', (socket) => {
  const sid = socket.id;

  syncSocket(socket);

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
      name: String(name || 'Spieler').trim().slice(0, 32) || 'Spieler',
      number: nextPlayerNumber++,
      alive: true,
      lastAnswer: null
    };
    players.push(player);
    socket.join('alive');
    socket.emit('youAre', { number: player.number });
    if (currentQuestion) {
      socket.emit('newQuestion', currentQuestionPayload());
      if (mobAnsweringOpen) {
        const remainingMs = mobTimerEndsAt ? mobTimerEndsAt - Date.now() : 0;
        const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
        if (remainingSec > 0) socket.emit('mobTimerStart', { seconds: remainingSec });
      }
      if (!mobAnsweringOpen) socket.emit('questionLocked');
    }

    emitPlayers(); broadcastStats();
  });

  // Admin: Solo-Spieler fix setzen (einmalig sinnvoll)
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
    resetRoundState();
    resetBank();
    resetJokersForGame();
    io.emit('registrationClosed');
    setPhase('topicOffer');
    broadcastStats();
    emitBank(); emitJokers();
  });
  socket.on('openRegistration', () => {
    registrationOpen = true;
    resetRoundState();
    resetBank();
    resetJokersForGame();
    io.emit('registrationOpened');
    setPhase('lobby');
    broadcastStats();
    emitBank(); emitJokers();
  });

  // Admin: zwei zufällige Themen anbieten
  socket.on('offerTopics', () => {
    if (gamePhase!=='topicOffer') setPhase('topicOffer');
    const shuffled = TOPICS.slice().sort(()=>Math.random()-0.5);
    offeredTopics = shuffled.slice(0,2);
    chosenTopic = null;
    io.emit('topicOffered', { options: offeredTopics });
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
    resetSoloState();
    setPhase('question');
    resetMobTimer();

    // Reset Antworten nur für Lebende
    players.forEach(p => { if (p.alive) p.lastAnswer = null; });

    emitPlayers();
    const payload = currentQuestionPayload();
    io.emit('displayQuestion', payload);
    io.to('alive').emit('newQuestion', payload);
    emitEliminatedAnswers();

    // Mob-10s Fenster öffnen
    mobAnsweringOpen = true;
    mobTimerEndsAt = Date.now() + MOB_TIMER_SECONDS * 1000;
    io.emit('mobTimerStart', { seconds: MOB_TIMER_SECONDS });
    mobTimerHandle = setTimeout(() => {
      mobAnsweringOpen = false;
      mobTimerHandle = null;
      mobTimerEndsAt = null;
      io.emit('mobTimerEnd');
      io.emit('questionLocked');
    }, MOB_TIMER_SECONDS * 1000);

    // Solo-Timer (Lock-In)
    startSoloTimer();

    broadcastStats();
  });

  // Admin: Joker "Antwort kaufen" (eliminiert eine falsche Option, halbiert Bank)
  socket.on('useBuyAnswer', () => {
    if (!currentQuestion) { socket.emit('adminError','Keine Frage aktiv.'); return; }
    if (jokerState.buyUsed) { socket.emit('adminError','Antwort-kaufen-Joker ist schon weg.'); return; }
    const wrongIndexes = currentQuestion.answers
      .map((a, i) => ({ a, i }))
      .filter(({ a, i }) => a !== currentQuestion.correct && !eliminatedAnswers.includes(i));
    if (!wrongIndexes.length) { socket.emit('adminError','Keine falsche Antwort mehr übrig.'); return; }
    const choice = wrongIndexes[Math.floor(Math.random() * wrongIndexes.length)];
    eliminatedAnswers.push(choice.i);
    jokerState.buyUsed = true;
    const before = prizePool;
    prizePool = Math.floor(prizePool / 2);
    lastGain = prizePool - before;
    emitEliminatedAnswers();
    emitBank();
    emitJokers();
  });

  // Admin: Doppel-Joker (nur einmal pro Spiel, gilt für aktuelle Frage)
  socket.on('activateDoubleJoker', () => {
    if (!currentQuestion) { socket.emit('adminError','Keine Frage aktiv.'); return; }
    if (jokerState.doubleUsed) { socket.emit('adminError','Doppel-Joker ist bereits verbraucht.'); return; }
    jokerState.doubleActive = true;
    emitJokers();
  });

  // Spieler (Mob): Antwort (nur wenn Fenster offen & Spieler nicht Solo & alive)
  socket.on('answer', (answer) => {
    if (gamePhase!=='question' || !currentQuestion) return;
    const p = players.find(p=>p.sid===sid);
    if (!p || !p.alive) return;
    if (p.number===soloNumber) return; // Solo nicht hier
    if (!mobAnsweringOpen) return;
    if (!currentQuestion.answers.includes(answer)) return;
    const idx = currentQuestion.answers.findIndex(a => a === answer);
    if (eliminatedAnswers.includes(idx)) return;
    p.lastAnswer = answer;
    socket.emit('answerAck', answer);
    emitPlayers();
  });

  // Admin: Solo-Antwort manuell speichern (kein Zeitlimit, bis Auflösung änderbar)
  socket.on('setSoloAnswer', ({ index, answer }) => {
    if (!currentQuestion) return;
    if (index == null || !currentQuestion.answers[index]) return;
    if (currentQuestion.answers[index] !== answer) return; // Konsistenz
    if (!soloAnsweringOpen && soloTimedOut) { socket.emit('adminError','Solo-Zeit ist abgelaufen.'); return; }
    soloAnswer = answer;
    resetSoloTimer();
    io.emit('soloTimerEnd');
    io.emit('soloAnswerSet', { index, answer }); // Präsentation: eingeloggt markieren
  });

  // Admin: Auflösen -> nur Eliminationsliste & Show (ohne richtige Antwort zu verraten)
  socket.on('revealAndEliminate', () => {
    if (!currentQuestion) return;
    const correct = currentQuestion.correct;

    if (!soloAnswer && soloAnsweringOpen) {
      socket.emit('adminError','Solo muss noch locken oder Zeit auslaufen.');
      return;
    }

    const soloCorrect = !soloTimedOut && soloAnswer === correct;
    const eliminated = [];

    players.forEach(p => {
      if (!p.alive) return;
      if (p.number === soloNumber) {
        if (!soloCorrect) {
          p.alive = false;
          eliminated.push({ number: p.number, sid: p.sid });
        }
        return;
      }
      if (!soloCorrect) return; // Mob bleibt, wenn Solo falsch liegt
      if (p.lastAnswer === null || p.lastAnswer !== correct) {
        p.alive = false;
        eliminated.push({ number: p.number, sid: p.sid });
      }
    });

    eliminated.forEach(({sid}) => {
      io.sockets.sockets.get(sid)?.leave('alive');
      io.to(sid).emit('youAreOut');
    });

    const previousPool = prizePool;
    let gained = 0;
    if (soloCorrect) {
      gained = eliminated.filter(e => e.number !== soloNumber).length * REWARD_PER_MOB;
      if (jokerState.doubleActive) gained *= 2;
      prizePool += gained;
      lastGain = gained;
    } else if (jokerState.doubleActive && prizePool > 0) {
      prizePool = Math.floor(prizePool / 2);
      lastGain = prizePool - previousPool;
    } else {
      lastGain = 0;
    }

    if (jokerState.doubleActive) {
      jokerState.doubleActive = false;
      jokerState.doubleUsed = true;
    }

    setPhase('show');
    const order = eliminated.map(e => e.number).sort(()=>Math.random()-0.5);
    io.emit('eliminationSequence', { eliminatedNumbers: order }); // korrekt bleibt geheim
    emitPlayers(); broadcastStats(); emitBank(); emitJokers();
  });

  // Admin: richtige Antwort erst jetzt zeigen (grün/rot einfärben)
  socket.on('revealCorrect', () => {
    if (!currentQuestion) return;
    io.emit('revealCorrect', { correct: currentQuestion.correct, soloAnswer });
  });

  // Admin: Zurück zur Frageansicht mit Ergebnisbanner
  socket.on('backToQuestionView', () => {
    if (!currentQuestion) return;
    setPhase('reveal');
    io.emit('questionEnded', { correct: currentQuestion.correct, soloAnswer });
    broadcastStats();
  });

  // Admin: Nächste Themenrunde (zurück zur Auswahl)
  socket.on('nextRound', () => {
    resetRoundState();
    setPhase('topicOffer');
    broadcastStats();
  });

  // Disconnect
  socket.on('disconnect', () => {
    const leavingPlayer = players.find(p=>p.sid===sid);
    const before = players.length;
    players = players.filter(p=>p.sid!==sid);
    if (leavingPlayer && leavingPlayer.number === soloNumber) {
      soloNumber = null;
      io.emit('soloSet', { soloNumber });
    }
    if (players.length !== before) { emitPlayers(); broadcastStats(); }
  });
});

// ---- Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  loadQuestions();
  loadAsked();
  console.log('Server läuft auf Port', PORT);
});
