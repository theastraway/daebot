# Daebot Android

Capacitor shell around https://daebot.live (twin of `agent/ios`). Sideloaded APK plus Play AAB, same upload key.

Self-update: `window.DaebotAndroid.getVersion()` (JSON string) and
`window.DaebotAndroid.downloadAndInstall(url, sha256)`; progress arrives as the
`daebot-update-progress` window event `{pct, state, message}`. Only active on the
https://daebot.live origin; downloads only from https://download.m-i-n-d.ai/.

## Build (signed)
    source ~/.local/jdk/android-env.sh
    cd agent/android && npm install && npx cap sync android
    export DAEBOT_KS_PATH=~/.daebot-android/daebot-upload.jks DAEBOT_KS_PW=$(cat ~/.daebot-android/keystore.pw)
    cd android && ./gradlew assembleRelease bundleRelease
    # app/build/outputs/apk/release/app-release.apk, app/build/outputs/bundle/release/app-release.aab

Bump `versionCode`/`versionName` in `android/app/build.gradle` for every release.
Keystore and password live outside the repo (MIND runbook: "Daebot Android upload keystore access and recovery runbook").

## Publish (sideload feed)
Upload `Daebot-<ver>.apk`, `Daebot.apk` and `android-latest.json` to
`root@45.55.204.209:/var/www/evie/download/daebot/` (temp name then `mv`), serving
https://download.m-i-n-d.ai/download/daebot/android-latest.json:
`{"version","versionCode","url","sha256","size","releasedAt","notes"}`.
