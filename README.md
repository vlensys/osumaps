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

backend:

```bash
cd backend
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

## current progress

1. audio upload (mp3/flac) with drag/drop
2. local preview + basic metadata fields
3. beat detection + bpm calculation via librosa endpoint (`POST /analyze/bpm`)
4. timing point generation (`POST /generate/timing-points`)

next: note pattern generation from audio features

