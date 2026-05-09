# test audio assets

Generated locally for QA with ffmpeg (not committed):

- `tmp_test_audio/test-tone.mp3`
- `tmp_test_audio/test-tone.flac`

Generate:

```bash
ffmpeg -f lavfi -i "sine=frequency=440:duration=20" -ar 44100 tmp_test_audio/test-tone.mp3
ffmpeg -f lavfi -i "sine=frequency=440:duration=20" -ar 44100 tmp_test_audio/test-tone.flac
```
