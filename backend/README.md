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
- `POST /analyze/bpm` with multipart form field `audio` (`.mp3` or `.flac`)
- `POST /generate/timing-points` from detected BPM + beats

