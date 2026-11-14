/**
 * electron-builder custom app signer (mac.sign). Same as electron-builder's own signing (@electron/osx-sign, retried), with one difference:
 * when the build signs from a throwaway keychain made out of CSC_LINK (opts.keychain), the identity is passed to codesign by its
 * SHA-1 hash instead of its name. Signing by name is "ambiguous" on any Mac whose own keychain holds a second certificate with the same
 * name (an older Developer ID of the same team), and the build then fails; a hash is unambiguous.
 */
const { execFileSync } = require('child_process')

function hashFor(keychain, wanted) {
  const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning', keychain], { encoding: 'utf8' })
  for (const line of out.split('\n')) {
    const m = /^\s*\d+\)\s+([0-9A-F]{40})\s+"(.*)"/.exec(line)
    if (m && (!wanted || m[2].includes(wanted))) return m[1]
  }
  return undefined
}

async function macSign(opts) {
  const { signAsync } = await import('@electron/osx-sign')
  let identity = opts.identity
  const name = typeof identity === 'string' ? identity : identity && identity.name
  if (opts.keychain) {
    const hash = hashFor(opts.keychain, name)
    if (hash) identity = hash
  }
  let lastErr
  for (let i = 0; i < 3; i++) {
    try {
      return await signAsync({ ...opts, identity })
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 5000 * (i + 1)))
    }
  }
  throw lastErr
}

module.exports = macSign
module.exports.default = macSign
