# Quick Search — User Help

Applies to: **v2.1.0** (Windows 10 / 11)
Back to: [Project overview](../README.en.md) ｜ [中文](HELP.md)

---

## 1. What this is

A tray-resident selection tool. Select text and a bar drops down from the top of the screen;
click an icon to hand the text to the corresponding website, app, or shortcut. It also includes
on-screen OCR, translation, screenshot image search, favorites, and encrypted backups.

**There is no main window** — everything is reached through the tray icon and the bar.

---

## 2. Install and first run

1. Download `QuickSearch.exe` from the [releases page](https://github.com/QQQOrange/QuickSearch/releases/latest).
2. Put it in its own folder (e.g. `D:\Apps\QuickSearch\`) and double-click it.
3. **No window appears on first run.** Look at the notification area at the bottom-right of the
   taskbar (it may be collapsed behind the `^` button).

> The app is portable: configuration, icons, and logs are created in `Quick search data\` next
> to the executable.

---

## 3. Basic usage

| Action | Result |
|---|---|
| **Select text** in any application | The bar pops up automatically |
| **Ctrl + double-click** | Bring the bar up manually |
| **Ctrl + C** | Copy and show the bar at the same time (can be disabled in Settings) |
| Click an icon on the bar | Search / open with that engine |
| **Double-click the tray icon** | Open Settings |
| **Right-click the tray icon** | Menu (Settings, Exit, …) |

Triggers and hotkeys are configured in **Settings → ⚙️ General**.

If the bar appears where you do not want it, add that application to the blacklist in
**Settings → 🚫 Scope**.

---

## 4. OCR (text recognition)

1. Click the **OCR** button on the bar (it shows your own icon if you customized it).
2. Drag to select a screen region; recognition starts when you release.
3. Results appear in a separate window; multiple engines can run **at the same time** and are
   shown side by side.

Notes:

- **The local engine is the default**: offline, free, instant, and it consumes no online quota.
- For higher accuracy, switch to or add online engines in **Settings → 🔤 OCR** (most are billed
  per call).
- You can add several online engines to "recognize simultaneously", but each adds one billable call.

---

## 5. Translation

Select text and click the translation button on the bar. Engines, credentials, and streaming
output are configured in **Settings → 🌐 Translation**.

---

## 6. Image search

Click the image-search button on the bar → select a screen region → search by image with the
chosen engine. Engines and credentials live in **Settings → 🖼 Image search**.

---

## 7. Favorites

In **Settings → ⭐ Favorites** you can create two-level folders; items support text, images, and
rich text, and can be reordered by dragging. The favorites panel can be opened from the tray menu
or a hotkey.

---

## 8. Custom icons

Any engine, the OCR button, the translation button, and favorite items can use your own image:

1. Go to **Settings → 🔎 Engines**, find the item → click its icon → pick an image.
2. To revert: use "Restore default" in the same place.

Two behaviors worth knowing:

- **Your icons survive upgrades.** When you update, previously customized icons are carried over
  automatically; nothing needs to be redone.
- Drop an image named **exactly like the engine** (e.g. `百度.png`) into
  `Quick search data\icons\` and that engine will use it — no per-engine setup needed.

---

## 9. Backup, restore, and sync

### Local backups

**Settings → ☁️ Backup** → create a backup. Files land in `QuickSearch back\` next to the
executable, named like `config(2026-10-30 18-11-57).QuickSearch`. Scheduled auto-backup is also
supported.

### Backup password (important)

A backup password is what makes a backup restorable on another machine.
**If you lose the password, the backup cannot be decrypted — there is no recovery.**
After changing Windows users or reinstalling the OS, if you see "this backup is password
protected, but this machine has no password set", enter the original password in
**Settings → ☁️ Backup** and restore again.

### WebDAV sync

Fill in server URL, account, and password in **Settings → ☁️ Backup**; you can enable sync on
startup and upload on exit. When syncing multiple machines, make a local backup first.

### Moving to a new machine

Recommended: on the old machine "Backup → export", then "restore" on the new one.
Copying `config.json` directly is **not** recommended — it is tied to the local DPAPI key and may
not decrypt elsewhere.

---

## 10. Data folders

| Path | Contents |
|---|---|
| `<exe folder>\Quick search data\config.json` | Configuration (encrypted) |
| `<exe folder>\Quick search data\icons\` | Your custom icons |
| `<exe folder>\Quick search data\log.txt` | Runtime log (for troubleshooting) |
| `<exe folder>\QuickSearch back\` | Backup files |

The whole folder can be copied elsewhere. **Deleting the data folder is equivalent to a factory reset.**

---

## 11. FAQ

**Double-clicking does nothing / it won't open.**
This is a tray app with no main window. Check the notification area (including the `^` overflow).
If an instance is already running, launching the exe again exits silently on purpose, so that two
instances do not fight over global hotkeys.

**I can't find the tray icon.**
Click `^` on the taskbar to expand hidden icons, or set the icon to "always show" in Windows
settings.

**Icons don't show, or a letter appears instead.**
That image could not be read. Check that the file exists in `Quick search data\icons\`; for custom
icons, use "Restore default" in Settings and pick the image again.

**OCR says the quota is used up.**
If you have used an online engine, its free quota may be exhausted. Switch to the local engine —
it keeps working with no network and no quota.

**Are my settings kept after upgrading?**
Yes. The config format and folder location are unchanged; replacing the executable is enough, and
custom icons are carried over automatically.

**How do I uninstall completely?**
Exit the app → delete the exe plus the `Quick search data` and `QuickSearch back` folders → if
needed, remove the startup entry (Task Manager → Startup → Quick Search, or the "start with
Windows" switch in Settings).

---

## 12. Feedback

When reporting a problem, please include the last part of `Quick search data\log.txt` and the steps
to reproduce it.
