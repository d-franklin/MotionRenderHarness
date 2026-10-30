import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface EncoderConfig {
  fps: number;
  crf: number;
  preset: string;
  out: string;
}

/**
 * An ffmpeg child that encodes PNG frames arriving on stdin.
 *
 * The write waits for drain, because a 1080p PNG at 30 fps outruns ffmpeg's
 * decode. The wait races the child's exit, because a dead ffmpeg means the
 * drain never arrives and the render would hang forever.
 */
export class FfmpegEncoder {
  private readonly ff: ChildProcessByStdio<Writable, null, Readable>;
  private error: Error | null = null;
  private closed = false;
  private stderrTail = "";

  constructor(private readonly config: EncoderConfig) {
    this.ff = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "image2pipe",
        "-vcodec",
        "png",
        "-framerate",
        String(config.fps),
        "-i",
        "-",
        "-c:v",
        "libx264",
        "-preset",
        config.preset,
        "-crf",
        String(config.crf),
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        config.out,
      ],
      { stdio: ["pipe", "inherit", "pipe"] },
    );

    this.ff.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      process.stderr.write(text);
    });

    this.ff.on("error", (error) => {
      this.error = this.failure(`ffmpeg could not be started: ${error.message}`);
    });

    this.ff.on("close", (code) => {
      this.closed = true;
      if (code !== 0 && this.error === null) {
        this.error = this.failure(`ffmpeg exited with code ${code}`);
      }
    });

    // EPIPE and ERR_STREAM_DESTROYED are expected once ffmpeg is gone. Anything
    // else is a real failure, but it is recorded rather than thrown, because
    // throwing inside this handler is an uncaught exception.
    this.ff.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
      if (this.error === null) this.error = this.failure(`ffmpeg stdin failed: ${error.message}`);
    });
  }

  write(buffer: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ff.stdin.destroyed) {
        reject(this.error ?? this.failure("ffmpeg stdin is closed"));
        return;
      }

      const cleanup = () => {
        this.ff.stdin.off("drain", onDrain);
        this.ff.stdin.off("error", onError);
        this.ff.off("close", onExit);
      };
      const onDrain = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onExit = () => {
        cleanup();
        reject(this.error ?? this.failure("ffmpeg exited before the frame was written"));
      };

      this.ff.stdin.once("drain", onDrain);
      this.ff.stdin.once("error", onError);
      this.ff.once("close", onExit);

      try {
        if (this.ff.stdin.write(buffer)) {
          cleanup();
          resolve();
        }
      } catch (error) {
        cleanup();
        reject(error as Error);
      }
    });
  }

  /** Ends the render without waiting for a clean encode. Used when a render fails. */
  async abort(): Promise<void> {
    if (!this.closed) {
      // Killing the child avoids ffmpeg reporting an empty output stream,
      // which would only add noise to an error the caller already reports.
      this.ff.kill("SIGKILL");
      await new Promise<void>((resolve) => this.ff.once("close", () => resolve()));
    }
  }

  async close(): Promise<void> {
    const exited = this.closed
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.ff.once("close", () => resolve()));
    try {
      this.ff.stdin.end();
    } catch {
      // already closed
    }
    await exited;
    if (this.error !== null) throw this.error;
  }

  private failure(message: string): Error {
    const tail = this.stderrTail.trim();
    return new Error(tail ? `${message}\n${tail}` : message);
  }
}

export interface ConcatConfig {
  fps: number;
  crf: number;
  preset: string;
}

/**
 * Concatenates segments. The copy is the fast path and needs identical codec
 * parameters across the segments; when it fails the segments are re-encoded.
 */
export async function concatSegments(
  segments: string[],
  out: string,
  config: ConcatConfig,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mrh-concat-"));
  const listFile = join(dir, "segments.txt");
  await writeFile(listFile, segments.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");

  const copy = await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    out,
  ]);
  if (copy.ok) return;

  const reencode = await runFfmpeg([
    "-hide_banner",
    "-nostats",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c:v",
    "libx264",
    "-preset",
    config.preset,
    "-crf",
    String(config.crf),
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    out,
  ]);
  if (!reencode.ok) {
    throw new Error(`the segments could not be joined into ${out}: ${reencode.stderr}`);
  }
}

async function runFfmpeg(args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { ok: code === 0, stderr: stderr.trim().slice(-2000) };
}
