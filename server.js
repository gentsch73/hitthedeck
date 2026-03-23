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

// ── CONFIG ──
const TICK_RATE = 20;
const MAP_SIZE = 1200;
const BOAT_SPEED = 0.9;
const WALK_SPEED = 0.4;
const ROTATION_SPEED = 0.035;
const CANNONBALL_SPEED = 3.0;
const CANNONBALL_LIFETIME = 2500;
const SHIP_MAX_HP = 100;
const CANNONBALL_DAMAGE = 20;
const DROWN_TIME = 4000; // ms in water before death
const EMBARK_DIST = 15;
const SHORE_DIST = 12; // how close to island to disembark

// Bigger, sparser islands
const islands = [
  { x: 0, z: 0, radius: 65, height: 18 },
  { x: 350, z: 280, radius: 50, height: 14 },
  { x: -320, z: -250, radius: 55, height: 16 },
  { x: 300, z: -350, radius: 45, height: 12 },
  { x: -400, z: 350, radius: 70, height: 20 },
];

const players = {};
const cannonballs = [];

function spawnPosition() {
  let x, z, valid;
  do {
    x = (Math.random() - 0.5) * MAP_SIZE * 0.7;
    z = (Math.random() - 0.5) * MAP_SIZE * 0.7;
    valid = true;
    for (const isl of islands) {
      const dx = x - isl.x, dz = z - isl.z;
      if (Math.sqrt(dx * dx + dz * dz) < isl.radius + 25) { valid = false; break; }
    }
  } while (!valid);
  return { x, z };
}

function isOnLand(x, z) {
  for (const isl of islands) {
    const dx = x - isl.x, dz = z - isl.z;
    if (Math.sqrt(dx * dx + dz * dz) < isl.radius) return isl;
  }
  return null;
}

function nearShore(x, z) {
  for (const isl of islands) {
    const dx = x - isl.x, dz = z - isl.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < isl.radius + SHORE_DIST && dist > isl.radius - 5) return isl;
  }
  return null;
}

io.on('connection', (socket) => {
  const spawn = spawnPosition();
  const player = {
    id: socket.id,
    name: 'Pirate',
    // Character position (when on land/swimming)
    cx: spawn.x, cz: spawn.z, cRotation: Math.random() * Math.PI * 2,
    // Boat
    bx: spawn.x, bz: spawn.z, bRotation: Math.random() * Math.PI * 2,
    bSpeed: 0, sails: 1,
    // State
    onBoat: true,
    swimming: false,
    swimStart: 0,
    hp: SHIP_MAX_HP,
    score: 0,
    alive: true,
    // Input
    input: { forward: false, backward: false, left: false, right: false, fire: false, action: false },
    lastFire: 0,
    lastActivity: Date.now(),
    actionPressed: false, // debounce
  };
  players[socket.id] = player;

  socket.emit('init', { id: socket.id, islands, mapSize: MAP_SIZE });
  console.log(`+ ${socket.id} (${Object.keys(players).length} players)`);

  socket.on('input', (inp) => {
    if (!players[socket.id]) return;
    players[socket.id].input = inp;
    players[socket.id].lastActivity = Date.now();
  });

  socket.on('setSails', (level) => {
    if (!players[socket.id]) return;
    players[socket.id].sails = Math.max(0, Math.min(2, level));
  });

  socket.on('setName', (name) => {
    if (!players[socket.id]) return;
    if (name && typeof name === 'string')
      players[socket.id].name = name.trim().substring(0, 16);
  });

  socket.on('heartbeat', () => {
    if (players[socket.id]) players[socket.id].lastActivity = Date.now();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

// Ghost cleanup
setInterval(() => {
  const connected = new Set();
  for (const [id] of io.of('/').sockets) connected.add(id);
  for (const id in players) {
    if (!connected.has(id)) {
      delete players[id];
      io.emit('playerLeft', id);
    }
  }
}, 5000);

// ── GAME LOOP ──
setInterval(() => {
  const now = Date.now();

  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    const inp = p.input;

    if (p.onBoat) {
      // ── ON BOAT ──
      // Rotation
      if (inp.left) p.bRotation += ROTATION_SPEED;
      if (inp.right) p.bRotation -= ROTATION_SPEED;

      // Speed based on sails
      const maxSpeed = [0, BOAT_SPEED * 0.45, BOAT_SPEED][p.sails];
      if (inp.forward) p.bSpeed = Math.min(p.bSpeed + 0.04, maxSpeed);
      else if (inp.backward) p.bSpeed = Math.max(p.bSpeed - 0.04, -maxSpeed * 0.25);
      else {
        if (p.sails === 0) p.bSpeed *= 0.95;
        else p.bSpeed += (maxSpeed * 0.8 - p.bSpeed) * 0.01; // sails push forward
      }

      p.bx += Math.sin(p.bRotation) * p.bSpeed;
      p.bz += Math.cos(p.bRotation) * p.bSpeed;

      // Map bounds
      const half = MAP_SIZE / 2;
      p.bx = Math.max(-half, Math.min(half, p.bx));
      p.bz = Math.max(-half, Math.min(half, p.bz));

      // Island collision for boat
      for (const isl of islands) {
        const dx = p.bx - isl.x, dz = p.bz - isl.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const minDist = isl.radius + 6;
        if (dist < minDist) {
          const angle = Math.atan2(dx, dz);
          p.bx = isl.x + Math.sin(angle) * minDist;
          p.bz = isl.z + Math.cos(angle) * minDist;
          p.bSpeed *= 0.2;
        }
      }

      // Character follows boat
      p.cx = p.bx;
      p.cz = p.bz;
      p.cRotation = p.bRotation;

      // Disembark: press action near shore
      if (inp.action && !p.actionPressed) {
        p.actionPressed = true;
        const shore = nearShore(p.bx, p.bz);
        if (shore) {
          // Place character on the island edge
          const angle = Math.atan2(p.bx - shore.x, p.bz - shore.z);
          p.cx = shore.x + Math.sin(angle) * (shore.radius - 3);
          p.cz = shore.z + Math.cos(angle) * (shore.radius - 3);
          p.cRotation = angle;
          p.onBoat = false;
          p.swimming = false;
        }
      }
      if (!inp.action) p.actionPressed = false;

      // Fire cannon (forward)
      if (inp.fire && now - p.lastFire > 1000) {
        p.lastFire = now;
        cannonballs.push({
          x: p.bx + Math.sin(p.bRotation) * 7,
          z: p.bz + Math.cos(p.bRotation) * 7,
          vx: Math.sin(p.bRotation) * CANNONBALL_SPEED + Math.sin(p.bRotation) * p.bSpeed * 0.3,
          vz: Math.cos(p.bRotation) * CANNONBALL_SPEED + Math.cos(p.bRotation) * p.bSpeed * 0.3,
          owner: id, born: now, y: 3, vy: 0.6,
        });
      }

    } else {
      // ── ON FOOT ──
      if (inp.left) p.cRotation += ROTATION_SPEED * 1.5;
      if (inp.right) p.cRotation -= ROTATION_SPEED * 1.5;

      let moveX = 0, moveZ = 0;
      if (inp.forward) {
        moveX = Math.sin(p.cRotation) * WALK_SPEED;
        moveZ = Math.cos(p.cRotation) * WALK_SPEED;
      }
      if (inp.backward) {
        moveX = -Math.sin(p.cRotation) * WALK_SPEED * 0.5;
        moveZ = -Math.cos(p.cRotation) * WALK_SPEED * 0.5;
      }

      const newX = p.cx + moveX;
      const newZ = p.cz + moveZ;

      const onLand = isOnLand(newX, newZ);
      if (onLand) {
        p.cx = newX;
        p.cz = newZ;
        p.swimming = false;
        p.swimStart = 0;
      } else {
        // Walking into water
        p.cx = newX;
        p.cz = newZ;
        if (!p.swimming) {
          p.swimming = true;
          p.swimStart = now;
        }
      }

      // Drowning
      if (p.swimming && now - p.swimStart > DROWN_TIME) {
        // Die and respawn on boat
        p.hp -= 50;
        if (p.hp <= 0) {
          respawnPlayer(p);
          io.to(id).emit('sunk', { by: 'the sea' });
        } else {
          // Teleport back to boat
          p.onBoat = true;
          p.swimming = false;
          p.cx = p.bx;
          p.cz = p.bz;
        }
      }

      // Embark: press action near own boat
      if (inp.action && !p.actionPressed) {
        p.actionPressed = true;
        const dx = p.cx - p.bx, dz = p.cz - p.bz;
        if (dx * dx + dz * dz < EMBARK_DIST * EMBARK_DIST) {
          p.onBoat = true;
          p.swimming = false;
          p.cx = p.bx;
          p.cz = p.bz;
        }
      }
      if (!inp.action) p.actionPressed = false;
    }
  }

  // ── CANNONBALLS ──
  for (let i = cannonballs.length - 1; i >= 0; i--) {
    const cb = cannonballs[i];
    cb.x += cb.vx; cb.z += cb.vz; cb.y += cb.vy; cb.vy -= 0.045;

    if (now - cb.born > CANNONBALL_LIFETIME || cb.y < -1) {
      cannonballs.splice(i, 1); continue;
    }

    // Hit boats
    for (const id in players) {
      if (id === cb.owner) continue;
      const p = players[id];
      if (!p.alive) continue;
      // Hit the boat
      const dx = cb.x - p.bx, dz = cb.z - p.bz;
      if (dx * dx + dz * dz < 80) {
        p.hp -= CANNONBALL_DAMAGE;
        cannonballs.splice(i, 1);
        if (p.hp <= 0) {
          if (players[cb.owner]) players[cb.owner].score += 1;
          io.to(id).emit('sunk', { by: players[cb.owner]?.name || '?' });
          respawnPlayer(p);
        }
        break;
      }
    }
  }

  // ── BROADCAST ──
  const state = {
    players: {},
    cannonballs: cannonballs.map(cb => ({ x: cb.x, z: cb.z, y: cb.y })),
  };
  for (const id in players) {
    const p = players[id];
    state.players[id] = {
      cx: p.cx, cz: p.cz, cRotation: p.cRotation,
      bx: p.bx, bz: p.bz, bRotation: p.bRotation,
      bSpeed: p.bSpeed, sails: p.sails,
      onBoat: p.onBoat, swimming: p.swimming,
      hp: p.hp, score: p.score, name: p.name, alive: p.alive,
    };
  }
  io.volatile.emit('state', state);

}, 1000 / TICK_RATE);

function respawnPlayer(p) {
  const spawn = spawnPosition();
  p.bx = spawn.x; p.bz = spawn.z;
  p.bRotation = Math.random() * Math.PI * 2;
  p.bSpeed = 0; p.sails = 1;
  p.cx = spawn.x; p.cz = spawn.z;
  p.cRotation = p.bRotation;
  p.onBoat = true; p.swimming = false;
  p.hp = SHIP_MAX_HP; p.alive = true;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Krew3D on port ${PORT}`));
