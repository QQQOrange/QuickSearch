#!/bin/bash
# 采集「自动取色」证据：浅底一次、深底一次。
# 取证窗口由 node 在后台撑着；READY 标记里带横条窗口的真实矩形，
# 截图直接按这个矩形精确裁剪，并且**多拍几张**（用户一动手横条就会关）。
set -u
cd "C:/Users/64381/WorkBuddy/2026-10-10-16-56-30/QuickSearch-Win"

NODE="C:/Users/64381/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
export NODE_PATH="C:/Users/64381/.workbuddy/binaries/node/workspace/node_modules"
PY="D:/Local AI/image/python_embeded/python.exe"
ROOT="C:/Users/64381/WorkBuddy/2026-10-10-16-56-30"

shoot() {
    local mode="$1" win="_ev-bar-$1.png" bar="_ev-barcrop-$1.png"
    rm -f tools/_ev-ready.txt
    "$NODE" tools/evidence.js "$mode" "$win" 30000 > "tools/_ev-$mode.log" 2>&1 &
    local pid=$!
    for i in $(seq 1 75); do
        [ -f tools/_ev-ready.txt ] && break
        sleep 0.4
    done
    if [ ! -f tools/_ev-ready.txt ]; then
        echo "[$mode] 等不到 READY"; cat "tools/_ev-$mode.log"; kill $pid 2>/dev/null; return 1
    fi
    local json
    json=$(cat tools/_ev-ready.txt)
    echo "[$mode] $json"

    local crop bcrop
    crop=$("$PY" -c "import json;d=json.load(open(r'tools/_ev-ready.txt',encoding='utf-8'));print(' '.join(map(str,d['crop'])))")
    bcrop=$("$PY" -c "
import json
d=json.load(open(r'tools/_ev-ready.txt',encoding='utf-8'))
b=d.get('bar')
if not b: print(''); raise SystemExit
x,y,w,h=b['rect']
print('%d %d %d %d'%(max(0,x-24), max(0,y-24), x+w+24, y+h+24))
")
    echo "[$mode] 窗口crop=$crop  横条crop=$bcrop"

    for k in 1 2 3 4 5; do
        "$PY" "$ROOT/shot.py" "$win" $crop >/dev/null 2>&1
        cp "$win" "${win%.png}-$k.png"
        if [ -n "$bcrop" ]; then
            "$PY" "$ROOT/shot.py" "$bar" $bcrop >/dev/null 2>&1
            cp "$bar" "${bar%.png}-$k.png"
        fi
        sleep 1.2
    done
    wait $pid 2>/dev/null
    echo "[$mode] 完成"
}

shoot light
echo ""
shoot dark
echo ""
ls -la _ev-bar*.png | head -30
