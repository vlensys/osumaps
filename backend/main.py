from __future__ import annotations

import tempfile
from pathlib import Path
from statistics import median

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


class TimingPoint(BaseModel):
    time: float
    beat_length: float
    meter: int
    sample_set: int
    sample_index: int
    volume: int
    uninherited: int
    effects: int
    line: str


class TimingPointRequest(BaseModel):
    bpm: float
    beats: list[float]
    meter: int = 4
    sample_set: int = 1
    sample_index: int = 0
    volume: int = 70
    effects: int = 0


class TimingPointResponse(BaseModel):
    timing_points: list[TimingPoint]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


def _format_timing_line(
    time_ms: float,
    beat_length: float,
    meter: int,
    sample_set: int,
    sample_index: int,
    volume: int,
    effects: int,
) -> str:
    return (
        f"{time_ms:.3f},{beat_length:.6f},{meter},{sample_set},{sample_index},{volume},1,{effects}"
    )


def _generate_uninherited_points(payload: TimingPointRequest) -> list[TimingPoint]:
    beats = sorted([float(value) for value in payload.beats if value >= 0])
    if payload.bpm <= 0:
        raise HTTPException(status_code=400, detail="bpm must be positive")

    beat_length_from_bpm = 60000.0 / payload.bpm
    meter = max(1, payload.meter)
    sample_set = min(max(payload.sample_set, 0), 3)
    sample_index = max(payload.sample_index, 0)
    volume = min(max(payload.volume, 0), 100)

    if len(beats) < 2:
        start_time_ms = beats[0] * 1000 if beats else 0.0
        line = _format_timing_line(
            start_time_ms,
            beat_length_from_bpm,
            meter,
            sample_set,
            sample_index,
            volume,
            payload.effects,
        )
        return [
            TimingPoint(
                time=round(start_time_ms, 3),
                beat_length=round(beat_length_from_bpm, 6),
                meter=meter,
                sample_set=sample_set,
                sample_index=sample_index,
                volume=volume,
                uninherited=1,
                effects=payload.effects,
                line=line,
            )
        ]

    intervals_ms: list[float] = []
    interval_start_indices: list[int] = []
    for i in range(len(beats) - 1):
        interval = (beats[i + 1] - beats[i]) * 1000.0
        if interval > 0:
            intervals_ms.append(interval)
            interval_start_indices.append(i)

    if not intervals_ms:
        start_time_ms = beats[0] * 1000
        line = _format_timing_line(
            start_time_ms,
            beat_length_from_bpm,
            meter,
            sample_set,
            sample_index,
            volume,
            payload.effects,
        )
        return [
            TimingPoint(
                time=round(start_time_ms, 3),
                beat_length=round(beat_length_from_bpm, 6),
                meter=meter,
                sample_set=sample_set,
                sample_index=sample_index,
                volume=volume,
                uninherited=1,
                effects=payload.effects,
                line=line,
            )
        ]

    sections: list[tuple[int, list[float]]] = []
    current_start = interval_start_indices[0]
    current_values: list[float] = [intervals_ms[0]]
    change_threshold = 0.04
    min_beats_per_section = 3

    for idx in range(1, len(intervals_ms)):
        candidate = intervals_ms[idx]
        reference = median(current_values)
        drift_ratio = abs(candidate - reference) / reference if reference > 0 else 0.0

        if drift_ratio >= change_threshold and len(current_values) >= min_beats_per_section:
            sections.append((current_start, current_values))
            current_start = interval_start_indices[idx]
            current_values = [candidate]
            continue
        current_values.append(candidate)

    sections.append((current_start, current_values))

    timing_points: list[TimingPoint] = []
    for section_start_index, section_values in sections:
        start_time_ms = beats[section_start_index] * 1000.0
        raw_beat_length = float(median(section_values))
        beat_length = raw_beat_length if raw_beat_length > 0 else beat_length_from_bpm
        line = _format_timing_line(
            start_time_ms,
            beat_length,
            meter,
            sample_set,
            sample_index,
            volume,
            payload.effects,
        )
        timing_points.append(
            TimingPoint(
                time=round(start_time_ms, 3),
                beat_length=round(beat_length, 6),
                meter=meter,
                sample_set=sample_set,
                sample_index=sample_index,
                volume=volume,
                uninherited=1,
                effects=payload.effects,
                line=line,
            )
        )

    return timing_points


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


@app.post("/generate/timing-points", response_model=TimingPointResponse)
def generate_timing_points(payload: TimingPointRequest) -> TimingPointResponse:
    points = _generate_uninherited_points(payload)
    return TimingPointResponse(timing_points=points)

