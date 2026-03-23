const express=require('express'),http=require('http'),{Server}=require('socket.io'),path=require('path');
const app=express(),srv=http.createServer(app);
const io=new Server(srv,{cors:{origin:'*'},pingInterval:10000,pingTimeout:20000,transports:['polling','websocket']});
app.use(express.static(path.join(__dirname,'public')));
app.get('/healthz',(_,r)=>r.send('OK'));

const TICK=20,MAP=1600,WALK=0.6,JUMP=0.4,GRAV=0.03,DROWN=4000,EMBARK=18,SHORE=14,CB_LIFE=2500,CB_DMG=18,GOLD0=5000;

const SHIPS={
  rowboat:{name:'Rowboat',price:0,hp:80,speed:0.85,turn:0.04,cannons:'front',count:1,reload:1200,cargo:0},
  warship:{name:'War Galleon',price:2000,hp:200,speed:0.6,turn:0.025,cannons:'side',count:3,reload:2500,cargo:0},
  tradeship:{name:'Trade Schooner',price:1500,hp:130,speed:0.75,turn:0.032,cannons:'front',count:1,reload:1000,cargo:1000},
};

const GOODS={
  coffee:{name:'Coffee',size:15,icon:'☕'},
  spice:{name:'Spice',size:20,icon:'🌶'},
  beer:{name:'Beer',size:30,icon:'🍺'},
};

const ORES={iron:{name:'Iron',icon:'⛏',value:50},gold:{name:'Gold',icon:'🥇',value:150},bronze:{name:'Bronze',icon:'🔶',value:80}};

// 4 large trade islands
const islands=[
  {x:-400,z:-400,r:80,name:'Skull Isle',goods:{coffee:{price:40,stock:100},beer:{price:25,stock:80}}},
  {x:400,z:-400,r:90,name:'Palm Haven',goods:{spice:{price:55,stock:60},coffee:{price:50,stock:70}}},
  {x:400,z:400,r:75,name:'Fort Rock',goods:{beer:{price:30,stock:90},spice:{price:45,stock:50}}},
  {x:-400,z:400,r:85,name:'Treasure Cove',goods:{coffee:{price:35,stock:80},spice:{price:60,stock:40},beer:{price:20,stock:100}}},
];

// Small mining islands
const mineIslands=[
  {x:0,z:-300,r:22,name:'Iron Reef',ore:'iron'},
  {x:-200,z:0,r:18,name:'Gold Shoal',ore:'gold'},
  {x:200,z:0,r:20,name:'Bronze Atoll',ore:'bronze'},
  {x:0,z:300,r:18,name:'Copper Cay',ore:'iron'},
  {x:-150,z:-200,r:15,name:'Nugget Isle',ore:'gold'},
  {x:150,z:200,r:16,name:'Tin Rock',ore:'bronze'},
];

const allIslands=[...islands,...mineIslands];

const rocks=[];
allIslands.forEach(il=>{for(let i=0;i<Math.floor(il.r/10);i++){const a=Math.random()*Math.PI*2,d=5+Math.random()*(il.r-12);rocks.push({x:il.x+Math.cos(a)*d,z:il.z+Math.sin(a)*d,r:1.5+Math.random()*1.5})}});

// Ground items (dropped ores)
let groundItems=[];
let itemIdCounter=0;

const players={},cbs=[];
let tick=0;

function spawn(){let x,z;do{x=(Math.random()-.5)*MAP*.5;z=(Math.random()-.5)*MAP*.5}while(onLand(x,z));return{x,z}}
function onLand(x,z){for(const i of allIslands)if(Math.hypot(x-i.x,z-i.z)<i.r)return i;return null}
function nearShore(x,z){for(const i of allIslands){const d=Math.hypot(x-i.x,z-i.z);if(d<i.r+SHORE&&d>i.r-8)return i}return null}
function hitRock(x,z,r){for(const o of rocks)if(Math.hypot(x-o.x,z-o.z)<o.r+r)return o;return null}
function isMineIsland(isl){return mineIslands.includes(isl)}
function isTradeIsland(isl){return islands.includes(isl)}

function fullState(){
  const s={t:Date.now(),p:{},cb:cbs.map(c=>({x:c.x,z:c.z,y:c.y})),gi:groundItems.map(g=>({id:g.id,x:g.x,z:g.z,type:g.type}))};
  for(const id in players){const p=players[id];
    s.p[id]={cx:p.cx,cz:p.cz,cy:p.cy,cr:p.cr,bx:p.bx,bz:p.bz,br:p.br,bs:p.bs,
      sl:p.sails,ob:p.ob,sw:p.swim,hp:p.hp,mhp:p.mhp,sc:p.sc,g:p.gold,
      n:p.name,sh:p.ship,ax:p.ax,az:p.az,cargo:p.cargo,cargoUsed:p.cargoUsed,inv:p.inv,mining:p.mining}}
  return s;
}

io.on('connection',socket=>{
  const sp=spawn();
  const p={id:socket.id,name:'Pirate',
    cx:sp.x,cz:sp.z,cy:0,cr:0,cvY:0,
    bx:sp.x,bz:sp.z,br:Math.random()*Math.PI*2,bs:0,
    ob:true,swim:false,swimT:0,
    ship:'rowboat',owned:['rowboat'],
    gold:GOLD0,hp:80,mhp:80,sc:0,sails:1,alive:true,
    inp:{},lastF:0,ax:sp.x,az:sp.z+30,
    actP:false,lastAct:Date.now(),joinT:Date.now(),
    cargo:{},cargoUsed:0, // {coffee:5, beer:3}
    inv:{}, // personal inventory for ores: {iron:2, gold:1}
    mining:false,mineT:0,
  };
  players[socket.id]=p;
  socket.emit('init',{id:socket.id,islands,mineIslands,rocks,map:MAP,ships:SHIPS,goods:GOODS,ores:ORES,
    state:fullState(),spawnX:sp.x,spawnZ:sp.z,spawnR:p.br});

  socket.on('input',d=>{if(players[socket.id]){players[socket.id].inp=d;players[socket.id].lastAct=Date.now()}});
  socket.on('aim',d=>{if(players[socket.id]){players[socket.id].ax=d.x||0;players[socket.id].az=d.z||0}});
  socket.on('fire',()=>{const p=players[socket.id];if(!p||!p.ob||!p.alive)return;const now=Date.now(),sh=SHIPS[p.ship];if(now-p.lastF<sh.reload)return;p.lastF=now;fire(p)});
  socket.on('setSails',l=>{if(players[socket.id])players[socket.id].sails=Math.max(0,Math.min(2,l))});
  socket.on('setName',n=>{if(players[socket.id]&&n&&typeof n==='string')players[socket.id].name=n.trim().substring(0,16)});
  socket.on('buy',t=>{const p=players[socket.id];if(!p||!SHIPS[t])return;if(p.owned.includes(t))return socket.emit('msg','Already owned!');if(p.gold<SHIPS[t].price)return socket.emit('msg','Not enough gold!');p.gold-=SHIPS[t].price;p.owned.push(t);socket.emit('msg',`Bought ${SHIPS[t].name}!`);socket.emit('upd',{gold:p.gold,owned:p.owned})});
  socket.on('equip',t=>{const p=players[socket.id];if(!p||!p.owned.includes(t))return;p.ship=t;const sh=SHIPS[t];p.mhp=sh.hp;p.hp=sh.hp;p.cargo={};p.cargoUsed=0;socket.emit('upd',{ship:t,hp:p.hp,mhp:p.mhp})});
  socket.on('tp',pos=>{const p=players[socket.id];if(!p)return;p.bx=pos.x;p.bz=pos.z;p.cx=pos.x;p.cz=pos.z;p.bs=0;if(!p.ob){p.ob=true;p.swim=false}});

  // Trading
  socket.on('buyGood',(d)=>{
    const p=players[socket.id];if(!p||p.ob)return; // must be on land
    const{good,qty,islIdx}=d;if(!GOODS[good]||qty<=0)return;
    const isl=islands[islIdx];if(!isl||!isl.goods[good])return;
    const cap=SHIPS[p.ship].cargo;if(!cap)return socket.emit('msg','Ship has no cargo!');
    const gd=GOODS[good],ig=isl.goods[good];
    const maxQty=Math.min(qty,ig.stock,Math.floor((cap-p.cargoUsed)/gd.size));
    if(maxQty<=0)return socket.emit('msg','No space or stock!');
    const cost=maxQty*ig.price;
    if(p.gold<cost)return socket.emit('msg','Not enough gold!');
    p.gold-=cost;ig.stock-=maxQty;
    p.cargo[good]=(p.cargo[good]||0)+maxQty;
    p.cargoUsed+=maxQty*gd.size;
    socket.emit('msg',`Bought ${maxQty} ${GOODS[good].name}`);
  });
  socket.on('sellGood',(d)=>{
    const p=players[socket.id];if(!p||p.ob)return;
    const{good,qty,islIdx}=d;if(!GOODS[good]||qty<=0)return;
    const isl=islands[islIdx];if(!isl||!isl.goods[good])return;
    const have=p.cargo[good]||0;const sell=Math.min(qty,have);if(sell<=0)return;
    const price=Math.round(isl.goods[good].price*1.3); // sell at 30% markup
    p.gold+=sell*price;
    p.cargo[good]-=sell;if(p.cargo[good]<=0)delete p.cargo[good];
    p.cargoUsed-=sell*GOODS[good].size;
    socket.emit('msg',`Sold ${sell} ${GOODS[good].name} for ${sell*price}g`);
  });

  // Sell ore
  socket.on('sellOre',(d)=>{
    const p=players[socket.id];if(!p||p.ob)return;
    const{ore,qty}=d;if(!ORES[ore]||qty<=0)return;
    const have=p.inv[ore]||0;const sell=Math.min(qty,have);if(sell<=0)return;
    p.gold+=sell*ORES[ore].value;
    p.inv[ore]-=sell;if(p.inv[ore]<=0)delete p.inv[ore];
    socket.emit('msg',`Sold ${sell} ${ORES[ore].name} for ${sell*ORES[ore].value}g`);
  });

  // Deposit ores from inv to... gold (sell at any island)
  socket.on('mine',()=>{
    const p=players[socket.id];if(!p||p.ob||p.mining)return;
    const land=onLand(p.cx,p.cz);if(!land)return;
    const mi=mineIslands.find(m=>m===land);if(!mi)return;
    p.mining=true;p.mineT=Date.now();
  });

  // Pick up ground item
  socket.on('pickup',itemId=>{
    const p=players[socket.id];if(!p||p.ob)return;
    const idx=groundItems.findIndex(g=>g.id===itemId);if(idx===-1)return;
    const gi=groundItems[idx];
    if(Math.hypot(p.cx-gi.x,p.cz-gi.z)>5)return;
    p.inv[gi.type]=(p.inv[gi.type]||0)+1;
    groundItems.splice(idx,1);
  });

  socket.on('heartbeat',()=>{if(players[socket.id])players[socket.id].lastAct=Date.now()});
  socket.on('disconnect',()=>{delete players[socket.id];io.emit('left',socket.id)});
});

function fire(p){
  const sh=SHIPS[p.ship],dx=p.ax-p.bx,dz=p.az-p.bz;
  const dist=Math.max(20,Math.min(180,Math.hypot(dx,dz)));
  if(sh.cannons==='front'){mkCB(p,p.bx+Math.sin(p.br)*6,p.bz+Math.cos(p.br)*6,p.ax,p.az,dist)}
  else{const aim=Math.atan2(dx,dz);let rel=aim-p.br;while(rel>Math.PI)rel-=Math.PI*2;while(rel<-Math.PI)rel+=Math.PI*2;
    const side=rel>0?1:-1,sa=p.br+side*Math.PI/2;
    for(let i=0;i<sh.count;i++){const off=(i-1)*4;
      mkCB(p,p.bx+Math.sin(p.br)*off+Math.sin(sa)*5,p.bz+Math.cos(p.br)*off+Math.cos(sa)*5,
        p.ax+Math.sin(p.br)*(i-1)*7,p.az+Math.cos(p.br)*(i-1)*7,dist)}}
}
function mkCB(p,sx,sz,tx,tz,dist){
  const d=Math.max(1,Math.hypot(tx-sx,tz-sz)),spd=2.8,fl=dist/spd/20;
  cbs.push({x:sx,z:sz,y:3.5,vx:(tx-sx)/d*spd,vz:(tz-sz)/d*spd,vy:fl*0.45,ow:p.id,born:Date.now()});
}

setInterval(()=>{const c=new Set();for(const[id]of io.of('/').sockets)c.add(id);
  for(const id in players)if(!c.has(id)){delete players[id];io.emit('left',id)}},5000);

// GAME LOOP
setInterval(()=>{
  const now=Date.now();tick++;
  for(const id in players){
    const p=players[id];if(!p.alive)continue;const I=p.inp,sh=SHIPS[p.ship];

    if(p.ob){
      if(I.left)p.br+=sh.turn;if(I.right)p.br-=sh.turn;
      const mx=[0,sh.speed*.45,sh.speed][p.sails];
      if(I.fwd)p.bs=Math.min(p.bs+0.04,mx);
      else if(I.back)p.bs=Math.max(p.bs-0.04,-mx*.2);
      else{if(p.sails===0)p.bs*=.95;else p.bs+=(mx*.7-p.bs)*.008}
      p.bx+=Math.sin(p.br)*p.bs;p.bz+=Math.cos(p.br)*p.bs;
      const h=MAP/2;p.bx=Math.max(-h,Math.min(h,p.bx));p.bz=Math.max(-h,Math.min(h,p.bz));
      for(const il of allIslands){const d=Math.hypot(p.bx-il.x,p.bz-il.z),m=il.r+6;
        if(d<m){const a=Math.atan2(p.bx-il.x,p.bz-il.z);p.bx=il.x+Math.sin(a)*m;p.bz=il.z+Math.cos(a)*m;p.bs*=.2}}
      p.cx=p.bx;p.cz=p.bz;p.cr=p.br;
      if(I.act&&!p.actP){p.actP=true;const s=nearShore(p.bx,p.bz);
        if(s){const a=Math.atan2(p.bx-s.x,p.bz-s.z);p.cx=s.x+Math.sin(a)*(s.r-4);p.cz=s.z+Math.cos(a)*(s.r-4);p.cy=3;p.cr=a;p.ob=false;p.swim=false;p.mining=false}}
      if(!I.act)p.actP=false;
    }else{
      if(I.left)p.cr+=.06;if(I.right)p.cr-=.06;
      let mx=0,mz=0;
      if(I.fwd){mx=Math.sin(p.cr)*WALK;mz=Math.cos(p.cr)*WALK}
      if(I.back){mx=-Math.sin(p.cr)*WALK*.5;mz=-Math.cos(p.cr)*WALK*.5}
      const nx=p.cx+mx,nz=p.cz+mz;
      const ob=hitRock(nx,nz,1);
      if(!ob){p.cx=nx;p.cz=nz}else{const a=Math.atan2(nx-ob.x,nz-ob.z);p.cx=ob.x+Math.sin(a)*(ob.r+1.2);p.cz=ob.z+Math.cos(a)*(ob.r+1.2)}
      // Fast jump
      if(I.jump&&p.cy<=3.05&&!p.swim)p.cvY=JUMP;
      p.cvY-=GRAV;p.cy+=p.cvY;
      const land=onLand(p.cx,p.cz),gy=land?3:-.5;
      if(p.cy<gy){p.cy=gy;p.cvY=0}
      if(!land){if(!p.swim){p.swim=true;p.swimT=now}
        if(now-p.swimT>DROWN){p.hp-=60;if(p.hp<=0){resp(p);io.to(id).emit('sunk',{by:'the sea'})}
          else{p.ob=true;p.swim=false;p.cx=p.bx;p.cz=p.bz;p.cy=0}}}
      else{p.swim=false;
        // Mining logic
        if(p.mining&&land){const mi=mineIslands.find(m=>m===land);
          if(mi&&now-p.mineT>2000){p.mining=false;
            // Drop ore
            const a=Math.random()*Math.PI*2;
            groundItems.push({id:++itemIdCounter,x:p.cx+Math.cos(a)*3,z:p.cz+Math.sin(a)*3,type:mi.ore});
          }
        }
      }
      // Auto-pickup nearby items
      for(let i=groundItems.length-1;i>=0;i--){
        const gi=groundItems[i];
        if(Math.hypot(p.cx-gi.x,p.cz-gi.z)<3){
          p.inv[gi.type]=(p.inv[gi.type]||0)+1;
          groundItems.splice(i,1);
        }
      }
      if(I.act&&!p.actP){p.actP=true;if(Math.hypot(p.cx-p.bx,p.cz-p.bz)<EMBARK){p.ob=true;p.swim=false;p.cx=p.bx;p.cz=p.bz;p.cy=0;p.mining=false}}
      if(!I.act)p.actP=false;
    }
  }

  // Cannonballs - fast removal
  for(let i=cbs.length-1;i>=0;i--){
    const c=cbs[i];c.x+=c.vx;c.z+=c.vz;c.y+=c.vy;c.vy-=.045;
    if(c.y<0||now-c.born>CB_LIFE){cbs.splice(i,1);continue} // instant remove on water hit
    for(const id in players){if(id===c.ow)continue;const p=players[id];if(!p.alive)continue;
      if(Math.hypot(c.x-p.bx,c.z-p.bz)<10){
        p.hp-=CB_DMG;cbs.splice(i,1);
        if(p.hp<=0){const k=players[c.ow];if(k){k.sc++;k.gold+=200}io.to(id).emit('sunk',{by:k?.name||'?'});resp(p)}break}}}

  // Broadcast with timestamp
  const state=fullState();
  for(const[sid]of io.of('/').sockets){
    const p=players[sid];
    if(p&&now-p.joinT<3000)io.to(sid).emit('s',state);
    else io.to(sid).volatile.emit('s',state);
  }
},1000/TICK);

function resp(p){const s=spawn();p.bx=s.x;p.bz=s.z;p.br=Math.random()*Math.PI*2;p.bs=0;p.cx=s.x;p.cz=s.z;p.cy=0;p.cr=p.br;p.ob=true;p.swim=false;p.mining=false;p.hp=SHIPS[p.ship].hp;p.mhp=SHIPS[p.ship].hp;p.sails=1;p.alive=true}

srv.listen(process.env.PORT||3000,()=>console.log('Krew3D running'));
