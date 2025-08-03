const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { cors: { origin: "*" } });

let players = [];
let currentQuestion = null;
let gameActive = false;

app.use(cors());
app.use(express.json());

const path = require('path');
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.send('1 gegen 100 Backend läuft.');
});

io.on('connection', (socket) => {
  console.log('Neuer Spieler/Admin verbunden');

  socket.on('joinGame', (name) => {
    players.push({ id: socket.id, name, alive: true });
    io.emit('updatePlayers', players);
  });

  socket.on('startQuestion', (question) => {
    currentQuestion = question;
    gameActive = true;
    io.emit('newQuestion', currentQuestion);
  });

  socket.on('answer', (answer) => {
    if (!gameActive) return;
    if (answer !== currentQuestion.correct) {
      const player = players.find(p => p.id === socket.id);
      if (player) player.alive = false;
    }
    io.emit('updatePlayers', players);
  });

  socket.on('endQuestion', () => {
    gameActive = false;
    io.emit('questionEnded');
  });

  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    io.emit('updatePlayers', players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
