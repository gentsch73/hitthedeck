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
const TICK = 20;
const MAP = 1600;
const WALK_SPEED = 0.55;
const JUMP_VEL = 0.25;
const GRAVITY = 0.012;
const DROWN_TIME = 4000;
const EMBARK_DIST = 18;
const SHORE_DIST = 14;
const CB_LIFETIME = 3000;
const CB_DAMAGE = 18;
const START_GOLD = 5000;

// Ship definitions
const SHIPS = {
  rowboat: {
    name: 'Rowboat', price: 0, hp: 80,
    speed: 0.85, turnRate: 0.04,
    cannons: 'front', cannonCount: 1, reloadMs: 1200,
  },
  warship: {
    name: 'War Galleon', price: 2000, hp: 200,
    speed: 0.6, turnRate: 0.025,
    cannons: 'side', cannonCount: 3, reloadMs: 2500,
  },
  tradeship: {
    name: 'Trade Schooner', price: 1500, hp: 130,
    speed: 0.75, turnRate: 0.032,
    cannons: 'front', cannonCount: 1, reloadMs: 1000,
  },
};

// 4 large islands, well-spaced
const islands = [
  { x: -350, z: -350, radius: 80, height: 20, name: 'Skull Isle' },
  { x: 350, z: -350, radius: 90, height: 22, name: 'Palm Haven' },
  { x: 350, z: 350, radius: 75, height: 18, name: 'Fort Rock' },
  { x: -350, z: 350, radius: 85, height: 24, name: 'Treasure Cove' },
];

// Obstacles on islands (trees/rocks for collision)
const obstacles = [];
islands.forEach(isl => {
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 10 + Math.random() * (isl.radius - 20);
    obstacles.push({
      x: isl.x + Math.cos(a) * d,
      z: isl.z + Math.sin(a) * d,
      radius: 2 + Math.random() * 2,
      island: isl,
    });
  }
});

const players = {};
const cannonballs = [];

function spawnPos() {
  let x, z;
  do {
    x = (Math.random() - 0.5) * MAP * 0.6;
    z = (Math.random() - 0.5) * MAP * 0.6;
  } while (isOnLand(x, z));
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
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < isl.radius + SHORE_DIST && d > isl.radius - 8) return isl;
  }
  return null;
}

function hitObstacle(x, z, r) {
  for (const ob of obstacles) {
    const dx = x - ob.x, dz = z - ob.z;
    if (Math.sqrt(dx * dx + dz * dz) < ob.radius + r) return ob;
  }
  return null;
}

io.on('connection', (socket) => {
  const sp = spawnPos();
  const p = {
    id: socket.id, name: 'Pirate',
    // Character
    cx: sp.x, cz: sp.z, cy: 0, cRot: 0, cVelY: 0,
    // Boat
    bx: sp.x, bz: sp.z, bRot: Math.random() * Math.PI * 2, bSpeed: 0,
    // State
    onBoat: true, swimming: false, swimStart: 0,
    shipType: 'rowboat', ownedShips: ['rowboat'],
    gold: START_GOLD, hp: SHIPS.rowboat.hp, maxHp: SHIPS.rowboat.hp,
    score: 0, sails: 1, alive: true,
    // Input
    input: {}, lastFire: 0, aimX: 0, aimZ: 0,
    actionPressed: false, lastActivity: Date.now(),
  };
  players[socket.id] = p;
  socket.emit('init', { id: socket.id, islands, obstacles, mapSize: MAP, ships: SHIPS, startGold: START_GOLD });

  socket.on('input', inp => {
    if (!players[socket.id]) return;
    Object.assign(players[socket.id].input, inp);
    players[socket.id].lastActivity = Date.now();
  });

  socket.on('aim', pos => {
    if (!players[socket.id]) return;
    players[socket.id].aimX = pos.x || 0;
    players[socket.id].aimZ = pos.z || 0;
  });

  socket.on('fire', () => {
    if (!players[socket.id]) return;
    const p = players[socket.id];
    if (!p.onBoat || !p.alive) return;
    const now = Date.now();
    const ship = SHIPS[p.shipType];
    if (now - p.lastFire < ship.reloadMs) return;
    p.lastFire = now;
    fireCannons(p);
  });

  socket.on('setSails', l => {
    if (players[socket.id]) players[socket.id].sails = Math.max(0, Math.min(2, l));
  });

  socket.on('setName', n => {
    if (players[socket.id] && n && typeof n === 'string')
      players[socket.id].name = n.trim().substring(0, 16);
  });

  socket.on('buyShip', type => {
    const p = players[socket.id];
    if (!p || !SHIPS[type]) return;
    if (p.ownedShips.includes(type)) return socket.emit('shopMsg', 'Already owned!');
    if (p.gold < SHIPS[type].price) return socket.emit('shopMsg', 'Not enough gold!');
    p.gold -= SHIPS[type].price;
    p.ownedShips.push(type);
    socket.emit('shopMsg', `Bought ${SHIPS[type].name}!`);
    socket.emit('updatePlayer', { gold: p.gold, ownedShips: p.ownedShips });
  });

  socket.on('switchShip', type => {
    const p = players[socket.id];
    if (!p || !p.ownedShips.includes(type)) return;
    if (!p.onBoat) return; // Must be on boat to switch (or just bought)
    p.shipType = type;
    const ship = SHIPS[type];
    p.maxHp = ship.hp;
    p.hp = ship.hp;
    socket.emit('updatePlayer', { shipType: type, hp: p.hp, maxHp: p.maxHp });
  });

  socket.on('teleport', pos => {
    const p = players[socket.id];
    if (!p) return;
    p.bx = pos.x; p.bz = pos.z;
    p.cx = pos.x; p.cz = pos.z;
    p.bSpeed = 0;
    if (!p.onBoat) { p.onBoat = true; p.swimming = false; }
  });

  socket.on('heartbeat', () => {
    if (players[socket.id]) players[socket.id].lastActivity = Date.now();
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
  });
});

function fireCannons(p) {
  const ship = SHIPS[p.shipType];
  const tx = p.aimX, tz = p.aimZ;
  const dx = tx - p.bx, dz = tz - p.bz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  const aimAngle = Math.atan2(dx, dz);

  if (ship.cannons === 'front') {
    spawnCannonball(p, p.bx, p.bz, p.bRot, tx, tz, dist, 6, 0);
  } else if (ship.cannons === 'side') {
    // Determine which side to fire (left or right of ship)
    let relAngle = aimAngle - p.bRot;
    while (relAngle > Math.PI) relAngle -= Math.PI * 2;
    while (relAngle < -Math.PI) relAngle += Math.PI * 2;
    const side = relAngle > 0 ? 1 : -1; // 1=left, -1=right
    const sideAngle = p.bRot + side * Math.PI / 2;

    for (let i = 0; i < ship.cannonCount; i++) {
      const offset = (i - 1) * 4; // -4, 0, 4 along ship
      const ox = p.bx + Math.sin(p.bRot) * offset + Math.sin(sideAngle) * 5;
      const oz = p.bz + Math.cos(p.bRot) * offset + Math.cos(sideAngle) * 5;
      // Spread targets
      const spread = (i - 1) * 6;
      const stx = tx + Math.sin(p.bRot) * spread;
      const stz = tz + Math.cos(p.bRot) * spread;
      const sd = Math.sqrt((stx - ox) ** 2 + (stz - oz) ** 2);
      spawnCannonball(p, ox, oz, sideAngle, stx, stz, sd, 0, 0);
    }
  }
}

function spawnCannonball(p, sx, sz, angle, tx, tz, dist, fwdOff, sideOff) {
  const clampDist = Math.min(Math.max(dist, 20), 200);
  const flightTime = clampDist / 2.5;
  const dx = tx - sx, dz = tz - sz;
  const d = Math.sqrt(dx * dx + dz * dz) || 1;

  cannonballs.push({
    x: sx + Math.sin(angle) * fwdOff,
    z: sz + Math.cos(angle) * fwdOff,
    y: 3.5,
    vx: (dx / d) * (clampDist / flightTime) * 0.05,
    vz: (dz / d) * (clampDist / flightTime) * 0.05,
    vy: clampDist * 0.008,
    owner: p.id,
    born: Date.now(),
    tx, tz, // target for client prediction
  });
}

// Ghost cleanup
setInterval(() => {
  const conn = new Set();
  for (const [id] of io.of('/').sockets) conn.add(id);
  for (const id in players) {
    if (!conn.has(id)) { delete players[id]; io.emit('playerLeft', id); }
  }
}, 5000);

// ── GAME LOOP ──
setInterval(() => {
  const now = Date.now();

  for (const id in players) {
    const p = players[id];
    if (!p.alive) continue;
    const inp = p.input;
    const ship = SHIPS[p.shipType];

    if (p.onBoat) {
      if (inp.left) p.bRot += ship.turnRate;
      if (inp.right) p.bRot -= ship.turnRate;

      const maxSpd = [0, ship.speed * 0.45, ship.speed][p.sails];
      if (inp.forward) p.bSpeed = Math.min(p.bSpeed + 0.04, maxSpd);
      else if (inp.backward) p.bSpeed = Math.max(p.bSpeed - 0.04, -maxSpd * 0.2);
      else {
        if (p.sails === 0) p.bSpeed *= 0.95;
        else p.bSpeed += (maxSpd * 0.7 - p.bSpeed) * 0.008;
      }

      p.bx += Math.sin(p.bRot) * p.bSpeed;
      p.bz += Math.cos(p.bRot) * p.bSpeed;

      const half = MAP / 2;
      p.bx = Math.max(-half, Math.min(half, p.bx));
      p.bz = Math.max(-half, Math.min(half, p.bz));

      for (const isl of islands) {
        const dx = p.bx - isl.x, dz = p.bz - isl.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const min = isl.radius + 8;
        if (dist < min) {
          const a = Math.atan2(dx, dz);
          p.bx = isl.x + Math.sin(a) * min;
          p.bz = isl.z + Math.cos(a) * min;
          p.bSpeed *= 0.2;
        }
      }

      p.cx = p.bx; p.cz = p.bz; p.cRot = p.bRot;

      // Disembark
      if (inp.action && !p.actionPressed) {
        p.actionPressed = true;
        const shore = nearShore(p.bx, p.bz);
        if (shore) {
          const a = Math.atan2(p.bx - shore.x, p.bz - shore.z);
          p.cx = shore.x + Math.sin(a) * (shore.radius - 5);
          p.cz = shore.z + Math.cos(a) * (shore.radius - 5);
          p.cy = 3;
          p.cRot = a;
          p.onBoat = false;
          p.swimming = false;
        }
      }
      if (!inp.action) p.actionPressed = false;

    } else {
      // ── ON FOOT ──
      if (inp.left) p.cRot += 0.06;
      if (inp.right) p.cRot -= 0.06;

      let mx = 0, mz = 0;
      if (inp.forward) { mx = Math.sin(p.cRot) * WALK_SPEED; mz = Math.cos(p.cRot) * WALK_SPEED; }
      if (inp.backward) { mx = -Math.sin(p.cRot) * WALK_SPEED * 0.5; mz = -Math.cos(p.cRot) * WALK_SPEED * 0.5; }

      const nx = p.cx + mx, nz = p.cz + mz;

      // Obstacle collision
      const ob = hitObstacle(nx, nz, 1);
      if (!ob) {
        p.cx = nx; p.cz = nz;
      } else {
        // Slide along obstacle
        const a = Math.atan2(nx - ob.x, nz - ob.z);
        p.cx = ob.x + Math.sin(a) * (ob.radius + 1.2);
        p.cz = ob.z + Math.cos(a) * (ob.radius + 1.2);
      }

      // Jump
      if (inp.jump && p.cy <= 3.1 && !p.swimming) {
        p.cVelY = JUMP_VEL;
      }
      p.cVelY -= GRAVITY;
      p.cy += p.cVelY;

      const land = isOnLand(p.cx, p.cz);
      const groundY = land ? 3 : -0.5;
      if (p.cy < groundY) { p.cy = groundY; p.cVelY = 0; }

      if (!land) {
        if (!p.swimming) { p.swimming = true; p.swimStart = now; }
        if (now - p.swimStart > DROWN_TIME) {
          p.hp -= 60;
          if (p.hp <= 0) { respawn(p); io.to(id).emit('sunk', { by: 'the sea' }); }
          else { p.onBoat = true; p.swimming = false; p.cx = p.bx; p.cz = p.bz; p.cy = 0; }
        }
      } else {
        p.swimming = false;
      }

      // Embark
      if (inp.action && !p.actionPressed) {
        p.actionPressed = true;
        const dx = p.cx - p.bx, dz = p.cz - p.bz;
        if (dx * dx + dz * dz < EMBARK_DIST * EMBARK_DIST) {
          p.onBoat = true; p.swimming = false; p.cx = p.bx; p.cz = p.bz; p.cy = 0;
        }
      }
      if (!inp.action) p.actionPressed = false;
    }
  }

  // Cannonballs
  for (let i = cannonballs.length - 1; i >= 0; i--) {
    const cb = cannonballs[i];
    cb.x += cb.vx; cb.z += cb.vz; cb.y += cb.vy; cb.vy -= 0.04;

    if (now - cb.born > CB_LIFETIME || cb.y < -1) { cannonballs.splice(i, 1); continue; }

    for (const id in players) {
      if (id === cb.owner) continue;
      const p = players[id];
      if (!p.alive) continue;
      const dx = cb.x - p.bx, dz = cb.z - p.bz;
      if (dx * dx + dz * dz < 100) {
        p.hp -= CB_DAMAGE;
        cannonballs.splice(i, 1);
        if (p.hp <= 0) {
          const killer = players[cb.owner];
          if (killer) { killer.score += 1; killer.gold += 200; }
          io.to(id).emit('sunk', { by: killer?.name || '?' });
          respawn(p);
        }
        break;
      }
    }
  }

  // Broadcast
  const st = { players: {}, cannonballs: cannonballs.map(c => ({ x: c.x, z: c.z, y: c.y })) };
  for (const id in players) {
    const p = players[id];
    st.players[id] = {
      cx: p.cx, cz: p.cz, cy: p.cy, cRot: p.cRot,
      bx: p.bx, bz: p.bz, bRot: p.bRot, bSpeed: p.bSpeed,
      sails: p.sails, onBoat: p.onBoat, swimming: p.swimming,
      hp: p.hp, maxHp: p.maxHp, score: p.score, gold: p.gold,
      name: p.name, alive: p.alive, shipType: p.shipType,
      aimX: p.aimX, aimZ: p.aimZ,
    };
  }
  io.volatile.emit('state', st);

}, 1000 / TICK);

function respawn(p) {
  const sp = spawnPos();
  p.bx = sp.x; p.bz = sp.z; p.bRot = Math.random() * Math.PI * 2; p.bSpeed = 0;
  p.cx = sp.x; p.cz = sp.z; p.cy = 0; p.cRot = p.bRot;
  p.onBoat = true; p.swimming = false;
  p.hp = SHIPS[p.shipType].hp; p.maxHp = SHIPS[p.shipType].hp;
  p.sails = 1; p.alive = true;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Krew3D on port ${PORT}`));
