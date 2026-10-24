import { send, faviconUrl, authErrorText } from './lib/ui.js';

const $ = sel => document.querySelector(sel);

// 两种入口：
//   #https://example.com/...   → 网页锁
//   #vault=<folderId>          → 文件夹保险箱（书签已被搬走，等着放回去）
const hash = (location.hash || '').slice(1);
const isVault = hash.startsWith('vault=');
const folderId = isVault ? hash.slice('vault='.length) : '';
const target = isVault ? '' : hash;

let lockTimer = null;

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function showError(text) {
  $('#err').textContent = text || '';
}

function shake() {
  const card = $('#card');
  card.classList.remove('wl-shake');
  void card.offsetWidth;
  card.classList.add('wl-shake');
  setTimeout(() => card.classList.remove('wl-shake'), 400);
}

function countdownLocked(until) {
  clearInterval(lockTimer);
  const btn = $('#btn-unlock');
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(lockTimer);
      btn.disabled = false;
      btn.textContent = isVault ? '解锁并恢复书签' : '解锁并进入';
      showError('可以再试了');
      return;
    }
    btn.disabled = true;
    btn.textContent = `${left} 秒后可再试`;
  };
  tick();
  lockTimer = setInterval(tick, 500);
}

/* ------------------------------------------------------------ 文件夹保险箱 */

async function initVault() {
  const info = await send({ type: 'vault-info', folderId });
  const name = info.folderName || '这个文件夹';
  const count = info.count || 0;

  document.title = '已上锁 · ' + name;
  $('#lock-title').textContent = '这个文件夹已上锁';
  $('#lock-sub').textContent = '输入密码，书签会放回原位';
  $('#btn-unlock').textContent = '解锁并恢复书签';
  $('#site-host').textContent = name;
  $('#site-url').textContent = count ? `${count} 个书签已收进保险箱` : '密码验证后恢复';

  const fav = $('#site-fav');
  if (fav) {
    fav.insertAdjacentHTML(
      'beforebegin',
      '<svg class="s-icon" style="width:28px;height:28px;color:#929292"><use href="#si-folder"/></svg>'
    );
    fav.remove();
  }

  if (!info.exists) {
    $('#lock-sub').textContent = '这个文件夹已经解锁过了';
    $('#btn-unlock').disabled = true;
    $('#btn-done').hidden = false;
  }

  $('#pw').focus();
}

function showVaultResult(res) {
  clearInterval(lockTimer);
  $('#lock-title').textContent = '已解锁';
  $('#lock-sub').textContent = res.restored
    ? `已把 ${res.restored} 个书签放回原来的文件夹`
    : '文件夹已恢复';

  $('#pw').hidden = true;
  $('#btn-unlock').hidden = true;
  $('#btn-done').hidden = false;

  const site = $('.wl-lock-site');
  if (site) site.hidden = true;

  if (res.stuck) {
    showError(`有 ${res.stuck} 项没能还原（原文件夹可能已被删掉），它们留在「其他收藏夹 → 已上锁」里。`);
  } else {
    showError('');
  }

  $('#btn-done').focus();
}

/* ------------------------------------------------------------------ 网页锁 */

function initWeb() {
  if (!/^https?:/i.test(target)) {
    $('#site-host').textContent = '地址无效';
    $('#site-url').textContent = '';
    $('#btn-unlock').disabled = true;
    showError('没有拿到要打开的地址，可能是直接打开了这个页面。');
    return;
  }

  $('#site-host').textContent = hostOf(target);
  $('#site-url').textContent = target;
  document.title = '已锁定 · ' + hostOf(target);

  const fav = $('#site-fav');
  fav.src = faviconUrl(target, 64);
  fav.addEventListener('error', () => { fav.style.visibility = 'hidden'; });

  $('#pw').focus();
}

/* ------------------------------------------------------------------ 解锁 */

async function unlock() {
  const input = $('#pw');
  const password = input.value.trim();
  if (!password) { showError('请输入密码'); input.focus(); return; }

  const btn = $('#btn-unlock');
  btn.disabled = true;
  btn.textContent = '验证中…';

  const res = isVault
    ? await send({ type: 'vault-unlock', folderId, password })
    : await send({ type: 'unlock-open', url: target, password });

  if (res.ok) {
    showError('');
    if (isVault) {
      showVaultResult(res);
    } else {
      btn.textContent = '正在进入…';
      if (res.fallback) location.replace(res.fallback);
    }
    return;
  }

  btn.disabled = false;
  btn.textContent = isVault ? '解锁并恢复书签' : '解锁并进入';
  showError(authErrorText(res));
  shake();
  input.select();

  if (res.code === 'LOCKED' && res.until) countdownLocked(res.until);
  if (res.code === 'NO_AUTH') {
    showError('扩展还没有设置密码，请先打开管理页设置。');
  }
  if (res.code === 'NOT_FOUND') {
    $('#btn-done').hidden = false;
  }
}

/* ------------------------------------------------------------------ 事件 */

$('#btn-unlock').addEventListener('click', unlock);
$('#pw').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); unlock(); }
});

$('#btn-back').addEventListener('click', () => send({ type: 'go-back' }));
$('#btn-close').addEventListener('click', () => send({ type: 'close-lock-tab' }));
$('#btn-done').addEventListener('click', () => send({ type: 'close-lock-tab' }));

(isVault ? initVault() : initWeb());
