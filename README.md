# 🏴‍☠️ Krew3D - Multiplayer Pirate Battle

A 3D multiplayer pirate ship battle game inspired by Krew.io, built with Three.js and Socket.io.

## Features
- 3D ocean with animated waves
- Ship controls with sails system (furled/half/full)
- Broadside cannon fire
- Multiplayer via WebSockets
- Minimap, scoreboard, health bar
- Island collision & map boundaries
- Respawn system

## Local Development

```bash
npm install
npm start
# Open http://localhost:3000
```

## Deploy to Render.com (FREE)

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
5. Deploy!

## Deploy to Glitch.com (FREE)

1. Go to [glitch.com](https://glitch.com) → New Project → Import from GitHub
2. Paste your GitHub URL
3. It auto-deploys!

## Deploy to Railway.app

1. Go to [railway.app](https://railway.app)
2. New Project → Deploy from GitHub
3. It auto-detects Node.js and deploys

## Controls

| Key | Action |
|-----|--------|
| W / ↑ | Forward |
| S / ↓ | Backward |
| A / ← | Turn left |
| D / → | Turn right |
| Space | Fire cannons |
| 1 | Furl sails (stop) |
| 2 | Half sail |
| 3 | Full sail |

## Tech Stack
- **Frontend:** Three.js (3D), vanilla JS
- **Backend:** Node.js, Express, Socket.io
- **Multiplayer:** WebSocket (Socket.io) with server-authoritative game loop

## Next Steps
- [ ] Better ship models
- [ ] Treasure/loot system
- [ ] Ship upgrades
- [ ] Team system
- [ ] Chat
- [ ] Sound effects
- [ ] Mobile controls
