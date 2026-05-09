# osumaps backend

Python backend for audio analysis (librosa). The frontend keeps audio client-side by default.

## run

```bash
python -m venv .venv
.venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

## endpoints

- `GET /health`
- `POST /analyze/bpm` with multipart form field `audio` (`.mp3` or `.flac`), returns bpm + beats + beat-level energy and centroid features
- `POST /generate/timing-points` from detected BPM + beats
- `POST /generate/hit-objects` from beat features

## vercel route

when deployed with root `vercel.json`, api is served under `/api/*`

