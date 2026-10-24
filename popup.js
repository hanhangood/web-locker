import { send, toast, faviconUrl, escapeHtml, askPassword, authErrorText } from './lib/ui.js';

const $ = sel => document.querySelector(sel);

const S = { hasAuth: false, locks: [], settings: {}, admin: false };
let tab = null;
let addMode = 'domain';
let lockTimer = null;

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  // 每次打开扩展都从「未解锁」开始：先撤掉上一次的管理会话，
  // 这样别人点开图标看到的一定是密码页，而不是你的锁定清单。
  await send({ type: 'admin-close' });
  S.admin = false;

  const res = await send({ type: 'get-state' });
  if (!res.ok) {
    show('setup');
    return;
  }
  Object.assign(S, res);
  S.admin = false;

  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active || null;
  } catch { tab = null; }

  if (!S.hasAuth) {
    show('setup');
    return;
  }

  show('lock');
  focusLater('#lock-pw');
}

function focusLater(sel) {
  setTimeout(() => { try { $(sel)?.focus(); } catch { } }, 40);
}

function show(name) {
  ['setup', 'lock', 'main', 'add'].forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.hidden = v !== name;
  });
  const relockBtn = $('#btn-lock-now');
  if (relockBtn) relockBtn.hidden = name !== 'main';
  if (name !== 'main') clearInterval(lockTimer);
}

/* ------------------------------------------------------- 打开扩展的密码门 */

function shakeBadge() {
  const badge = document.querySelector('#view-lock .wl-lock-badge');
  if (!badge) return;
  badge.classList.remove('wl-shake');
  void badge.offsetWidth;
  badge.classList.add('wl-shake');
  setTimeout(() => badge.classList.remove('wl-shake'), 400);
}

function countdownLocked(until) {
  clearInterval(lockTimer);
  const btn = $('#btn-unlock-popup');
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(lockTimer);
      btn.disabled = false;
      btn.textContent = '解锁';
      $('#lock-err').textContent = '可以再试了';
      return;
    }
    btn.disabled = true;
    btn.textContent = `${left} 秒后可再试`;
  };
  tick();
  lockTimer = setInterval(tick, 500);
}

async function unlockPopup() {
  const input = $('#lock-pw');
  const err = $('#lock-err');
  const password = input.value.trim();
  if (!password) { err.textContent = '请输入密码'; input.focus(); return; }

  const btn = $('#btn-unlock-popup');
  btn.disabled = true;
  btn.textContent = '验证中…';
  const res = await send({ type: 'verify', password });
  btn.disabled = false;
  btn.textContent = '解锁';

  if (!res.ok) {
    err.textContent = authErrorText(res);
    shakeBadge();
    input.select();
    if (res.code === 'LOCKED' && res.until) countdownLocked(res.until);
    return;
  }

  err.textContent = '';
  input.value = '';
  S.admin = true;
  show('main');
  await renderMain();
}

async function relock() {
  await send({ type: 'admin-close' });
  S.admin = false;
  $('#lock-pw').value = '';
  $('#lock-err').textContent = '';
  show('lock');
  focusLater('#lock-pw');
}

/* --------------------------------------------------------------- 主界面 */

async function renderMain() {
  const url = tab?.url || '';
  const isWeb = /^https?:/i.test(url);

  $('#cur-fav').src = isWeb ? faviconUrl(url, 32) : '';
  $('#cur-fav').style.visibility = isWeb ? 'visible' : 'hidden';
  $('#cur-title').textContent = tab?.title || (isWeb ? url : '不是网页');
  $('#cur-host').textContent = isWeb ? hostOf(url) : '这个页面没办法加锁';

  const btnAdd = $('#btn-add');
  if (!isWeb) {
    btnAdd.setAttribute('aria-disabled', 'true');
    btnAdd.disabled = true;
  } else {
    btnAdd.removeAttribute('aria-disabled');
    btnAdd.disabled = false;
  }

  const chip = $('#cur-state');
  if (isWeb) {
    const res = await send({ type: 'check-url', url });
    const locked = !!(res.ok && res.locked);
    chip.textContent = locked ? '已锁' : '未锁';
    chip.className = 's-chip ' + (locked ? 's-chip--blue' : 's-chip--grey');
    btnAdd.textContent = locked ? '再锁一次（换个范围）' : '锁定此网页';
  } else {
    chip.textContent = '—';
    chip.className = 's-chip s-chip--grey';
  }

  renderLocks();
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function renderLocks() {
  const list = $('#lock-list');
  const empty = $('#lock-empty');
  const desc = $('#lock-desc');
  const items = S.locks.slice(0, 6);

  if (!S.locks.length) {
    list.hidden = true;
    list.innerHTML = '';
    empty.hidden = false;
    desc.textContent = '';
    return;
  }

  list.hidden = false;
  empty.hidden = true;
  list.innerHTML = items.map(lock => {
    const isVault = lock.kind === 'vault';
    const isFolderLike = lock.kind === 'folder' || isVault;
    const title = isFolderLike ? lock.folderName : (lock.title || hostOf(lock.url));
    const sub = isVault ? '书签已隐藏' : isFolderLike ? '整个文件夹' : lockSub(lock);
    const icon = isFolderLike
      ? `<svg class="s-icon wl-favicon" style="color:${isVault ? '#5b87eb' : '#929292'}"><use href="#si-folder"/></svg>`
      : `<img class="wl-favicon" src="${faviconUrl(lock.url, 32)}" alt="">`;
    return `
      <li class="s-list-item">
        ${icon}
        <div class="s-list-item__text">
          <div class="s-list-item__title wl-ellipsis">${escapeHtml(title)}</div>
          <div class="s-list-item__subtitle wl-ellipsis">${escapeHtml(sub)}</div>
        </div>
        <button class="s-btn s-btn--text" data-unlock="${escapeHtml(lock.id)}">${isVault ? '恢复' : '解锁'}</button>
      </li>`;
  }).join('');

  const locked = S.locks.filter(l => l.enabled !== false).length;
  desc.textContent = S.locks.length > items.length
    ? `共 ${locked} 项已启用，到管理页看全部`
    : `${locked} 项已启用`;

  list.querySelectorAll('[data-unlock]').forEach(btn => {
    btn.addEventListener('click', () => removeLock(btn.getAttribute('data-unlock')));
  });
}

function lockSub(lock) {
  const modeText = lock.mode === 'domain' ? '整站' : lock.mode === 'prefix' ? '前缀' : '单页';
  return `${lock.host || hostOf(lock.url)} · ${modeText}`;
}

async function removeLock(id) {
  const lock = S.locks.find(l => l.id === id);
  const isVault = lock?.kind === 'vault';

  let password = '';
  if (!S.admin) {
    const pw = await askPassword({
      tip: isVault ? '把书签放回文件夹需要密码' : '解除锁定同样需要密码',
      title: isVault ? '恢复书签' : '解锁这一项'
    });
    if (pw === undefined) return;
    password = pw;
  }

  const res = isVault
    ? await send({ type: 'vault-unlock', folderId: lock.folderId, password })
    : await send({ type: 'remove-lock', id, password });

  if (!res.ok) {
    if (res.code === 'NEED_PASSWORD') { await relock(); toast('请先输入密码'); return; }
    toast(authErrorText(res));
    if (res.code === 'BAD_PASSWORD' && !S.admin) return removeLock(id);
    return;
  }

  S.locks = S.locks.filter(l => l.id !== id);
  toast(isVault ? `已恢复 ${res.restored || 0} 个书签` : '已解锁');
  renderLocks();
  renderCurrentChip();
}

async function renderCurrentChip() {
  const url = tab?.url || '';
  if (!/^https?:/i.test(url)) return;
  const res = await send({ type: 'check-url', url });
  const locked = !!(res.ok && res.locked);
  const chip = $('#cur-state');
  chip.textContent = locked ? '已锁' : '未锁';
  chip.className = 's-chip ' + (locked ? 's-chip--blue' : 's-chip--grey');
}

/* --------------------------------------------------------------- 加锁流程 */

function enterAdd() {
  if (!/^https?:/i.test(tab?.url || '')) return;
  addMode = 'domain';
  $('#add-fav').src = faviconUrl(tab.url, 32);
  $('#add-title').textContent = tab.title || hostOf(tab.url);
  $('#add-url').textContent = tab.url;
  $('#add-pw').value = '';
  $('#add-err').textContent = '';
  $('#add-pw-wrap').hidden = S.admin;
  document.querySelectorAll('#mode-choices .wl-choice').forEach(b => {
    b.classList.toggle('is-on', b.dataset.mode === 'domain');
  });
  updateModeHint();
  show('add');
}

function updateModeHint() {
  const text = {
    domain: '这个网站下的所有页面都会上锁。',
    prefix: '只有以当前地址开头（含参数）的页面会上锁。',
    exact: '只有这一个完整地址会上锁。'
  }[addMode];
  $('#mode-hint').textContent = text;
}

async function confirmAdd() {
  const password = S.admin ? '' : $('#add-pw').value.trim();
  if (!S.admin && !password) {
    $('#add-err').textContent = '请输入密码';
    return;
  }
  const btn = $('#btn-add-confirm');
  btn.disabled = true;
  const res = await send({
    type: 'add-lock',
    kind: 'url',
    mode: addMode,
    url: tab.url,
    title: tab.title || hostOf(tab.url),
    password
  });
  btn.disabled = false;

  if (!res.ok) {
    if (res.code === 'NEED_PASSWORD') {
      await relock();
      toast('请先输入密码');
      return;
    }
    $('#add-err').textContent = authErrorText(res);
    if (res.code === 'BAD_PASSWORD') {
      $('#add-pw-wrap').hidden = false;
      $('#add-pw').focus();
    }
    return;
  }
  S.locks.push(res.lock);
  toast('已上锁');
  show('main');
  await renderMain();
}

/* --------------------------------------------------------------- 设置密码 */

async function setupPassword() {
  const pw1 = $('#setup-pw1').value.trim();
  const pw2 = $('#setup-pw2').value.trim();
  const err = $('#setup-err');
  if (pw1.length < 4) { err.textContent = '密码至少 4 位'; return; }
  if (pw1 !== pw2) { err.textContent = '两次输入不一致'; return; }

  const btn = $('#btn-setup');
  btn.disabled = true;
  const res = await send({ type: 'set-password', password: pw1 });
  btn.disabled = false;
  if (!res.ok) { err.textContent = authErrorText(res); return; }

  S.hasAuth = true;
  S.admin = true;
  toast('密码已设置');
  show('main');
  await renderMain();
}

/* ------------------------------------------------------------------ 事件 */

$('#btn-setup').addEventListener('click', setupPassword);
$('#setup-pw2').addEventListener('keydown', e => { if (e.key === 'Enter') setupPassword(); });

$('#btn-unlock-popup').addEventListener('click', unlockPopup);
$('#lock-pw').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); unlockPopup(); }
});

$('#btn-lock-now').addEventListener('click', relock);

$('#btn-add').addEventListener('click', enterAdd);
$('#btn-add-back').addEventListener('click', () => { show('main'); renderMain(); });
$('#btn-add-confirm').addEventListener('click', confirmAdd);
$('#add-pw').addEventListener('keydown', e => { if (e.key === 'Enter') confirmAdd(); });

document.querySelectorAll('#mode-choices .wl-choice').forEach(btn => {
  btn.addEventListener('click', () => {
    addMode = btn.dataset.mode;
    document.querySelectorAll('#mode-choices .wl-choice').forEach(b => {
      b.classList.toggle('is-on', b === btn);
    });
    updateModeHint();
  });
});

function openOptions() {
  chrome.runtime.openOptionsPage();
  window.close();
}
$('#btn-settings').addEventListener('click', openOptions);
$('#btn-manage').addEventListener('click', openOptions);

boot();
