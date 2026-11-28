// ==UserScript==
// @name         GG公益站 Playground 断线缓存补发助手
// @namespace    pg-cache-companion
// @version      1.0.10
// @description  配合 GG公益站 Playground Executor 使用：缓存完整原始响应体，IndexedDB 持久化，按请求模型匹配补发；文本解析仅用于查看和复制，支持分段复制长回复。
// @match        https://aistudio.google.com/*
// @run-at       document-start
// @inject-into  content
// @grant        none
// @noframes
// ==/UserScript==

(function runCacheCompanion(inPage) {
    "use strict";

    function promptsBasePath() {
        if (location.origin !== "https://aistudio.google.com") return "";
        return location.pathname.match(/^(\/(?:u\/\d+\/)?prompts)(?:\/|$)/)?.[1] || "";
    }

    function isPromptsPage() {
        return promptsBasePath() !== "";
    }

    function waitForPromptsEntry() {
        let stopped = false;
        let timer;
        const stop = () => {
            if (stopped) return;
            stopped = true;
            window.clearInterval(timer);
            window.removeEventListener("popstate", check);
            window.removeEventListener("hashchange", check);
            window.navigation?.removeEventListener("currententrychange", check);
        };
        const check = () => {
            if (stopped || !isPromptsPage()) return;
            stop();
            runCacheCompanion(false);
        };
        window.addEventListener("popstate", check);
        window.addEventListener("hashchange", check);
        window.navigation?.addEventListener("currententrychange", check);
        timer = window.setInterval(check, 500);
        check();
    }

    if (!isPromptsPage()) {
        if (!inPage) waitForPromptsEntry();
        return;
    }

    const startedAttr = "data-pg-cache-companion-started";
    if (document.documentElement?.hasAttribute(startedAttr)) return;

    // 与原脚本一致，通过页面 nonce 注入到主页面上下文，保证可拦截主世界的 fetch 与 WebSocket
    if (!inPage) {
        let observer;
        let timeout;
        let finished = false;
        function finish() {
            finished = true;
            observer?.disconnect();
            clearTimeout(timeout);
        }
        function inject() {
            if (finished) return true;
            if (!isPromptsPage()) {
                finish();
                return true;
            }
            const root = document.documentElement;
            if (root?.hasAttribute(startedAttr)) {
                finish();
                return true;
            }
            const nonce = document.querySelector("script[nonce]")?.nonce;
            if (!root || !nonce) return false;
            const script = document.createElement("script");
            try {
                script.nonce = nonce;
                const source = `(${runCacheCompanion.toString()})(true);`;
                let trusted = source;
                if (window.trustedTypes) {
                    try {
                        trusted = window.trustedTypes.createPolicy("pg-cache-companion-bootstrap", {
                            createScript: () => source
                        }).createScript("");
                    } catch (_) {
                        if (window.trustedTypes.defaultPolicy) {
                            trusted = window.trustedTypes.defaultPolicy.createScript(source);
                        }
                    }
                }
                script.textContent = trusted;
                (document.head || root).appendChild(script);
                finish();
            } catch (_) {
                finish();
            } finally {
                script.remove();
            }
            return true;
        }
        if (!inject()) {
            observer = new MutationObserver(inject);
            observer.observe(document, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["nonce"]
            });
            timeout = setTimeout(finish, 15000);
        }
        return;
    }

    document.documentElement.setAttribute(startedAttr, "");

    const W = window;
    const WS_PATH_RE = /\/api\/playground\/ws(?:$|\?)/i;
    const GENERATE_MATCH = "MakerSuiteService/GenerateContent";
    const CACHE_MAX_MEM_BYTES = 10 * 1024 * 1024;   // 单条原始响应缓存上限 10MB
    const CACHE_MAX_STORE_BYTES = 3 * 1024 * 1024;  // IndexedDB 不可用时的 localStorage 兜底上限 3MB
    const CACHE_DB_NAME = "pg-cache-companion";
    const CACHE_DB_VERSION = 1;
    const CACHE_DB_STORE = "responses";
    const STREAM_CHUNK_SIZE = 4096; // WebSocket 流式补发分块大小
    const MAX_WS_BUFFERED = 1024 * 1024;
    const REQUEST_TTL_MS = 15 * 60 * 1000;

    const STORE_KEYS = {
        cache: "pg_cache_companion_latest_v1",
        keepOnCancel: "pg_cache_companion_keep_on_cancel_v1",
        collapsed: "pg_cache_companion_collapsed_v1",
        pos: "pg_cache_companion_pos_v1",
        segSize: "pg_cache_companion_seg_size_v1",
        filter: "pg_cache_companion_filter_v1",
        preferFrames: "pg_cache_companion_prefer_frames_v1"
    };
    const DIAG_MAX = 80;
    const SEG_SIZE_DEFAULT = 6000;
    const SEG_SIZE_MIN = 500;
    const SEG_SIZE_MAX = 200000;

    const state = {
        replayArmed: false,
        replayCache: null,       // { ts, model, status, body }
        keepOnCancel: true,      // 收到服务端 cancel 时，后台继续收完 Google 回复以写入缓存
        noticeText: "",
        noticeLevel: "info",     // info | ok | warn | err
        collapsed: false,
        segSize: SEG_SIZE_DEFAULT, // 分段复制每段字数
        // 精简输出：复制/查看时去掉思考块、草稿注释等，只留正文
        filter: { enabled: true, thinking: true, comments: true, imgthink: true, imgtags: false, custom: false, customTags: "" },
        wsConnected: false,
        replayPending: null,
        cacheLoading: true,
        preferFrames: true,      // 回传时优先按 Executor 真实发出的帧原样回放
        diag: []                 // 诊断事件日志
    };

    const pendingRequests = new Map(); // requestId -> { model, stream, ts }
    const outRecords = new Map();      // requestId -> 正在录制的 Executor 出站帧
    const suppressedIds = new Map();   // requestId -> timerId (已取消但后台续收中的请求)
    let lastRequestMeta = null;

    const sleep = (ms) => new Promise((r) => W.setTimeout(r, ms));

    function diagLog(text) {
        const d = new Date();
        const p = (n) => String(n).padStart(2, "0");
        state.diag.push(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${text}`);
        if (state.diag.length > DIAG_MAX) state.diag.splice(0, state.diag.length - DIAG_MAX);
    }

    function fmtBytes(n) {
        if (!Number.isFinite(n) || n < 0) return "-";
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
        return (n / 1024 / 1024).toFixed(2) + " MB";
    }

    function normalizeModel(value) {
        return String(value || "").trim().replace(/^models\//, "");
    }

    function fmtAge(ts) {
        const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (s < 5) return "刚刚";
        if (s < 60) return s + "秒前";
        const m = Math.floor(s / 60);
        if (m < 60) return m + "分钟前";
        return Math.floor(m / 60) + "小时前";
    }

    // 优先使用 IndexedDB 保存完整原始响应体；localStorage 只作小缓存兜底。
    // 这样不再受 3MB localStorage 上限限制，10MB 内的长回复刷新后也可恢复。
    let cacheDbPromise = null;
    function openCacheDB() {
        if (!("indexedDB" in W)) return Promise.reject(new Error("IndexedDB 不可用"));
        if (cacheDbPromise) return cacheDbPromise;
        cacheDbPromise = new Promise((resolve, reject) => {
            const req = W.indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CACHE_DB_STORE)) {
                    db.createObjectStore(CACHE_DB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error("打开缓存数据库失败"));
            req.onblocked = () => reject(new Error("缓存数据库被其他页面占用"));
        });
        return cacheDbPromise;
    }

    async function idbGetCache() {
        const db = await openCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CACHE_DB_STORE, "readonly");
            const req = tx.objectStore(CACHE_DB_STORE).get("latest");
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error || new Error("读取缓存失败"));
        });
    }

    async function idbPutCache(entry) {
        const db = await openCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CACHE_DB_STORE, "readwrite");
            tx.objectStore(CACHE_DB_STORE).put(entry, "latest");
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error("写入缓存失败"));
            tx.onabort = () => reject(tx.error || new Error("缓存写入中止"));
        });
    }

    async function idbDeleteCache() {
        const db = await openCacheDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(CACHE_DB_STORE, "readwrite");
            tx.objectStore(CACHE_DB_STORE).delete("latest");
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error || new Error("清除缓存失败"));
            tx.onabort = () => reject(tx.error || new Error("清除缓存中止"));
        });
    }

    async function loadPersistedState() {
        const loadStartedAt = Date.now();
        try {
            const raw = localStorage.getItem(STORE_KEYS.cache);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed.body === "string" && parsed.body.length > 0) {
                    state.replayCache = parsed;
                }
            }
        } catch (_) {}
        try {
            const k = localStorage.getItem(STORE_KEYS.keepOnCancel);
            if (k === "false") state.keepOnCancel = false;
            else if (k === "true") state.keepOnCancel = true;
        } catch (_) {}
        try {
            state.collapsed = localStorage.getItem(STORE_KEYS.collapsed) === "true";
        } catch (_) {}
        try {
            const f = JSON.parse(localStorage.getItem(STORE_KEYS.filter) || "null");
            if (f && typeof f === "object") {
                for (const k of Object.keys(state.filter)) {
                    if (typeof state.filter[k] === "boolean" && typeof f[k] === "boolean") state.filter[k] = f[k];
                }
                if (typeof f.customTags === "string") state.filter.customTags = f.customTags;
            }
        } catch (_) {}
        try {
            if (localStorage.getItem(STORE_KEYS.preferFrames) === "false") state.preferFrames = false;
        } catch (_) {}
        try {
            const sz = parseInt(localStorage.getItem(STORE_KEYS.segSize), 10);
            if (Number.isFinite(sz) && sz >= SEG_SIZE_MIN && sz <= SEG_SIZE_MAX) state.segSize = sz;
        } catch (_) {}

        try {
            const stored = await idbGetCache();
            if (stored && typeof stored.body === "string" && stored.body.length > 0 &&
                (!state.replayCache || Number(stored.ts) >= Number(state.replayCache.ts))) {
                state.replayCache = stored;
            }
        } catch (_) {
            // IndexedDB 不可用时继续使用 localStorage 兜底缓存。
        } finally {
            state.cacheLoading = false;
            updateUI();
        }
    }

    const mirrorOf = (e) => ({ ts: e.ts, model: e.model, status: e.status, body: e.body });

    async function saveReplayCache(model, body, status = 200, extra = null) {
        const text = String(body || "");
        if (!text || text.length > CACHE_MAX_MEM_BYTES) {
            if (text.length > CACHE_MAX_MEM_BYTES) {
                setNotice("⚠️ 响应超过 10MB，未写入缓存", "warn");
            }
            return;
        }
        // 刚由 Executor 原帧写入过缓存时，不让 fetch 路径的原始响应体覆盖它
        const cur = state.replayCache;
        if (!extra && cur && Array.isArray(cur.frames) && Date.now() - cur.ts < 10000) return;

        const entry = {
            ts: Date.now(),
            model: String(model || ""),
            status: Number(status) || 200,
            body: text
        };
        if (extra && Array.isArray(extra.frames) && extra.frames.length) {
            entry.frames = extra.frames;
            entry.kind = extra.kind;
        }
        state.replayCache = entry;
        updateUI();

        let persisted = false;
        try {
            await idbPutCache(entry);
            persisted = true;
            // 小缓存额外留一份 localStorage 镜像，便于 IndexedDB 暂时不可用时兜底。
            if (text.length <= CACHE_MAX_STORE_BYTES) {
                try { localStorage.setItem(STORE_KEYS.cache, JSON.stringify(mirrorOf(entry))); } catch (_) {}
            } else {
                try { localStorage.removeItem(STORE_KEYS.cache); } catch (_) {}
            }
        } catch (_) {
            if (text.length <= CACHE_MAX_STORE_BYTES) {
                try {
                    localStorage.setItem(STORE_KEYS.cache, JSON.stringify(mirrorOf(entry)));
                    persisted = true;
                } catch (_) {}
            }
        }

        setNotice(
            persisted
                ? `✅ 已缓存完整响应（${fmtBytes(text.length)}${entry.frames ? "，含 Executor 原帧" : ""}，可刷新恢复）`
                : `⚠️ 已暂存原始响应（${fmtBytes(text.length)}），但浏览器持久化失败；刷新前请勿关闭页面`,
            persisted ? "ok" : "warn"
        );
        updateUI();
    }


    function extractCachedText(raw) {
        const original = String(raw || "");
        const source = original.trim().replace(/^\)\]\}'\s*/, "");
        const roots = [];

        try {
            roots.push(JSON.parse(source));
        } catch (_) {
            // 兼容按行分隔的 JSON 响应
            for (const line of source.split(/\r?\n/)) {
                const part = line.trim().replace(/^\)\]\}'\s*/, "");
                if (!part) continue;
                try { roots.push(JSON.parse(part)); } catch (_) {}
            }
        }

        // 先兼容标准 Gemini candidates 响应
        const standardTexts = [];
        function walkStandard(value, depth = 0) {
            if (depth > 24 || value == null || typeof value !== "object") return;
            if (Array.isArray(value)) {
                for (const item of value) walkStandard(item, depth + 1);
                return;
            }
            if (Array.isArray(value.candidates)) {
                for (const candidate of value.candidates) {
                    for (const part of candidate?.content?.parts || []) {
                        if (typeof part?.text === "string" && part.text) standardTexts.push(part.text);
                    }
                }
            }
            for (const [key, child] of Object.entries(value)) {
                if (key !== "candidates") walkStandard(child, depth + 1);
            }
        }
        for (const root of roots) walkStandard(root);
        if (standardTexts.length) {
            return { text: standardTexts.join(""), parsed: true, format: "gemini" };
        }

        // AI Studio GenerateContent 使用嵌套数组；文本块通常表现为 [null, "文本"]。
        // 按原数组遍历顺序收集，不去重，避免误删模型连续输出的重复片段。
        const wireTexts = [];
        function walkWire(value, depth = 0) {
            if (depth > 32 || value == null || typeof value !== "object") return;
            if (!Array.isArray(value)) {
                for (const child of Object.values(value)) walkWire(child, depth + 1);
                return;
            }
            if (value.length === 2 && value[0] === null && typeof value[1] === "string") {
                const text = value[1];
                if (text && !/^(?:model|user|assistant|system)$/i.test(text.trim())) {
                    wireTexts.push(text);
                }
                return;
            }
            for (const child of value) walkWire(child, depth + 1);
        }
        for (const root of roots) walkWire(root);
        if (wireTexts.length) {
            return { text: wireTexts.join(""), parsed: true, format: "aistudio-wire" };
        }

        // 断线时 JSON 可能只写入了一部分，整段 JSON.parse 会失败。
        // 仍尝试从已收到的原始字节中恢复完整的 [null, "文本片段"]。
        const recovered = [];
        const pairPattern = /\[\s*null\s*,\s*"/g;
        let match;
        while ((match = pairPattern.exec(source))) {
            const quoteStart = pairPattern.lastIndex - 1;
            let escaped = false;
            let quoteEnd = -1;
            for (let i = quoteStart + 1; i < source.length; i++) {
                const ch = source[i];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === "\\") {
                    escaped = true;
                    continue;
                }
                if (ch === '"') {
                    quoteEnd = i;
                    break;
                }
            }
            if (quoteEnd < 0) break;
            try {
                const value = JSON.parse(source.slice(quoteStart, quoteEnd + 1));
                if (typeof value === "string" && value && !/^(?:model|user|assistant|system)$/i.test(value.trim())) {
                    recovered.push(value);
                }
            } catch (_) {}
            pairPattern.lastIndex = quoteEnd + 1;
        }
        if (recovered.length) {
            return { text: recovered.join(""), parsed: true, format: "aistudio-wire-partial" };
        }

        return { text: original, parsed: false, format: "raw" };
    }

    // 在 Markdown 行内代码/围栏代码之外查找真正的 HTML 标签。
    // 反引号数量必须与开符完全一致，避免把说明文字中的伪标签当成结构边界。
    function findOpeningTagOutsideCode(text, tagName, fromIndex = 0) {
        const source = String(text);
        const tagRe = new RegExp(`^<${tagName}(?:\\s[^>]*)?>`, "i");
        let i = Math.max(0, fromIndex);
        while (i < source.length) {
            if (source[i] === "`") {
                let runEnd = i + 1;
                while (source[runEnd] === "`") runEnd++;
                const delimiter = source.slice(i, runEnd);
                let close = runEnd;
                let matched = -1;
                while (close < source.length) {
                    const tick = source.indexOf("`", close);
                    if (tick < 0) break;
                    let tickEnd = tick + 1;
                    while (source[tickEnd] === "`") tickEnd++;
                    if (tickEnd - tick === delimiter.length) {
                        matched = tickEnd;
                        break;
                    }
                    close = tickEnd;
                }
                if (matched >= 0) {
                    i = matched;
                    continue;
                }
                i = runEnd;
                continue;
            }
            if (source[i] === "<") {
                if (tagRe.test(source.slice(i))) return i;
            }
            i++;
        }
        return -1;
    }

    // 精简输出：按选项去掉思考块 / 草稿注释 / 绘图行，只保留正文。
    function applyFilter(text, f) {
        let t = String(text);
        // <prelude> 思维块为固定过滤项，不依赖“自定义标签剔除”开关或标签列表。
        // 从消息开头定位代码片段之外的真正 <content>，切掉此前所有思维内容。
        const preludePrefix = t.match(/^\s*<prelude(?:\s[^>]*)?>/i);
        if (preludePrefix) {
            const realContentStart = findOpeningTagOutsideCode(t, "content", preludePrefix[0].length);
            if (realContentStart >= 0) t = t.slice(realContentStart);
        }
        if (f.thinking) t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
        if (f.imgthink) t = t.replace(/<imgthink>[\s\S]*?<\/imgthink>/gi, "");
        if (f.comments) {
            t = t.replace(/<!--[\s\S]*?-->/g, "");
            const open = t.indexOf("<!--"); // 断线时可能留下未闭合的半截草稿
            if (open >= 0) t = t.slice(0, open);
        }
        if (f.imgtags) t = t.replace(/^[ \t]*(?:title|image)###.*?###[ \t]*$/gm, "");
        if (f.custom && f.customTags) {
            const tags = f.customTags.split(/[\n,，;；]+/).map(x => x.trim())
                .filter(Boolean).map(x => x.replace(/^<\/?|\/?>(?:$)/g, "").trim()).filter(Boolean);
            for (const tag of tags) {
                const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

                // 其他自定义标签维持原有的成对标签及断线未闭合处理。
                const paired = new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${escaped}\\s*>`, "gi");
                const unclosed = new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*$`, "gi");
                t = t.replace(paired, "").replace(unclosed, "");
            }
        }
        t = t.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
        t = t.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");
        return t;
    }

    function getOutputText() {
        const cache = state.replayCache;
        if (!cache?.body) return null;
        const result = extractCachedText(cache.body);
        const rawLength = result.text.length;
        if (!result.parsed || !state.filter.enabled) {
            return Object.assign({}, result, { rawLength, filtered: false });
        }
        const text = applyFilter(result.text, state.filter);
        // 过滤后什么都没剩，说明规则不适用，退回原文避免复制出空内容
        if (!text.trim()) return Object.assign({}, result, { rawLength, filtered: false });
        return Object.assign({}, result, { text, rawLength, filtered: true });
    }

    function saveFilter() {
        try { localStorage.setItem(STORE_KEYS.filter, JSON.stringify(state.filter)); } catch (_) {}
    }

    async function writeClipboard(text) {
        if (W.navigator?.clipboard?.writeText) {
            await W.navigator.clipboard.writeText(text);
            return;
        }
        const area = document.createElement("textarea");
        area.value = text;
        area.style.cssText = "position:fixed;left:-9999px;top:0";
        document.documentElement.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        if (!ok) throw new Error("clipboard unavailable");
    }

    // 把长文本按段拆分：优先在空行 / 换行 / 句末标点处断开，避免把句子从中间切开。
    function splitIntoSegments(text, size) {
        const segs = [];
        const n = text.length;
        let i = 0;
        while (i < n) {
            let end = Math.min(i + size, n);
            if (end < n) {
                const minEnd = i + Math.floor(size * 0.5);
                const win = text.slice(minEnd, end);
                let cut = -1;
                let k = win.lastIndexOf("\n\n");
                if (k >= 0) cut = minEnd + k + 2;
                if (cut < 0) {
                    k = win.lastIndexOf("\n");
                    if (k >= 0) cut = minEnd + k + 1;
                }
                if (cut < 0) {
                    const m = [...win.matchAll(/[。！？!?….”"」』）)]/g)].pop();
                    if (m) cut = minEnd + m.index + m[0].length;
                }
                if (cut > i) end = cut;
                // 不要把 emoji 等代理对从中间切开
                const code = text.charCodeAt(end - 1);
                if (code >= 0xd800 && code <= 0xdbff) end -= 1;
            }
            segs.push(text.slice(i, end));
            i = end;
        }
        return segs.length ? segs : [""];
    }

    async function copyCachedText() {
        const result = getOutputText();
        if (!result) return;
        try {
            await writeClipboard(result.text);
            setNotice(
                result.parsed
                    ? `✅ 已复制全部${result.filtered ? "正文（已精简，" + result.rawLength + " → " + result.text.length + " 字）" : "回复（" + result.text.length + " 字）"}。内容很长时建议用“分段复制”`
                    : "⚠️ 未识别响应结构，已复制原始缓存",
                result.parsed ? "ok" : "warn"
            );
        } catch (err) {
            setNotice("❌ 自动复制失败，请使用“分段复制”手动复制", "err");
        }
    }

    function viewCachedText() {
        if (!state.replayCache?.body) return;
        let result = getOutputText();
        const root = hostEl?.shadowRoot;
        if (!root) return;
        root.querySelector(".cache-viewer")?.remove();

        let segs = splitIntoSegments(result.text, state.segSize);
        let idx = 0;
        let refilter = () => {};
        let autoNext = true;
        const copied = new Set();

        const overlay = document.createElement("div");
        overlay.className = "cache-viewer";
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:12px";
        const panel = document.createElement("div");
        panel.style.cssText = "width:min(620px,95vw);max-height:92vh;overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px";

        const heading = document.createElement("strong");
        heading.textContent = "缓存内容（分段复制）";
        const hint = document.createElement("div");
        hint.style.cssText = "font-size:11px;color:var(--muted)";
        function hintText() {
            if (!result.parsed) return "未识别响应结构，下面显示原始缓存数据，不建议直接当作回复粘贴。";
            return result.filtered
                ? `共 ${result.text.length} 字（已从 ${result.rawLength} 字精简）。逐段点“复制本段”，到酒馆输入框依次粘贴即可。`
                : `共 ${result.text.length} 字。逐段点“复制本段”，到酒馆输入框依次粘贴即可。`;
        }
        hint.textContent = hintText();

        // 精简选项
        const filterBox = document.createElement("div");
        filterBox.style.cssText = "display:flex;flex-wrap:wrap;gap:4px 12px;padding:6px 8px;background:var(--card);border-radius:7px";
        const filterChecks = {};
        function mkCheck(label, key, bold) {
            const lab = document.createElement("label");
            lab.className = "check";
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = !!state.filter[key];
            box.addEventListener("change", () => {
                state.filter[key] = box.checked;
                saveFilter();
                refilter();
            });
            const txt = document.createElement("span");
            txt.textContent = label;
            if (bold) txt.style.fontWeight = "650";
            lab.append(box, txt);
            filterChecks[key] = box;
            return lab;
        }
        const masterLabel = mkCheck("只保留正文（精简）", "enabled", true);
        masterLabel.style.flexBasis = "100%";
        filterBox.append(
            masterLabel,
            mkCheck("去掉思考块", "thinking"),
            mkCheck("去掉草稿注释", "comments"),
            mkCheck("去掉生图思考", "imgthink"),
            mkCheck("去掉 title/image 绘图行", "imgtags"),
            mkCheck("自定义标签剔除", "custom")
        );
        const customTagsInput = document.createElement("textarea");
        customTagsInput.placeholder = "填写标签名，每行一个，例如：blend\nthought\nanalysis\n也可写 <blend>";
        customTagsInput.value = state.filter.customTags || "";
        customTagsInput.style.cssText = "width:100%;min-height:64px;resize:vertical;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px;font:inherit";
        customTagsInput.addEventListener("input", () => {
            state.filter.customTags = customTagsInput.value;
            saveFilter();
            if (state.filter.custom) refilter();
        });
        filterBox.append(customTagsInput);
        function syncFilterEnabled() {
            for (const [k, box] of Object.entries(filterChecks)) {
                if (k !== "enabled") box.disabled = !state.filter.enabled;
            }
            customTagsInput.disabled = !state.filter.enabled || !state.filter.custom;
        }

        // 每段字数设置
        const sizeRow = document.createElement("div");
        sizeRow.style.cssText = "display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--muted)";
        const sizeLabel = document.createElement("span");
        sizeLabel.textContent = "每段字数";
        const sizeInput = document.createElement("input");
        sizeInput.type = "number";
        sizeInput.min = String(SEG_SIZE_MIN);
        sizeInput.max = String(SEG_SIZE_MAX);
        sizeInput.step = "500";
        sizeInput.value = String(state.segSize);
        sizeInput.style.cssText = "width:88px;height:28px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:0 6px;font:inherit";
        const sizeApply = document.createElement("button");
        sizeApply.className = "btn sm";
        sizeApply.type = "button";
        sizeApply.textContent = "重新分段";
        sizeApply.style.height = "28px";
        sizeRow.append(sizeLabel, sizeInput, sizeApply);

        // 进度 + 跳转
        const progRow = document.createElement("div");
        progRow.style.cssText = "display:flex;gap:6px;align-items:center";
        const progress = document.createElement("strong");
        progress.style.cssText = "flex:1;font-size:12px";
        const jump = document.createElement("select");
        jump.style.cssText = "height:28px;max-width:140px;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;font:inherit";
        progRow.append(progress, jump);

        const area = document.createElement("textarea");
        area.readOnly = true;
        area.style.cssText = "width:100%;min-height:200px;max-height:42vh;resize:vertical;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:8px;font:12px/1.5 monospace";

        const status = document.createElement("div");
        status.style.cssText = "font-size:11.5px;color:var(--muted);min-height:16px;word-break:break-word";

        const autoLabel = document.createElement("label");
        autoLabel.className = "check";
        const autoBox = document.createElement("input");
        autoBox.type = "checkbox";
        autoBox.checked = autoNext;
        autoBox.addEventListener("change", () => { autoNext = autoBox.checked; });
        const autoText = document.createElement("span");
        autoText.textContent = "复制后自动跳到下一段";
        autoLabel.append(autoBox, autoText);

        const row1 = document.createElement("div");
        row1.style.cssText = "display:flex;gap:6px";
        const prevBtn = document.createElement("button");
        prevBtn.className = "btn sm";
        prevBtn.type = "button";
        prevBtn.textContent = "◀ 上一段";
        const copyBtn = document.createElement("button");
        copyBtn.className = "btn primary";
        copyBtn.type = "button";
        const nextBtn = document.createElement("button");
        nextBtn.className = "btn sm";
        nextBtn.type = "button";
        nextBtn.textContent = "下一段 ▶";
        row1.append(prevBtn, copyBtn, nextBtn);

        const row2 = document.createElement("div");
        row2.style.cssText = "display:flex;gap:6px";
        const copyAllBtn = document.createElement("button");
        copyAllBtn.className = "btn";
        copyAllBtn.type = "button";
        copyAllBtn.textContent = "复制全部";
        const closeBtn = document.createElement("button");
        closeBtn.className = "btn sm";
        closeBtn.type = "button";
        closeBtn.textContent = "关闭";
        row2.append(copyAllBtn, closeBtn);

        function rebuildJump() {
            jump.textContent = "";
            segs.forEach((seg, i) => {
                const opt = document.createElement("option");
                opt.value = String(i);
                opt.textContent = `第 ${i + 1} 段${copied.has(i) ? " ✓" : ""}`;
                jump.append(opt);
            });
            jump.value = String(idx);
        }

        function render() {
            const total = segs.length;
            const seg = segs[idx] || "";
            area.value = seg;
            area.scrollTop = 0;
            progress.textContent = `第 ${idx + 1} / ${total} 段 · ${seg.length} 字${copied.has(idx) ? " · 已复制 ✓" : ""}`;
            copyBtn.textContent = total > 1 ? `复制第 ${idx + 1} 段` : "复制内容";
            prevBtn.disabled = idx <= 0;
            nextBtn.disabled = idx >= total - 1;
            jump.style.display = total > 1 ? "" : "none";
            autoLabel.style.display = total > 1 ? "" : "none";
            rebuildJump();
        }

        function go(i) {
            idx = Math.min(Math.max(i, 0), segs.length - 1);
            status.textContent = "";
            render();
        }

        refilter = () => {
            result = getOutputText() || result;
            segs = splitIntoSegments(result.text, state.segSize);
            copied.clear();
            idx = 0;
            hint.textContent = hintText();
            syncFilterEnabled();
            status.style.color = "var(--muted)";
            status.textContent = `已重新分为 ${segs.length} 段`;
            render();
        };

        sizeApply.addEventListener("click", () => {
            let v = parseInt(sizeInput.value, 10);
            if (!Number.isFinite(v)) v = SEG_SIZE_DEFAULT;
            v = Math.min(Math.max(v, SEG_SIZE_MIN), SEG_SIZE_MAX);
            sizeInput.value = String(v);
            state.segSize = v;
            try { localStorage.setItem(STORE_KEYS.segSize, String(v)); } catch (_) {}
            segs = splitIntoSegments(result.text, v);
            copied.clear();
            idx = 0;
            status.textContent = `已重新分为 ${segs.length} 段`;
            render();
        });
        prevBtn.addEventListener("click", () => go(idx - 1));
        nextBtn.addEventListener("click", () => go(idx + 1));
        jump.addEventListener("change", () => go(parseInt(jump.value, 10) || 0));

        copyBtn.addEventListener("click", async () => {
            const cur = idx;
            try {
                await writeClipboard(segs[cur]);
                copied.add(cur);
                const last = cur >= segs.length - 1;
                if (autoNext && !last) {
                    idx = cur + 1;
                    render();
                    status.textContent = `✅ 已复制第 ${cur + 1} 段，已切到第 ${idx + 1} 段`;
                } else {
                    render();
                    status.textContent = last && segs.length > 1
                        ? `✅ 已复制第 ${cur + 1} 段（最后一段）`
                        : `✅ 已复制第 ${cur + 1} 段`;
                }
                status.style.color = "var(--ok)";
            } catch (_) {
                status.textContent = "❌ 自动复制失败，请长按文本框手动全选复制";
                status.style.color = "var(--err)";
                area.focus();
                area.select();
            }
        });
        copyAllBtn.addEventListener("click", async () => {
            try {
                await writeClipboard(result.text);
                status.textContent = `✅ 已复制全部（${result.text.length} 字）`;
                status.style.color = "var(--ok)";
            } catch (_) {
                status.textContent = "❌ 复制失败，请使用分段复制";
                status.style.color = "var(--err)";
            }
        });
        closeBtn.addEventListener("click", () => overlay.remove());

        panel.append(heading, hint, filterBox, sizeRow, progRow, area, status, autoLabel, row1, row2);
        syncFilterEnabled();
        overlay.append(panel);
        overlay.addEventListener("click", event => { if (event.target === overlay) overlay.remove(); });
        root.append(overlay);
        render();
    }

    function trimFrame(f) {
        const o = Object.assign({}, f);
        for (const k of ["chunkBody", "responseBody"]) {
            if (typeof o[k] === "string") o[k] = o[k].slice(0, 30) + "…(" + f[k].length + "字)";
        }
        return JSON.stringify(o);
    }

    function buildDiagReport() {
        const c = state.replayCache;
        const L = ["缓存助手诊断 v1.0.9"];
        if (c) {
            L.push(`缓存：模型=${c.model || "-"} 状态=${c.status} 响应体=${c.body.length}字 ${fmtAge(c.ts)}`);
            L.push(c.frames ? `Executor 原帧：${c.frames.length} 帧（${c.kind}）` : "Executor 原帧：无（只能按原始响应体回传）");
            L.push("体开头：" + JSON.stringify(c.body.slice(0, 40)));
            L.push("体结尾：" + JSON.stringify(c.body.slice(-20)));
            if (c.frames && c.frames.length) {
                L.push("首帧：" + trimFrame(c.frames[0]));
                L.push("末帧：" + trimFrame(c.frames[c.frames.length - 1]));
            }
        } else {
            L.push("缓存：无");
        }
        L.push(`回传方式设置：${state.preferFrames ? "优先原帧" : "仅原始体"}　WS：${state.wsConnected ? "已连接" : "未连接"}`);
        L.push("--- 最近事件（旧→新）---");
        L.push(...(state.diag.length ? state.diag : ["（暂无）"]));
        return L.join("\n");
    }

    function showDiag() {
        const root = hostEl?.shadowRoot;
        if (!root) return;
        root.querySelector(".cache-viewer")?.remove();
        const overlay = document.createElement("div");
        overlay.className = "cache-viewer";
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:12px";
        const panel = document.createElement("div");
        panel.style.cssText = "width:min(620px,95vw);max-height:92vh;overflow:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px";
        const heading = document.createElement("strong");
        heading.textContent = "诊断信息";
        const hint = document.createElement("div");
        hint.style.cssText = "font-size:11px;color:var(--muted)";
        hint.textContent = "复制后发给我即可。里面只含帧结构和各 40 字内的片段，介意的话可手动删掉。";
        const area = document.createElement("textarea");
        area.readOnly = true;
        area.value = buildDiagReport();
        area.style.cssText = "width:100%;min-height:260px;max-height:55vh;resize:vertical;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:8px;font:11.5px/1.5 monospace";
        const status = document.createElement("div");
        status.style.cssText = "font-size:11.5px;color:var(--muted);min-height:16px";
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:6px";
        const copy = document.createElement("button");
        copy.className = "btn primary";
        copy.type = "button";
        copy.textContent = "复制诊断";
        copy.addEventListener("click", async () => {
            try {
                await writeClipboard(area.value);
                status.textContent = "✅ 已复制";
            } catch (_) {
                status.textContent = "❌ 复制失败，请长按文本框手动复制";
                area.focus();
                area.select();
            }
        });
        const refresh = document.createElement("button");
        refresh.className = "btn sm";
        refresh.type = "button";
        refresh.textContent = "刷新";
        refresh.addEventListener("click", () => { area.value = buildDiagReport(); status.textContent = ""; });
        const close = document.createElement("button");
        close.className = "btn sm";
        close.type = "button";
        close.textContent = "关闭";
        close.addEventListener("click", () => overlay.remove());
        row.append(copy, refresh, close);
        panel.append(heading, hint, area, status, row);
        overlay.append(panel);
        overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
        root.append(overlay);
    }

    function clearReplayCache() {
        state.replayCache = null;
        state.replayArmed = false;
        state.replayPending = null;
        try {
            localStorage.removeItem(STORE_KEYS.cache);
        } catch (_) {}
        void idbDeleteCache().catch(() => {});
        setNotice("缓存已清空", "info");
        updateUI();
    }

    function markSuppressed(requestId) {
        if (suppressedIds.has(requestId)) return;
        const timer = W.setTimeout(() => {
            suppressedIds.delete(requestId);
            pendingRequests.delete(requestId);
        }, REQUEST_TTL_MS);
        suppressedIds.set(requestId, timer);
    }

    function clearSuppressed(requestId) {
        const timer = suppressedIds.get(requestId);
        if (timer) W.clearTimeout(timer);
        suppressedIds.delete(requestId);
        pendingRequests.delete(requestId);
    }

    function prunePending() {
        const now = Date.now();
        for (const [rid, info] of pendingRequests.entries()) {
            if (now - info.ts > REQUEST_TTL_MS) pendingRequests.delete(rid);
        }
    }

    function trackRequest(rid, model, stream) {
        pendingRequests.set(rid, { model, stream, ts: Date.now() });
        outRecords.set(rid, { model, stream, frames: [], bytes: 0, ts: Date.now(), overflow: false, chunkCount: 0 });
        const now = Date.now();
        for (const [k, v] of outRecords.entries()) {
            if (now - v.ts > REQUEST_TTL_MS) outRecords.delete(k);
        }
    }

    // 录下 Executor 实际发给服务端的帧（含被“断线续收”丢弃的那些），回传时原样重放。
    function recordOutFrame(rid, msg) {
        const type = msg.type;
        if (type !== "stream-chunk" && type !== "stream-end" && type !== "response" &&
            type !== "error" && type !== "stream-error") return;
        const rec = outRecords.get(rid);
        if (!rec) return;
        const tag = String(rid).slice(0, 8);
        if (type === "error" || type === "stream-error") {
            diagLog(`→ ${type} ${tag}`);
            outRecords.delete(rid);
            return;
        }
        const piece = typeof msg.chunkBody === "string" ? msg.chunkBody
            : typeof msg.responseBody === "string" ? msg.responseBody : "";
        if (!rec.overflow) {
            rec.bytes += piece.length;
            if (rec.bytes > CACHE_MAX_MEM_BYTES) {
                rec.overflow = true;
                rec.frames = [];
            } else {
                const rest = Object.assign({}, msg);
                delete rest.requestId;
                rec.frames.push(rest);
            }
        }
        if (type === "stream-chunk") {
            rec.chunkCount++;
            if (rec.chunkCount === 1) diagLog(`→ stream-chunk ${tag}（首块 ${piece.length} 字）`);
            return;
        }
        diagLog(`→ ${type} ${tag} status=${msg.status} 共 ${rec.frames.length} 帧 ${rec.bytes} 字`);
        outRecords.delete(rid);
        if (rec.overflow) return;
        const status = Number(msg.status) || 200;
        if (status >= 400) return;
        let body;
        let kind = "stream";
        if (type === "response") {
            if (typeof msg.responseBody !== "string") return;
            body = msg.responseBody;
            kind = "response";
        } else {
            body = rec.frames
                .filter((f) => f.type === "stream-chunk" && typeof f.chunkBody === "string")
                .map((f) => f.chunkBody)
                .join("");
        }
        // 只缓存能解析出模型回复的响应，避免被模型列表等无关请求覆盖
        if (!body.trim() || !extractCachedText(body).parsed) return;
        void saveReplayCache(rec.model, body, status, { frames: rec.frames, kind });
    }

    // ==================== 1. Fetch 底层捕获（自动保存完整上游响应） ====================

    function wrapFetch(fn) {
        if (typeof fn !== "function" || fn.__pgCacheWrapped) return fn;
        const wrapped = function (input, init) {
            const url = typeof input === "string" ? input : (input && input.url) || "";
            const isGenerate = url.includes(GENERATE_MATCH);
            let reqModel = "";
            if (isGenerate && init && typeof init.body === "string") {
                try {
                    const parsed = JSON.parse(init.body);
                    if (Array.isArray(parsed) && typeof parsed[0] === "string") {
                        reqModel = parsed[0].replace(/^models\//, "");
                    }
                } catch (_) {}
            }

            const promise = fn.apply(this, arguments);
            if (isGenerate && promise && typeof promise.then === "function") {
                promise.then((resp) => {
                    if (!resp || !resp.ok) return;
                    let clone;
                    try {
                        clone = resp.clone();
                    } catch (_) {
                        return;
                    }
                    clone.text().then((text) => {
                        if (!text || !text.trim()) return;
                        const activeMeta = lastRequestMeta &&
                            (!state.replayPending || lastRequestMeta.requestId === state.replayPending.requestId)
                            ? lastRequestMeta : null;
                        const model = reqModel || (activeMeta && activeMeta.model) || "";
                        void saveReplayCache(model, text, resp.status || 200);
                    }).catch(() => {});
                }).catch(() => {});
            }
            return promise;
        };
        wrapped.__pgCacheWrapped = true;
        return wrapped;
    }

    // 无论本脚本与原脚本谁先注入，都确保捕获原脚本实际调用的底层 fetch
    function ensureFetchHook() {
        if (typeof W.fetch !== "function") return;
        if (W.fetch.__pgOriginal) {
            if (!W.fetch.__pgOriginal.__pgCacheWrapped) {
                W.fetch.__pgOriginal = wrapFetch(W.fetch.__pgOriginal);
            }
        } else if (!W.fetch.__pgCacheWrapped) {
            W.fetch = wrapFetch(W.fetch);
        }
    }

    // ==================== 2. WebSocket 拦截（一键缓存补发 + 断线续收） ====================

    const OrigWebSocket = W.WebSocket;

    async function sendWithBackpressure(ws, origSend, payload) {
        if (ws.readyState !== OrigWebSocket.OPEN) return false;
        while (ws.bufferedAmount > MAX_WS_BUFFERED) {
            if (ws.readyState !== OrigWebSocket.OPEN) return false;
            await sleep(10);
        }
        if (ws.readyState !== OrigWebSocket.OPEN) return false;
        origSend(JSON.stringify(payload));
        return true;
    }

    async function replayToServer(ws, origSend, requestId, stream) {
        const cache = state.replayCache;
        if (!cache || !cache.body) return;
        setNotice(`⚡ 正在回传缓存（${fmtBytes(cache.body.length)}）…`, "info");
        updateUI();
        const canUseFrames = state.preferFrames && Array.isArray(cache.frames) && cache.frames.length > 0 &&
            (cache.kind === "stream") === !!stream;
        diagLog(`↑ 开始回传 rid=${String(requestId).slice(0, 8)} 方式=${canUseFrames ? "原帧(" + cache.frames.length + "帧)" : "原始体"} 请求stream=${!!stream} 缓存kind=${cache.kind || "-"}`);
        try {
            if (canUseFrames) {
                for (const f of cache.frames) {
                    const ok = await sendWithBackpressure(ws, origSend, Object.assign({}, f, { requestId }));
                    if (!ok) throw new Error("连接已断开");
                }
            } else if (stream) {
                for (let i = 0; i < cache.body.length; i += STREAM_CHUNK_SIZE) {
                    const ok = await sendWithBackpressure(ws, origSend, {
                        type: "stream-chunk",
                        requestId,
                        chunkBody: cache.body.slice(i, i + STREAM_CHUNK_SIZE)
                    });
                    if (!ok) throw new Error("连接已断开");
                }
                const ok = await sendWithBackpressure(ws, origSend, {
                    type: "stream-end",
                    requestId,
                    status: cache.status || 200
                });
                if (!ok) throw new Error("连接已断开");
            } else {
                const ok = await sendWithBackpressure(ws, origSend, {
                    type: "response",
                    requestId,
                    status: cache.status || 200,
                    responseBody: cache.body
                });
                if (!ok) throw new Error("连接已断开");
            }
            pendingRequests.delete(requestId);
            diagLog("↑ 回传完成，等待服务端后续消息");
            setNotice(`✅ 已回传缓存（${fmtBytes(cache.body.length)}，${canUseFrames ? "按原帧" : "按原始体"}），开关已自动关闭`, "ok");
        } catch (err) {
            diagLog("↑ 回传失败：" + ((err && err.message) || err));
            setNotice(`❌ 回传失败：${(err && err.message) || err}（缓存已保留，可重试）`, "err");
        }
        updateUI();
    }

    function installWebSocketHook() {
        if (typeof OrigWebSocket !== "function" || OrigWebSocket.__pgCacheWrapped) return;

        function WrappedWebSocket(url, protocols) {
            const ws = protocols !== undefined
                ? new OrigWebSocket(url, protocols)
                : new OrigWebSocket(url);

            if (!WS_PATH_RE.test(String(url || ""))) {
                return ws;
            }

            // 连接建立时再次确保底层 fetch hook 就位
            ensureFetchHook();

            const origSend = ws.send.bind(ws);
            const origAdd = ws.addEventListener.bind(ws);
            const origRemove = ws.removeEventListener.bind(ws);

            let userOnMessage = null;
            const extraListeners = new Set();

            Object.defineProperty(ws, "onmessage", {
                configurable: true,
                enumerable: true,
                get() {
                    return userOnMessage;
                },
                set(fn) {
                    userOnMessage = typeof fn === "function" ? fn : null;
                }
            });

            ws.addEventListener = function (type, listener, options) {
                if (type === "message" && typeof listener === "function") {
                    extraListeners.add(listener);
                    return;
                }
                return origAdd(type, listener, options);
            };

            ws.removeEventListener = function (type, listener, options) {
                if (type === "message" && typeof listener === "function") {
                    extraListeners.delete(listener);
                    return;
                }
                return origRemove(type, listener, options);
            };

            origAdd("open", () => {
                state.wsConnected = true;
                updateUI();
            });

            origAdd("close", () => {
                state.wsConnected = false;
                updateUI();
            });

            origAdd("message", (event) => {
                let intercepted = false;
                if (typeof event.data === "string") {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg && msg.type === "request") {
                            prunePending();
                            const rid = String(msg.requestId || "").trim();
                            const stream = msg.stream === true;
                            const model = String(msg.model || "");
                            if (rid) {
                                lastRequestMeta = { requestId: rid, model, stream, ts: Date.now() };
                                diagLog(`← request ${rid.slice(0, 8)} model=${model} stream=${stream}${state.replayArmed ? " [补发已开启]" : ""}`);
                                if (state.replayArmed && state.replayCache) {
                                    // 在 Executor 收到 request 之前直接从 WS 回传缓存，
                                    // 不再依赖 fetch 包装层是否被 Executor 绕过。
                                    const cachedModel = normalizeModel(state.replayCache.model);
                                    const requestModel = normalizeModel(model);
                                    if (cachedModel && requestModel && cachedModel !== requestModel) {
                                        setNotice("⚠️ 当前请求模型 " + model + " 与缓存模型 " + state.replayCache.model + " 不一致，未补发；开关仍保持开启", "warn");
                                        trackRequest(rid, model, stream);
                                        updateUI();
                                    } else {
                                        state.replayArmed = false;
                                        intercepted = true;
                                        setNotice("⚡ 已拦截匹配请求，正在通过 WebSocket 回传原始缓存…", "info");
                                        updateUI();
                                        void replayToServer(ws, origSend, rid, stream);
                                    }
                                } else {
                                    trackRequest(rid, model, stream);
                                }
                            }
                        } else if (msg && msg.type === "cancel") {
                            const rid = String(msg.requestId || "").trim();
                            diagLog(`← cancel ${rid.slice(0, 8)}${suppressedIds.has(rid) ? "（已在续收）" : ""}`);
                            if (state.keepOnCancel && rid && pendingRequests.has(rid)) {
                                markSuppressed(rid);
                                intercepted = true;
                                setNotice("⏳ 客户端已取消，后台继续接收 Google 回复以写入缓存…", "warn");
                                updateUI();
                            }
                        } else if (msg && msg.type) {
                            diagLog("← " + msg.type + " " + String(msg.requestId || "").slice(0, 8));
                        }
                    } catch (_) {}
                }
                if (intercepted) return;
                if (userOnMessage) {
                    try {
                        userOnMessage.call(ws, event);
                    } catch (_) {}
                }
                for (const fn of extraListeners) {
                    try {
                        fn.call(ws, event);
                    } catch (_) {}
                }
            });

            ws.send = function (data) {
                if (typeof data === "string") {
                    try {
                        const msg = JSON.parse(data);
                        const rid = String((msg && msg.requestId) || "").trim();
                        const isTerminal = msg && (
                            msg.type === "stream-end" ||
                            msg.type === "response" ||
                            msg.type === "error" ||
                            msg.type === "stream-error"
                        );
                        if (rid && msg) recordOutFrame(rid, msg);
                        if (rid && suppressedIds.has(rid)) {
                            if (isTerminal) clearSuppressed(rid);
                            return; // 丢弃后台续收请求的回传，避免向服务端发送已取消的包
                        }
                        if (rid && isTerminal) {
                            pendingRequests.delete(rid);
                        }
                    } catch (_) {}
                }
                return origSend(data);
            };

            return ws;
        }

        WrappedWebSocket.CONNECTING = OrigWebSocket.CONNECTING;
        WrappedWebSocket.OPEN = OrigWebSocket.OPEN;
        WrappedWebSocket.CLOSING = OrigWebSocket.CLOSING;
        WrappedWebSocket.CLOSED = OrigWebSocket.CLOSED;
        WrappedWebSocket.prototype = OrigWebSocket.prototype;
        WrappedWebSocket.__pgCacheWrapped = true;

        W.WebSocket = WrappedWebSocket;
    }

    // ==================== 3. 轻量悬浮面板 UI（Shadow DOM，左下角不遮挡原面板） ====================

    const CSS = `
:host {
  all: initial;
  --bg: #ffffff;
  --card: #f4f4f6;
  --line: #dedee4;
  --fg: #18181b;
  --muted: #6b6b76;
  --accent: #2563eb;
  --accent-fg: #ffffff;
  --ok: #15803d;
  --warn: #b45309;
  --err: #dc2626;
  --shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  font-family: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 12px;
  line-height: 1.45;
  color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  :host {
    --bg: #141418;
    --card: #1e1e24;
    --line: #2e2e38;
    --fg: #f4f4f5;
    --muted: #a1a1aa;
    --accent: #3b82f6;
    --accent-fg: #ffffff;
    --ok: #4ade80;
    --warn: #facc15;
    --err: #f87171;
    --shadow: 0 10px 32px rgba(0, 0, 0, 0.5);
  }
}
:host([hidden]) { display: none !important; }
*, *::before, *::after { box-sizing: border-box; }
.box {
  width: 270px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: var(--shadow);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--card);
  border-bottom: 1px solid var(--line);
  cursor: grab;
  user-select: none;
  touch-action: none;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}
.dot.ok { background: var(--ok); }
.dot.armed { background: var(--accent); box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25); }
.title { font-weight: 650; font-size: 12.5px; flex: 1; }
.icon-btn {
  border: 0;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1;
}
.icon-btn:hover { background: var(--line); color: var(--fg); }
.body {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.meta {
  color: var(--muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.btn {
  flex: 1;
  height: 32px;
  padding: 0 10px;
  border-radius: 7px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--fg);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--muted); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
}
.btn.sm {
  flex: none;
  padding: 0 9px;
  font-weight: 500;
  color: var(--muted);
}
.check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 11.5px;
  cursor: pointer;
  user-select: none;
}
.check input { margin: 0; cursor: pointer; }
.notice {
  display: none;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--card);
  border-left: 3px solid var(--muted);
  font-size: 11.5px;
  word-break: break-word;
}
.notice.ok { border-color: var(--ok); color: var(--ok); }
.notice.warn { border-color: var(--warn); color: var(--warn); }
.notice.err { border-color: var(--err); color: var(--err); }
.notice.info { border-color: var(--accent); color: var(--fg); }
.pill {
  display: none;
  align-items: center;
  gap: 7px;
  padding: 7px 11px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--line);
  box-shadow: var(--shadow);
  font-weight: 600;
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  touch-action: none;
}
`;

    let hostEl = null;
    const ui = {};

    function el(tag, attrs, ...kids) {
        const node = document.createElement(tag);
        if (attrs) {
            for (const [k, v] of Object.entries(attrs)) {
                if (v == null || v === false) continue;
                if (k === "class") node.className = v;
                else if (k === "text") node.textContent = v;
                else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
                else node.setAttribute(k, v === true ? "" : String(v));
            }
        }
        for (const kid of kids) {
            if (kid != null) node.append(kid);
        }
        return node;
    }

    function setNotice(text, level = "info") {
        state.noticeText = text;
        state.noticeLevel = level;
        updateUI();
    }

    function clampPos(x, y) {
        const w = hostEl.offsetWidth || 270;
        const h = hostEl.offsetHeight || 120;
        const maxX = Math.max(8, W.innerWidth - w - 8);
        const maxY = Math.max(8, W.innerHeight - h - 8);
        return {
            x: Math.min(Math.max(x, 8), maxX),
            y: Math.min(Math.max(y, 8), maxY)
        };
    }

    function applyPos(x, y) {
        const pos = clampPos(x, y);
        hostEl.style.left = pos.x + "px";
        hostEl.style.top = pos.y + "px";
        hostEl.style.right = "auto";
        hostEl.style.bottom = "auto";
        return pos;
    }

    function bindDrag(handle, onTap) {
        let dragging = false;
        let moved = false;
        let sx = 0, sy = 0, ox = 0, oy = 0;

        handle.addEventListener("pointerdown", (e) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            if (e.target && e.target.closest && e.target.closest("button, input")) return;
            dragging = true;
            moved = false;
            sx = e.clientX;
            sy = e.clientY;
            const r = hostEl.getBoundingClientRect();
            ox = r.left;
            oy = r.top;
            try { handle.setPointerCapture(e.pointerId); } catch (_) {}
            handle.style.cursor = "grabbing";
        });

        handle.addEventListener("pointermove", (e) => {
            if (!dragging) return;
            const dx = e.clientX - sx;
            const dy = e.clientY - sy;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            moved = true;
            applyPos(ox + dx, oy + dy);
        });

        const end = (e, cancelled) => {
            if (!dragging) return;
            dragging = false;
            handle.style.cursor = "";
            try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
            if (moved) {
                const r = hostEl.getBoundingClientRect();
                const pos = applyPos(r.left, r.top);
                try { localStorage.setItem(STORE_KEYS.pos, JSON.stringify(pos)); } catch (_) {}
            } else if (!cancelled && onTap) {
                onTap();
            }
        };
        handle.addEventListener("pointerup", (e) => end(e, false));
        handle.addEventListener("pointercancel", (e) => end(e, true));
    }

    function setCollapsed(v) {
        state.collapsed = !!v;
        try { localStorage.setItem(STORE_KEYS.collapsed, String(state.collapsed)); } catch (_) {}
        if (ui.box) ui.box.style.display = state.collapsed ? "none" : "block";
        if (ui.pill) ui.pill.style.display = state.collapsed ? "flex" : "none";
        requestAnimationFrame(() => {
            if (!hostEl) return;
            const r = hostEl.getBoundingClientRect();
            applyPos(r.left, r.top);
        });
    }

    function buildUI() {
        if (hostEl || !isPromptsPage()) return;
        hostEl = document.createElement("div");
        hostEl.id = "pg-cache-companion-host";
        hostEl.style.cssText = "position:fixed;left:20px;bottom:20px;z-index:2147483600;";

        const shadow = hostEl.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = CSS;

        ui.pillDot = el("span", { class: "dot" });
        ui.pillText = el("span", { text: "缓存补发" });
        ui.pill = el("div", { class: "pill", title: "点击展开（可拖动）" }, ui.pillDot, ui.pillText);

        ui.headDot = el("span", { class: "dot" });
        const collapseBtn = el("button", {
            class: "icon-btn",
            type: "button",
            title: "收起",
            text: "–",
            onclick: () => setCollapsed(true)
        });
        ui.head = el("div", { class: "head" }, ui.headDot, el("span", { class: "title", text: "⚡ 缓存补发助手" }), collapseBtn);

        ui.meta = el("div", { class: "meta", text: "暂无缓存" });
        ui.replayBtn = el("button", {
            class: "btn",
            type: "button",
            text: "暂无缓存",
            onclick: () => {
                if (!state.replayCache) return;
                state.replayArmed = !state.replayArmed;
                if (state.replayArmed) {
                    setNotice("⚡ 已开启：在酒馆点重新生成，下个请求将直接吐出缓存", "info");
                } else {
                    setNotice("已取消补发，恢复正常请求", "info");
                }
                updateUI();
            }
        });
        ui.clearBtn = el("button", {
            class: "btn sm",
            type: "button",
            text: "清空",
            onclick: clearReplayCache
        });
        ui.diagBtn = el("button", {
            class: "btn sm",
            type: "button",
            text: "诊断",
            onclick: showDiag
        });
        ui.copyBtn = el("button", {
            class: "btn",
            type: "button",
            text: "复制全部",
            onclick: copyCachedText
        });
        ui.viewBtn = el("button", {
            class: "btn",
            type: "button",
            text: "分段复制",
            onclick: viewCachedText
        });

        ui.keepCheck = el("input", { type: "checkbox" });
        ui.keepCheck.checked = state.keepOnCancel;
        ui.keepCheck.addEventListener("change", () => {
            state.keepOnCancel = ui.keepCheck.checked;
            try { localStorage.setItem(STORE_KEYS.keepOnCancel, String(state.keepOnCancel)); } catch (_) {}
        });
        const keepRow = el(
            "label",
            {
                class: "check",
                title: "开启后，如果酒馆因延迟超时取消请求，本页会在后台继续把 Google 回复收完并存入缓存"
            },
            ui.keepCheck,
            el("span", { text: "断线续收（酒馆超时取消时仍收完缓存）" })
        );

        ui.frameCheck = el("input", { type: "checkbox" });
        ui.frameCheck.checked = state.preferFrames;
        ui.frameCheck.addEventListener("change", () => {
            state.preferFrames = ui.frameCheck.checked;
            try { localStorage.setItem(STORE_KEYS.preferFrames, String(state.preferFrames)); } catch (_) {}
        });
        const frameRow = el(
            "label",
            {
                class: "check",
                title: "开启后，回传时按 Executor 当初真实发给服务端的帧原样重放（格式最稳）；关闭则把响应体自行切块回传"
            },
            ui.frameCheck,
            el("span", { text: "回传时按 Executor 原帧回放（推荐）" })
        );

        ui.notice = el("div", { class: "notice" });

        ui.box = el(
            "div",
            { class: "box" },
            ui.head,
            el("div", { class: "body" }, ui.meta, el("div", { class: "row" }, ui.replayBtn, ui.clearBtn, ui.diagBtn),
                el("div", { class: "row" }, ui.copyBtn, ui.viewBtn), keepRow, frameRow, ui.notice)
        );

        shadow.append(style, ui.pill, ui.box);
        document.documentElement.appendChild(hostEl);

        bindDrag(ui.head);
        bindDrag(ui.pill, () => setCollapsed(false));

        try {
            const savedPos = JSON.parse(localStorage.getItem(STORE_KEYS.pos) || "null");
            if (savedPos && Number.isFinite(savedPos.x) && Number.isFinite(savedPos.y)) {
                applyPos(savedPos.x, savedPos.y);
            }
        } catch (_) {}

        W.addEventListener("resize", () => {
            if (!hostEl || hostEl.hidden) return;
            const r = hostEl.getBoundingClientRect();
            applyPos(r.left, r.top);
        });

        setCollapsed(state.collapsed);
        updateUI();
        W.setInterval(updateUI, 5000); // 定期刷新缓存耗时显示
    }

    function updateUI() {
        if (!hostEl) return;
        const c = state.replayCache;

        if (state.replayArmed) {
            ui.headDot.className = "dot armed";
            ui.pillDot.className = "dot armed";
            ui.pillText.textContent = "等待补发…";
            ui.replayBtn.disabled = false;
            ui.replayBtn.className = "btn primary";
            ui.replayBtn.textContent = "⚡ 已开启（点此取消）";
        } else if (c) {
            ui.headDot.className = "dot ok";
            ui.pillDot.className = "dot ok";
            ui.pillText.textContent = `已缓存 ${fmtBytes(c.body.length)}`;
            ui.replayBtn.disabled = false;
            ui.replayBtn.className = "btn";
            ui.replayBtn.textContent = "⚡ 下次请求返回缓存";
        } else {
            ui.headDot.className = "dot";
            ui.pillDot.className = "dot";
            ui.pillText.textContent = "缓存补发";
            ui.replayBtn.disabled = true;
            ui.replayBtn.className = "btn";
            ui.replayBtn.textContent = state.cacheLoading ? "正在读取缓存…" : "暂无缓存";
        }

        ui.clearBtn.disabled = !c;
        ui.copyBtn.disabled = !c;
        ui.viewBtn.disabled = !c;
        ui.meta.textContent = c
            ? `已缓存原始响应 ${fmtBytes(c.body.length)} · ${fmtAge(c.ts)}${c.model ? " · " + c.model : ""}${c.frames ? " · 含原帧" : ""}`
            : state.cacheLoading
                ? "正在读取持久化缓存…"
                : "暂无缓存（完整收到成功响应后自动保存最新一条）";
        if (state.cacheLoading) {
            ui.replayBtn.disabled = true;
            ui.clearBtn.disabled = true;
        }

        if (state.noticeText) {
            ui.notice.style.display = "block";
            ui.notice.className = "notice " + state.noticeLevel;
            ui.notice.textContent = state.noticeText;
        } else {
            ui.notice.style.display = "none";
        }
    }

    function syncVisibility() {
        const visible = isPromptsPage();
        if (visible && !hostEl && document.readyState !== "loading") buildUI();
        if (hostEl) hostEl.hidden = !visible;
    }

    function installRouteWatch() {
        for (const name of ["pushState", "replaceState"]) {
            const orig = W.history[name];
            if (typeof orig !== "function") continue;
            W.history[name] = function (...args) {
                const res = orig.apply(this, args);
                syncVisibility();
                return res;
            };
        }
        W.addEventListener("popstate", syncVisibility);
        W.addEventListener("hashchange", syncVisibility);
        W.navigation?.addEventListener("currententrychange", syncVisibility);
    }

    // ==================== 启动 ====================

    void loadPersistedState();
    ensureFetchHook();
    installWebSocketHook();
    installRouteWatch();

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            ensureFetchHook();
            buildUI();
        }, { once: true });
    } else {
        buildUI();
    }
})();