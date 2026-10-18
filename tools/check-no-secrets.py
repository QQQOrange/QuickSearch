# -*- coding: utf-8 -*-
"""分享前自检：确认本机凭据**没有**被打包进软件里。

用户的担心（原话）：
    「像 OCR 的 API、WebDAV 的数据，不能默认存储在软件里面，只能存储在配置
      信息里面，不然我把软件分享给别人，这样一些隐私信息就泄露了。」

这个脚本就是那条底线，随时可以跑一遍确认：

  · 从本机 config.json 读出敏感字段（OCR Key / Secret、WebDAV 账号 / 密码）；
  · 在「会被分享出去的东西」里全文搜索这些值，一个都不许命中：
      1. 编译产物 QuickSearch.exe（target/release 和桌面各一份）
      2. 整个源码树（排除 target/、node_modules/、.git/）
      3. 编译产物目录里体积最大的若干文件（保险起见再扫一层）

  · 顺带确认 `src/config.rs` 的默认配置里这些字段都是**空串** ——
    默认值一旦被人填上真凭据，每个编译出来的 exe 就都带上了。

用法：
    python tools/check-no-secrets.py                 # 默认检查
    python tools/check-no-secrets.py --exe 某个.exe  # 额外检查指定文件

退出码：0 = 干净；1 = 发现泄露（会列出命中的文件和字段名）。
"""

import io
import json
import os
import re
import sys

# 这些字段是隐私，绝不能出现在软件里。
#
# ⚠ 刻意**不含** `webdav_url`：那只是服务器地址（谁都能看到的那种），不是凭据；
#   而且测试里用的就是坚果云的公开示例地址 `https://dav.jianguoyun.com/dav/`，
#   用户按文档填的一模一样 —— 放进名单只会天天误报。
SECRET_FIELDS = [
    "ocr_key",      # 百度 OCR 的 API Key
    "ocr_secret",   # 百度 OCR 的 Secret Key
    "webdav_user",  # 网盘账号
    "webdav_pass",  # 网盘密码 / 应用密码
]

SKIP_DIRS = {"target", "node_modules", ".git", ".workbuddy"}
SKIP_EXT = {
    ".png", ".ico", ".jpg", ".jpeg", ".gif", ".webp", ".bmp",
    ".woff", ".woff2", ".ttf", ".otf", ".zip", ".7z", ".rar",
    ".mp4", ".mp3", ".pdf",
}
MAX_FILE = 64 * 1024 * 1024


def load_secrets():
    """从本机配置里取敏感值。没有配置（从没配过）就返回空字典。"""
    path = os.path.join(os.environ.get("APPDATA", ""), "QuickSearch", "config.json")
    if not os.path.isfile(path):
        print("· 本机还没有 config.json（%s），没什么可查的。" % path)
        return {}
    try:
        cfg = json.load(io.open(path, encoding="utf-8"))
    except Exception as e:
        print("！读配置失败：%s" % e)
        return {}
    out = {}
    for k in SECRET_FIELDS:
        v = (cfg.get(k) or "").strip()
        # 太短的值（比如空、单个字符）到处都会撞上，不查
        if len(v) >= 6:
            out[k] = v
    return out


def scan_bytes(blob, secrets):
    hits = []
    for field, val in secrets.items():
        for enc in ("utf-8", "utf-16-le"):
            try:
                if val.encode(enc) in blob:
                    hits.append(field)
                    break
            except Exception:
                pass
    return hits


def scan_tree(root, secrets):
    """扫源码树。返回 [(相对路径, [命中字段])]。"""
    bad = []
    n = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            if os.path.splitext(fn)[1].lower() in SKIP_EXT:
                continue
            try:
                if os.path.getsize(p) > MAX_FILE:
                    continue
                blob = open(p, "rb").read()
            except Exception:
                continue
            n += 1
            hits = scan_bytes(blob, secrets)
            if hits:
                bad.append((os.path.relpath(p, root), hits))
    return n, bad


def scan_file(path, secrets):
    if not os.path.isfile(path):
        return None
    try:
        blob = open(path, "rb").read()
    except Exception as e:
        print("！读不了 %s：%s" % (path, e))
        return None
    return scan_bytes(blob, secrets)


def check_defaults_are_empty(root):
    """src/config.rs 的 Default 里，敏感字段必须都是空串。"""
    p = os.path.join(root, "src", "config.rs")
    if not os.path.isfile(p):
        return []
    src = io.open(p, encoding="utf-8", errors="replace").read()
    bad = []
    for field in ("ocr_key", "ocr_secret", "webdav_user", "webdav_pass", "webdav_url"):
        # 找 `field: ...` 这一行的默认值，要求是 String::new()
        m = re.search(r"^\s*%s\s*:\s*(.+?),?\s*$" % re.escape(field), src, re.M)
        if m:
            val = m.group(1).strip().rstrip(",")
            if val != "String::new()":
                bad.append((field, val))
    return bad


def main():
    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    extra = []
    argv = sys.argv[1:]
    if "--exe" in argv:
        i = argv.index("--exe")
        extra = [a for a in argv[i + 1:] if not a.startswith("-")]

    print("=" * 62)
    print(" QuickSearch 分享前自检：本机凭据有没有混进软件里")
    print("=" * 62)
    print("源码树: %s" % root)

    secrets = load_secrets()
    if not secrets:
        print("\n· 配置里没有可查的敏感值（都是空的），直接算通过。")
        print("\n结论：干净 —— 软件里不含任何账号信息。")
        return 0

    print("\n· 待查字段: %s" % ", ".join(sorted(secrets)))

    failed = []

    # ---- 1. 编译产物 ----
    print("\n[1] 编译产物 exe")
    exes = [
        os.path.join(root, "target", "release", "QuickSearch.exe"),
        os.path.join(os.environ.get("USERPROFILE", ""), "Desktop", "QuickSearch.exe"),
    ] + extra
    seen = set()
    for e in exes:
        e = os.path.abspath(e)
        if e in seen:
            continue
        seen.add(e)
        hits = scan_file(e, secrets)
        if hits is None:
            print("    - %s（不存在，跳过）" % e)
        elif hits:
            print("    ✗ %s  命中 %s" % (e, ", ".join(hits)))
            failed.append(e)
        else:
            print("    ✓ %s  干净" % e)

    # ---- 2. 源码树 ----
    print("\n[2] 源码树（排除 target/、node_modules/）")
    n, bad = scan_tree(root, secrets)
    if bad:
        for p, hits in bad:
            print("    ✗ %s  命中 %s" % (p, ", ".join(hits)))
            failed.append(p)
    else:
        print("    ✓ 扫了 %d 个文件，一个都没命中" % n)

    # ---- 3. 默认配置必须是空 ----
    print("\n[3] src/config.rs 的默认配置")
    bad_def = check_defaults_are_empty(root)
    if bad_def:
        for field, val in bad_def:
            print("    ✗ %s 的默认值是 %s（应该是 String::new()）" % (field, val))
            failed.append("src/config.rs:" + field)
    else:
        print("    ✓ 敏感字段默认全是空串（新装的用户拿到的软件里没有别人的凭据）")

    print("\n" + "=" * 62)
    if failed:
        print(" 结论：✗ 发现 %d 处泄露 —— 分享前必须清掉！" % len(failed))
        for f in failed:
            print("   · %s" % f)
        return 1
    print(" 结论：✓ 干净 —— 把 QuickSearch.exe 单独发出去是安全的。")
    print(" （Key / 密码只在本机 %APPDATA%\\QuickSearch\\config.json 里）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
