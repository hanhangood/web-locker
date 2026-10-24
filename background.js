/* 网页锁 · 后台 Service Worker
   职责：
   1) 把「锁定的书签 / 锁定的文件夹」编译成 declarativeNetRequest 规则，
      命中时把主框架导航重定向到锁屏页 lock.html。
   2) 校验密码、发放一次性放行（allow）规则。
   3) 收藏夹变化时自动重建规则（文件夹锁住的书签增删即时生效）。
*/

import { createAuth, verifyAuth } from './lib/crypto.js';
import {
  readState, writeState, mutate, newId,
  isAdminOpen, openAdmin, closeAdmin
} from './lib/store.js';

const RULE_BASE = 1000;    // 锁定规则 id 段：1000 ~ 19999
const RULE_TEMP = 20000;   // 一次性放行规则 id 段：20000+
const LOCK_PAGE = chrome.runtime.getURL('lock.html');

/* ---------------------------------------------------------------- 规则编译 */

function escRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把一条锁定项翻译成正则；domain = 整个站点，prefix = 地址前缀，exact = 这一个地址 */
function buildFilter(mode, rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;

  if (mode === 'exact') return '^' + escRe(u.href) + '$';
  if (mode === 'prefix') return '^' + escRe(u.href);

  const host = u.hostname.replace(/^www\./i, '');
  if (!host) return null;
  return '^https?://(?:[^/?#]+\\.)?' + escRe(host) + '(?::\\d+)?(?:[/?#]|$)';
}

async function folderUrls(folderId) {
  const urls = [];
  async function walk(id) {
    let kids = [];
    try { kids = await chrome.bookmarks.getChildren(String(id)); } catch { return; }
    for (const k of kids) {
      if (k.url) urls.push(k.url);
      else await walk(k.id);
    }
  }
  await walk(folderId);
  return urls;
}

/** 收集所有需要拦截的正则（自动去重） */
async function collectFilters(state) {
  const set = new Set();
  for (const lock of state.locks) {
    if (lock.enabled === false) continue;

    if (lock.kind === 'vault') {
      // 书签已经被搬走，用上锁时记下的 URL 清单继续拦（防止从保险箱里直接点开）
      for (const u of lock.urls || []) {
        const f = buildFilter(lock.mode, u);
        if (f) set.add(f);
      }
      continue;
    }

    if (lock.kind === 'folder') {
      const urls = await folderUrls(lock.folderId);
      for (const u of urls) {
        const f = buildFilter(lock.mode, u);
        if (f) set.add(f);
      }
    } else {
      const f = buildFilter(lock.mode, lock.url);
      if (f) set.add(f);
    }
  }
  return [...set];
}

let queue = Promise.resolve();
function rebuild() {
  queue = queue.then(doRebuild).catch(err => console.error('[网页锁] 重建规则失败', err));
  return queue;
}

async function doRebuild() {
  await sweepTempRules();
  const state = await readState();
  const filters = await collectFilters(state);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const stale = existing
    .filter(r => r.id >= RULE_BASE && r.id < RULE_TEMP)
    .map(r => r.id);

  const addRules = [];
  let id = RULE_BASE;
  for (const filter of filters) {
    if (id >= RULE_TEMP) break;
    addRules.push({
      id: id++,
      priority: 100,
      action: { type: 'redirect', redirect: { regexSubstitution: LOCK_PAGE + '#\\0' } },
      condition: { regexFilter: filter, resourceTypes: ['main_frame'] }
    });
  }

  const CHUNK = 300;
  if (!addRules.length) {
    if (stale.length) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: stale });
    }
  } else {
    for (let i = 0; i < addRules.length; i += CHUNK) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: i === 0 ? stale : [],
        addRules: addRules.slice(i, i + CHUNK)
      });
    }
  }
  await updateBadge(state);
}

async function updateBadge(state) {
  const active = state.locks.filter(l => l.enabled !== false).length;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#5b87eb' });
    await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
    await chrome.action.setBadgeText({ text: state.settings.badge && active ? String(active) : '' });
  } catch { /* 部分版本没有 setBadgeTextColor */ }
}

/* ------------------------------------------------------- 一次性放行（解锁） */

async function addAllowRule(url, graceMinutes) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const ruleId = RULE_TEMP + Math.floor(Math.random() * 7000) + 1;
  const filter = '^' + escRe(u.protocol) + '//' + escRe(u.host) + '/';
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 5000,
      action: { type: 'allow' },
      condition: { regexFilter: filter, resourceTypes: ['main_frame'] }
    }]
  });

  const lifeMs = graceMinutes > 0 ? graceMinutes * 60 * 1000 : 15000;
  const { tempRules = {} } = await chrome.storage.session.get('tempRules');
  tempRules[ruleId] = Date.now() + lifeMs;
  await chrome.storage.session.set({ tempRules });

  if (lifeMs >= 60000) {
    // 长免密用 alarm 兜底，避免 SW 被回收后规则残留
    chrome.alarms.create('allow-' + ruleId, { when: Date.now() + lifeMs });
  } else {
    setTimeout(() => removeTempRule(ruleId), lifeMs);
  }
  return ruleId;
}

async function removeTempRule(ruleId) {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [ruleId] });
  } catch { /* ignore */ }
  const { tempRules = {} } = await chrome.storage.session.get('tempRules');
  if (ruleId in tempRules) {
    delete tempRules[ruleId];
    await chrome.storage.session.set({ tempRules });
  }
}

async function sweepTempRules() {
  let tempRules = {};
  try { ({ tempRules = {} } = await chrome.storage.session.get('tempRules')); } catch { return; }
  const now = Date.now();
  const drop = new Set();
  for (const [key, expireAt] of Object.entries(tempRules)) {
    if (!expireAt || expireAt <= now) drop.add(Number(key));
  }
  let existing = [];
  try { existing = await chrome.declarativeNetRequest.getDynamicRules(); } catch { return; }
  const known = new Set(Object.keys(tempRules).map(Number));
  for (const rule of existing) {
    if (rule.id >= RULE_TEMP && !known.has(rule.id)) drop.add(rule.id); // 上次会话残留
  }
  const ids = [...drop];
  if (ids.length) {
    try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids }); } catch { }
  }
  for (const id of ids) delete tempRules[id];
  try { await chrome.storage.session.set({ tempRules }); } catch { }
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (!alarm.name.startsWith('allow-')) return;
  await removeTempRule(Number(alarm.name.slice(6)));
});

/** 从锁屏页跳回原地址后，若没开"免密时长"，立刻收回放行 */
chrome.webNavigation.onCommitted.addListener(async details => {
  if (details.frameId !== 0) return;
  const { pendingTabs = {} } = await chrome.storage.session.get('pendingTabs');
  const ruleId = pendingTabs[details.tabId];
  if (!ruleId) return;
  delete pendingTabs[details.tabId];
  await chrome.storage.session.set({ pendingTabs });
  const state = await readState();
  if (!state.settings.graceMinutes) await removeTempRule(ruleId);
});

/* -------------------------------------------------------------- 密码与权限 */

async function verifyPassword(password) {
  const state = await readState();
  if (!state.auth) return { ok: false, code: 'NO_AUTH' };

  const now = Date.now();
  const sess = await chrome.storage.session.get(['failCount', 'lockUntil']);
  if (sess.lockUntil && sess.lockUntil > now) {
    return { ok: false, code: 'LOCKED', until: sess.lockUntil };
  }

  if (await verifyAuth(password, state.auth)) {
    await chrome.storage.session.set({ failCount: 0, lockUntil: 0 });
    return { ok: true };
  }

  const failCount = (sess.failCount || 0) + 1;
  const maxAttempts = state.settings.maxAttempts || 5;
  if (failCount >= maxAttempts) {
    const until = now + (state.settings.lockoutSeconds || 60) * 1000;
    await chrome.storage.session.set({ failCount: 0, lockUntil: until });
    return { ok: false, code: 'LOCKED', until };
  }
  await chrome.storage.session.set({ failCount });
  return { ok: false, code: 'BAD_PASSWORD', remaining: maxAttempts - failCount };
}

/** 管理操作鉴权：管理会话已开，或当场给出正确密码 */
async function authorize(password) {
  const state = await readState();
  if (!state.auth) return { ok: false, code: 'NO_AUTH' };
  if (await isAdminOpen()) return { ok: true };
  if (!password) return { ok: false, code: 'NEED_PASSWORD' };
  const res = await verifyPassword(password);
  if (res.ok) { await openAdmin(); return { ok: true }; }
  return res;
}

/* ------------------------------------------------------------------ 收藏夹 */

function normalizeBookmark(node) {
  const out = {
    id: node.id,
    title: (node.title || '').trim(),
    url: node.url || '',
    children: []
  };
  if (node.children) out.children = node.children.map(normalizeBookmark);
  if (!out.url && !out.title) out.title = '未命名文件夹';
  return out;
}

async function bookmarkRoots() {
  const tree = await chrome.bookmarks.getTree();
  const roots = tree[0]?.children || [];
  return roots.map(normalizeBookmark);
}

/* ------------------------------------------------------------ 文件夹保险箱
   收藏夹栏是浏览器自身的 UI（不是网页），扩展既不能往里注入内容，
   也拿不到"用户点开了哪个文件夹"这种事件，所以"点文件夹先弹密码"做不到。
   这里换一条路，做到同样的观感：
     把文件夹里的书签整体搬进「其他收藏夹 → 已上锁」，
     原文件夹只留一个"已上锁 · 点击解锁"的替身。
   书签是被移走而不是删除，卸载扩展也不会丢。
*/

const VAULT_ROOT_NAME = '已上锁';
const VAULT_MARK = '🔒';
const VAULT_HASH = '#vault=';

function vaultPageFor(folderId) {
  return chrome.runtime.getURL('lock.html') + VAULT_HASH + String(folderId);
}

async function findVaultRoot(create) {
  const state = await readState();
  if (state.vaultRootId) {
    try {
      await chrome.bookmarks.get(String(state.vaultRootId));
      return state.vaultRootId;
    } catch { /* 被删了，下面重建 */ }
  }
  // 只认登记过的那个。自检时绝不靠名字去猜，免得误碰用户自己的同名文件夹。
  if (!create) return null;

  let fallbackParent = null;
  for (const pid of ['2', '1']) {          // 2 = 其他收藏夹，1 = 收藏夹栏
    let kids = [];
    try { kids = await chrome.bookmarks.getChildren(pid); } catch { continue; }
    const hit = kids.find(k => !k.url && k.title === VAULT_ROOT_NAME);
    if (hit) {
      await mutate(s => { s.vaultRootId = hit.id; });
      return hit.id;
    }
    if (!fallbackParent) fallbackParent = pid;
  }

  const created = await chrome.bookmarks.create({
    parentId: fallbackParent || '2',
    title: VAULT_ROOT_NAME
  });
  await mutate(s => { s.vaultRootId = created.id; });
  return created.id;
}

async function collectUrlsDeep(nodeId) {
  const out = [];
  async function walk(id) {
    let kids = [];
    try { kids = await chrome.bookmarks.getChildren(id); } catch { return; }
    for (const k of kids) {
      if (k.url) out.push(k.url);
      else await walk(k.id);
    }
  }
  await walk(nodeId);
  return out;
}

/** 把文件夹搬进保险箱，原位置留替身 */
async function vaultLockFolder(folderId, folderName) {
  const fid = String(folderId);
  const state = await readState();
  if (state.locks.some(l => (l.kind === 'folder' || l.kind === 'vault') && l.folderId === fid)) {
    return { ok: false, code: 'DUP', message: '这个文件夹已经锁上了' };
  }

  let children = [];
  try { children = await chrome.bookmarks.getChildren(fid); } catch { }
  if (!children.length) {
    return { ok: false, code: 'EMPTY', message: '这个文件夹是空的，不用锁' };
  }

  const urls = await collectUrlsDeep(fid);
  const rootId = await findVaultRoot(true);
  const vaultFolder = await chrome.bookmarks.create({
    parentId: rootId,
    title: `[${fid}] ${folderName || '文件夹'}`
  });

  // 替身先建好：拿不到这个入口就不搬，避免书签"不见了又点不到"
  let decoy = null;
  try {
    decoy = await chrome.bookmarks.create({
      parentId: fid,
      title: `${VAULT_MARK} 已上锁 · 点击解锁`,
      url: vaultPageFor(fid)
    });
  } catch {
    try { await chrome.bookmarks.remove(vaultFolder.id); } catch { }
    return { ok: false, code: 'NO_DECOY', message: '当前浏览器不允许创建扩展书签，没法做隐藏式锁定' };
  }

  let moved = 0;
  for (const child of children) {
    try {
      await chrome.bookmarks.move(child.id, { parentId: vaultFolder.id });
      moved++;
    } catch { /* 单个失败不影响其余 */ }
  }

  const lock = {
    id: newId('v_'),
    kind: 'vault',
    folderId: fid,
    folderName: folderName || '收藏夹文件夹',
    vaultFolderId: vaultFolder.id,
    decoyId: decoy.id,
    urls,
    mode: 'domain',
    enabled: true,
    createdAt: Date.now()
  };
  await mutate(s => { s.locks.push(lock); });
  await rebuild();
  return { ok: true, lock, moved };
}

/** 解锁：替身删掉，书签搬回原位 */
async function vaultUnlockFolder(folderId) {
  const fid = String(folderId);
  const state = await readState();
  const lock = state.locks.find(l => l.kind === 'vault' && l.folderId === fid);
  if (!lock) return { ok: false, code: 'NOT_FOUND', message: '这一项已经解锁了' };

  if (lock.decoyId) {
    try { await chrome.bookmarks.remove(lock.decoyId); } catch { }
  }

  let kids = [];
  try { kids = await chrome.bookmarks.getChildren(lock.vaultFolderId); } catch { }

  let restored = 0;
  let stuck = 0;
  for (let i = 0; i < kids.length; i++) {
    try {
      await chrome.bookmarks.move(kids[i].id, { parentId: fid, index: i });
      restored++;
    } catch { stuck++; }
  }

  if (!stuck) {
    try { await chrome.bookmarks.remove(lock.vaultFolderId); } catch { }
  }

  await mutate(s => { s.locks = s.locks.filter(l => l.id !== lock.id); });
  await rebuild();
  return { ok: true, restored, stuck };
}

/** 启动自检：把没有 lock 认领的保险箱内容还原，删掉无主的替身 */
async function healVault() {
  let state;
  try { state = await readState(); } catch { return; }
  const vaultLocks = state.locks.filter(l => l.kind === 'vault');
  const known = new Set(vaultLocks.map(l => l.vaultFolderId));

  let rootId = null;
  try { rootId = await findVaultRoot(false); } catch { }

  if (rootId) {
    let kids = [];
    try { kids = await chrome.bookmarks.getChildren(rootId); } catch { }
    for (const k of kids) {
      if (k.url || known.has(k.id)) continue;
      const match = /^\[(\d+)\]/.exec(k.title || '');
      if (!match) continue;
      const targetFolder = match[1];
      let inner = [];
      try { inner = await chrome.bookmarks.getChildren(k.id); } catch { }
      let moved = 0;
      for (let i = 0; i < inner.length; i++) {
        try { await chrome.bookmarks.move(inner[i].id, { parentId: targetFolder, index: i }); moved++; } catch { }
      }
      if (moved === inner.length) {
        try { await chrome.bookmarks.remove(k.id); } catch { }
      }
    }
  }

  const folderIds = new Set(vaultLocks.map(l => l.folderId));
  let tree = [];
  try { tree = await chrome.bookmarks.getTree(); } catch { return; }
  const decoys = [];
  (function walk(nodes) {
    for (const n of nodes || []) {
      if (n.url) { if (n.url.includes(VAULT_HASH)) decoys.push(n); }
      else walk(n.children);
    }
  })(tree);

  for (const b of decoys) {
    const fid = b.url.split(VAULT_HASH)[1];
    if (!folderIds.has(fid)) {
      try { await chrome.bookmarks.remove(b.id); } catch { }
    }
  }
}

/* ------------------------------------------------------------------ 消息总线 */

const handlers = {
  async 'get-state'() {
    const state = await readState();
    return {
      ok: true,
      hasAuth: !!state.auth,
      locks: state.locks,
      settings: state.settings,
      stats: state.stats,
      admin: await isAdminOpen()
    };
  },

  async 'set-password'({ password }) {
    if (!password || String(password).length < 4) {
      return { ok: false, code: 'WEAK', message: '密码至少 4 位' };
    }
    const state = await readState();
    if (state.auth) return { ok: false, code: 'HAS_AUTH' };
    const auth = await createAuth(String(password));
    await mutate(s => { s.auth = auth; });
    await openAdmin();
    return { ok: true };
  },

  async 'change-password'({ oldPassword, newPassword }) {
    const state = await readState();
    if (!state.auth) return { ok: false, code: 'NO_AUTH' };
    if (await isAdminOpen() || (await verifyAuth(oldPassword, state.auth))) {
      if (!newPassword || String(newPassword).length < 4) {
        return { ok: false, code: 'WEAK', message: '新密码至少 4 位' };
      }
      const auth = await createAuth(String(newPassword));
      await mutate(s => { s.auth = auth; });
      await openAdmin();
      return { ok: true };
    }
    return { ok: false, code: 'BAD_PASSWORD', message: '原密码不正确' };
  },

  async 'verify'({ password }) {
    const res = await verifyPassword(password);
    if (res.ok) await openAdmin();
    return res;
  },

  async 'admin-close'() {
    await closeAdmin();
    return { ok: true };
  },

  async 'add-lock'({ kind, mode, url, folderId, folderName, title, password }) {
    const gate = await authorize(password);
    if (!gate.ok) return gate;

    const state = await readState();
    const cleanMode = ['exact', 'prefix', 'domain'].includes(mode) ? mode : 'domain';

    if (kind === 'folder') {
      if (!folderId) return { ok: false, code: 'BAD_INPUT', message: '缺少文件夹' };
      if (state.locks.some(l => (l.kind === 'folder' || l.kind === 'vault') && l.folderId === String(folderId))) {
        return { ok: false, code: 'DUP', message: '这个文件夹已经锁上了' };
      }
      const lock = {
        id: newId('f_'),
        kind: 'folder',
        folderId: String(folderId),
        folderName: folderName || '收藏夹文件夹',
        mode: cleanMode === 'prefix' ? 'domain' : cleanMode,
        enabled: true,
        createdAt: Date.now()
      };
      await mutate(s => { s.locks.push(lock); });
      await rebuild();
      return { ok: true, lock };
    }

    let u;
    try { u = new URL(url); } catch { return { ok: false, code: 'BAD_INPUT', message: '地址无效' }; }
    if (!/^https?:$/.test(u.protocol)) {
      return { ok: false, code: 'BAD_INPUT', message: '只能锁定 http / https 网页' };
    }
    if (state.locks.some(l => l.kind === 'url' && l.url === u.href && l.mode === cleanMode)) {
      return { ok: false, code: 'DUP', message: '这个网页已经锁上了' };
    }
    const lock = {
      id: newId('l_'),
      kind: 'url',
      mode: cleanMode,
      url: u.href,
      host: u.hostname,
      title: title || u.hostname,
      enabled: true,
      createdAt: Date.now()
    };
    await mutate(s => { s.locks.push(lock); });
    await rebuild();
    return { ok: true, lock };
  },

  async 'remove-lock'({ id, password }) {
    const gate = await authorize(password);
    if (!gate.ok) return gate;
    await mutate(s => { s.locks = s.locks.filter(l => l.id !== id); });
    await rebuild();
    return { ok: true };
  },

  async 'clear-locks'({ password }) {
    const gate = await authorize(password);
    if (!gate.ok) return gate;
    await mutate(s => { s.locks = []; });
    await rebuild();
    return { ok: true };
  },

  async 'update-lock'({ id, patch, password }) {
    const gate = await authorize(password);
    if (!gate.ok) return gate;
    await mutate(s => {
      const lock = s.locks.find(l => l.id === id);
      if (!lock) return;
      if (typeof patch.enabled === 'boolean') lock.enabled = patch.enabled;
      if (typeof patch.title === 'string') lock.title = patch.title;
      if (['exact', 'prefix', 'domain'].includes(patch.mode)) lock.mode = patch.mode;
    });
    await rebuild();
    return { ok: true };
  },

  async 'update-settings'({ patch, password }) {
    const gate = await authorize(password);
    if (!gate.ok) return gate;
    const state = await mutate(s => { s.settings = { ...s.settings, ...patch }; });
    await updateBadge(state);
    return { ok: true, settings: state.settings };
  },

  async 'bookmarks'() {
    const roots = await bookmarkRoots();
    const state = await readState();
    return { ok: true, roots, locks: state.locks };
  },

  /** 锁屏页拿保险箱信息 */
  async 'vault-info'({ folderId }) {
    const state = await readState();
    const lock = state.locks.find(l => l.kind === 'vault' && l.folderId === String(folderId));
    let folderName = lock?.folderName || '';
    if (!folderName) {
      try {
        const [node] = await chrome.bookmarks.get(String(folderId));
        folderName = node?.title || '收藏夹';
      } catch { folderName = '收藏夹'; }
    }
    return { ok: true, exists: !!lock, folderName, count: lock?.urls?.length || 0 };
  },

  async 'vault-lock'({ folderId, folderName, password }) {
    const gate = await authorize(password);
    if (!gate.ok) return gate;
    return vaultLockFolder(folderId, folderName);
  },

  async 'vault-unlock'({ folderId, password }) {
    // 锁屏页没人开管理会话，只能靠密码；管理页里已经验证过就直接放行
    const gate = await authorize(password);
    if (!gate.ok) return gate;
    const res = await vaultUnlockFolder(folderId);
    if (res.ok) {
      await mutate(s => {
        s.stats.unlockCount = (s.stats.unlockCount || 0) + 1;
        s.stats.lastUnlockAt = Date.now();
      });
    }
    return res;
  },

  async 'vault-heal'() {
    await healVault();
    return { ok: true };
  },

  /** 某个地址是否落在锁定范围内（popup 用） */
  async 'check-url'({ url }) {
    if (!url) return { ok: true, locked: false };
    const state = await readState();
    const filters = await collectFilters(state);
    for (const filter of filters) {
      try {
        if (new RegExp(filter).test(url)) return { ok: true, locked: true };
      } catch { /* 忽略非法正则 */ }
    }
    return { ok: true, locked: false };
  },

  /** 锁屏页提交密码 —— 通过后立刻放行并跳回原地址 */
  async 'unlock-open'({ url, password }, sender) {
    if (!url || !/^https?:/i.test(url)) {
      return { ok: false, code: 'BAD_URL', message: '目标地址无效' };
    }
    const gate = await verifyPassword(password);
    if (!gate.ok) return gate;

    const state = await readState();
    const ruleId = await addAllowRule(url, state.settings.graceMinutes);
    const tabId = sender?.tab?.id;

    await mutate(s => {
      s.stats.unlockCount = (s.stats.unlockCount || 0) + 1;
      s.stats.lastUnlockAt = Date.now();
    });

    if (tabId != null) {
      if (!state.settings.graceMinutes && ruleId) {
        const { pendingTabs = {} } = await chrome.storage.session.get('pendingTabs');
        pendingTabs[tabId] = ruleId;
        await chrome.storage.session.set({ pendingTabs });
      }
      try {
        await chrome.tabs.update(tabId, { url });
      } catch {
        return { ok: true, fallback: url };
      }
      return { ok: true };
    }
    return { ok: true, fallback: url };
  },

  async 'close-lock-tab'(_, sender) {
    if (sender?.tab?.id != null) {
      try { await chrome.tabs.remove(sender.tab.id); } catch { }
    }
    return { ok: true };
  },

  async 'go-back'(_, sender) {
    if (sender?.tab?.id != null) {
      try { await chrome.tabs.goBack(sender.tab.id); return { ok: true }; } catch { }
      try { await chrome.tabs.update(sender.tab.id, { url: 'about:blank' }); } catch { }
    }
    return { ok: true };
  },

  async 'lock-current-tab'(_, sender) {
    const tab = sender?.tab;
    return { ok: true, url: tab?.url || '', title: tab?.title || '' };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) { sendResponse({ ok: false, code: 'UNKNOWN', message: '未知操作' }); return; }
  Promise.resolve(fn(msg, sender))
    .then(res => sendResponse(res))
    .catch(err => sendResponse({ ok: false, code: 'ERROR', message: String(err?.message || err) }));
  return true;
});

/* -------------------------------------------------------------------- 生命周期 */

chrome.runtime.onInstalled.addListener(async () => {
  const state = await readState();
  if (!state.stats?.createdAt) {
    await mutate(s => { s.stats = { ...s.stats, createdAt: Date.now() }; });
  }
  await healVault();
  await rebuild();
});

chrome.runtime.onStartup.addListener(async () => {
  // 浏览器重启后，上一轮的临时放行和"管理已解锁"都应失效
  await chrome.storage.session.set({ tempRules: {}, pendingTabs: {}, adminUntil: 0, failCount: 0, lockUntil: 0 });
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const temp = existing.filter(r => r.id >= RULE_TEMP).map(r => r.id);
  if (temp.length) {
    try { await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: temp }); } catch { }
  }
  await healVault();
  await rebuild();
});

/* 收藏夹变动时重建（文件夹锁住的书签增删即时生效） */
let bookmarkTimer = null;
function scheduleBookmarkRebuild() {
  clearTimeout(bookmarkTimer);
  bookmarkTimer = setTimeout(() => rebuild(), 600);
}
[
  chrome.bookmarks.onCreated,
  chrome.bookmarks.onRemoved,
  chrome.bookmarks.onChanged,
  chrome.bookmarks.onMoved,
  chrome.bookmarks.onChildrenReordered
].forEach(evt => evt?.addListener(scheduleBookmarkRebuild));

/* 首次加载也校正一次 */
rebuild();
