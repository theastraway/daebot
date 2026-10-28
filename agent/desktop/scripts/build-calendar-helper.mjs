// Builds daebot-calendar, the EventKit helper the Mac app calls for Apple Calendar, as ONE universal (arm64 + x86_64) binary in
// desktop/build/bin/, where electron-builder ships it to Contents/Resources/bin and signs it with the app (hardened runtime plus the
// calendars entitlement from build-resources/entitlements.mac.plist).
//   node scripts/build-calendar-helper.mjs                 -> build/bin/daebot-calendar
//   node scripts/build-calendar-helper.mjs --out DIR       -> DIR/daebot-calendar
// Needs swiftc and lipo (Xcode or the Command Line Tools) on a Mac. scripts/stage-bin.mjs runs it for the mac build.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const HELPER_NAME = "daebot-calendar";
export const HELPER_SRC = join(here, "..", "native", "calendar");
/** The oldest macOS the helper runs on. requestFullAccessToEvents is used on 14+, requestAccess(to:) before. */
export const MIN_MACOS = "12.0";
export const ARCHS = ["arm64", "x86_64"];

/** The exact commands for one build (pure, so a test can read them without a Mac). */
export function calendarHelperPlan({ srcDir = HELPER_SRC, outDir, tmpDir, archs = ARCHS, min = MIN_MACOS } = {}) {
  const compile = archs.map((arch) => {
    const out = join(tmpDir, `${HELPER_NAME}-${arch}`);
    return {
      arch, out,
      cmd: "xcrun",
      args: [
        "swiftc", "-O", "-target", `${arch}-apple-macos${min}`, "-o", out, join(srcDir, "main.swift"),
        // The usage strings live inside the binary too, so macOS can read them whichever process asks.
        "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", join(srcDir, "Info.plist"),
      ],
    };
  });
  const out = join(outDir, HELPER_NAME);
  return { compile, lipo: { cmd: "xcrun", args: ["lipo", "-create", ...compile.map((c) => c.out), "-output", out] }, sign: { cmd: "codesign", args: ["--force", "--sign", "-", out] }, out };
}

/** Compiles both slices, joins them, ad-hoc signs the result (electron-builder re-signs it with the app's identity). Returns the output path. */
export function buildCalendarHelper({ outDir = join(here, "..", "build", "bin"), run = spawnSync, platform = process.platform, required = true, log = console.error } = {}) {
  if (platform !== "darwin") {
    if (required) throw new Error("The Apple Calendar helper can only be built on a Mac.");
    return null;
  }
  const tmpDir = mkdtempSync(join(tmpdir(), "daebot-calendar-"));
  try {
    mkdirSync(outDir, { recursive: true });
    const plan = calendarHelperPlan({ outDir, tmpDir });
    const sh = (step) => {
      const r = run(step.cmd, step.args, { stdio: ["ignore", "inherit", "inherit"] });
      if (r.error || r.status !== 0) throw new Error(`${step.cmd} ${step.args[0]} failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}`);
    };
    for (const c of plan.compile) sh(c);
    sh(plan.lipo);
    try { sh(plan.sign); } catch (e) { log(`warning: ad-hoc signing skipped (${e.message})`); }
    return plan.out;
  } catch (e) {
    if (required) throw e;
    log(`warning: Apple Calendar helper not built (${e.message}); Calendar will say it is unavailable in this build.`);
    return null;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--out");
  const outDir = i > 0 ? process.argv[i + 1] : undefined;
  try {
    const out = buildCalendarHelper(outDir ? { outDir } : {});
    console.log(existsSync(out) ? out : "not built");
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}
