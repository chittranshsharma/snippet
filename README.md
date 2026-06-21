# Snippet — multiplayer music guessing game

A real-time, server-authoritative music guessing game. Listen to a short song
snippet, pick the right track from four options — faster answers score more.

## Stack
- **Server** — Node.js + Socket.IO (`server.js`), iTunes preview API (`itunesFetcher.js`)
- **Client** — React + Vite + Tailwind (`client/`)

## How it works
- Single room, up to 8 players, 10 rounds.
- State machine: `LOBBY → ROUND_PLAYING → ROUND_REVEAL → GAME_OVER`.
- The **server is the only source of truth**: it holds the correct answer, runs
  the round clock, validates guesses, and computes every score. The correct
  answer is never sent to clients during a round.
- **Scoring**: escalating question value (`300 + roundIndex * 250`) plus a linear
  speed bonus (max 350). Settled only after the round ends.
- **Audio**: 30s iTunes previews, played from a random offset, stopped after 10s
  client-side.

## Run it
```bash
# 1. game server (port 3000)
node server.js

# 2. client (port 5173) — Vite proxies /socket.io to :3000
cd client && npm install && npm run dev
```

Open http://localhost:5173 in two tabs to play with a friend.
