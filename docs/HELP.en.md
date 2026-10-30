# Quick Search — User Help

Applies to: **v2.4.0** (Windows 10 / 11)
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
| **Ctrl + C** (default) | Opens the **grid page** (a tile panel) — a separate surface from the selection bar |
| Click an icon on the bar | Search / open with that engine |
| **Double-click the tray icon** | Open Settings |
| **Right-click the tray icon** | Menu (Settings, Exit, …) |

Triggers and hotkeys are configured in **Settings → ⚙️ General**.

If the bar appears where you do not want it, add that application to the blacklist in
**Settings → 🚫 Scope**.

---

### Two different pop-ups (important)

There are **two** surfaces, with separate content, styling and settings:

| | Selection bar | Grid page |
|---|---|---|
| Opened by | Selecting text / Ctrl+double-click | A hotkey (default **Ctrl+C**) |
| Looks like | A thin strip with engines in a row | A grid panel of tiles |
| Items | Bar members (Settings → 🔎 Engines) | Its **own separate** list (below) |
| What a click searches | The selected text | Text **already** in the clipboard; otherwise the engine home page |

**Configuring the grid** (Settings → 🧩 **Grid page**). This tab has four cards:
*Live preview / Appearance / Behaviour / Tiles*.

- **Live preview**: what you see *is* the grid page — it loads the grid's own stylesheet and the
  same markup, so layout, size, spacing, corner radius, colours and shadow match the pop-up
  **exactly**. Any change below is reflected instantly.
- **Appearance**: 1–10 rows × 1–10 columns (3×3, 3×4, 4×4…); cell 40–260 px wide, 40–200 px tall;
  gap 0–24 px; cell radius 0–24 px. Colours, shadow and blur are shared with **Bar appearance** —
  the grid has no colour settings of its own.
- **Behaviour**:
  - **Enable grid page** — turn it off and the hotkey stops opening it; content and settings stay;
  - **Clicking an empty tile adds content** — turn it off to make empty tiles inert (avoids misclicks);
  - **Click behaviour** — *search the selected text* (default) or *always open the engine home page*
    (use the grid as a bookmark panel);
  - **Hotkey** — `ctrl+c` by default; any combination such as `ctrl+shift+g` or `alt+space`.
    Once changed, **Ctrl+C no longer opens it**; clashes with the Favorites hotkey or the reserved
    `Ctrl+Alt+O` are rejected with a message;
  - **Hotkey self-check** — reports which step blocks you (bad combination / master switch off /
    paused / current app blacklisted).
- **Tiles**: a list **separate from the bar**. Add items one by one, or *Import from bar*;
  **drag any row up or down to reorder — released order is saved immediately**. Tiles shown =
  rows × columns.
- Every change takes effect **immediately** (no restart).

**Working directly on the grid page**:

- The **⚙** at the top-right jumps straight to this settings tab;
- Clicking an **empty tile** opens an *Add content* panel with three groups: **built-in features**
  (text recognition / translation / image search), **Smart Launch**, and **engines** (searchable).
  Pick one and it fills that tile — no trip to Settings needed;
- Tiles show **readable names**: internal ids like `@ocr` or `@//ocr/` appear as "Text recognition",
  `@trans` as "Translation"; Smart Launch entries, external apps and favorites show your own names;
- If you selected text before pressing the hotkey, clicking an engine searches **that text directly**
  (no copy needed); with *always open home page* it ignores the text.

> The grid follows the bar theme (light / dark / system) — no separate colour settings.

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

## 8. Smart Launch

Put frequently used **apps, URLs, and local files** on the bar and open them with one click — you only paste one address and the type is detected for you.

### Add an entry

1. Settings → **🎯 Launch**;
2. Paste an address into the box and press Enter (or click **Detect and add**);
3. The app decides which of the three types it is and pre-fills name / note / icon;
4. Edit anything in the preview card, then click **Save**.

What you can paste:

| You paste | Detected as | Notes |
|---|---|---|
| `https://example.com`, `example.com` | URL | `https://` is added when missing |
| `D://Tools//App.exe`, `notepad` | App | `.exe/.lnk/.bat/.cmd/.msi` supported; a bare name is looked up on `PATH` |
| `%USERPROFILE%\Desktop\list.xlsx` | File | Files and folders; `%VAR%` and `~` are expanded |

**Everything is validated before saving**: URLs are checked for a valid shape (and the page title is fetched), apps and files are checked for an existing path. If validation fails you get the reason instead of a dead entry.

### Notes are filled automatically

- **URL**: the page `<title>` (3 s timeout — if it cannot be fetched, the host name is used and saving is *not* blocked);
- **App**: the program name (`notepad.exe` → `notepad`);
- **File**: the file name (with extension).

All three can be edited.

### Icons

Leave it empty to use a **default icon picked by type**:

| Type | Default icon |
|---|---|
| URL | globe |
| Folder | folder |
| App (exe/lnk/bat…) | the program's own icon (extracted from the exe); the app icon if that fails |
| Text / Markdown / config | document with text lines |
| Image | picture frame |
| Video | player |
| Audio | music note |
| PDF | document marked PDF |
| Archive | archive box |
| Source code | `<>` |
| Office document | document with a list |
| Anything else | generic file |

The type is computed **live from the target** (folder check, file extension), so renaming
`.txt` to `.mp4` changes the icon automatically — no need to set it again.

Two ways to customise:

- **Pick a local image** (png / jpg / ico / svg / webp / gif / bmp, ≤3 MB);
- **Give an image URL** (`http(s)://…`). The image is **downloaded and stored inside the configuration**, so losing network access or the image host does not break the bar.

### Pin, reorder, edit, delete

- **Pin to bar**: the entry appears on the bar and opens with one click;
- **↑ / ↓**: move it (buttons grey out at the ends);
- **Edit**: change name, note, target, icon; changing the target re-runs detection and validation;
- **Try it**: open it right away — a stale path is reported immediately;
- **Delete**: the bar slot is removed together with the entry, so no dead slot is left behind.

Up to 200 entries.

### Data, sync, and backup

Entries live in the configuration (`shortcuts`), so they travel with the whole config:

- **Local backup / restore** (`.QuickSearch`): the full configuration includes them — restoring brings that point in time back;
- **WebDAV sync**: same file and same triggers as every other setting (compare at start, upload at exit); there is no separate switch;
- **Import / export**: a new export group **"Smart Launch"** (links/paths, names, notes, icons). It is **unchecked by default** (paths reveal your local folder layout) — tick it to take them along.

**Tolerance rules when restoring or importing** (so a hand-edited backup cannot damage the config):

| Situation | Handling |
|---|---|
| The same target appears twice (URL trailing slash and path case ignored) | Only the first is kept |
| Duplicate `id` | Later ones are dropped (otherwise one bar slot would point at two entries) |
| Missing `id` / missing target / type not app·url·file | The entry is skipped, never guessed |
| Empty name | Falls back to the target, so the bar always shows something |
| More than 200 entries | Only the first 200 are kept |

Import/restore **replaces the whole list** (same semantics as restoring a backup: back to that point in time) rather than merging old and new.

### FAQ

**"Path no longer exists or has been moved"** — the target was moved or deleted; click **Edit** and point it again.

**"Already points to the same target"** — duplicates of the same type are rejected; change the target of one of them.

**The browser does not open** — the app only hands the URL to the system default browser; if nothing happens, the default browser association is broken.

**The bar icon is broken** — that entry's icon data is invalid; click **Clear icon** to fall back to the letter badge and pick another image.

---

## 9. Custom icons

Any engine, the OCR button, the translation button, and favorite items can use your own image:

1. Go to **Settings → 🔎 Engines**, find the item → click its icon → pick an image.
2. To revert: use "Restore default" in the same place.

Two behaviors worth knowing:

- **Your icons survive upgrades.** When you update, previously customized icons are carried over
  automatically; nothing needs to be redone.
- Drop an image named **exactly like the engine** (e.g. `百度.png`) into
  `Quick search data\icons\` and that engine will use it — no per-engine setup needed.

---

## 10. Backup, restore, and sync

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

## 11. Data folders

| Path | Contents |
|---|---|
| `<exe folder>\Quick search data\config.json` | Configuration (encrypted) |
| `<exe folder>\Quick search data\icons\` | Your custom icons |
| `<exe folder>\Quick search data\log.txt` | Runtime log (for troubleshooting) |
| `<exe folder>\QuickSearch back\` | Backup files |

The whole folder can be copied elsewhere. **Deleting the data folder is equivalent to a factory reset.**

---

## 12. FAQ

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

## 13. Feedback

When reporting a problem, please include the last part of `Quick search data\log.txt` and the steps
to reproduce it.
