import { test } from "node:test";
import assert from "node:assert/strict";
import { isEntrypoint } from "../../src/cli.ts";

test("entrypoint check works on Windows paths, compiled binaries and dev runs", () => {
  // Bun-compiled binary on any OS (and Node 24+) sets import.meta.main.
  assert.equal(isEntrypoint({ url: "file:///B:/~BUN/root/daebot-windows-x64.exe", main: true }, "B:\\~BUN\\root\\daebot-windows-x64.exe"), true);
  // The old string compare failed exactly here; without main, a Windows dev run still matches by file URL or cli.ts name.
  assert.equal(isEntrypoint({ url: "file:///C:/src/agent/src/cli.ts" }, "C:\\src\\agent\\src\\cli.ts"), true);
  assert.equal(isEntrypoint({ url: "file:///Users/a/agent/src/cli.ts" }, "/Users/a/agent/src/cli.ts"), true);
  // Imported by a test or another module: not the entrypoint.
  assert.equal(isEntrypoint({ url: "file:///Users/a/agent/src/cli.ts", main: false }, "/Users/a/agent/test/core/x.test.ts"), false);
  assert.equal(isEntrypoint({ url: "file:///x/cli.ts" }, undefined), false);
});
