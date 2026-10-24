/* =========================================================
   TapOnce — auth.js
   Client-side authentication helpers (PBKDF2-SHA256 via Web Crypto).

   IMPORTANT — this is a PROTOTYPE login. Accounts, hashes and
   sessions live in the browser, so anyone with DevTools access can
   tamper with them. Production needs a server: TLS, server-side
   sessions/JWT, rate limiting, MFA and a real identity provider.
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TapAuth = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ITER = 120000;
  const SESSION_MS = 15 * 60 * 1000;
  const MAX_FAILS = 5;
  const enc = new TextEncoder();
  const COMMON = ['password', 'password1', 'password123', '12345678', '123456789', 'qwerty123', 'qwertyuiop', 'iloveyou1', 'letmein123', 'admin123', 'welcome123'];

  const subtle = () => (typeof crypto !== 'undefined' && crypto.subtle ? crypto.subtle : null);
  const available = () => !!subtle() && typeof crypto.getRandomValues === 'function';
  const randomBytes = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };
  const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64 = (u8) => btoa(String.fromCharCode(...u8));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const normUser = (s) => String(s || '').trim().toLowerCase();

  async function derive(password, salt, iter) {
    const s = subtle();
    const key = await s.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
  }
  /** Constant-time comparison. */
  function ctEqual(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  async function createUser(username, password, role, extra) {
    const salt = randomBytes(16);
    const hash = await derive(password, salt, ITER);
    return Object.assign({
      id: 'U-' + hex(randomBytes(4)).toUpperCase(), username: normUser(username), display: String(username).trim(), role,
      salt: b64(salt), hash: b64(hash), iter: ITER, createdAt: new Date().toISOString(), failed: 0, lockedUntil: 0,
    }, extra || {});
  }
  async function verify(rec, password) {
    const h = await derive(password, unb64(rec.salt), rec.iter || ITER);
    return ctEqual(h, unb64(rec.hash));
  }
  /** Spend the same time for unknown usernames so timing does not reveal which accounts exist. */
  async function dummyVerify() { await derive('dummy-password', randomBytes(16), ITER); }

  const lockRemaining = (rec, now) => Math.max(0, (rec.lockedUntil || 0) - now);
  function registerFailure(rec, now) {
    rec.failed = (rec.failed || 0) + 1;
    if (rec.failed >= MAX_FAILS) {
      const tier = Math.floor(rec.failed / MAX_FAILS);
      rec.lockedUntil = now + Math.min(15 * 60 * 1000, 30000 * Math.pow(2, tier - 1));
    }
  }
  function registerSuccess(rec) { rec.failed = 0; rec.lockedUntil = 0; }

  function validateUsername(u) {
    return /^[A-Za-z0-9_.-]{3,20}$/.test(String(u).trim()) ? '' : 'Username: 3–20 letters, numbers, . _ or -';
  }
  function validatePassword(pw, username) {
    pw = String(pw);
    if (pw.length < 8) return 'Password must be at least 8 characters.';
    if (pw.length > 64) return 'Password must be 64 characters or fewer.';
    if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Use at least one letter and one number.';
    if (COMMON.includes(pw.toLowerCase())) return 'That password is too common.';
    if (username && pw.toLowerCase().includes(normUser(username))) return 'Password must not contain your username.';
    return '';
  }
  function strength(pw) {
    pw = String(pw || '');
    const labels = ['Very weak', 'Weak', 'Fair', 'Good', 'Strong'];
    const tips = [];
    let s = 0;
    if (pw.length >= 8) s++; else tips.push('use 8+ characters');
    if (pw.length >= 12) s++; else if (pw.length >= 8) tips.push('12+ characters is stronger');
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++; else tips.push('mix upper and lower case');
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++; else tips.push('add a number and a symbol');
    if (COMMON.includes(pw.toLowerCase())) { s = 0; tips.unshift('this password is too common'); }
    s = Math.max(0, Math.min(4, s));
    return { score: s, label: labels[s], tips };
  }

  return { ITER, SESSION_MS, MAX_FAILS, available, createUser, verify, dummyVerify, lockRemaining, registerFailure, registerSuccess, validateUsername, validatePassword, strength, normUser, ctEqual };
});
