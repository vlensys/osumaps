from __future__ import annotations

import math
import os
import tempfile
import time
import traceback
from pathlib import Path
from statistics import median

import librosa
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, Request, Response, UploadFile
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


@app.middleware("http")
async def request_log_middleware(request: Request, call_next):
    started = time.perf_counter()
    path = request.url.path
    method = request.method
    try:
        response = await call_next(request)
        elapsed = int((time.perf_counter() - started) * 1000)
        print(f"[http] {method} {path} -> {response.status_code} ({elapsed}ms)", flush=True)
        return response
    except Exception:
        elapsed = int((time.perf_counter() - started) * 1000)
        print(f"[http] {method} {path} -> unhandled exception ({elapsed}ms)", flush=True)
        print(traceback.format_exc(), flush=True)
        raise


class BpmAnalysisResponse(BaseModel):
    bpm: float
    beats: list[float]
    beat_count: int
    duration_sec: float
    beat_strengths: list[float]
    beat_centroids: list[float]
    timing_beats: list[float] = []


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
    difficulty_star: float = 3.0


class HitObjectResponse(BaseModel):
    hit_objects: list[HitObject]


class GeneratedNote(BaseModel):
    time_ms: int
    x: int
    y: int
    snap: str


class GeneratedDifficulty(BaseModel):
    difficulty: str
    star_rating: float
    notes: list[GeneratedNote]
    spacing_notes: str


class DifficultyGenerateResponse(BaseModel):
    generated: list[GeneratedDifficulty]


class DifficultySettings(BaseModel):
    difficulty: str
    target_star: float
    estimated_star: float
    circle_size: float
    approach_rate: float
    overall_difficulty: float
    hp_drain: float
    slider_multiplier: float


class FullGenerationResponse(BaseModel):
    bpm: float
    beat_count: int
    duration_sec: float
    timing_points: list[TimingPoint]
    hit_objects: list[HitObject]
    settings: DifficultySettings


DIFF_PROFILES: dict[str, dict[str, float | tuple[str, ...]]] = {
    "Easy": {
        "star_min": 1.0,
        "star_max": 2.0,
        "cs": 4.8,
        "ar": 4.2,
        "od": 2.6,
        "hp": 2.6,
        "sv": 0.7,
        "spacing_mult": 35.0,
        "spacing_difficulty_mult": 0.4,
        "threshold": 0.48,
        "allowed_snaps": ("1/1", "1/2"),
    },
    "Normal": {
        "star_min": 2.0,
        "star_max": 3.0,
        "cs": 4.4,
        "ar": 5.6,
        "od": 4.2,
        "hp": 3.5,
        "sv": 0.9,
        "spacing_mult": 60.0,
        "spacing_difficulty_mult": 0.6,
        "threshold": 0.42,
        "allowed_snaps": ("1/1", "1/2", "1/4"),
    },
    "Hard": {
        "star_min": 3.0,
        "star_max": 4.0,
        "cs": 4.0,
        "ar": 6.7,
        "od": 5.6,
        "hp": 4.6,
        "sv": 1.3,
        "spacing_mult": 100.0,
        "spacing_difficulty_mult": 0.9,
        "threshold": 0.36,
        "allowed_snaps": ("1/1", "1/2", "1/4"),
    },
    "Insane": {
        "star_min": 4.0,
        "star_max": 5.5,
        "cs": 3.6,
        "ar": 7.6,
        "od": 6.6,
        "hp": 5.6,
        "sv": 1.6,
        "spacing_mult": 140.0,
        "spacing_difficulty_mult": 1.2,
        "threshold": 0.30,
        "allowed_snaps": ("1/2", "1/4", "1/6"),
    },
    "Expert": {
        "star_min": 5.5,
        "star_max": 7.0,
        "cs": 3.0,
        "ar": 8.7,
        "od": 7.6,
        "hp": 6.6,
        "sv": 1.9,
        "spacing_mult": 175.0,
        "spacing_difficulty_mult": 1.5,
        "threshold": 0.24,
        "allowed_snaps": ("1/2", "1/4", "1/6"),
    },
}


@app.get("/health")
@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/")
def root() -> dict[str, str]:
    return {"status": "ok", "service": "osumaps backend"}


@app.head("/")
def root_head() -> Response:
    return Response(status_code=200)


@app.head("/health")
@app.head("/api/health")
def health_head() -> Response:
    return Response(status_code=200)


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


def _analyze_audio_librosa(path: Path) -> dict[str, object]:
    sr_target = 16000
    hop_length = 512
    n_fft = 1024

    y, sr = librosa.load(path.as_posix(), sr=sr_target, mono=True, dtype=np.float32)
    if y.size == 0:
        raise ValueError("decoded audio has no samples")

    spectral_flux = librosa.onset.onset_strength(
        y=y,
        sr=sr,
        hop_length=hop_length,
        n_fft=n_fft,
    ).astype(np.float32, copy=False)
    onset_times = _detect_dense_onsets(
        onset_envelope=spectral_flux,
        sr=sr,
        hop_length=hop_length,
        duration_sec=float(librosa.get_duration(y=y, sr=sr)),
    )
    rms = librosa.feature.rms(
        y=y,
        frame_length=n_fft,
        hop_length=hop_length,
    )[0].astype(np.float32, copy=False)

    bass_energy, mid_energy, high_energy = _compute_band_energies(
        y=y,
        sr=sr,
        n_fft=n_fft,
        hop_length=hop_length,
    )

    tempo_candidates = librosa.feature.tempo(
        onset_envelope=spectral_flux,
        sr=sr,
        hop_length=hop_length,
        aggregate=np.median,
    )
    tempo_value = float(tempo_candidates[0]) if len(tempo_candidates) else 120.0
    tempo_value = max(1.0, tempo_value)
    beat_period = 60.0 / tempo_value
    duration = float(librosa.get_duration(y=y, sr=sr))
    beat_start = float(onset_times[0]) if len(onset_times) else 0.0
    beat_times = np.arange(beat_start, max(duration, beat_start + beat_period), beat_period)

    frame_count = min(len(spectral_flux), len(rms), len(bass_energy), len(mid_energy), len(high_energy))
    if frame_count == 0:
        raise ValueError("audio feature extraction returned empty frames")
    spectral_flux = spectral_flux[:frame_count]
    rms = rms[:frame_count]
    bass_energy = bass_energy[:frame_count]
    mid_energy = mid_energy[:frame_count]
    high_energy = high_energy[:frame_count]

    beat_strengths: list[float] = []
    beat_centroids: list[float] = []
    beat_frames = librosa.time_to_frames(beat_times, sr=sr, hop_length=hop_length)
    for frame in beat_frames:
        frame_index = max(0, min(int(frame), frame_count - 1))
        strength = float(spectral_flux[frame_index])
        total_band = float(bass_energy[frame_index] + mid_energy[frame_index] + high_energy[frame_index]) + 1e-6
        centroid_ratio = float(high_energy[frame_index] / total_band)
        beat_strengths.append(strength)
        beat_centroids.append(centroid_ratio)

    return {
        "y_len": len(y),
        "sr": sr,
        "onset_times": onset_times,
        "spectral_flux": spectral_flux,
        "rms": rms,
        "bass_energy": bass_energy,
        "mid_energy": mid_energy,
        "high_energy": high_energy,
        "tempo": tempo_value,
        "beat_times": beat_times,
        "duration": duration,
        "beat_strengths": beat_strengths,
        "beat_centroids": beat_centroids,
    }


def _compute_band_energies(
    y: np.ndarray,
    sr: int,
    n_fft: int,
    hop_length: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if y.size == 0:
        empty = np.zeros(0, dtype=np.float32)
        return empty, empty, empty

    if y.size <= n_fft:
        frame_count = 1
    else:
        frame_count = 1 + int(np.ceil((y.size - n_fft) / hop_length))
    window = np.hanning(n_fft).astype(np.float32)
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)

    bass_mask = freqs < 250
    mid_mask = (freqs >= 250) & (freqs < 4000)
    high_mask = freqs >= 4000

    bass_energy = np.zeros(frame_count, dtype=np.float32)
    mid_energy = np.zeros(frame_count, dtype=np.float32)
    high_energy = np.zeros(frame_count, dtype=np.float32)

    frame = np.zeros(n_fft, dtype=np.float32)
    for frame_idx in range(frame_count):
        start = frame_idx * hop_length
        end = min(start + n_fft, y.size)
        frame.fill(0.0)
        frame[: end - start] = y[start:end]
        spectrum = np.abs(np.fft.rfft(frame * window)).astype(np.float32, copy=False)

        if np.any(bass_mask):
            bass_energy[frame_idx] = float(np.mean(spectrum[bass_mask]))
        if np.any(mid_mask):
            mid_energy[frame_idx] = float(np.mean(spectrum[mid_mask]))
        if np.any(high_mask):
            high_energy[frame_idx] = float(np.mean(spectrum[high_mask]))

    return bass_energy, mid_energy, high_energy


def _merge_onset_frames(frames: np.ndarray, min_gap_frames: int) -> np.ndarray:
    if frames.size == 0:
        return frames
    merged: list[int] = [int(frames[0])]
    for value in frames[1:]:
        frame = int(value)
        if frame - merged[-1] >= min_gap_frames:
            merged.append(frame)
    return np.array(merged, dtype=np.int32)


def _peak_pick_fallback(onset_envelope: np.ndarray, target_count: int, min_gap_frames: int) -> np.ndarray:
    if onset_envelope.size < 3:
        return np.array([], dtype=np.int32)

    local_max_indices = np.where(
        (onset_envelope[1:-1] > onset_envelope[:-2]) &
        (onset_envelope[1:-1] >= onset_envelope[2:])
    )[0] + 1
    if local_max_indices.size == 0:
        return np.array([], dtype=np.int32)

    values = onset_envelope[local_max_indices]
    min_value = float(np.percentile(values, 55))
    candidate_indices = local_max_indices[values >= min_value]
    if candidate_indices.size == 0:
        candidate_indices = local_max_indices

    sorted_candidates = sorted(
        candidate_indices.tolist(),
        key=lambda idx: float(onset_envelope[idx]),
        reverse=True,
    )

    selected: list[int] = []
    for idx in sorted_candidates:
        if any(abs(idx - taken) < min_gap_frames for taken in selected):
            continue
        selected.append(int(idx))
        if len(selected) >= target_count:
            break

    if not selected:
        return np.array([], dtype=np.int32)
    selected.sort()
    return np.array(selected, dtype=np.int32)


def _detect_dense_onsets(
    onset_envelope: np.ndarray,
    sr: int,
    hop_length: int,
    duration_sec: float,
) -> np.ndarray:
    wait_default = max(1, int(0.03 * sr // hop_length))

    primary = librosa.onset.onset_detect(
        onset_envelope=onset_envelope,
        sr=sr,
        hop_length=hop_length,
        units="frames",
        delta=0.045,
        wait=wait_default,
    )

    dense = librosa.onset.onset_detect(
        onset_envelope=onset_envelope,
        sr=sr,
        hop_length=hop_length,
        units="frames",
        pre_avg=max(1, int(0.04 * sr // hop_length)),
        post_avg=max(1, int(0.04 * sr // hop_length)),
        wait=max(1, int(0.015 * sr // hop_length)),
        delta=0.018,
    )

    merged = np.unique(np.concatenate([primary.astype(np.int32), dense.astype(np.int32)]))
    merged.sort()

    min_gap_frames = max(1, int(0.045 * sr // hop_length))
    merged = _merge_onset_frames(merged, min_gap_frames=min_gap_frames)

    min_target = int(max(48, duration_sec * 1.1))
    if merged.size < min_target:
        fallback = _peak_pick_fallback(
            onset_envelope=onset_envelope,
            target_count=min_target - int(merged.size),
            min_gap_frames=min_gap_frames,
        )
        if fallback.size:
            merged = np.unique(np.concatenate([merged, fallback]))
            merged.sort()
            merged = _merge_onset_frames(merged, min_gap_frames=min_gap_frames)

    onset_times = librosa.frames_to_time(merged, sr=sr, hop_length=hop_length)
    return onset_times.astype(np.float32, copy=False)


def _sample_frame_feature(values: np.ndarray, onset_time: float, sr: int, hop: int = 512) -> float:
    frame = int(round((onset_time * sr) / hop))
    frame = max(0, min(frame, len(values) - 1))
    return float(values[frame])


def _closest_snap(delta_ms: float, beat_ms: float, allowed_snaps: tuple[str, ...]) -> str:
    divisors = {"1/1": 1.0, "1/2": 0.5, "1/4": 0.25, "1/6": 1.0 / 6.0}
    best_snap = allowed_snaps[0]
    best_err = float("inf")
    for snap in allowed_snaps:
        target = beat_ms * divisors[snap]
        err = abs(delta_ms - target)
        if err < best_err:
            best_err = err
            best_snap = snap
    return best_snap


def _profile_for_star(star_target: float) -> str:
    if star_target < 2.0:
        return "Easy"
    if star_target < 3.0:
        return "Normal"
    if star_target < 4.0:
        return "Hard"
    if star_target < 5.5:
        return "Insane"
    return "Expert"


def _resolve_profile(difficulty_label: str | None, star_target: float) -> tuple[str, dict[str, object]]:
    if difficulty_label:
        normalized = difficulty_label.strip().capitalize()
        if normalized in DIFF_PROFILES:
            return normalized, dict(DIFF_PROFILES[normalized])

    selected = _profile_for_star(star_target)
    profile = dict(DIFF_PROFILES[selected])
    profile["star_min"] = max(float(profile["star_min"]), star_target - 0.5)
    profile["star_max"] = min(float(profile["star_max"]), star_target + 0.5)
    if float(profile["star_min"]) >= float(profile["star_max"]):
        profile["star_min"] = star_target - 0.5
        profile["star_max"] = star_target + 0.5
    return selected, profile


def _thin_notes(notes: list[GeneratedNote], max_notes: int) -> list[GeneratedNote]:
    if len(notes) <= max_notes:
        return notes
    stride = max(1, len(notes) // max_notes)
    thinned = notes[::stride]
    if len(thinned) > max_notes:
        thinned = thinned[:max_notes]
    return thinned


def _generate_notes_for_profile(features: dict[str, object], profile: dict[str, object]) -> tuple[list[GeneratedNote], float]:
    onset_times = features["onset_times"]
    if len(onset_times) == 0:
        return [], 0.0

    flux = features["spectral_flux"]
    rms = features["rms"]
    bass = features["bass_energy"]
    high = features["high_energy"]
    sr = int(features["sr"])
    tempo = max(1.0, float(features["tempo"]))
    beat_ms = 60000.0 / tempo

    flux_max = float(np.max(flux) + 1e-9)
    rms_max = float(np.max(rms) + 1e-9)

    threshold = float(profile["threshold"])
    spacing_mult = float(profile["spacing_mult"])
    diff_mult = float(profile["spacing_difficulty_mult"])
    allowed_snaps = tuple(profile["allowed_snaps"])
    cs = float(profile["cs"])
    ar = float(profile["ar"])
    od = float(profile["od"])
    hp = float(profile["hp"])

    radius = (54.4 - 4.48 * cs) * 1.00041
    min_note_distance = max(20.0, min(90.0, radius * 0.9))
    min_delta_ms = beat_ms * (0.34 - (od / 28.0))
    min_delta_ms = float(np.clip(min_delta_ms, 26.0, beat_ms * 0.45))
    threshold = float(np.clip(threshold + np.interp(hp, [2.0, 7.0], [0.0, -0.02]), 0.08, 0.9))

    notes: list[GeneratedNote] = []
    prev_time_ms: int | None = None
    prev_x, prev_y = 256.0, 192.0
    used_positions: set[tuple[int, int]] = set()

    bar_anchor_phase = 0.0
    downbeat_cursor = 0
    beat_times = features["beat_times"]

    for onset in onset_times:
        onset_time = float(onset)
        while downbeat_cursor + 1 < len(beat_times) and beat_times[downbeat_cursor + 1] <= onset_time:
            downbeat_cursor += 1
            if downbeat_cursor % 4 == 0:
                bar_anchor_phase += math.pi / 2.0

        flux_score = _sample_frame_feature(flux, onset_time, sr) / flux_max
        rms_score = _sample_frame_feature(rms, onset_time, sr) / rms_max
        intensity = float(np.clip(0.6 * flux_score + 0.4 * rms_score, 0.0, 1.0))
        if intensity < threshold:
            continue

        bass_val = _sample_frame_feature(bass, onset_time, sr)
        high_val = _sample_frame_feature(high, onset_time, sr)
        freq_ratio = high_val / (bass_val + 1e-6)

        time_ms = int(round(onset_time * 1000.0))
        delta_ms = beat_ms if prev_time_ms is None else max(1.0, time_ms - prev_time_ms)
        if prev_time_ms is not None and delta_ms < min_delta_ms and intensity < min(0.98, threshold + 0.03):
            continue

        distance = (delta_ms / beat_ms) * spacing_mult
        distance *= (0.9 + 0.2 * intensity)
        distance *= diff_mult
        distance *= 0.9 + max(0.0, (ar - 5.0) * 0.05)
        distance = float(np.clip(distance, min_note_distance, 320.0))

        angle = (freq_ratio * math.pi) + (onset_time % (2.0 * math.pi)) + bar_anchor_phase

        placed = False
        x, y = int(prev_x), int(prev_y)
        for attempt in range(18):
            swing = (attempt // 2 + 1) * (0.28 if attempt % 2 == 0 else -0.28)
            trial_angle = angle + swing
            trial_x = int(np.clip(prev_x + distance * math.cos(trial_angle), 30, 482))
            trial_y = int(np.clip(prev_y + distance * math.sin(trial_angle), 30, 354))

            if (trial_x, trial_y) in used_positions:
                continue
            if notes:
                dx = trial_x - notes[-1].x
                dy = trial_y - notes[-1].y
                if math.hypot(dx, dy) < min_note_distance:
                    continue
            x, y = trial_x, trial_y
            placed = True
            break

        if not placed:
            x = int(np.clip(prev_x + distance * 0.7, 30, 482))
            y = int(np.clip(prev_y + distance * 0.45, 30, 354))
            if notes:
                dx = x - notes[-1].x
                dy = y - notes[-1].y
                if math.hypot(dx, dy) < min_note_distance:
                    x = int(np.clip(x + 24, 30, 482))
                    y = int(np.clip(y + 24, 30, 354))

        snap = "1/1" if prev_time_ms is None else _closest_snap(delta_ms, beat_ms, allowed_snaps)
        notes.append(GeneratedNote(time_ms=time_ms, x=x, y=y, snap=snap))
        used_positions.add((x, y))
        prev_time_ms = time_ms
        prev_x, prev_y = float(x), float(y)

    if len(notes) < 2:
        return notes, 0.0

    spacings = []
    for i in range(1, len(notes)):
        spacings.append(math.hypot(notes[i].x - notes[i - 1].x, notes[i].y - notes[i - 1].y))
    spacing_avg = float(np.mean(spacings)) if spacings else 0.0
    spacing_norm = spacing_avg / 100.0
    density = len(notes) / max(float(features["duration"]), 1.0)
    ar_factor = float(profile["ar"]) / 10.0
    estimated_sr = float((density * spacing_norm * (1.2 + ar_factor)) / 2.6)
    return notes, estimated_sr


def _calibrate_profile_to_target(
    features: dict[str, object], base_profile: dict[str, object]
) -> tuple[list[GeneratedNote], float, dict[str, object]]:
    profile = dict(base_profile)
    notes: list[GeneratedNote] = []
    sr_est = 0.0
    duration = max(1.0, float(features["duration"]))
    target_note_floor = int(max(60, duration * (0.9 + float(profile["star_min"]) * 0.35)))
    for _ in range(8):
        notes, sr_est = _generate_notes_for_profile(features, profile)
        if len(notes) < target_note_floor:
            profile["threshold"] = max(0.06, float(profile["threshold"]) - 0.05)
            profile["spacing_mult"] = float(profile["spacing_mult"]) * 1.04
            continue
        if sr_est > float(profile["star_max"]) + 0.5:
            profile["threshold"] = min(0.92, float(profile["threshold"]) + 0.04)
            profile["spacing_mult"] = float(profile["spacing_mult"]) * 0.92
        elif sr_est < float(profile["star_min"]) - 0.5:
            profile["threshold"] = max(0.1, float(profile["threshold"]) - 0.04)
            profile["spacing_mult"] = float(profile["spacing_mult"]) * 1.08
        else:
            break

    sr_est = max(float(profile["star_min"]) - 0.5, min(float(profile["star_max"]) + 0.5, sr_est))
    return notes, sr_est, profile


def _note_type_for_onset(features: dict[str, object], note: GeneratedNote) -> tuple[int, float]:
    bass = features["bass_energy"]
    high = features["high_energy"]
    sr = int(features["sr"])

    bass_val = _sample_frame_feature(bass, note.time_ms / 1000.0, sr)
    high_val = _sample_frame_feature(high, note.time_ms / 1000.0, sr)
    high_ratio = high_val / (bass_val + high_val + 1e-6)

    if high_ratio > 0.62:
        return 2, high_ratio
    return 1, high_ratio


def _build_hit_objects(
    notes: list[GeneratedNote],
    features: dict[str, object],
    profile: dict[str, object],
) -> list[HitObject]:
    hit_objects: list[HitObject] = []

    for idx, note in enumerate(notes):
        object_type, high_ratio = _note_type_for_onset(features, note)
        hit_sound = 4 if high_ratio < 0.22 else 0

        if object_type == 2 and idx + 1 < len(notes):
            next_note = notes[idx + 1]
            dx = next_note.x - note.x
            dy = next_note.y - note.y
            seg_distance = max(30.0, min(240.0, math.hypot(dx, dy) * 0.9))
            ctrl_x = int(np.clip(note.x + dx * 0.55, 30, 482))
            ctrl_y = int(np.clip(note.y + dy * 0.55, 30, 354))
            slider_length = max(80.0, seg_distance * float(profile["sv"]))
            object_line = (
                f"{note.x},{note.y},{note.time_ms},2,{hit_sound},"
                f"B|{ctrl_x}:{ctrl_y}|{next_note.x}:{next_note.y},1,{slider_length:.2f},0:0|0:0,0:0:0:0:"
            )
        else:
            object_type = 1
            object_line = f"{note.x},{note.y},{note.time_ms},1,{hit_sound},0:0:0:0:"

        hit_objects.append(
            HitObject(
                x=note.x,
                y=note.y,
                time=note.time_ms,
                object_type=object_type,
                hit_sound=hit_sound,
                hit_sample="0:0:0:0:",
                line=object_line,
            )
        )

    if not hit_objects:
        line = "256,192,0,1,0,0:0:0:0:"
        hit_objects.append(
            HitObject(
                x=256,
                y=192,
                time=0,
                object_type=1,
                hit_sound=0,
                hit_sample="0:0:0:0:",
                line=line,
            )
        )

    return hit_objects


def _build_timing_from_features(
    features: dict[str, object],
    meter: int,
    sample_set: int,
    sample_index: int,
    volume: int,
    effects: int,
) -> list[TimingPoint]:
    beat_times = [float(v) for v in features["beat_times"] if v >= 0]
    if not beat_times:
        beat_times = [float(v) for v in features["onset_times"][:32] if v >= 0]

    request = TimingPointRequest(
        bpm=float(features["tempo"]),
        beats=beat_times,
        meter=meter,
        sample_set=sample_set,
        sample_index=sample_index,
        volume=volume,
        effects=effects,
    )
    return _generate_uninherited_points(request)


def _extract_audio_to_temp(audio: UploadFile) -> tuple[Path, str]:
    suffix = Path(audio.filename or "track.mp3").suffix.lower()
    if suffix not in {".mp3", ".flac"}:
        raise HTTPException(status_code=400, detail="only .mp3 and .flac are supported")

    fd, temp_name = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    return Path(temp_name), suffix


@app.post("/analyze/bpm", response_model=BpmAnalysisResponse)
@app.post("/api/analyze/bpm", response_model=BpmAnalysisResponse)
async def analyze_bpm(audio: UploadFile = File(...)) -> BpmAnalysisResponse:
    temp_path, _ = _extract_audio_to_temp(audio)
    try:
        payload = await audio.read()
        if not payload:
            raise HTTPException(status_code=400, detail="empty file")
        temp_path.write_bytes(payload)

        features = _analyze_audio_librosa(temp_path)
        beat_times = [round(float(value), 4) for value in features["onset_times"]]
        return BpmAnalysisResponse(
            bpm=round(float(features["tempo"]), 3),
            beats=beat_times,
            beat_count=len(beat_times),
            duration_sec=round(float(features["duration"]), 4),
            beat_strengths=[round(float(v), 6) for v in features["beat_strengths"]],
            beat_centroids=[round(float(v), 4) for v in features["beat_centroids"]],
            timing_beats=[round(float(v), 4) for v in features["beat_times"]],
        )
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"bpm analysis failed: {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)


@app.post("/generate/timing-points", response_model=TimingPointResponse)
@app.post("/api/generate/timing-points", response_model=TimingPointResponse)
def generate_timing_points(payload: TimingPointRequest) -> TimingPointResponse:
    points = _generate_uninherited_points(payload)
    return TimingPointResponse(timing_points=points)


@app.post("/generate/hit-objects", response_model=HitObjectResponse)
@app.post("/api/generate/hit-objects", response_model=HitObjectResponse)
def generate_hit_objects(payload: HitObjectRequest) -> HitObjectResponse:
    star_target = min(max(payload.difficulty_star, 1.0), 7.0)
    label, profile = _resolve_profile(None, star_target)

    tempo = 120.0
    beat_step = 60.0 / tempo
    onsets = np.array(payload.beats, dtype=np.float32)
    if onsets.size == 0:
        raise HTTPException(status_code=400, detail="beats cannot be empty")

    features: dict[str, object] = {
        "onset_times": onsets,
        "spectral_flux": np.array(payload.beat_strengths if payload.beat_strengths else [1.0] * len(onsets), dtype=np.float32),
        "rms": np.array(payload.beat_strengths if payload.beat_strengths else [1.0] * len(onsets), dtype=np.float32),
        "bass_energy": np.array([1.0] * len(onsets), dtype=np.float32),
        "mid_energy": np.array([1.0] * len(onsets), dtype=np.float32),
        "high_energy": np.array(payload.beat_centroids if payload.beat_centroids else [0.5] * len(onsets), dtype=np.float32),
        "sr": 22050,
        "tempo": tempo,
        "beat_times": np.arange(0, max(onsets[-1] + beat_step, beat_step), beat_step),
        "duration": float(max(onsets[-1], 1.0)),
    }

    notes, _, tuned = _calibrate_profile_to_target(features, profile)
    notes = _thin_notes(notes, min(max(payload.max_notes, 1), 2000))
    hit_objects = _build_hit_objects(notes, features, tuned)
    if label and payload.difficulty_star <= 3.5:
        hit_objects = hit_objects
    return HitObjectResponse(hit_objects=hit_objects)


@app.post("/generate/difficulties-json", response_model=DifficultyGenerateResponse)
@app.post("/api/generate/difficulties-json", response_model=DifficultyGenerateResponse)
async def generate_difficulties_json(
    audio: UploadFile = File(...),
    difficulties: str = Form("Easy,Normal,Hard,Insane"),
    max_notes: int = Form(1200),
) -> DifficultyGenerateResponse:
    temp_path, _ = _extract_audio_to_temp(audio)
    try:
        payload = await audio.read()
        if not payload:
            raise HTTPException(status_code=400, detail="empty file")
        temp_path.write_bytes(payload)

        features = _analyze_audio_librosa(temp_path)
        labels = [item.strip().capitalize() for item in difficulties.split(",") if item.strip()]
        if not labels:
            labels = ["Easy", "Normal", "Hard", "Insane"]

        generated: list[GeneratedDifficulty] = []
        for label in labels:
            if label not in DIFF_PROFILES:
                continue
            notes, sr_est, _ = _calibrate_profile_to_target(features, dict(DIFF_PROFILES[label]))
            notes = _thin_notes(notes, max(100, min(max_notes, 4000)))
            spacing_msg = (
                "spacing follows onset intensity and rhythmic delta; "
                "higher-energy onsets produce larger jumps, quieter sections tighten spacing"
            )
            generated.append(
                GeneratedDifficulty(
                    difficulty=label,
                    star_rating=round(sr_est, 2),
                    notes=notes,
                    spacing_notes=spacing_msg,
                )
            )

        if not generated:
            raise HTTPException(status_code=400, detail="no valid difficulties requested")

        return DifficultyGenerateResponse(generated=generated)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"difficulty generation failed: {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)


@app.post("/generate/full-map", response_model=FullGenerationResponse)
@app.post("/api/generate/full-map", response_model=FullGenerationResponse)
async def generate_full_map(
    audio: UploadFile = File(...),
    difficulty_star: float = Form(3.0),
    difficulty_label: str | None = Form(None),
    max_notes: int = Form(1200),
    meter: int = Form(4),
    sample_set: int = Form(1),
    sample_index: int = Form(0),
    volume: int = Form(70),
    effects: int = Form(0),
) -> FullGenerationResponse:
    temp_path, _ = _extract_audio_to_temp(audio)
    try:
        print("[full-map] request received", flush=True)
        payload = await audio.read()
        if not payload:
            raise HTTPException(status_code=400, detail="empty file")
        print(f"[full-map] upload bytes={len(payload)}", flush=True)
        temp_path.write_bytes(payload)
        print("[full-map] temp file written", flush=True)

        features = _analyze_audio_librosa(temp_path)
        print("[full-map] audio analysis complete", flush=True)
        star_target = min(max(float(difficulty_star), 1.0), 7.0)
        label, base_profile = _resolve_profile(difficulty_label, star_target)

        notes, sr_est, tuned_profile = _calibrate_profile_to_target(features, base_profile)
        print(f"[full-map] note generation complete notes={len(notes)} est_sr={sr_est:.2f}", flush=True)
        notes = _thin_notes(notes, max(50, min(max_notes, 4000)))
        hit_objects = _build_hit_objects(notes, features, tuned_profile)
        timing_points = _build_timing_from_features(
            features,
            meter=max(1, meter),
            sample_set=min(max(sample_set, 0), 3),
            sample_index=max(sample_index, 0),
            volume=min(max(volume, 0), 100),
            effects=min(max(effects, 0), 1),
        )

        if timing_points and hit_objects and timing_points[0].time > hit_objects[0].time:
            first = timing_points[0]
            start = float(hit_objects[0].time)
            first.line = _format_timing_line(
                start,
                first.beat_length,
                first.meter,
                first.sample_set,
                first.sample_index,
                first.volume,
                first.effects,
            )
            first.time = round(start, 3)

        settings = DifficultySettings(
            difficulty=label,
            target_star=round(star_target, 2),
            estimated_star=round(sr_est, 2),
            circle_size=round(float(tuned_profile["cs"]), 2),
            approach_rate=round(float(tuned_profile["ar"]), 2),
            overall_difficulty=round(float(tuned_profile["od"]), 2),
            hp_drain=round(float(tuned_profile["hp"]), 2),
            slider_multiplier=round(float(tuned_profile["sv"]), 2),
        )

        return FullGenerationResponse(
            bpm=round(float(features["tempo"]), 3),
            beat_count=len(notes),
            duration_sec=round(float(features["duration"]), 4),
            timing_points=timing_points,
            hit_objects=hit_objects,
            settings=settings,
        )
    except HTTPException:
        raise
    except Exception as exc:
        print(f"[full-map] failed: {exc}", flush=True)
        print(traceback.format_exc(), flush=True)
        raise HTTPException(status_code=500, detail=f"full map generation failed: {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)
