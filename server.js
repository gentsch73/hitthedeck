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
  transports: ['polling', 'websocket'],
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.status(200).send('OK'));

const TICK = 20, MAP = 1600, WALK = 0.55, JUMP = 0.25, GRAV = 0.012;
const DROWN = 4000, EMBARK = 18, SHORE = 14, CB_LIFE = 3000, CB_DMG = 18, GOLD0 = 5000;

const SHIPS = {
  rowboat:   { name:'Rowboat',        price:0,    hp:80,  speed:0.85, turn:0.04,  cannons:'front', count:1, reload:1200 },
  warship:   { name:'War Galleon',     price:2000, hp:200, speed:0.6,  turn:0.025, cannons:'side',  count:3, reload:2500 },
  tradeship: { name:'Trade Schooner',  price:1500, hp:130, speed:0.75, turn:0.032, cannons:'front', count:1, reload:1000 },
};

const islands = [
  { x:-400, z:-400, r:80, name:'Skull Isle' },
  { x: 400, z:-400, r:90, name:'Palm Haven' },
  { x: 400, z: 400, r:75, name:'Fort Rock' },
  { x:-400, z: 400, r:85, name:'Treasure Cove' },
];

const rocks = [];
islands.forEach(il => {
  for (let i = 0; i < 8; i++) {
    const a = Math.random()*Math.PI*2, d = 12+Math.random()*(il.r-22);
    rocks.push({ x: il.x+Math.cos(a)*d, z: il.z+Math.sin(a)*d, r: 2+Math.random()*2 });
  }
});

const players = {}, cbs = [];

function spawn() {
  let x, z;
  do { x=(Math.random()-0.5)*MAP*0.5; z=(Math.random()-0.5)*MAP*0.5; }
  while (onLand(x,z));
  return {x,z};
}
function onLand(x,z) { for(const i of islands) if(Math.hypot(x-i.x,z-i.z)<i.r) return i; return null; }
function nearShore(x,z) { for(const i of islands){const d=Math.hypot(x-i.x,z-i.z);if(d<i.r+SHORE&&d>i.r-8)return i;} return null; }
function hitRock(x,z,r) { for(const o of rocks) if(Math.hypot(x-o.x,z-o.z)<o.r+r) return o; return null; }

function fullState() {
  const s = { players:{}, cbs: cbs.map(c=>({x:c.x,z:c.z,y:c.y})) };
  for (const id in players) {
    const p = players[id];
    s.players[id] = {
      cx:p.cx,cz:p.cz,cy:p.cy,cr:p.cr,
      bx:p.bx,bz:p.bz,br:p.br,bs:p.bs,
      sails:p.sails,onBoat:p.ob,swim:p.swim,
      hp:p.hp,mhp:p.mhp,score:p.sc,gold:p.gold,
      name:p.name,ship:p.ship,ax:p.ax,az:p.az,
    };
  }
  return s;
}

io.on('connection', socket => {
  const sp = spawn();
  const p = {
    id:socket.id, name:'Pirate',
    cx:sp.x,cz:sp.z,cy:0,cr:0,cvY:0,
    bx:sp.x,bz:sp.z,br:Math.random()*Math.PI*2,bs:0,
    ob:true,swim:false,swimT:0,
    ship:'rowboat',owned:['rowboat'],
    gold:GOLD0,hp:80,mhp:80,sc:0,sails:1,alive:true,
    inp:{},lastF:0,ax:sp.x,az:sp.z+30,
    actP:false,lastAct:Date.now(),joinT:Date.now(),
  };
  players[socket.id] = p;

  // CRITICAL: send init with full state immediately
  socket.emit('init', {
    id: socket.id,
    islands, rocks, map: MAP, ships: SHIPS,
    state: fullState(),
    spawnX: sp.x, spawnZ: sp.z, spawnR: p.br,
  });

  console.log(`+ ${socket.id} (${Object.keys(players).length})`);

  socket.on('input', d => { if(players[socket.id]){players[socket.id].inp=d;players[socket.id].lastAct=Date.now()} });
  socket.on('aim', d => { if(players[socket.id]){players[socket.id].ax=d.x||0;players[socket.id].az=d.z||0} });

  socket.on('fire', () => {
    const p=players[socket.id]; if(!p||!p.ob||!p.alive)return;
    const now=Date.now(),sh=SHIPS[p.ship]; if(now-p.lastF<sh.reload)return;
    p.lastF=now; fire(p);
  });

  socket.on('setSails', l => { if(players[socket.id]) players[socket.id].sails=Math.max(0,Math.min(2,l)) });
  socket.on('setName', n => { if(players[socket.id]&&n&&typeof n==='string') players[socket.id].name=n.trim().substring(0,16) });

  socket.on('buy', type => {
    const p=players[socket.id]; if(!p||!SHIPS[type])return;
    if(p.owned.includes(type))return socket.emit('msg','Already owned!');
    if(p.gold<SHIPS[type].price)return socket.emit('msg','Not enough gold!');
    p.gold-=SHIPS[type].price; p.owned.push(type);
    socket.emit('msg',`Bought ${SHIPS[type].name}!`);
    socket.emit('upd',{gold:p.gold,owned:p.owned});
  });

  socket.on('equip', type => {
    const p=players[socket.id]; if(!p||!p.owned.includes(type))return;
    p.ship=type; const sh=SHIPS[type]; p.mhp=sh.hp; p.hp=sh.hp;
    socket.emit('upd',{ship:type,hp:p.hp,mhp:p.mhp});
  });

  socket.on('tp', pos => {
    const p=players[socket.id]; if(!p)return;
    p.bx=pos.x;p.bz=pos.z;p.cx=pos.x;p.cz=pos.z;p.bs=0;
    if(!p.ob){p.ob=true;p.swim=false}
  });

  socket.on('heartbeat', ()=>{ if(players[socket.id])players[socket.id].lastAct=Date.now() });
  socket.on('disconnect', ()=>{ delete players[socket.id]; io.emit('left',socket.id) });
});

function fire(p) {
  const sh=SHIPS[p.ship], dx=p.ax-p.bx, dz=p.az-p.bz;
  const dist=Math.max(20,Math.min(200,Math.hypot(dx,dz)));
  if(sh.cannons==='front') {
    mkCB(p,p.bx+Math.sin(p.br)*6,p.bz+Math.cos(p.br)*6,p.ax,p.az,dist);
  } else {
    const aim=Math.atan2(dx,dz);let rel=aim-p.br;while(rel>Math.PI)rel-=Math.PI*2;while(rel<-Math.PI)rel+=Math.PI*2;
    const side=rel>0?1:-1, sa=p.br+side*Math.PI/2;
    for(let i=0;i<sh.count;i++){
      const off=(i-1)*4;
      const ox=p.bx+Math.sin(p.br)*off+Math.sin(sa)*5;
      const oz=p.bz+Math.cos(p.br)*off+Math.cos(sa)*5;
      const sp=(i-1)*7;
      mkCB(p,ox,oz,p.ax+Math.sin(p.br)*sp,p.az+Math.cos(p.br)*sp,dist);
    }
  }
}

function mkCB(p,sx,sz,tx,tz,dist) {
  const d=Math.max(1,Math.hypot(tx-sx,tz-sz)), spd=2.5, fl=dist/spd/20;
  cbs.push({x:sx,z:sz,y:3.5,vx:(tx-sx)/d*spd,vz:(tz-sz)/d*spd,vy:fl*0.4,ow:p.id,born:Date.now()});
}

// Ghost cleanup
setInterval(()=>{
  const c=new Set();for(const[id]of io.of('/').sockets)c.add(id);
  for(const id in players)if(!c.has(id)){delete players[id];io.emit('left',id)}
},5000);

// GAME LOOP
setInterval(()=>{
  const now=Date.now();
  for(const id in players){
    const p=players[id]; if(!p.alive)continue;
    const I=p.inp, sh=SHIPS[p.ship];

    if(p.ob){
      if(I.left)p.br+=sh.turn; if(I.right)p.br-=sh.turn;
      const mx=[0,sh.speed*0.45,sh.speed][p.sails];
      if(I.fwd)p.bs=Math.min(p.bs+0.04,mx);
      else if(I.back)p.bs=Math.max(p.bs-0.04,-mx*0.2);
      else{if(p.sails===0)p.bs*=0.95;else p.bs+=(mx*0.7-p.bs)*0.008}
      p.bx+=Math.sin(p.br)*p.bs;p.bz+=Math.cos(p.br)*p.bs;
      const h=MAP/2;p.bx=Math.max(-h,Math.min(h,p.bx));p.bz=Math.max(-h,Math.min(h,p.bz));
      for(const il of islands){const d=Math.hypot(p.bx-il.x,p.bz-il.z),m=il.r+8;
        if(d<m){const a=Math.atan2(p.bx-il.x,p.bz-il.z);p.bx=il.x+Math.sin(a)*m;p.bz=il.z+Math.cos(a)*m;p.bs*=0.2}}
      p.cx=p.bx;p.cz=p.bz;p.cr=p.br;
      if(I.act&&!p.actP){p.actP=true;const s=nearShore(p.bx,p.bz);
        if(s){const a=Math.atan2(p.bx-s.x,p.bz-s.z);p.cx=s.x+Math.sin(a)*(s.r-5);p.cz=s.z+Math.cos(a)*(s.r-5);p.cy=3;p.cr=a;p.ob=false;p.swim=false}}
      if(!I.act)p.actP=false;
    } else {
      if(I.left)p.cr+=0.06;if(I.right)p.cr-=0.06;
      let mx=0,mz=0;
      if(I.fwd){mx=Math.sin(p.cr)*WALK;mz=Math.cos(p.cr)*WALK}
      if(I.back){mx=-Math.sin(p.cr)*WALK*0.5;mz=-Math.cos(p.cr)*WALK*0.5}
      const nx=p.cx+mx,nz=p.cz+mz;
      const ob=hitRock(nx,nz,1);
      if(!ob){p.cx=nx;p.cz=nz}else{const a=Math.atan2(nx-ob.x,nz-ob.z);p.cx=ob.x+Math.sin(a)*(ob.r+1.2);p.cz=ob.z+Math.cos(a)*(ob.r+1.2)}
      if(I.jump&&p.cy<=3.1&&!p.swim)p.cvY=JUMP;
      p.cvY-=GRAV;p.cy+=p.cvY;
      const land=onLand(p.cx,p.cz),gy=land?3:-0.5;
      if(p.cy<gy){p.cy=gy;p.cvY=0}
      if(!land){if(!p.swim){p.swim=true;p.swimT=now}
        if(now-p.swimT>DROWN){p.hp-=60;if(p.hp<=0){resp(p);io.to(id).emit('sunk',{by:'the sea'})}
          else{p.ob=true;p.swim=false;p.cx=p.bx;p.cz=p.bz;p.cy=0}}}
      else p.swim=false;
      if(I.act&&!p.actP){p.actP=true;if(Math.hypot(p.cx-p.bx,p.cz-p.bz)<EMBARK){p.ob=true;p.swim=false;p.cx=p.bx;p.cz=p.bz;p.cy=0}}
      if(!I.act)p.actP=false;
    }
  }

  for(let i=cbs.length-1;i>=0;i--){
    const c=cbs[i];c.x+=c.vx;c.z+=c.vz;c.y+=c.vy;c.vy-=0.04;
    if(now-c.born>CB_LIFE||c.y<-1){cbs.splice(i,1);continue}
    for(const id in players){if(id===c.ow)continue;const p=players[id];if(!p.alive)continue;
      if(Math.hypot(c.x-p.bx,c.z-p.bz)<10){
        p.hp-=CB_DMG;cbs.splice(i,1);
        if(p.hp<=0){const k=players[c.ow];if(k){k.sc++;k.gold+=200}io.to(id).emit('sunk',{by:k?.name||'?'});resp(p)}
        break;
      }
    }
  }

  const state=fullState();
  for(const[sid]of io.of('/').sockets){
    const p=players[sid];
    if(p&&now-p.joinT<5000)io.to(sid).emit('s',state);
    else io.to(sid).volatile.emit('s',state);
  }
},1000/TICK);

function resp(p){const s=spawn();p.bx=s.x;p.bz=s.z;p.br=Math.random()*Math.PI*2;p.bs=0;p.cx=s.x;p.cz=s.z;p.cy=0;p.cr=p.br;p.ob=true;p.swim=false;p.hp=SHIPS[p.ship].hp;p.mhp=SHIPS[p.ship].hp;p.sails=1;p.alive=true}

server.listen(process.env.PORT||3000,()=>console.log('Krew3D running'));
