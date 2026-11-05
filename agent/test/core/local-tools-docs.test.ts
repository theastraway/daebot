import { test } from "node:test";
import assert from "node:assert/strict";
import { shellCommand } from "../../src/tools/bash.ts";
import { composeSystemPrompt, DOCUMENTS_SECTION } from "../../src/runtime.ts";
import { hostedToolAllowed } from "../../src/hosted.ts";

test("Windows PowerShell fallback drops the curl alias so curl is the real curl.exe", () => {
  const sh = shellCommand("curl -s https://example.com", "win32", () => false);
  assert.equal(sh.file, "powershell.exe");
  assert.match(sh.args[sh.args.length - 1], /^Remove-Item Alias:curl .*; curl -s https:\/\/example\.com$/);
  // bash on Windows and every POSIX platform run the command untouched
  assert.deepEqual(shellCommand("curl -s x", "win32", () => true).args, ["-c", "curl -s x"]);
  assert.deepEqual(shellCommand("curl -s x", "linux").args, ["-c", "curl -s x"]);
});

test("hosted still never offers a shell, process, terminal or file write/edit", () => {
  for (const n of ["bash", "process", "terminal", "write_file", "edit_file"]) assert.equal(hostedToolAllowed(n), false, n);
});

test("system prompt: MIND is the main document database; Dropbox and Drive are third-party connectors", () => {
  const p = composeSystemPrompt({ bootContext: "", surface: "desktop", cwd: "C:\\x", toolNames: ["bash", "process", "write_file", "edit_file"] });
  assert.match(p, /## Documents/);
  assert.match(p, /MIND is the main document database/);
  assert.match(p, /Dropbox and Google Drive are third-party connectors/);
  assert.match(p, /curl is available/);
  assert.ok(DOCUMENTS_SECTION.length >= 3);
});
