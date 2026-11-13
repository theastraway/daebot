// Xvfb capture for the iOS Simulator pane. Uses the shared smoke harness
// (--daebot-devices-shots and --daebot-devices-pane=ios-sim, which do nothing without --mindclaw-smoke).
// Linux cannot boot a simulator. One launch paints the fixture phone. The other shows the real
// "needs a Mac" state. Not part of the app.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.DAEBOT_IOS_SIM_SHOTS || "/workspace/daebot-devices/shots/ios-sim";
const jpeg = join(out, "fixture-phone.jpg");
mkdirSync(out, { recursive: true });

const py = `
from PIL import Image, ImageDraw, ImageFont
im = Image.new("RGB", (390, 844), (12, 108, 214))
d = ImageDraw.Draw(im)
font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 42)
small = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 22)
d.rounded_rectangle((24, 28, 366, 816), 36, outline=(255, 255, 255), width=4)
d.rounded_rectangle((36, 120, 354, 300), 20, fill=(255, 255, 255))
d.text((58, 150), "FIXTURE", fill=(16, 16, 16), font=font)
d.text((58, 210), "iPhone 16", fill=(16, 16, 16), font=small)
d.text((48, 420), "not a live", fill=(255, 255, 255), font=font)
d.text((48, 480), "simulator", fill=(255, 255, 255), font=font)
d.ellipse((155, 760, 235, 800), fill=(230, 230, 230))
im.save(${JSON.stringify(jpeg)}, "JPEG", quality=90)
`;
await new Promise((resolve, reject) => {
  const p = spawn("python3", ["-c", py], { stdio: "inherit" });
  p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("could not paint the fixture jpeg"))));
});

function launch(mode) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, DAEBOT_IOS_SIM_SHOT_MODE: mode, DAEBOT_SIMULATOR_FIXTURE_JPEG: jpeg };
    if (mode === "needs-mac") {
      delete env.DAEBOT_SIMULATOR_FAKE;
      delete env.DAEBOT_DEV_SHOTS;
    }
    const child = spawn(
      "xvfb-run",
      ["-a", "-s", "-screen 0 1440x900x24", "npx", "electron", ".", "--mindclaw-smoke", "--no-sandbox", `--daebot-devices-shots=${out}`, "--daebot-devices-pane=ios-sim"],
      { cwd: desktop, env, stdio: "inherit" },
    );
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${mode} shots exited ${code}`))));
  });
}

await launch("fixture");
await launch("needs-mac");
console.log("shots written to", out);
