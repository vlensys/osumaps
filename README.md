# osumaps

audio-to-osu! lazer map converter web app.

## stack

- frontend: react + tailwind (vite)
- backend: python + fastapi + librosa
- hosting plan: github pages for frontend, vercel fallback for backend api if needed

## local run

```bash
npm install
npm run dev
```

frontend env:

```bash
cp .env.example .env
```

set `VITE_API_BASE`:
- local backend: `http://127.0.0.1:8000`
- deployed backend (vercel): `https://<your-vercel-project>.vercel.app/api`

backend:

```bash
cd backend
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

## deploy

frontend (github pages first):
- workflow file: `.github/workflows/deploy-pages.yml`
- on push to `master`, it builds and deploys `dist/` to pages
- keep `vite.config.js` base as `/osumaps/`

backend (vercel fallback):
- config file: `vercel.json`
- deploys `backend/main.py` as serverless python
- exposed route pattern: `/api/*`

## current progress

1. audio upload (mp3/flac) with drag/drop
2. local preview + metadata auto-fill from audio tags (fallback to filename)
3. beat detection + bpm calculation via librosa endpoint (`POST /analyze/bpm`)
4. timing point generation (`POST /generate/timing-points`)
5. note pattern generation from audio features (`POST /generate/hit-objects`)
6. `.osu` export from generated metadata + timing + hit objects
7. playback sync verifier against generated hit object times
8. in-app beatmap sanity check for common spec errors before lazer import

## remaining before ship

1. run one real `.mp3` and one `.flac` end-to-end
2. import generated `.osu` into osu! lazer and pass validator
3. tune hit object generation defaults after validator feedback
4. resolve local git index lock/permission issue before normal commits

qa checklist: `docs/qa-checklist.md`

