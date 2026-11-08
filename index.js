const MODULE = 'st_text_replacer';
const DEFAULTS = { enabled: true, scopeTags: 'content', groups: [], presets: {}, activePreset: '' };
const getContext = () => SillyTavern.getContext();
const clone = value => JSON.parse(JSON.stringify(value));

function settings() {
    const root = getContext().extensionSettings;
    if (!root[MODULE]) root[MODULE] = clone(DEFAULTS);
    const cfg = root[MODULE];
    for (const [key, value] of Object.entries(DEFAULTS)) if (!(key in cfg)) cfg[key] = clone(value);
    if (!Array.isArray(cfg.groups)) cfg.groups = [];
    if (!cfg.presets || typeof cfg.presets !== 'object' || Array.isArray(cfg.presets)) cfg.presets = {};
    if (typeof cfg.activePreset !== 'string') cfg.activePreset = '';
    if (Array.isArray(cfg.rules) && cfg.rules.length) {
        cfg.groups.push({
            id: crypto.randomUUID(), name: '已迁移规则', enabled: true,
            subRules: cfg.rules.filter(r => r && typeof r.find === 'string').map(r => ({
                id: r.id || crypto.randomUUID(), name: r.name || r.find, enabled: r.enabled !== false,
                mode: r.regex ? 'regex' : 'text', targets: [r.find],
                replacements: [String(r.replace ?? '')], flags: r.flags || 'gi',
            })),
        });
        delete cfg.rules;
    }
    return cfg;
}
function persist() { getContext().saveSettingsDebounced(); }
function escapeRegex(value) { return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function simplePattern(source) {
    let out = '';
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === '*') { out += '[^，。！？、,.!?;；:：]{0,15}?'; continue; }
        if (c === '{') {
            const end = source.indexOf('}', i + 1);
            if (end > i) {
                const choices = source.slice(i + 1, end).split(/[,，]/).map(x => x.trim()).filter(Boolean);
                if (choices.length) { out += '(?:' + choices.map(escapeRegex).join('|') + ')'; i = end; continue; }
            }
        }
        out += escapeRegex(c);
    }
    return out;
}
function compileSubRule(sub) {
    const mode = ['text', 'simple', 'regex'].includes(sub.mode) ? sub.mode : 'text';
    const replacements = Array.isArray(sub.replacements) ? sub.replacements.map(x => String(x ?? '')) : [];
    const baseFlags = [...new Set(String(sub.flags || 'gimu').replace(/[^dgimsuvy]/g, '').replace(/[gy]/g, '') + 'gmu')].join('');
    const result = [];
    for (const target of (sub.targets || []).map(String).filter(Boolean).sort((a, b) => b.length - a.length)) {
        try {
            let source = mode === 'text' ? escapeRegex(target) : mode === 'simple' ? simplePattern(target) : target;
            let flags = baseFlags;
            if (mode === 'regex' && target.startsWith('/')) {
                const last = target.lastIndexOf('/');
                if (last > 0) { source = target.slice(1, last); flags = [...new Set((target.slice(last + 1).replace(/[^dgimsuvy]/g, '') + 'g').split(''))].join(''); }
            }
            const regex = new RegExp(source, flags);
            if (regex.test('')) throw new Error('规则会匹配空字符串');
            result.push({ regex, replacements, target });
        } catch (error) { console.warn('[文字净化] 跳过无效规则：', target, error); }
    }
    return result;
}
function buildProcessors(cfg) {
    const out = [];
    for (const group of cfg.groups) {
        if (group.enabled === false) continue;
        for (const sub of group.subRules || []) if (sub && sub.enabled !== false) out.push(...compileSubRule(sub));
    }
    return out;
}
function pickReplacement(values) {
    return values.length ? values[Math.floor(Math.random() * values.length)] : '';
}
function replacementText(template, args) {
    const captures = args.slice(1, -2);
    return String(template ?? '').replace(/\$(\d{1,2})/g, (_, n) => captures[Number(n) - 1] ?? '');
}
function applyText(source, processors) {
    let text = source, count = 0;
    for (const p of processors) text = text.replace(p.regex, (...args) => {
        count++;
        return replacementText(pickReplacement(p.replacements), args);
    });
    return { text, count };
}
function tagEnd(source, start) {
    let quote = '';
    for (let i = start + 1; i < source.length; i++) {
        const c = source[i];
        if (quote) { if (c === quote) quote = ''; }
        else if (c === '"' || c === "'") quote = c;
        else if (c === '>') return i + 1;
    }
    return source.length;
}
function cleanHtml(html, cfg) {
    const source = String(html ?? ''), processors = buildProcessors(cfg);
    if (!source || !processors.length) return { text: source, count: 0 };
    const scopes = String(cfg.scopeTags || '').toLowerCase().split(/[\s,，]+/).map(x => x.replace(/[<>/]/g, '')).filter(Boolean);
    const raw = new Set(['script', 'style', 'textarea', 'pre', 'code']);
    const stack = [];
    let output = '', count = 0, cursor = 0, scopeFound = scopes.length === 0;
    while (cursor < source.length) {
        const open = source.indexOf('<', cursor), stop = open < 0 ? source.length : open;
        const chunk = source.slice(cursor, stop);
        const protectedBlock = stack.some(tag => raw.has(tag));
        const inScope = !scopes.length || stack.some(tag => scopes.includes(tag));
        if (inScope && scopes.length) scopeFound = true;
        if (chunk && !protectedBlock && inScope) {
            const r = applyText(chunk, processors); output += r.text; count += r.count;
        } else output += chunk;
        if (open < 0) break;
        if (source.startsWith('<!--', open)) {
            const comment = source.indexOf('-->', open + 4), end = comment < 0 ? source.length : comment + 3;
            output += source.slice(open, end); cursor = end; continue;
        }
        const end = tagEnd(source, open), token = source.slice(open, end);
        output += token;
        const m = token.match(/^<\s*(\/?)\s*([a-zA-Z][\w:-]*)\b/);
        if (m) {
            const closing = !!m[1], tag = m[2].toLowerCase();
            const empty = /\/\s*>$/.test(token) || /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i.test(tag);
            if (closing) { const i = stack.lastIndexOf(tag); if (i >= 0) stack.splice(i); }
            else if (!empty) {
                stack.push(tag);
                if (scopes.includes(tag)) scopeFound = true;
            }
        }
        cursor = end;
    }
    return { text: output, count, scopeFound, processorCount: processors.length };
}
function processMessage(message, { manual = false } = {}) {
    const cfg = settings();
    if (!manual && !cfg.enabled) return { count: 0, reason: 'disabled' };
    if (!message || message.is_system || (!manual && message.is_user) || typeof message.mes !== 'string') {
        return { count: 0, reason: 'invalid-message' };
    }
    const result = cleanHtml(message.mes, cfg);
    if (result.count && result.text !== message.mes) message.mes = result.text;
    return result;
}

function normalizePresetGroups(payload) {
    let value = payload;
    for (let i = 0; i < 3 && value && !Array.isArray(value); i++) {
        if (Array.isArray(value.groups)) { value = value.groups; break; }
        if (Array.isArray(value.rules)) { value = value.rules; break; }
        if (value.__content__ !== undefined) { value = value.__content__; continue; }
        if (value.content !== undefined) { value = value.content; continue; }
        break;
    }
    if (!Array.isArray(value) && value && typeof value === 'object') {
        const numeric = Object.keys(value).filter(k => /^\d+$/.test(k)).sort((a,b) => Number(a)-Number(b));
        if (numeric.length) value = numeric.map(k => value[k]);
    }
    if (!Array.isArray(value)) throw new Error('没有找到规则合集数组（rules/groups）');
    const groups = value.map((group, gi) => {
        if (!group || typeof group !== 'object') return null;
        const sourceSubs = Array.isArray(group.subRules) ? group.subRules
            : Array.isArray(group.targets) ? [{ targets: group.targets, replacements: group.replacements, mode: group.mode }]
            : [];
        const subRules = sourceSubs.filter(sub => sub && sub.rewriteMode !== 'ai').map((sub, si) => {
            if (!sub || typeof sub !== 'object') return null;
            return {
                id: String(sub.id || crypto.randomUUID()),
                name: String(sub.name || ('子规则 ' + (si + 1))),
                enabled: sub.enabled !== false,
                mode: ['text', 'simple', 'regex'].includes(sub.mode) ? sub.mode : 'text',
                targets: Array.isArray(sub.targets) ? sub.targets.map(String).filter(Boolean) : [],
                replacements: Array.isArray(sub.replacements) ? sub.replacements.map(v => String(v ?? '')) : [],
                flags: sub.flags || 'gimu'
            };
        }).filter(Boolean);
        return {
            id: String(group.id || crypto.randomUUID()),
            name: String(group.name || ('规则合集 ' + (gi + 1))),
            enabled: group.enabled !== false,
            subRules
        };
    }).filter(Boolean);
    if (!groups.length) throw new Error('预设中没有可用的规则合集');
    return groups;
}
function uniquePresetName(baseName, presets) {
    const base = String(baseName || '').trim() || '导入预设';
    if (!presets[base]) return base;
    let n = 2;
    while (presets[base + ' (' + n + ')']) n++;
    return base + ' (' + n + ')';
}
function refreshPresetSelect(panel) {
    const select = panel.querySelector('#str-preset-select');
    if (!select) return;
    const cfg = settings(), current = cfg.activePreset || '';
    select.replaceChildren(new Option('当前临时规则', ''));
    for (const name of Object.keys(cfg.presets).sort((a,b) => a.localeCompare(b))) select.add(new Option(name, name));
    select.value = current;
}

function button(label, action, id) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'menu_button';
    b.textContent = label; b.dataset.action = action; if (id) b.dataset.id = id; return b;
}
function mountPanel() {
    if (document.getElementById('str-panel')) return;
    const host = document.querySelector('#extensions_settings'); if (!host) return;
    const panel = document.createElement('section'); panel.id = 'str-panel'; panel.className = 'extension-settings-block';
    panel.innerHTML = `
      <div class="str-head"><div><b>文字净化</b><small>规则直接替换，不调用 AI</small></div><label><input id="str-enabled" type="checkbox"> 自动净化</label></div>
      <div class="str-scope"><label for="str-scope">只处理指定标签内的正文（留空处理全部正文文本）</label><input id="str-scope" placeholder="例如 content，可填写多个标签"></div>
      <div class="str-presetbar"><label>规则预设 <select id="str-preset-select"><option value="">当前临时规则</option></select></label><button id="str-save-preset" class="menu_button">保存为预设</button><button id="str-delete-preset" class="menu_button">删除预设</button></div>
      <div class="str-toolbar"><button id="str-add-group" class="menu_button">新建规则合集</button><button id="str-export" class="menu_button">导出预设</button><button id="str-import" class="menu_button">导入预设</button><button id="str-clean-last" class="menu_button">净化最新楼层</button><input id="str-file" type="file" accept="application/json,.json" hidden></div>
      <div id="str-editor" class="str-editor" hidden><b>子规则编辑</b><input id="str-name" placeholder="规则名称"><select id="str-mode"><option value="text">普通文本</option><option value="simple">简易通配（*、{A,B}）</option><option value="regex">正则表达式</option></select><textarea id="str-targets" rows="3" placeholder="匹配内容：每行一条"></textarea><textarea id="str-replacements" rows="3" placeholder="替换候选：每行一条；留空表示删除"></textarea><div class="str-editor-options"><label><input id="str-case" type="checkbox"> 区分大小写</label><button id="str-save" class="menu_button">保存子规则</button><button id="str-cancel" class="menu_button">取消</button></div><small>正则替换支持 $1、$2 捕获组；多个候选随机选择。</small></div>
      <div id="str-groups"></div><div id="str-status" class="str-status">HTML 标签、属性、注释及代码块不会被替换。</div>`;
    host.append(panel); bindPanel(panel); renderPanel(panel);
}
function bindPanel(panel) {
    const $ = s => panel.querySelector(s); let editing = null;
    $('#str-enabled').addEventListener('change', e => { settings().enabled = e.target.checked; persist(); });
    $('#str-scope').addEventListener('change', e => { settings().scopeTags = e.target.value.trim(); persist(); });
    $('#str-add-group').addEventListener('click', () => {
        const name = prompt('规则合集名称', '新规则合集'); if (!name?.trim()) return;
        settings().groups.push({ id: crypto.randomUUID(), name: name.trim(), enabled: true, subRules: [] });
        persist(); renderPanel(panel);
    });
    $('#str-cancel').addEventListener('click', () => { editing = null; $('#str-editor').hidden = true; });
    $('#str-save').addEventListener('click', () => {
        const targets = $('#str-targets').value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        if (!targets.length) { $('#str-status').textContent = '请至少填写一条匹配内容。'; return; }
        const mode = $('#str-mode').value;
        if (mode === 'regex') for (const t of targets) {
            try {
                const source = t.startsWith('/') && t.lastIndexOf('/') > 0 ? t.slice(1, t.lastIndexOf('/')) : t;
                const re = new RegExp(source, 'gmu'); if (re.test('')) throw new Error('会匹配空字符串');
            } catch (e) { $('#str-status').textContent = '正则无效：' + t + '（' + e.message + '）'; return; }
        }
        const group = settings().groups.find(g => g.id === editing.groupId); if (!group) return;
        const replacementRaw = $('#str-replacements').value;
        const next = { id: editing.ruleId || crypto.randomUUID(), name: $('#str-name').value.trim() || '未命名规则',
            enabled: true, mode, targets, replacements: replacementRaw === '' ? [] : replacementRaw.split(/\r?\n/).map(x => x.replace(/\\r/g, '')),
            flags: $('#str-case').checked ? 'gmu' : 'gimu' };
        const i = group.subRules.findIndex(r => r.id === editing.ruleId);
        if (i >= 0) group.subRules[i] = next; else group.subRules.push(next);
        persist(); editing = null; $('#str-editor').hidden = true; renderPanel(panel); $('#str-status').textContent = '规则已保存。';
    });
    $('#str-preset-select').addEventListener('change', e => {
        const cfg = settings(), name = e.target.value;
        if (name && !cfg.presets[name]) { refreshPresetSelect(panel); return; }
        if (cfg.activePreset && cfg.presets[cfg.activePreset] &&
            JSON.stringify(cfg.groups) !== JSON.stringify(cfg.presets[cfg.activePreset])) {
            if (!confirm('当前预设「' + cfg.activePreset + '」有未保存改动，切换前要保存吗？')) {
                e.target.value = cfg.activePreset; return;
            }
            cfg.presets[cfg.activePreset] = clone(cfg.groups);
        }
        cfg.activePreset = name;
        if (name) cfg.groups = clone(cfg.presets[name]);
        persist(); renderPanel(panel);
        $('#str-status').textContent = name ? ('已切换到预设「' + name + '」。') : '已切换到临时规则。';
    });
    $('#str-save-preset').addEventListener('click', () => {
        const cfg = settings(), suggested = cfg.activePreset || '我的规则预设';
        const raw = prompt('预设名称', suggested);
        if (!raw || !raw.trim()) return;
        const name = raw.trim();
        if (cfg.presets[name] && name !== cfg.activePreset && !confirm('预设「' + name + '」已存在，是否覆盖？')) return;
        cfg.presets[name] = clone(cfg.groups); cfg.activePreset = name;
        persist(); renderPanel(panel); $('#str-status').textContent = '已保存预设「' + name + '」。';
    });
    $('#str-delete-preset').addEventListener('click', () => {
        const cfg = settings(), name = cfg.activePreset;
        if (!name || !cfg.presets[name]) { $('#str-status').textContent = '请先选择一个已保存的预设。'; return; }
        if (!confirm('确定删除预设「' + name + '」？当前规则会保留为临时规则。')) return;
        delete cfg.presets[name]; cfg.activePreset = '';
        persist(); renderPanel(panel); $('#str-status').textContent = '已删除预设「' + name + '」，当前规则保留。';
    });
    $('#str-export').addEventListener('click', () => {
        const cfg = settings(), name = cfg.activePreset || '文字净化预设';
        const payload = { type: 'veridis-rewrite-preset', version: 2, name, rules: clone(cfg.groups) };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $('#str-import').addEventListener('click', () => $('#str-file').click());
    $('#str-file').addEventListener('change', async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try {
            const data = JSON.parse(await file.text()), groups = normalizePresetGroups(data), cfg = settings();
            const baseName = data?.name || file.name.replace(/\.json$/i, '') || '导入预设';
            const name = uniquePresetName(baseName, cfg.presets);
            cfg.presets[name] = groups;
            persist(); renderPanel(panel);
            $('#str-status').textContent = '已导入「' + name + '」，共 ' + groups.length + ' 个规则合集；当前规则未被替换，可在预设列表中切换。';
        } catch (err) { $('#str-status').textContent = '导入失败：' + err.message; }
        e.target.value = '';
    });
    $('#str-clean-last').addEventListener('click', async () => {
        const ctx = getContext(), index = ctx.chat.length - 1, msg = ctx.chat[index];
        if (!msg) { $('#str-status').textContent = '当前聊天没有可处理的楼层。'; return; }
        const result = processMessage(msg, { manual: true });
        if (result.count) {
            if (typeof ctx.saveChat === 'function') await ctx.saveChat();
            if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(index, msg);
            $('#str-status').textContent = '最新楼层已替换 ' + result.count + ' 处。';
        } else if (!result.processorCount) {
            $('#str-status').textContent = '没有可执行的子规则：请检查合集和子规则是否启用。';
        } else if (String(settings().scopeTags || '').trim() && !result.scopeFound) {
            $('#str-status').textContent = '没有找到作用范围标签「' + settings().scopeTags + '」；请检查正文标签，或暂时清空作用范围测试。';
        } else {
            $('#str-status').textContent = '已找到处理范围，但没有匹配到规则。请检查匹配文本是否与楼层正文一致。';
        }
    });
    $('#str-groups').addEventListener('click', e => {
        const b = e.target.closest('button[data-action]'); if (!b) return;
        const cfg = settings(), group = cfg.groups.find(g => g.id === b.dataset.group); if (!group) return;
        const rule = (group.subRules || []).find(r => r.id === b.dataset.id);
        switch (b.dataset.action) {
            case 'toggle-group': group.enabled = !group.enabled; break;
            case 'rename-group': { const name = prompt('修改合集名称', group.name); if (name?.trim()) group.name = name.trim(); break; }
            case 'delete-group': if (confirm('删除整个规则合集及其中的子规则？')) cfg.groups = cfg.groups.filter(g => g.id !== group.id); else return; break;
            case 'add-rule':
                editing = { groupId: group.id, ruleId: null }; $('#str-name').value = ''; $('#str-mode').value = 'text';
                $('#str-targets').value = ''; $('#str-replacements').value = ''; $('#str-case').checked = false; $('#str-editor').hidden = false; break;
            case 'toggle-rule': if (rule) rule.enabled = !rule.enabled; break;
            case 'edit-rule':
                if (!rule) return; editing = { groupId: group.id, ruleId: rule.id };
                $('#str-name').value = rule.name || ''; $('#str-mode').value = rule.mode || 'text';
                $('#str-targets').value = (rule.targets || []).join('\\n'); $('#str-replacements').value = (rule.replacements || []).join('\\n');
                $('#str-case').checked = !(rule.flags || 'gimu').includes('i'); $('#str-editor').hidden = false; break;
            case 'delete-rule': if (rule && confirm('删除这条子规则？')) group.subRules = group.subRules.filter(r => r.id !== rule.id); break;
            default: return;
        }
        persist(); renderPanel(panel);
    });
}
function renderPanel(panel) {
    const cfg = settings(); panel.querySelector('#str-enabled').checked = cfg.enabled;
    panel.querySelector('#str-scope').value = cfg.scopeTags || '';
    refreshPresetSelect(panel);
    const host = panel.querySelector('#str-groups'); host.replaceChildren();
    if (!cfg.groups.length) { const empty = document.createElement('div'); empty.className = 'str-empty'; empty.textContent = '还没有规则合集，先新建一个合集。'; host.append(empty); return; }
    for (const group of cfg.groups) {
        const section = document.createElement('section'); section.className = 'str-group';
        const head = document.createElement('div'); head.className = 'str-group-head';
        const title = document.createElement('b'); title.textContent = group.name || '未命名合集';
        const actions = document.createElement('div'); actions.className = 'str-actions';
        actions.append(button(group.enabled === false ? '合集已停用' : '合集已启用', 'toggle-group'),
            button('添加子规则', 'add-rule'), button('改名', 'rename-group'), button('删除合集', 'delete-group'));
        for (const b of actions.children) b.dataset.group = group.id;
        head.append(title, actions); section.append(head);
        const rows = document.createElement('div'); rows.className = 'str-subrules';
        for (const rule of group.subRules || []) {
            const row = document.createElement('div'); row.className = 'str-subrule';
            const info = document.createElement('div'); info.className = 'str-subrule-info';
            const name = document.createElement('b'); name.textContent = rule.name || '未命名规则';
            const detail = document.createElement('small');
            const mode = rule.mode === 'regex' ? '正则' : rule.mode === 'simple' ? '简易通配' : '普通文本';
            detail.textContent = mode + ' · ' + (rule.targets || []).join(' / ') + ' → ' + ((rule.replacements || []).length ? rule.replacements.join(' / ') : '直接删除');
            info.append(name, detail);
            const controls = document.createElement('div'); controls.className = 'str-actions';
            controls.append(button(rule.enabled === false ? '已停用' : '已启用', 'toggle-rule', rule.id),
                button('编辑', 'edit-rule', rule.id), button('删除', 'delete-rule', rule.id));
            for (const b of controls.children) b.dataset.group = group.id;
            row.append(info, controls); rows.append(row);
        }
        if (!(group.subRules || []).length) { const empty = document.createElement('small'); empty.className = 'str-empty'; empty.textContent = '这个合集还没有子规则。'; rows.append(empty); }
        section.append(rows); host.append(section);
    }
}
function mountWandEntry() {
    if (document.getElementById('str-wand-entry')) return;
    const container = document.querySelector('#token_counter_wand_container') ||
        document.querySelector('#extensionsMenu');
    if (!container) return;
    const entry = document.createElement('div');
    entry.id = 'str-wand-entry';
    entry.className = 'list-group-item flex-container flexGap5';
    entry.innerHTML = '<div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div><span>文字净化</span>';
    entry.title = '打开文字净化规则与预设';
    entry.addEventListener('click', () => {
        const settingsButton = document.querySelector('#extensions_settings_button');
        if (settingsButton) settingsButton.click();
        const reveal = () => {
            const panel = document.getElementById('str-panel');
            if (panel) {
                panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
                panel.classList.add('str-panel-highlight');
                setTimeout(() => panel.classList.remove('str-panel-highlight'), 1200);
            }
        };
        requestAnimationFrame(() => requestAnimationFrame(reveal));
    });
    container.append(entry);
}
function initialize() {
    settings(); mountPanel(); mountWandEntry();
    const { eventSource, event_types } = getContext();
    eventSource.on(event_types.MESSAGE_RECEIVED, async messageId => {
        const ctx = getContext(), msg = ctx.chat?.[Number(messageId)], result = processMessage(msg);
        if (result.count && typeof ctx.saveChat === 'function') await ctx.saveChat();
    });
}
const { eventSource, event_types } = getContext();
eventSource.on(event_types.APP_READY, initialize);
