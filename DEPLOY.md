# Deploying Snippet

Two services:

- **Backend** (`server.js` + `itunesFetcher.js`) → **Railway**. It runs a
  persistent Socket.IO server with in-memory rooms, so it must be a long-running
  container (NOT serverless).
- **Frontend** (`client/`, Vite + React) → **Vercel** as a static site.

The frontend connects to the backend over `wss://` using `VITE_SOCKET_URL`.

---

## 1. Backend → Railway

1. Push this repo to GitHub (already at `am1t27/snippet`).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
3. Root directory: **repo root** (where `server.js` + root `package.json` live).
   Railway auto-detects Node and runs `npm start` (= `node server.js`).
4. **Variables** (Railway → Variables):
   - `CLIENT_ORIGIN` = your Vercel URL, e.g. `https://snippet.vercel.app`
     (comma-separate if you have several; locks CORS down from `*`).
   - `PORT` is provided by Railway automatically — the server already reads it.
   - `GOOGLE_CLIENT_ID` = (Phase 2, see below).
5. Deploy. Railway gives a public URL like `https://snippet-production.up.railway.app`.
   Verify: open `/` — you should see `{"ok":true,"rooms":0,"players":0}`.

> Note: in-memory rooms reset on every redeploy/restart, and you can only run a
> single instance (no Redis adapter yet). Fine for launch; revisit for scale.

---

## 2. Frontend → Vercel

1. Vercel → **Add New → Project** → import the same repo.
2. **Root Directory: `client`** (important — the app lives there).
3. Framework preset: **Vite** (auto). Build `npm run build`, output `dist` (auto).
   `client/vercel.json` adds the SPA rewrite so `?room=CODE` links resolve.
4. **Environment Variables**:
   - `VITE_SOCKET_URL` = your Railway URL from step 1
     (e.g. `https://snippet-production.up.railway.app`).
   - `VITE_GOOGLE_CLIENT_ID` = (Phase 2).
5. Deploy → you get `https://snippet.vercel.app`.

---

## 3. Wire CORS

Once you have the Vercel URL, set `CLIENT_ORIGIN` on Railway to it and redeploy
the backend. (If `CLIENT_ORIGIN` is unset, CORS falls back to `*` — okay for a
first test, lock it down after.)

---

## 4. Google OAuth (wired — just add your client ID)

The sign-in flow is implemented (Google Identity Services button → server-side
ID-token verification). Without a client ID set it stays hidden and everyone
plays as a guest. To enable it, in **Google Cloud Console → APIs & Services →
Credentials**:

1. **Create OAuth client ID → Web application**.
2. **Authorized JavaScript origins**: your Vercel URL (and
   `http://localhost:5173` for dev).
3. Copy the **Client ID** into:
   - Vercel env `VITE_GOOGLE_CLIENT_ID`
   - Railway env `GOOGLE_CLIENT_ID`
4. No client secret is needed — the app uses Google Identity Services to get an
   ID token client-side, then the server verifies it. (You enter these values in
   the dashboards yourself; they never go in the repo.)

---

## 5. Test

- Open the Vercel URL, enter a handle, **Create Room** → you get a 4-char code.
- Open the `Copy link` URL (or `?room=CODE`) in another browser/phone, enter a
  handle, **Join** → both land in the same room.
- Host starts; play a round; confirm audio + scoring.

## Local dev (unchanged)

```bash
node server.js                 # backend :3000
cd client && npm run dev       # frontend :5173 (proxies to :3000)
```
