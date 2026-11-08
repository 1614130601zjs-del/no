const MODULE = 'st_text_replacer';
const DEFAULTS = { enabled: true, scopeTags: '', groups: [] };
const getContext = () => SillyTavern.getContext();
const clone = value => JSON.parse(JSON.stringify(value));

function settings() {
    const root = getContext().extensionSettings;
    if (!root[MODULE]) root[MODULE] = clone(DEFAULTS);
    const cfg = root[MODULE];
    for (const [key, value] of Object.entries(DEFAULTS)) if (!(key in cfg)) cfg[key] = clone(value);
    if (!Array.isArray(cfg.groups)) cfg.groups = [];
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
        if (c === '*') { out += '[^\\s，。！？、,.!?;；:：]{0,15}?'; continue; }
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
    let output = '', count = 0, cursor = 0;
    while (cursor < source.length) {
        const open = source.indexOf('<', cursor), stop = open < 0 ? source.length : open;
        const chunk = source.slice(cursor, stop);
        const protectedBlock = stack.some(tag => raw.has(tag));
        const inScope = !scopes.length || stack.some(tag => scopes.includes(tag));
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
            else if (!empty) stack.push(tag);
        }
        cursor = end;
    }
    return { text: output, count };
}
function processMessage(message) {
    const cfg = settings();
    if (!cfg.enabled || !message || message.is_user || message.is_system || !message.mes) return 0;
    const r = cleanHtml(message.mes, cfg);
    if (r.count && r.text !== message.mes) { message.mes = r.text; return r.count; }
    return 0;
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
      <div class="str-toolbar"><button id="str-add-group" class="menu_button">新建规则合集</button><button id="str-export" class="menu_button">导出规则</button><button id="str-import" class="menu_button">导入规则</button><button id="str-clean-last" class="menu_button">净化最新楼层</button><input id="str-file" type="file" accept="application/json" hidden></div>
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
    $('#str-export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify({ version: 2, groups: settings().groups, scopeTags: settings().scopeTags }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = '文字净化规则.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    $('#str-import').addEventListener('click', () => $('#str-file').click());
    $('#str-file').addEventListener('change', async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try {
            const data = JSON.parse(await file.text()); if (!Array.isArray(data.groups)) throw new Error('文件中没有 groups 规则合集');
            settings().groups = data.groups.filter(g => g && Array.isArray(g.subRules)).map(g => ({
                id: g.id || crypto.randomUUID(), name: String(g.name || '导入合集'), enabled: g.enabled !== false,
                subRules: g.subRules.filter(s => s && Array.isArray(s.targets)).map(s => ({
                    id: s.id || crypto.randomUUID(), name: String(s.name || '未命名规则'), enabled: s.enabled !== false,
                    mode: ['text', 'simple', 'regex'].includes(s.mode) ? s.mode : 'text',
                    targets: s.targets.map(String), replacements: Array.isArray(s.replacements) ? s.replacements.map(String) : [], flags: s.flags || 'gimu'
                }))
            }));
            if (typeof data.scopeTags === 'string') settings().scopeTags = data.scopeTags;
            persist(); renderPanel(panel); $('#str-status').textContent = '规则合集已导入。';
        } catch (err) { $('#str-status').textContent = '导入失败：' + err.message; }
        e.target.value = '';
    });
    $('#str-clean-last').addEventListener('click', async () => {
        const ctx = getContext(), index = ctx.chat.length - 1, msg = ctx.chat[index], count = processMessage(msg);
        if (count) {
            if (typeof ctx.saveChat === 'function') await ctx.saveChat();
            if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(index, msg);
            $('#str-status').textContent = '最新楼层已替换 ' + count + ' 处。';
        } else $('#str-status').textContent = '最新楼层没有命中规则。';
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
function initialize() {
    settings(); mountPanel();
    const { eventSource, event_types } = getContext();
    eventSource.on(event_types.MESSAGE_RECEIVED, async messageId => {
        const ctx = getContext(), msg = ctx.chat?.[Number(messageId)], count = processMessage(msg);
        if (count && typeof ctx.saveChat === 'function') await ctx.saveChat();
    });
}
const { eventSource, event_types } = getContext();
eventSource.on(event_types.APP_READY, initialize);
