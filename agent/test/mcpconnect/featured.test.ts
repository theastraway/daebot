import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FEATURED, featuredConnectors, orderFeatured } from "../../src/mcpconnect/featured.ts";

test("featured connectors: a short default set, overridable by env, bad ids dropped", () => {
  assert.deepEqual(featuredConnectors({}), [...DEFAULT_FEATURED]);
  assert.deepEqual(featuredConnectors({ DAEBOT_FEATURED_CONNECTORS: "linear, github, bad id!, github" }), ["linear", "github"]);
});

test("orderFeatured puts the featured first in featured order and keeps the rest in place", () => {
  const all = [{ id: "zapier", name: "Zapier" }, { name: "GitHub" }, { id: "google", name: "Google Workspace" }, { id: "n8n", name: "n8n" }, { name: "Render" }];
  assert.deepEqual(orderFeatured(all, ["github", "google", "n8n"]).map((e) => e.name), ["GitHub", "Google Workspace", "n8n", "Zapier", "Render"]);
});
