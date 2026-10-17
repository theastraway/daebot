/**
 * electron-builder afterSign hook, copied from MINDbots (theastraway/MINDapp desktop-agent-sync/scripts/notarize.js).
 * Notarizes the signed .app through the `MINDNotarize` keychain profile, then staples it.
 * Runs ONLY when DAEBOT_SIGN=1 (electron-builder.config.mjs also only registers it then), so unsigned local builds never reach
 * the keychain. If the profile is missing or Apple rejects the submission, this logs the exact failure and resolves WITHOUT
 * throwing: the build still produces a signed (not notarized) app and the release report must say so.
 */
const { notarize } = require('@electron/notarize')
const { execFileSync } = require('child_process')
const path = require('path')

const NOTARIZE_PROFILE = 'MINDNotarize'

exports.default = async function notarizeApp(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return
  if (process.env.DAEBOT_SIGN !== '1') {
    console.log('[notarize] DAEBOT_SIGN is not 1; skipping')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)

  console.log(`[notarize] submitting ${appPath} via keychain profile "${NOTARIZE_PROFILE}"...`)
  try {
    await notarize({
      appPath,
      keychainProfile: NOTARIZE_PROFILE,
    })
    console.log('[notarize] submission accepted - stapling...')
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
    console.log('[notarize] SUCCESS - app is notarized and stapled.')
  } catch (err) {
    console.error('[notarize] FAILED - shipping signed-only. Exact error below:')
    console.error(err && err.message ? err.message : err)
    // Do not rethrow: a failed notarization attempt (e.g. Apple account agreement issue) must not block producing a signed
    // DMG. The build report must say "signed, not notarized" with this exact error.
  }
}
