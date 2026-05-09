# osumaps

audio to osu! lazer map converter.

## live app

- frontend: `https://vlensys.github.io/osumaps/`
- backend api: `https://osumaps.vercel.app/api/health`

## how to use

1. open the app and upload an `.mp3` or `.flac` file.
2. edit metadata fields on the right (title, artist, creator, difficulty name).
3. click `run full pipeline`.
4. check `sanity status`.
5. click `export .osz`.
6. import the exported `.osz` package in osu! lazer.

## manual buttons (optional)

- `analyze bpm`: local, browser-side BPM/beat detection (audio does not upload).
- `generate timing points`: sends beat data to API and builds `[TimingPoints]`.
- `generate note pattern`: sends beat features to API and builds `[HitObjects]`.
- `run beatmap sanity check`: validates common format mistakes.

## generation settings explained

- `meter`:
  - beats per measure used in `[TimingPoints]`.
  - common values: `4` (most songs), `3` (waltz feel).
- `timing volume`:
  - hit sound sample volume value written into timing points (`0-100`).
  - affects perceived loudness of map hit samples.
- `sample set (0-3)`:
  - timing point sample set id.
  - `1` is standard default for most maps.
- `sample index`:
  - custom sample bank index for timing samples.
  - leave `0` unless you use custom sample sets.
- `effects`:
  - timing point effects flag.
  - keep `0` for normal behavior.
- `max notes`:
  - hard cap on generated hit objects.
  - lower = sparser/easier drafts, higher = denser drafts.
- `note density (0.1-1.0)`:
  - intensity threshold for how many beats become notes.
  - lower values generate more notes; higher values generate fewer notes.

## troubleshooting

- `networkerror` / `cors` on analyze:
  - fixed by local analysis in browser. no audio upload for BPM step.
- `413` request entity too large:
  - avoided for analyze step, because BPM is client-side.
- `ses removing unpermitted intrinsics` logs:
  - these logs are from browser extension sandboxing (not from this app code).
- if API calls fail for timing/note generation:
  - verify `https://osumaps.vercel.app/api/health` returns `{ "status": "ok" }`.

## notes

- generated maps are auto-mapped drafts. always playtest and adjust in lazer editor.
- this project does not store uploaded audio.
