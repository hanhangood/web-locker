import {
  send, toast, faviconUrl, escapeHtml, openDialog,
  askNewPassword, authErrorText, timeAgo
} from './lib/ui.js';

const $ = sel => document.querySelector(sel);

const S = { hasAuth: false, locks: [], settings: {}, stats: {}, admin: false };
let roots = [];
const expanded = new Set();
let keyword = '';
let currentPane = 'locks';

/* ============================================================ 启动 */

async function boot() {
  await refresh();
  // 管理页每次打开都重新验证，不复用上一次的放行
  S.admin = false;

  if (!S.hasAuth) {
    await firstRun();
    setGate(!S.admin);
  } else {
    const ok = await ensureAdmin('管理锁定清单需要密码');
    setGate(!ok);
  }

  await loadBookmarks();
  renderAll();
}

function setGate(locked) {
  const gate = $('#gate');
  if (gate) gate.hidden = !locked;
}

async function refresh() {
  const res = await send({ type: 'get-state' });
  if (!res.ok) return;
  Object.assign(S, res);
}

async function firstRun() {
  const data = await askNewPassword({ title: '设置密码' });
  if (!data) { toast('还没设密码，暂时不能加锁'); return; }
  const res = await send({ type: 'set-password', password: data.password });
  if (res.ok) {
    S.hasAuth = true;
    S.admin = true;
    toast('密码已设置');
  } else {
    toast(authErrorText(res));
  }
}

function ensureAdmin(tip) {
  if (S.admin) return Promise.resolve(true);
  if (!S.hasAuth) {
    return firstRun().then(() => S.admin);
  }
  return openDialog({
    title: '需要密码',
    body: `
      <p class="wl-dialog-tip">${escapeHtml(tip || '这个操作需要密码')}</p>
      <input class="s-textfield" type="password" placeholder="密码" autocomplete="current-password">
      <p class="wl-error"></p>`,
    buttons: [
      { label: '取消', value: false },
      {
        label: '解锁', primary: true,
        onClick: (bodyEl, close) => {
          const input = bodyEl.querySelector('input');
          const errEl = bodyEl.querySelector('.wl-error');
          const pw = input.value.trim();
          if (!pw) { errEl.textContent = '请输入密码'; return false; }
          send({ type: 'verify', password: pw }).then(res => {
            if (res.ok) { S.admin = true; close(true); }
            else errEl.textContent = authErrorText(res);
          });
          return false;
        }
      }
    ]
  }).then(v => v === true);
}

/* ============================================================ 数据 */

async function loadBookmarks() {
  const res = await send({ type: 'bookmarks' });
  if (!res.ok) return;
  roots = res.roots || [];
  roots.forEach(r => expanded.add(r.id));
}

function renderAll() {
  renderLocks();
  renderTree();
  renderSettings();
}

/* ============================================================ 锁定清单 */

function modeLabel(mode) {
  return mode === 'domain' ? '整站' : mode === 'prefix' ? '前缀' : '单页';
}

function lockTitle(lock) {
  if (lock.kind === 'folder' || lock.kind === 'vault') return lock.folderName || '收藏夹文件夹';
  return lock.title || lock.host || lock.url;
}

function lockSubtitle(lock) {
  if (lock.kind === 'vault') return `整个文件夹 · 书签已隐藏`;
  if (lock.kind === 'folder') return `整个文件夹 · ${modeLabel(lock.mode)}`;
  return `${lock.host || ''} · ${modeLabel(lock.mode)}`;
}

function lockIcon(lock) {
  if (lock.kind === 'folder' || lock.kind === 'vault') {
    const color = lock.kind === 'vault' ? '#5b87eb' : '#929292';
    return `<svg class="s-icon wl-favicon" style="color:${color}"><use href="#si-folder"/></svg>`;
  }
  return `<img class="wl-favicon" src="${faviconUrl(lock.url, 32)}" alt="">`;
}

function renderLocks() {
  const list = $('#lock-list');
  const empty = $('#lock-empty');
  const hint = $('#lock-hint');

  if (!S.locks.length) {
    list.hidden = true;
    list.innerHTML = '';
    empty.hidden = false;
    hint.textContent = '';
    return;
  }

  list.hidden = false;
  empty.hidden = true;

  list.innerHTML = S.locks.map(lock => {
    const right = lock.kind === 'vault'
      ? `<button class="s-btn s-btn--text" data-restore="${escapeHtml(lock.id)}">恢复</button>`
      : `<input type="checkbox" class="s-switch" data-toggle="${escapeHtml(lock.id)}" ${lock.enabled === false ? '' : 'checked'}>`;
    return `
    <li class="s-list-item" data-pressable data-lock-id="${escapeHtml(lock.id)}" style="cursor:pointer">
      ${lockIcon(lock)}
      <div class="s-list-item__text">
        <div class="s-list-item__title wl-ellipsis">${escapeHtml(lockTitle(lock))}</div>
        <div class="s-list-item__subtitle wl-ellipsis">${escapeHtml(lockSubtitle(lock))}</div>
      </div>
      ${right}
    </li>`;
  }).join('');

  list.querySelectorAll('[data-restore]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      restoreVault(btn.getAttribute('data-restore'));
    });
  });

  list.querySelectorAll('.s-switch').forEach(sw => {
    sw.addEventListener('click', e => e.stopPropagation());
    sw.addEventListener('change', e => {
      e.stopPropagation();
      toggleLock(sw.getAttribute('data-toggle'), sw.checked);
    });
  });

  list.querySelectorAll('[data-lock-id]').forEach(row => {
    row.addEventListener('click', () => openLockDetail(row.getAttribute('data-lock-id')));
  });

  const active = S.locks.filter(l => l.enabled !== false).length;
  hint.textContent = active === S.locks.length
    ? `共 ${S.locks.length} 项正在保护`
    : `共 ${S.locks.length} 项，其中 ${active} 项生效`;
}

async function openLockDetail(id) {
  const lock = S.locks.find(l => l.id === id);
  if (!lock) return;
  if (!await ensureAdmin()) return;

  if (lock.kind === 'vault') {
    const action = await openDialog({
      title: '这一项',
      body: `
        <p class="wl-dialog-tip" style="color:var(--s-grey-800);font-weight:600">${escapeHtml(lockTitle(lock))}</p>
        <p class="wl-dialog-tip">书签已经搬进「其他收藏夹 → 已上锁」，原文件夹里只留了一个解锁入口。</p>
        <p class="wl-dialog-tip" style="font-size:12px;color:var(--s-subtitle-other)">共 ${(lock.urls || []).length} 个书签，只是被移走，没有删除。</p>`,
      buttons: [
        { label: '关闭', value: null },
        { label: '恢复书签', primary: true, value: 'restore' }
      ]
    });
    if (action === 'restore') await restoreVault(id);
    return;
  }

  const action = await openDialog({
    title: '这一项',
    body: `
      <p class="wl-dialog-tip" style="color:var(--s-grey-800);font-weight:600">${escapeHtml(lockTitle(lock))}</p>
      <p class="wl-dialog-tip">${escapeHtml(lock.kind === 'folder' ? '锁住了整个文件夹里的书签，之后新增的也包含在内。' : lock.url)}</p>
      <p class="wl-dialog-tip" style="font-size:12px;color:var(--s-subtitle-other)">范围：${modeLabel(lock.mode)}</p>`,
    buttons: [
      { label: '关闭', value: null },
      { label: '移除锁定', primary: true, value: 'remove' }
    ]
  });

  if (action === 'remove') await removeLock(id, lockTitle(lock));
}

async function removeLock(id, title) {
  if (!await ensureAdmin()) return;
  const res = await send({ type: 'remove-lock', id });
  if (!res.ok) { toast(authErrorText(res)); return; }
  toast('已移除');
  await refresh();
  renderAll();
}

async function toggleLock(id, enabled) {
  if (!await ensureAdmin()) { renderLocks(); return; }
  const res = await send({ type: 'update-lock', id, patch: { enabled } });
  if (!res.ok) { toast(authErrorText(res)); await refresh(); }
  else toast(enabled ? '已启用' : '已暂停');
  await refresh();
  renderAll();
}

/* ============================================================ 收藏夹树 */

function countUrls(node) {
  if (node.url) return node.url.includes('#vault=') ? 0 : 1;
  return (node.children || []).reduce((n, k) => n + countUrls(k), 0);
}

function matchesKeyword(node) {
  if (!keyword) return true;
  const q = keyword.toLowerCase();
  if (node.url) return (node.title + ' ' + node.url).toLowerCase().includes(q);
  return (node.children || []).some(matchesKeyword);
}

function folderLockOf(folderId) {
  return S.locks.find(l =>
    (l.kind === 'folder' || l.kind === 'vault') &&
    l.folderId === folderId &&
    l.enabled !== false
  );
}

function urlLockOf(url) {
  return S.locks.find(l => l.kind === 'url' && l.url === url && l.enabled !== false);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function folderRow(node, pad, open, locked, count) {
  const title = node.title || '未命名文件夹';
  const color = locked ? '#5b87eb' : '#a8a8a8';
  return `
    <li class="s-list-item wl-tree-item" data-folder="${escapeHtml(node.id)}" style="padding-left:${pad}px;gap:12px;cursor:pointer">
      <svg class="s-icon s-icon--16" style="color:var(--s-icon-chevron);transform:rotate(${open ? 90 : 0}deg);transition:transform .15s"><use href="#si-chevron-right"/></svg>
      <svg class="s-icon" style="color:${color}"><use href="#si-folder"/></svg>
      <div class="s-list-item__text">
        <div class="s-list-item__title wl-ellipsis">${escapeHtml(title)}</div>
        <div class="s-list-item__subtitle">${count} 个书签${locked ? ' · 已整夹上锁' : ''}</div>
      </div>
      <button class="wl-row-btn" data-lock-folder="${escapeHtml(node.id)}" data-name="${escapeHtml(title)}" title="${locked ? '这个文件夹已锁' : '锁整个文件夹'}">
        <svg class="s-icon" style="color:${color}"><use href="#si-lock${locked ? '' : '-open'}"/></svg>
      </button>
    </li>`;
}

function bookmarkRow(node, pad, locked) {
  const color = locked ? '#5b87eb' : '#a8a8a8';
  const title = node.title || hostOf(node.url);
  return `
    <li class="s-list-item wl-tree-item" data-bookmark-url="${escapeHtml(node.url)}" data-bookmark-title="${escapeHtml(title)}" style="padding-left:${pad}px;gap:12px;cursor:pointer">
      <img class="wl-favicon" src="${faviconUrl(node.url, 32)}" alt="">
      <div class="s-list-item__text">
        <div class="s-list-item__title wl-ellipsis">${escapeHtml(title)}</div>
        <div class="s-list-item__subtitle wl-ellipsis">${escapeHtml(hostOf(node.url))}</div>
      </div>
      <button class="wl-row-btn" title="${locked ? '已在锁定范围内' : '锁定这个网页'}">
        <svg class="s-icon" style="color:${color}"><use href="#si-lock${locked ? '' : '-open'}"/></svg>
      </button>
    </li>`;
}

function collectRows(node, depth, rows, inheritedLocked) {
  if (!matchesKeyword(node)) return;
  const pad = 14 + depth * 16;

  if (node.url) {
    // 保险箱留下的替身书签不显示，文件夹行本身已经标明"已整夹上锁"
    if (node.url.includes('#vault=')) return;
    rows.push(bookmarkRow(node, pad, inheritedLocked || !!urlLockOf(node.url)));
    return;
  }

  const selfLocked = !!folderLockOf(node.id);
  const open = !!keyword || expanded.has(node.id);
  rows.push(folderRow(node, pad, open, selfLocked, countUrls(node)));

  if (open) {
    const locked = inheritedLocked || selfLocked;
    for (const kid of node.children || []) collectRows(kid, depth + 1, rows, locked);
  }
}

function renderTree() {
  const list = $('#marks-tree');
  if (!roots.length) {
    list.innerHTML = `<li class="wl-empty"><div class="wl-empty__title">读不到收藏夹</div><div class="wl-empty__desc">请在扩展设置里允许访问收藏夹后重试。</div></li>`;
    return;
  }
  const rows = [];
  for (const root of roots) collectRows(root, 0, rows, false);
  list.innerHTML = rows.length
    ? rows.join('')
    : `<li class="wl-empty"><div class="wl-empty__title">没有匹配的收藏</div></li>`;
}

async function chooseMode() {
  return openDialog({
    title: '锁定范围',
    body: `
      <p class="wl-dialog-tip">决定这个地址被锁住的范围：</p>
      <div class="wl-choices">
        <button class="wl-choice is-on" data-mode="domain">整个网站</button>
        <button class="wl-choice" data-mode="prefix">此地址开头</button>
        <button class="wl-choice" data-mode="exact">仅这一个地址</button>
      </div>`,
    buttons: [
      { label: '取消', value: null },
      {
        label: '上锁', primary: true,
        onClick: (bodyEl, close) => {
          const on = bodyEl.querySelector('.wl-choice.is-on');
          close(on ? on.dataset.mode : 'domain');
          return false;
        }
      }
    ],
    onMount: bodyEl => {
      bodyEl.querySelectorAll('.wl-choice').forEach(btn => {
        btn.addEventListener('click', () => {
          bodyEl.querySelectorAll('.wl-choice').forEach(x => x.classList.toggle('is-on', x === btn));
        });
      });
    }
  });
}

async function addUrlLock(url, title) {
  if (!/^https?:/i.test(url)) { toast('只能锁定网页地址'); return; }
  if (!await ensureAdmin()) return;
  const mode = await chooseMode();
  if (!mode) return;
  const res = await send({ type: 'add-lock', kind: 'url', mode, url, title });
  if (!res.ok) { toast(authErrorText(res)); return; }
  toast('已上锁');
  await refresh();
  renderAll();
}

async function addFolderLock(folderId, name) {
  if (folderLockOf(folderId)) { toast('这个文件夹已经锁上了'); return; }
  if (!await ensureAdmin()) return;

  const node = findNode(roots, folderId);
  const count = node ? countUrls(node) : 0;

  const mode = await openDialog({
    title: '锁定「' + (name || '文件夹') + '」',
    body: `
      <p class="wl-dialog-tip">里面 ${count} 个书签，选一种锁法：</p>
      <label class="s-radio-item" style="height:auto;padding:12px 16px;align-items:flex-start">
        <span>
          <span style="font-size:14px">拦截访问</span>
          <span class="wl-radio-desc">书签留在原位，点开会跳到密码页</span>
        </span>
        <input type="radio" class="s-radio" name="fmode" value="guard" checked style="margin-top:3px">
      </label>
      <label class="s-radio-item" style="height:auto;padding:12px 16px;align-items:flex-start">
        <span>
          <span style="font-size:14px">隐藏书签</span>
          <span class="wl-radio-desc">书签搬进「其他收藏夹 → 已上锁」，原文件夹只剩一个解锁入口</span>
        </span>
        <input type="radio" class="s-radio" name="fmode" value="vault" style="margin-top:3px">
      </label>`,
    buttons: [
      { label: '取消', value: null },
      {
        label: '上锁', primary: true,
        onClick: (bodyEl, close) => {
          const on = bodyEl.querySelector('input[name="fmode"]:checked');
          close(on ? on.value : 'guard');
          return false;
        }
      }
    ]
  });
  if (!mode) return;

  if (mode === 'vault') {
    const res = await send({ type: 'vault-lock', folderId, folderName: name });
    if (!res.ok) { toast(authErrorText(res)); return; }
    toast(`已上锁，${res.moved ?? count} 个书签收进保险箱`);
    await refresh();
    await loadBookmarks();
    renderAll();
    return;
  }

  const res = await send({ type: 'add-lock', kind: 'folder', folderId, folderName: name, mode: 'domain' });
  if (!res.ok) { toast(authErrorText(res)); return; }
  toast('整个文件夹已上锁');
  await refresh();
  renderAll();
}

/** 保险箱解锁：把书签搬回原位 */
async function restoreVault(id) {
  const lock = S.locks.find(l => l.id === id);
  if (!lock || lock.kind !== 'vault') return;
  if (!await ensureAdmin()) return;

  const ok = await openDialog({
    title: '恢复书签',
    body: `
      <p class="wl-dialog-tip">把「${escapeHtml(lock.folderName || '文件夹')}」里的书签放回原来的文件夹，同时解除锁定。</p>
      <p class="wl-dialog-tip" style="font-size:12px;color:var(--s-subtitle-other)">这些书签一直存在「其他收藏夹 → 已上锁」里，没有被删除。</p>`,
    buttons: [
      { label: '取消', value: false },
      { label: '恢复', primary: true, value: true }
    ]
  });
  if (ok !== true) return;

  const res = await send({ type: 'vault-unlock', folderId: lock.folderId });
  if (!res.ok) { toast(authErrorText(res)); return; }
  toast(`已恢复 ${res.restored || 0} 个书签`);
  await refresh();
  await loadBookmarks();
  renderAll();
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

/* ============================================================ 设置 */

const GRACE_OPTIONS = [
  { value: 0, label: '每次都要输密码' },
  { value: 5, label: '5 分钟内免密' },
  { value: 15, label: '15 分钟内免密' },
  { value: 30, label: '30 分钟内免密' },
  { value: 60, label: '60 分钟内免密' }
];

function renderSettings() {
  const grace = S.settings.graceMinutes || 0;
  $('#grace-val').textContent = grace ? `${grace} 分钟` : '每次都要输';
  $('#sw-badge').checked = !!S.settings.badge;

  const total = S.locks.length;
  const active = S.locks.filter(l => l.enabled !== false).length;
  const parts = [`共 ${total} 项锁定，${active} 项生效`];
  if (S.stats?.unlockCount) parts.push(`累计解锁 ${S.stats.unlockCount} 次`);
  if (S.stats?.lastUnlockAt) parts.push(`最近一次 ${timeAgo(S.stats.lastUnlockAt)}`);
  $('#stats-line').textContent = parts.join(' · ');
}

async function changePassword() {
  if (!await ensureAdmin()) return;
  const data = await askNewPassword({ title: '修改密码', requireOld: true });
  if (!data) return;
  const res = await send({ type: 'change-password', oldPassword: data.oldPassword, newPassword: data.password });
  if (!res.ok) { toast(res.code === 'BAD_PASSWORD' ? '原密码不正确' : authErrorText(res)); return; }
  toast('密码已更新');
}

async function pickGrace() {
  if (!await ensureAdmin()) return;
  const current = S.settings.graceMinutes || 0;
  const picked = await openDialog({
    title: '解锁后免密',
    body: GRACE_OPTIONS.map(o => `
      <label class="s-radio-item">
        <span>${o.label}</span>
        <input type="radio" class="s-radio" name="grace" value="${o.value}" ${o.value === current ? 'checked' : ''}>
      </label>`).join(''),
    buttons: [{ label: '取消', value: null }],
    onMount: (bodyEl, close) => {
      bodyEl.querySelectorAll('input[name="grace"]').forEach(input => {
        input.addEventListener('change', () => close(Number(input.value)));
      });
    }
  });
  if (picked === null || picked === undefined) return;

  const res = await send({ type: 'update-settings', patch: { graceMinutes: picked } });
  if (!res.ok) { toast(authErrorText(res)); return; }
  await refresh();
  renderSettings();
  toast(picked ? `已设为 ${picked} 分钟内免密` : '已改为每次都要输密码');
}

async function toggleBadge(checked) {
  if (!await ensureAdmin()) { $('#sw-badge').checked = !checked; return; }
  const res = await send({ type: 'update-settings', patch: { badge: checked } });
  if (!res.ok) { toast(authErrorText(res)); $('#sw-badge').checked = !checked; return; }
  await refresh();
}

async function clearLocks() {
  if (!await ensureAdmin()) return;
  const ok = await openDialog({
    title: '清空全部锁定',
    body: '<p class="wl-dialog-tip">锁定清单会被清空，密码保留。这一步不能撤销。</p>',
    buttons: [
      { label: '取消', value: false },
      { label: '清空', primary: true, value: true }
    ]
  });
  if (ok !== true) return;
  const res = await send({ type: 'clear-locks' });
  if (!res.ok) { toast(authErrorText(res)); return; }
  toast('已清空');
  await refresh();
  renderAll();
}

async function forgetPassword() {
  await openDialog({
    title: '忘记密码',
    body: `
      <p class="wl-dialog-tip">密码只用哈希保存，没有任何后门可以找回。</p>
      <p class="wl-dialog-tip">唯一的办法：移除这个扩展再重新安装，然后重新设置密码、重新加锁。</p>
      <p class="wl-dialog-tip" style="font-size:12px;color:var(--s-subtitle-other)">也正因为这样，把扩展删掉并不能"偷偷解开"你的锁 —— 所有配置会一起消失。</p>`,
    buttons: [{ label: '知道了', primary: true }]
  });
}

/* ============================================================ 事件绑定 */

document.querySelectorAll('#tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    currentPane = btn.dataset.pane;
    document.querySelectorAll('#tabs button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.pane === currentPane));
    });
    ['locks', 'marks', 'settings'].forEach(name => {
      document.getElementById('pane-' + name).hidden = name !== currentPane;
    });
  });
});

$('#marks-tree').addEventListener('click', e => {
  const folderLockBtn = e.target.closest('[data-lock-folder]');
  if (folderLockBtn) {
    e.stopPropagation();
    addFolderLock(folderLockBtn.getAttribute('data-lock-folder'), folderLockBtn.getAttribute('data-name'));
    return;
  }

  const folderRowEl = e.target.closest('[data-folder]');
  if (folderRowEl) {
    const id = folderRowEl.getAttribute('data-folder');
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    renderTree();
    return;
  }

  const bookmarkEl = e.target.closest('[data-bookmark-url]');
  if (bookmarkEl) {
    addUrlLock(bookmarkEl.getAttribute('data-bookmark-url'), bookmarkEl.getAttribute('data-bookmark-title'));
  }
});

let filterTimer = null;
$('#mark-filter').addEventListener('input', e => {
  clearTimeout(filterTimer);
  const value = e.target.value.trim();
  filterTimer = setTimeout(() => {
    keyword = value;
    renderTree();
  }, 150);
});

$('#row-change-pw').addEventListener('click', changePassword);
$('#row-grace').addEventListener('click', pickGrace);
$('#sw-badge').addEventListener('change', e => toggleBadge(e.target.checked));
$('#row-reset').addEventListener('click', clearLocks);
$('#row-forget').addEventListener('click', forgetPassword);

$('#btn-relock').addEventListener('click', async () => {
  await send({ type: 'admin-close' });
  S.admin = false;
  setGate(true);
  const ok = await ensureAdmin('管理锁定清单需要密码');
  setGate(!ok);
  if (!ok) toast('管理界面已上锁');
});

$('#btn-gate-open').addEventListener('click', async () => {
  const ok = await ensureAdmin('输入密码以进入管理界面');
  if (!ok) return;
  setGate(false);
  await loadBookmarks();
  renderAll();
});

boot();
