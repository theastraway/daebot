# ONE-TIME SETUP — so Dae never asks for release credentials again

Run these ONCE. After this, "publish Daebot 0.3.x" is one command I run alone.

Dae's public key (already generated on the AJC M5 MAX, private half stays there):
    ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKO7at+b8qLtVuHO0s7IS3Uu73l1cWPPLwFaiQnvpGN1 dae-daebot-release

---

## 1. The droplet (uploads to download.m-i-n-d.ai)

That host is `root@45.55.204.209`; the downloads live in `/var/www/evie/download/`.

**Best: run this FROM the Mac that already has ~/.ssh/droplet_170_key** (it can already
reach the droplet). It appends Dae's key without touching the existing one:

    ssh -i ~/.ssh/droplet_170_key root@45.55.204.209 \
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
       grep -q "dae-daebot-release" ~/.ssh/authorized_keys 2>/dev/null || \
       echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKO7at+b8qLtVuHO0s7IS3Uu73l1cWPPLwFaiQnvpGN1 dae-daebot-release" >> ~/.ssh/authorized_keys && \
       chmod 600 ~/.ssh/authorized_keys && echo ADDED'

**Or paste that one `ssh-ed25519 ...` line** into `/root/.ssh/authorized_keys` on the droplet.

Then I can upload, verify over HTTPS, and fix a bad upload myself — forever.

## 2. Mac signing + notarization (only needed to publish the macOS DMG)

The Developer ID is `ANTHONY JOSEPH CONTI (VJ44THJ238)` + the `MINDNotarize` keychain
profile. Both live on the Mac that cuts your Mac releases. That Mac is the cleanest fix:

    # on that Mac, once: let Dae use it
    ssh-copy-id -i ~/.ssh/daebot_release_ed25519.pub <that-mac>     # or paste the key above
    # and turn on: System Settings > General > Sharing > Remote Login

With SSH on that Mac, ONE key gives me both the cert and a machine that already reaches
the droplet. Then I cut, sign, notarize and publish there myself.

**If you would rather not open SSH on it:** export the cert and I can sign here —
Keychain Access > login > My Certificates > "Developer ID Application: ANTHONY JOSEPH
CONTI" > Export > .p12 (set a password), plus the notarization app-specific password, and
run `xcrun notarytool store-credentials MINDNotarize` here with them.

---

## What each unlocks

| Setup | I can then ship, alone |
|---|---|
| 1 only | Windows + Linux 0.3.47 (unsigned **by design**), the feed files, releases.json, MIND registry, HTTPS verification |
| 1 + 2 | the macOS DMG **signed + notarized**, on every surface |

## What is ALREADY done and waiting

- PDF support is live on daebot.live (commit 5645d2a; verified with 3 real PDFs incl. a scan).
- `agent/desktop/scripts/publish-release.sh` — the whole publish in one command (`--dry-run` works).
- `agent/desktop/README.md` — the procedure written down, incl. the traps.
- The 0.3.47 Mac DMG is already built and verified to carry the fix (adhoc-signed — I will not
  publish an unsigned build over a notarized one).
