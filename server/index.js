const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

// In-memory rooms store
const rooms = new Map(); // roomId -> roomObj

function makeRoomId(len = 6) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len).toUpperCase();
}

function generateGrid(size = 30) {
  const grid = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) row.push({ type: 'empty', hp: 0 });
    grid.push(row);
  }
  return grid;
}

function createRoom(hostSocketId, hostName, maxPlayers = 6) {
  const roomId = makeRoomId(6);
  const room = {
    id: roomId,
    host: hostSocketId,
    hostName,
    players: [], // { id: socketId, name, ready }
    maxPlayers,
    state: 'lobby', // 'lobby' | 'in-game'
    grid: null,
    createdAt: Date.now()
  };
  rooms.set(roomId, room);
  return room;
}

function getPublicRoomData(room) {
  return {
    id: room.id,
    host: room.host,
    hostName: room.hostName,
    players: room.players.map(p => ({ id: p.id, name: p.name, ready: p.ready })),
    state: room.state,
    maxPlayers: room.maxPlayers
  };
}

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  // set username (optional) — client can emit after connect
  socket.on('set-username', (name) => {
    socket.data.name = typeof name === 'string' && name.trim() ? name.trim().slice(0, 32) : `Player_${socket.id.slice(0,4)}`;
    socket.emit('username-set', socket.data.name);
  });

  socket.on('create-room', ({ name, maxPlayers }, cb) => {
    const playerName = (name && name.trim()) ? name.trim().slice(0,32) : `Host_${socket.id.slice(0,4)}`;
    const room = createRoom(socket.id, playerName, Math.min(Math.max(2, maxPlayers || 6), 6));

    // add host as player
    room.players.push({ id: socket.id, name: playerName, ready: false });
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.name = playerName;

    // ack callback with room data
    const publicData = getPublicRoomData(room);
    if (cb) cb({ ok: true, room: publicData });
    io.to(room.id).emit('lobby-update', publicData);
  });

  socket.on('join-room', ({ roomId, name }, cb) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) {
      if (cb) cb({ ok: false, error: 'ROOM_NOT_FOUND' });
      return;
    }
    if (room.state !== 'lobby') { if (cb) cb({ ok: false, error: 'GAME_ALREADY_STARTED' }); return; }
    if (room.players.length >= room.maxPlayers) { if (cb) cb({ ok: false, error: 'ROOM_FULL' }); return; }

    const playerName = (name && name.trim()) ? name.trim().slice(0,32) : `Player_${socket.id.slice(0,4)}`;
    room.players.push({ id: socket.id, name: playerName, ready: false });
    socket.join(room.id);
    socket.data.roomId = room.id;
    socket.data.name = playerName;

    const publicData = getPublicRoomData(room);
    if (cb) cb({ ok: true, room: publicData });
    io.to(room.id).emit('lobby-update', publicData);
  });

  socket.on('leave-room', (_, cb) => {
    const rid = socket.data.roomId;
    if (!rid) { if (cb) cb({ ok: false, error: 'NOT_IN_ROOM' }); return; }
    const room = rooms.get(rid);
    if (!room) { if (cb) cb({ ok: false, error: 'ROOM_NOT_FOUND' }); return; }

    room.players = room.players.filter(p => p.id !== socket.id);
    socket.leave(rid);
    delete socket.data.roomId;

    // If host left, transfer host to first player
    if (room.host === socket.id) {
      if (room.players.length > 0) {
        room.host = room.players[0].id;
        room.hostName = room.players[0].name;
      }
    }

    if (room.players.length === 0) {
      rooms.delete(room.id);
    } else {
      io.to(room.id).emit('lobby-update', getPublicRoomData(room));
    }

    if (cb) cb({ ok: true });
  });

  socket.on('toggle-ready', (cb) => {
    const rid = socket.data.roomId;
    if (!rid) { if (cb) cb({ ok: false, error: 'NOT_IN_ROOM' }); return; }
    const room = rooms.get(rid);
    if (!room) { if (cb) cb({ ok: false, error: 'ROOM_NOT_FOUND' }); return; }

    const player = room.players.find(p => p.id === socket.id);
    if (!player) { if (cb) cb({ ok: false, error: 'PLAYER_NOT_IN_ROOM' }); return; }
    player.ready = !player.ready;
    io.to(room.id).emit('lobby-update', getPublicRoomData(room));
    if (cb) cb({ ok: true, ready: player.ready });
  });

  socket.on('start-game', (opts, cb) => {
    const rid = socket.data.roomId;
    if (!rid) { if (cb) cb({ ok: false, error: 'NOT_IN_ROOM' }); return; }
    const room = rooms.get(rid);
    if (!room) { if (cb) cb({ ok: false, error: 'ROOM_NOT_FOUND' }); return; }

    // only host can start
    if (room.host !== socket.id) { if (cb) cb({ ok: false, error: 'NOT_HOST' }); return; }

    // require at least 1 player
    if (room.players.length === 0) { if (cb) cb({ ok: false, error: 'NO_PLAYERS' }); return; }

    // optional: require all ready to start
    // if (!room.players.every(p => p.ready)) { if (cb) cb({ ok: false, error: 'NOT_ALL_READY' }); return; }

    // Change state and create world
    room.state = 'in-game';
    room.grid = generateGrid(30); // default 30x30

    const startPayload = {
      roomId: room.id,
      gridSize: room.grid.length,
      grid: room.grid,
      players: room.players.map(p => ({ id: p.id, name: p.name }))
    };

    io.to(room.id).emit('game-start', startPayload);
    io.to(room.id).emit('lobby-update', getPublicRoomData(room));

    if (cb) cb({ ok: true, started: true });
  });

  socket.on('get-rooms', (cb) => {
    // return public list (small) — good for open matchmaking later
    const list = Array.from(rooms.values()).map(getPublicRoomData);
    if (cb) cb({ ok: true, rooms: list });
  });

  socket.on('disconnect', () => {
    const rid = socket.data.roomId;
    if (rid) {
      const room = rooms.get(rid);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        // host transfer
        if (room.host === socket.id) {
          if (room.players.length > 0) {
            room.host = room.players[0].id;
            room.hostName = room.players[0].name;
          }
        }
        if (room.players.length === 0) rooms.delete(rid);
        else io.to(rid).emit('lobby-update', getPublicRoomData(room));
      }
    }
    console.log('socket disconnected', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}/lobby.html`);
});
