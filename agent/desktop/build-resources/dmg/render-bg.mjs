// Render background.html to background@2x.png (1520x960) and background.png (760x480).
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = process.argv[2] || here
const b = await chromium.launch()
for (const [scale, name] of [[2, 'background@2x.png'], [1, 'background.png']]) {
  const ctx = await b.newContext({ viewport: { width: 760, height: 480 }, deviceScaleFactor: scale })
  const p = await ctx.newPage()
  await p.goto('file://' + path.join(here, 'background.html'), { waitUntil: 'networkidle', timeout: 60000 })
  await p.evaluate(() => document.fonts.ready)
  await p.waitForTimeout(500)
  await p.screenshot({ path: path.join(outDir, name), fullPage: false })
  await ctx.close()
  console.log('wrote', name)
}
await b.close()
