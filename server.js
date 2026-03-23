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

const SHIPS = {
  rowboat: { name: 'Rowboat', price: 0, hp: 80, speed: 0.85, turnRate: 0.04, cannons: 'front', cannonCount: 1, reloadMs: 1200 },
  warship: { name: 'War Galleon', price: 2000, hp: 200, speed: 0.6, turnRate: 0.025, cannons: 'side', cannonCount: 3, reloadMs: 2500 },
  tradeship: { name: 'Trade Schooner', price: 1500, hp: 130, speed: 0.75, turnRate: 0.032, cannons: 'front', cannonCount: 1, reloadMs: 1000 },
};

const islands = [
  { x: -400, z: -400, radius: 80, height: 20, name: 'Skull Isle' },
  { x: 400, z: -400, radius: 90, height: 22, name: 'Palm Haven' },
  { x: 400, z: 400, radius: 75, height: 18, name: 'Fort Rock' },
  { x: -400, z: 400, radius: 85, height: 24, name: 'Treasure Cove' },
];

const obstacles = [];
islands.forEach(isl => {
  for (let i = 0; i < 8; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = 10 + Math.random() * (isl.radius - 20);
    obstacles.push({ x: isl.x + Math.cos(a) * d, z: isl.z + Math.sin(a) * d, radius: 2 + Math.random() * 2 });
  }
});

const players = {};
const cannonballs = [];

function spawnPos() {
  let x, z;
  do {
    x = (Math.random() - 0.5) * MAP * 0.5;
    z = (Math.random() - 0.5) * MAP * 0.5;
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
  const bRot = Math.random() * Math.PI * 2;
  const p = {
    id: socket.id, name: 'Pirate',
    cx: sp.x, cz: sp.z, cy: 0, cRot: bRot, cVelY: 0,
    bx: sp.x, bz: sp.z, bRot, bSpeed: 0,
    onBoat: true, swimming: false, swimStart: 0,
    shipType: 'rowboat', ownedShips: ['rowboat'],
    gold: START_GOLD, hp: SHIPS.rowboat.hp, maxHp: SHIPS.rowboat.hp,
    score: 0, sails: 1, alive: true,
    input: {}, lastFire: 0, aimX: sp.x, aimZ: sp.z + 30,
    actionPressed: false, lastActivity: Date.now(),
  };
  players[socket.id] = p;

  // Send init WITH spawn position so client can position camera immediately
  socket.emit('init', {
    id: socket.id,
    islands, obstacles, mapSize: MAP, ships: SHIPS,
    spawn: { x: sp.x, z: sp.z, rot: bRot },
  });

  console.log(`+ ${socket.id} (${Object.keys(players).length})`);

  socket.on('input', inp => { if (players[socket.id]) { players[socket.id].input = inp; players[socket.id].lastActivity = Date.now(); } });
  socket.on('aim', pos => { if (players[socket.id]) { players[socket.id].aimX = pos.x || 0; players[socket.id].aimZ = pos.z || 0; } });

  socket.on('fire', () => {
    const p = players[socket.id];
    if (!p || !p.onBoat || !p.alive) return;
    const now = Date.now();
    const ship = SHIPS[p.shipType];
    if (now - p.lastFire < ship.reloadMs) return;
    p.lastFire = now;
    fireCannons(p);
  });

  socket.on('setSails', l => { if (players[socket.id]) players[socket.id].sails = Math.max(0, Math.min(2, l)); });
  socket.on('setName', n => { if (players[socket.id] && n && typeof n === 'string') players[socket.id].name = n.trim().substring(0, 16); });

  socket.on('buyShip', type => {
    const p = players[socket.id]; if (!p || !SHIPS[type]) return;
    if (p.ownedShips.includes(type)) return socket.emit('shopMsg', 'Already owned!');
    if (p.gold < SHIPS[type].price) return socket.emit('shopMsg', 'Not enough gold!');
    p.gold -= SHIPS[type].price;
    p.ownedShips.push(type);
    socket.emit('shopMsg', `Bought ${SHIPS[type].name}!`);
    socket.emit('updatePlayer', { gold: p.gold, ownedShips: p.ownedShips });
  });

  socket.on('switchShip', type => {
    const p = players[socket.id]; if (!p || !p.ownedShips.includes(type)) return;
    p.shipType = type;
    const ship = SHIPS[type];
    p.maxHp = ship.hp; p.hp = ship.hp;
    socket.emit('updatePlayer', { shipType: type, hp: p.hp, maxHp: p.maxHp });
  });

  socket.on('teleport', pos => {
    const p = players[socket.id]; if (!p) return;
    p.bx = pos.x; p.bz = pos.z; p.cx = pos.x; p.cz = pos.z; p.bSpeed = 0;
    if (!p.onBoat) { p.onBoat = true; p.swimming = false; }
  });

  socket.on('heartbeat', () => { if (players[socket.id]) players[socket.id].lastActivity = Date.now(); });
  socket.on('disconnect', () => { delete players[socket.id]; io.emit('playerLeft', socket.id); });
});

function fireCannons(p) {
  const ship = SHIPS[p.shipType];
  const dx = p.aimX - p.bx, dz = p.aimZ - p.bz;
  const dist = Math.max(20, Math.min(200, Math.sqrt(dx * dx + dz * dz)));
  const aimAngle = Math.atan2(dx, dz);

  if (ship.cannons === 'front') {
    const speed = 2.5;
    const flightT = dist / speed;
    const vy = (dist * 0.008) + 0.3;
    cannonballs.push({
      x: p.bx + Math.sin(p.bRot) * 6, z: p.bz + Math.cos(p.bRot) * 6, y: 3.5,
      vx: (dx / (dist || 1)) * speed * 0.05, vz: (dz / (dist || 1)) * speed * 0.05,
      vy, owner: p.id, born: Date.now(),
    });
  } else if (ship.cannons === 'side') {
    let rel = aimAngle - p.bRot;
    while (rel > Math.PI) rel -= Math.PI * 2; while (rel < -Math.PI) rel += Math.PI * 2;
    const side = rel > 0 ? 1 : -1;
    const sideAngle = p.bRot + side * Math.PI / 2;
    const speed = 2.2;

    for (let i = 0; i < ship.cannonCount; i++) {
      const off = (i - 1) * 4;
      const ox = p.bx + Math.sin(p.bRot) * off + Math.sin(sideAngle) * 6;
      const oz = p.bz + Math.cos(p.bRot) * off + Math.cos(sideAngle) * 6;
      const spread = (i - 1) * 7;
      const tx = p.aimX + Math.sin(p.bRot) * spread;
      const tz = p.aimZ + Math.cos(p.bRot) * spread;
      const tdx = tx - ox, tdz = tz - oz;
      const td = Math.sqrt(tdx * tdx + tdz * tdz) || 1;
      cannonballs.push({
        x: ox, z: oz, y: 3.5,
        vx: (tdx / td) * speed * 0.05, vz: (tdz / td) * speed * 0.05,
        vy: Math.min(td, 200) * 0.007 + 0.25, owner: p.id, born: Date.now(),
      });
    }
  }
}

// Ghost cleanup
setInterval(() => {
  const conn = new Set();
  for (const [id] of io.of('/').sockets) conn.add(id);
  for (const id in players) if (!conn.has(id)) { delete players[id]; io.emit('playerLeft', id); }
}, 5000);

// ── GAME LOOP ──
setInterval(() => {
  const now = Date.now();

  for (const id in players) {
    const p = players[id]; if (!p.alive) continue;
    const inp = p.input;
    const ship = SHIPS[p.shipType];

    if (p.onBoat) {
      if (inp.left) p.bRot += ship.turnRate;
      if (inp.right) p.bRot -= ship.turnRate;
      const maxSpd = [0, ship.speed * 0.45, ship.speed][p.sails];
      if (inp.forward) p.bSpeed = Math.min(p.bSpeed + 0.04, maxSpd);
      else if (inp.backward) p.bSpeed = Math.max(p.bSpeed - 0.04, -maxSpd * 0.2);
      else { if (p.sails === 0) p.bSpeed *= 0.95; else p.bSpeed += (maxSpd * 0.7 - p.bSpeed) * 0.008; }

      p.bx += Math.sin(p.bRot) * p.bSpeed;
      p.bz += Math.cos(p.bRot) * p.bSpeed;
      const half = MAP / 2;
      p.bx = Math.max(-half, Math.min(half, p.bx));
      p.bz = Math.max(-half, Math.min(half, p.bz));

      for (const isl of islands) {
        const dx = p.bx - isl.x, dz = p.bz - isl.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        const min = isl.radius + 8;
        if (dist < min) { const a = Math.atan2(dx, dz); p.bx = isl.x + Math.sin(a) * min; p.bz = isl.z + Math.cos(a) * min; p.bSpeed *= 0.2; }
      }

      p.cx = p.bx; p.cz = p.bz; p.cRot = p.bRot;

      if (inp.action && !p.actionPressed) {
        p.actionPressed = true;
        const shore = nearShore(p.bx, p.bz);
        if (shore) {
          const a = Math.atan2(p.bx - shore.x, p.bz - shore.z);
          p.cx = shore.x + Math.sin(a) * (shore.radius - 5);
          p.cz = shore.z + Math.cos(a) * (shore.radius - 5);
          p.cy = 3; p.cRot = a; p.onBoat = false; p.swimming = false;
        }
      }
      if (!inp.action) p.actionPressed = false;

    } else {
      if (inp.left) p.cRot += 0.06;
      if (inp.right) p.cRot -= 0.06;
      let mx = 0, mz = 0;
      if (inp.forward) { mx = Math.sin(p.cRot) * WALK_SPEED; mz = Math.cos(p.cRot) * WALK_SPEED; }
      if (inp.backward) { mx = -Math.sin(p.cRot) * WALK_SPEED * 0.5; mz = -Math.cos(p.cRot) * WALK_SPEED * 0.5; }

      const nx = p.cx + mx, nz = p.cz + mz;
      const ob = hitObstacle(nx, nz, 1);
      if (!ob) { p.cx = nx; p.cz = nz; }
      else { const a = Math.atan2(nx - ob.x, nz - ob.z); p.cx = ob.x + Math.sin(a) * (ob.radius + 1.2); p.cz = ob.z + Math.cos(a) * (ob.radius + 1.2); }

      if (inp.jump && p.cy <= 3.1 && !p.swimming) p.cVelY = JUMP_VEL;
      p.cVelY -= GRAVITY; p.cy += p.cVelY;
      const land = isOnLand(p.cx, p.cz);
      const gy = land ? 3 : -0.5;
      if (p.cy < gy) { p.cy = gy; p.cVelY = 0; }

      if (!land) {
        if (!p.swimming) { p.swimming = true; p.swimStart = now; }
        if (now - p.swimStart > DROWN_TIME) {
          p.hp -= 60;
          if (p.hp <= 0) { respawn(p); io.to(id).emit('sunk', { by: 'the sea' }); }
          else { p.onBoat = true; p.swimming = false; p.cx = p.bx; p.cz = p.bz; p.cy = 0; }
        }
      } else p.swimming = false;

      if (inp.action && !p.actionPressed) {
        p.actionPressed = true;
        const dx = p.cx - p.bx, dz = p.cz - p.bz;
        if (dx * dx + dz * dz < EMBARK_DIST * EMBARK_DIST) { p.onBoat = true; p.swimming = false; p.cx = p.bx; p.cz = p.bz; p.cy = 0; }
      }
      if (!inp.action) p.actionPressed = false;
    }
  }

  for (let i = cannonballs.length - 1; i >= 0; i--) {
    const cb = cannonballs[i];
    cb.x += cb.vx; cb.z += cb.vz; cb.y += cb.vy; cb.vy -= 0.035;
    if (now - cb.born > CB_LIFETIME || cb.y < -1) { cannonballs.splice(i, 1); continue; }
    for (const id in players) {
      if (id === cb.owner) continue;
      const p = players[id]; if (!p.alive) continue;
      const dx = cb.x - p.bx, dz = cb.z - p.bz;
      if (dx * dx + dz * dz < 100) {
        p.hp -= CB_DAMAGE; cannonballs.splice(i, 1);
        if (p.hp <= 0) {
          const k = players[cb.owner];
          if (k) { k.score += 1; k.gold += 200; }
          io.to(id).emit('sunk', { by: k?.name || '?' });
          respawn(p);
        }
        break;
      }
    }
  }

  const st = { players: {}, cannonballs: cannonballs.map(c => ({ x: c.x, z: c.z, y: c.y })) };
  for (const id in players) {
    const p = players[id];
    st.players[id] = {
      cx: p.cx, cz: p.cz, cy: p.cy, cRot: p.cRot,
      bx: p.bx, bz: p.bz, bRot: p.bRot, bSpeed: p.bSpeed,
      sails: p.sails, onBoat: p.onBoat, swimming: p.swimming,
      hp: p.hp, maxHp: p.maxHp, score: p.score, gold: p.gold,
      name: p.name, alive: p.alive, shipType: p.shipType,
      aimX: p.aimX, aimZ: p.aimZ, ownedShips: p.ownedShips,
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
