# qa checklist

## objective

verify generated `.osu` files open and validate in osu! lazer for one `.mp3` and one `.flac` input.

## test matrix

1. short track (`.mp3`, ~1-2 min)
2. short track (`.flac`, ~1-2 min)

## procedure

1. start backend (`uvicorn main:app --reload`) and frontend (`npm run dev`)
2. upload audio file in app
3. click `analyze bpm`
4. click `generate timing points`
5. click `generate note pattern`
6. click `run beatmap sanity check` and confirm pass
7. click `export .osu`
8. copy audio + `.osu` into same folder under osu! lazer songs import path
9. import in lazer and run beatmap validator
10. play through first 30-60 seconds and inspect sync quality

## acceptance criteria

1. no parser/format errors during import
2. validator reports no fatal timing/hitobject format issues
3. map is playable with consistent sync (no large drift)
4. generated metadata fields are populated and editable

## if validator fails

1. capture exact validator message
2. note offending line(s) from `[TimingPoints]` or `[HitObjects]`
3. patch generator logic and retest both file types
