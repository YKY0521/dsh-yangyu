/* Yangyu browser plugin. Uses DSH's public main/sidebar slots and native sessions. */
window.__ModuleLoader__.load({
  id: 'dsh-yangyu',
  factory(require) {
    'use strict';
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React;
    const BASE = '/api/dsh-yangyu';
    const NS = 'yangyu';
    let csrfToken = '';
    let navigation = { characterId: null, tab: 'chat' };
    const navigationListeners = new Set();
    const pendingSessions = new Map();
    const navigationStore = {
      getSnapshot: () => navigation,
      subscribe(listener) { navigationListeners.add(listener); return () => navigationListeners.delete(listener); },
    };
    function setNavigation(value) {
      navigation = value;
      for (const listener of navigationListeners) listener();
    }

    async function request(endpoint, options = {}) {
      const response = await fetch(BASE + endpoint, { credentials: 'same-origin', ...options });
      let value;
      try { value = await response.json(); } catch { throw new Error('养鱼接口返回了无法读取的内容，请刷新后重试。'); }
      if (!response.ok || value.ok !== true) throw new Error(value.error || value.message || `请求失败（${response.status}）`);
      if (typeof value.csrfToken === 'string') csrfToken = value.csrfToken;
      return value;
    }
    async function mutate(action, payload) {
      if (!csrfToken) await request('/state');
      return request('/mutate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-yangyu-token': csrfToken },
        body: JSON.stringify({ action, ...payload }),
      });
    }
    async function readExistingPersona(endpoint) {
      const response = await fetch('/api/dsh-persona-dafeiyu/' + endpoint, { credentials: 'same-origin' });
      if (response.status === 404) throw new Error('现有人设库未启用。请启用 dsh-persona-dafeiyu，或直接粘贴、导入人设文本。');
      let body;
      try { body = await response.json(); } catch { throw new Error('无法读取现有人设库，请确认人设插件已启用。'); }
      if (!response.ok || body.ok !== true) throw new Error(body.error || '现有人设库暂时不可用。');
      return body.value;
    }
    function FishIcon({ size = 20, decorative = true }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': decorative, role: decorative ? undefined : 'img' },
        h('path', { d: 'M18.5 12c-2.8-5.5-8.4-6.3-12-2.6L2 6.7v10.6l4.5-2.7C10.1 18.3 15.7 17.5 18.5 12Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
        h('circle', { cx: 14.5, cy: 11, r: 1, fill: 'currentColor' }),
        h('path', { d: 'm9 7 2-3 2 3m-4 10 2 3 2-3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
        h('circle', { cx: 21, cy: 6, r: 1, stroke: 'currentColor' }));
    }
    function PondArt() {
      return h('svg', { className: 'yy-pond-art', viewBox: '0 0 240 120', fill: 'none', 'aria-hidden': true },
        h('ellipse', { cx: 120, cy: 65, rx: 104, ry: 38, stroke: 'currentColor', strokeDasharray: '3 6', opacity: .3 }),
        h('ellipse', { cx: 120, cy: 65, rx: 73, ry: 24, stroke: 'currentColor', opacity: .15 }),
        h('g', { transform: 'translate(77 26) scale(3)' }, h(FishIcon, { size: 24 })),
        h('circle', { cx: 175, cy: 33, r: 5, stroke: 'currentColor', opacity: .4 }),
        h('circle', { cx: 190, cy: 17, r: 2, fill: 'currentColor', opacity: .3 }),
        h('path', { d: 'M40 89c9-4 18-4 27 0m105 0c9-4 18-4 27 0', stroke: 'currentColor', strokeLinecap: 'round', opacity: .4 }));
    }
    function Button({ children, primary, danger, small, className = '', ...props }) {
      return h('button', { type: 'button', ...props, className: `yy-button ${primary ? 'yy-primary' : ''} ${danger ? 'yy-danger' : ''} ${small ? 'yy-small' : ''} ${className}` }, children);
    }
    function Field({ label, hint, children }) {
      return h('label', { className: 'yy-field' }, h('span', { className: 'yy-label' }, label), children, hint && h('span', { className: 'yy-hint' }, hint));
    }
    function dateLabel(value) {
      if (!value) return '刚刚';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }
    function downloadJson(value, name) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function readText(file, limit = 512000) {
      if (!file) return null;
      if (file.size > limit) throw new Error(`文件过大，请选择小于 ${Math.floor(limit / 1000)} KB 的文件。`);
      return file.text();
    }

    function PersonaImport({ onSelect, onError, disabled }) {
      const [entries, setEntries] = useState(null);
      const [loading, setLoading] = useState(false);
      const [selected, setSelected] = useState('');
      return h('div', { className: 'yy-import-tools' },
        h('label', { className: `yy-button yy-small ${disabled ? 'yy-disabled' : ''}` }, '从文本文件导入',
          h('input', { type: 'file', className: 'yy-file', accept: '.md,.markdown,.txt,text/plain,text/markdown', disabled,
            onChange: async (event) => {
              const file = event.target.files?.[0]; event.target.value = '';
              try { const text = await readText(file, 192000); if (text !== null) onSelect(text); } catch (error) { onError(error); }
            } })),
        entries === null ? h(Button, { small: true, disabled: disabled || loading, onClick: async () => {
          setLoading(true);
          try { const result = await readExistingPersona('status'); setEntries(result.personas || []); }
          catch (error) { onError(error); } finally { setLoading(false); }
        } }, loading ? '读取人设库…' : '从现有人设库选择') : h(React.Fragment, null,
          h('select', { className: 'yy-input yy-select', value: selected, disabled, 'aria-label': '选择要导入的人设', onChange: (e) => setSelected(e.target.value) },
            h('option', { value: '' }, entries.length ? '选择一个现有人设' : '没有可导入的人设'),
            entries.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.name))),
          h(Button, { small: true, disabled: disabled || loading || !selected, onClick: async () => {
            setLoading(true);
            try { const entry = await readExistingPersona(`persona?id=${encodeURIComponent(selected)}`); onSelect(entry.text || ''); }
            catch (error) { onError(error); } finally { setLoading(false); }
          } }, loading ? '读取中…' : '填入人设')));
    }

    function CharacterForm({ onSave, onCancel, busy, onError }) {
      const [name, setName] = useState('');
      const [avatar, setAvatar] = useState('🐟');
      const [persona, setPersona] = useState('');
      return h('section', { className: 'yy-editor yy-create', 'aria-labelledby': 'yy-create-title' },
        h('div', { className: 'yy-section-heading' }, h('div', null,
          h('span', { className: 'yy-eyebrow' }, '一次新的相遇'), h('h2', { id: 'yy-create-title' }, '添加一位伙伴')),
          h(Button, { small: true, disabled: busy, onClick: onCancel, 'aria-label': '取消添加角色' }, '取消')),
        h('form', { onSubmit: (event) => { event.preventDefault(); onSave({ name: name.trim(), avatar, persona }); } },
          h('fieldset', { disabled: busy, className: 'yy-fieldset' },
            h('div', { className: 'yy-form-row' },
              h(Field, { label: '头像', hint: '一个表情就很好' }, h('input', { className: 'yy-input yy-avatar-input', value: avatar, maxLength: 16, onChange: (e) => setAvatar(e.target.value), 'aria-label': '角色头像表情' })),
              h(Field, { label: '名字 · 必填' }, h('input', { autoFocus: true, className: 'yy-input', value: name, maxLength: 60, required: true, placeholder: '例如：小鱼', onChange: (e) => setName(e.target.value) }))),
            h(Field, { label: '人设 · 可选', hint: '可以写性格、背景、说话方式，也可以留空，之后再慢慢认识。' },
              h('textarea', { className: 'yy-input yy-persona-input', value: persona, maxLength: 64000, placeholder: '她是怎样的伙伴？', onChange: (e) => setPersona(e.target.value) })),
            h(PersonaImport, { onSelect: setPersona, onError, disabled: busy }),
            h('div', { className: 'yy-actions yy-form-footer' }, h('span', { className: 'yy-hint' }, '创建后会拥有自己的聊天记录和记忆库。'),
              h(Button, { type: 'submit', primary: true, disabled: busy || !name.trim() }, busy ? '正在创建…' : '添加伙伴')))));
    }

    function CharacterCard({ character, bindings, sessionState, onManage, onChat, busy }) {
      const sessions = bindings.filter((binding) => binding.characterId === character.id);
      const available = sessionState?.phase === 'ready' ? sessions.filter((binding) => sessionState.byId[binding.sessionId]) : sessions;
      const last = available[available.length - 1];
      return h('article', { className: 'yy-card' },
        h('div', { className: 'yy-card-top' }, h('span', { className: 'yy-avatar', 'aria-hidden': true }, character.avatar || '🐟'),
          h('span', { className: 'yy-pill' }, character.persona ? '已有人设' : '自由相处')),
        h('h2', null, character.name),
        h('p', { className: 'yy-card-description' }, character.persona ? character.persona.slice(0, 100) : '从一声问好开始，慢慢积累属于你们的回忆。'),
        h('p', { className: 'yy-hint yy-card-meta' }, sessions.length ? `${sessions.length} 段对话 · ${dateLabel(last?.createdAt)}` : '还没有开始聊天'),
        h('div', { className: 'yy-card-actions' }, h(Button, { primary: true, disabled: busy, onClick: () => onChat(character.id, last?.sessionId) }, last ? '继续聊天' : '开始聊天'),
          h(Button, { disabled: busy, onClick: () => onManage(character.id) }, '管理')));
    }

    function PersonaEditor({ character, onSave, onError, busy }) {
      const [text, setText] = useState(character.persona || '');
      const dirty = text !== (character.persona || '');
      return h('form', { className: 'yy-editor', onSubmit: (event) => { event.preventDefault(); onSave({ id: character.id, persona: text }); } },
        h('h2', null, '她是怎样的伙伴'),
        h('p', { className: 'yy-muted' }, '人设决定初始性格与说话方式。修改后，下次回复就会使用新的设定。'),
        h('fieldset', { className: 'yy-fieldset', disabled: busy },
          h(Field, { label: '人设', hint: '留空表示不设置固定人设；已有的相处记忆会保留。' },
            h('textarea', { className: 'yy-input yy-persona-large', value: text, maxLength: 64000, onChange: (e) => setText(e.target.value), placeholder: '写下性格、背景、说话习惯，或者先留空。' })),
          h(PersonaImport, { onSelect: setText, onError, disabled: busy }),
          h('div', { className: 'yy-actions yy-form-footer' }, h('span', { className: 'yy-hint' }, `${text.length.toLocaleString()} / 64,000 字符`),
            h(Button, { type: 'submit', primary: true, disabled: busy || !dirty }, busy ? '保存中…' : '保存人设'))));
    }

    function MemoryEditor({ initial, onSave, onCancel, busy }) {
      const [text, setText] = useState(initial?.text || '');
      const [kind, setKind] = useState(initial?.kind || 'fixed');
      const [important, setImportant] = useState(initial?.important === true);
      return h('form', { className: 'yy-editor yy-memory-editor', onSubmit: (e) => { e.preventDefault(); onSave({ id: initial?.id, text, kind, important }); } },
        h('h3', null, initial ? '修改这段记忆' : '留下新的记忆'),
        h('fieldset', { className: 'yy-fieldset', disabled: busy },
          h(Field, { label: '记忆内容' }, h('textarea', { className: 'yy-input', rows: 4, autoFocus: true, required: true, value: text, maxLength: 8000, placeholder: '例如：我们约好下周一起看海。', onChange: (e) => setText(e.target.value) })),
          h('div', { className: 'yy-actions' },
            h('select', { className: 'yy-input yy-select', value: kind, 'aria-label': '记忆类型', onChange: (e) => setKind(e.target.value) }, h('option', { value: 'fixed' }, '固定资料'), h('option', { value: 'episode' }, '相处记忆')),
            h('label', { className: 'yy-checkbox' }, h('input', { type: 'checkbox', checked: important, onChange: (e) => setImportant(e.target.checked) }), '重要记忆')),
          h('div', { className: 'yy-actions yy-form-footer' }, h(Button, { disabled: busy, onClick: onCancel }, '取消'), h(Button, { type: 'submit', primary: true, disabled: busy || !text.trim() }, busy ? '保存中…' : '保存记忆'))));
    }

    function Memories({ memories, onSave, onDelete, busy }) {
      const [filter, setFilter] = useState('all');
      const [query, setQuery] = useState('');
      const [editing, setEditing] = useState(undefined);
      const [deleting, setDeleting] = useState(null);
      const visible = memories.filter((entry) => (filter === 'all' || entry.kind === filter) && entry.text.toLowerCase().includes(query.toLowerCase()));
      return h('section', { className: 'yy-stack' },
        h('div', { className: 'yy-section-heading' }, h('div', null, h('h2', null, '属于你们的记忆'), h('p', { className: 'yy-muted' }, '固定资料与相处经历分别保存，你可以随时纠正或删除。')),
          h(Button, { primary: true, disabled: busy || editing !== undefined, onClick: () => setEditing(null) }, '＋ 添加记忆')),
        editing !== undefined && h(MemoryEditor, { key: editing?.id || 'new', initial: editing, busy,
          onCancel: () => setEditing(undefined), onSave: async (value) => { if (await onSave(value)) setEditing(undefined); } }),
        h('div', { className: 'yy-memory-toolbar' },
          h('input', { className: 'yy-input', type: 'search', placeholder: '搜索记忆', value: query, onChange: (e) => setQuery(e.target.value), 'aria-label': '搜索记忆' }),
          h('select', { className: 'yy-input yy-select', value: filter, 'aria-label': '筛选记忆类型', onChange: (e) => setFilter(e.target.value) }, h('option', { value: 'all' }, `全部 · ${memories.length}`), h('option', { value: 'fixed' }, '固定资料'), h('option', { value: 'episode' }, '相处记忆'))),
        visible.length === 0 ? h('div', { className: 'yy-empty-small' }, h('span', { 'aria-hidden': true }, '○'), h('p', null, memories.length ? '没有符合条件的记忆' : '记忆库还是空的'), h('span', { className: 'yy-hint' }, memories.length ? '试试其他关键词或类型。' : '可以先添加一条固定资料，或在聊天中告诉她“记住这件事”。')) :
          h('div', { className: 'yy-memory-list' }, visible.map((entry) => h('article', { key: entry.id, className: 'yy-memory' },
            h('div', { className: 'yy-actions' }, h('span', { className: 'yy-pill' }, entry.kind === 'fixed' ? '固定资料' : '相处记忆'), entry.important && h('span', { className: 'yy-important' }, '★ 重要'), h('span', { className: 'yy-hint' }, dateLabel(entry.updatedAt || entry.createdAt))),
            h('p', { className: 'yy-memory-text' }, entry.text),
            h('div', { className: 'yy-memory-foot' }, h('span', { className: 'yy-hint' }, entry.sourceSessionId ? `来源：聊天记录 · ${entry.sourceSessionId.slice(0, 8)}` : '来源：手动记录或导入'),
              h('div', { className: 'yy-actions' }, h(Button, { small: true, disabled: busy || editing !== undefined, onClick: () => setEditing(entry) }, '编辑'),
                deleting === entry.id ? h(React.Fragment, null, h(Button, { small: true, danger: true, disabled: busy, onClick: async () => { if (await onDelete(entry.id)) setDeleting(null); } }, '确认删除'), h(Button, { small: true, disabled: busy, onClick: () => setDeleting(null) }, '取消')) : h(Button, { small: true, disabled: busy, onClick: () => setDeleting(entry.id) }, '删除')))))));
    }

    function ChatList({ character, bindings, sessions, workspaces, workspaceId, setWorkspaceId, onChat, busy }) {
      return h('section', { className: 'yy-stack' },
        h('div', { className: 'yy-chat-welcome' }, h('span', { className: 'yy-avatar yy-avatar-large', 'aria-hidden': true }, character.avatar || '🐟'),
          h('h2', null, `今天，和${character.name}聊些什么？`), h('p', { className: 'yy-muted' }, '每一段新对话，都能延续属于你们的记忆。'),
          h('div', { className: 'yy-actions yy-center' },
            h('select', { className: 'yy-input yy-select yy-workspace', value: workspaceId, onChange: (e) => setWorkspaceId(e.target.value), disabled: busy, 'aria-label': '新对话所在工作区' },
              workspaces.length === 0 && h('option', { value: '' }, '请先在侧栏添加工作区'),
              workspaces.map((item) => h('option', { key: item.workspaceId, value: item.workspaceId }, item.title || item.path || item.workspaceId))),
            h(Button, { primary: true, disabled: busy || !workspaceId, onClick: () => onChat(character.id) }, busy ? '准备中…' : '＋ 开始新对话'))),
        h('div', { className: 'yy-section-heading' }, h('h3', null, '之前的对话'), h('span', { className: 'yy-hint' }, `${bindings.length} 段`)),
        bindings.length ? h('div', { className: 'yy-sessions' }, [...bindings].reverse().map((binding) => {
          const session = sessions?.byId?.[binding.sessionId];
          const unavailable = sessions?.phase === 'ready' && !session;
          return h('button', { type: 'button', className: 'yy-session', key: binding.sessionId, disabled: busy || unavailable, onClick: () => onChat(character.id, binding.sessionId) },
            h('span', { className: 'yy-session-icon', 'aria-hidden': true }, '◌'), h('span', { className: 'yy-session-info' }, h('strong', null, session?.title || binding.title || `与${character.name}的对话`), h('span', { className: 'yy-hint' }, unavailable ? '该会话已不在 DSH 会话列表中' : dateLabel(binding.createdAt))), h('span', { 'aria-hidden': true }, '↗'));
        })) : h('div', { className: 'yy-empty-small' }, h('p', null, '还没有对话'), h('span', { className: 'yy-hint' }, '从上面的“开始新对话”打个招呼吧。')));
    }

    const TRAVEL_PLATFORMS = [
      { id: 'wechat', name: '微信', about: '使用微信扫码连接官方机器人通道。', audience: '仅回复扫码微信用户的私聊。' },
      { id: 'qq', name: 'QQ', about: '扫码连接你的 QQ，让伙伴和你聊天。', audience: '仅回复 QQ 允许名单中的私聊。' },
    ];
    const TRAVEL_STATES = {
      disconnected: '未连接', waiting: '等待扫码', scanned: '等待手机确认', connected: '已连接',
      expired: '二维码已过期', error: '连接失败', unavailable: '暂不可用',
    };
    function travelDeadline(value) {
      const milliseconds = typeof value === 'number' ? value : Date.parse(value);
      return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
    }
    function travelStatus(platform, now) {
      const deadline = travelDeadline(platform?.qr?.expiresAt);
      return ['waiting', 'scanned'].includes(platform?.status) && deadline !== null && now >= deadline
        ? 'expired' : platform?.status || 'disconnected';
    }
    function PlatformIcon({ platform, size = 24 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 32 32', fill: 'none', 'aria-hidden': true },
        platform === 'wechat' ? h(React.Fragment, null,
          h('path', { d: 'M19.5 7.8c-1.7-2.3-4.2-3.6-7.4-3.6C6.8 4.2 2.5 7.8 2.5 12.3c0 2.5 1.3 4.6 3.6 6.2l-.9 3.3 3.7-1.8c1 .3 2.2.5 3.3.5', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
          h('path', { d: 'M29.5 19c0-4.1-3.9-7.4-8.7-7.4S12 14.9 12 19s4 7.4 8.8 7.4c1 0 2-.2 3-.4l3.3 1.8-.8-3.2c2-1.4 3.2-3.3 3.2-5.6Z', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
          h('circle', { cx: 8.7, cy: 11.2, r: 1.1, fill: 'currentColor' }), h('circle', { cx: 15.2, cy: 11.2, r: 1.1, fill: 'currentColor' }),
          h('circle', { cx: 17.9, cy: 18.2, r: 1.1, fill: 'currentColor' }), h('circle', { cx: 23.5, cy: 18.2, r: 1.1, fill: 'currentColor' })) :
          h(React.Fragment, null,
            h('path', { d: 'M8.5 16c-.6-2-1-3.2-1-5.1 0-5 3.5-8 8.5-8s8.5 3 8.5 8c0 1.9-.4 3.1-1 5.1 2 2 3.8 5.6 3.3 6.2-.6.7-2.7-.5-3.7-1.1.1 4.1-3.3 7.3-7.1 7.3s-7.2-3.2-7.1-7.3c-1 .6-3.1 1.8-3.7 1.1-.5-.6 1.3-4.2 3.3-6.2Z', stroke: 'currentColor', strokeWidth: 1.7, strokeLinejoin: 'round' }),
            h('path', { d: 'M9 16.5c4.3 1.7 9.7 1.7 14 0m-12.4 11-3 1.6m13.8-1.6 3 1.6', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
            h('circle', { cx: 13, cy: 9.5, r: 1, fill: 'currentColor' }), h('circle', { cx: 19, cy: 9.5, r: 1, fill: 'currentColor' }),
            h('path', { d: 'm13.5 12.5 2.5 1.4 2.5-1.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })));
    }
    function QRPlaceholder({ expired, busy }) {
      return h('div', { className: 'yy-qr-placeholder', 'aria-hidden': true },
        h('svg', { width: 66, height: 66, viewBox: '0 0 64 64', fill: 'none' },
          h('path', { d: 'M24 7H11a4 4 0 0 0-4 4v13m33-17h13a4 4 0 0 1 4 4v13M7 40v13a4 4 0 0 0 4 4h13m33-17v13a4 4 0 0 1-4 4H40', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }),
          busy ? h('circle', { className: 'yy-qr-spinner', cx: 32, cy: 32, r: 11, stroke: 'currentColor', strokeWidth: 2.4, strokeDasharray: '45 24' }) :
            expired ? h('path', { d: 'm23 23 18 18m0-18L23 41', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round' }) :
              h('path', { d: 'M21 21h5v5h-5zm17 0h5v5h-5zM21 38h5v5h-5zm17 0h5v5h-5z', fill: 'currentColor', opacity: .45 })));
    }
    function TravelQRCode({ image, platform }) {
      const [failed, setFailed] = useState(false);
      useEffect(() => { setFailed(false); }, [image]);
      const valid = typeof image === 'string' && image.length <= 2 * 1024 * 1024 && /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(image);
      return valid && !failed ? h('div', { className: 'yy-qr-paper' },
        h('img', { className: 'yy-qr-image', src: image, alt: `${platform}登录二维码`, width: 224, height: 224,
          referrerPolicy: 'no-referrer', draggable: false, onError: () => setFailed(true) })) :
        h('div', { className: 'yy-qr-display-error', role: 'alert' }, h(QRPlaceholder), h('p', null, '二维码未能显示'), h('span', { className: 'yy-hint' }, '请刷新二维码后重试。'));
    }
    function Travel({ character }) {
      const [selected, setSelected] = useState('wechat');
      const [platforms, setPlatforms] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(false);
      const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
      const [clock, setClock] = useState(Date.now);
      const [revision, setRevision] = useState(0);
      const [confirmDisconnect, setConfirmDisconnect] = useState(false);
      const [verificationCode, setVerificationCode] = useState('');
      const alive = useRef(true);
      const role = useRef(character.id);
      const items = useRef([]);
      const pollEpoch = useRef(0);
      const actionEpoch = useRef(0);
      const actionLock = useRef(false);
      const pollRequest = useRef(null);
      const actionRequest = useRef(null);
      const pollTimer = useRef(null);
      const initialLoaded = useRef(false);

      const accept = useCallback((response) => {
        if (!Array.isArray(response?.platforms)) throw new Error('暂时无法读取平台连接状态，请重试。');
        const received = response.platforms.filter((item) => TRAVEL_PLATFORMS.some((known) => known.id === item?.platform)).map((item) => ({
          platform: item.platform, status: item.status, generation: item.generation, message: typeof item.message === 'string' ? item.message.slice(0, 2000) : '',
          setupHint: typeof item.setupHint === 'string' ? item.setupHint.slice(0, 2000) : '',
          chatEnabled: item.chatEnabled === true, needsTakeover: item.needsTakeover === true, verificationRequired: item.verificationRequired === true,
          account: item.account ? { name: item.account.name, idMasked: item.account.idMasked } : undefined,
          qr: item.qr ? { image: typeof item.qr.image === 'string' && item.qr.image.length <= 2 * 1024 * 1024 ? item.qr.image : '', expiresAt: item.qr.expiresAt, generation: item.qr.generation } : undefined,
        }));
        const merged = [...items.current];
        for (const item of received) {
          const index = merged.findIndex((known) => known.platform === item.platform);
          if (index === -1) merged.push(item); else merged[index] = item;
        }
        items.current = merged;
        initialLoaded.current = true;
        setPlatforms(merged);
        setLoading(false);
        setClock(Date.now());
      }, []);

      useEffect(() => {
        alive.current = true;
        role.current = character.id;
        items.current = [];
        initialLoaded.current = false;
        setPlatforms([]); setError(''); setLoading(true); setConfirmDisconnect(false); setVerificationCode('');
        return () => {
          alive.current = false;
          pollEpoch.current++; actionEpoch.current++;
          clearTimeout(pollTimer.current);
          pollRequest.current?.abort(); actionRequest.current?.abort();
          actionLock.current = false;
        };
      }, [character.id]);

      useEffect(() => {
        const update = () => {
          const next = document.visibilityState !== 'hidden';
          if (!next) {
            pollEpoch.current++; actionEpoch.current++;
            clearTimeout(pollTimer.current);
            pollRequest.current?.abort(); actionRequest.current?.abort();
            setVerificationCode('');
          }
          setVisible(next); setClock(Date.now());
        };
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
      }, []);

      useEffect(() => {
        if (!visible) return;
        const timer = setInterval(() => setClock(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [visible]);

      useEffect(() => {
        setConfirmDisconnect(false);
        const epoch = ++pollEpoch.current;
        let cancelled = false;
        clearTimeout(pollTimer.current);
        pollRequest.current?.abort();
        if (!visible || busy) return;
        const current = () => !cancelled && alive.current && epoch === pollEpoch.current && role.current === character.id;
        const schedule = () => {
          if (!current()) return;
          const platform = items.current.find((item) => item.platform === selected);
          const status = travelStatus(platform, Date.now());
          const delay = ['waiting', 'scanned'].includes(status) ? 2000 : status === 'connected' ? 5000 : null;
          if (delay !== null) pollTimer.current = setTimeout(load, delay);
        };
        async function load() {
          if (!current()) return;
          const controller = new AbortController();
          pollRequest.current = controller;
          try {
            const response = await request(`/travel?characterId=${encodeURIComponent(character.id)}&platform=${encodeURIComponent(selected)}`, { signal: controller.signal });
            if (!current()) return;
            accept(response); setError('');
          } catch (failure) {
            if (current() && failure?.name !== 'AbortError') { setError(failure?.message || '连接状态更新失败'); setLoading(false); }
          } finally {
            if (pollRequest.current === controller) pollRequest.current = null;
            schedule();
          }
        }
        if (!initialLoaded.current) setLoading(true);
        load();
        return () => {
          cancelled = true;
          pollEpoch.current++;
          clearTimeout(pollTimer.current);
          pollRequest.current?.abort();
        };
      }, [character.id, selected, visible, busy, revision, accept]);

      async function action(name, platform = selected, code) {
        if (actionLock.current || !visible) return;
        if (name === 'verify' && (platform !== 'wechat' || typeof code !== 'string' || !/^\d{4,12}$/.test(code))) {
          setError('请输入手机微信里显示的 4 至 12 位数字验证码。');
          return;
        }
        actionLock.current = true;
        const epoch = ++actionEpoch.current;
        const characterId = character.id;
        const controller = new AbortController();
        const previous = items.current.find((item) => item.platform === platform);
        const generation = previous?.qr?.generation ?? previous?.generation;
        actionRequest.current = controller;
        pollEpoch.current++; pollRequest.current?.abort(); clearTimeout(pollTimer.current);
        setSelected(platform); setConfirmDisconnect(false); setBusy(true); setError(''); setVerificationCode('');
        const current = () => alive.current && role.current === characterId && epoch === actionEpoch.current;
        try {
          if (!csrfToken) await request('/state', { signal: controller.signal });
          const response = await request('/travel', {
            method: 'POST', signal: controller.signal,
            headers: { 'content-type': 'application/json', 'x-yangyu-token': csrfToken },
            body: JSON.stringify({ action: name, characterId, platform, ...(generation === undefined ? {} : { generation }), ...(name === 'verify' ? { code } : {}) }),
          });
          if (current()) accept(response);
        } catch (failure) {
          if (current() && failure?.name !== 'AbortError') setError(failure?.message || '连接操作失败');
        } finally {
          if (actionRequest.current === controller) actionRequest.current = null;
          actionLock.current = false;
          if (alive.current && role.current === characterId) { setBusy(false); setRevision((value) => value + 1); }
        }
      }

      function connect(platform) {
        const state = items.current.find((item) => item.platform === platform);
        const status = travelStatus(state, Date.now());
        if (['waiting', 'scanned', 'connected'].includes(status)) { setSelected(platform); return; }
        action(status === 'expired' ? 'refresh' : 'start', platform);
      }
      const descriptor = TRAVEL_PLATFORMS.find((platform) => platform.id === selected);
      const state = platforms.find((platform) => platform.platform === selected) || { platform: selected, status: 'disconnected', chatEnabled: false };
      const status = travelStatus(state, clock);
      const deadline = travelDeadline(state.qr?.expiresAt);
      const remaining = deadline === null ? null : Math.max(0, Math.ceil((deadline - clock) / 1000));
      const qrActive = ['waiting', 'scanned'].includes(status) && state.qr?.image;
      const connected = status === 'connected' && !state.verificationRequired;
      const verification = state.verificationRequired === true;
      const statusLabel = verification && status !== 'expired' ? '等待安全验证' : TRAVEL_STATES[status] || '正在更新';
      const showVerification = selected === 'wechat' && verification && status !== 'expired';
      useEffect(() => { setVerificationCode(''); }, [character.id, selected, state.qr?.generation ?? state.generation, showVerification]);

      return h('section', { className: 'yy-travel', 'aria-label': `${character.name}的出游连接` },
        h('div', { className: 'yy-section-heading yy-travel-heading' }, h('div', null,
          h('span', { className: 'yy-eyebrow' }, '带着人设与回忆，换个地方相遇'), h('h2', null, '出游'),
          h('p', { className: 'yy-muted' }, `让${character.name}在微信或 QQ 中与你聊天，使用这个角色自己的记忆。`))),
        error && h('div', { className: 'yy-alert yy-error', role: 'alert' }, h('span', null, error),
          h(Button, { small: true, disabled: busy || !visible, onClick: () => setRevision((value) => value + 1) }, '重试')),
        h('div', { className: 'yy-travel-layout' },
          h('div', { className: 'yy-platforms', 'aria-label': '选择出游平台' }, TRAVEL_PLATFORMS.map((platform) => {
            const platformState = platforms.find((item) => item.platform === platform.id);
            const platformStatus = travelStatus(platformState, clock);
            const pending = ['waiting', 'scanned'].includes(platformStatus);
            return h('section', { key: platform.id, className: `yy-platform-card ${selected === platform.id ? 'yy-selected-platform' : ''}` },
              h('button', { className: 'yy-platform-select', type: 'button', 'aria-pressed': selected === platform.id,
                'aria-label': `查看${platform.name}连接`, disabled: busy, onClick: () => setSelected(platform.id) },
                h('span', { className: `yy-platform-icon yy-platform-${platform.id}` }, h(PlatformIcon, { platform: platform.id, size: 28 })),
                h('span', { className: 'yy-platform-name' }, h('strong', null, platform.name), h('span', { className: 'yy-hint' }, platform.about))),
              h('div', { className: 'yy-platform-card-foot' }, h('span', { className: `yy-platform-state yy-platform-state-${platformStatus}` },
                h('span', { className: 'yy-status-dot', 'aria-hidden': true }), platformState?.verificationRequired ? '等待安全验证' : TRAVEL_STATES[platformStatus] || '未连接'),
                h(Button, { small: true, primary: platformStatus === 'disconnected', disabled: busy || loading || !visible, onClick: () => connect(platform.id),
                  'aria-label': platformStatus === 'connected' ? `查看${platform.name}连接` : pending ? `查看${platform.name}二维码` : `连接${platform.name}` },
                  platformStatus === 'connected' ? '查看连接' : pending ? '查看二维码' : `连接${platform.name}`)));
          })),
          h('section', { className: 'yy-connection-panel', 'aria-label': `${descriptor.name}扫码与连接状态` },
            h('div', { className: 'yy-connection-heading' }, h('span', null, h(PlatformIcon, { platform: selected, size: 19 }), h('strong', null, descriptor.name)),
              h('span', { className: `yy-pill ${connected ? 'yy-connection-online' : ''}`, role: 'status' }, busy ? '正在连接…' : loading ? '读取状态…' : statusLabel)),
            h('div', { className: 'yy-connection-body' },
              busy || loading ? h(React.Fragment, null, h(QRPlaceholder, { busy: true }), h('h3', null, busy ? '正在准备连接' : '正在读取连接状态'), h('p', { className: 'yy-hint' }, '请稍候，二维码就会显示在这里。')) :
              connected ? h(React.Fragment, null,
                h('div', { className: 'yy-connected-mark', 'aria-hidden': true }, h('svg', { width: 36, height: 36, viewBox: '0 0 36 36', fill: 'none' }, h('path', { d: 'm9 18 6 6 13-13', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
                h('h3', null, `已连接到${character.name}`),
                (state.account?.name || state.account?.idMasked) && h('p', { className: 'yy-account-summary' }, state.account.name || descriptor.name, state.account.idMasked && h('span', null, state.account.idMasked)),
                h('p', { className: 'yy-hint' }, state.chatEnabled ? '角色聊天已开启，继续使用这个角色的人设与记忆。' : '账号已连接，角色聊天目前已暂停。'),
                state.message && h('p', { className: 'yy-hint' }, state.message),
                state.needsTakeover && h('div', { className: 'yy-alert yy-warning yy-travel-inline' }, '原小鱼桥正在使用此 QQ，请先停用旧桥，再启用角色聊天。'),
                h('div', { className: 'yy-actions yy-center' }, h(Button, { primary: !state.chatEnabled, disabled: busy || state.needsTakeover,
                  onClick: () => action(state.chatEnabled ? 'chat.disable' : 'chat.enable') }, state.chatEnabled ? '暂停角色聊天' : '启用角色聊天'),
                  h(Button, { disabled: busy, onClick: () => setConfirmDisconnect(true) }, '解除连接'))) :
              qrActive ? h(React.Fragment, null,
                h(TravelQRCode, { key: state.qr.generation || state.qr.image, image: state.qr.image, platform: descriptor.name }),
                h('h3', null, verification ? '请输入微信验证码' : status === 'scanned' ? '已扫码，请在手机确认' : `用${descriptor.name}扫描二维码`),
                h('p', { className: 'yy-hint' }, verification ? '请在下方填写手机微信里显示的验证码并提交。' : status === 'scanned' ? '手机确认后，这里会自动显示连接结果。' : '请使用你希望与这个角色连接的账号扫码。'),
                h('div', { className: 'yy-qr-foot' }, h('span', { className: 'yy-hint' }, remaining === null ? '二维码失效后可手动刷新' : `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} 后过期`),
                  h(Button, { small: true, disabled: busy, onClick: () => action('refresh'), 'aria-label': `刷新${descriptor.name}二维码` }, '↻ 刷新二维码')),
                state.message && h('p', { className: 'yy-hint yy-platform-message' }, state.message)) :
              h(React.Fragment, null,
                h(QRPlaceholder, { expired: status === 'expired' }),
                h('h3', null, status === 'expired' ? '二维码已过期' : verification ? '请输入微信验证码' : ['error', 'unavailable'].includes(status) ? `${descriptor.name}暂时无法连接` : '二维码会显示在这里'),
                h('p', { className: 'yy-hint' }, status === 'expired' ? '刷新后会生成一个新的二维码，请重新扫码。' : verification ? '请在下方填写手机微信里显示的验证码并提交。' : state.message || `点击左侧“连接${descriptor.name}”，再用手机扫码。`),
                state.setupHint && h('p', { className: 'yy-hint yy-platform-message' }, state.setupHint),
                ['expired', 'error', 'unavailable'].includes(status) || verification ? h(Button, { primary: true, disabled: busy || !visible, onClick: () => action(status === 'unavailable' ? 'start' : 'refresh'), 'aria-label': `刷新${descriptor.name}二维码` }, '↻ 刷新二维码') : null),
              showVerification && !busy && !loading && h('form', { className: 'yy-verification-form', onSubmit: (event) => { event.preventDefault(); action('verify', 'wechat', verificationCode); } },
                h(Field, { label: '微信验证码', hint: '验证码仅用于本次登录，提交后立即清空。' },
                  h('input', { type: 'text', inputMode: 'numeric', autoComplete: 'one-time-code', className: 'yy-input yy-verification-input',
                    value: verificationCode, required: true, pattern: '[0-9]{4,12}', minLength: 4, maxLength: 12,
                    'aria-label': '微信验证码', placeholder: '输入手机微信里的验证码', disabled: busy || !visible,
                    onChange: (event) => setVerificationCode(event.target.value.replace(/\D/g, '').slice(0, 12)) })),
                h(Button, { type: 'submit', primary: true, disabled: busy || !visible || !/^\d{4,12}$/.test(verificationCode) }, '提交验证码')),
              confirmDisconnect && h('div', { className: 'yy-travel-confirm', role: 'group', 'aria-label': `确认解除${descriptor.name}连接` },
                h('p', null, '解除后，此角色将停止在该平台回复。重新连接需要再次扫码，角色人设和记忆仍会保留。'),
                h('div', { className: 'yy-actions yy-center' }, h(Button, { danger: true, disabled: busy, onClick: () => action('disconnect') }, '确认解除连接'), h(Button, { disabled: busy, onClick: () => setConfirmDisconnect(false) }, '取消')))),
            h('div', { className: 'yy-connection-note' }, h('span', null, descriptor.audience), h('span', null, '群聊暂不接入。')))),
        character.memoryEnabled === false && h('p', { className: 'yy-hint yy-travel-memory-note' }, '这个角色目前已关闭记忆使用。你可以在“设置”中重新开启；平台连接不会改变这个设置。'));
    }

    function Settings({ character, busy, onSave, onExport, onDelete }) {
      const [name, setName] = useState(character.name);
      const [avatar, setAvatar] = useState(character.avatar || '🐟');
      const [memoryEnabled, setMemoryEnabled] = useState(character.memoryEnabled !== false);
      const [autoCapture, setAutoCapture] = useState(character.autoCapture === true);
      const [confirmDelete, setConfirmDelete] = useState(false);
      const [confirmName, setConfirmName] = useState('');
      const dirty = name !== character.name || avatar !== (character.avatar || '🐟') || memoryEnabled !== (character.memoryEnabled !== false) || autoCapture !== (character.autoCapture === true);
      return h('section', { className: 'yy-stack' },
        h('form', { className: 'yy-editor', onSubmit: (e) => { e.preventDefault(); onSave({ id: character.id, name: name.trim(), avatar, memoryEnabled, autoCapture }); } },
          h('h2', null, '角色设置'), h('fieldset', { disabled: busy, className: 'yy-fieldset' },
            h('div', { className: 'yy-form-row' }, h(Field, { label: '头像' }, h('input', { className: 'yy-input yy-avatar-input', value: avatar, maxLength: 16, onChange: (e) => setAvatar(e.target.value) })),
              h(Field, { label: '名字' }, h('input', { className: 'yy-input', value: name, maxLength: 60, required: true, onChange: (e) => setName(e.target.value) }))),
            h('label', { className: 'yy-toggle-row' }, h('span', null, h('strong', null, '聊天时使用记忆'), h('span', { className: 'yy-hint' }, '关闭后保留已有记忆，聊天时暂停召回。')), h('input', { type: 'checkbox', checked: memoryEnabled, onChange: (e) => setMemoryEnabled(e.target.checked) })),
            h('label', { className: 'yy-toggle-row' }, h('span', null, h('strong', null, '允许聊天中记忆'), h('span', { className: 'yy-hint' }, '允许伙伴记录重要事实与明确的记忆请求，可在记忆库中查看和删除。')), h('input', { type: 'checkbox', checked: autoCapture, onChange: (e) => setAutoCapture(e.target.checked) })),
            h('div', { className: 'yy-actions yy-form-footer' }, h('span', { className: 'yy-hint' }, '修改名字不会清空聊天或记忆。'), h(Button, { type: 'submit', primary: true, disabled: busy || !name.trim() || !dirty }, busy ? '保存中…' : '保存设置')))),
        h('div', { className: 'yy-editor yy-export-row' }, h('div', null, h('h3', null, '带走你们的回忆'), h('p', { className: 'yy-hint' }, '导出这个角色的人设与记忆，可在其他安装中重新导入。')), h(Button, { disabled: busy, onClick: onExport }, '导出角色')),
        h('div', { className: 'yy-editor yy-delete-area' }, h('h3', null, '删除角色'), h('p', { className: 'yy-hint' }, '删除此角色、人设和记忆，并解除与聊天会话的绑定。已有聊天记录仍保留在 DSH 中。建议先导出备份。'),
          confirmDelete ? h('div', { className: 'yy-stack' }, h(Field, { label: `输入“${character.name}”确认删除` }, h('input', { className: 'yy-input', value: confirmName, onChange: (e) => setConfirmName(e.target.value), autoFocus: true })),
            h('div', { className: 'yy-actions' }, h(Button, { danger: true, disabled: busy || confirmName !== character.name, onClick: onDelete }, '确认删除角色'), h(Button, { disabled: busy, onClick: () => { setConfirmDelete(false); setConfirmName(''); } }, '取消'))) :
            h(Button, { danger: true, disabled: busy, onClick: () => setConfirmDelete(true) }, '删除角色')));
    }

    function Page(props) {
      const nav = useSyncExternalStore(navigationStore.subscribe, navigationStore.getSnapshot);
      const sessions = props.useSessions((value) => value);
      const workspaceState = props.useWorkspaces((value) => value);
      const workspaces = workspaceState?.items || [];
      const [workspaceId, setWorkspaceId] = useState('');
      const [snapshot, setSnapshot] = useState(null);
      const [detail, setDetail] = useState(null);
      const [creating, setCreating] = useState(false);
      const [error, setError] = useState('');
      const [notice, setNotice] = useState('');
      const [busy, setBusy] = useState(false);
      const [loading, setLoading] = useState(true);
      const lock = useRef(false);
      const mounted = useRef(true);
      const detailRequest = useRef(0);
      const noticeTimer = useRef(null);
      useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; clearTimeout(noticeTimer.current); };
      }, []);
      const reportError = (error) => setError(error?.message || String(error));
      const showNotice = (text) => {
        setNotice(text); clearTimeout(noticeTimer.current);
        noticeTimer.current = setTimeout(() => { if (mounted.current) setNotice(''); }, 5000);
      };
      useEffect(() => {
        if (!workspaces.some((item) => item.workspaceId === workspaceId)) setWorkspaceId(workspaces[0]?.workspaceId || '');
      }, [workspaceId, workspaces]);
      const refresh = useCallback(async () => {
        const result = await request('/state'); if (mounted.current) setSnapshot(result); return result;
      }, []);
      const loadDetail = useCallback(async (id) => {
        const revision = ++detailRequest.current;
        const result = await request(`/character?id=${encodeURIComponent(id)}`);
        if (mounted.current && revision === detailRequest.current) setDetail(result);
        return result;
      }, []);
      useEffect(() => {
        let active = true;
        refresh().catch((error) => { if (active) reportError(error); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
      }, [refresh]);
      useEffect(() => {
        let active = true;
        setDetail(null); setError(''); setCreating(false);
        if (nav.characterId) {
          loadDetail(nav.characterId).catch((error) => { if (active) reportError(error); });
        } else detailRequest.current++;
        return () => { active = false; };
      }, [nav.characterId, loadDetail]);
      async function run(task) {
        if (lock.current) return false;
        lock.current = true; setBusy(true); setError('');
        try { await task(); return true; }
        catch (error) { if (mounted.current) reportError(error); return false; }
        finally { lock.current = false; if (mounted.current) setBusy(false); }
      }
      const manage = (id, tab = 'chat') => { setNavigation({ characterId: id, tab }); };
      async function chat(characterId, sessionId) {
        return run(async () => {
          if (!sessionId) {
            const key = `${characterId}:${workspaceId}`;
            if (!workspaceId) { manage(characterId); throw new Error('请先在 DSH 左侧栏添加工作区，再开始新对话。'); }
            sessionId = pendingSessions.get(key);
            if (!sessionId) {
              sessionId = await props.createSession(workspaceId);
              if (typeof sessionId !== 'string' || !sessionId) throw new Error('DSH 未返回有效的会话编号。');
              pendingSessions.set(key, sessionId);
            }
            await mutate('session.bind', { characterId, sessionId });
            pendingSessions.delete(key);
          }
          if (mounted.current) {
            await props.openSession(sessionId);
          }
        });
      }
      async function saveCharacter(value) {
        return run(async () => {
          await mutate('character.update', value);
          await Promise.all([refresh(), loadDetail(value.id)]);
          showNotice('已保存');
        });
      }
      const characters = snapshot?.characters || [];
      const bindings = snapshot?.bindings || [];
      const conflicts = snapshot?.compatibility?.conflicts || [];
      const selected = detail?.character;
      const tabs = [['chat', '聊天'], ['persona', '人设'], ['memory', '记忆库'], ['travel', '出游'], ['settings', '设置']];
      return h('div', { className: 'yy-root', 'data-yangyu': 'page' }, h('div', { className: 'yy-page' },
        h('header', { className: 'yy-header' }, h('div', { className: 'yy-brand' }, h('span', { className: 'yy-brand-icon' }, h(FishIcon, { size: 25 })),
          h('div', null, h('h1', null, '养鱼'), h('p', null, '把日常聊成回忆'))),
          h('div', { className: 'yy-actions' }, !nav.characterId && h('label', { className: `yy-button ${busy ? 'yy-disabled' : ''}`, title: '导入角色 JSON 文件，最大 16 MiB' }, '导入角色',
            h('input', { type: 'file', className: 'yy-file', accept: '.json,application/json', disabled: busy, onChange: (event) => {
              const file = event.target.files?.[0]; event.target.value = '';
              if (file) run(async () => {
                if (file.size > 16 * 1024 * 1024) throw new Error('角色文件不能超过 16 MiB，请缩小文件后重新导入。');
                const data = JSON.parse(await readText(file, 16 * 1024 * 1024));
                await mutate('import', { data }); await refresh(); showNotice('角色已导入，原有角色保持独立。');
              });
            } })),
            !nav.characterId && h(Button, { primary: true, disabled: busy || creating, onClick: () => setCreating(true) }, '＋ 添加角色'),
            nav.characterId && h(Button, { disabled: busy, onClick: () => { setNavigation({ characterId: null, tab: 'chat' }); refresh().catch(reportError); } }, '← 全部伙伴'))),
        error && h('div', { className: 'yy-alert yy-error', role: 'alert' }, h('span', null, error), h(Button, { small: true, disabled: busy, onClick: () => run(async () => { await refresh(); if (nav.characterId) await loadDetail(nav.characterId); }) }, '重试')),
        notice && h('div', { className: 'yy-alert yy-notice', role: 'status' }, notice),
        conflicts.length > 0 && h('div', { className: 'yy-alert yy-warning' }, conflicts.map((conflict, i) => {
          if (typeof conflict === 'string') return h('p', { key: i }, conflict);
          if (conflict.error || conflict.message) return h('p', { key: i }, conflict.error || conflict.message);
          const role = characters.find((character) => character.id === conflict.characterId);
          return h('p', { key: i }, `“${role?.name || conflict.characterId || '该角色'}”的会话 ${conflict.sessionId || ''} 与生活插件共用，请为该角色新建对话。`);
        })),
        loading && h('div', { className: 'yy-loading', role: 'status' }, '正在打开鱼塘…'),
        !loading && !snapshot && !error && h('div', { className: 'yy-empty-small' }, '暂时无法读取鱼塘。'),
        !loading && snapshot && !nav.characterId && h(React.Fragment, null,
          creating && h(CharacterForm, { busy, onError: reportError, onCancel: () => setCreating(false), onSave: (value) => run(async () => {
            const result = await mutate('character.create', value); const next = await refresh();
            const id = result.entity?.id || result.character?.id || next.characters.find((entry) => entry.name === value.name)?.id;
            setCreating(false); if (id) manage(id); showNotice('新伙伴已加入鱼塘');
          }) }),
          characters.length === 0 && !creating ? h('section', { className: 'yy-empty' }, h(PondArt), h('span', { className: 'yy-eyebrow' }, '你的鱼塘，等待第一位伙伴'), h('h2', null, '从一个名字开始'),
            h('p', null, '叫她小鱼，或任何你喜欢的名字。', h('br'), '人设可以慢慢写，回忆可以慢慢攒。'),
            h(Button, { primary: true, disabled: busy, onClick: () => setCreating(true) }, '＋ 添加第一位伙伴'),
            h('div', { className: 'yy-empty-notes' }, h('span', null, '独立人设'), h('span', null, '专属记忆'), h('span', null, '长久相处'))) :
            characters.length > 0 && h(React.Fragment, null,
              h('div', { className: 'yy-section-heading yy-list-heading' }, h('h2', null, '鱼塘里的伙伴'), h('span', { className: 'yy-hint' }, `${characters.length} 位伙伴`)),
              h('div', { className: 'yy-grid' }, characters.map((character) => h(CharacterCard, { key: character.id, character, bindings, sessionState: sessions, busy, onManage: manage, onChat: chat }))))),
        !loading && nav.characterId && !selected && !error && h('div', { className: 'yy-loading', role: 'status' }, '正在读取伙伴资料…'),
        selected && nav.characterId === selected.id && h(React.Fragment, null,
          h('div', { className: 'yy-profile' }, h('span', { className: 'yy-avatar', 'aria-hidden': true }, selected.avatar || '🐟'), h('div', null, h('h2', null, selected.name), h('p', { className: 'yy-muted' }, selected.persona ? '有自己的性格，也有你们的回忆' : '暂未设定人设，从日常相处开始'))),
          h('nav', { className: 'yy-tabs', 'aria-label': `${selected.name}的资料` }, tabs.map(([id, label]) => h('button', { type: 'button', key: id, className: `yy-tab ${nav.tab === id ? 'yy-active' : ''}`, 'aria-current': nav.tab === id ? 'page' : undefined, disabled: busy, onClick: () => setNavigation({ characterId: selected.id, tab: id }) }, label))),
          h('div', { className: 'yy-tab-body', key: `${selected.id}:${nav.tab}` },
            nav.tab === 'chat' && h(ChatList, { character: selected, bindings: detail.bindings || [], sessions, workspaces, workspaceId, setWorkspaceId, onChat: chat, busy }),
            nav.tab === 'persona' && h(PersonaEditor, { character: selected, busy, onSave: saveCharacter, onError: reportError }),
            nav.tab === 'memory' && h(Memories, { memories: detail.memories || [], busy,
              onSave: (value) => run(async () => { await mutate('memory.save', { ...value, characterId: selected.id }); await loadDetail(selected.id); showNotice('记忆已保存'); }),
              onDelete: (id) => run(async () => { await mutate('memory.delete', { characterId: selected.id, id }); await loadDetail(selected.id); showNotice('记忆已删除'); }) }),
            nav.tab === 'travel' && h(Travel, { key: selected.id, character: selected }),
            nav.tab === 'settings' && h(Settings, { character: selected, busy, onSave: saveCharacter,
              onExport: () => run(async () => { const result = await request(`/export?id=${encodeURIComponent(selected.id)}`); downloadJson(result.data, `yangyu-${selected.name.replace(/[\\/:*?"<>|]/g, '_')}.json`); showNotice('角色已导出'); }),
              onDelete: () => run(async () => { await mutate('character.delete', { id: selected.id }); setNavigation({ characterId: null, tab: 'chat' }); await refresh(); showNotice('角色已删除'); }) }))),
        snapshot && h('footer', { className: 'yy-footer' }, h(FishIcon, { size: 14 }), '养鱼 · 每一位伙伴，都有自己的故事')));
    }

    function CompanionBadge({ sessionId, openCharacter }) {
      const [character, setCharacter] = useState(null);
      useEffect(() => {
        let live = true;
        request('/state').then((state) => {
          const binding = (state.bindings || []).find((entry) => entry.sessionId === sessionId);
          if (live) setCharacter(binding ? (state.characters || []).find((entry) => entry.id === binding.characterId) || null : null);
        }).catch(() => { if (live) setCharacter(null); });
        return () => { live = false; };
      }, [sessionId]);
      if (!character) return null;
      return h('div', { className: 'yy-root yy-dock' }, h('button', { type: 'button', className: 'yy-badge', onClick: () => openCharacter(character.id), title: `查看${character.name}的人设与记忆` },
        h(FishIcon, { size: 15 }), h('span', null, `养鱼 · ${character.name}`), h('span', { className: 'yy-badge-memory' }, character.memoryEnabled === false ? '记忆已暂停' : '专属记忆'), h('span', { 'aria-hidden': true }, '↗')));
    }

    const CSS = `
.yy-root{--yy-accent:var(--dsw-alias-state-business-primary);--yy-bg:var(--dsw-alias-bg-base);--yy-text:var(--dsw-alias-label-primary);--yy-muted:var(--dsw-alias-label-secondary);--yy-line:var(--dsw-alias-border-l3);font-family:inherit;color:var(--yy-text);box-sizing:border-box;line-height:1.6;font-size:14px;min-width:0;height:100%;overflow:auto;background:var(--yy-bg)}
.yy-root *{box-sizing:border-box}.yy-root button,.yy-root input,.yy-root textarea,.yy-root select{font:inherit}.yy-page{max-width:1080px;margin:0 auto;padding:40px 40px 24px}.yy-header,.yy-section-heading{display:flex;justify-content:space-between;align-items:center;gap:20px}.yy-header{padding-bottom:30px;border-bottom:1px solid var(--yy-line);margin-bottom:30px}.yy-brand{display:flex;gap:13px;align-items:center}.yy-brand-icon{width:48px;height:48px;border-radius:16px;display:grid;place-items:center;background:color-mix(in srgb,var(--yy-accent) 9%,transparent);color:var(--yy-accent)}.yy-root h1,.yy-root h2,.yy-root h3,.yy-root p{margin:0}.yy-root h1{font-size:23px;letter-spacing:.12em;font-weight:650;line-height:1.3}.yy-brand p{font-size:12px;letter-spacing:.08em;color:var(--yy-muted);margin-top:4px}.yy-root h2{font-size:20px;font-weight:600;line-height:1.5}.yy-root h3{font-size:15px;font-weight:600}.yy-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.yy-center{justify-content:center}.yy-button{display:inline-flex;justify-content:center;align-items:center;gap:6px;padding:9px 16px;line-height:1.4;min-height:38px;border:1px solid var(--yy-line);border-radius:10px;background:transparent;color:var(--yy-text);cursor:pointer;white-space:nowrap;text-decoration:none;transition:background .15s,border-color .15s}.yy-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.yy-button.yy-primary{background:var(--yy-accent);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}.yy-button.yy-primary:hover:not(:disabled){filter:brightness(.94);background:var(--yy-accent)}.yy-button.yy-danger{color:var(--dsw-alias-state-error-primary,#c33)}.yy-button.yy-small{min-height:30px;padding:5px 10px;font-size:12px;border-radius:8px}.yy-button:disabled,.yy-disabled{opacity:.5;cursor:default}.yy-root :is(button,input,textarea,select):focus-visible,.yy-button:has(input:focus-visible){outline:2px solid var(--yy-accent);outline-offset:3px}.yy-file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip-path:inset(50%)}.yy-empty{text-align:center;padding:28px 16px 44px;max-width:550px;margin:0 auto}.yy-pond-art{width:240px;height:120px;color:var(--yy-accent);margin:0 auto 20px}.yy-eyebrow{display:block;font-size:11px;color:var(--yy-muted);letter-spacing:.14em;margin-bottom:8px}.yy-empty h2{font-size:30px;font-weight:550;letter-spacing:.03em}.yy-empty>p{color:var(--yy-muted);margin:18px 0 26px;line-height:1.9}.yy-empty-notes{display:flex;justify-content:center;gap:24px;margin-top:34px;font-size:12px;color:var(--yy-muted)}.yy-empty-notes span+span:before{content:'·';margin-right:24px;opacity:.5}.yy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(245px,1fr));gap:20px}.yy-list-heading{margin:30px 0 18px}.yy-list-heading h2{font-size:16px}.yy-card{border:1px solid var(--yy-line);border-radius:18px;padding:24px;display:flex;flex-direction:column;min-width:0;background:color-mix(in srgb,var(--yy-bg) 97%,var(--yy-accent) 3%)}.yy-card-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.yy-avatar{font-size:29px;width:58px;height:58px;display:flex;align-items:center;justify-content:center;border-radius:18px;background:color-mix(in srgb,var(--yy-accent) 8%,transparent);flex:none;overflow:hidden}.yy-card h2{font-size:19px;overflow-wrap:anywhere}.yy-pill{font-size:11px;padding:3px 9px;border:1px solid var(--yy-line);border-radius:20px;color:var(--yy-muted);white-space:nowrap}.yy-card-description{color:var(--yy-muted);font-size:13px;line-height:1.8;margin-top:9px!important;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;min-height:47px}.yy-card-meta{margin-top:20px!important;margin-bottom:17px!important}.yy-card-actions{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:auto}.yy-hint{font-size:12px;color:var(--yy-muted);font-weight:400;line-height:1.6}.yy-muted{color:var(--yy-muted);font-size:13px}.yy-editor{border:1px solid var(--yy-line);border-radius:16px;padding:24px}.yy-editor>p{margin-top:6px;margin-bottom:22px}.yy-create{margin-bottom:28px}.yy-create .yy-section-heading{margin-bottom:22px}.yy-field{display:flex;flex-direction:column;gap:7px;min-width:0;margin-bottom:18px;flex:1}.yy-label{font-size:13px;font-weight:500}.yy-input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid var(--yy-line);color:var(--yy-text);background:var(--yy-bg);outline:none;min-width:0;line-height:1.6}.yy-input::placeholder{color:var(--yy-muted);opacity:.75}.yy-input:focus{border-color:var(--yy-accent)}.yy-input:disabled{opacity:.55}.yy-root textarea{resize:vertical;min-height:110px;white-space:pre-wrap}.yy-root option{color:var(--yy-text);background:var(--yy-bg)}.yy-form-row{display:flex;gap:18px}.yy-form-row>.yy-field:first-child{flex:0 0 120px}.yy-avatar-input{font-size:21px!important;height:47px}.yy-persona-input{min-height:150px!important}.yy-persona-large{min-height:300px!important;font-size:13px!important}.yy-select{width:auto;max-width:100%}.yy-fieldset{border:0;padding:0;margin:0;min-width:0}.yy-import-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0 20px}.yy-import-tools .yy-select{font-size:12px;max-width:250px;padding:5px 10px}.yy-form-footer{justify-content:space-between;margin-top:22px}.yy-profile{display:flex;gap:18px;align-items:center;margin-bottom:26px}.yy-profile h2{font-size:24px;overflow-wrap:anywhere}.yy-profile p{margin-top:5px}.yy-tabs{display:flex;gap:30px;border-bottom:1px solid var(--yy-line);margin-bottom:30px}.yy-tab{border:0;border-bottom:2px solid transparent;background:transparent;padding:0 2px 12px;color:var(--yy-muted);cursor:pointer}.yy-tab:hover{color:var(--yy-text)}.yy-tab.yy-active{color:var(--yy-accent);border-bottom-color:var(--yy-accent);font-weight:600}.yy-tab:disabled{cursor:default;opacity:.6}.yy-tab-body{min-height:280px}.yy-stack{display:flex;flex-direction:column;gap:22px}.yy-section-heading>div>p{margin-top:6px}.yy-chat-welcome{text-align:center;padding:20px 10px 30px}.yy-avatar-large{width:70px;height:70px;font-size:36px;margin:0 auto 18px;border-radius:24px}.yy-chat-welcome h2{font-size:22px}.yy-chat-welcome>p{margin-top:9px;margin-bottom:24px}.yy-workspace{max-width:280px;font-size:12px!important}.yy-sessions{border:1px solid var(--yy-line);border-radius:13px;overflow:hidden}.yy-session{width:100%;display:flex;gap:14px;align-items:center;border:0;background:transparent;color:var(--yy-text);padding:16px 18px;text-align:left;cursor:pointer}.yy-session+.yy-session{border-top:1px solid var(--yy-line)}.yy-session:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.yy-session:disabled{opacity:.5;cursor:default}.yy-session-icon{color:var(--yy-accent);font-size:25px}.yy-session-info{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}.yy-session-info strong{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.yy-empty-small{padding:35px 18px;text-align:center;color:var(--yy-muted);border:1px dashed var(--yy-line);border-radius:13px}.yy-empty-small>span:first-child:not(.yy-hint){font-size:24px;color:var(--yy-accent);display:block;margin-bottom:8px}.yy-empty-small p{margin-bottom:5px}.yy-memory-toolbar{display:flex;gap:10px}.yy-memory-list{display:flex;flex-direction:column;gap:12px}.yy-memory{border:1px solid var(--yy-line);border-radius:13px;padding:18px}.yy-memory-text{white-space:pre-wrap;overflow-wrap:anywhere;margin-top:12px!important;font-size:14px;line-height:1.9}.yy-memory-foot{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:15px}.yy-memory-foot>.yy-hint{overflow-wrap:anywhere;min-width:0}.yy-important{font-size:11px;color:var(--yy-accent)}.yy-checkbox{display:flex;align-items:center;gap:7px;font-size:13px;cursor:pointer}.yy-root input[type=checkbox]{accent-color:var(--yy-accent)}.yy-toggle-row{display:flex;align-items:center;justify-content:space-between;gap:25px;padding:17px 0;border-bottom:1px solid var(--yy-line);cursor:pointer}.yy-toggle-row strong{display:block;font-size:13px;font-weight:500;margin-bottom:4px}.yy-toggle-row input{width:17px;height:17px;flex:none}.yy-export-row{display:flex;align-items:center;justify-content:space-between;gap:20px}.yy-export-row p{margin-top:7px}.yy-delete-area>p{margin-bottom:18px}.yy-delete-area h3{color:var(--dsw-alias-state-error-primary,#c33)}.yy-alert{border:1px solid var(--yy-line);padding:12px 15px;border-radius:10px;display:flex;gap:15px;align-items:center;justify-content:space-between;margin-bottom:20px;font-size:13px;overflow-wrap:anywhere}.yy-error{color:var(--dsw-alias-state-error-primary,#c33)}.yy-notice{color:var(--yy-accent);background:color-mix(in srgb,var(--yy-accent) 5%,transparent)}.yy-warning{display:block;color:var(--yy-muted)}.yy-warning p+p{margin-top:5px}.yy-loading{padding:70px 15px;text-align:center;color:var(--yy-muted)}.yy-footer{display:flex;justify-content:center;align-items:center;gap:8px;margin-top:48px;padding-top:20px;border-top:1px solid var(--yy-line);font-size:11px;color:var(--yy-muted);letter-spacing:.03em}.yy-root.yy-dock{background:transparent;height:auto;overflow:visible;padding:2px 0}.yy-badge{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--yy-line);border-radius:20px;background:transparent;color:var(--yy-text);padding:5px 10px;cursor:pointer;font-size:12px!important}.yy-badge>svg{color:var(--yy-accent)}.yy-badge-memory{font-size:10px;color:var(--yy-muted);padding-left:7px;border-left:1px solid var(--yy-line)}
@media(max-width:700px){.yy-page{padding:24px 18px}.yy-header{align-items:flex-start;gap:16px;flex-wrap:wrap}.yy-brand-icon{width:42px;height:42px}.yy-header>.yy-actions{width:100%}.yy-header>.yy-actions .yy-button{flex:1}.yy-grid{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}.yy-editor{padding:18px}.yy-section-heading{gap:12px;align-items:flex-start;flex-wrap:wrap}.yy-card{padding:20px}.yy-tabs{gap:24px}.yy-form-row{gap:12px}.yy-form-row>.yy-field:first-child{flex-basis:85px}.yy-form-footer{gap:14px}.yy-export-row{align-items:flex-start;flex-direction:column}.yy-memory-foot{flex-direction:column;align-items:flex-start}.yy-chat-welcome{padding:8px 0 18px}.yy-chat-welcome h2{font-size:19px}.yy-empty h2{font-size:26px}.yy-empty-notes{gap:12px}.yy-empty-notes span+span:before{margin-right:12px}.yy-workspace{max-width:100%}}
.yy-travel-heading{margin-bottom:24px}.yy-travel-heading .yy-eyebrow{letter-spacing:.06em}.yy-travel-heading p{line-height:1.8;margin-top:7px}.yy-travel-layout{display:grid;grid-template-columns:minmax(220px,.88fr) minmax(280px,1.12fr);gap:22px;align-items:stretch}.yy-platforms{display:flex;flex-direction:column;gap:15px;min-width:0}.yy-platform-card{border:1px solid var(--yy-line);border-radius:16px;padding:20px;background:color-mix(in srgb,var(--yy-bg) 96%,var(--yy-accent) 4%);transition:border-color .15s,background .15s}.yy-platform-card.yy-selected-platform{border-color:var(--yy-accent);background:color-mix(in srgb,var(--yy-bg) 93%,var(--yy-accent) 7%)}.yy-platform-select{display:flex;align-items:flex-start;gap:12px;width:100%;text-align:left;border:0;padding:0;color:var(--yy-text);background:transparent;cursor:pointer}.yy-platform-select:disabled{cursor:default}.yy-platform-icon{height:46px;width:46px;display:grid;place-items:center;border-radius:14px;flex:none;color:var(--yy-accent);background:color-mix(in srgb,var(--yy-accent) 10%,transparent)}.yy-platform-name{display:flex;flex-direction:column;gap:7px;min-width:0}.yy-platform-name strong{font-size:16px;line-height:1.4;font-weight:600}.yy-platform-name .yy-hint{font-size:12px;line-height:1.7}.yy-platform-card-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:19px;margin-top:18px;border-top:1px solid var(--yy-line)}.yy-platform-state{display:inline-flex;align-items:center;gap:6px;color:var(--yy-muted);font-size:11px;line-height:1.5}.yy-status-dot{height:5px;width:5px;flex:none;background:currentColor;border-radius:50%;opacity:.7}.yy-platform-state-connected{color:var(--yy-accent)}.yy-platform-state-error,.yy-platform-state-expired{color:var(--dsw-alias-state-error-primary,#c33)}.yy-connection-panel{display:flex;flex-direction:column;min-width:0;border:1px solid var(--yy-line);border-radius:17px;background:color-mix(in srgb,var(--yy-bg) 98%,var(--yy-accent) 2%);overflow:hidden}.yy-connection-heading{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:18px 21px;border-bottom:1px solid var(--yy-line)}.yy-connection-heading>span:first-child{display:inline-flex;align-items:center;gap:9px;font-size:13px}.yy-connection-heading>span:first-child svg{color:var(--yy-accent)}.yy-connection-heading strong{font-size:13px;font-weight:500}.yy-connection-online{color:var(--yy-accent);border-color:color-mix(in srgb,var(--yy-accent) 35%,transparent)}.yy-connection-body{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:13px;padding:30px 24px;min-height:374px;flex:1}.yy-connection-body>h3{font-size:16px;line-height:1.6}.yy-connection-body>.yy-hint{max-width:310px;line-height:1.8}.yy-qr-placeholder{height:164px;width:164px;display:grid;place-items:center;border-radius:22px;color:color-mix(in srgb,var(--yy-muted) 65%,transparent);background:color-mix(in srgb,var(--yy-accent) 4%,transparent);margin-bottom:5px}.yy-qr-spinner{transform-origin:center;animation:yy-qr-spin 1.4s linear infinite}@keyframes yy-qr-spin{to{transform:rotate(360deg)}}.yy-qr-paper{padding:16px;border:1px solid color-mix(in srgb,var(--yy-line) 70%,transparent);background:#fff;border-radius:13px;max-width:100%;line-height:0;box-shadow:0 7px 24px rgba(0,0,0,.03);margin-bottom:2px}.yy-qr-image{width:224px;height:224px;max-width:100%;object-fit:contain;aspect-ratio:1;display:block}.yy-qr-foot{width:100%;max-width:280px;display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap}.yy-qr-foot>.yy-hint{font-variant-numeric:tabular-nums;font-size:11px}.yy-qr-display-error{display:flex;flex-direction:column;align-items:center;gap:10px}.yy-qr-display-error>p{font-size:14px}.yy-platform-message{overflow-wrap:anywhere;white-space:pre-wrap}.yy-connection-note{font-size:11px;line-height:1.7;color:var(--yy-muted);border-top:1px solid var(--yy-line);padding:14px 20px;text-align:center}.yy-connection-note>span{display:block}.yy-connected-mark{display:grid;place-items:center;color:var(--yy-accent);background:color-mix(in srgb,var(--yy-accent) 9%,transparent);height:84px;width:84px;border-radius:50%;margin:6px 0 8px}.yy-account-summary{display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:1.7;overflow-wrap:anywhere}.yy-account-summary>span{color:var(--yy-muted);font-size:12px}.yy-travel-inline{max-width:100%;font-size:12px;margin:0;text-align:left}.yy-travel-confirm{border-top:1px solid var(--yy-line);margin-top:7px;padding-top:16px;display:flex;flex-direction:column;gap:14px;width:100%}.yy-travel-confirm>p{font-size:12px;line-height:1.8;color:var(--yy-muted)}.yy-travel-memory-note{margin-top:18px!important;line-height:1.8}
@media(max-width:800px){.yy-travel-layout{grid-template-columns:1fr}.yy-platforms{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.yy-platform-card{padding:16px}.yy-platform-select{flex-direction:column;gap:12px}.yy-platform-card-foot{align-items:flex-start;flex-direction:column;gap:12px;margin-top:15px;padding-top:13px}.yy-platform-card-foot .yy-button{width:100%}.yy-connection-body{min-height:340px}.yy-travel-heading .yy-eyebrow{font-size:10px}.yy-tabs{gap:24px;overflow-x:auto}.yy-tab{white-space:nowrap;flex:none}}
@media(max-width:400px){.yy-platform-card{padding:13px}.yy-platform-icon{height:40px;width:40px;border-radius:12px}.yy-platform-name .yy-hint{font-size:11px}.yy-connection-body{padding:25px 18px}.yy-qr-paper{padding:12px}.yy-qr-image{width:204px;height:204px}.yy-connection-heading{padding:15px}.yy-platform-state{font-size:10px}}
.yy-verification-form{width:100%;max-width:320px;border-top:1px solid var(--yy-line);padding-top:18px;margin-top:4px;text-align:left}.yy-verification-form>.yy-field{margin-bottom:14px}.yy-verification-input{text-align:center;font-variant-numeric:tabular-nums;font-size:16px!important;letter-spacing:.15em}.yy-verification-input::placeholder{font-size:12px;letter-spacing:0}.yy-verification-form>.yy-button{width:100%}
@media(prefers-reduced-motion:reduce){.yy-root *{transition:none!important;animation:none!important}}
`;

    const inject = ['slots', 'locale', 'layout', 'sessions', 'workspaces', 'uiWorkspace'];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: { nav: '养鱼' }, en: { nav: '养鱼' } }), 'yangyu: dictionaries');
      ctx.effect(() => {
        const style = document.createElement('style'); style.dataset.plugin = 'dsh-yangyu'; style.textContent = CSS; document.head.appendChild(style);
        return () => { style.remove(); navigationListeners.clear(); pendingSessions.clear(); csrfToken = ''; };
      }, 'yangyu: styles');
      const openCharacter = (id) => { setNavigation({ characterId: id, tab: 'memory' }); ctx.layout.selectPanel('yangyu'); };
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'yangyu', locale: NS,
        inject: () => ({
          createSession: (workspaceId) => ctx.sessions.create({ workspaceId }),
          openSession: (id) => ctx.uiWorkspace.openSession(id),
        }),
      }, Page));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'yangyu', order: 20, locale: NS, label: () => '养鱼' }, FishIcon));
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'yangyu-companion', order: 45, locale: NS, inject: () => ({ openCharacter }) }, CompanionBadge));
      ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({ name: 'conversation.hero.options', id: 'yangyu-companion-hero', order: 45, locale: NS, inject: () => ({ openCharacter }) }, CompanionBadge));
    }
    return { inject, apply, Page, Travel, FishIcon, NS, CSS };
  },
});
