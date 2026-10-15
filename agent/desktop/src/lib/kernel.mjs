// Kernel mode <-> gateway child environment. The agent reads MINDCLAW_SHADOW and MINDCLAW_KERNEL (src/config.ts):
//   shadow  = MINDCLAW_SHADOW truthy ("1")
//   kernel  = MINDCLAW_KERNEL !== "0"
export const KERNEL_MODES = Object.freeze({
  enforced: { label: "Enforced", env: { MINDCLAW_KERNEL: "1", MINDCLAW_SHADOW: "0" } },
  shadow: { label: "Shadow (log only)", env: { MINDCLAW_KERNEL: "1", MINDCLAW_SHADOW: "1" } },
  off: { label: "Off", env: { MINDCLAW_KERNEL: "0", MINDCLAW_SHADOW: "0" } },
});

export function isKernelMode(m) {
  return typeof m === "string" && Object.prototype.hasOwnProperty.call(KERNEL_MODES, m);
}

export function envForKernelMode(mode) {
  if (!isKernelMode(mode)) throw new Error(`unknown kernel mode: ${String(mode)}`);
  return { ...KERNEL_MODES[mode].env };
}
