// Background-first routing eval. Each prompt has a set of acceptable FIRST tools. A model that reaches for the screen
// (`computer`) first on work a background tool can do fails; the two screen scenarios fail if it does NOT use the screen.
export interface RoutingScenario {
  id: string;
  prompt: string;
  /** Tool names that are an acceptable first tool call. */
  allow: string[];
  /** true when the screen really is the only way (the scenario checks the model does not refuse to use it). */
  needsScreen?: boolean;
}

export const ROUTING_SCENARIOS: RoutingScenario[] = [
  { id: "R01-read-site", prompt: "check what's on example.com", allow: ["web_fetch"] },
  { id: "R02-run-tests", prompt: "run the tests in ~/project", allow: ["bash", "process"] },
  { id: "R03-calendar", prompt: "send me my calendar for tomorrow", allow: ["mind_calendar", "mind_apps", "apple_calendar"] },
  { id: "R04-convert-file", prompt: "convert ~/Downloads/report.docx to a PDF", allow: ["bash", "process"] },
  { id: "R05-watch-build", prompt: "watch this build and tell me when it's done: npm run build in ~/app", allow: ["process"] },
  { id: "R06-weather", prompt: "check the weather in New York", allow: ["web_fetch"] },
  { id: "R07-mail", prompt: "do I have any unread email from Dana?", allow: ["mind_mail", "mind_apps"] },
  { id: "R08-big-files", prompt: "list the files in my Downloads folder bigger than 100 MB", allow: ["bash", "glob"] },
  { id: "R09-download", prompt: "download https://example.com/big-dataset.zip into ~/data and tell me when it finishes", allow: ["process"] },
  { id: "R12-go-to-site", prompt: "go to news.ycombinator.com and tell me what the top story is", allow: ["web_fetch"] },
  { id: "R13-open-terminal", prompt: "open Terminal and run npm test in ~/project", allow: ["bash", "process"] },
  { id: "R14-open-folder", prompt: "open my Downloads folder in the file explorer and tell me which file is the biggest", allow: ["bash", "glob"] },
  { id: "R15-open-browser", prompt: "open Chrome and look up the weather in Boston", allow: ["web_fetch"] },
  { id: "R10-screen-xactimate", prompt: "Xactimate is open on my screen. Look at the estimate that's showing and tell me the first three line items.", allow: ["computer"], needsScreen: true },
  { id: "R11-screen-watch", prompt: "Open the Calculator app and work out 1234 x 5678 on screen so I can watch you do it.", allow: ["computer"], needsScreen: true },
];
