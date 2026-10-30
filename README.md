# mrh - motion render harness

Renders a Motion page into a deterministic MP4. One command, no intermediate
images on disk.

```bash
bun install
bun link            # puts `mrh` on PATH

mrh render ./dist --out out.mp4 --fps 30 --duration 10 --size 1920x1080
```

The CLI serves the page directory over http on a free port, drives the page's
`window.seek(t)` frame by frame with Chromium, pipes the PNG frames straight
into ffmpeg, and checks the result with ffprobe.

## Requirements

| Requirement | Notes |
|---|---|
| Bun | 1.4 or newer |
| ffmpeg and ffprobe | on `PATH` |
| Chromium | default `/usr/bin/chromium`, override with `--chrome` |
| Motion | in the page you render, `motion` v14+. See [Motion](#motion) |

The first three are on the machine. Motion is a requirement on the page, and
it is the one that is easy to miss: a page that is not built on Motion cannot
be rendered frame by frame at all.

## Options

```
mrh render <page-dir> [options]

  --out <file>        output video path (default: out.mp4)
  --fps <n>           frames per second (default: 30)
  --duration <s>      seconds to render (default: 10)
  --size <WxH>        viewport size (default: 1920x1080)
  --crf <n>           x264 quality, lower is better (default: 18)
  --preset <name>     x264 preset (default: medium)
  --page <file>       entry page inside <page-dir> (default: index.html)
  --start <frame>     first frame index, a frame offset and not a time (default: 0)
  --workers <n>       render in n parallel segment processes (default: 4)
  --keep-frames <dir> also write every frame to <dir> as a PNG
  --gpu <on|off>      GPU rasterization, or software (default: on)
  --expect-gpu <text>  fail the render unless the GPU string contains this
                      text, e.g. "NVIDIA GeForce RTX 4070"
  --chrome <path>     Chromium executable (default: /usr/bin/chromium)
  --ready-timeout <ms>  how long to wait for the page (default: 30000)
  --no-verify         skip the ffprobe check of the output
```

## Motion

The page must be built on [Motion](https://motion.dev), the npm package
`motion`. `mrh` renders by scrubbing an animation's timeline to an absolute
time, and only Motion's hybrid `animate` can be moved that way. The page's
own project installs it, `bun add motion`.

```ts
import { animate } from "motion";

const timeline = animate([
  ["#title", { opacity: [0, 1], y: [28, 0] }, { duration: 0.7 }],
  ["#l1", { opacity: [0, 1], x: [-18, 0] }, { duration: 0.5, at: "+0" }],
]);

timeline.pause();

window.seek = (t: number) => {
  timeline.time = t;
};

document.fonts.ready.then(() => {
  window.__ready = true;
});
```

Two parts of that sample carry the requirement.

`animate` from `"motion"`, not `"motion/mini"`. The hybrid `animate` keeps
its values in JavaScript, so the timeline can be moved. `motion/mini` hands
off to the Web Animations API and jumps to the end value. A page built on
mini renders, passes every check, and comes out with the same picture on
every frame after the first.

`timeline.pause()`. An animation that keeps playing on the browser's clock
moves between the seek and the capture, so the frame that lands on disk
depends on how fast the machine is. A paused timeline only moves when the
page is told to.

| Motion API | Scrubbable |
|---|---|
| `animate()` from `"motion"` (hybrid) | yes. The supported path |
| `motion/mini` | no. It jumps to the end value |
| CSS keyframes, Web Animations API | no. The browser owns the clock |
| view transitions, optimized-appear | no. They jump to the end value |
| `whileHover`, `whileInView`, drag, scroll | no. Gesture-driven and viewport-driven animation cannot be rendered by seeking |

The rule behind the table: the composition must be a pure function of `t`.

## Page contract

The page must:

- expose `window.seek(t)`, taking seconds, and set the state at that time;
- set `window.__ready = true` once fonts and assets are in place;
- hold its animations still between seeks.

A Motion page scrubs the hybrid `animate` from `"motion"` and pauses it, as
in the sample above. `fixtures/motion-page` is a working example.

## GPU

The render runs on ANGLE's Vulkan backend, which reaches the discrete GPU on a
hybrid laptop. The GL backend lands on the integrated GPU, because that is
what the system GL dispatch picks when both are present. Chromium falls back to
GL on a machine with no Vulkan driver.

Every render reports the GPU it ran on, and `--expect-gpu` turns that report
into a check:

```bash
mrh render ./dist --expect-gpu "NVIDIA GeForce RTX 4070"
```

The check runs before the first frame, so a render on the wrong hardware fails
in seconds rather than after the whole duration. `--gpu off` renders in
software and reports SwiftShader.

The renderer string is part of the output's identity. Intel and NVIDIA
rasterize the same page differently, so a video rendered on one is not
comparable to a video rendered on the other.

## Parallel rendering

`--workers n` splits the frame range across n processes, each encoding its own
segment, then joins them with `ffmpeg -f concat -c copy`. Frame N depends only
on `t`, so the split is safe. Generally 4 workers render about 3 times
faster than one process.

`--start` is a frame offset, not a time offset. A render with `--start 450`
produces the same frames as the first 450 frames of a longer render.

## Debugging

`--keep-frames <dir>` writes every frame as a PNG next to the video, so the
video can be re-encoded without rendering again.

## Fixtures

```bash
bun run build:fixtures   # rebuild fixtures/motion-page/app.js
mrh render fixtures/basic --out /tmp/basic.mp4 --fps 30 --duration 3 --size 640x360
mrh render fixtures/motion-page --out /tmp/motion.mp4 --fps 30 --duration 3 --size 1280x720
```

## Specs

`goal-and-requirements.md` is what the tool is and why. `architecture.md` is
how it is put together.
