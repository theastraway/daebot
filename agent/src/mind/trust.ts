// How mind_remember chooses an origin. The model may name one; a web-tainted turn fills in origin:web when it does not.
// origin:tool is not a model value (internal writers set it themselves).
import { turnFetchedWeb } from "../learn/guard.ts";
import { isModelOrigin, ORIGIN_ERROR, type ModelOrigin } from "./origin.ts";

/** Blank counts as omitted. An explicit value wins over a turn that already called web_fetch or web_search. */
export function resolveModelOrigin(raw: unknown, calls?: readonly { tool: string }[]): ModelOrigin {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return turnFetchedWeb(calls ?? []) ? "web" : "agent_inferred";
  }
  if (typeof raw !== "string") throw new Error(ORIGIN_ERROR);
  const v = raw.trim();
  if (!isModelOrigin(v)) throw new Error(ORIGIN_ERROR);
  return v;
}
