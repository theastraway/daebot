// Which model a turn runs on. A bot's own model (set in Bot settings) beats everything for THAT bot's threads only: the header
// pick, the session's own model and the user default. Sessions of the main Daebot (no bot) never see a bot's model.
import { validModelId } from "../settings.ts";

export function resolveTurnModel(o: { botModel?: string; sessionModel?: string; userDefault?: string }): string | undefined {
  if (validModelId(o.botModel)) return o.botModel;
  if (validModelId(o.sessionModel)) return o.sessionModel;
  return validModelId(o.userDefault) ? o.userDefault : undefined;
}

/** The default for threads nobody pinned: the model the user picked as the Daebot default, else the model chosen in their MIND account. */
export function pickDefaultModel(picked: unknown, account: unknown): string | undefined {
  if (validModelId(picked)) return picked;
  return validModelId(account) ? account : undefined;
}
