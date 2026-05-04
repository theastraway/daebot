# MINDapp Backend Changes for MINDClaw

This folder documents the MINDapp backend changes the MINDClaw distribution
depends on. The code edits have already been applied to the local MINDapp
repo at `/Users/anthonyjconti/Documents/GitHub/MINDapp`. Stripe-side and
production-deploy steps are deferred to Anthony — they are real-money
mutations that need explicit go-ahead.

## What changed in the local MINDapp tree

Three files, all production-additive:

1. **`backend/models/subscription.py`** — added a new `claw` tier to
   `SUBSCRIPTION_TIERS`: $10/month, 300 credits, 500 MB storage, BYO LLM.
   Existing tiers untouched.
2. **`backend/routes/featured_minds_routes.py`** — broadened `_VALID_TIERS`
   from `{"free", "starter", "professional", "business"}` to include
   `"scale"`, `"payg"`, and `"claw"` so partner-key user provisioning can
   create accounts on the new tier (and the older oversights for `scale` /
   `payg`). The whitelist was previously narrower than the live tier set,
   which 400'd partner provisioning attempts on those tiers.
3. **`backend/routes/stripe_routes.py`** — added a `STRIPE_PRICE_CLAW` env
   var slot. When set, the `claw` tier becomes a valid checkout target.
   When unset, requests to checkout the `claw` tier 400 — which is the
   correct behavior until the Stripe product exists.

## Steps Anthony needs to run

These cannot run from Claude — they touch external systems.

### 1. Create the Stripe product + price

In the Stripe dashboard for the live MIND account:

- **Product:** `MIND Claw`
- **Description:** `MCP-only access for BYO-LLM developers. The MINDClaw distribution. KG infrastructure only.`
- **Recurring price:** `$10.00 USD / month`
- **Metadata:** `tier=claw`

Copy the resulting `price_…` id.

### 2. Set the env var on the live MINDapp backend

On the Render service that runs the MINDapp backend:

```
STRIPE_PRICE_CLAW=price_<the-id-stripe-just-gave-you>
```

Add it through the Render dashboard env-var UI (per the
`feedback_render_env_var_api_safety` rule — never use the bulk PUT
`/env-vars` API). Then redeploy.

**Rollback:** unset `STRIPE_PRICE_CLAW` and redeploy. The `claw` tier
becomes inaccessible from checkout but no other tier is affected.

### 3. Verify the tier is live

```bash
curl -s https://www.m-i-n-d.ai/api/subscription/tiers | jq '.tiers[] | select(.tier_name=="claw")'
```

Expect a JSON object with `price: 10`, `credits: 300`, `storage_mb: 512`.

Then try a checkout:

```bash
curl -s -X POST https://www.m-i-n-d.ai/api/stripe/create-checkout-session \
  -H "Authorization: Bearer mind_<your-test-key>" \
  -H "Content-Type: application/json" \
  -d '{"tier": "claw"}' | jq .
```

You should get a Stripe checkout URL.

### 4. Publish MINDClaw to npm

```bash
cd /Users/anthonyjconti/Documents/GitHub/MINDClaw
npm publish --access public
```

The package name is `mindclaw` and it depends on `openclaw` +
`@astramindapp/openclaw-mind`, so `npm install -g mindclaw` pulls
everything required.

### 5. Push the source repo to GitHub

```bash
cd /Users/anthonyjconti/Documents/GitHub/MINDClaw
git init
git add -A
git commit -m "Initial MINDClaw distribution"
git branch -M main
git remote add origin git@github.com:theastraway/mindclaw.git
git push -u origin main
```

### 6. Wire the install endpoint

The one-line installer (`install.sh`) expects to be served from
`https://www.m-i-n-d.ai/install/mindclaw.sh`. Two options:

- Static file: drop `install.sh` into `frontend/public/install/mindclaw.sh`
  and redeploy the Vercel frontend.
- Redirect: add a 302 from `/install/mindclaw.sh` to
  `https://raw.githubusercontent.com/theastraway/mindclaw/main/install.sh`
  in `vercel.json` or the framework config.

### 7. Add the landing page

Drop `docs/mindclaw.html` into `frontend/public/mindclaw.html` and redeploy.
The page references the existing `/openclaw-hero.jpg` so no new image asset
needs to be uploaded.

## Open questions for Anthony

- **Should the Claw tier publish to the existing pricing page on
  m-i-n-d.ai?** Currently the page lists Free, Starter, Professional,
  Business, Scale, and PAYG. Adding Claw needs a frontend update.
- **Webhook routing.** When a Claw checkout completes, the existing
  `handle_subscription_update` handler updates the tier correctly because
  it reads from `tier_limits = get_tier_limits(tier)` which now resolves
  `"claw"`. But verify in staging first with a test card.
- **MCP-host gating.** The Claw tier is positioned as MCP-only. There is
  currently no enforcement that a Claw user only accesses MIND through MCP
  vs. the web app. If we want true MCP-only, we'd need a check in
  `middleware/usage_tracker.py` that rejects web-only endpoints for
  `tier == "claw"`. Recommendation: ship the tier without that gate first,
  add it only if free-rider abuse becomes visible.
