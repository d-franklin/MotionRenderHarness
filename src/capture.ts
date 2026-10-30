import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";

type PageWindow = {
  seek?: (t: number) => unknown;
  __ready?: boolean;
};

export interface CaptureConfig {
  url: string;
  chrome: string;
  width: number;
  height: number;
  gpu: boolean;
  readyTimeout: number;
  /** Text the renderer's GPU string must contain, or null to accept any. */
  expectGpu: string | null;
}

/** What the browser's GPU process actually ran on. */
export interface GpuInfo {
  /** The unmasked renderer string, e.g. "ANGLE (NVIDIA, Vulkan 1.4.351 ...)". */
  renderer: string;
  vendor: string;
  displayType: string;
}

export interface CaptureResult {
  gpu: GpuInfo | null;
}

export interface CaptureJob {
  /** Frame index of the first frame to capture. */
  startFrame: number;
  totalFrames: number;
  fps: number;
  /** Directory that also receives every frame as a PNG, or null. */
  keepFrames: string | null;
  /** Prefix for the progress line. */
  label: string;
  onFrame: (png: Uint8Array, frameIndex: number) => Promise<void>;
}

/**
 * The browser flags that define a render. They live in one place so two runs
 * cannot differ because a flag was forgotten in one of them.
 */
export function chromeArgs(gpu: boolean): string[] {
  const args = [
    "--hide-scrollbars",
    "--force-color-profile=srgb",
    "--font-render-hinting=none",
    "--disable-lcd-text",
    "--disable-features=PaintHolding",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ];
  if (gpu) {
    // ANGLE's Vulkan backend reaches the discrete GPU on a hybrid laptop. The
    // GL backend lands on the integrated GPU, because that is what the system
    // GL dispatch picks when both are present. Chromium falls back to GL when
    // no Vulkan driver is present, so the flag needs no host detection.
    args.push("--enable-gpu", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=vulkan");
  } else {
    args.push("--disable-gpu");
  }
  return args;
}

/**
 * Reads back the GPU the browser process is actually running on.
 *
 * The renderer string is the only honest answer to "which GPU did this render
 * use": the flags say what was asked for, not what the driver picked.
 */
export async function readGpuInfo(browser: Browser): Promise<GpuInfo | null> {
  try {
    const client = await browser.target().createCDPSession();
    const info = await client.send("SystemInfo.getInfo");
    const aux = info.gpu?.auxAttributes;
    if (!aux) return null;
    return {
      renderer: aux.glRenderer ?? "",
      vendor: aux.glVendor ?? "",
      displayType: aux.displayType ?? "",
    };
  } catch {
    return null;
  }
}

export async function captureFrames(config: CaptureConfig, job: CaptureJob): Promise<CaptureResult> {
  const browser = await puppeteer.launch({
    executablePath: config.chrome,
    headless: true,
    args: chromeArgs(config.gpu),
  });

  try {
    // The GPU is checked before the first frame, so a render on the wrong
    // hardware fails in seconds instead of after the whole duration.
    const gpu = await readGpuInfo(browser);
    if (config.expectGpu !== null) {
      if (gpu === null) {
        throw new Error(
          `the browser did not report which GPU it is using, so the render cannot be checked against "${config.expectGpu}"`,
        );
      }
      if (!gpu.renderer.includes(config.expectGpu)) {
        throw new Error(
          `the render ran on "${gpu.renderer}", which does not contain the expected GPU "${config.expectGpu}"`,
        );
      }
    }

    const page = await browser.newPage();
    await page.setViewport({ width: config.width, height: config.height, deviceScaleFactor: 1 });

    await page.goto(config.url, { waitUntil: "load", timeout: config.readyTimeout });

    const hasSeek = await page.evaluate(() => typeof (window as unknown as PageWindow).seek === "function");
    if (!hasSeek) {
      throw new Error(
        `the page at ${config.url} does not expose window.seek(t), so it cannot be rendered frame by frame`,
      );
    }

    try {
      await page.waitForFunction(() => (window as unknown as PageWindow).__ready === true, {
        timeout: config.readyTimeout,
      });
    } catch {
      throw new Error(
        `the page at ${config.url} never set window.__ready = true within ${config.readyTimeout}ms`,
      );
    }

    // Web fonts still loading render as fallback glyphs, and the first frames
    // come out in the wrong typeface.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    if (job.keepFrames !== null) {
      await mkdir(job.keepFrames, { recursive: true });
    }

    const lastFrame = job.startFrame + job.totalFrames - 1;

    // Prime the first frame of this segment so the first capture is a settled
    // state rather than the state before the first seek.
    await seek(page, job.startFrame / job.fps);

    for (let frame = 0; frame < job.totalFrames; frame++) {
      const index = job.startFrame + frame;
      await seek(page, index / job.fps);
      // optimizeForSpeed picks Chromium's faster PNG encoder. The pixels are
      // the same, only the file is bigger, and the file is never written to
      // disk unless --keep-frames asks for it.
      const png = await page.screenshot({ type: "png", optimizeForSpeed: true });

      if (job.keepFrames !== null) {
        const file = join(job.keepFrames, `frame_${String(index).padStart(6, "0")}.png`);
        await writeFile(file, png);
      }

      await job.onFrame(png, index);
      if (frame % 15 === 0 || frame === job.totalFrames - 1) {
        progress(job.label, index, lastFrame);
      }
    }

    return { gpu };
  } finally {
    await browser.close();
  }
}

async function seek(page: import("puppeteer-core").Page, time: number): Promise<void> {
  await page.evaluate((t: number) => {
    const target = window as unknown as PageWindow;
    target.seek?.(t);
  }, time);
}

function progress(label: string, index: number, last: number): void {
  const text = `${label} frame ${index}/${last}`;
  process.stderr.write(`\r${text.padEnd(48)}`);
  if (index === last) process.stderr.write("\n");
}
