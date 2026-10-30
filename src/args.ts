import { basename, dirname, isAbsolute, resolve } from "node:path";

export class UsageError extends Error {}

export interface RenderPlan {
  /** Directory that is served over http. */
  root: string;
  /** Entry page inside root, relative to root. */
  page: string;
  out: string;
  fps: number;
  duration: number;
  width: number;
  height: number;
  crf: number;
  preset: string;
  chrome: string;
  /** Frame offset of the first rendered frame. */
  start: number;
  workers: number;
  /** Directory that also receives every rendered frame as a PNG, or null. */
  keepFrames: string | null;
  gpu: boolean;
  /** Text the renderer's GPU string must contain, or null to accept any. */
  expectGpu: string | null;
  verify: boolean;
  readyTimeout: number;
}

const VALUE_FLAGS = new Set([
  "out",
  "fps",
  "duration",
  "size",
  "crf",
  "preset",
  "chrome",
  "page",
  "start",
  "workers",
  "keep-frames",
  "gpu",
  "expect-gpu",
  "ready-timeout",
]);

export const HELP = `mrh - render a Motion page into a deterministic MP4

usage
  mrh render <page-dir> [options]

arguments
  <page-dir>          directory of the built page. It is served over http for
                      the duration of the render.

options
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
  -h, --help          show this help
  -v, --version       show the version

page contract
  The page must expose window.seek(t) taking seconds, and set
  window.__ready = true once its fonts and assets are in place. The
  composition has to be a pure function of t.
`;

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "render"; plan: RenderPlan };

function intValue(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new UsageError(`--${name} needs a whole number, got "${raw}"`);
  return value;
}

function floatValue(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new UsageError(`--${name} needs a number, got "${raw}"`);
  return value;
}

function parseSize(raw: string | undefined): { width: number; height: number } {
  if (raw === undefined) return { width: 1920, height: 1080 };
  const match = /^(\d+)x(\d+)$/.exec(raw);
  if (!match) throw new UsageError(`--size needs WxH, got "${raw}"`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 1 || height < 1) throw new UsageError("--size needs positive dimensions");
  return { width, height };
}

function parseGpu(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const value = raw.toLowerCase();
  if (["on", "true", "1", "gpu"].includes(value)) return true;
  if (["off", "false", "0", "software", "swiftshader"].includes(value)) return false;
  throw new UsageError(`--gpu needs on or off, got "${raw}"`);
}

export function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let verify = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version" || arg === "-v") return { kind: "version" };
    if (arg === "--no-verify") {
      verify = false;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!VALUE_FLAGS.has(name)) throw new UsageError(`unknown flag --${name}`);
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      values.set(name, value);
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) throw new UsageError(`unknown flag ${arg}`);
    positional.push(arg);
  }

  if (positional.length === 0) throw new UsageError("a page directory is required");
  if (positional.length > 1) throw new UsageError(`expected one page directory, got ${positional.length}`);

  let root = positional[0]!;
  let page = values.get("page") ?? "index.html";
  if (isAbsolute(page)) {
    root = dirname(page);
    page = basename(page);
  }
  root = resolve(root);
  page = page.replace(/^\.\//, "");

  const fps = intValue("fps", values.get("fps"), 30);
  const duration = floatValue("duration", values.get("duration"), 10);
  const { width, height } = parseSize(values.get("size"));
  const crf = intValue("crf", values.get("crf"), 18);
  const preset = values.get("preset") ?? "medium";
  const chrome = values.get("chrome") ?? "/usr/bin/chromium";
  const start = intValue("start", values.get("start"), 0);
  const workers = intValue("workers", values.get("workers"), 4);
  const keepFrames = values.get("keep-frames") ?? null;
  const gpu = parseGpu(values.get("gpu"));
  const expectGpu = values.get("expect-gpu") ?? null;
  const readyTimeout = intValue("ready-timeout", values.get("ready-timeout"), 30_000);
  const out = resolve(values.get("out") ?? "out.mp4");

  if (fps < 1) throw new UsageError("--fps must be at least 1");
  if (duration <= 0) throw new UsageError("--duration must be greater than 0");
  if (crf < 0 || crf > 51) throw new UsageError("--crf must be between 0 and 51");
  if (start < 0) throw new UsageError("--start must be 0 or greater");
  if (workers < 1) throw new UsageError("--workers must be at least 1");
  if (readyTimeout < 1000) throw new UsageError("--ready-timeout must be at least 1000ms");

  return {
    kind: "render",
    plan: {
      root,
      page,
      out,
      fps,
      duration,
      width,
      height,
      crf,
      preset,
      chrome,
      start,
      workers,
      keepFrames: keepFrames === null ? null : resolve(keepFrames),
      gpu,
      expectGpu,
      verify,
      readyTimeout,
    },
  };
}
