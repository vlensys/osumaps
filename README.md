# osumaps

audio to osu! lazer map converter.

## live app

- frontend: `https://vlensys.github.io/osumaps/`
- backend api: `https://osumaps.vercel.app/api/health`

## how to use

1. upload an `.mp3` or `.flac`.
2. review or edit metadata (`title`, `artist`, `creator`, `version`).
3. choose `difficulty tier` and `target stars`.
4. click `run full pipeline`.
5. confirm `sanity status` and preview playback sync.
6. click `export .osz` and import it in osu! lazer.

## generation settings

- `difficulty tier`:
  - picks a full difficulty profile at once (`cs`, `ar`, `od`, `hp`, `sv`) and mapping behavior.
- `target stars`:
  - calibration target for generated map strain (generator keeps output near this value).
- `meter`, `timing volume`, `sample set`, `sample index`, `effects`:
  - written into `[TimingPoints]`.
- `max notes`:
  - hard cap for generated hit objects.

## what the generator does

- uses librosa onset detection, spectral flux, rms, and frequency bands (bass/mid/high).
- places notes on detected onsets (not plain bpm grid).
- applies time-distance equality so faster rhythms are tighter and slower rhythms jump farther.
- spreads notes across both `x` and `y` axes and enforces minimum spacing.
- writes `[Difficulty]` values directly into `.osu`:
  - `HPDrainRate`
  - `CircleSize`
  - `OverallDifficulty`
  - `ApproachRate`
  - `SliderMultiplier`

## troubleshooting

- `networkerror` / API failures:
  - verify backend health at `https://osumaps.vercel.app/api/health`.
- `413` on hosted backend:
  - file is too large for current hosted request limits; try a smaller file or run backend locally.
- `ses removing unpermitted intrinsics` logs:
  - from browser extension sandboxing, not this app.

## note

- generated maps are drafts; playtest and refine in lazer editor.
- uploaded audio is used only for generation and is not persisted by this app.
