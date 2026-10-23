#!/usr/bin/env node
/**
 * Headless check of the Daebot in-app update feed (modeled on MINDbots' scripts/verify-feed.cjs). No Electron window, no app
 * launch: it drives electron-updater's REAL MacUpdater / NsisUpdater / AppImageUpdater in plain Node against the live feed, with
 * a stubbed `electron` module, using the same feed URL and channel the app uses (src/lib/updater.mjs).
 *
 *   node scripts/verify-feed.cjs <mac|win-x64|win-arm64|linux> <installedVersion> [--download] [--expect <version|none>]
 *
 * Prints the update electron-updater would offer to an app on <installedVersion> and the files it would download; --download
 * also downloads the update through electron-updater, which verifies the sha512 from the feed. Exit 0 only when the result
 * matches --expect (a version, or "none").
 */
const Module = require('module')
const os = require('os')
const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

const [, , target, installed, ...rest] = process.argv
const TARGETS = { mac: ['darwin', 'arm64'], 'win-x64': ['win32', 'x64'], 'win-arm64': ['win32', 'arm64'], linux: ['linux', 'x64'] }
if (!TARGETS[target] || !installed) {
  console.error('usage: verify-feed.cjs <mac|win-x64|win-arm64|linux> <installedVersion> [--download] [--expect <version|none>]')
  process.exit(2)
}
const [platform, arch] = TARGETS[target]
const doDownload = rest.includes('--download')
const expectIdx = rest.indexOf('--expect')
const expected = expectIdx >= 0 ? rest[expectIdx + 1] : null

const nativeUpdater = new EventEmitter()
nativeUpdater.setFeedURL = () => {}
nativeUpdater.checkForUpdates = () => setImmediate(() => nativeUpdater.emit('update-downloaded'))
nativeUpdater.quitAndInstall = () => {}
const origLoad = Module._load
Module._load = function (request, ...args) {
  if (request === 'electron') return { autoUpdater: nativeUpdater, app: {}, session: {}, net: {}, Notification: function () {} }
  return origLoad.call(this, request, ...args)
}
// electron-updater picks latest.yml / latest-mac.yml / latest-linux.yml from process.platform (and the arm64 linux suffix from process.arch).
Object.defineProperty(process, 'platform', { value: platform })
Object.defineProperty(process, 'arch', { value: arch })
if (platform === 'linux') process.env.APPIMAGE = '/tmp/Daebot.AppImage'
const { MacUpdater, NsisUpdater, AppImageUpdater } = require('electron-updater')
const { HttpExecutor, configureRequestUrl, configureRequestOptions } = require('builder-util-runtime')
const https = require('https')
const http = require('http')
class NodeHttpExecutor extends HttpExecutor {
  async download(url, destination, options) {
    return await options.cancellationToken.createPromise((resolve, reject, onCancel) => {
      const requestOptions = { headers: options.headers || undefined, redirect: 'manual' }
      configureRequestUrl(url, requestOptions)
      configureRequestOptions(requestOptions)
      this.doDownload(requestOptions, { destination, options, onCancel, callback: (error) => (error == null ? resolve(destination) : reject(error)), responseHandler: null }, 0)
    })
  }
  createRequest(options, callback) {
    return (options.protocol === 'http:' ? http : https).request(options, callback)
  }
}

;(async () => {
  const { FEED_URL, feedChannel } = await import('../src/lib/updater.mjs')
  const FEED = process.env.DAEBOT_FEED_URL || FEED_URL
  const channel = feedChannel({ platform, arch })
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daebot-feed-'))
  const appAdapter = {
    version: installed, name: 'Daebot', isPackaged: true, appUpdateConfigPath: path.join(tmp, 'app-update.yml'), userDataPath: tmp, baseCachePath: tmp,
    whenReady: () => Promise.resolve(), relaunch: () => {}, quit: () => {}, onQuit: () => {},
  }
  fs.writeFileSync(appAdapter.appUpdateConfigPath, `provider: generic\nurl: ${FEED}\nchannel: latest\n`)
  const Updater = platform === 'darwin' ? MacUpdater : platform === 'win32' ? NsisUpdater : AppImageUpdater
  const u = new Updater(undefined, appAdapter)
  u.httpExecutor = new NodeHttpExecutor()
  u.setFeedURL({ provider: 'generic', url: FEED, channel })
  u.autoDownload = false
  u.allowDowngrade = false
  u.logger = { info: () => {}, warn: console.warn, error: console.error, debug: () => {} }

  console.log(`feed ${FEED}  target=${target} (${platform}/${arch})  channel=${channel}  installed=${installed}`)
  const res = await u.checkForUpdates()
  const offered = res && res.isUpdateAvailable ? res.updateInfo.version : null
  console.log(`  feed file version: ${res && res.updateInfo && res.updateInfo.version}`)
  console.log(`  offered to ${installed}: ${offered || 'none (already current)'}`)
  if (res && res.updateInfo) {
    for (const f of res.updateInfo.files) console.log(`  file ${new URL(f.url, FEED).href}  ${f.size} bytes  sha512 ${String(f.sha512).slice(0, 16)}...`)
  }
  if (doDownload && offered) {
    const t0 = Date.now()
    const files = await u.downloadUpdate()
    console.log(`  downloaded + sha512-verified by electron-updater in ${((Date.now() - t0) / 1000).toFixed(1)}s:`)
    for (const f of files) console.log(`    ${path.basename(f)} (${fs.statSync(f).size} bytes)`)
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  if (expected !== null) {
    const want = expected === 'none' ? null : expected
    if (offered !== want) { console.error(`FAIL: expected ${want || 'none'}, got ${offered || 'none'}`); process.exit(1) }
  }
  console.log('OK')
  process.exit(0)
})().catch((e) => { console.error('FAIL:', e && e.message ? e.message : e); process.exit(1) })
