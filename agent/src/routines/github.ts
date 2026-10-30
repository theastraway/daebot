// GitHub pushes straight to Daebot: a repository webhook calls /hooks/gh/<routineId>, signed with the routine's secret
// (X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(secret, raw body)). This file is pure: it checks the signature, decides which trigger an
// event belongs to, and boils the payload down to one short untrusted line for the bot. The gateway does the HTTP and the dedupe.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Trigger, TriggerType } from "./triggers.ts";

/** The routine's secret signs the body; GitHub sends the result in X-Hub-Signature-256. Constant-time compare, strict format. */
export function signGithub(secret: string, body: Buffer | string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export function verifyGithubSignature(secret: string | undefined, body: Buffer | string, header: string | undefined): boolean {
  if (!secret || typeof header !== "string" || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const want = Buffer.from(signGithub(secret, body)), got = Buffer.from(header);
  return want.length === got.length && timingSafeEqual(want, got);
}

const line = (v: unknown, max: number): string => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export interface GithubEvent {
  /** Which trigger type this event belongs to. */
  type: TriggerType;
  repo: string;
  /** gh_push only. */
  branch?: string;
  /** What the bot gets. Written by strangers: it is handed over as untrusted data. */
  text: string;
}

/** Maps a GitHub event name + payload to a trigger event, or undefined for events no trigger listens to (labels, stars, closed issues ...). */
export function githubEvent(name: string, p: any): GithubEvent | undefined {
  if (!p || typeof p !== "object") return undefined;
  const repo = line(p.repository?.full_name, 140).toLowerCase();
  if (!repo) return undefined;
  const who = line(p.sender?.login, 60) || "someone";
  if (name === "issues" && (p.action === "opened" || p.action === "reopened") && p.issue) {
    const i = p.issue;
    return { type: "gh_issue", repo, text: `GitHub issue #${Number(i.number) || 0} ${p.action} in ${repo} by ${who}: "${line(i.title, 160)}"${i.body ? ` | ${line(i.body, 600)}` : ""} (${line(i.html_url, 200)})` };
  }
  if (name === "pull_request" && (p.action === "opened" || p.action === "reopened" || p.action === "ready_for_review") && p.pull_request) {
    const r = p.pull_request;
    return { type: "gh_pr", repo, text: `GitHub pull request #${Number(r.number) || 0} ${p.action.replace(/_/g, " ")} in ${repo} by ${who}: "${line(r.title, 160)}" (${line(r.head?.ref, 80)} into ${line(r.base?.ref, 80)})${r.body ? ` | ${line(r.body, 600)}` : ""} (${line(r.html_url, 200)})` };
  }
  if (name === "push" && typeof p.ref === "string" && !p.deleted) {
    const branch = line(p.ref.replace(/^refs\/heads\//, ""), 120);
    const commits = Array.isArray(p.commits) ? p.commits : [];
    const msgs = commits.slice(0, 5).map((c: any) => `- ${line(c?.message, 120)} (${line(c?.author?.username ?? c?.author?.name, 40)})`).join("\n");
    return { type: "gh_push", repo, branch, text: `GitHub push to ${repo} on ${branch} by ${line(p.pusher?.name, 60) || who}: ${commits.length} commit${commits.length === 1 ? "" : "s"}${msgs ? `\n${msgs}` : ""}${line(p.compare, 200) ? `\n${line(p.compare, 200)}` : ""}` };
  }
  if ((name === "issue_comment" || name === "pull_request_review_comment" || name === "commit_comment") && p.action === "created" && p.comment) {
    const c = p.comment;
    const what = name === "issue_comment" ? (p.issue?.pull_request ? `pull request #${Number(p.issue?.number) || 0}` : `issue #${Number(p.issue?.number) || 0}`) : name === "pull_request_review_comment" ? `pull request #${Number(p.pull_request?.number) || 0}` : "a commit";
    return { type: "gh_comment", repo, text: `GitHub comment on ${what} in ${repo} by ${who}: ${line(c.body, 800)} (${line(c.html_url, 200)})` };
  }
  return undefined;
}

/** Does this event belong to this routine's trigger (right type, right repository, right branch)? */
export function githubWants(t: Trigger, ev: GithubEvent): boolean {
  if (t.type !== ev.type) return false;
  if (t.repo && t.repo !== ev.repo) return false;
  if (t.type === "gh_push" && t.branch && t.branch !== ev.branch) return false;
  return true;
}

/** A small valid payload for "Send test event": it goes through the very same signature check and routing as a real delivery. */
export function sampleGithub(type: TriggerType, repo: string, branch?: string): { event: string; body: string } {
  const r = { full_name: repo || "your-org/your-repo" };
  const sender = { login: "daebot-test" };
  switch (type) {
    case "gh_pr": return { event: "pull_request", body: JSON.stringify({ action: "opened", repository: r, sender, pull_request: { number: 1, title: "Test pull request from Daebot", body: "This is a test event.", head: { ref: "test" }, base: { ref: "main" }, html_url: `https://github.com/${r.full_name}/pull/1` } }) };
    case "gh_push": return { event: "push", body: JSON.stringify({ ref: `refs/heads/${branch || "main"}`, repository: r, sender, pusher: { name: "daebot-test" }, commits: [{ message: "Test commit from Daebot", author: { username: "daebot-test" } }] }) };
    case "gh_comment": return { event: "issue_comment", body: JSON.stringify({ action: "created", repository: r, sender, issue: { number: 1 }, comment: { body: "This is a test comment from Daebot.", html_url: `https://github.com/${r.full_name}/issues/1#issuecomment-1` } }) };
    default: return { event: "issues", body: JSON.stringify({ action: "opened", repository: r, sender, issue: { number: 1, title: "Test issue from Daebot", body: "This is a test event.", html_url: `https://github.com/${r.full_name}/issues/1` } }) };
  }
}
