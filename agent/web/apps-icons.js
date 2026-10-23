// Official company marks for the Apps card. Each file in /logos/ was downloaded ONCE from the vendor's own site (its favicon,
// apple-touch-icon or brand SVG; source URLs in /logos/sources.json) and is served same-origin, so the page's image policy
// (img-src 'self') stays as strict as it was. Nothing is fetched from a vendor or an icon CDN at runtime, and nothing is redrawn.
// An item without a file here (a brand-new connector) shows its first letter until a file is added.
// Built with createElement only, never innerHTML.

export const LOGO_EXT = {
  airtable: "png", apple: "png", asana: "png", atlassian: "png", aws: "png", box: "png", calendly: "svg", clickup: "png", cloudflare: "png",
  datadog: "png", digitalocean: "png", dropbox: "png", evernote: "png", figma: "png", fireflies: "png", github: "png", gitlab: "png",
  gong: "png", google: "png", heroku: "png", hubspot: "png", huggingface: "png", intercom: "png", klaviyo: "png", linear: "svg",
  make: "png", "meta-ads": "png", microsoft: "png", miro: "png", monday: "png", mongodb: "png", neon: "png", netlify: "png",
  notion: "png", otter: "png", pagerduty: "svg", paypal: "png", posthog: "png", render: "svg", salesforce: "png", sentry: "png",
  slack: "png", square: "png", stripe: "png", supabase: "png", todoist: "png", trello: "png", vercel: "png", webflow: "png",
  wix: "png", zapier: "png", zoom: "png",
};

/** The logo file's address for an entry's logo key ("notion", "meta-ads"), or null when no file ships for it. */
export function logoSrc(key) {
  const k = String(key || "");
  return Object.prototype.hasOwnProperty.call(LOGO_EXT, k) ? `/logos/${k}.${LOGO_EXT[k]}` : null;
}

/** An <img> for a logo key, or null. If the file ever fails to load, `onMissing` runs so the caller can fall back to the letter. */
export function markFor(key, onMissing) {
  const src = logoSrc(key);
  if (!src) return null;
  const img = document.createElement("img");
  img.className = "app-mark";
  img.src = src;
  img.alt = "";
  img.width = 24; img.height = 24;
  img.decoding = "async";
  img.draggable = false;
  img.setAttribute("aria-hidden", "true");
  if (onMissing) img.addEventListener("error", onMissing, { once: true });
  return img;
}
