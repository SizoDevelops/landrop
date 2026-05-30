# Releasing

Releases are produced by GitHub Actions and attached to a GitHub Release. The
two apps version and release **independently** via prefixed tags.

| App | Workflow | Tag pattern | Output |
| --- | --- | --- | --- |
| Desktop | `.github/workflows/release-desktop.yml` | `desktop-v*` | Windows `.exe` (NSIS installer + portable) |
| Mobile  | `.github/workflows/release-mobile.yml`  | `mobile-v*`  | Signed Android `.apk` |

## Cutting a desktop release

1. Bump `version` in `electron/package.json` (e.g. `0.1.0` → `0.1.1`).
2. Commit, then tag and push:
   ```bash
   git tag desktop-v0.1.1
   git push origin desktop-v0.1.1
   ```
3. The workflow builds on `windows-latest` and uploads the installers to a
   Release named after the tag.

No secrets are required for the desktop build — it uses the automatic
`GITHUB_TOKEN`.

## Cutting a mobile release

1. Bump `version` in `mobile-sdk54/app.json` **and** `versionName` (and
   `versionCode`) in `mobile-sdk54/android/app/build.gradle`.
2. Commit, then tag and push:
   ```bash
   git tag mobile-v0.1.1
   git push origin mobile-v0.1.1
   ```
3. The workflow builds a **signed** release APK with Gradle and uploads it.

### Required repository secrets (mobile signing)

The mobile release build signs the APK with an upload keystore. Add these
secrets under **Settings → Secrets and variables → Actions**:

| Secret | What it is |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | The upload keystore file, base64-encoded |
| `ANDROID_KEYSTORE_PASSWORD` | Keystore (store) password |
| `ANDROID_KEY_ALIAS` | Key alias inside the keystore |
| `ANDROID_KEY_PASSWORD` | Key password |

> ⚠️ Keep the keystore file itself **out of git** (it is already gitignored).
> If you lose it you cannot ship signed updates under the same key, so back it
> up somewhere safe.

#### Generating an upload keystore

```bash
keytool -genkeypair -v \
  -keystore landrop-upload-key.keystore \
  -alias landrop-upload \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass <STORE_PASSWORD> -keypass <KEY_PASSWORD> \
  -dname "CN=LAN Drop, O=LAN Drop, C=US"

# Encode for the GitHub secret:
base64 -w0 landrop-upload-key.keystore > keystore.b64   # Linux
# macOS: base64 -i landrop-upload-key.keystore -o keystore.b64
```

Then set the secret values to: the contents of `keystore.b64`
(`ANDROID_KEYSTORE_BASE64`), `<STORE_PASSWORD>`, `landrop-upload`, and
`<KEY_PASSWORD>` respectively.

## Re-running / manual triggers

Both workflows also accept `workflow_dispatch`, so you can trigger a build from
the **Actions** tab without pushing a tag (useful for testing — note it will
attach assets to a Release named after the selected ref).
