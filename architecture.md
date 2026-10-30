---
id: mrh-architecture
type: architecture-design
status: draft
title: Motion Render Harness CLI architecture
parent: motion-render-harness-cli
depends-on: [motion-render-harness-cli]
---

# Motion Render Harness CLI architecture

## Shape

A render runs four stages in one process: serve the page directory, capture frames by seeking the page, encode the frames through ffmpeg, then verify the result. A parallel render repeats the capture and encode stages in worker processes and adds a concat step.

## Boundaries

- The CLI layer parses arguments into a render plan and owns nothing else. Every later stage takes the plan as it is.
- The page server owns the static directory and the port. It knows nothing about capture or ffmpeg.
- The capture layer owns the Chromium lifecycle, the page contract and the frame loop. It yields PNG buffers in frame order and knows nothing about ffmpeg.
- The encoder layer owns the ffmpeg child, its stdin pipe and the segment concat. It takes byte buffers and never touches a browser.
- The verification layer owns ffprobe and the comparison against the requested values.

Only the capture layer launches Chromium. Only the encoder layer spawns ffmpeg. The CLI layer does neither, so a stage can be tested or replaced without touching the ones around it.

## Decisions

- The static server is Bun's own `Bun.serve`. The runtime is Bun, so the tool carries no http dependency.
- The page contract is `window.seek(t)` taking seconds, plus `window.__ready = true`. The CLI waits for `__ready`, then for `document.fonts.ready`, then seeks. It never inspects the page's DOM and never waits on a selector. Everything Motion-specific belongs to the page. In published Motion there is no `processFrame`: the hybrid `animate` returns controls whose `time` scrubs the timeline, and the timeline has to be paused, because an animation that keeps running on the browser's clock moves between the seek and the capture.
- One static server is shared across a parallel render. Each worker owns a Chromium and an ffmpeg child, and receives the plan and the server URL as arguments.
- GPU raster is the default; `--gpu off` forces software raster. The flags that define a render live in one place, so two runs cannot differ because a flag was forgotten in one path.
- The GPU path uses ANGLE's Vulkan backend (`--use-gl=angle --use-angle=vulkan`). ANGLE's GL backend resolves to the integrated GPU on a hybrid laptop, because that is what the system GL dispatch picks when both GPUs are present. The Vulkan backend resolves to the discrete GPU, and Chromium falls back to GL on a machine with no Vulkan ICD, so the flag needs no host detection and no vendor-specific environment variables.
- The capture layer reads the browser's GPU string over CDP after the browser launches, before the first frame. The render reports it, and `--expect-gpu` fails the render when it does not contain the expected text. The check belongs here rather than in the CLI layer, because only the capture layer owns the browser. A parallel render has one browser per worker, so each worker checks and reports its own GPU and the summary lists the distinct values.
- The frame is captured with Chromium's faster PNG path. The PNG encode is the largest per-frame cost in a DOM and SVG composition, where there is no GPU-bound work to accelerate: 87 ms against 278 ms per 1920x1080 frame. The pixels are the same and only the file is bigger, which costs nothing because the PNG is streamed to ffmpeg and never written to disk unless `--keep-frames` asks for it.
- `--keep-frames` writes PNGs to disk *in addition* to streaming them to ffmpeg. A debug render still produces the video and the frames needed for a later re-encode.
- Segments are concatenated with `-c copy` when the encoder parameters match, and re-encoded when they do not.
- `start` is a frame offset, never a time offset. `duration` is the length of the segment being rendered.
- The default worker count is 4. Worker scaling is near-linear to 4 and 8 and flattens after, and a fixed number keeps the segment count, and therefore the output bytes, independent of the host.

## Invariants

1. Frame N is a pure function of `t = N / fps`. The renderer seeks to an absolute time for every frame and never advances by wall clock. This is what makes segments safe to run in parallel and what makes two runs byte-identical on one machine.
2. The page is served over http, never `file://`. The CLI starts the server itself, on a port it picks.
3. In the default path a frame never touches disk. A PNG exists only in memory between the screenshot and the write to ffmpeg.
4. Viewport size, `deviceScaleFactor: 1` and the browser flag set are fixed. No render setting may depend on the host's display or its running state. The GPU driver is not a render setting: it is part of the output's identity, and the render reports which one it used.
5. A dead ffmpeg fails the render. The write to ffmpeg's stdin races the child's exit, so the outcome is an error carrying ffmpeg's stderr, never a hang on a drain that will not arrive.
6. The render fails rather than degrading quietly. A page without `window.seek`, a `__ready` that never arrives, a frame count that does not match the request, and a GPU that is not the expected one are all errors.

## Out of scope

- Audio muxing, authoring or editing the animation, and bundling Chromium or ffmpeg.
