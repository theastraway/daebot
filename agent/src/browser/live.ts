// The last page the browser tool read. classFor and the permission card use it so a click's domain and its
// danger class come from the page Daebot actually has open, not from a URL the model writes into the click.

export interface LiveElement {
  ref: string;
  tag: string;
  type: string;
  role: string;
  name: string;
  id: string;
  autocomplete: string;
  aria: string;
  placeholder: string;
  text: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  secret: boolean;
  value?: string;
}

export interface LivePage {
  url?: string;
  tabId?: string;
  elements: LiveElement[];
}

let page: LivePage = { elements: [] };

export function browserLive(): LivePage {
  return page;
}

export function setBrowserLive(next: Partial<LivePage> & { elements?: LiveElement[] }): void {
  page = {
    url: "url" in next ? next.url : page.url,
    tabId: "tabId" in next ? next.tabId : page.tabId,
    elements: next.elements ?? page.elements,
  };
}

export function resetBrowserLive(): void {
  page = { elements: [] };
}

/** The element a click or type names. An x,y click hits the smallest box that contains the point. */
export function elementForCall(args: Record<string, unknown>, elements: readonly LiveElement[] = page.elements): LiveElement | undefined {
  if (typeof args.ref === "string" && args.ref) return elements.find((e) => e.ref === args.ref);
  const x = typeof args.x === "number" ? args.x : Number(args.x);
  const y = typeof args.y === "number" ? args.y : Number(args.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  const hits = elements.filter((e) => e.w > 0 && e.h > 0 && x >= e.x && y >= e.y && x <= e.x + e.w && y <= e.y + e.h);
  hits.sort((a, b) => a.w * a.h - b.w * b.h);
  return hits[0];
}
