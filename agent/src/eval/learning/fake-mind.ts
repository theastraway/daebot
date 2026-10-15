// In-memory MIND stand-in for learning tests and the LEARNING eval. It mimics what the live graph was observed
// to do on 2026-10-15: query returns the top few retrieved chunks shaped "# <title> / ## Original Entry / body /
// ## AI Analysis ..." (the body repeated, no ids), ranking is by word overlap with the query. Real MIND retrieval is
// semantic and fuzzier than this lexical model; see LEARNING.md for what that means for the numbers.
import type { MindClient } from "../../types.ts";
import { tokenSet } from "../../learn/text.ts";

export interface FakeDoc { id: string; type: "entry" | "document"; title: string; content: string; tags: string[]; at: number }

const BOILERPLATE = new Set(["daebot", "lesson", "skill", "learn", "appl", "request", "daebot-lesson", "daebot-skill", "model", "user"]);

export class FakeMind implements MindClient {
  docs: FakeDoc[] = [];
  queries: string[] = [];
  failQueries = false;
  failWrites = false;
  topK: number;
  private n = 0;

  constructor(o: { topK?: number } = {}) { this.topK = o.topK ?? 5; }

  async context(): Promise<string> { return "fake boot context"; }

  async query(q: string): Promise<string> {
    this.queries.push(q);
    if (this.failQueries) throw new Error("MIND query: HTTP 502");
    const qt = [...tokenSet(q)].filter((t) => !BOILERPLATE.has(t));
    const scored = this.docs.map((d) => {
      const dt = tokenSet(`${d.title} ${d.content}`);
      let hit = 0;
      for (const t of qt) if (dt.has(t)) hit++;
      return { d, hit, score: hit / Math.sqrt(dt.size || 1) };
    }).filter((x) => x.hit >= 1).sort((a, b) => b.score - a.score || b.d.at - a.d.at).slice(0, this.topK);
    if (!scored.length) return "No relevant context found.";
    return scored.map(({ d }, i) => `{"reference_id": "${i + 1}", "content": ${JSON.stringify(`# ${d.title}\n\n## Original Entry\n${d.content}\n\n## AI Analysis\nA note Daebot wrote about itself.\n${d.content}`)}}`).join("\n");
  }

  async remember(a: { type?: "entry" | "document"; title: string; content: string; tags?: string[] }): Promise<string> {
    if (this.failWrites) throw new Error("MIND remember: HTTP 500");
    const id = `fake${(++this.n).toString(16).padStart(4, "0")}`;
    this.docs.push({ id, type: a.type ?? "entry", title: a.title, content: a.content, tags: a.tags ?? [], at: this.n });
    return `saved ${a.type ?? "entry"} ${id}`;
  }

  async call(): Promise<string> { return "{}"; }

  titles(): string[] { return this.docs.map((d) => d.title); }
}
