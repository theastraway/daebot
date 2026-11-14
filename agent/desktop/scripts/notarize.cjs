/**
 * electron-builder afterSign hook (originally from MINDbots, theastraway/MINDapp desktop-agent-sync/scripts/notarize.js).
 * Notarizes the signed .app with Apple's notarytool, then staples it. Runs ONLY when DAEBOT_SIGN=1
 * (electron-builder.config.mjs also only registers it then), so unsigned local builds never reach Apple or the keychain.
 *
 * Credentials come from the environment, so ANY Mac can notarize. First one present wins:
 *   1. App Store Connect API key:  APPLE_API_KEY (path to the AuthKey_XXXX.p8)
 *                                  or APPLE_API_KEY_BASE64 (the .p8 file's contents, base64) ; plus APPLE_API_KEY_ID and APPLE_API_ISSUER
 *   2. Apple ID:                   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *   3. Keychain profile:           the `MINDNotarize` notarytool profile (only the original signing Mac has it)
 * Run `node scripts/release-preflight.mjs` to see which of these this machine has.
 *
 * If the credentials are missing or Apple rejects the submission, this logs the exact failure and resolves WITHOUT throwing:
 * the build still produces a signed (not notarized) app and the release report must say so. Set DAEBOT_NOTARIZE_STRICT=1 to
 * make a failed notarization fail the build instead (use it for real releases).
 */
const { notarize } = require('@electron/notarize')
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const NOTARIZE_PROFILE = 'MINDNotarize'

/**
 * Pick the notarization credentials from an environment object. Pure (no I/O besides the optional temp key file the caller
 * asked for through APPLE_API_KEY_BASE64), so it is unit tested. Returns { mode, options, cleanup } or { mode: 'none' }.
 */
function resolveNotarizeAuth(env = process.env) {
  const keyId = env.APPLE_API_KEY_ID
  const issuer = env.APPLE_API_ISSUER
  if ((env.APPLE_API_KEY || env.APPLE_API_KEY_BASE64) && keyId && issuer) {
    let keyPath = env.APPLE_API_KEY
    let cleanup = () => {}
    if (!keyPath) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daebot-notarize-'))
      keyPath = path.join(dir, `AuthKey_${keyId}.p8`)
      fs.writeFileSync(keyPath, Buffer.from(env.APPLE_API_KEY_BASE64, 'base64'), { mode: 0o600 })
      cleanup = () => fs.rmSync(dir, { recursive: true, force: true })
    }
    return { mode: 'api-key', options: { appleApiKey: keyPath, appleApiKeyId: keyId, appleApiIssuer: issuer }, cleanup }
  }
  if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
    return {
      mode: 'apple-id',
      options: { appleId: env.APPLE_ID, appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD, teamId: env.APPLE_TEAM_ID },
      cleanup: () => {},
    }
  }
  return { mode: 'keychain-profile', options: { keychainProfile: NOTARIZE_PROFILE }, cleanup: () => {} }
}

async function notarizeApp(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return
  if (process.env.DAEBOT_SIGN !== '1') {
    console.log('[notarize] DAEBOT_SIGN is not 1; skipping')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)
  const auth = resolveNotarizeAuth()
  const label = auth.mode === 'keychain-profile' ? `keychain profile "${NOTARIZE_PROFILE}"` : auth.mode

  console.log(`[notarize] submitting ${appPath} via ${label}...`)
  try {
    await notarize({ appPath, ...auth.options })
    console.log('[notarize] submission accepted - stapling...')
    execFileSync('xcrun', ['stapler', 'staple', appPath], { stdio: 'inherit' })
    console.log('[notarize] SUCCESS - app is notarized and stapled.')
  } catch (err) {
    console.error(`[notarize] FAILED via ${label} - exact error below:`)
    console.error(err && err.message ? err.message : err)
    if (process.env.DAEBOT_NOTARIZE_STRICT === '1') throw err
    console.error('[notarize] shipping signed-only (DAEBOT_NOTARIZE_STRICT is not 1). The release report must say "signed, not notarized".')
  } finally {
    auth.cleanup()
  }
}

exports.default = notarizeApp
exports.resolveNotarizeAuth = resolveNotarizeAuth
