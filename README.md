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

next: beat detection + bpm calculation

