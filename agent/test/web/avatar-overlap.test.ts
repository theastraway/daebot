import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../web/${p}`, import.meta.url)), "utf8");
const css = read("brand/brand.css");

/** The body of the first rule whose selector matches, honouring a trailing comma-less exact selector. */
function rule(text: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[}\\n])\\s*${esc}\\s*\\{([^{}]*)\\}`, "m").exec(text);
  return m ? m[1] : "";
}
const px = (body: string, prop: string): number | null => {
  const m = new RegExp(`\\b${prop}\\s*:\\s*([\\d.]+)px`).exec(body);
  return m ? Number(m[1]) : null;
};
const varRef = (body: string, prop: string): string | null => {
  const m = new RegExp(`\\b${prop}\\s*:\\s*var\\((--[\\w-]+)\\)`).exec(body);
  return m ? m[1] : null;
};

// The avatar is absolutely positioned, so it does not make its row tall enough to hold it. If the row is
// shorter than the avatar (an empty or one-line reply) the mark spills into the next row. The next row is
// static and the message is positioned, so the spill paints ON TOP of it and covers its chevron.
test("the assistant avatar cannot overflow its own message onto the next row", () => {
  const msg = rule(css, ".msg-asst");
  assert.ok(msg, ".msg-asst rule exists");
  assert.equal(/position:\s*relative/.test(msg), true, "it is positioned (so it paints over later static rows)");

  const avatarVar = varRef(msg, "min-height");
  assert.ok(avatarVar, "the row reserves the avatar's height with min-height: var(...)");
  assert.equal(avatarVar, "--avatar", "and it is the same variable the mark uses");

  const declared = px(msg, "") ?? Number((/--avatar\s*:\s*([\d.]+)px/.exec(msg) || [])[1]);
  assert.ok(declared > 0, `--avatar is a positive px length, got ${declared}`);

  const before = rule(css, ".msg-asst::before");
  assert.equal(varRef(before, "height"), "--avatar", "the mark's height is the same variable");
  assert.equal(varRef(before, "width"), "--avatar", "and so is its width");
  assert.equal(px(before, "height"), null, "no hardcoded height left to drift from the row");
});

test("the mobile avatar size re-declares the variable, not a bare size", () => {
  const mobile = /@media\s*\(max-width:\s*760px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(mobile, "the mobile block exists");
  const block = mobile![1];
  const msgRule = /\n\s*\.msg-asst\s*\{([^}]*)\}/.exec(block);
  assert.ok(msgRule, "mobile overrides .msg-asst");
  assert.equal(varRef(msgRule![1], "") ?? (/(--avatar\s*:\s*[\d.]+px)/.exec(msgRule![1]) || [])[1], "--avatar: 28px", "it sets --avatar, so the mark and the row stay in step");
  assert.equal(px(msgRule![1], "padding-left"), 40, "the gutter still clears the smaller mark");
});

test("the avatar is smaller than the gutter it sits in, at both sizes", () => {
  const msg = rule(css, ".msg-asst");
  const desktopMark = Number(/(--avatar\s*:\s*([\d.]+)px)/.exec(msg)![2]);
  const desktopGutter = px(msg, "padding-left")!;
  assert.ok(desktopMark <= desktopGutter, `desktop: mark ${desktopMark} fits the ${desktopGutter}px gutter`);

  const mobile = /@media\s*\(max-width:\s*760px\)\s*\{([\s\S]*?)\n\}/.exec(css)![1];
  const m = /\n\s*\.msg-asst\s*\{([^}]*)\}/.exec(mobile)![1];
  const mobileMark = Number(/(--avatar\s*:\s*([\d.]+)px)/.exec(m)![2]);
  const mobileGutter = px(m, "padding-left")!;
  assert.ok(mobileMark <= mobileGutter, `mobile: mark ${mobileMark} fits the ${mobileGutter}px gutter`);
});
