// DAEBOT_BOTS_ENABLED gates the whole Bots feature (default OFF). Read on every use, so flipping the env var and restarting
// is not even needed for tests; in production set it before start. Off: /bots* answers 404, bot_talk and mind_tenants are not
// offered, bot sessions cannot be opened, and GET /health and /auth/me say `bots: false` (the web UI then hides the Sessions|Bots toggle).
// The model picker (/models) does NOT depend on this flag.
export function botsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test((env.DAEBOT_BOTS_ENABLED ?? "").trim());
}
