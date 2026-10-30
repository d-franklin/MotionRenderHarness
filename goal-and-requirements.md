---
id: motion-render-harness-cli
type: goal-and-requirements
title: Motion Render Harness CLI
status: active
---

# Motion Render Harness CLI

Render a Motion page into a deterministic MP4 from one command.

## Overview

`mrh` is a Bun CLI that takes a directory of built page files, serves it over `http://localhost` on a free port, drives the page's `window.seek(t)` frame by frame with Chromium, and pipes the PNG frames straight into ffmpeg to produce an H.264 MP4.

It replaces the hand-run driver script plus the separately started `python3 -m http.server` bound to a hand-picked port. The browser and encoder settings that make a render reproducible are fixed in the tool instead of typed into a command each time.

## Problem

Rendering a Motion animation to video is several loosely coupled steps: serve the built page over http on a port you have to check is free, run a driver with `key=value` arguments, and get the browser flags right. The failures are quiet. Identical frames mean `useManualTiming` was set too late or `motion/mini` is in use. A shifted layout means a scrollbar. Wrong glyphs in the first frames mean fonts were not ready. A hang means ffmpeg died while the driver waited for a drain that never comes. None of those names itself.

The work is repetitive enough to deserve one command with fixed settings and errors that name the cause.

## Capabilities

- **Render a page directory to an MP4 in one command.** `mrh render ./dist --out out.mp4 --fps 30 --duration 10 --size 1920x1080 --crf 18`. The CLI picks a free port, serves the directory, waits for `window.__ready` and for fonts, then seeks and captures. Without this the tool has no purpose.
- **Deterministic capture.** Fixed Chromium flags (no scrollbar, srgb color profile, no font hinting, no LCD text, no paint holding, no throttling), a fixed viewport, `deviceScaleFactor: 1`, and one `seek(t)` per frame. The output is a pure function of `t`, so two runs of the same input are byte-identical on the same machine and GPU driver. Everything else rests on this.
- **Report and assert the GPU.** Every render prints the renderer string of the GPU it ran on, and `--expect-gpu <text>` fails the render when that string does not contain the expected text. The check runs before the first frame, so a render on the wrong hardware fails in seconds rather than after the whole duration. A silent difference between the integrated and the discrete GPU is the same class of quiet failure as the ones listed above.
- **Frames straight into ffmpeg over stdin.** H.264, `yuv420p`, `+faststart`, with backpressure handling and fail-fast when ffmpeg dies mid-render. No PNGs on disk, no second encode pass, no hang.
- **Verify the output.** After encoding, check codec, dimensions, frame rate, frame count and duration against what was asked for, and report any mismatch.
- **Parallel segment rendering.** Split the frame range across worker processes, each encoding its own segment with identical settings, then concat with `-c copy`. Long clips render at the machine's pace instead of one process's. Four workers by default.
- **Keep PNG frames.** Debug mode writes the frames to disk so a render can be re-encoded without re-rendering.

## Non-Goals

- Audio. Not part of the first build.
- Authoring or editing the animation. The CLI renders a page it does not modify.
- Replacing Chromium or ffmpeg. Both are external prerequisites on `PATH`.

## Tech Notes

- Runtime and package manager: Bun (1.4.4 here). npm is absent on this machine.
- Browser: `puppeteer-core` against the system Chromium at `/usr/bin/chromium`. No browser download.
- Encoder: ffmpeg on `PATH`.
- CLI shape: one subcommand, `mrh render <page-dir> [flags]`. Positional input, long flags, `--help` for the full set.
- The page contract is the page's job, not the CLI's. The page must expose `window.seek(t)` taking seconds, set `window.__ready = true` once fonts and assets are in place, and hold its animations still between seeks. A Motion page scrubs the hybrid `animate` from `"motion"` through the returned controls' `time`, and pauses the timeline. An animation that keeps running on the browser's clock moves between the seek and the capture, so the frame that lands on disk depends on how fast the machine is.
- The composition must be a pure function of `t`. Gesture-driven and viewport-driven animation cannot be rendered by seeking.
- Rasterizer: GPU by default, with `--gpu off` falling back to software raster. The GPU path uses ANGLE's Vulkan backend, because ANGLE's GL backend resolves to the integrated GPU on a hybrid laptop. GPU raster is not guaranteed identical across machines or drivers, so a byte-level comparison is only meaningful within one environment, and a video rendered on one GPU is not comparable to a video rendered on another.
- Frame capture cost: the PNG encode inside Chromium's screenshot is the largest per-frame cost in a DOM and SVG composition, where there is no GPU-bound work to accelerate. The capture uses Chromium's faster PNG path, which produces the same pixels in a larger file.
- Throughput on the reference machine (i9-14900HX, RTX 4070 Max-Q Laptop): one worker renders about 10 frames/s, four workers about 32 frames/s, enough for realtime 30 fps output.

## Alternatives Considered

- **web2mp4** — same pipe-to-ffmpeg architecture, but its page contract is `window.setFrameTime(t)` with `window.__frameReady`, and it is Node-targeted with GPU-angle tuning written for macOS. <https://github.com/leog25/web2mp4>
- **kamishibai** — a fuller renderer with React helpers, audio, subtitles, narration and incremental rebuilds. Its contract is `window.kamishibai = { meta, seek(ms) }` and it drives Playwright rather than puppeteer-core. <https://github.com/reearth/kamishibai>
- **hyperframes** — states the deterministic-rendering contract this tool also depends on, but is a scene and composition system rather than a page-to-video CLI. <https://github.com/heygen-com/hyperframes>
