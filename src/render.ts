import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RenderPlan } from "./args";
import { captureFrames, type GpuInfo } from "./capture";
import { concatSegments, FfmpegEncoder } from "./encoder";
import { startServer } from "./server";
import { verifyOutput, type VerifyCheck } from "./verify";

export interface RenderSummary {
  out: string;
  frames: number;
  duration: number;
  elapsedMs: number;
  checks: VerifyCheck[];
  /** The distinct GPUs the render ran on, one per segment worker. */
  gpu: string[];
}

export async function render(plan: RenderPlan): Promise<RenderSummary> {
  preflight(plan);

  const totalFrames = Math.round(plan.duration * plan.fps);
  const server = startServer(plan.root);
  const started = Date.now();

  try {
    const pageUrl = `${server.url}/${plan.page.split("/").map(encodeURIComponent).join("/")}`;

    const gpu =
      plan.workers > 1 && totalFrames > 1
        ? await renderParallel(plan, pageUrl, totalFrames)
        : await renderSingle(plan, pageUrl, totalFrames);

    const elapsedMs = Date.now() - started;
    const checks = plan.verify
      ? await verifyOutput(plan.out, {
          width: plan.width,
          height: plan.height,
          fps: plan.fps,
          frames: totalFrames,
          duration: plan.duration,
        })
      : [];

    return { out: plan.out, frames: totalFrames, duration: plan.duration, elapsedMs, checks, gpu };
  } finally {
    server.stop();
  }
}

async function renderSingle(plan: RenderPlan, pageUrl: string, totalFrames: number): Promise<string[]> {
  const encoder = new FfmpegEncoder({
    fps: plan.fps,
    crf: plan.crf,
    preset: plan.preset,
    out: plan.out,
  });

  try {
    const { gpu } = await captureFrames(captureConfig(plan, pageUrl), {
      startFrame: plan.start,
      totalFrames,
      fps: plan.fps,
      keepFrames: plan.keepFrames,
      label: "render",
      onFrame: (png) => encoder.write(png),
    });
    await encoder.close();
    return gpu === null ? [] : [gpu.renderer];
  } catch (error) {
    await encoder.abort();
    throw error;
  }
}

async function renderParallel(plan: RenderPlan, pageUrl: string, totalFrames: number): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "mrh-segments-"));
  const workerPath = join(import.meta.dir, "worker.ts");

  try {
    const chunks = splitFrames(plan.start, totalFrames, plan.workers);
    const segments = chunks.map((_, index) => join(dir, `segment-${index}.mp4`));
    const gpuFiles = chunks.map((_, index) => join(dir, `segment-${index}.gpu.json`));

    const processes = chunks.map((chunk, index) =>
      Bun.spawn(
        [
          process.execPath,
          "run",
          workerPath,
          JSON.stringify({
            plan,
            url: pageUrl,
            range: chunk,
            out: segments[index],
            gpuOut: gpuFiles[index],
          }),
        ],
        { stdout: "inherit", stderr: "inherit" },
      ),
    );

    const codes = await Promise.all(processes.map((proc) => proc.exited));
    const failed = codes.findIndex((code) => code !== 0);
    if (failed !== -1) {
      throw new Error(`segment worker ${failed} failed with exit code ${codes[failed]}`);
    }

    const renderers: string[] = [];
    for (const file of gpuFiles) {
      const gpu = await readGpuFile(file);
      if (gpu !== null && !renderers.includes(gpu.renderer)) renderers.push(gpu.renderer);
    }

    await concatSegments(segments, plan.out, {
      fps: plan.fps,
      crf: plan.crf,
      preset: plan.preset,
    });
    return renderers;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readGpuFile(file: string): Promise<GpuInfo | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<GpuInfo>;
    return typeof parsed.renderer === "string" ? (parsed as GpuInfo) : null;
  } catch {
    return null;
  }
}

function captureConfig(plan: RenderPlan, pageUrl: string) {
  return {
    url: pageUrl,
    chrome: plan.chrome,
    width: plan.width,
    height: plan.height,
    gpu: plan.gpu,
    expectGpu: plan.expectGpu,
    readyTimeout: plan.readyTimeout,
  };
}

/** Contiguous frame ranges, as evenly sized as the frame count allows. */
function splitFrames(start: number, total: number, workers: number): Array<{ start: number; count: number }> {
  const perWorker = Math.ceil(total / workers);
  const chunks: Array<{ start: number; count: number }> = [];
  for (let index = 0; index < workers; index++) {
    const count = Math.min(perWorker, total - index * perWorker);
    if (count <= 0) continue;
    chunks.push({ start: start + index * perWorker, count });
  }
  return chunks;
}

function preflight(plan: RenderPlan): void {
  if (!existsSync(plan.root) || !statSync(plan.root).isDirectory()) {
    throw new Error(`the page directory does not exist: ${plan.root}`);
  }
  const pagePath = resolve(plan.root, plan.page);
  if (!existsSync(pagePath)) {
    throw new Error(`the page does not exist: ${pagePath}`);
  }
  if (!existsSync(plan.chrome)) {
    throw new Error(`chromium does not exist at ${plan.chrome}`);
  }
  if (Bun.which("ffmpeg") === null) {
    throw new Error("ffmpeg is not on PATH");
  }
  const outDir = dirname(plan.out);
  if (!existsSync(outDir)) {
    throw new Error(`the output directory does not exist: ${outDir}`);
  }
}
