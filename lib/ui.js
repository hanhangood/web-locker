/* 页面共用小工具：发消息、弹对话框、Toast、favicon。 */

export function send(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, res => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, code: 'DISCONNECTED', message: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false, code: 'EMPTY' });
      }
    });
  });
}

export function faviconUrl(pageUrl, size = 32) {
  return chrome.runtime.getURL('/_favicon/?pageUrl=' + encodeURIComponent(pageUrl) + '&size=' + size);
}

export function toast(text, ms) {
  if (window.Smartisan && typeof window.Smartisan.toast === 'function') {
    window.Smartisan.toast(text, ms);
  }
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

/**
 * 通用对话框。按钮 onClick(bodyEl, close) 返回 false 表示不自动关闭，
 * 想带值关闭就自己调用 close(value)。
 */
export function openDialog({
  title,
  body,
  buttons = [{ label: '好', primary: true, value: true }],
  dismissible = true,
  onMount
}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 's-overlay';
    overlay.innerHTML = `
      <div class="s-dialog" role="dialog" aria-modal="true">
        ${title ? `<div class="s-dialog__header">${escapeHtml(title)}</div>` : ''}
        <div class="s-dialog__body s-dialog__body--field"></div>
        <div class="s-dialog__actions"></div>
      </div>`;
    const bodyEl = overlay.querySelector('.s-dialog__body');
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);

    const actions = overlay.querySelector('.s-dialog__actions');
    let settled = false;
    const close = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };

    buttons.forEach(btn => {
      const b = document.createElement('button');
      b.textContent = btn.label;
      if (btn.primary) b.setAttribute('data-primary', '');
      b.addEventListener('click', () => {
        if (btn.onClick) {
          const keep = btn.onClick(bodyEl, close);
          if (keep === false) return;
        }
        close(btn.value);
      });
      actions.appendChild(b);
    });

    function onKey(e) {
      if (e.key === 'Escape' && dismissible) { e.stopPropagation(); close(undefined); }
      if (e.key === 'Enter' && !e.isComposing) {
        const primary = actions.querySelector('[data-primary]');
        if (primary) { e.preventDefault(); primary.click(); }
      }
    }
    document.addEventListener('keydown', onKey, true);

    if (dismissible) {
      overlay.addEventListener('click', e => { if (e.target === overlay) close(undefined); });
    }
    document.body.appendChild(overlay);
    if (onMount) onMount(bodyEl, close);
    const focusable = bodyEl.querySelector('input, .s-textfield');
    (focusable || actions.querySelector('[data-primary]') || actions.querySelector('button'))?.focus();
  });
}

/** 只问密码的小对话框，返回字符串或 undefined */
export function askPassword({ title = '需要密码', tip = '请输入密码以继续', placeholder = '密码' } = {}) {
  return openDialog({
    title,
    body: `
      <p class="wl-dialog-tip">${escapeHtml(tip)}</p>
      <input class="s-textfield" type="password" placeholder="${escapeHtml(placeholder)}" autocomplete="current-password">
      <p class="wl-error"></p>`,
    buttons: [
      { label: '取消', value: undefined },
      {
        label: '确定', primary: true,
        onClick: (bodyEl, close) => {
          const value = bodyEl.querySelector('input').value.trim();
          if (!value) {
            bodyEl.querySelector('.wl-error').textContent = '请输入密码';
            return false;
          }
          close(value);
          return false;
        }
      }
    ],
    onMount: bodyEl => bodyEl.querySelector('input').focus()
  });
}

/** 设置 / 修改密码对话框，返回 { password } 或 undefined */
export function askNewPassword({ title = '设置密码', requireOld = false } = {}) {
  return openDialog({
    title,
    body: `
      ${requireOld ? '<div class="wl-dialog-field"><input class="s-textfield" type="password" data-role="old" placeholder="当前密码" autocomplete="current-password"></div>' : ''}
      <div class="wl-dialog-field"><input class="s-textfield" type="password" data-role="new" placeholder="新密码（至少 4 位）" autocomplete="new-password"></div>
      <div class="wl-dialog-field"><input class="s-textfield" type="password" data-role="confirm" placeholder="再输一次" autocomplete="new-password"></div>
      <p class="wl-error"></p>`,
    buttons: [
      { label: '取消', value: undefined },
      {
        label: '确定', primary: true,
        onClick: (bodyEl, close) => {
          const errEl = bodyEl.querySelector('.wl-error');
          const oldPw = bodyEl.querySelector('[data-role="old"]')?.value || '';
          const pw = bodyEl.querySelector('[data-role="new"]').value;
          const pw2 = bodyEl.querySelector('[data-role="confirm"]').value;
          if (pw.length < 4) { errEl.textContent = '密码至少 4 位'; return false; }
          if (pw !== pw2) { errEl.textContent = '两次输入不一致'; return false; }
          if (requireOld && !oldPw) { errEl.textContent = '请输入当前密码'; return false; }
          close({ password: pw, oldPassword: oldPw });
          return false;
        }
      }
    ]
  });
}

export function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + ' 小时前';
  return Math.floor(diff / 86400e3) + ' 天前';
}

/** 统一的鉴权失败文案 */
export function authErrorText(res) {
  switch (res.code) {
    case 'BAD_PASSWORD':
      return res.remaining != null ? `密码不正确，还可以试 ${res.remaining} 次` : '密码不正确';
    case 'LOCKED': {
      const sec = Math.max(1, Math.ceil(((res.until || 0) - Date.now()) / 1000));
      return `输错次数太多，请 ${sec} 秒后再试`;
    }
    case 'NEED_PASSWORD': return '请输入密码';
    case 'NO_AUTH': return '还没有设置密码';
    case 'HAS_AUTH': return '已经设置过密码了';
    case 'WEAK': return res.message || '密码太简单';
    case 'DUP': return res.message || '已经锁过了';
    default: return res.message || '操作失败';
  }
}
