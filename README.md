# SeeDance 2 Stitcher

Local browser tool for stitching two SeeDance 2 video generations when the end of the first clip and the start of the second clip overlap or shift slightly in brightness/contrast.

## Features

- Drag and drop two MP4/video files.
- Detect overlapping frames at the stitch point.
- Recommend frame trimming.
- Preserve audio on export.
- Smooth brightness/contrast at the join, or apply the join correction to all of video 2.
- Export descriptive filenames such as `video1_video2_rm-v2s4f_cut_tonefull.mp4`.
- Export labelled 2s or 5s comparison collages:
  - Top: original unedited join.
  - Bottom: stitched result with current settings.

## Requirements

- Node.js 18+
- FFmpeg and FFprobe available on your machine

On Windows, the app will first look for FFmpeg at:

`C:\Program Files\ffmpeg-6.0-full_build-shared\bin\ffmpeg.exe`

You can override paths with environment variables:

```powershell
$env:FFMPEG_PATH="C:\path\to\ffmpeg.exe"
$env:FFPROBE_PATH="C:\path\to\ffprobe.exe"
```

## Run

```powershell
npm start
```

Then open:

`http://localhost:4177`

To use bundled sample videos, create:

```text
samples/video1.mp4
samples/video2.mp4
```

Otherwise, just upload clips in the browser.

## Notes

For best results, generate clips with diegetic sound effects and dialogue only. Add soundtrack or music after stitching, because music beds rarely overlap cleanly across regenerated clips.

## License

MIT
