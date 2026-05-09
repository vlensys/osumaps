import { useEffect, useMemo, useRef, useState } from "react";

const MB = 1024 * 1024;

const emptyMetadata = {
  title: "",
  artist: "",
  creator: "",
  version: "normal",
  source: "",
  tags: ""
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

export default function App() {
  const fileRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [audioFile, setAudioFile] = useState(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [durationSec, setDurationSec] = useState(0);
  const [metadata, setMetadata] = useState(emptyMetadata);

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

  const updateFile = (file) => {
    if (!file) return;
    const validExt = /\.(mp3|flac)$/i.test(file.name);
    if (!validExt) {
      alert("only mp3 and flac are supported");
      return;
    }

    const nameMeta = parseName(file.name);
    const nextUrl = URL.createObjectURL(file);

    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioFile(file);
    setAudioUrl(nextUrl);
    setDurationSec(0);
    setMetadata((current) => ({
      ...current,
      title: nameMeta.title || current.title,
      artist: nameMeta.artist || current.artist
    }));
  };

  const onInputChange = (event) => {
    const selected = event.target.files?.[0];
    updateFile(selected);
  };

  const onDrop = (event) => {
    event.preventDefault();
    setDragActive(false);
    const dropped = event.dataTransfer.files?.[0];
    updateFile(dropped);
  };

  const setField = (field, value) => {
    setMetadata((current) => ({ ...current, [field]: value }));
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
              controls
              src={audioUrl}
              className="mt-4 w-full"
              onLoadedMetadata={(event) => setDurationSec(event.currentTarget.duration)}
            />
          </article>

          <article className="rounded-2xl bg-slate-900 p-6">
            <h2 className="text-xl font-semibold">map metadata</h2>
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
          </article>
        </section>
      )}
    </main>
  );
}

