import { writeFile } from "node:fs/promises";
import type { RenderPlan } from "./args";
import { captureFrames } from "./capture";
import { FfmpegEncoder } from "./encoder";

export interface SegmentJob {
  plan: RenderPlan;
  url: string;
  range: { start: number; count: number };
  out: string;
  /** File the worker writes its GPU string to, so the parent can report it. */
  gpuOut: string;
}

const job = JSON.parse(Bun.argv[2] ?? "") as SegmentJob;
const plan = job.plan;

const encoder = new FfmpegEncoder({
  fps: plan.fps,
  crf: plan.crf,
  preset: plan.preset,
  out: job.out,
});

try {
  const { gpu } = await captureFrames(
    {
      url: job.url,
      chrome: plan.chrome,
      width: plan.width,
      height: plan.height,
      gpu: plan.gpu,
      expectGpu: plan.expectGpu,
      readyTimeout: plan.readyTimeout,
    },
    {
      startFrame: job.range.start,
      totalFrames: job.range.count,
      fps: plan.fps,
      keepFrames: plan.keepFrames,
      label: `segment ${job.range.start}`,
      onFrame: (png) => encoder.write(png),
    },
  );

  if (gpu !== null) {
    await writeFile(job.gpuOut, JSON.stringify(gpu), "utf8");
  }
} catch (error) {
  await encoder.abort();
  // A clean one-liner, because the parent reports the exit code and cannot
  // see this message.
  console.error(`mrh: ${(error as Error).message}`);
  process.exit(1);
}

await encoder.close();
