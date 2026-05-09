import { useEffect, useMemo, useRef, useState } from "react";
import { parseBlob } from "music-metadata-browser";

const MB = 1024 * 1024;
const API_BASE = import.meta.env.VITE_API_BASE || "http://127.0.0.1:8000";

const emptyMetadata = {
  title: "",
  artist: "",
  creator: "",
  version: "normal",
  source: "",
  tags: ""
};

const defaultMapSettings = {
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

function buildOsuContent({ metadata, audioFilename, timingPointLines, hitObjectLines }) {
  const title = cleanField(metadata.title, "untitled");
  const artist = cleanField(metadata.artist, "unknown artist");
  const creator = cleanField(metadata.creator, "osumaps");
  const version = cleanField(metadata.version, "generated");
  const source = cleanField(metadata.source, "");
  const tags = cleanField(metadata.tags, "auto generated osumaps");

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
    "HPDrainRate:5",
    "CircleSize:4",
    "OverallDifficulty:7",
    "ApproachRate:8",
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
  if (firstHitTime !== null && firstTimingTime !== null && firstTimingTime > firstHitTime) {
    issues.push("first timing point starts after first hit object");
  }

  return {
    ok: issues.length === 0,
    issues
  };
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

    const formData = new FormData();
    formData.append("audio", audioFile);

    try {
      const response = await fetch(`${API_BASE}/analyze/bpm`, {
        method: "POST",
        body: formData
      });

      if (!response.ok) {
        const errorPayload = await response.json().catch(() => null);
        throw new Error(errorPayload?.detail || "analysis request failed");
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
          beats: analysisPayload.beats,
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
      setTimingPoints(payload.timing_points ?? []);
      setNotesError("");
      setHitObjects([]);
      setValidationResult(null);
      return payload.timing_points ?? [];
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
          density: mapSettings.noteDensity
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

    const result = validateBeatmapDraft({
      metadata,
      timingPoints: generatedTiming,
      hitObjects: generatedNotes
    });
    setValidationResult(result);
    setIsRunningPipeline(false);
  };

  const exportOsuFile = () => {
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
      hitObjectLines: hitObjects.map((obj) => obj.line)
    });

    const artistPart = sanitizeFilenamePart(metadata.artist, "unknown artist");
    const titlePart = sanitizeFilenamePart(metadata.title, "untitled");
    const creatorPart = sanitizeFilenamePart(metadata.creator, "osumaps");
    const versionPart = sanitizeFilenamePart(metadata.version, "generated");
    const fileName = `${artistPart} - ${titlePart} (${creatorPart}) [${versionPart}].osu`;

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
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
              onClick={exportOsuFile}
              className="mt-3 rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
            >
              export .osu
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

