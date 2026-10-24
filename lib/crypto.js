/* PBKDF2-SHA256 口令派生。Service Worker 与扩展页面共用。 */

const ITERATIONS = 150000;
const KEY_BYTES = 32;

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function deriveHash(password, saltB64, iterations = ITERATIONS) {
  const raw = new TextEncoder().encode(password);
  const key = await crypto.subtle.importKey('raw', raw, 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromBase64(saltB64), iterations, hash: 'SHA-256' },
    key,
    KEY_BYTES * 8
  );
  return toBase64(new Uint8Array(bits));
}

export async function createAuth(password) {
  const salt = toBase64(crypto.getRandomValues(new Uint8Array(16)));
  return {
    salt,
    hash: await deriveHash(password, salt),
    iterations: ITERATIONS,
    createdAt: Date.now()
  };
}

function equalsConstantTime(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyAuth(password, auth) {
  if (!auth || !auth.hash || !auth.salt) return false;
  const hash = await deriveHash(password, auth.salt, auth.iterations || ITERATIONS);
  return equalsConstantTime(hash, auth.hash);
}

/* 粗略的强度提示，只用于界面 */
export function passwordStrength(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 6) score++;
  if (pw.length >= 10) score++;
  if (/[a-zA-Z]/.test(pw) && /\d/.test(pw)) score++;
  if (/[^a-zA-Z0-9]/.test(pw)) score++;
  return Math.min(score, 4);
}
