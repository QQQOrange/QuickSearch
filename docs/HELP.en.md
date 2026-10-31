# Quick Search — User Help

Applies to: **v2.6.0** (Windows 10 / 11)
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
  **exactly**. Any change below is reflected instantly. The preview frame has a **fixed height**:
  make cells taller and it scrolls inside the frame instead of stretching the whole settings page.
  - **Drag the right/bottom edge or the bottom-right corner** to resize the cells; the number
    fields follow and the change is saved as soon as you let go;
  - **Drag a tile inside the preview** to reorder — the Tiles list stays in sync.
- **Appearance**: 1–10 rows × 1–10 columns (3×3, 3×4, 4×4…); cell 40–260 px wide, 40–200 px tall;
  gap 0–24 px; cell radius 0–24 px. Colours, shadow and blur are shared with **Bar appearance** —
  the grid has no colour settings of its own. **Tile text**: show *icon + name* or *icon only*
  (icon-only is tidier and allows shorter cells); applies immediately. This is the **default
  style**; individual tiles can override it (see Tiles below).
  - **Rows grow automatically**: the row count you set is a **minimum**. Once 3×3 is full, adding
    a 10th item adds a fourth row (12 slots); removing items reclaims the extra row again.
  - **Short cells keep their names**: below 66 px the tile switches to a compact
    "icon left, name right" layout instead of hiding the name.
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
  **drag any row up or down to reorder — released order is saved immediately** (dragging tiles in
  the preview does the same). Tiles shown = rows × columns, and rows grow with the content.
  The **dropdown on the right of each row** sets that tile's display style:
  **follow default / icon+name / icon only / name only**. The default lives in
  *Appearance → Tile text*; this only overrides the one item — e.g. set a shortcut tile to
  *name only* to see just its note (the page title). *Add content* also lists **OCR models / image-search models / translation
  models** as their own groups (searching "baidu" finds both Baidu search and Baidu OCR), plus
  **function tiles** such as **Wrap symbols**: tap it to open the symbol menu and **wrap, unwrap
  or switch** the selected text (same thing as the `[ ]` button on the bar). Which OCR / image /
  translation provider a function tile uses is the one selected in **Extras** (rows marked
  *currently in use*).
- Every change takes effect **immediately** (no restart).

### Bottom-right toast: which feature is running

When you use **the selection bar / the grid page / OCR / translation / image search**, a small
**built-in** toast appears in the bottom-right corner:

- Content: "Using: <feature> · <app you are in>";
- Timing: only when the feature **actually starts** (blocked by pause / blacklist / disabled = no toast);
- Duration: **Settings → General → "Toast duration"** (1–15 s, 3 s by default);
- Frequency: the same feature in the same app is announced at most once every 10 s;
- Turn it off in **Settings → General → "Bottom-right feature hint"** (on by default).

> This is not a Windows system notification but the app's own small window: rounded, follows the
> light/dark theme, never steals focus, stays out of the taskbar and is **click-through**.

**Working directly on the grid page**:

- Two buttons at the top-right: **✏️ Edit** (every tile gets an **×**; click it to remove that tile,
  click the button again to leave edit mode) and **⚙ Settings** (jump to this settings tab).
- Clicking an **empty tile** opens the *Add content* panel; pick one and it fills that tile.
  The panel is grouped three levels deep (**built-in / shortcuts / favourites / models / web / app /
  hotkey → theme → category**) and has a search box; items already on the grid are ticked and greyed.
  **Drag its bottom-right corner to resize it — the size is remembered**, including after a restart.
- The same window is in Settings: **Grid page → Tiles → ＋ Add content** (search box on top,
  grouped into *Extras / Smart Launch / Engines*, with the same icons as everywhere else);
- Faster still: click **Add to grid / ＋grid** right on an engine row, a Smart Launch row or the
  Wrap symbols page — click again to remove;
- Tiles show **readable names**: internal ids like `@ocr` or `@//ocr/` appear as "Text recognition",
  `@trans` as "Translation"; Smart Launch entries, external apps and favorites show your own names;
- If you selected text before pressing the hotkey, clicking an engine searches **that text directly**
  (no copy needed); with *always open home page* it ignores the text.

> The grid follows the bar theme (light / dark / system) — no separate colour settings.

---

### Wrapping symbols (put a pair of brackets around the selection)

Find it under **Settings → ➕ Extras → 🧷 Wrap symbols**; the page has *Add to bar* /
*Add to grid page*, and once added the **`[ ]`** button appears on the bar or the grid.

Select some text and the bar shows a **`[ ]`** button — click it to wrap the text in a pair of
symbols; click the same pair again to unwrap.

| Group | Symbols | Name |
|---|---|---|
| Quotes | `“text”` `‘text’` `「text」` | Double / single / corner quotes |
| Special | `《text》` `〈text〉` `【text】` | Title marks / single title mark / lenticular |
| Brackets | `（text）` `[text]` `{text}` | Parentheses / square / curly |
| ASCII | `"text"` `'text'` `` `text` `` | Double / single quote / backtick |

**How to use**

1. Select text → the bar appears → click `[ ]`;
2. Pick a pair (or press **1–9** while the menu is open);
3. The result is **copied to the clipboard** immediately and the bar shows *Wrapped (copied)*;
4. Go back and press **Ctrl+V** to replace the original.

**Same pair toggles**

| Current text | You click | Result |
|---|---|---|
| `hello` | Double quotes | `“hello”` |
| `“hello”` | Double quotes | `hello` (unwrapped) |
| `““hello””` | Double quotes | `hello` (**all nested layers removed**) |
| `《hello》` | Double quotes | `“hello”` (**outer pair replaced**, never stacked) |
| `hello` | Square brackets | `[hello]` |

Leading/trailing whitespace stays **outside** the symbols; a half pair (only a trailing `”`)
does not count as wrapped, so it gets a fresh pair.

**With nothing selected**: the `[ ]` button **does not appear** (same rule as 🔗 / 📁 / 📄).
If triggered anyway, you get "select some text first" instead of producing an empty `“”`.

**Consistency with the other actions**

- It only reads the current text — it never touches another program's selection;
- The result goes to the **clipboard** (the same outlet as copy-capture), so closing the menu
  never affects what was already copied;
- **Esc closes the menu only** (the bar stays); selecting different text closes it automatically
  so you cannot wrap the wrong thing.

> **It replaces the text in place** (since v2.6.2): the app hands focus back to the original window
> and pastes over your selection. The result also stays on the clipboard, so press **Ctrl+Z** to undo.
> If you already undid it, or that window is gone, it **copies only** and says why — it never edits
> your document blindly.

---

### Per-app profiles (a different bar / grid page for one app)

Settings → **Per app**.

- Enter a **process name** (Task Manager → Details → Name, e.g. `chrome.exe`), or click
  "Use current app" to grab the app you were just using; `*` wildcards are allowed (`*chrome*`).
- The **bar** and the **grid page** are two independent profiles: changing one for Chrome leaves
  the other untouched.
- For the bar you save a **full item list** (it replaces the default bar); for the grid page you
  pick **one page**.
- Priority: **per-app profile > default profile**. Each of these falls back to the default and the
  panel explains why in red:
  - no profile / the process name does not match;
  - the profile was emptied;
  - nothing in the profile can be displayed any more (e.g. the engine was deleted);
  - the bound page was deleted / the bound page is empty.
- Changes take effect **immediately** — the next time you open the bar inside that app.
- When several bindings match: **exact beats wildcard; longer wildcard beats shorter; otherwise
  the one configured first wins**.
- The "Configured apps" list at the bottom merges both kinds of bindings, with one-click
  "Configure" / "Clear".

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
3. The app decides which of the three types it is and pre-fills name / note / icon — for URLs the
   **page title is fetched into the note** (if it cannot be fetched, the note stays empty and you can
   press "Fetch title again");
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
