/**
 * Tiny logger. No deps — terminal colors only when stdout is a TTY.
 */

const isTTY = process.stdout.isTTY;
const c = (code) => (isTTY ? `\x1b[${code}m` : "");
const RESET = c(0);
const RED = c(31);
const GREEN = c(32);
const YELLOW = c(33);
const CYAN = c(36);
const BOLD = c(1);
const DIM = c(2);

export function info(msg) {
  process.stdout.write(`${CYAN}›${RESET} ${msg}\n`);
}
export function ok(msg) {
  process.stdout.write(`${GREEN}✓${RESET} ${msg}\n`);
}
export function warn(msg) {
  process.stdout.write(`${YELLOW}!${RESET} ${msg}\n`);
}
export function err(msg) {
  process.stderr.write(`${RED}✗${RESET} ${msg}\n`);
}
export function dim(msg) {
  process.stdout.write(`${DIM}${msg}${RESET}\n`);
}

export function logo() {
  // 256-color crimson + slate; falls back to basic red on 8-color terms.
  const CRIMSON = isTTY ? "\x1b[38;5;196m" : "";
  const SLATE = isTTY ? "\x1b[38;5;245m" : "";
  const FAINT = isTTY ? "\x1b[38;5;238m" : "";
  const banner = `
${CRIMSON}${BOLD}    ███╗   ███╗██╗███╗   ██╗██████╗${RESET}    ${FAINT}╲${RESET}
${CRIMSON}${BOLD}    ████╗ ████║██║████╗  ██║██╔══██╗${RESET}   ${FAINT}╲╲${RESET}     ${CRIMSON}${BOLD}╔═══╗${RESET}
${CRIMSON}${BOLD}    ██╔████╔██║██║██╔██╗ ██║██║  ██║${RESET}    ${FAINT}╲${RESET}      ${CRIMSON}${BOLD}║ ${SLATE}×${CRIMSON} ║${RESET}    ${BOLD}${CRIMSON}C L A W${RESET}
${CRIMSON}${BOLD}    ██║╚██╔╝██║██║██║╚██╗██║██║  ██║${RESET}           ${CRIMSON}${BOLD}╚═══╝${RESET}
${CRIMSON}${BOLD}    ██║ ╚═╝ ██║██║██║ ╚████║██████╔╝${RESET}      ${FAINT}your knowledge graph${RESET}
${CRIMSON}${BOLD}    ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═════╝${RESET}       ${FAINT}wired into every turn${RESET}

`;
  process.stdout.write(banner);
}

export function tagline() {
  const SLATE = isTTY ? "\x1b[38;5;245m" : "";
  process.stdout.write(`${SLATE}MIND remembers · MIND connects · MIND compounds${RESET}\n\n`);
}
