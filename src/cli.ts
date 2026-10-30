import { existsSync, rmSync } from "node:fs";
import { HELP, UsageError, parseArgs, type RenderPlan } from "./args";
import { render } from "./render";

const VERSION = "0.1.0";

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    console.log(HELP);
    return 0;
  }

  const args = argv[0] === "render" ? argv.slice(1) : argv;

  let plan: RenderPlan;
  try {
    const parsed = parseArgs(args);
    if (parsed.kind === "help") {
      console.log(HELP);
      return 0;
    }
    if (parsed.kind === "version") {
      console.log(`mrh ${VERSION}`);
      return 0;
    }
    plan = parsed.plan;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`mrh: ${error.message}\n`);
      console.error(HELP);
      return 2;
    }
    throw error;
  }

  try {
    const summary = await render(plan);
    report(plan, summary);
    return summary.checks.every((check) => check.ok) ? 0 : 1;
  } catch (error) {
    // A failed render must not leave a half written file that looks valid.
    if (existsSync(plan.out)) rmSync(plan.out, { force: true });
    console.error(`mrh: ${(error as Error).message}`);
    return 1;
  }
}

function report(plan: RenderPlan, summary: Awaited<ReturnType<typeof render>>): void {
  const seconds = summary.elapsedMs / 1000;
  const rate = seconds > 0 ? summary.frames / seconds : 0;

  console.log(
    `${summary.out}  ${summary.frames} frames  ${summary.duration.toFixed(3)}s  ` +
      `${rate.toFixed(1)} frames/s  ${seconds.toFixed(1)}s wall clock`,
  );

  for (const renderer of summary.gpu) {
    console.log(`  gpu    ${renderer}`);
  }
  if (summary.gpu.length === 0) {
    console.log("  gpu    unknown, the browser did not report one");
  }

  for (const check of summary.checks) {
    const mark = check.ok ? "ok  " : "FAIL";
    console.log(`  ${mark} ${check.name.padEnd(14)} expected ${check.expected.padEnd(12)} got ${check.actual}`);
  }

  if (plan.keepFrames !== null) {
    console.log("");
    console.log(`frames kept in ${plan.keepFrames}. To re-encode them without re-rendering:`);
    console.log(
      `  ffmpeg -y -framerate ${plan.fps} -start_number ${plan.start} ` +
        `-i ${plan.keepFrames}/frame_%06d.png -c:v libx264 -preset ${plan.preset} ` +
        `-crf ${plan.crf} -pix_fmt yuv420p -movflags +faststart ${plan.out}`,
    );
  }
}
