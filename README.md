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
5. click `export .osu`.
6. place the exported `.osu` in the same folder as the audio file.
7. import the folder in osu! lazer.

## manual buttons (optional)

- `analyze bpm`: local, browser-side BPM/beat detection (audio does not upload).
- `generate timing points`: sends beat data to API and builds `[TimingPoints]`.
- `generate note pattern`: sends beat features to API and builds `[HitObjects]`.
- `run beatmap sanity check`: validates common format mistakes.

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
