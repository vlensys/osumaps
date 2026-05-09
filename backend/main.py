from __future__ import annotations

import tempfile
from pathlib import Path
import math
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
    beat_strengths: list[float]
    beat_centroids: list[float]


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


class HitObject(BaseModel):
    x: int
    y: int
    time: int
    object_type: int
    hit_sound: int
    hit_sample: str
    line: str


class HitObjectRequest(BaseModel):
    beats: list[float]
    beat_strengths: list[float] = []
    beat_centroids: list[float] = []
    max_notes: int = 400
    density: float = 0.75
    difficulty_star: float = 5.0


class HitObjectResponse(BaseModel):
    hit_objects: list[HitObject]


@app.get("/health")
@app.get("/api/health")
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


def _normalize(values: list[float]) -> list[float]:
    if not values:
        return []
    minimum = min(values)
    maximum = max(values)
    if maximum <= minimum:
        return [0.5 for _ in values]
    scale = maximum - minimum
    return [(value - minimum) / scale for value in values]


def _generate_hit_objects(payload: HitObjectRequest) -> list[HitObject]:
    beats = [float(value) for value in payload.beats if value >= 0]
    if not beats:
        raise HTTPException(status_code=400, detail="beats cannot be empty")

    max_notes = min(max(payload.max_notes, 1), 2000)
    density = min(max(payload.density, 0.1), 1.0)
    star = min(max(payload.difficulty_star, 0.5), 10.0)

    strength_values = payload.beat_strengths[: len(beats)] if payload.beat_strengths else [1.0] * len(beats)
    centroid_values = payload.beat_centroids[: len(beats)] if payload.beat_centroids else [0.0] * len(beats)

    normalized_strengths = _normalize([float(value) for value in strength_values])
    normalized_centroids = _normalize([float(value) for value in centroid_values])
    if not normalized_centroids:
        normalized_centroids = [0.5] * len(beats)

    sorted_strengths = sorted(normalized_strengths)
    quantile_index = int((1.0 - density) * (len(sorted_strengths) - 1))
    threshold = sorted_strengths[quantile_index] if sorted_strengths else 0.0

    # osu! standard playfield is 512x384
    cs = min(max(2.5 + star * 0.35, 2.0), 7.0)
    radius = (54.4 - 4.48 * cs) * 1.00041
    margin = int(max(radius + 8, 24))
    min_x, max_x = margin, 512 - margin
    min_y, max_y = margin, 384 - margin

    base_min_jump = 16.0 + 4.5 * star
    base_max_jump = 54.0 + 13.0 * star
    min_note_distance = max(radius * 0.95, 20.0 + 1.5 * star)

    intervals = []
    for i in range(len(beats) - 1):
        intervals.append(max(0.001, beats[i + 1] - beats[i]))
    default_interval = sum(intervals) / len(intervals) if intervals else 0.5

    hit_objects: list[HitObject] = []
    last_time = -10_000
    current_x = 256.0
    current_y = 192.0
    angle = 0.0

    def clamp(value: float, lo: float, hi: float) -> float:
        return max(lo, min(hi, value))

    for index, beat_sec in enumerate(beats):
        if len(hit_objects) >= max_notes:
            break
        strength = normalized_strengths[index] if index < len(normalized_strengths) else 0.5
        centroid = normalized_centroids[index] if index < len(normalized_centroids) else 0.5

        # Drop lower-energy beats to prevent overmapping.
        if strength < threshold and index % 2 == 1:
            continue

        time_ms = int(round(beat_sec * 1000))
        if time_ms - last_time < 70:
            continue

        interval = intervals[index] if index < len(intervals) else default_interval
        interval_ratio = clamp(interval / max(default_interval, 0.001), 0.5, 1.75)
        interval_factor = (interval_ratio - 0.5) / (1.75 - 0.5)
        # time-distance-equality base: shorter rhythms -> smaller spacing.
        jump = base_min_jump + (base_max_jump - base_min_jump) * (0.65 * strength + 0.35 * interval_factor)

        # Use centroid as directional change driver and strength as extra movement weight.
        turn = (centroid - 0.5) * 1.9
        if strength > 0.85:
            turn += 0.35 if index % 2 == 0 else -0.35
        angle += turn

        candidate_x = current_x
        candidate_y = current_y
        found = False
        for attempt in range(14):
            step = jump * (1.0 + 0.05 * attempt)
            px = current_x + step * math.cos(angle)
            py = current_y + step * math.sin(angle)

            if px < min_x or px > max_x:
                angle = math.pi - angle
                px = clamp(px, min_x, max_x)
            if py < min_y or py > max_y:
                angle = -angle
                py = clamp(py, min_y, max_y)

            if hit_objects:
                prev = hit_objects[-1]
                dx = px - prev.x
                dy = py - prev.y
                dist = (dx * dx + dy * dy) ** 0.5
                if dist < min_note_distance:
                    angle += 0.55
                    continue

            candidate_x, candidate_y = px, py
            found = True
            break

        if not found:
            candidate_x = clamp(current_x + jump, min_x, max_x)
            candidate_y = clamp(current_y + jump * 0.2, min_y, max_y)

        current_x, current_y = candidate_x, candidate_y
        x = int(round(candidate_x))
        y = int(round(candidate_y))
        object_type = 5 if len(hit_objects) % 4 == 0 else 1
        hit_sound = 4 if strength > 0.85 else 0
        hit_sample = "0:0:0:0:"
        line = f"{x},{y},{time_ms},{object_type},{hit_sound},{hit_sample}"

        hit_objects.append(
            HitObject(
                x=x,
                y=y,
                time=time_ms,
                object_type=object_type,
                hit_sound=hit_sound,
                hit_sample=hit_sample,
                line=line,
            )
        )
        last_time = time_ms

    if not hit_objects:
        first_time = int(round(beats[0] * 1000))
        line = f"256,192,{first_time},1,0,0:0:0:0:"
        hit_objects.append(
            HitObject(
                x=256,
                y=192,
                time=first_time,
                object_type=1,
                hit_sound=0,
                hit_sample="0:0:0:0:",
                line=line,
            )
        )

    return hit_objects


@app.post("/analyze/bpm", response_model=BpmAnalysisResponse)
@app.post("/api/analyze/bpm", response_model=BpmAnalysisResponse)
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
        onset_env = librosa.onset.onset_strength(y=signal, sr=sample_rate)
        tempo, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_env, sr=sample_rate, units="frames"
        )
        beat_times = librosa.frames_to_time(beat_frames, sr=sample_rate).tolist()
        duration = librosa.get_duration(y=signal, sr=sample_rate)
        centroids = librosa.feature.spectral_centroid(y=signal, sr=sample_rate)[0]

        beat_strengths: list[float] = []
        beat_centroids: list[float] = []
        for frame in beat_frames:
            frame_index = int(frame)
            strength = float(onset_env[frame_index]) if frame_index < len(onset_env) else 0.0
            centroid = float(centroids[frame_index]) if frame_index < len(centroids) else 0.0
            beat_strengths.append(strength)
            beat_centroids.append(centroid)

        bpm_value = float(tempo[0] if hasattr(tempo, "__len__") else tempo)
        return BpmAnalysisResponse(
            bpm=round(bpm_value, 3),
            beats=[round(float(time), 4) for time in beat_times],
            beat_count=len(beat_times),
            duration_sec=round(float(duration), 4),
            beat_strengths=[round(value, 6) for value in beat_strengths],
            beat_centroids=[round(value, 4) for value in beat_centroids],
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"bpm analysis failed: {exc}") from exc
    finally:
        if temp_path and temp_path.exists():
            temp_path.unlink(missing_ok=True)


@app.post("/generate/timing-points", response_model=TimingPointResponse)
@app.post("/api/generate/timing-points", response_model=TimingPointResponse)
def generate_timing_points(payload: TimingPointRequest) -> TimingPointResponse:
    points = _generate_uninherited_points(payload)
    return TimingPointResponse(timing_points=points)


@app.post("/generate/hit-objects", response_model=HitObjectResponse)
@app.post("/api/generate/hit-objects", response_model=HitObjectResponse)
def generate_hit_objects(payload: HitObjectRequest) -> HitObjectResponse:
    hit_objects = _generate_hit_objects(payload)
    return HitObjectResponse(hit_objects=hit_objects)

