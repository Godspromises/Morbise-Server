╔══════════════════════════════════════════════════════════════╗
║        MORBISE SERVER — DEPLOYMENT GUIDE                     ║
║        Phases 5 + 6 + 7 — Live Quiz Backend                 ║
╚══════════════════════════════════════════════════════════════╝

WHAT THIS SERVER DOES
──────────────────────
• Creates and manages live quiz sessions
• Lets phone participants join via QR code or URL
• Syncs questions, timer, and answers in real time
  between the desktop moderator, projector, and phones
• Scores answers as they come in
• Serves the participant join page (/join/CODE)

QUICK DEPLOY — RAILWAY (recommended, free to start)
─────────────────────────────────────────────────────
1. Create a free account at https://railway.app

2. Install Railway CLI (optional but faster):
      npm install -g @railway/cli
      railway login

3. Push this folder to GitHub:
      git init
      git add .
      git commit -m "Morbise Server v1.0"
      git remote add origin https://github.com/YOUR_NAME/morbise-server.git
      git push -u origin main

4. In Railway dashboard:
      New Project → Deploy from GitHub → select morbise-server

5. Add environment variables in Railway dashboard:
      BASE_URL = https://YOUR-APP.railway.app
      NODE_ENV = production

6. Railway gives you a URL like:
      https://morbise-server-production.up.railway.app

7. Copy that URL into the Morbise desktop app:
      Top nav → ⚙ Server → paste URL → Test Connection → Save

8. OPTIONAL — point your own domain:
      In Railway: Settings → Custom Domain → add api.morbise.app
      In your DNS: add CNAME api → your-app.railway.app
      Update BASE_URL to https://api.morbise.app

QUICK DEPLOY — RENDER (alternative free option)
────────────────────────────────────────────────
1. Go to https://render.com → New Web Service
2. Connect your GitHub repo
3. Build command:  npm install
4. Start command:  node server.js
5. Add env vars:   BASE_URL, NODE_ENV=production
6. Deploy

LOCAL DEVELOPMENT
──────────────────
1. Install dependencies:
      npm install

2. Copy env file:
      cp .env.example .env
      (edit .env — set BASE_URL=http://localhost:3000)

3. Run server:
      npm start          (production)
      npm run dev        (with auto-restart via nodemon)

4. Test it:
      http://localhost:3000/health
      http://localhost:3000/join/TEST12

5. In the desktop app:
      ⚙ Server → http://localhost:3000 → Test → Save

API ENDPOINTS
──────────────
POST /api/session/create        Create a new live session
GET  /api/session/:code         Get session info (phone checks this)
POST /api/session/:code/join    Participant joins session
POST /api/session/:code/answer  Participant submits answer
GET  /api/session/:code/state   Get current quiz state (HTTP fallback)
GET  /api/session/:code/leaderboard  Get leaderboard
POST /api/session/:code/end     End the session
GET  /health                    Health check

WEBSOCKET
──────────
Connect: ws://YOUR-SERVER/live?code=ABC123&role=moderator|projector|participant&participantId=...

Moderator sends:  moderatorState, revealAnswer, nextQuestion, kickParticipant
Server sends:     init, quizState, answerReceived, participantJoined, sessionEnded

DATABASE
─────────
SQLite (better-sqlite3) — single file, zero config.
For production scale → swap to PostgreSQL by changing the DB init block.
Railway provides a PostgreSQL plugin at one click if you need it later.

FILE STRUCTURE
───────────────
server.js          Main server (Express + WebSocket + SQLite)
public/
  join.html        Phone participant page (/join/CODE)
package.json       Dependencies
railway.toml       Railway deployment config
.env.example       Environment variables template
.gitignore         Git ignore rules

PARTICIPANT FLOW (phone)
─────────────────────────
1. Moderator opens Moderator tab → Live Session panel shows QR + code
2. Participant scans QR → lands on /join/CODE
3. Enters name + school → joins session
4. Waiting room shows until host starts
5. Questions appear as moderator reveals them
6. Answers submitted in real time
7. Answer revealed → participant sees ✔ Correct or ✗ Wrong
8. Top 5 leaderboard shown after each answer
9. Session ends → final leaderboard shown

──────────────────────────────────────────────────
Morbise Quiz Engine — built for competition.
──────────────────────────────────────────────────
