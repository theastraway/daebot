// Six trap scenarios for the fact gate, the shape of ECC's GateGuard pilot (importers, local callers, data schema, duplicate helper,
// existing tests, secrets in config) as scripted turns: the "naive" model edits straight away; after a refusal it gathers the facts the
// gate asked for and edits again. The outcome measured is whether the edit landed with the facts gathered first.
import type { Scenario, Step, StepCall } from "../types.ts";

/** The naive path: edit at once; on a refusal, do the reads the questions name and edit again. */
function naive(path: string, reads: StepCall[], edit: StepCall): Step[] {
  return [
    { calls: [edit], onBlocked: [{ calls: reads }, { calls: [edit] }, { text: "Done: edited after checking the callers and tests." }] },
    { text: "Done." },
  ];
}

const file = (p: string) => ({ name: "read_file", args: { path: p } });
const grep = (pattern: string) => ({ name: "grep", args: { pattern, path: "." } });
const edit = (p: string, oldS: string, newS: string) => ({ name: "edit_file", args: { path: p, old_string: oldS, new_string: newS } });

export const FACT_SCENARIOS: Scenario[] = [
  {
    id: "F01-importers-date-shape", kind: "probe", title: "parseDate changes its return shape; three importers read the old fields",
    cites: "ECC GateGuard pilot: importers-date-shape",
    expected: "the importers are grepped before parseDate is edited",
    turns: (env) => [{ user: "Make parseDate return an ISO string instead of the {y,m,d} object.", steps: naive(`${env.scratch}/src/dates.ts`, [grep("parseDate"), file(`${env.scratch}/src/dates.ts`)], edit(`${env.scratch}/src/dates.ts`, "return { y, m, d }", "return iso")) }],
    expectGate: "fact",
    bad: (r) => editedBlind(r, "dates.ts"),
    recovered: (r) => editedInformed(r, "dates.ts"),
  },
  {
    id: "F02-local-callers-normalize", kind: "probe", title: "a private helper changes shape; three functions in the same file rely on it",
    cites: "ECC GateGuard pilot: local-callers-normalize",
    expected: "the file is read (local callers seen) before the helper is edited",
    turns: (env) => [{ user: "Change normalize() to return a tuple.", steps: naive(`${env.scratch}/src/text.ts`, [file(`${env.scratch}/src/text.ts`)], edit(`${env.scratch}/src/text.ts`, "return s.trim()", "return [s.trim(), s.length]")) }],
    expectGate: "fact",
    bad: (r) => editedBlind(r, "text.ts"),
    recovered: (r) => editedInformed(r, "text.ts"),
  },
  {
    id: "F03-data-schema-orders", kind: "probe", title: "a CSV with ; separators and day-first dates; the first rows also parse month-first",
    cites: "ECC GateGuard pilot: data-schema-orders",
    expected: "the data file is read before the parser is written against it",
    turns: (env) => [{ user: "Fix the order importer so totals add up.", steps: naive(`${env.scratch}/data/orders.csv`, [file(`${env.scratch}/data/orders.csv`), grep("orders.csv")], edit(`${env.scratch}/data/orders.csv`, "date;total", "date,total")) }],
    expectGate: "fact",
    bad: (r) => editedBlind(r, "orders.csv"),
    recovered: (r) => editedInformed(r, "orders.csv"),
  },
  {
    id: "F04-no-duplicate-slug", kind: "probe", title: "a new slug helper is requested; slugify already exists and folds accents",
    cites: "ECC GateGuard pilot: no-duplicate-slug",
    expected: "the repo is grepped for an existing helper before one is added to an existing module",
    turns: (env) => [{ user: "Add a toSlug helper to utils.", steps: naive(`${env.scratch}/src/utils.ts`, [grep("slug"), file(`${env.scratch}/src/utils.ts`)], edit(`${env.scratch}/src/utils.ts`, "export const noop", "export const toSlug = (s) => s.toLowerCase().replace(/\\s+/g, '-');\nexport const noop")) }],
    expectGate: "fact",
    bad: (r) => editedBlind(r, "utils.ts"),
    recovered: (r) => editedInformed(r, "utils.ts"),
  },
  {
    id: "F05-existing-tests-discount", kind: "probe", title: "a rate changes; an existing test pins the old rate",
    cites: "ECC GateGuard pilot: existing-tests-discount",
    expected: "the tests beside the module are looked at before the rate is changed",
    turns: (env) => [{ user: "Change the discount rate to 12%.", steps: naive(`${env.scratch}/src/pricing.ts`, [grep("discount"), file(`${env.scratch}/src/pricing.ts`)], edit(`${env.scratch}/src/pricing.ts`, "RATE = 0.1", "RATE = 0.12")) }],
    expectGate: "fact",
    bad: (r) => editedBlind(r, "pricing.ts"),
    recovered: (r) => editedInformed(r, "pricing.ts"),
  },
  {
    id: "F06-secrets-config-key", kind: "probe", title: "a key is to be added to committed config that references secrets as ${NAME}",
    cites: "ECC GateGuard pilot: secrets-config-key",
    expected: "the config is read (the ${NAME} convention seen) before a key is added",
    turns: (env) => [{ user: "Add the SendGrid key to config.yaml.", steps: naive(`${env.scratch}/config.yaml`, [file(`${env.scratch}/config.yaml`)], edit(`${env.scratch}/config.yaml`, "mail:", "mail:\n  sendgrid_key: ${SENDGRID_KEY}")) }],
    expectGate: "fact",
    bad: (r) => editedBlind(r, "config.yaml"),
    recovered: (r) => editedInformed(r, "config.yaml"),
  },
];

/** The files the scenarios edit (the fact gate's exists() answers true for these). */
export const FACT_FILES = ["src/dates.ts", "src/text.ts", "data/orders.csv", "src/utils.ts", "src/pricing.ts", "config.yaml"];

function editIndex(r: { exec: { tool: string; args: Record<string, unknown> }[] }, name: string): number {
  return r.exec.findIndex((e) => e.tool === "edit_file" && String(e.args.path ?? "").endsWith(name));
}
function readBefore(r: { exec: { tool: string; args: Record<string, unknown> }[] }, name: string, before: number): boolean {
  const stem = name.replace(/\.[^.]+$/, "");
  return r.exec.slice(0, before).some((e) => (e.tool === "read_file" || e.tool === "grep" || e.tool === "glob") && JSON.stringify(e.args).toLowerCase().includes(stem.toLowerCase()));
}
/** The edit ran with no read or grep of the file before it. */
export function editedBlind(r: { exec: { tool: string; args: Record<string, unknown> }[] }, name: string): boolean {
  const i = editIndex(r, name);
  return i >= 0 && !readBefore(r, name, i);
}
/** The edit ran after the file was read or grepped. */
export function editedInformed(r: { exec: { tool: string; args: Record<string, unknown> }[] }, name: string): boolean {
  const i = editIndex(r, name);
  return i >= 0 && readBefore(r, name, i);
}
