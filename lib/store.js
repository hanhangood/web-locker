/* 状态存取。所有数据保存在 chrome.storage.local，关掉浏览器不丢。
   chrome.storage.session 用来存"临时放行"和"管理已解锁"这类会随浏览器关闭失效的东西。 */

const STATE_KEY = 'wl_state';

export const DEFAULT_SETTINGS = {
  graceMinutes: 0,      // 解锁后多久内同一网站免密（0 = 每次都要密码）
  maxAttempts: 5,       // 连续输错几次后临时锁定
  lockoutSeconds: 60,   // 临时锁定秒数
  badge: true           // 图标上显示已锁数量
};

export function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export async function readState() {
  const bag = await chrome.storage.local.get(STATE_KEY);
  const raw = bag[STATE_KEY] || {};
  return {
    ...raw,
    auth: raw.auth || null,
    locks: Array.isArray(raw.locks) ? raw.locks : [],
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
    stats: raw.stats || { unlockCount: 0, lastUnlockAt: 0, createdAt: Date.now() }
  };
}

export async function writeState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  return state;
}

/** 读 → 改 → 写，返回改后的完整状态。 */
export async function mutate(fn) {
  const state = await readState();
  await fn(state);
  return writeState(state);
}

export async function readSession(keys) {
  return chrome.storage.session.get(keys);
}

export async function patchSession(obj) {
  await chrome.storage.session.set(obj);
}

export const ADMIN_TTL = 5 * 60 * 1000;

export async function isAdminOpen() {
  const { adminUntil = 0 } = await chrome.storage.session.get('adminUntil');
  return adminUntil > Date.now();
}

export async function openAdmin() {
  await chrome.storage.session.set({ adminUntil: Date.now() + ADMIN_TTL });
}

export async function closeAdmin() {
  await chrome.storage.session.set({ adminUntil: 0 });
}
