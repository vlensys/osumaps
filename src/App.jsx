import { useEffect, useMemo, useRef, useState } from "react";

const MB = 1024 * 1024;
const APP_MAX_FILE_BYTES = 100 * MB;
const API_BASE =
  import.meta.env.VITE_API_BASE ||
  (typeof window !== "undefined" &&
  window.location.hostname !== "localhost" &&
  window.location.hostname !== "127.0.0.1"
    ? "https://osumaps.onrender.com/api"
    : "http://127.0.0.1:8000");

const emptyMetadata = {
  title: "",
  artist: "",
  creator: "osumaps",
  version: "normal",
  source: "",
  tags: ""
};

const defaultMapSettings = {
  starRating: 3.0,
  difficultyLabel: "Hard",
  meter: 4,
  sampleSet: 1,
  sampleIndex: 0,
  timingVolume: 70,
  effects: 0,
  maxNotes: 500,
  circleSize: 4.0,
  approachRate: 6.7,
  overallDifficulty: 5.6,
  hpDrain: 4.6,
  sliderMultiplier: 1.3,
  estimatedStar: null
};

const difficultyPresets = {
  Easy: { cs: 4.8, ar: 4.2, od: 2.6, hp: 2.6, sv: 0.7, star: 1.6 },
  Normal: { cs: 4.4, ar: 5.6, od: 4.2, hp: 3.5, sv: 0.9, star: 2.5 },
  Hard: { cs: 4.0, ar: 6.7, od: 5.6, hp: 4.6, sv: 1.3, star: 3.5 },
  Insane: { cs: 3.6, ar: 7.6, od: 6.6, hp: 5.6, sv: 1.6, star: 4.8 },
  Expert: { cs: 3.0, ar: 8.7, od: 7.6, hp: 6.6, sv: 1.9, star: 6.2 }
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

function difficultyFromStars(star) {
  if (star < 2) return "Easy";
  if (star < 3) return "Normal";
  if (star < 4) return "Hard";
  if (star < 5.5) return "Insane";
  return "Expert";
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

function buildOsuContent({ metadata, audioFilename, timingPointLines, hitObjectLines, mapSettings }) {
  const title = cleanField(metadata.title, "untitled");
  const artist = cleanField(metadata.artist, "unknown artist");
  const creator = cleanField(metadata.creator, "osumaps");
  const version = cleanField(metadata.version, "generated");
  const source = cleanField(metadata.source, "");
  const tags = cleanField(metadata.tags, "auto generated osumaps");
  const hp = Number.isFinite(mapSettings?.hpDrain) ? mapSettings.hpDrain : 4.6;
  const cs = Number.isFinite(mapSettings?.circleSize) ? mapSettings.circleSize : 4.0;
  const od = Number.isFinite(mapSettings?.overallDifficulty) ? mapSettings.overallDifficulty : 5.6;
  const ar = Number.isFinite(mapSettings?.approachRate) ? mapSettings.approachRate : 6.7;
  const sv = Number.isFinite(mapSettings?.sliderMultiplier) ? mapSettings.sliderMultiplier : 1.3;

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
    `SliderMultiplier:${sv.toFixed(2)}`,
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
    if (file.size > APP_MAX_FILE_BYTES) {
      alert("file too large. maximum supported size is 100 mb");
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
    setMapSettings((current) => {
      const next = { ...current, [field]: value };
      if (field === "starRating") {
        const label = difficultyFromStars(Number(value));
        const preset = difficultyPresets[label];
        return {
          ...next,
          difficultyLabel: label,
          circleSize: preset.cs,
          approachRate: preset.ar,
          overallDifficulty: preset.od,
          hpDrain: preset.hp,
          sliderMultiplier: preset.sv,
          estimatedStar: null
        };
      }
      if (field === "difficultyLabel" && difficultyPresets[value]) {
        const preset = difficultyPresets[value];
        return {
          ...next,
          starRating: preset.star,
          circleSize: preset.cs,
          approachRate: preset.ar,
          overallDifficulty: preset.od,
          hpDrain: preset.hp,
          sliderMultiplier: preset.sv,
          estimatedStar: null
        };
      }
      return next;
    });
  };

  const analyzeBpm = async () => {
    if (!audioFile) return;
    setIsAnalyzing(true);
    setAnalysisError("");

    try {
      const formData = new FormData();
      formData.append("audio", audioFile);
      const response = await fetch(`${API_BASE}/analyze/bpm`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        throw new Error(errorPayload?.detail || "analysis failed");
      }
      const payload = await response.json();
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

  const requestFullMap = async () => {
    if (!audioFile) return null;
    const formData = new FormData();
    formData.append("audio", audioFile);
    formData.append("difficulty_star", String(mapSettings.starRating));
    formData.append("difficulty_label", mapSettings.difficultyLabel);
    formData.append("max_notes", String(mapSettings.maxNotes));
    formData.append("meter", String(mapSettings.meter));
    formData.append("sample_set", String(mapSettings.sampleSet));
    formData.append("sample_index", String(mapSettings.sampleIndex));
    formData.append("volume", String(mapSettings.timingVolume));
    formData.append("effects", String(mapSettings.effects));

    const response = await fetch(`${API_BASE}/generate/full-map`, {
      method: "POST",
      body: formData
    });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => null);
      const detail = errorPayload?.detail || "full pipeline request failed";
      if (response.status === 413) {
        throw new Error("upload too large for hosted backend, try a smaller file or run backend locally");
      }
      throw new Error(detail);
    }
    return response.json();
  };

  const applyFullMapPayload = (payload) => {
    const nextTiming = ensureTimingStartsBeforeHits(payload.timing_points ?? [], payload.hit_objects ?? []);
    const nextHitObjects = payload.hit_objects ?? [];
    const nextSettings = payload.settings || {};
    setTimingPoints(nextTiming);
    setHitObjects(nextHitObjects);
    setMapSettings((current) => ({
      ...current,
      difficultyLabel: nextSettings.difficulty || current.difficultyLabel,
      starRating: Number.isFinite(nextSettings.target_star) ? nextSettings.target_star : current.starRating,
      circleSize: Number.isFinite(nextSettings.circle_size) ? nextSettings.circle_size : current.circleSize,
      approachRate: Number.isFinite(nextSettings.approach_rate)
        ? nextSettings.approach_rate
        : current.approachRate,
      overallDifficulty: Number.isFinite(nextSettings.overall_difficulty)
        ? nextSettings.overall_difficulty
        : current.overallDifficulty,
      hpDrain: Number.isFinite(nextSettings.hp_drain) ? nextSettings.hp_drain : current.hpDrain,
      sliderMultiplier: Number.isFinite(nextSettings.slider_multiplier)
        ? nextSettings.slider_multiplier
        : current.sliderMultiplier,
      estimatedStar: Number.isFinite(nextSettings.estimated_star)
        ? nextSettings.estimated_star
        : current.estimatedStar
    }));
    setAnalysis({
      bpm: payload.bpm,
      beat_count: payload.beat_count,
      beats: nextHitObjects.map((obj) => Number((obj.time / 1000).toFixed(4))),
      duration_sec: payload.duration_sec,
      beat_strengths: [],
      beat_centroids: []
    });
    return { nextTiming, nextHitObjects };
  };

  const generateTimingPoints = async () => {
    setIsGeneratingTiming(true);
    setTimingError("");

    try {
      const payload = await requestFullMap();
      if (!payload) return null;
      const { nextTiming } = applyFullMapPayload(payload);
      setValidationResult(null);
      return nextTiming;
    } catch (error) {
      setTimingError(error.message || "timing point generation failed");
      setTimingPoints([]);
      return null;
    } finally {
      setIsGeneratingTiming(false);
    }
  };

  const generateHitObjects = async () => {
    setIsGeneratingNotes(true);
    setNotesError("");

    try {
      const payload = await requestFullMap();
      if (!payload) return null;
      const { nextHitObjects } = applyFullMapPayload(payload);
      setExportError("");
      setValidationResult(null);
      return nextHitObjects;
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

    try {
      const payload = await requestFullMap();
      if (!payload) {
        setIsRunningPipeline(false);
        return;
      }
      const { nextTiming, nextHitObjects } = applyFullMapPayload(payload);
      const result = validateBeatmapDraft({
        metadata,
        timingPoints: nextTiming,
        hitObjects: nextHitObjects
      });
      setValidationResult(result);
    } catch (error) {
      setAnalysisError(error.message || "full pipeline failed");
    } finally {
      setIsRunningPipeline(false);
    }
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
          step 1: upload an audio track. files are sent to the backend only for analysis/generation and are not stored.
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
              {isAnalyzing ? "analyzing..." : "analyze audio"}
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
                <p>detected onsets: {analysis.beat_count}</p>
                <p>first beat at: {analysis.beats[0] ?? "n/a"} sec</p>
                <p>beat length: {analysis.bpm > 0 ? (60000 / analysis.bpm).toFixed(2) : "n/a"} ms</p>
              </div>
            )}
            <button
              type="button"
              onClick={generateTimingPoints}
              disabled={!audioFile || isGeneratingTiming}
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
              disabled={!audioFile || isGeneratingNotes}
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
                <span className="mb-1 block">difficulty tier</span>
                <select
                  value={mapSettings.difficultyLabel}
                  onChange={(event) => setSetting("difficultyLabel", event.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-300"
                >
                  {Object.keys(difficultyPresets).map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="col-span-2">
                <span className="mb-1 block">target stars ({mapSettings.starRating.toFixed(1)}★)</span>
                <input
                  type="range"
                  min="1"
                  max="7"
                  step="0.1"
                  value={mapSettings.starRating}
                  onChange={(event) => setSetting("starRating", Number(event.target.value))}
                  className="w-full accent-cyan-300"
                />
                <span className="mt-1 block text-xs text-slate-400">
                  generation auto-calibrates to roughly this star range
                </span>
              </label>
              <div className="col-span-2 rounded-lg border border-slate-700 bg-slate-950/60 p-3 text-xs text-slate-300">
                {Number.isFinite(mapSettings.estimatedStar) && (
                  <p className="mb-1 text-cyan-300">estimated stars: {mapSettings.estimatedStar.toFixed(2)}★</p>
                )}
                <p>cs: {mapSettings.circleSize.toFixed(2)}</p>
                <p>ar: {mapSettings.approachRate.toFixed(2)}</p>
                <p>od: {mapSettings.overallDifficulty.toFixed(2)}</p>
                <p>hp: {mapSettings.hpDrain.toFixed(2)}</p>
                <p>sv: {mapSettings.sliderMultiplier.toFixed(2)}</p>
              </div>
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
            </div>
          </article>
        </section>
      )}
    </main>
  );
}

