import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const API_BASE = process.env.API_BASE || "http://127.0.0.1:8000";

function buildOsuContent({ title, artist, creator, version, audioFilename, timingPointLines, hitObjectLines }) {
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
    "Source:",
    "Tags:auto generated osumaps qa",
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

async function postAudio(filePath) {
  const buffer = await readFile(filePath);
  const blob = new Blob([buffer]);
  const form = new FormData();
  form.append("audio", blob, path.basename(filePath));

  const response = await fetch(`${API_BASE}/analyze/bpm`, { method: "POST", body: form });
  if (!response.ok) {
    throw new Error(`analyze/bpm failed for ${filePath}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function postJson(route, payload) {
  const response = await fetch(`${API_BASE}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`${route} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function runCase(filePath) {
  const analysis = await postAudio(filePath);
  if (!analysis.beats?.length) throw new Error(`no beats detected for ${filePath}`);

  const timing = await postJson("/generate/timing-points", {
    bpm: analysis.bpm,
    beats: analysis.beats,
    meter: 4,
    sample_set: 1,
    sample_index: 0,
    volume: 70,
    effects: 0
  });

  const notes = await postJson("/generate/hit-objects", {
    beats: analysis.beats,
    beat_strengths: analysis.beat_strengths ?? [],
    beat_centroids: analysis.beat_centroids ?? [],
    max_notes: 500,
    density: 0.78
  });

  if (!timing.timing_points?.length) throw new Error(`no timing points for ${filePath}`);
  if (!notes.hit_objects?.length) throw new Error(`no hit objects for ${filePath}`);

  const outputDir = path.join(process.cwd(), "tmp_output");
  await mkdir(outputDir, { recursive: true });

  const baseName = path.basename(filePath, path.extname(filePath));
  const osuContent = buildOsuContent({
    title: baseName,
    artist: "qa artist",
    creator: "osumaps",
    version: "qa",
    audioFilename: path.basename(filePath),
    timingPointLines: timing.timing_points.map((p) => p.line),
    hitObjectLines: notes.hit_objects.map((h) => h.line)
  });

  const outPath = path.join(outputDir, `${baseName}.osu`);
  await writeFile(outPath, osuContent, "utf8");

  return {
    filePath,
    bpm: analysis.bpm,
    beatCount: analysis.beat_count,
    timingPoints: timing.timing_points.length,
    hitObjects: notes.hit_objects.length,
    outPath
  };
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    throw new Error("usage: node scripts/qa-runner.mjs <mp3-file> <flac-file>");
  }

  for (const file of files) {
    const result = await runCase(file);
    console.log(`[ok] ${result.filePath}`);
    console.log(`  bpm=${result.bpm} beats=${result.beatCount} timing=${result.timingPoints} notes=${result.hitObjects}`);
    console.log(`  osu=${result.outPath}`);
  }
}

main().catch((error) => {
  console.error(`[fail] ${error.message}`);
  process.exit(1);
});
