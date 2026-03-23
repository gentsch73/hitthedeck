const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 10000,
  pingTimeout: 20000,
  transports: ['websocket', 'polling'],
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.status(200).send('OK'));

const players = {};
const cannonballs = [];
const TICK_RATE = 20;
const MAP_SIZE = 800;
const SHIP_SPEED = 0.8;
const ROTATION_SPEED = 0.03;
const CANNONBALL_SPEED = 2.5;
const CANNONBALL_LIFETIME = 3000;
const SHIP_MAX_HP = 100;
const CANNONBALL_DAMAGE = 15;

const islands = [
  { x: 0, z: 0, radius: 30, height: 12 },
  { x: 200, z: 150, radius: 22, height: 8 },
  { x: -180, z: -120, radius: 26, height: 10 },
  { x: 150, z: -200, radius: 18, height: 7 },
  { x: -250, z: 200, radius: 35, height: 14 },
  { x: 300, z: -100, radius: 20, height: 9 },
  { x: -100, z: 280, radius: 24, height: 11 },
];

function spawnPosition() {
  let x, z, valid;
  do {
    x = (Math.random() - 0.5) * MAP_SIZE * 0.8;
    z = (Math.random() - 0.5) * MAP_SIZE * 0.8;
    valid = true;
    for (const isl of islands) {
      const dx = x - isl.x, dz = z - isl.z;
      if (Math.sqrt(dx * dx + dz * dz) < isl.radius + 15) { valid = false; break; }
    }
  } while (!valid);
  return { x, z };
}

io.on('connection', (socket) => {
  const spawn = spawnPosition();
  const player = {
    id: socket.id,
    name: 'Pirate',
    x: spawn.x, z: spawn.z,
    rotation: Math.random() * Math.PI * 2,
    speed: 0, hp: SHIP_MAX_HP, score: 0,
    input: { forward: false, backward: false, left: false, right: false, fire: false },
    lastFire: 0, sails: 1, lastActivity: Date.now(),
  };
  players[socket.id] = player;

  socket.emit('init', { id: socket.id, islands, mapSize: MAP_SIZE });
  console.log(`+ ${socket.id} joined (${Object.keys(players).length} total)`);

  socket.on('input', (input) => {
    if (!players[socket.id]) return;
    players[socket.id].input = input;
    players[socket.id].lastActivity = Date.now();
  });

  socket.on('setSails', (level) => {
    if (!players[socket.id]) return;
    players[socket.id].sails = Math.max(0, Math.min(2, level));
    players[socket.id].lastActivity = Date.now();
  });

  socket.on('setName', (name) => {
    if (!players[socket.id]) return;
    if (name && typeof name === 'string' && name.length <= 16) {
      players[socket.id].name = name.trim().substring(0, 16);
    }
  });

  socket.on('heartbeat', () => {
    if (players[socket.id]) players[socket.id].lastActivity = Date.now();
  });

  socket.on('disconnect', (reason) => {
    console.log(`- ${socket.id} left: ${reason} (${Object.keys(players).length - 1} remain)`);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// Ghost cleanup every 5s
setInterval(() => {
  const connectedIds = new Set();
  for (const [id] of io.of('/').sockets) connectedIds.add(id);
  for (const id in players) {
    if (!connectedIds.has(id)) {
      console.log(`Ghost removed: ${id}`);
      delete players[id];
      io.emit('playerLeft', id);
    }
  }
}, 5000);

// Game loop
setInterval(() => {
  const now = Date.now();

  for (const id in players) {
    const p = players[id];
    const inp = p.input;

    if (inp.left) p.rotation += ROTATION_SPEED;
    if (inp.right) p.rotation -= ROTATION_SPEED;

    const maxSpeed = [0, SHIP_SPEED * 0.5, SHIP_SPEED][p.sails];
    if (inp.forward) p.speed = Math.min(p.speed + 0.05, maxSpeed);
    else if (inp.backward) p.speed = Math.max(p.speed - 0.05, -maxSpeed * 0.3);
    else p.speed *= 0.98;

    p.x += Math.sin(p.rotation) * p.speed;
    p.z += Math.cos(p.rotation) * p.speed;

    const half = MAP_SIZE / 2;
    p.x = Math.max(-half, Math.min(half, p.x));
    p.z = Math.max(-half, Math.min(half, p.z));

    for (const isl of islands) {
      const dx = p.x - isl.x, dz = p.z - isl.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      const minDist = isl.radius + 8;
      if (dist < minDist) {
        const angle = Math.atan2(dx, dz);
        p.x = isl.x + Math.sin(angle) * minDist;
        p.z = isl.z + Math.cos(angle) * minDist;
        p.speed *= 0.3;
      }
    }

    if (inp.fire && now - p.lastFire > 800) {
      p.lastFire = now;
      for (const side of [Math.PI / 2, -Math.PI / 2]) {
        const angle = p.rotation + side;
        cannonballs.push({
          x: p.x + Math.sin(angle) * 6,
          z: p.z + Math.cos(angle) * 6,
          vx: Math.sin(angle) * CANNONBALL_SPEED + Math.sin(p.rotation) * p.speed * 0.5,
          vz: Math.cos(angle) * CANNONBALL_SPEED + Math.cos(p.rotation) * p.speed * 0.5,
          owner: id, born: now, y: 3, vy: 0.5,
        });
      }
    }
  }

  for (let i = cannonballs.length - 1; i >= 0; i--) {
    const cb = cannonballs[i];
    cb.x += cb.vx; cb.z += cb.vz; cb.y += cb.vy; cb.vy -= 0.04;
    if (now - cb.born > CANNONBALL_LIFETIME || cb.y < 0) { cannonballs.splice(i, 1); continue; }
    for (const id in players) {
      if (id === cb.owner) continue;
      const p = players[id];
      const dx = cb.x - p.x, dz = cb.z - p.z;
      if (dx * dx + dz * dz < 64) {
        p.hp -= CANNONBALL_DAMAGE;
        cannonballs.splice(i, 1);
        if (p.hp <= 0) {
          if (players[cb.owner]) players[cb.owner].score += 1;
          io.to(id).emit('sunk', { by: players[cb.owner]?.name || '?' });
          const spawn = spawnPosition();
          p.x = spawn.x; p.z = spawn.z; p.hp = SHIP_MAX_HP;
          p.speed = 0; p.rotation = Math.random() * Math.PI * 2;
        }
        break;
      }
    }
  }

  const state = { players: {}, cannonballs: cannonballs.map(cb => ({ x: cb.x, z: cb.z, y: cb.y })) };
  for (const id in players) {
    const p = players[id];
    state.players[id] = {
      x: p.x, z: p.z, rotation: p.rotation, speed: p.speed,
      hp: p.hp, score: p.score, name: p.name, sails: p.sails,
    };
  }
  io.volatile.emit('state', state);
}, 1000 / TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Krew3D on port ${PORT}`));
