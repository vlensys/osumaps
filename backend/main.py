from __future__ import annotations

import tempfile
from pathlib import Path

import librosa
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

app = FastAPI(title="osumaps backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class BpmAnalysisResponse(BaseModel):
    bpm: float
    beats: list[float]
    beat_count: int
    duration_sec: float


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/analyze/bpm", response_model=BpmAnalysisResponse)
async def analyze_bpm(audio: UploadFile = File(...)) -> BpmAnalysisResponse:
    suffix = Path(audio.filename or "track.mp3").suffix.lower()
    if suffix not in {".mp3", ".flac"}:
        raise HTTPException(status_code=400, detail="only .mp3 and .flac are supported")

    payload = await audio.read()
    if not payload:
        raise HTTPException(status_code=400, detail="empty file")

    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
            handle.write(payload)
            temp_path = Path(handle.name)

        signal, sample_rate = librosa.load(temp_path.as_posix(), sr=None, mono=True)
        tempo, beat_frames = librosa.beat.beat_track(y=signal, sr=sample_rate, units="frames")
        beat_times = librosa.frames_to_time(beat_frames, sr=sample_rate).tolist()
        duration = librosa.get_duration(y=signal, sr=sample_rate)

        bpm_value = float(tempo[0] if hasattr(tempo, "__len__") else tempo)
        return BpmAnalysisResponse(
            bpm=round(bpm_value, 3),
            beats=[round(float(time), 4) for time in beat_times],
            beat_count=len(beat_times),
            duration_sec=round(float(duration), 4),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"bpm analysis failed: {exc}") from exc
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)

