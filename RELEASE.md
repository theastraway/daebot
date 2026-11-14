# Releasing Daebot from any machine

One page. Any Mac, Windows or Linux laptop with the repo can build; the secrets are environment variables, never files in the repo.
The values live in the MIND document titled **"Daebot release signing kit"** (query MIND for that title). Names only below.

## 1. Prerequisites (once per machine)
- Node 22.18+, `bun` (`curl -fsSL https://bun.sh/install | bash`), `gh` logged in with push rights to `theastraway/daebot`.
- Mac builds: a Mac with Xcode command line tools (`xcode-select --install`).
- Publishing: the droplet SSH key at `~/.ssh/droplet_170_key` (chmod 600) or `DAEBOT_SSH_KEY=<path>`, reaching `root@45.55.204.209`.
- `cd agent && bun install && cd desktop && npm install`

## 2. Environment variables (set the ones for the platform you build)
| Platform | Names | Notes |
|---|---|---|
| Mac code signing | `DAEBOT_SIGN=1`, `CSC_LINK` (path or base64 of the Developer ID `.p12`), `CSC_KEY_PASSWORD`, `CSC_IDENTITY_AUTO_DISCOVERY=false` (use only the `.p12`, never a keychain cert) | Skip `CSC_LINK` only on a Mac whose keychain already holds "Developer ID Application: ANTHONY JOSEPH CONTI (VJ44THJ238)". |
| Mac notarization (first that is complete wins) | `APPLE_API_KEY` (path to `AuthKey_XXXX.p8`) or `APPLE_API_KEY_BASE64`, plus `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | then `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID`, then the `MINDNotarize` keychain profile. Add `DAEBOT_NOTARIZE_STRICT=1` for a release so a failed notarization fails the build. |
| Windows | none | Unsigned by default, builds everywhere (also cross-built from a Mac). `DAEBOT_WIN_SIGN=azure` + 7 Azure vars is opt-in only (`agent/DEPLOY.md`). |
| Linux | none | AppImage + deb, unsigned. |
| Publish | `DAEBOT_SSH_KEY` (optional), `MIND_API_KEY` (or `~/.daebot/mind-key`) | MIND registry needs an admin `mind_` key. |

### Fresh machine from the kit
The MIND document **"Daebot release signing kit"** holds the Developer ID `.p12` (base64), its password, the App Store Connect `.p8` (base64), its key id and issuer, and the droplet SSH key (base64). Decode on a Mac with `base64 -D`:
```
mkdir -p ~/.daebot-kit ~/.appstoreconnect/private_keys && chmod 700 ~/.daebot-kit
base64 -D > ~/.daebot-kit/devid.p12 <<< "<p12 base64 line from the kit>"
base64 -D > ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 <<< "<p8 base64 line from the kit>"
base64 -D > ~/.ssh/droplet_170_key <<< "<ssh key base64 line from the kit>" && chmod 600 ~/.ssh/droplet_170_key
export CSC_LINK=~/.daebot-kit/devid.p12 CSC_KEY_PASSWORD=<password from the kit> CSC_IDENTITY_AUTO_DISCOVERY=false
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8 APPLE_API_KEY_ID=<KEYID> APPLE_API_ISSUER=<issuer from the kit>
```
Never commit these files or paste the values into a PR, chat or log.

## 3. Preflight (always run it first)
```
cd agent/desktop
node scripts/release-preflight.mjs --upload     # --platform mac|win|linux|all, --skip-network
```
It prints which inputs this machine has (never the secret values) and exits 1 with exact fix steps if a required one is missing.

## 4. Build
```
cd agent/desktop
DAEBOT_SIGN=1 DAEBOT_NOTARIZE_STRICT=1 npm run dist:mac     # signed + notarized + stapled universal dmg and zip
npm run dist:win                                            # NSIS x64 + arm64, unsigned
npm run dist:linux                                          # AppImage + deb
```
Output is `agent/desktop/dist/`. Bump `version` in `agent/package.json` and `agent/desktop/package.json` first.
Check a Mac build before publishing: `spctl -a -vv dist/mac-universal/Daebot.app` must say `accepted`, `source=Notarized Developer ID`;
`xcrun stapler validate dist/mac-universal/Daebot.app` must pass. An `adhoc` signature means signing did not run: do not publish it.

## 5. Upload, feed files, registry
```
agent/desktop/scripts/publish-release.sh agent/desktop/dist <version> --notes "..." --dry-run   # then again without --dry-run
```
It uploads to `root@45.55.204.209:/var/www/evie/download/daebot` (public `https://download.m-i-n-d.ai/download/daebot/`), including the
four electron-updater feeds `latest-mac.yml`, `latest.yml`, `latest-arm64.yml`, `latest-linux.yml` and the `.blockmap` files (a feed that
is not flipped never reaches an installed app), and registers each platform and arch in the MIND registry.

## 6. releases.json PR and verify
```
node agent/scripts/release-manifest.mjs agent/desktop/dist <version>     # fills agent/web/download/releases.json
```
Open the PR, merge it (`python3 ~/code/mac-ops/merge-guard.py theastraway/daebot <pr>`), let daebot.live deploy. Then verify:
`curl -sIL https://download.m-i-n-d.ai/download/daebot/<file>` is 200 with the right `content-length`; the server's four `latest*.yml` name
the new version; `node agent/desktop/scripts/verify-feed.cjs` shows the update offered to the previous version; `daebot.live/download` shows it.
No GitHub Actions: nothing here runs in CI.
