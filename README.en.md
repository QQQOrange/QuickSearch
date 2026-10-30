# Quick Search for Windows

> Select text in any application, or press a hotkey, and a search bar drops down from the top
> of the screen: click an icon to hand the selected text to that website, app, or shortcut.
> Includes on-screen text recognition (OCR), translation, screenshot image search,
> favorites, an icon editor, encrypted backups, and WebDAV sync.

A Windows 10 / 11 desktop app built on a **native host (wry + system WebView2)**, with no
bundled runtime dependencies.

> **Size (v2.1.0)**: a single **6.68 MiB** executable with the frontend embedded and
> compressed — copy one `.exe` anywhere and it runs, with no resource folder beside it.
>
> The inference runtime (`onnxruntime.dll`) and models used by **AI matting** are **not**
> shipped in the executable. They are downloaded to `<program folder>/抠图模型/` only when
> you click "Download" in Settings. If you never use that feature, nothing is downloaded.

[中文](README.md) | **English** ｜ [Help](docs/HELP.en.md) ｜ [Changelog](CHANGELOG.md)

---

## Features

| Capability | Description |
|---|---|
| **Selection bar** | Pops up when you select text, or on a hotkey; click an icon to search |
| **Many engines** | **780+ engine entries** in 27 categories, plus custom web / app / hotkey engines |
| **Aliases** | Many engines have aliases — type "B站" to reach Bilibili, "度娘" for Baidu |
| **Image search** | Select a screen region → several engines (Baidu / Yandex / SauceNAO / trace.moe / AI vision models) |
| **OCR** | Select a region to read text, with a **local offline engine plus multiple online engines**, and multi-engine side-by-side results |
| **Translation** | Translate the selected text right from the bar, with streaming output |
| **Favorites** | Two-level folders for text / images / rich text, drag to reorder |
| **Icon editor** | AI auto-matting (optional models) + brush touch-up + re-run with another model + export |
| **Custom icons** | Any engine / OCR / translation / favorite item can use your own image, and **your icons carry over across upgrades** |
| **Backup & sync** | Local encrypted backups (AES-256-GCM + Argon2id), WebDAV cloud sync |
| **Auto-update** | Optional check in "About"; downloads, verifies, and replaces the running executable |
| **Theming** | Light / dark / follow system; the bar supports liquid glass (WebGL2 refraction) |

---

## Download & install

1. Get `QuickSearch.exe` from the [releases page](https://github.com/QQQOrange/QuickSearch/releases/latest).
2. Put it in any folder (a dedicated folder is recommended) and double-click it.
3. **There is no window on first run** — the app lives in the notification area. Look for its
   icon in the tray at the bottom-right of the taskbar (it may be collapsed under `^`).

No installer, no .NET, and no separate WebView2 install (Windows 10/11 usually includes it).

### Where your data lives

Portable by design: configuration, icons, and logs live in `Quick search data\` next to the
executable, and backups in `QuickSearch back\`. Copy the whole folder to another machine and
keep working (but see the backup password note below).

---

## Getting started

1. **Select text**: select a piece of text in any app — the bar pops up → click an icon to search.
2. **Hotkeys**: you can also use Ctrl + double-click or Ctrl + C (configurable in Settings → General).
3. **OCR**: click the OCR button on the bar (it shows your own icon if you customized it) → select a screen region.
4. **Open Settings**: double-click the tray icon, or right-click it → Settings.

---

## Settings pages

| Page | Purpose |
|---|---|
| ⚙️ General | Trigger methods, hotkeys, start with Windows, bar behavior |
| 🎨 Appearance | Theme, colors, corner radius, liquid glass, bar size |
| 🚫 Scope | Windows / apps where the bar should not appear (blacklist and whitelist) |
| 🔎 Engines | Bar members, ordering, custom engines, icons |
| 🤖 AI tools | AI endpoints and prompts |
| ✂️ Matting | Matting model download and parameters |
| 🔤 OCR | OCR engines, credentials, multi-engine mode, text cleanup |
| 🌐 Translation | Translation engines, credentials, streaming switch |
| 🖼 Image search | Image search engines and credentials |
| ⭐ Favorites | Folders, items, ordering |
| 📦 Data | Import / export, cleanup, data folder |
| ☁️ Backup | Local backups, backup password, WebDAV sync |
| 📖 Help | Built-in help entry |
| ℹ️ About | Version, build time, auto-update, developer |

---

## Data security

- **The configuration file itself is encrypted**: stored in a `{"qsEnc":1,"kdf":"argon2id",…}`
  envelope, with the key protected by local DPAPI.
- **Backups can be encrypted**: with a backup password, an exported `.QuickSearch` backup can be
  restored on another machine — **if you lose the password, it cannot be decrypted**. Keep it safe.
- **Moving machines**: prefer "Backup → export and restore" over copying `config.json`
  directly (the latter is tied to the local machine key).

---

## Upgrading from 1.x

- **Configuration and backup formats are fully compatible**: 1.5.x `config.json` files and
  `.QuickSearch` backups can be read and restored by 2.1.0 directly.
- The data folder location is unchanged (still `Quick search data` next to the executable), so
  replacing the executable is all that is needed — no migration.
- **Custom icons carry over automatically**: on first launch the new version reads your icon
  overrides from the previous installation.
- This release switches the default OCR engine to the **local** engine (online engines are
  billed per call, so this avoids accidental charges); you can switch back in Settings.

---

## Building (this repository)

This repository holds the **frontend assets and the historical Tauri sources**; the v2.1.0
release artifact is produced by the native-host version.

```powershell
cargo test             # unit tests
cargo clippy           # lints
cargo build --release  # output: target\release\QuickSearch.exe
```

Release profile is defined in `Cargo.toml`: `opt-level` + `lto="fat"` +
`codegen-units=1` + `strip=true`.

### Testing auto-update

The "detect → download → verify → replace the running executable" chain cannot wait for a real
release, so there are two run-and-exit probes and two test-only endpoint overrides
(`QS_UPDATE_API` / `QS_UPDATE_WEB`):

```powershell
$env:QS_UPDATE_API = 'http://127.0.0.1:8731/api/repos/x/releases/latest'
$env:QS_UPDATE_WEB = 'http://127.0.0.1:8731/web/releases/latest'

QuickSearch.exe --update-probe     # check once, print NEWER/TAG/SIZE/SHA
QuickSearch.exe --update-install   # actually download + replace (run in an isolated folder only)
```

---

## Repository layout

```
src/              Rust sources
  main.rs           Main program: windows / commands / bar layout / image search / OCR scheduling
  config.rs         Config structure and persistence (atomic write + backups + encryption)
  win.rs            Win32 wrappers: windows, UIA, keyboard hooks, screen capture
  ocr.rs / ocr_engines.rs             OCR and engine registry
  trans.rs / trans_engines.rs         Translation and engine registry
  imgsearch.rs      Image search engine registry
  engines.rs        Search engine parsing
  iconedit*.rs      Icon editor (including AI matting glue)
  matting.rs        Matting edge processing
  crypto.rs         Backup encryption (AES-256-GCM + Argon2id)
  export.rs         Config import/export
  webdav.rs         WebDAV client
  update.rs         Auto-update
ui/               Frontend (vanilla JS + CSS, no framework)
  index.html        Bar page
  bar.js / bar.css  Bar interactions
  settings.html     Settings page
  ocr.html          OCR result window
  iconedit.html     Icon editor
  shared.js         Logic shared by the bar and settings
  data/engines.json Engine registry
  data/icons/       Icon assets (402 files)
docs/
  HELP.md / HELP.en.md       User help (Chinese / English)
  PRD.md                     Product requirements
  PUSH-GUIDE.md              Release process
  RELEASE-v*.md              Per-version release notes
CHANGELOG.md       Changelog
```

---

## Documentation

- [User help (Chinese)](docs/HELP.md) ｜ [Help (English)](docs/HELP.en.md)
- [Changelog](CHANGELOG.md)
- [Product requirements](docs/PRD.md)
- [Release process](docs/PUSH-GUIDE.md)

---

## License

See [LICENSE](LICENSE).
