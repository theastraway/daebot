#!/usr/bin/env bash
#
# Daebot — publish a built release to download.m-i-n-d.ai and register it with MIND.
#
# Modeled on the proven MIND publisher (mindapp-sandbox/extension-scripts/publish-dmg.sh):
# upload atomically to the evie droplet, upload the electron-updater feed files, write the
# download manifest, register the release in MIND's registry, then verify every surface.
#
# Usage:
#   publish-release.sh <artifactsDir> <version> --notes "..." [--platforms mac,windows,linux]
#                       [--dry-run] [--force] [--skip-registry]
#
# <artifactsDir> is what electron-builder wrote (agent/desktop/dist): the installers AND the
# latest*.yml feed files. The feed files are NOT optional for Mac/Windows in-app update:
# an installer uploaded without its latest-<channel>.yml never reaches an installed app.
#
# Layout on the droplet (one folder per product, mirrors the feed URL):
#   /var/www/evie/download/daebot/
#     Daebot-<v>-mac-universal.dmg / .zip / .blockmap
#     Daebot-Setup-<v>-x64.exe / -arm64.exe
#     Daebot-<v>-linux-x86_64.AppImage / -amd64.deb
#     latest-mac.yml, latest.yml, latest-arm64.yml, latest-linux.yml
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"       # agent/desktop/scripts -> repo root
AGENT_DIR="$REPO_DIR/agent"

HOST="root@45.55.204.209"
SSH_KEY="${DAEBOT_SSH_KEY:-$HOME/.ssh/droplet_170_key}"
SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10)
REMOTE_DIR="/var/www/evie/download/daebot"
PUBLIC_BASE="https://download.m-i-n-d.ai/download/daebot"
REGISTRY_BASE="https://mindapp.onrender.com/developer/v1/mac-releases"

DIR=""; VERSION=""; NOTES="${RELEASE_NOTES:-}"
PLATFORMS="mac,windows,linux"
DRY_RUN=0; FORCE=0; SKIP_REGISTRY=0

usage() {
    sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --notes)       NOTES="${2:-}"; shift 2 ;;
        --platforms)   PLATFORMS="${2:-}"; shift 2 ;;
        --dry-run)     DRY_RUN=1; shift ;;
        --force)       FORCE=1; shift ;;
        --skip-registry) SKIP_REGISTRY=1; shift ;;
        -h|--help)     usage 0 ;;
        *)             if [ -z "$DIR" ]; then DIR="$1"; elif [ -z "$VERSION" ]; then VERSION="$1"; else echo "error: unexpected argument $1" >&2; usage 1; fi; shift ;;
    esac
done

[ -n "$DIR" ] && [ -n "$VERSION" ] || { echo "error: <artifactsDir> and <version> are required" >&2; usage 1; }
[ -d "$DIR" ] || { echo "error: not a directory: $DIR" >&2; exit 1; }
if [ -z "$NOTES" ]; then
    echo "error: release notes are required — pass --notes \"...\" or set \$RELEASE_NOTES" >&2
    echo "       (the registry record is what the in-app update dialog and the download page show)" >&2
    exit 1
fi
command -v jq >/dev/null || { echo "error: jq is required" >&2; exit 1; }
command -v shasum >/dev/null || { echo "error: shasum is required" >&2; exit 1; }

# run(): execute, or in --dry-run only print. runsh(): same for a shell string.
run()   { if [ "$DRY_RUN" = 1 ]; then printf '+ (dry-run) '; printf '%q ' "$@"; printf '\n'; else "$@"; fi; }
runsh() { local label="$1" cmd="$2"; if [ "$DRY_RUN" = 1 ]; then printf '+ (dry-run, %s) %s\n' "$label" "$cmd"; else eval "$cmd"; fi; }

# ---------------------------------------------------------------- what a release is made of
# Every name electron-builder produces, per platform. `feed` lists the update-feed files that
# must travel with the installers (missing feed = installed apps never see the update).
mac_files()    { echo "Daebot-$VERSION-mac-universal.dmg Daebot-$VERSION-mac-universal.zip Daebot-$VERSION-mac-universal.dmg.blockmap Daebot-$VERSION-mac-universal.zip.blockmap"; }
win_files()    { echo "Daebot-Setup-$VERSION-x64.exe Daebot-Setup-$VERSION-arm64.exe"; }
linux_files()  { echo "Daebot-$VERSION-linux-x86_64.AppImage Daebot-$VERSION-linux-amd64.deb"; }

files_for() {
    case "$1" in
        mac)     mac_files ;;
        windows) win_files ;;
        linux)   linux_files ;;
        *) echo "error: unknown platform $1" >&2; exit 1 ;;
    esac
}
feed_for() {
    case "$1" in
        mac)     echo "latest-mac.yml" ;;
        windows) echo "latest.yml latest-arm64.yml" ;;
        linux)   echo "latest-linux.yml" ;;
    esac
}

echo "Daebot release $VERSION"
echo "  artifacts : $DIR"
echo "  platforms : $PLATFORMS"
echo "  remote    : $HOST:$REMOTE_DIR"
echo "  notes     : $(printf '%s' "$NOTES" | head -c 100)"
echo ""

# ---------------------------------------------------------------- 1. collect and check artifacts
WANTED=()
for p in ${PLATFORMS//,/ }; do
    for f in $(files_for "$p"); do [ -f "$DIR/$f" ] && WANTED+=("$f"); done
    for f in $(feed_for "$p"); do [ -f "$DIR/$f" ] && WANTED+=("$f"); done
done

if [ "${#WANTED[@]}" -eq 0 ]; then
    echo "error: none of the expected $VERSION files are in $DIR." >&2
    echo "       Build first (agent/desktop: npm run dist:mac|dist:win|dist:linux), or check the version." >&2
    exit 1
fi

echo "==> Artifacts found"
MANIFEST_ROWS=""
for f in "${WANTED[@]}"; do
    size=$(stat -f%z "$DIR/$f" 2>/dev/null || stat -c%s "$DIR/$f")
    sha=$(shasum -a 256 "$DIR/$f" | awk '{print $1}')
    human=$(echo "$size" | awk '{printf "%.1f MB", $1/1048576}')
    printf '    %-48s %10s  %s\n' "$f" "$human" "${sha:0:16}…"
    # A missing installer for a requested platform is worth saying out loud, not skipping quietly.
    MANIFEST_ROWS+="$f|$size|$sha"$'\n'
done

echo ""
echo "==> Checking every requested platform is actually complete"
MISSING=0
for p in ${PLATFORMS//,/ }; do
    for f in $(files_for "$p"); do
        if [ ! -f "$DIR/$f" ]; then echo "    MISSING ($p): $f" >&2; MISSING=1; fi
    done
done
[ "$MISSING" = 0 ] || echo "    (a platform with a missing installer will keep its 'Coming soon' button)" >&2

# ---------------------------------------------------------------- 2. upload, atomically
echo ""
echo "==> Uploading to $HOST:$REMOTE_DIR"
runsh "mkdir remote dir" "ssh ${SSH_OPTS[*]} $HOST 'mkdir -p $REMOTE_DIR'"
for f in "${WANTED[@]}"; do
    # Upload under a .tmp name, then mv into place: a half-uploaded installer is never visible
    # under its real name, so a download mid-publish can never get a truncated file.
    if [ "$DRY_RUN" != 1 ]; then
        REMOTE_SHA="$(ssh "${SSH_OPTS[@]}" "$HOST" "if [ -f $REMOTE_DIR/$f ]; then shasum -a 256 $REMOTE_DIR/$f | awk '{print \$1}'; else echo ABSENT; fi")"
        LOCAL_SHA="$(shasum -a 256 "$DIR/$f" | awk '{print $1}')"
        if [ "$REMOTE_SHA" = "$LOCAL_SHA" ]; then echo "    $f already there with the same sha256 — skipping"; continue; fi
        if [ "$REMOTE_SHA" != "ABSENT" ] && [ "$FORCE" != 1 ]; then
            echo "error: $f exists on the droplet with a DIFFERENT sha256." >&2
            echo "       Re-run with --force to overwrite, or confirm this is not a stale rebuild." >&2
            exit 1
        fi
    fi
    runsh "scp $f" "scp ${SSH_OPTS[*]} \"$DIR/$f\" $HOST:$REMOTE_DIR/$f.tmp"
    runsh "atomic mv $f" "ssh ${SSH_OPTS[*]} $HOST 'mv $REMOTE_DIR/$f.tmp $REMOTE_DIR/$f && chmod 644 $REMOTE_DIR/$f'"
done

# ---------------------------------------------------------------- 3. verify over HTTPS
echo ""
echo "==> Verifying over HTTPS"
if [ "$DRY_RUN" != 1 ]; then
    for f in "${WANTED[@]}"; do
        hdrs="$(curl -sIL "$PUBLIC_BASE/$f" || true)"
        code="$(printf '%s' "$hdrs" | grep -E '^HTTP' | tail -1 | awk '{print $2}')"
        rlen="$(printf '%s' "$hdrs" | grep -i '^content-length:' | tail -1 | awk '{print $2}' | tr -d '\r')"
        lsize=$(stat -f%z "$DIR/$f" 2>/dev/null || stat -c%s "$DIR/$f")
        if [ "$code" != "200" ]; then echo "    FAIL  $f  (HTTP ${code:-none})" >&2; exit 1; fi
        if [ -n "$rlen" ] && [ "$rlen" != "$lsize" ]; then echo "    FAIL  $f  (content-length $rlen != local $lsize)" >&2; exit 1; fi
        echo "    ok    $f  (HTTP 200, $rlen bytes)"
    done
fi

# ---------------------------------------------------------------- 4. download manifest (the website)
echo ""
echo "==> Writing the download manifest (agent/web/download/releases.json)"
run node "$AGENT_DIR/scripts/release-manifest.mjs" "$DIR" "$VERSION"
echo "    (merge that change: daebot.live/download reads it)"

# ---------------------------------------------------------------- 5. MIND registry (authoritative record)
if [ "$SKIP_REGISTRY" = 1 ]; then
    echo ""
    echo "==> Registry: skipped (--skip-registry)"
else
    echo ""
    echo "==> Registering with MIND ($REGISTRY_BASE)"
    API_KEY="${MIND_API_KEY:-}"
    if [ -z "$API_KEY" ] && [ -f "$HOME/.daebot/mind-key" ]; then API_KEY="$(tr -d '[:space:]' < "$HOME/.daebot/mind-key")"; fi
    if [ -z "$API_KEY" ]; then
        API_KEY="$(jq -r '(.mcpServers.mind.env.MIND_API_KEY // ((.mcpServers.mind.headers.Authorization // "") | sub("^Bearer +"; "")) // "") | select(startswith("mind_"))' "$HOME/.claude.json" 2>/dev/null || true)"
    fi
    case "$API_KEY" in mind_*) ;; *) echo "error: no MIND key (set MIND_API_KEY, or have ~/.daebot/mind-key, or add mcpServers.mind to ~/.claude.json)" >&2; exit 1 ;; esac
    for p in ${PLATFORMS//,/ }; do
        # A universal Mac DMG registers as arch=universal (it runs on both); Windows and
        # Linux register as their single arch. The registry keys on (version, build, platform, arch).
        case "$p" in
            mac)     ENTRIES="universal:Daebot-$VERSION-mac-universal.dmg" ;;
            windows) ENTRIES="x64:Daebot-Setup-$VERSION-x64.exe arm64:Daebot-Setup-$VERSION-arm64.exe" ;;
            linux)   ENTRIES="x64:Daebot-$VERSION-linux-x86_64.AppImage" ;;
        esac
        for pair in $ENTRIES; do
            arch="${pair%%:*}"; file="${pair#*:}"
            [ -n "$file" ] || continue
            [ -f "$DIR/$file" ] || continue
            size=$(stat -f%z "$DIR/$file" 2>/dev/null || stat -c%s "$DIR/$file")
            sha=$(shasum -a 256 "$DIR/$file" | awk '{print $1}')
            body="$(jq -n --arg version "$VERSION" --arg build "$VERSION" --arg url "$PUBLIC_BASE/$file" \
                --arg sha256 "$sha" --argjson size_bytes "$size" --arg notes "$NOTES" \
                --arg platform "$p" --arg arch "$arch" \
                '{version:$version,build:$build,url:$url,sha256:$sha256,size_bytes:$size_bytes,notes:$notes,platform:$platform,arch:$arch}')"
            echo "    POST $p/$arch"
            if [ "$DRY_RUN" != 1 ]; then
                resp="$(curl -sS -X POST "$REGISTRY_BASE" -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' -d "$body")"
                echo "      -> $(printf '%s' "$resp" | head -c 200)"
            fi
        done
    done
fi

# ---------------------------------------------------------------- receipt
echo ""
echo "================================================================"
echo "  RECEIPT — Daebot $VERSION"
echo "================================================================"
for f in "${WANTED[@]}"; do
    size=$(stat -f%z "$DIR/$f" 2>/dev/null || stat -c%s "$DIR/$f")
    echo "  $(shasum -a 256 "$DIR/$f" | awk '{print $1}' | cut -c1-16)…  $(echo "$size" | awk '{printf "%9.1f MB", $1/1048576}')  $f"
done
echo "  Direct:  $PUBLIC_BASE/"
echo "  Feed:    $PUBLIC_BASE/latest-mac.yml, latest.yml, latest-linux.yml"
echo "  Next:    merge the releases.json change; installed apps see the update from the feed"
[ "$DRY_RUN" = 1 ] && echo "  MODE:    dry-run — nothing above was executed"
echo "================================================================"
