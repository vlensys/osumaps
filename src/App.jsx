import { useEffect, useMemo, useRef, useState } from "react";

const MB = 1024 * 1024;
const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

const emptyMetadata = {
  title: "",
  artist: "",
  creator: "osumaps",
  version: "normal",
  source: "",
  tags: ""
};

const defaultMapSettings = {
  starRating: 5.0,
  meter: 4,
  sampleSet: 1,
  sampleIndex: 0,
  timingVolume: 70,
  effects: 0,
  maxNotes: 500,
  noteDensity: 0.78
};

function parseName(name) {
  const withoutExtension = name.replace(/\.[^/.]+$/, "");
  const split = withoutExtension.split(" - ");
  if (split.length >= 2) {
    return { artist: split[0].trim(), title: split.slice(1).join(" - ").trim() };
  }
  return { artist: "", title: withoutExtension };
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unknown";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mins}:${secs}`;
}

function formatMb(size) {
  return `${(size / MB).toFixed(2)} mb`;
}

function cleanField(value, fallback = "") {
  const normalized = (value ?? "").toString().trim();
  return normalized || fallback;
}

function sanitizeFilenamePart(value, fallback) {
  const normalized = cleanField(value, fallback).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  return normalized || fallback;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function msDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);
  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

function writeU16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeU32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function buildZipStore(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  const centralRecords = [];
  let offset = 0;
  const { dosTime, dosDate } = msDosDateTime();

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = entry.data;
    const checksum = crc32(data);
    const size = data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeU32(localView, 0, 0x04034b50);
    writeU16(localView, 4, 20);
    writeU16(localView, 6, 0);
    writeU16(localView, 8, 0);
    writeU16(localView, 10, dosTime);
    writeU16(localView, 12, dosDate);
    writeU32(localView, 14, checksum);
    writeU32(localView, 18, size);
    writeU32(localView, 22, size);
    writeU16(localView, 26, nameBytes.length);
    writeU16(localView, 28, 0);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeU32(centralView, 0, 0x02014b50);
    writeU16(centralView, 4, 20);
    writeU16(centralView, 6, 20);
    writeU16(centralView, 8, 0);
    writeU16(centralView, 10, 0);
    writeU16(centralView, 12, dosTime);
    writeU16(centralView, 14, dosDate);
    writeU32(centralView, 16, checksum);
    writeU32(centralView, 20, size);
    writeU32(centralView, 24, size);
    writeU16(centralView, 28, nameBytes.length);
    writeU16(centralView, 30, 0);
    writeU16(centralView, 32, 0);
    writeU16(centralView, 34, 0);
    writeU16(centralView, 36, 0);
    writeU32(centralView, 38, 0);
    writeU32(centralView, 42, offset);
    central.set(nameBytes, 46);

    centralRecords.push(central);
    offset += local.length + data.length;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const record of centralRecords) {
    chunks.push(record);
    centralSize += record.length;
    offset += record.length;
  }

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  writeU32(eocdView, 0, 0x06054b50);
  writeU16(eocdView, 4, 0);
  writeU16(eocdView, 6, 0);
  writeU16(eocdView, 8, centralRecords.length);
  writeU16(eocdView, 10, centralRecords.length);
  writeU32(eocdView, 12, centralSize);
  writeU32(eocdView, 16, centralStart);
  writeU16(eocdView, 20, 0);
  chunks.push(eocd);

  return new Blob(chunks, { type: "application/zip" });
}

function movingAverage(values, windowSize) {
  const output = new Array(values.length).fill(0);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= windowSize) sum -= values[i - windowSize];
    const divisor = i < windowSize ? i + 1 : windowSize;
    output[i] = sum / divisor;
  }
  return output;
}

function findMaxIndex(values, endExclusive = values.length) {
  let bestIndex = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  const end = Math.max(1, Math.min(endExclusive, values.length));
  for (let i = 0; i < end; i += 1) {
    if (values[i] > bestValue) {
      bestValue = values[i];
      bestIndex = i;
    }
  }
  return bestIndex;
}

async function analyzeAudioClientSide(file) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error("web audio api is not available in this browser");

  const context = new AudioCtx();
  try {
    const input = await file.arrayBuffer();
    const decoded = await context.decodeAudioData(input.slice(0));
    const sampleRate = decoded.sampleRate;
    const channelCount = decoded.numberOfChannels;
    const sampleCount = decoded.length;
    const durationSec = decoded.duration;

    if (sampleCount < 2048) throw new Error("audio is too short for analysis");

    const mono = new Float32Array(sampleCount);
    for (let ch = 0; ch < channelCount; ch += 1) {
      const channel = decoded.getChannelData(ch);
      for (let i = 0; i < sampleCount; i += 1) mono[i] += channel[i] / channelCount;
    }

    const frameSize = 1024;
    const hopSize = 512;
    const frameCount = Math.max(1, Math.floor((sampleCount - frameSize) / hopSize) + 1);
    const energy = new Array(frameCount).fill(0);
    const zcr = new Array(frameCount).fill(0);

    for (let frame = 0; frame < frameCount; frame += 1) {
      const start = frame * hopSize;
      let sumSquares = 0;
      let zeroCrossings = 0;
      let prev = mono[start];
      for (let i = 0; i < frameSize; i += 1) {
        const sample = mono[start + i] ?? 0;
        sumSquares += sample * sample;
        if (i > 0 && ((sample >= 0 && prev < 0) || (sample < 0 && prev >= 0))) zeroCrossings += 1;
        prev = sample;
      }
      energy[frame] = Math.sqrt(sumSquares / frameSize);
      zcr[frame] = zeroCrossings / frameSize;
    }

    const onset = new Array(frameCount).fill(0);
    for (let i = 1; i < frameCount; i += 1) onset[i] = Math.max(0, energy[i] - energy[i - 1]);
    const onsetSmoothed = movingAverage(onset, 4);

    const framesPerSecond = sampleRate / hopSize;
    const minBpm = 60;
    const maxBpm = 220;
    const minLag = Math.max(1, Math.round((framesPerSecond * 60) / maxBpm));
    const maxLag = Math.max(minLag + 1, Math.round((framesPerSecond * 60) / minBpm));

    let bestLag = Math.round((framesPerSecond * 60) / 120);
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      let score = 0;
      for (let i = lag; i < onsetSmoothed.length; i += 1) score += onsetSmoothed[i] * onsetSmoothed[i - lag];
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }

    const bpm = (60 * framesPerSecond) / bestLag;
    const beatStepSec = 60 / Math.max(1, bpm);

    // Peak-pick onset candidates (local max + local mean threshold + minimum distance).
    // This follows standard onset peak-picking heuristics used in MIR literature.
    const preMax = 2;
    const postMax = 2;
    const preAvg = 8;
    const postAvg = 4;
    const waitFrames = Math.max(2, Math.round(framesPerSecond * Math.max(0.06, beatStepSec * 0.28)));
    const meanOnset = onsetSmoothed.reduce((a, b) => a + b, 0) / Math.max(1, onsetSmoothed.length);
    const varianceOnset =
      onsetSmoothed.reduce((a, b) => a + (b - meanOnset) * (b - meanOnset), 0) /
      Math.max(1, onsetSmoothed.length);
    const stdOnset = Math.sqrt(varianceOnset);
    const delta = stdOnset * 0.35;

    const peakFrames = [];
    let previousPeak = -waitFrames;
    for (let n = 1; n < onsetSmoothed.length - 1; n += 1) {
      const maxStart = Math.max(0, n - preMax);
      const maxEnd = Math.min(onsetSmoothed.length, n + postMax + 1);
      let localMax = Number.NEGATIVE_INFINITY;
      for (let i = maxStart; i < maxEnd; i += 1) localMax = Math.max(localMax, onsetSmoothed[i]);

      const avgStart = Math.max(0, n - preAvg);
      const avgEnd = Math.min(onsetSmoothed.length, n + postAvg + 1);
      let localSum = 0;
      for (let i = avgStart; i < avgEnd; i += 1) localSum += onsetSmoothed[i];
      const localMean = localSum / Math.max(1, avgEnd - avgStart);

      const isPeak = onsetSmoothed[n] === localMax && onsetSmoothed[n] >= localMean + delta;
      const respectsWait = n - previousPeak > waitFrames;

      if (isPeak && respectsWait) {
        peakFrames.push(n);
        previousPeak = n;
      }
    }

    const timingSearchFrames = Math.min(frameCount, Math.round(framesPerSecond * 8));
    const firstBeatFrame = findMaxIndex(onsetSmoothed, timingSearchFrames);
    const firstBeatSec = (firstBeatFrame * hopSize) / sampleRate;

    // Stable timing grid for [TimingPoints].
    const timingBeats = [];
    for (let t = firstBeatSec; t < durationSec; t += beatStepSec) timingBeats.push(t);
    for (let t = firstBeatSec - beatStepSec; t > 0; t -= beatStepSec) timingBeats.unshift(t);

    // Note candidates follow detected onsets, not pure BPM grid.
    let beats = peakFrames.map((frame) => (frame * hopSize) / sampleRate);
    if (beats.length < 8) {
      // Fallback for very flat audio where onset peaks are weak.
      beats = [...timingBeats];
    }

    const beatStrengths = beats.map((beatSec) => {
      const frame = Math.min(frameCount - 1, Math.max(0, Math.round((beatSec * sampleRate) / hopSize)));
      return onsetSmoothed[frame] ?? 0;
    });

    const beatCentroids = beats.map((beatSec) => {
      const frame = Math.min(frameCount - 1, Math.max(0, Math.round((beatSec * sampleRate) / hopSize)));
      return zcr[frame] ?? 0;
    });

    return {
      bpm: Number(bpm.toFixed(3)),
      beats: beats.map((value) => Number(value.toFixed(4))),
      beat_count: beats.length,
      timing_beats: timingBeats.map((value) => Number(value.toFixed(4))),
      duration_sec: Number(durationSec.toFixed(4)),
      beat_strengths: beatStrengths.map((value) => Number(value.toFixed(6))),
      beat_centroids: beatCentroids.map((value) => Number(value.toFixed(6)))
    };
  } finally {
    await context.close();
  }
}

function buildOsuContent({ metadata, audioFilename, timingPointLines, hitObjectLines, mapSettings }) {
  const title = cleanField(metadata.title, "untitled");
  const artist = cleanField(metadata.artist, "unknown artist");
  const creator = cleanField(metadata.creator, "osumaps");
  const version = cleanField(metadata.version, "generated");
  const source = cleanField(metadata.source, "");
  const tags = cleanField(metadata.tags, "auto generated osumaps");
  const star = Number.isFinite(mapSettings?.starRating) ? mapSettings.starRating : 5;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const hp = clamp(2.5 + star * 0.65, 2, 9);
  const cs = clamp(2.7 + star * 0.35, 2, 7);
  const od = clamp(3 + star * 0.7, 2, 9.5);
  const ar = clamp(4 + star * 0.6, 2, 10);

  return [
    "osu file format v128",
    "",
    "[General]",
    `AudioFilename: ${audioFilename}`,
    "AudioLeadIn: 0",
    "PreviewTime: -1",
    "Countdown: 0",
    "SampleSet: Normal",
    "StackLeniency: 0.7",
    "Mode: 0",
    "LetterboxInBreaks: 0",
    "WidescreenStoryboard: 0",
    "",
    "[Editor]",
    "DistanceSpacing: 1.2",
    "BeatDivisor: 4",
    "GridSize: 4",
    "TimelineZoom: 1",
    "",
    "[Metadata]",
    `Title:${title}`,
    `TitleUnicode:${title}`,
    `Artist:${artist}`,
    `ArtistUnicode:${artist}`,
    `Creator:${creator}`,
    `Version:${version}`,
    `Source:${source}`,
    `Tags:${tags}`,
    "BeatmapID:0",
    "BeatmapSetID:-1",
    "",
    "[Difficulty]",
    `HPDrainRate:${hp.toFixed(1)}`,
    `CircleSize:${cs.toFixed(1)}`,
    `OverallDifficulty:${od.toFixed(1)}`,
    `ApproachRate:${ar.toFixed(1)}`,
    "SliderMultiplier:1.4",
    "SliderTickRate:1",
    "",
    "[Events]",
    "//Background and Video events",
    "//Break Periods",
    "//Storyboard Layer 0 (Background)",
    "//Storyboard Layer 1 (Fail)",
    "//Storyboard Layer 2 (Pass)",
    "//Storyboard Layer 3 (Foreground)",
    "//Storyboard Sound Samples",
    "",
    "[TimingPoints]",
    ...timingPointLines,
    "",
    "[HitObjects]",
    ...hitObjectLines,
    ""
  ].join("\n");
}

function validateBeatmapDraft({ metadata, timingPoints, hitObjects }) {
  const issues = [];

  if (!cleanField(metadata.title)) issues.push("metadata title is empty");
  if (!cleanField(metadata.artist)) issues.push("metadata artist is empty");
  if (!cleanField(metadata.creator)) issues.push("metadata creator is empty");
  if (!cleanField(metadata.version)) issues.push("metadata version is empty");

  if (timingPoints.length === 0) issues.push("no timing points generated");
  if (hitObjects.length === 0) issues.push("no hit objects generated");

  for (let i = 0; i < timingPoints.length; i += 1) {
    const tp = timingPoints[i];
    if (!(tp.beat_length > 0)) issues.push(`timing point ${i + 1} has invalid beat_length`);
    if (tp.time < 0) issues.push(`timing point ${i + 1} has negative time`);
  }

  for (let i = 0; i < hitObjects.length; i += 1) {
    const obj = hitObjects[i];
    if (obj.x < 0 || obj.x > 512) issues.push(`hit object ${i + 1} has x out of range`);
    if (obj.y < 0 || obj.y > 384) issues.push(`hit object ${i + 1} has y out of range`);
    if (obj.time < 0) issues.push(`hit object ${i + 1} has negative time`);
    if (i > 0 && obj.time < hitObjects[i - 1].time) {
      issues.push(`hit object ${i + 1} is out of time order`);
    }
  }

  const firstHitTime = hitObjects.length > 0 ? hitObjects[0].time : null;
  const firstTimingTime = timingPoints.length > 0 ? timingPoints[0].time : null;
  if (firstHitTime !== null && firstTimingTime !== null && firstTimingTime - firstHitTime > 2) {
    issues.push("first timing point starts after first hit object");
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

function ensureTimingStartsBeforeHits(timingPoints, hitObjects) {
  if (!timingPoints.length || !hitObjects.length) return timingPoints;
  const firstTiming = timingPoints[0];
  const firstHit = hitObjects[0];

  if ((firstTiming.time ?? 0) <= firstHit.time + 2) return timingPoints;

  const fixedTime = Number(firstHit.time.toFixed ? firstHit.time.toFixed(3) : firstHit.time);
  const fixedLine = `${fixedTime.toFixed(3)},${Number(firstTiming.beat_length).toFixed(6)},${firstTiming.meter},${firstTiming.sample_set},${firstTiming.sample_index},${firstTiming.volume},1,${firstTiming.effects}`;

  const prepended = {
    ...firstTiming,
    time: fixedTime,
    line: fixedLine
  };

  return [prepended, ...timingPoints];
}

export default function App() {
  const fileRef = useRef(null);
  const audioRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [durationSec, setDurationSec] = useState(0);
  const [playbackSec, setPlaybackSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [metadata, setMetadata] = useState(emptyMetadata);
  const [mapSettings, setMapSettings] = useState(defaultMapSettings);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [isGeneratingTiming, setIsGeneratingTiming] = useState(false);
  const [timingError, setTimingError] = useState("");
  const [timingPoints, setTimingPoints] = useState([]);
  const [isGeneratingNotes, setIsGeneratingNotes] = useState(false);
  const [notesError, setNotesError] = useState("");
  const [hitObjects, setHitObjects] = useState([]);
  const [exportError, setExportError] = useState("");
  const [validationResult, setValidationResult] = useState(null);
  const [metadataSource, setMetadataSource] = useState("filename");
  const [isRunningPipeline, setIsRunningPipeline] = useState(false);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const fileInfo = useMemo(() => {
    if (!audioFile) return null;
    return {
      filename: audioFile.name,
      type: audioFile.type || "unknown",
      size: formatMb(audioFile.size),
      duration: formatDuration(durationSec)
    };
  }, [audioFile, durationSec]);

  const syncStatus = useMemo(() => {
    if (hitObjects.length === 0) return null;
    const nowMs = playbackSec * 1000;
    let nearest = hitObjects[0];
    let nearestDiff = Math.abs(hitObjects[0].time - nowMs);

    for (const object of hitObjects) {
      const diff = Math.abs(object.time - nowMs);
      if (diff < nearestDiff) {
        nearest = object;
        nearestDiff = diff;
      }
    }

    const signedDelta = nearest.time - nowMs;
    return {
      nearestTimeMs: nearest.time,
      deltaMs: signedDelta,
      absDeltaMs: Math.abs(signedDelta),
      withinTight: Math.abs(signedDelta) <= 40,
      withinLoose: Math.abs(signedDelta) <= 80
    };
  }, [hitObjects, playbackSec]);

  const updateFile = async (file) => {
    if (!file) return;
    const validExt = /\.(mp3|flac)$/i.test(file.name);
    if (!validExt) {
      alert("only mp3 and flac are supported");
      return;
    }

    const nameMeta = parseName(file.name);
    let tagMeta = null;
    try {
      const { parseBlob } = await import("music-metadata-browser");
      const parsed = await parseBlob(file);
      tagMeta = {
        title: cleanField(parsed.common?.title),
        artist: cleanField(parsed.common?.artist),
        source: cleanField(parsed.common?.album),
        tags: cleanField(parsed.common?.genre?.join(" "))
      };
    } catch {
      tagMeta = null;
    }
    const nextUrl = URL.createObjectURL(file);

    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioFile(file);
    setAudioUrl(nextUrl);
    setDurationSec(0);
    setPlaybackSec(0);
    setIsPlaying(false);
    setAnalysis(null);
    setAnalysisError("");
    setTimingError("");
    setTimingPoints([]);
    setNotesError("");
    setHitObjects([]);
    setExportError("");
    setValidationResult(null);
    setMetadata((current) => ({
      ...current,
      title: tagMeta?.title || nameMeta.title || current.title,
      artist: tagMeta?.artist || nameMeta.artist || current.artist,
      source: tagMeta?.source || current.source,
      tags: tagMeta?.tags || current.tags
    }));
    setMapSettings(defaultMapSettings);
    setMetadataSource(tagMeta?.title || tagMeta?.artist ? "audio tags" : "filename");
  };

  const onInputChange = async (event) => {
    const selected = event.target.files?.[0];
    await updateFile(selected);
  };

  const onDrop = async (event) => {
    event.preventDefault();
    setDragActive(false);
    const dropped = event.dataTransfer.files?.[0];
    await updateFile(dropped);
  };

  const setField = (field, value) => {
    setMetadata((current) => ({ ...current, [field]: value }));
  };

  const setSetting = (field, value) => {
    setMapSettings((current) => ({ ...current, [field]: value }));
  };

  const analyzeBpm = async () => {
    if (!audioFile) return;
    setIsAnalyzing(true);
    setAnalysisError("");

    try {
      const payload = await analyzeAudioClientSide(audioFile);
      setAnalysis(payload);
      setNotesError("");
      setHitObjects([]);
      setValidationResult(null);
      return payload;
    } catch (error) {
      setAnalysisError(error.message || "analysis failed");
      setAnalysis(null);
      setTimingPoints([]);
      setHitObjects([]);
      return null;
    } finally {
      setIsAnalyzing(false);
    }
  };

  const generateTimingPoints = async (analysisPayload = analysis) => {
    if (!analysisPayload) return null;
    setIsGeneratingTiming(true);
    setTimingError("");

    try {
      const response = await fetch(`${API_BASE}/generate/timing-points`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bpm: analysisPayload.bpm,
          beats: analysisPayload.timing_beats ?? analysisPayload.beats,
          meter: mapSettings.meter,
          sample_set: mapSettings.sampleSet,
          sample_index: mapSettings.sampleIndex,
          volume: mapSettings.timingVolume,
          effects: mapSettings.effects
        })
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        throw new Error(errorPayload?.detail || "timing point generation failed");
      }

      const payload = await response.json();
      const normalized = ensureTimingStartsBeforeHits(payload.timing_points ?? [], hitObjects);
      setTimingPoints(normalized);
      setNotesError("");
      setHitObjects([]);
      setValidationResult(null);
      return normalized;
    } catch (error) {
      setTimingError(error.message || "timing point generation failed");
      setTimingPoints([]);
      return null;
    } finally {
      setIsGeneratingTiming(false);
    }
  };

  const generateHitObjects = async (analysisPayload = analysis) => {
    if (!analysisPayload) return null;
    setIsGeneratingNotes(true);
    setNotesError("");

    try {
      const response = await fetch(`${API_BASE}/generate/hit-objects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beats: analysisPayload.beats,
          beat_strengths: analysisPayload.beat_strengths ?? [],
          beat_centroids: analysisPayload.beat_centroids ?? [],
          max_notes: mapSettings.maxNotes,
          density: mapSettings.noteDensity,
          difficulty_star: mapSettings.starRating
        })
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        throw new Error(errorPayload?.detail || "hit object generation failed");
      }

      const payload = await response.json();
      setHitObjects(payload.hit_objects ?? []);
      setExportError("");
      setValidationResult(null);
      return payload.hit_objects ?? [];
    } catch (error) {
      setNotesError(error.message || "hit object generation failed");
      setHitObjects([]);
      return null;
    } finally {
      setIsGeneratingNotes(false);
    }
  };

  const runFullPipeline = async () => {
    if (!audioFile) return;
    setIsRunningPipeline(true);
    setAnalysisError("");
    setTimingError("");
    setNotesError("");
    setExportError("");

    const analysisPayload = await analyzeBpm();
    if (!analysisPayload) {
      setIsRunningPipeline(false);
      return;
    }

    const generatedTiming = await generateTimingPoints(analysisPayload);
    if (!generatedTiming || generatedTiming.length === 0) {
      setIsRunningPipeline(false);
      return;
    }

    const generatedNotes = await generateHitObjects(analysisPayload);
    if (!generatedNotes || generatedNotes.length === 0) {
      setIsRunningPipeline(false);
      return;
    }

    const fixedTiming = ensureTimingStartsBeforeHits(generatedTiming, generatedNotes);
    if (fixedTiming !== generatedTiming) setTimingPoints(fixedTiming);

    const result = validateBeatmapDraft({
      metadata,
      timingPoints: fixedTiming,
      hitObjects: generatedNotes
    });
    setValidationResult(result);
    setIsRunningPipeline(false);
  };

  const exportOszFile = async () => {
    if (!audioFile) {
      setExportError("upload an audio file before exporting");
      return;
    }
    if (timingPoints.length === 0) {
      setExportError("generate timing points before exporting");
      return;
    }
    if (hitObjects.length === 0) {
      setExportError("generate hit objects before exporting");
      return;
    }

    const content = buildOsuContent({
      metadata,
      audioFilename: audioFile.name,
      timingPointLines: timingPoints.map((point) => point.line),
      hitObjectLines: hitObjects.map((obj) => obj.line),
      mapSettings
    });

    const artistPart = sanitizeFilenamePart(metadata.artist, "unknown artist");
    const titlePart = sanitizeFilenamePart(metadata.title, "untitled");
    const creatorPart = sanitizeFilenamePart(metadata.creator, "osumaps");
    const versionPart = sanitizeFilenamePart(metadata.version, "generated");
    const osuFileName = `${artistPart} - ${titlePart} (${creatorPart}) [${versionPart}].osu`;
    const packageName = `${artistPart} - ${titlePart}.osz`;

    const encoder = new TextEncoder();
    const osuBytes = encoder.encode(content);
    const audioBytes = new Uint8Array(await audioFile.arrayBuffer());
    const blob = buildZipStore([
      { name: osuFileName, data: osuBytes },
      { name: audioFile.name, data: audioBytes }
    ]);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = packageName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setExportError("");
  };

  const runSanityValidation = () => {
    const result = validateBeatmapDraft({ metadata, timingPoints, hitObjects });
    setValidationResult(result);
  };

  return (
    <main className="mx-auto min-h-screen w-full max-w-4xl px-6 py-10">
      <header className="mb-10">
        <p className="text-sm uppercase tracking-[0.25em] text-cyan-300">osumaps</p>
        <h1 className="mt-2 text-3xl font-bold text-white">audio to osu! lazer converter</h1>
        <p className="mt-3 max-w-2xl text-slate-300">
          step 1: upload an audio track. files stay on-device and are used for local analysis + map generation.
        </p>
      </header>

      <section
        className={`rounded-2xl border-2 border-dashed p-10 text-center transition ${
          dragActive ? "border-cyan-300 bg-cyan-500/10" : "border-slate-700 bg-slate-900"
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        <p className="text-lg font-semibold">drop mp3/flac here</p>
        <p className="mt-2 text-sm text-slate-400">or pick a file manually</p>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="mt-6 rounded-lg bg-cyan-400 px-5 py-2 font-medium text-slate-950 transition hover:bg-cyan-300"
        >
          choose file
        </button>
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept=".mp3,.flac,audio/mpeg,audio/flac"
          onChange={onInputChange}
        />
      </section>

      {fileInfo && (
        <section className="mt-8 grid gap-6 md:grid-cols-2">
          <article className="rounded-2xl bg-slate-900 p-6">
            <h2 className="text-xl font-semibold">audio info</h2>
            <ul className="mt-4 space-y-2 text-sm text-slate-300">
              <li>name: {fileInfo.filename}</li>
              <li>type: {fileInfo.type}</li>
              <li>size: {fileInfo.size}</li>
              <li>duration: {fileInfo.duration}</li>
            </ul>
            <audio
              ref={audioRef}
              controls
              src={audioUrl}
              className="mt-4 w-full"
              onLoadedMetadata={(event) => setDurationSec(event.currentTarget.duration)}
              onTimeUpdate={(event) => setPlaybackSec(event.currentTarget.currentTime)}
              onPlay={() => setIsPlaying(true)}
              onPause={() => setIsPlaying(false)}
              onEnded={() => setIsPlaying(false)}
            />
            <button
              type="button"
              onClick={analyzeBpm}
              disabled={isAnalyzing || isRunningPipeline}
              className="mt-4 rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isAnalyzing ? "analyzing..." : "analyze bpm"}
            </button>
            <button
              type="button"
              onClick={runFullPipeline}
              disabled={isRunningPipeline}
              className="mt-3 rounded-lg bg-indigo-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-indigo-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isRunningPipeline ? "running full pipeline..." : "run full pipeline"}
            </button>
            {analysisError && <p className="mt-2 text-sm text-rose-300">{analysisError}</p>}
            {analysis && (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-sm text-slate-200">
                <p>bpm: {analysis.bpm}</p>
                <p>detected beats: {analysis.beat_count}</p>
                <p>first beat at: {analysis.beats[0] ?? "n/a"} sec</p>
                <p>beat length: {analysis.bpm > 0 ? (60000 / analysis.bpm).toFixed(2) : "n/a"} ms</p>
              </div>
            )}
            <button
              type="button"
              onClick={generateTimingPoints}
              disabled={!analysis || isGeneratingTiming}
              className="mt-3 rounded-lg bg-amber-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isGeneratingTiming ? "generating timing points..." : "generate timing points"}
            </button>
            {timingError && <p className="mt-2 text-sm text-rose-300">{timingError}</p>}
            {timingPoints.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200">
                <p className="mb-2 font-semibold text-slate-100">[timingpoints]</p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
                  {timingPoints.map((point) => point.line).join("\n")}
                </pre>
              </div>
            )}
            <button
              type="button"
              onClick={generateHitObjects}
              disabled={!analysis || isGeneratingNotes}
              className="mt-3 rounded-lg bg-fuchsia-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-fuchsia-200 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isGeneratingNotes ? "generating hit objects..." : "generate note pattern"}
            </button>
            {notesError && <p className="mt-2 text-sm text-rose-300">{notesError}</p>}
            {hitObjects.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200">
                <p className="mb-2 font-semibold text-slate-100">[hitobjects]</p>
                <p className="mb-2 text-slate-400">generated notes: {hitObjects.length}</p>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all">
                  {hitObjects.map((obj) => obj.line).join("\n")}
                </pre>
              </div>
            )}
            <button
              type="button"
              onClick={exportOszFile}
              className="mt-3 rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
            >
              export .osz
            </button>
            {exportError && <p className="mt-2 text-sm text-rose-300">{exportError}</p>}
            <button
              type="button"
              onClick={runSanityValidation}
              className="mt-3 rounded-lg bg-lime-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-lime-200"
            >
              run beatmap sanity check
            </button>
            {validationResult && (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200">
                <p className="font-semibold text-slate-100">
                  sanity status: {validationResult.ok ? "pass" : "needs fixes"}
                </p>
                {validationResult.ok ? (
                  <p className="mt-1 text-emerald-300">no issues found in draft structure</p>
                ) : (
                  <ul className="mt-2 list-disc pl-4 text-rose-300">
                    {validationResult.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {hitObjects.length > 0 && (
              <div className="mt-3 rounded-lg border border-slate-700 bg-slate-950/70 p-3 text-xs text-slate-200">
                <p className="font-semibold text-slate-100">playback sync check</p>
                <p className="mt-1">
                  playback: {(playbackSec * 1000).toFixed(1)} ms ({isPlaying ? "playing" : "paused"})
                </p>
                {syncStatus && (
                  <>
                    <p>nearest note: {syncStatus.nearestTimeMs} ms</p>
                    <p>
                      delta: {syncStatus.deltaMs.toFixed(1)} ms{" "}
                      {syncStatus.withinTight
                        ? "(tight)"
                        : syncStatus.withinLoose
                          ? "(acceptable)"
                          : "(off-sync)"}
                    </p>
                  </>
                )}
              </div>
            )}
          </article>

          <article className="rounded-2xl bg-slate-900 p-6">
            <h2 className="text-xl font-semibold">map metadata</h2>
            <p className="mt-2 text-xs text-slate-400">auto-filled from: {metadataSource}</p>
            <div className="mt-4 grid gap-3">
              {Object.entries(metadata).map(([key, value]) => (
                <label key={key} className="text-sm text-slate-300">
                  <span className="mb-1 block capitalize">{key}</span>
                  <input
                    value={value}
                    onChange={(event) => setField(key, event.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                  />
                </label>
              ))}
            </div>

            <h3 className="mt-6 text-lg font-semibold text-slate-100">generation settings</h3>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-slate-300">
              <label className="col-span-2">
                <span className="mb-1 block">difficulty stars ({mapSettings.starRating.toFixed(1)}★)</span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="0.1"
                  value={mapSettings.starRating}
                  onChange={(event) => setSetting("starRating", Number(event.target.value))}
                  className="w-full accent-cyan-300"
                />
                <span className="mt-1 block text-xs text-slate-400">
                  target generator intensity, not exact lazer star calculation
                </span>
              </label>
              <label>
                <span className="mb-1 block">meter</span>
                <input
                  type="number"
                  min="1"
                  max="12"
                  value={mapSettings.meter}
                  onChange={(event) => setSetting("meter", Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                />
              </label>
              <label>
                <span className="mb-1 block">timing volume</span>
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={mapSettings.timingVolume}
                  onChange={(event) => setSetting("timingVolume", Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                />
              </label>
              <label>
                <span className="mb-1 block">sample set (0-3)</span>
                <input
                  type="number"
                  min="0"
                  max="3"
                  value={mapSettings.sampleSet}
                  onChange={(event) => setSetting("sampleSet", Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                />
              </label>
              <label>
                <span className="mb-1 block">sample index</span>
                <input
                  type="number"
                  min="0"
                  value={mapSettings.sampleIndex}
                  onChange={(event) => setSetting("sampleIndex", Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                />
              </label>
              <label>
                <span className="mb-1 block">effects</span>
                <input
                  type="number"
                  min="0"
                  max="1"
                  value={mapSettings.effects}
                  onChange={(event) => setSetting("effects", Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                />
              </label>
              <label>
                <span className="mb-1 block">max notes</span>
                <input
                  type="number"
                  min="1"
                  max="2000"
                  value={mapSettings.maxNotes}
                  onChange={(event) => setSetting("maxNotes", Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                />
              </label>
              <label>
                <span className="mb-1 block">note density (0.1-1.0)</span>
                <input
                  type="number"
                  step="0.01"
                  min="0.1"
                  max="1"
                  value={mapSettings.noteDensity}
                  onChange={(event) => setSetting("noteDensity", Number(event.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                />
              </label>
            </div>
          </article>
        </section>
      )}
    </main>
  );
}

