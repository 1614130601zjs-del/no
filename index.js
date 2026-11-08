import { extension_settings } from '../../../extensions.js';

const MODULE = 'st_text_replacer';
const DEFAULTS = {
    enabled: true,
    rules: [],
    applyToHistorical: true,
};

const getContext = () => SillyTavern.getContext();
const clone = value => JSON.parse(JSON.stringify(value));

function settings() {
    const root = getContext().extensionSettings;
    if (!root[MODULE]) root[MODULE] = clone(DEFAULTS);
    const current = root[MODULE];
    for (const [key, value] of Object.entries(DEFAULTS)) {
        if (!(key in current)) current[key] = clone(value);
    }
    return current;
}

function persist() {
    getContext().saveSettingsDebounced();
}

function applyRules(source, rules) {
    let result = String(source ?? '');
    let count = 0;
    for (const rule of rules) {
        if (!rule.enabled || !rule.find) continue;
        try {
            if (rule.regex) {
                const flags = [...new Set((rule.flags || 'g').replace(/[^gimsuy]/g, '').split(''))].join('');
                const re = new RegExp(rule.find, flags.includes('g') ? flags : flags + 'g');
                result = result.replace(re, (...args) => {
                    count++;
                    return rule.replace ?? '';
                });
            } else {
                const parts = result.split(rule.find);
                if (parts.length > 1) {
                    count += parts.length - 1;
                    result = parts.join(rule.replace ?? '');
                }
            }
        } catch (error) {
            console.warn('[文字净化] 无效规则：', rule.name || rule.find, error);
        }
    }
    return { text: result, count };
}

// Only edit visible text chunks. HTML tags, attributes, comments and script/style blocks remain untouched.
function cleanHtml(html, rules) {
    const chunks = String(html ?? '').split(/(<(?:!--[\s\S]*?--|[^>]+)>)/g);
    let count = 0;
    let inRawBlock = false;
    const output = chunks.map(chunk => {
        if (!chunk) return chunk;
        if (/^<(script|style|textarea|pre|code)\b/i.test(chunk)) inRawBlock = true;
        if (/^<\/(script|style|textarea|pre|code)\s*>/i.test(chunk)) {
            inRawBlock = false;
            return chunk;
        }
        if (chunk.startsWith('<') || inRawBlock) return chunk;
        const cleaned = applyRules(chunk, rules);
        count += cleaned.count;
        return cleaned.text;
    }).join('');
    return { text: output, count };
}

function processMessage(message) {
    const cfg = settings();
    if (!cfg.enabled || !message || message.is_user || message.is_system || !message.mes) return 0;
    const result = cleanHtml(message.mes, cfg.rules);
    if (result.count && result.text !== message.mes) {
        message.mes = result.text;
        return result.count;
    }
    return 0;
}

function addStylesAndPanel() {
    if (document.getElementById('str-panel')) return;
    const host = document.querySelector('#extensions_settings');
    if (!host) return;
    const panel = document.createElement('section');
    panel.id = 'str-panel';
    panel.className = 'extension-settings-block';
    panel.innerHTML = `
      <div class="str-head">
        <div><b>文字净化</b><small>直接替换，不调用 AI</small></div>
        <label class="str-toggle"><input id="str-enabled" type="checkbox"><span>自动净化</span></label>
      </div>
      <div class="str-toolbar">
        <button id="str-add" class="menu_button">添加规则</button>
        <button id="str-export" class="menu_button">导出</button>
        <button id="str-import" class="menu_button">导入</button>
        <button id="str-clean-last" class="menu_button">净化最新楼层</button>
        <input id="str-import-file" type="file" accept="application/json" hidden>
      </div>
      <div id="str-editor" class="str-editor" hidden>
        <input id="str-name" placeholder="规则名称（可选）">
        <input id="str-find" placeholder="要查找的文字 / 正则表达式">
        <input id="str-replace" placeholder="替换为（留空表示删除）">
        <div class="str-editor-options">
          <label><input id="str-regex" type="checkbox"> 正则表达式</label>
          <label><input id="str-case" type="checkbox"> 区分大小写</label>
          <button id="str-save" class="menu_button">保存规则</button>
          <button id="str-cancel" class="menu_button">取消</button>
        </div>
      </div>
      <div id="str-rules" class="str-rules"></div>
      <div id="str-status" class="str-status">规则只处理消息正文中的文本，不改 HTML 标签和属性。</div>
    `;
    host.append(panel);
    bindPanel(panel);
    renderPanel(panel);
}

function bindPanel(panel) {
    const $ = selector => panel.querySelector(selector);
    let editingId = null;
    $('#str-enabled').addEventListener('change', event => {
        settings().enabled = event.target.checked;
        persist();
    });
    $('#str-add').addEventListener('click', () => {
        editingId = null;
        $('#str-name').value = '';
        $('#str-find').value = '';
        $('#str-replace').value = '';
        $('#str-regex').checked = false;
        $('#str-case').checked = false;
        $('#str-editor').hidden = false;
    });
    $('#str-cancel').addEventListener('click', () => { $('#str-editor').hidden = true; });
    $('#str-save').addEventListener('click', () => {
        const find = $('#str-find').value;
        if (!find) return $('#str-status').textContent = '请填写要查找的内容。';
        const rule = {
            id: editingId || crypto.randomUUID(),
            name: $('#str-name').value.trim() || find,
            find,
            replace: $('#str-replace').value,
            regex: $('#str-regex').checked,
            flags: $('#str-case').checked ? 'g' : 'gi',
            enabled: true,
        };
        if (rule.regex) {
            try { new RegExp(rule.find, rule.flags); }
            catch (error) { return $('#str-status').textContent = '正则表达式错误：' + error.message; }
        }
        const list = settings().rules;
        const index = list.findIndex(item => item.id === editingId);
        if (index >= 0) list[index] = rule;
        else list.push(rule);
        persist();
        $('#str-editor').hidden = true;
        renderPanel(panel);
    });
    $('#str-export').addEventListener('click', () => {
        const blob = new Blob([JSON.stringify({ rules: settings().rules }, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = '文字净化规则.json'; a.click();
        URL.revokeObjectURL(url);
    });
    $('#str-import').addEventListener('click', () => $('#str-import-file').click());
    $('#str-import-file').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            if (!Array.isArray(data.rules)) throw new Error('文件中没有 rules 规则数组');
            settings().rules = data.rules.filter(rule => rule && typeof rule.find === 'string').map(rule => ({
                id: rule.id || crypto.randomUUID(), name: rule.name || rule.find,
                find: rule.find, replace: String(rule.replace ?? ''), regex: !!rule.regex,
                flags: rule.flags || 'gi', enabled: rule.enabled !== false,
            }));
            persist(); renderPanel(panel);
            $('#str-status').textContent = '已导入 ' + settings().rules.length + ' 条规则。';
        } catch (error) { $('#str-status').textContent = '导入失败：' + error.message; }
        event.target.value = '';
    });
    $('#str-clean-last').addEventListener('click', async () => {
        const ctx = getContext();
        const index = ctx.chat.length - 1;
        const message = ctx.chat[index];
        const count = processMessage(message);
        if (count) {
            if (typeof ctx.saveChat === 'function') await ctx.saveChat();
            if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(index, message);
            $('#str-status').textContent = '最新楼层已替换 ' + count + ' 处。';
        } else {
            $('#str-status').textContent = '最新楼层没有命中规则。';
        }
    });
    $('#str-rules').addEventListener('click', event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const rule = settings().rules.find(item => item.id === button.dataset.id);
        if (!rule) return;
        if (button.dataset.action === 'toggle') rule.enabled = !rule.enabled;
        if (button.dataset.action === 'delete') settings().rules = settings().rules.filter(item => item.id !== rule.id);
        if (button.dataset.action === 'edit') {
            editingId = rule.id;
            $('#str-name').value = rule.name || '';
            $('#str-find').value = rule.find;
            $('#str-replace').value = rule.replace ?? '';
            $('#str-regex').checked = !!rule.regex;
            $('#str-case').checked = !(rule.flags || 'gi').includes('i');
            $('#str-editor').hidden = false;
            return;
        }
        persist(); renderPanel(panel);
    });
}

function renderPanel(panel) {
    const cfg = settings();
    panel.querySelector('#str-enabled').checked = cfg.enabled;
    const list = panel.querySelector('#str-rules');
    list.replaceChildren();
    if (!cfg.rules.length) {
        const empty = document.createElement('div');
        empty.className = 'str-empty';
        empty.textContent = '还没有规则，点击「添加规则」创建第一条。';
        list.append(empty);
        return;
    }
    for (const rule of cfg.rules) {
        const row = document.createElement('div');
        row.className = 'str-rule';
        const info = document.createElement('div');
        info.className = 'str-rule-info';
        const name = document.createElement('b'); name.textContent = rule.name || rule.find;
        const detail = document.createElement('small');
        detail.textContent = (rule.regex ? '正则 · ' : '文本 · ') + rule.find + ' → ' + (rule.replace || '（删除）');
        info.append(name, detail);
        const actions = document.createElement('div');
        actions.className = 'str-rule-actions';
        for (const [action, label] of [['toggle', rule.enabled ? '已启用' : '已停用'], ['edit', '编辑'], ['delete', '删除']]) {
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'menu_button'; button.dataset.action = action; button.dataset.id = rule.id;
            button.textContent = label; actions.append(button);
        }
        row.append(info, actions); list.append(row);
    }
}

function initialize() {
    settings();
    addStylesAndPanel();
    const { eventSource, event_types } = getContext();
    eventSource.on(event_types.MESSAGE_RECEIVED, async messageId => {
        const ctx = getContext();
        const message = ctx.chat?.[Number(messageId)];
        const count = processMessage(message);
        if (count && typeof ctx.saveChat === 'function') await ctx.saveChat();
    });
}

const { eventSource, event_types } = getContext();
eventSource.on(event_types.APP_READY, initialize);
