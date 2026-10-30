export interface VerifyExpectation {
  width: number;
  height: number;
  fps: number;
  frames: number;
  duration: number;
}

export interface VerifyCheck {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}

interface ProbeResult {
  streams?: Array<{
    codec_name?: string;
    width?: number;
    height?: number;
    r_frame_rate?: string;
    nb_frames?: string;
    pix_fmt?: string;
  }>;
  format?: { duration?: string };
}

/**
 * Checks the rendered file against what was asked for. A render that quietly
 * produced the wrong number of frames is the failure this catches.
 */
export async function verifyOutput(file: string, expected: VerifyExpectation): Promise<VerifyCheck[]> {
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,r_frame_rate,nb_frames,pix_fmt",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`ffprobe could not read ${file}: ${stderr.trim()}`);
  }

  const probe = JSON.parse(stdout) as ProbeResult;
  const stream = probe.streams?.[0];
  if (stream === undefined) throw new Error(`${file} has no video stream`);

  const duration = Number(probe.format?.duration ?? NaN);
  const tolerance = Math.max(0.1, 2 / expected.fps);

  const checks: VerifyCheck[] = [
    check("codec", "h264", stream.codec_name ?? "none"),
    check("width", String(expected.width), String(stream.width)),
    check("height", String(expected.height), String(stream.height)),
    check("frame rate", `${expected.fps}/1`, stream.r_frame_rate ?? "none"),
    check("pixel format", "yuv420p", stream.pix_fmt ?? "none"),
    check("frames", String(expected.frames), stream.nb_frames ?? "none"),
    check(
      "duration",
      `${expected.duration.toFixed(3)}s`,
      Number.isFinite(duration) ? `${duration.toFixed(3)}s` : "unknown",
      Number.isFinite(duration) && Math.abs(duration - expected.duration) <= tolerance,
    ),
  ];

  return checks;
}

function check(name: string, expected: string, actual: string, ok = expected === actual): VerifyCheck {
  return { name, expected, actual, ok };
}
