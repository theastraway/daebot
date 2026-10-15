import { bad } from "./bad.ts";
import { legit } from "./legit.ts";
import { probes } from "./probes.ts";
import type { Scenario } from "../types.ts";

export const ALL_SCENARIOS: Scenario[] = [...bad, ...legit, ...probes];
export { bad, legit, probes };
