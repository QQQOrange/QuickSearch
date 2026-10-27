#!/usr/bin/env node
/* 翻译真机联调用的**假 OpenAI 兼容服务**。
 *
 * 为什么要它：翻译的多引擎链路（`trans_run` → `trans::translate` → HTTP
 * `chat/completions`）在单元测试里已经用本地 http 桩验过请求体，但"两家
 * 引擎**并行**各发一次、译文各落各的框"这件事只有真机跑一遍才算数 ——
 * 真机上走的是 reqwest + WebView2 + Tauri 事件，桩替不掉。
 *
 * 行为（刻意做成"可判别"的）：
 *   · 每个请求记一行 JSONL（时间 / 引擎用的模型 / Authorization / 系统提示词），
 *     脚本据此断言"确实并行发了两次、各带自己家的模型"；
 *   · 模型名里带 `bad` 的返回 401 + error 体 —— 用来验"一家挂、一家好"；
 *   · `GET /v1/models` 给一份混了对话模型和非对话模型的表，验"只留对话模型"。
 *
 * 用法：node tools/trans-e2e-mock.js [端口]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 8788);
const LOGF = process.env.MOCK_LOG || path.join(__dirname, '_trans-e2e.mock.jsonl');

/** 模型名 → 这一家的"译文"（让界面上一眼看出是哪家回的） */
function replyFor(model, userText) {
    return `【mock·${model}】${userText}`;
}

const MODELS = [
    { id: 'mock-deepseek', object: 'model', owned_by: 'mock' },
    { id: 'mock-sf', object: 'model', owned_by: 'mock' },
    { id: 'mock-bad-key', object: 'model', owned_by: 'mock' },
    { id: 'mock-embed-v2', object: 'model', owned_by: 'mock' },   // 不像对话模型
    { id: 'mock-vl-2', object: 'model', owned_by: 'mock' },       // 不像对话模型
];

const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const rec = {
            t: new Date().toISOString(),
            method: req.method,
            url: req.url,
            auth: req.headers['authorization'] || '',
            raw,
        };
        try {
            const body = JSON.parse(raw || '{}');
            rec.model = body.model;
            rec.messages = body.messages;
            rec.stream = body.stream;
        } catch (e) { /* GET 没有 body */ }
        fs.appendFileSync(LOGF, JSON.stringify(rec) + '\n');

        if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: MODELS }));
            return;
        }
        if (req.method === 'POST' && req.url.indexOf('/chat/completions') >= 0) {
            const model = rec.model || '';
            // 401 通道：验"一家挂、一家好，别连坐"
            if (model.indexOf('bad') >= 0) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'mock：这把 Key 是故意的坏 Key（401）', type: 'invalid_request_error' } }));
                return;
            }
            const userText = (rec.messages || [])
                .filter((m) => m && m.role === 'user')
                .map((m) => m.content)
                .join('\n');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                id: 'chatcmpl-mock',
                object: 'chat.completion',
                model,
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: replyFor(model, userText) },
                    finish_reason: 'stop',
                }],
            }));
            return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'mock：没有这条路 ' + req.url } }));
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('mock openai-compatible server on http://127.0.0.1:' + PORT + '/v1');
    console.log('log: ' + LOGF);
});
process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
