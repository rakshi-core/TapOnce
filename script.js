/* =========================================================
   TapOnce — script.js
   Vanilla JS · no backend · everything here is a SIMULATION
   Sections:
     1. Utilities            7. Replay protection + transactions
     2. App state            8. Tap simulation
     3. Persistence          9. Offline queue + settlement
     4. Crypto (WebCrypto)  10. Admin credential management
     5. Wallet helpers      11. UI rendering
     6. Discount engine     12. Events + boot
   ========================================================= */
(() => {
  'use strict';

  /* ---------------------------------------------------------
     1. UTILITIES
  --------------------------------------------------------- */
  const STORAGE_KEY = 'taponce.demo.v1';
  const AUTH_KEY = 'taponce.auth.v1';
  const SESS_KEY = 'taponce.session.v1';
  const CHALLENGE_TTL_MS = 120000;
  const PAGES = ['home', 'wallet', 'merchant', 'admin', 'security', 'settlement', 'analytics'];
  const ROLE_PAGES = {
    student: ['home', 'wallet', 'analytics'],
    merchant: ['home', 'merchant', 'settlement', 'analytics'],
    university: ['home', 'wallet', 'admin', 'security', 'settlement', 'analytics'],
  };
  const ROLE_HOME = { student: 'wallet', merchant: 'merchant', university: 'admin' };
  /** Who may trigger what (enforced in handleAction + form handlers). Prototype-grade: see README. */
  const ACTION_ROLES = {
    'open-tap': ['student', 'university'], 'edit-identity': ['student'], 'top-up': ['student'], scenario: ['student', 'university'],
    reset: ['student', 'university'], 'gen-challenge': ['merchant'], 'dup-test': ['university'], 'tamper-test': ['university'],
    'run-settlement': ['merchant', 'university'], 'admin-cred': ['university'], 'admin-rules': ['university'], limits: ['university'],
    assistant: ['student', 'university'],
  };
  const MERCHANTS = [
    { id: 'MRC-CAN-01', name: 'Sunrise Canteen', category: 'canteen', icon: '🍛', color: '#ffb020', blurb: 'Lunch, snacks & chai' },
    { id: 'MRC-BKS-02', name: 'Page Turner Bookstore', category: 'bookstore', icon: '📚', color: '#7c5cff', blurb: 'Textbooks & notes' },
    { id: 'MRC-STA-03', name: 'Inkwell Stationery', category: 'stationery', icon: '✏️', color: '#2dd4bf', blurb: 'Pens, files & print' },
  ];
  const STATUS_TRANSITIONS = {
    'Pending Sync': ['Synced', 'Rejected'],
    'Synced': [],
    'Rejected': [],
    'Declined': [],
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const prefersReduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const pace = (ms) => (prefersReduced() ? Math.min(ms, 80) : ms);
  const merchantById = (id) => MERCHANTS.find((m) => m.id === id);

  /** Safe DOM builder — never uses innerHTML, so user input can't inject markup. */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const mount = (el, ...nodes) => { if (el) el.replaceChildren(...nodes.flat().filter(Boolean)); };

  const money = (n) => {
    const v = Math.round(Number(n) * 100) / 100;
    return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 });
  };
  const timeFmt = (iso) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const shortTime = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const isoDate = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return d.toISOString().slice(0, 10); };
  const rid = (prefix, bytes = 4) => {
    const a = new Uint8Array(bytes);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(a);
    else for (let i = 0; i < bytes; i++) a[i] = Math.floor(Math.random() * 256);
    return prefix + [...a].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  };
  const emptyState = (icon, text) => h('div', { class: 'empty' }, h('span', { class: 'e-ico' }, icon), h('div', {}, text));
  const skeleton = (n = 3) => Array.from({ length: n }, () => h('div', { class: 'skeleton' }));
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

  function toast(msg, type = 'info') {
    const box = $('#toasts');
    const t = h('div', { class: 'toast ' + type, role: type === 'error' ? 'alert' : 'status' }, msg);
    box.append(t);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3800);
  }

  /* ---------------------------------------------------------
     2. APP STATE
  --------------------------------------------------------- */
  function defaultState() {
    return {
      v: 1,
      role: 'student',
      nickname: 'CampusCoder',
      university: 'Nova Demo University',
      program: 'B.Tech (fictional)',
      walletCredId: 'CR-1001',
      balance: 2500,
      networkMode: 'online',
      rules: { canteen: 10, bookstore: 8, stationery: 5 },
      limits: { perTx: 300, offlineTotal: 500 },
      credentials: [],
      transactions: [],
      ledger: [],
      challenges: [],
      audit: [],
      stats: { duplicatesRejected: 0, declined: 0, verifyMsTotal: 0, verifyCount: 0, syncRuns: 0, syncOk: 0, syncFail: 0 },
      activeMerchant: 'MRC-CAN-01',
      ai: TapAI.newModel(),
      keys: null,
    };
  }
  let state = defaultState();
  const ui = { loading: true, lastDup: null, tap: { merchantId: 'MRC-CAN-01', running: false, lastTx: null } };
  let current = 'home';
  let syncing = false;

  /* ---------------------------------------------------------
     3. PERSISTENCE (LocalStorage)
  --------------------------------------------------------- */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!p || p.v !== 1) return;
      const d = defaultState();
      state = { ...d, ...p, rules: { ...d.rules, ...p.rules }, limits: { ...d.limits, ...p.limits }, stats: { ...d.stats, ...p.stats } };
      state.ai = TapAI.sane(state.ai);
      if (!ROLE_PAGES[state.role]) state.role = 'student';
    } catch (e) { state = defaultState(); }
  }
  // Performance: writes are coalesced (one JSON.stringify per ~150 ms burst) and flushed on tab hide/close.
  let dirty = false, saveTimer = 0;
  function writeNow() {
    clearTimeout(saveTimer); saveTimer = 0;
    if (!dirty) return;
    dirty = false;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage may be blocked; demo still works in memory */ }
  }
  function save() { dirty = true; if (!saveTimer) saveTimer = setTimeout(writeNow, 150); }
  const pushTx = (tx) => { state.transactions.unshift(tx); if (state.transactions.length > 500) state.transactions.length = 500; };

  /* ---------------------------------------------------------
     4. CRYPTO — real ECDSA P-256 via Web Crypto (simulated "university" key)
  --------------------------------------------------------- */
  const Crypto = {
    ready: false, priv: null, pub: null, retried: false,
    async init() {
      try {
        if (!window.crypto || !crypto.subtle) throw new Error('WebCrypto unavailable');
        const alg = { name: 'ECDSA', namedCurve: 'P-256' };
        if (state.keys) {
          this.priv = await crypto.subtle.importKey('jwk', state.keys.priv, alg, false, ['sign']);
          this.pub = await crypto.subtle.importKey('jwk', state.keys.pub, alg, false, ['verify']);
        } else {
          const kp = await crypto.subtle.generateKey(alg, true, ['sign', 'verify']);
          state.keys = { pub: await crypto.subtle.exportKey('jwk', kp.publicKey), priv: await crypto.subtle.exportKey('jwk', kp.privateKey) };
          this.priv = kp.privateKey; this.pub = kp.publicKey;
        }
        this.ready = true;
      } catch (e) {
        if (state.keys && !this.retried) { // stored keys unusable → regenerate and re-issue demo credentials
          this.retried = true; state.keys = null; state.credentials = [];
          return this.init();
        }
        this.ready = false;
      }
    },
    b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); },
    unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); },
    async sign(claims) {
      if (!this.ready) return 'SIMULATED-UNSIGNED';
      const data = new TextEncoder().encode(JSON.stringify(claims));
      return this.b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.priv, data));
    },
    async verify(claims, sig) {
      if (!this.ready) return sig === 'SIMULATED-UNSIGNED';
      try {
        const data = new TextEncoder().encode(JSON.stringify(claims));
        return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, this.pub, this.unb64(sig), data);
      } catch (e) { return false; }
    },
    label() { return this.ready ? 'ECDSA P-256 signature (Web Crypto)' : 'Simulated check (Web Crypto unavailable)'; },
  };

  async function seedCredentials() {
    const mk = async (id, nickname, status, offsetDays) => {
      const expiry = isoDate(offsetDays);
      const claims = { credential: id, category: 'student', expiry };
      return { id, nickname, status, expiry, claims, signature: await Crypto.sign(claims), seeded: true };
    };
    state.credentials = [
      await mk('CR-1001', 'Aarav (demo)', 'active', 365),
      await mk('CR-1002', 'Meera (demo)', 'active', 200),
      await mk('CR-1003', 'Kabir (demo)', 'active', -30),
      await mk('CR-1004', 'Isha (demo)', 'inactive', 300),
    ];
  }

  /* ---------------------------------------------------------
     5. WALLET + ELIGIBILITY HELPERS
  --------------------------------------------------------- */
  const getCred = (id) => state.credentials.find((c) => c.id === id);
  const getWalletCred = () => getCred(state.walletCredId) || state.credentials[0] || null;
  function effectiveStatus(c) {
    if (!c) return 'missing';
    if (c.status !== 'active') return c.status;
    return new Date(c.expiry + 'T23:59:59') < new Date() ? 'expired' : 'active';
  }
  const statusBadge = (s) => {
    const map = { active: ['ok', '● Active'], inactive: ['mute', '○ Inactive'], revoked: ['bad', '⛔ Revoked'], expired: ['warn', '⌛ Expired'], missing: ['bad', 'No credential'] };
    const [cls, txt] = map[s] || ['mute', s];
    return h('span', { class: 'badge ' + cls }, txt);
  };

  /** Eligibility verification: signature check + registry status. Merchant only gets {eligible, category}. */
  async function verifyEligibility(cred) {
    const t0 = performance.now();
    let result;
    if (!cred) result = { ok: false, reason: 'No credential found in this wallet.' };
    else if (!(await Crypto.verify(cred.claims, cred.signature))) result = { ok: false, reason: 'Invalid university signature — credential rejected.' };
    else {
      const st = effectiveStatus(cred);
      if (st === 'revoked') result = { ok: false, reason: 'Credential revoked by the university.' };
      else if (st === 'expired') result = { ok: false, reason: 'Credential expired on ' + cred.expiry + '.' };
      else if (st === 'inactive') result = { ok: false, reason: 'Credential is inactive.' };
      else result = { ok: true, reason: 'Eligible student' };
    }
    result.ms = Math.round((performance.now() - t0) * 10) / 10;
    result.credentialStatus = effectiveStatus(cred);
    return result;
  }

  /* ---------------------------------------------------------
     6. DISCOUNT ENGINE (integer paise → no float drift)
  --------------------------------------------------------- */
  function calcDiscount(amount, category) {
    const pct = Number(state.rules[category]) || 0;
    const paise = Math.round(Number(amount) * 100);
    const disc = Math.round((paise * pct) / 100);
    return { pct, amount: paise / 100, discountAmount: disc / 100, finalAmount: (paise - disc) / 100 };
  }
  function validateAmount(raw) {
    if (raw === '' || raw === null || raw === undefined) return { ok: false, msg: 'Enter a bill amount.' };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { ok: false, msg: 'Amount must be a number.' };
    if (n < 1) return { ok: false, msg: 'Minimum bill is ₹1.' };
    if (n > 5000) return { ok: false, msg: 'Maximum demo bill is ₹5,000.' };
    if (Math.round(n * 100) / 100 !== n) return { ok: false, msg: 'Use at most 2 decimal places.' };
    return { ok: true, value: n };
  }

  /* ---------------------------------------------------------
     7. AUDIT + REPLAY PROTECTION + TRANSACTION PROCESSING
  --------------------------------------------------------- */
  function logAudit(type, text, level = 'info', security = false) {
    state.audit.unshift({ id: rid('EV-', 3), at: new Date().toISOString(), type, text, level, security });
    state.audit = state.audit.slice(0, 200);
  }

  function issueChallenge(merchantId, source = 'terminal') {
    const c = { nonce: rid('CH-', 6), merchantId, issuedAt: Date.now(), used: false, source };
    state.challenges.unshift(c);
    state.challenges = state.challenges.slice(0, 50);
    logAudit('challenge', `Merchant ${merchantId} issued challenge ${c.nonce}`);
    save();
    return c;
  }
  const challengeState = (c) => (c.used ? 'Used' : Date.now() - c.issuedAt > CHALLENGE_TTL_MS ? 'Expired' : 'Unused');

  function transition(tx, next) {
    if (!(STATUS_TRANSITIONS[tx.settlementStatus] || []).includes(next)) throw new Error(`Illegal transition ${tx.settlementStatus} → ${next}`);
    tx.settlementStatus = next;
  }
  function addLedger(tx, status, note, batchId) {
    state.ledger.unshift({ transactionId: tx.transactionId, merchantId: tx.merchantId, finalAmount: tx.finalAmount, status, note: note || '', settledAt: new Date().toISOString(), batchId: batchId || 'LIVE' });
    state.ledger = state.ledger.slice(0, 300);
  }

  const riskSummary = (r) => ({ score: r.score, level: r.level, action: r.action, factors: r.factors.map((f) => f.label) });
  const riskCtx = (finalAmount, merchantId) => ({ amount: finalAmount, finalAmount, merchantId, hour: new Date().getHours(), now: Date.now(), offline: state.networkMode === 'offline', perTxLimit: state.limits.perTx, balance: state.balance });
  const assessRisk = (finalAmount, merchantId) => TapAI.scoreRisk(state.ai, riskCtx(finalAmount, merchantId));

  function declineTx(p, merchant, reason, credentialStatus, code = 'DECLINED', risk) {
    const tx = {
      transactionId: p.transactionId, merchantId: p.merchantId, amount: p.amount, discountAmount: 0, finalAmount: 0,
      credentialStatus, createdAt: new Date().toISOString(), networkMode: state.networkMode, settlementStatus: 'Declined',
      declineReason: reason, risk: risk || undefined, category: merchant.category, nonce: p.nonce, credId: p.credId, verifyMs: p.eligibility ? p.eligibility.ms : 0, discountApplied: false,
    };
    pushTx(tx);
    state.stats.declined++;
    logAudit('decline', `Declined ${tx.transactionId} at ${merchant.name}: ${reason}`, 'error', true);
    save();
    return { ok: false, code, reason, tx };
  }

  /** The single entry point for committing a payment. Idempotent by transactionId. */
  function submitTransaction(p) {
    const merchant = merchantById(p.merchantId);
    if (!merchant) return { ok: false, code: 'BAD_MERCHANT', reason: 'Unknown merchant.' };

    // 1) Duplicate / idempotency check
    if (state.transactions.some((t) => t.transactionId === p.transactionId)) {
      state.stats.duplicatesRejected++;
      logAudit('security', `Duplicate rejected: reference ${p.transactionId} was already processed`, 'error', true);
      save();
      return { ok: false, code: 'DUPLICATE_TX', reason: `Reference ${p.transactionId} was already processed.` };
    }
    // 2) Challenge / nonce check (replay protection)
    const ch = state.challenges.find((c) => c.nonce === p.nonce);
    if (!ch || ch.merchantId !== p.merchantId) {
      logAudit('security', `Rejected: unknown challenge for ${merchant.name}`, 'error', true); save();
      return { ok: false, code: 'INVALID_CHALLENGE', reason: 'Unknown merchant challenge.' };
    }
    if (ch.used) {
      state.stats.duplicatesRejected++;
      logAudit('security', `Replay rejected: challenge ${ch.nonce} already consumed`, 'error', true); save();
      return { ok: false, code: 'REPLAYED_CHALLENGE', reason: `Challenge ${ch.nonce} was already used.` };
    }
    if (Date.now() - ch.issuedAt > CHALLENGE_TTL_MS) {
      logAudit('security', `Rejected: challenge ${ch.nonce} expired`, 'warn', true); save();
      return { ok: false, code: 'EXPIRED_CHALLENGE', reason: 'Merchant challenge expired (120 s limit).' };
    }
    // challenge is single-use from here on
    ch.used = true;

    // 3) Eligibility
    const el = p.eligibility || { ok: false, reason: 'No eligibility proof.' };
    if (!el.ok) return declineTx(p, merchant, el.reason, el.credentialStatus || 'invalid');

    // 4) Amount + discount (applied exactly once, here)
    const v = validateAmount(p.amount);
    if (!v.ok) return declineTx(p, merchant, v.msg, 'active');
    const d = calcDiscount(v.value, merchant.category);

    // 5) Offline limits
    if (state.networkMode === 'offline') {
      if (d.finalAmount > state.limits.perTx) return declineTx(p, merchant, `Offline per-transaction limit (${money(state.limits.perTx)}) exceeded.`, 'active');
      const queued = sum(state.transactions.filter((t) => t.settlementStatus === 'Pending Sync'), (t) => t.finalAmount);
      if (queued + d.finalAmount > state.limits.offlineTotal) return declineTx(p, merchant, `Offline spending limit (${money(state.limits.offlineTotal)}) reached. Reconnect to sync first.`, 'active');
    }
    // 6) Balance
    if (d.finalAmount > state.balance) return declineTx(p, merchant, 'Insufficient wallet balance.', 'active');
    // 7) On-device AI risk gate (explainable logistic scorer — see ai-engine.js)
    const risk = TapAI.scoreRisk(state.ai, riskCtx(d.finalAmount, p.merchantId));
    if (risk.action === 'block' && !p.riskOverride) {
      const why = risk.factors.map((f) => f.label.toLowerCase()).join('; ');
      logAudit('ai', `AI held ${p.transactionId} at ${merchant.name}: risk ${risk.score}/100`, 'error', true);
      return declineTx(p, merchant, `AI risk engine held this payment (score ${risk.score}/100)${why ? ': ' + why : ''}.`, 'active', 'RISK_HELD', riskSummary(risk));
    }

    // Commit
    state.balance = Math.round((state.balance - d.finalAmount) * 100) / 100;
    const tx = {
      transactionId: p.transactionId, merchantId: p.merchantId, amount: d.amount, discountAmount: d.discountAmount, finalAmount: d.finalAmount,
      credentialStatus: 'active', createdAt: new Date().toISOString(), networkMode: state.networkMode,
      settlementStatus: state.networkMode === 'offline' ? 'Pending Sync' : 'Synced',
      category: merchant.category, discountPct: d.pct, discountApplied: true, nonce: p.nonce, credId: p.credId, verifyMs: el.ms || 0,
      risk: riskSummary(risk), riskOverride: risk.action === 'block' ? true : undefined,
    };
    pushTx(tx);
    TapAI.learn(state.ai, { amount: d.finalAmount, hour: new Date().getHours(), merchantId: p.merchantId, at: Date.now() });
    if (risk.action !== 'allow') logAudit('ai', `AI flagged ${tx.transactionId}: risk ${risk.score}/100 (${risk.level})`, 'warn', true);
    state.stats.verifyMsTotal += el.ms || 0; state.stats.verifyCount++;
    if (tx.settlementStatus === 'Synced') { tx.syncedAt = tx.createdAt; addLedger(tx, 'Accepted', 'Online — settled instantly (simulated)', 'LIVE'); }
    logAudit('payment', `${merchant.name}: ${money(d.amount)} − ${money(d.discountAmount)} = ${money(d.finalAmount)} (${tx.networkMode}, ${tx.settlementStatus})`, 'ok');
    save();
    return { ok: true, tx };
  }

  /* ---------------------------------------------------------
     8. TAP SIMULATION
  --------------------------------------------------------- */
  const STEP_LABELS = ['Wallet ready', 'Merchant challenge received', 'Eligibility proof verified', 'Discount calculated', 'AI risk check', 'Transaction accepted'];

  const failStepFor = (code) => ({ INVALID_CHALLENGE: 1, REPLAYED_CHALLENGE: 1, EXPIRED_CHALLENGE: 1, DUPLICATE_TX: 1, RISK_HELD: 4 }[code] ?? 5);

  async function executeTap({ merchantId, amount, override }, view) {
    const merchant = merchantById(merchantId);
    const cred = getWalletCred();
    const transactionId = rid('TX-', 5);

    view.step(0, 'active'); view.stage(true); view.wallet('Waking up…');
    await sleep(pace(650)); view.step(0, 'done'); view.wallet('Ready');

    view.step(1, 'active'); view.term('Sending challenge…');
    // reuse a still-valid challenge generated from the merchant dashboard, else the terminal issues a new one
    const reuse = state.challenges.find((c) => c.merchantId === merchantId && c.source === 'merchant-dashboard' && challengeState(c) === 'Unused');
    const ch = reuse || issueChallenge(merchantId);
    view.sees(`Challenge sent: ${ch.nonce}`);
    await sleep(pace(750)); view.step(1, 'done'); view.term('Challenge answered');

    view.step(2, 'active'); view.wallet('Proving eligibility…');
    await sleep(pace(550));
    const el = await verifyEligibility(cred);
    await sleep(pace(450));
    if (!el.ok) {
      view.step(2, 'fail'); view.stage(false);
      view.sees('Eligibility: ✗ not eligible (no identity shared)');
      const res = submitTransaction({ transactionId, nonce: ch.nonce, merchantId, amount, credId: cred ? cred.id : null, eligibility: el });
      return res;
    }
    view.step(2, 'done'); view.sees('Eligibility: ✓ eligible · category: student · no name/photo/roll number');

    view.step(3, 'active');
    const preview = calcDiscount(amount, merchant.category);
    await sleep(pace(600));
    view.step(3, 'done'); view.sees(`Discount: ${preview.pct}% → pays ${money(preview.finalAmount)}`);

    view.step(4, 'active'); view.wallet('AI risk check…');
    const risk = assessRisk(preview.finalAmount, merchantId);
    await sleep(pace(450));
    view.sees(`AI risk score: ${risk.score}/100 (${risk.level})` + (risk.factors.length ? ' · ' + risk.factors[0].label : ''));
    const held = risk.action === 'block' && !override;
    if (!held) {
      view.step(4, 'done'); view.step(5, 'active'); view.term('Processing…');
      await sleep(pace(600));
    } else await sleep(pace(300));
    const res = submitTransaction({ transactionId, nonce: ch.nonce, merchantId, amount, credId: cred.id, eligibility: el, riskOverride: !!override });
    view.stage(false);
    if (res.ok) { view.step(5, 'done'); view.term('Accepted'); view.sees(`Reference: ${res.tx.transactionId} · status: ${res.tx.settlementStatus}`); }
    else { view.step(failStepFor(res.code), 'fail'); view.term('Declined'); }
    return res;
  }

  /* ---------------------------------------------------------
     9. OFFLINE QUEUE + SETTLEMENT SIMULATION
  --------------------------------------------------------- */
  const pendingTx = () => state.transactions.filter((t) => t.settlementStatus === 'Pending Sync');

  function settleCheck(tx) {
    if (state.ledger.some((l) => l.transactionId === tx.transactionId && l.status === 'Accepted')) return { ok: false, note: 'Duplicate reference already in ledger' };
    if (Math.abs(tx.amount - tx.discountAmount - tx.finalAmount) > 0.005) return { ok: false, note: 'Amount mismatch: final ≠ amount − discount' };
    if (tx.finalAmount < 0 || tx.amount <= 0) return { ok: false, note: 'Invalid amounts' };
    return { ok: true, note: 'Verified and accepted (simulated)' };
  }

  async function setNetwork(mode) {
    if (state.networkMode === mode) return;
    state.networkMode = mode;
    logAudit('network', mode === 'offline' ? 'Switched to Offline mode' : 'Network connection restored');
    save(); renderAll();
    if (mode === 'offline') { toast('Offline Mode on — payments will queue locally.', 'warn'); return; }
    const pill = $('#netToggle');
    pill.classList.add('reconnecting'); $('#netLabel').textContent = 'Reconnecting…';
    toast('Reconnecting to network…', 'info');
    await sleep(pace(1300));
    pill.classList.remove('reconnecting');
    renderHeader();
    if (state.networkMode !== 'online') return;
    if (pendingTx().length) await runSync('Back online — synchronizing queue');
    else toast('Back online. Nothing waiting to sync.', 'ok');
  }

  async function runSync(title) {
    if (syncing) return;
    if (state.networkMode !== 'online') { toast('Cannot synchronize while offline. Switch to Online first.', 'error'); return; }
    const items = pendingTx();
    if (!items.length) { toast('Queue is empty — nothing to settle.', 'info'); return; }
    syncing = true; document.body.dataset.syncing = 'true';
    const batchId = rid('BATCH-', 3);
    $('#syncTitle').textContent = title;
    $('#syncBar').style.width = '0%';
    $('#syncSummary').hidden = true;
    const btn = $('#syncClose'); btn.disabled = true; btn.textContent = 'Working…';
    const rows = items.map((tx) => h('li', { class: '' }, h('span', { class: 'mono' }, tx.transactionId), h('span', {}, 'queued')));
    mount($('#syncList'), rows);
    openModal('syncModal');
    let ok = 0, bad = 0, total = 0;
    for (let i = 0; i < items.length; i++) {
      const tx = items[i]; const row = rows[i];
      row.className = 'active'; row.lastChild.textContent = 'verifying…';
      await sleep(pace(650));
      const verdict = settleCheck(tx);
      if (verdict.ok) { transition(tx, 'Synced'); tx.syncedAt = new Date().toISOString(); tx.settlementNote = verdict.note; addLedger(tx, 'Accepted', verdict.note, batchId); ok++; total += tx.finalAmount; row.className = 'done'; row.lastChild.textContent = '✓ synced'; }
      else { transition(tx, 'Rejected'); tx.settlementNote = verdict.note; addLedger(tx, 'Rejected', verdict.note, batchId); bad++; row.className = 'fail'; row.lastChild.textContent = '✗ ' + verdict.note; }
      $('#syncBar').style.width = Math.round(((i + 1) / items.length) * 100) + '%';
      save();
    }
    state.stats.syncRuns++; state.stats.syncOk += ok; state.stats.syncFail += bad;
    logAudit('sync', `Batch ${batchId}: ${ok} synced, ${bad} rejected (simulated)`, bad ? 'warn' : 'ok');
    save();
    const sm = $('#syncSummary');
    sm.className = 'result-box' + (bad ? '' : ' good');
    mount(sm, h('b', {}, bad ? 'Batch finished with rejections' : '🎉 All records synchronized'),
      h('div', {}, `${ok} synced (${money(total)}) · ${bad} rejected`), h('div', { class: 'muted small mono' }, 'Batch ' + batchId + ' · simulated ledger'));
    sm.hidden = false;
    btn.disabled = false; btn.textContent = 'Done';
    delete document.body.dataset.syncing; syncing = false;
    toast(`Sync complete: ${ok} synced${bad ? ', ' + bad + ' rejected' : ''}.`, bad ? 'warn' : 'ok');
    if (ok && !prefersReduced()) confetti(70);
    renderAll();
  }

  /* ---------------------------------------------------------
     10. ADMIN CREDENTIAL MANAGEMENT
  --------------------------------------------------------- */
  const validName = (s) => /^[\p{L}\p{N} ()_.-]{2,20}$/u.test(s);

  function setCredStatus(id, status) {
    if (!can('admin-cred')) return;
    const c = getCred(id); if (!c) return;
    c.status = status;
    logAudit('admin', `University set ${c.id} → ${status}`, status === 'revoked' ? 'warn' : 'info', status !== 'active');
    save(); renderAll();
    toast(`${c.id} is now ${status}.`, status === 'active' ? 'ok' : 'warn');
  }
  async function renewCred(id) {
    if (!can('admin-cred')) return;
    const c = getCred(id); if (!c) return;
    c.expiry = isoDate(365); c.claims = { credential: c.id, category: 'student', expiry: c.expiry };
    c.signature = await Crypto.sign(c.claims); c.status = 'active';
    logAudit('admin', `University renewed ${c.id} until ${c.expiry}`);
    save(); renderAll(); toast(`${c.id} renewed for 1 year.`, 'ok');
  }
  async function createCred(nickname, expiry) {
    if (!can('admin-cred')) return;
    const nums = state.credentials.map((c) => parseInt(c.id.slice(3), 10) || 1000);
    const id = 'CR-' + (Math.max(1000, ...nums) + 1);
    const claims = { credential: id, category: 'student', expiry };
    state.credentials.push({ id, nickname, status: 'active', expiry, claims, signature: await Crypto.sign(claims) });
    logAudit('admin', `University issued fictional credential ${id}`);
    save(); renderAll(); toast(`Issued ${id} for ${nickname}.`, 'ok');
  }

  /* ---------------------------------------------------------
     11. UI RENDERING
  --------------------------------------------------------- */
  const lastVals = new Map();
  function animateNum(el, from, to, fmt) {
    if (from === to || prefersReduced()) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 700;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur); const e = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(to);
    };
    requestAnimationFrame(step);
  }
  function kpi(key, label, value, o = {}) {
    const fmt = o.fmt || ((v) => String(Math.round(v)));
    const num = h('b', { class: 'num' });
    const from = lastVals.get(key) ?? 0; lastVals.set(key, value);
    num.textContent = fmt(from);
    const card = h('div', { class: 'kpi ' + (o.tone || '') }, h('span', { class: 'kpi-ico' }, o.icon || '•'), h('div', {}, num, h('small', {}, label)));
    animateNum(num, from, value, fmt);
    return card;
  }

  function txRow(tx, onClick) {
    const m = merchantById(tx.merchantId) || MERCHANTS[0];
    const badgeMap = { 'Pending Sync': ['warn', '⏳ Pending Sync'], Synced: ['ok', '✓ Synced'], Rejected: ['bad', 'Rejected'], Declined: ['bad', 'Declined'] };
    const [cls, txt] = badgeMap[tx.settlementStatus] || ['mute', tx.settlementStatus];
    return h('div', { class: 'hist-row', role: 'button', tabindex: '0', onclick: onClick, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } },
      h('span', { class: 'mi' }, m.icon),
      h('div', { class: 'grow' }, h('b', {}, m.name), h('small', {}, shortTime(tx.createdAt) + ' · ' + tx.networkMode + (tx.declineReason ? ' · ' + tx.declineReason : ''))),
      h('div', { class: 'amt' }, tx.settlementStatus === 'Declined' ? money(tx.amount) : money(tx.finalAmount), h('small', {}, h('span', { class: 'badge ' + cls }, txt), tx.risk && tx.risk.action !== 'allow' ? h('span', { class: 'badge warn', title: 'AI risk score' }, ' 🚩 ' + tx.risk.score) : null)));
  }

  function renderHeader() {
    const off = state.networkMode === 'offline';
    const pill = $('#netToggle');
    pill.classList.toggle('offline', off); pill.classList.toggle('online', !off);
    if (!pill.classList.contains('reconnecting')) $('#netLabel').textContent = off ? 'Offline Mode' : 'Online';
    pill.setAttribute('aria-pressed', String(off));
    const pc = pendingTx().length; const badge = $('#netPending');
    badge.hidden = pc === 0; badge.textContent = pc; badge.title = pc + ' pending sync';
    const allowed = ROLE_PAGES[state.role] || [];
    $$('#mainNav a').forEach((a) => {
      const p = a.dataset.page;
      a.hidden = !allowed.includes(p);
      a.classList.toggle('active', p === current);
      if (p === current) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  /* ---- Wallet ---- */
  function renderWallet() {
    const cred = getWalletCred(); const st = effectiveStatus(cred); const active = st === 'active';
    if (ui.loading) { mount($('#walletCard'), ...skeleton(4)); mount($('#walletHistory'), ...skeleton(3)); }
    else {
      const balNum = h('div', { class: 'wc-balance' });
      const from = lastVals.get('wallet-bal') ?? state.balance; lastVals.set('wallet-bal', state.balance);
      balNum.textContent = money(from); animateNum(balNum, from, state.balance, money);
      mount($('#walletCard'), h('div', { class: 'wallet-card' + (active ? '' : ' inactive') },
        h('div', { class: 'wc-top' }, h('span', {}, '⚡ TapOnce Student Wallet'), statusBadge(st)),
        h('div', { class: 'wc-chip' }),
        h('div', { class: 'wc-name' }, state.nickname),
        h('div', { class: 'wc-sub' }, `${state.university} · ${state.program}`),
        h('div', { class: 'wc-bottom' },
          h('div', {}, h('small', {}, 'Eligibility credential (simulated)'), h('b', { class: 'mono' }, cred ? '•••• ' + cred.id.slice(-4) : 'none'), h('small', {}, cred ? 'valid until ' + cred.expiry : '')),
          h('div', { style: { textAlign: 'right' } }, h('small', {}, 'Demo balance'), balNum))));
      const recent = state.transactions.slice(0, 6);
      mount($('#walletHistory'), recent.length ? recent.map((tx) => txRow(tx, () => openReceipt(tx.transactionId))) : emptyState('🧾', 'No transactions yet — tap to pay to see one here.'));
    }
    mount($('#discountList'), MERCHANTS.map((m) => h('div', { class: 'disc-row' }, h('span', { class: 'mi' }, m.icon), h('div', { class: 'grow' }, h('b', {}, m.name), h('small', {}, m.blurb)), h('span', { class: 'pct' }, state.rules[m.category] + '% off'))));
    const off = state.networkMode === 'offline'; const pend = pendingTx();
    const queued = sum(pend, (t) => t.finalAmount); const usedPct = Math.min(100, Math.round((queued / state.limits.offlineTotal) * 100));
    mount($('#netPanel'),
      h('div', { class: 'net-box' },
        h('div', {}, h('small', { class: 'muted' }, 'Network mode'), h('div', { class: 'net-mode' }, off ? '📴 Offline Mode' : '🟢 Online')),
        h('button', { class: 'btn ' + (off ? 'btn-primary' : 'btn-ghost'), type: 'button', onclick: () => setNetwork(off ? 'online' : 'offline') }, off ? 'Go online & sync' : 'Go offline')),
      h('div', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: { width: usedPct + '%' } })),
      h('small', { class: 'muted' }, `${pend.length} pending · ${money(queued)} of ${money(state.limits.offlineTotal)} offline limit used`),
      h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Local simulation — not a real offline payment rail.'));
    renderAiInsights();
  }

  /* ---- AI: insights + risk monitor ---- */
  const aiTxs = () => state.transactions.filter((t) => (t.settlementStatus === 'Synced' || t.settlementStatus === 'Pending Sync') && !t.tampered);
  function aiInsights() {
    const pend = pendingTx();
    return TapAI.insights(aiTxs(), { money, merchants: MERCHANTS, rules: state.rules, balance: state.balance, pending: { count: pend.length, total: sum(pend, (t) => t.finalAmount) }, flagged: state.transactions.filter((t) => t.risk && t.risk.action !== 'allow').length });
  }
  function renderAiInsights() {
    const box = $('#aiInsights'); if (!box) return;
    const i = aiInsights();
    const stat = (label, val) => h('div', { class: 'ai-stat' }, h('b', {}, val), h('small', {}, label));
    const trend = { rising: '📈 rising', falling: '📉 falling', flat: '➡️ steady' }[i.trend];
    mount(box,
      h('h3', {}, '🧠 AI insights ', h('span', { class: 'badge info' }, 'on-device')),
      i.tips.map((t) => h('div', { class: 'ai-tip' }, h('span', { class: 'ai-ico' }, t.icon), h('span', {}, t.text))),
      i.count >= 2 ? h('div', { class: 'ai-stats' }, stat('Next bill (forecast)', money(i.nextSpend)), stat('Bill trend', trend), i.monthlySavings !== null ? stat('Savings / month', money(i.monthlySavings)) : null) : null);
  }
  function renderRiskMonitor() {
    const box = $('#riskMonitor'); if (!box) return;
    const m = state.ai; const rows = state.transactions.filter((t) => t.risk).slice(0, 6);
    const row = (t) => {
      const s = t.risk.score; const cls = s >= m.blockAt ? 'bad' : s >= m.flagAt ? 'warn' : 'ok';
      return h('div', { class: 'list-row' },
        h('div', { class: 'grow' }, h('b', {}, `${(merchantById(t.merchantId) || MERCHANTS[0]).name} · ${money(t.amount)}`),
          h('small', {}, t.risk.factors.length ? t.risk.factors.join(' · ') : 'No risk signals'),
          h('div', { class: 'meter', 'aria-hidden': 'true' }, h('i', { style: { width: s + '%', background: `var(--${cls === 'bad' ? 'red' : cls === 'warn' ? 'amber' : 'ok'})` } }))),
        h('span', { class: 'badge ' + cls }, s + '/100'));
    };
    mount(box, h('h3', {}, '🛰️ AI risk monitor ', h('span', { class: 'badge info' }, 'on-device')),
      h('p', { class: 'small muted' }, m.n ? `Learned from ${m.n} accepted payment(s) · typical bill ${money(m.mean)} · flag ≥ ${m.flagAt}, hold ≥ ${m.blockAt}.` : 'Learning starts with your first accepted payment; a cautious default profile is used until then.'),
      rows.length ? rows.map(row) : emptyState('🛰️', 'No scored payments yet.'));
  }

  /* ---- Merchant ---- */
  function renderMerchant() {
    const sel = $('#merchantSelect');
    if (!sel.options.length) MERCHANTS.forEach((m) => sel.append(h('option', { value: m.id }, `${m.icon} ${m.name} (${m.id})`)));
    sel.value = state.activeMerchant;
    const mid = state.activeMerchant; const m = merchantById(mid);
    const acc = state.transactions.filter((t) => t.merchantId === mid && t.settlementStatus !== 'Declined');
    const pend = acc.filter((t) => t.settlementStatus === 'Pending Sync');
    const syncLabel = state.networkMode === 'offline' ? (pend.length ? 'Offline · queueing' : 'Offline') : (pend.length ? pend.length + ' awaiting sync' : 'All synced');
    mount($('#merchantKpis'),
      kpi('m-sales', 'Total simulated sales', sum(acc, (t) => t.finalAmount), { icon: '💰', fmt: money }),
      kpi('m-disc', 'Student discounts granted', sum(acc, (t) => t.discountAmount), { icon: '🎁', fmt: money, tone: 't-pink' }),
      kpi('m-acc', 'Transactions accepted', acc.length, { icon: '✅', tone: 't-teal' }),
      kpi('m-pend', 'Pending offline', pend.length, { icon: '⏳', tone: 't-amber' }),
      h('div', { class: 'kpi' }, h('span', { class: 'kpi-ico' }, '🔄'), h('div', {}, h('b', { class: 'num', style: { fontSize: '1.1rem' } }, syncLabel), h('small', {}, 'Synchronization status'))));
    const rec = acc.slice(0, 6);
    mount($('#merchantReceipts'), rec.length ? rec.map((tx) => txRow(tx, () => openReceipt(tx.transactionId))) : emptyState('🧾', `No receipts yet for ${m.name}.`));
    renderChallengeBox();
  }
  function renderChallengeBox() {
    const c = state.challenges.find((x) => x.merchantId === state.activeMerchant && x.source === 'merchant-dashboard');
    const box = $('#challengeBox'); if (!box) return;
    if (!c) { mount(box, emptyState('🎲', 'No challenge generated yet.')); return; }
    mount(box, h('div', { class: 'nonce mono' }, c.nonce), h('div', {}, 'Status: ', h('span', { class: 'badge ' + (challengeState(c) === 'Unused' ? 'ok' : 'mute') }, challengeState(c))), h('small', { class: 'muted', id: 'chCountdown' }, countdownText(c)));
  }
  const countdownText = (c) => { const left = Math.max(0, Math.round((CHALLENGE_TTL_MS - (Date.now() - c.issuedAt)) / 1000)); return c.used ? 'Consumed by a tap.' : left ? `Valid for ${left}s more` : 'Expired'; };

  /* ---- Admin ---- */
  function renderAdmin() {
    const creds = state.credentials; const stat = (s) => creds.filter((c) => effectiveStatus(c) === s).length;
    const real = state.transactions.filter((t) => t.settlementStatus !== 'Declined');
    mount($('#adminStats'),
      kpi('a-act', 'Active credentials', stat('active'), { icon: '🪪', tone: 't-teal' }),
      kpi('a-exp', 'Expired / revoked / inactive', creds.length - stat('active'), { icon: '⌛', tone: 't-amber' }),
      kpi('a-tx', 'Transactions', real.length, { icon: '🧾' }),
      kpi('a-disc', 'Discounts granted', sum(real, (t) => t.discountAmount), { icon: '🎁', fmt: money, tone: 't-pink' }));
    const head = h('thead', {}, h('tr', {}, ['Credential', 'Student (fictional)', 'Status', 'Valid until', 'Actions'].map((x) => h('th', {}, x))));
    const body = h('tbody', {}, creds.map((c) => {
      const st = effectiveStatus(c); const acts = [];
      if (st === 'active') { acts.push(h('button', { class: 'btn btn-sm', type: 'button', onclick: () => setCredStatus(c.id, 'inactive') }, 'Deactivate'), h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: () => setCredStatus(c.id, 'revoked') }, 'Revoke')); }
      else if (st === 'expired') acts.push(h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => renewCred(c.id) }, 'Renew 1y'));
      else acts.push(h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => setCredStatus(c.id, 'active') }, 'Reactivate'));
      return h('tr', {}, h('td', { class: 'mono' }, c.id + (c.id === state.walletCredId ? ' 📱' : '')), h('td', {}, c.nickname), h('td', {}, statusBadge(st)), h('td', {}, c.expiry), h('td', {}, acts));
    }));
    mount($('#credTable'), head, body);
    const rf = $('#ruleFields');
    if (!rf.children.length || ui.rulesDirty) {
      mount(rf, MERCHANTS.map((m) => h('div', { class: 'rule-row' }, h('label', { for: 'rule-' + m.category }, `${m.icon} ${m.name}`), h('input', { id: 'rule-' + m.category, type: 'number', min: '0', max: '50', step: '1', value: state.rules[m.category], 'aria-label': m.name + ' discount percent' }))));
      ui.rulesDirty = false;
    }
    mount($('#adminMerchants'), MERCHANTS.map((m) => {
      const t = real.filter((x) => x.merchantId === m.id);
      return h('div', { class: 'list-row' }, h('span', { class: 'mi' }, m.icon), h('div', { class: 'grow' }, h('b', {}, m.name), h('small', {}, `${t.length} txns · ${money(sum(t, (x) => x.finalAmount))} sales · ${t.filter((x) => x.settlementStatus === 'Pending Sync').length} pending`)), h('span', { class: 'pct' }, state.rules[m.category] + '%'));
    }));
    const ev = state.audit.filter((a) => a.security).slice(0, 8);
    mount($('#adminEvents'), ev.length ? h('ul', { class: 'timeline' }, ev.map(auditLi)) : emptyState('🛡️', 'No security events yet.'));
  }
  const auditLi = (a) => h('li', { class: a.level }, a.text, h('small', {}, timeFmt(a.at) + ' · ' + a.type));

  /* ---- Security ---- */
  function renderSecurity() {
    $('#limTx').value = state.limits.perTx; $('#limTotal').value = state.limits.offlineTotal;
    const log = state.challenges.slice(0, 8);
    mount($('#challengeLog'), log.length ? log.map((c) => { const s = challengeState(c); return h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('b', { class: 'mono' }, c.nonce), h('small', {}, `${merchantById(c.merchantId)?.name || c.merchantId} · ${shortTime(new Date(c.issuedAt).toISOString())}`)), h('span', { class: 'badge ' + (s === 'Unused' ? 'ok' : s === 'Used' ? 'info' : 'warn') }, s)); }) : emptyState('🎲', 'No challenges issued yet. A tap creates one.'));
    mount($('#credStatusPanel'), state.credentials.map((c) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('b', {}, c.id + (c.id === state.walletCredId ? ' (this wallet)' : '')), h('small', {}, 'valid until ' + c.expiry)), statusBadge(effectiveStatus(c)))),
      h('p', { class: 'small muted' }, 'Proof check: ' + Crypto.label() + ' + revocation registry.'));
    const au = state.audit.slice(0, 15);
    mount($('#auditTrail'), au.length ? h('ul', { class: 'timeline' }, au.map(auditLi)) : emptyState('📜', 'Audit trail is empty — make a payment.'));
    const box = $('#dupResult');
    if (ui.lastDup) {
      box.hidden = false; box.className = 'result-box' + (ui.lastDup.kind === 'info' ? ' good' : '');
      mount(box, h('b', {}, ui.lastDup.title), h('p', {}, ui.lastDup.body), h('p', { class: 'small muted' }, ui.lastDup.note));
    } else box.hidden = true;
  }

  /* ---- Settlement ---- */
  function renderSettlement() {
    const pend = pendingTx();
    const synced = state.transactions.filter((t) => t.settlementStatus === 'Synced');
    const rej = state.transactions.filter((t) => t.settlementStatus === 'Rejected');
    mount($('#settleSummary'),
      kpi('s-pend', 'Pending', pend.length, { icon: '⏳', tone: 't-amber' }),
      kpi('s-sync', 'Synced', synced.length, { icon: '✅', tone: 't-teal' }),
      kpi('s-rej', 'Rejected', rej.length, { icon: '⛔', tone: 't-pink' }),
      kpi('s-led', 'Ledger records', state.ledger.length, { icon: '📒' }));
    const li = (tx) => h('div', { class: 'list-row' }, h('div', { class: 'grow' }, h('b', { class: 'mono' }, tx.transactionId), h('small', {}, `${tx.merchantId} · ${timeFmt(tx.createdAt)}${tx.settlementNote ? ' · ' + tx.settlementNote : ''}`)), h('span', { class: 'amt' }, money(tx.finalAmount)));
    mount($('#pendingList'), pend.length ? pend.slice(0, 8).map(li) : emptyState('📭', 'Queue is empty.'));
    mount($('#syncedList'), synced.length ? synced.slice(0, 8).map(li) : emptyState('🌐', 'Nothing synced yet.'));
    mount($('#rejectedList'), rej.length ? rej.slice(0, 8).map(li) : emptyState('👍', 'No rejected records.'));
    const head = h('thead', {}, h('tr', {}, ['Reference', 'Merchant', 'Amount', 'Result', 'Settled at', 'Batch'].map((x) => h('th', {}, x))));
    const body = h('tbody', {}, state.ledger.slice(0, 10).map((l) => h('tr', {}, h('td', { class: 'mono' }, l.transactionId), h('td', { class: 'mono' }, l.merchantId), h('td', {}, money(l.finalAmount)), h('td', {}, h('span', { class: 'badge ' + (l.status === 'Accepted' ? 'ok' : 'bad') }, l.status)), h('td', {}, timeFmt(l.settledAt)), h('td', { class: 'mono' }, l.batchId))));
    mount($('#ledgerTable'), state.ledger.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, head, body)) : emptyState('📒', 'Ledger is empty. Simulated records appear after a payment or sync.'));
  }

  /* ---- Analytics ---- */
  function renderAnalytics() {
    const real = state.transactions.filter((t) => t.settlementStatus !== 'Declined');
    const offlineDone = real.filter((t) => t.networkMode === 'offline' && t.settlementStatus !== 'Pending Sync');
    const okRate = offlineDone.length ? Math.round((offlineDone.filter((t) => t.settlementStatus === 'Synced').length / offlineDone.length) * 100) : null;
    const avg = state.stats.verifyCount ? state.stats.verifyMsTotal / state.stats.verifyCount : null;
    if (ui.loading) { mount($('#analyticsKpis'), ...skeleton(3)); } else {
      mount($('#analyticsKpis'),
        kpi('an-tx', 'Total demo transactions', real.length, { icon: '🧾' }),
        kpi('an-disc', 'Total discounts granted', sum(real, (t) => t.discountAmount), { icon: '🎁', fmt: money, tone: 't-pink' }),
        kpi('an-pend', 'Awaiting synchronization', pendingTx().length, { icon: '⏳', tone: 't-amber' }),
        okRate === null ? h('div', { class: 'kpi t-teal' }, h('span', { class: 'kpi-ico' }, '🔄'), h('div', {}, h('b', { class: 'num' }, '—'), h('small', {}, 'Offline sync success rate'))) : kpi('an-rate', 'Offline sync success rate', okRate, { icon: '🔄', tone: 't-teal', fmt: (v) => Math.round(v) + '%' }),
        kpi('an-dup', 'Duplicates rejected', state.stats.duplicatesRejected, { icon: '🛑', tone: 't-pink' }),
        avg === null ? h('div', { class: 'kpi' }, h('span', { class: 'kpi-ico' }, '⏱️'), h('div', {}, h('b', { class: 'num' }, '—'), h('small', {}, 'Avg verification time'))) : kpi('an-avg', 'Avg verification (measured)', avg, { icon: '⏱️', fmt: (v) => v.toFixed(1) + ' ms' }));
    }
    const maxN = Math.max(1, ...MERCHANTS.map((m) => real.filter((t) => t.merchantId === m.id).length));
    mount($('#chartMerchants'), real.length ? h('div', { class: 'bars' }, MERCHANTS.map((m) => {
      const t = real.filter((x) => x.merchantId === m.id);
      return h('div', { class: 'bar-row' }, h('div', { class: 'bar-label' }, h('span', {}, `${m.icon} ${m.name}`), h('b', {}, `${t.length} · saved ${money(sum(t, (x) => x.discountAmount))}`)),
        h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width: Math.round((t.length / maxN) * 100) + '%', background: m.color } })));
    })) : emptyState('📊', 'No transactions yet. Run a scenario to see the chart.'));
    const segs = [['Pending Sync', '#ffb020'], ['Synced', '#34e5a0'], ['Rejected', '#ff5c70'], ['Declined', '#7c5cff']].map(([k, c]) => ({ k, c, n: state.transactions.filter((t) => t.settlementStatus === k).length }));
    const total = sum(segs, (s) => s.n);
    if (!total) mount($('#chartDonut'), emptyState('🍩', 'Nothing to chart yet.'));
    else {
      let acc = 0; const parts = segs.filter((s) => s.n).map((s) => { const from = acc; acc += (s.n / total) * 100; return `${s.c} ${from}% ${acc}%`; });
      const donut = h('div', { class: 'donut', 'data-center': total + '\ntotal', role: 'img', 'aria-label': 'Status mix' });
      donut.style.setProperty('--donut', parts.join(', '));
      mount($('#chartDonut'), h('div', { class: 'donut-wrap' }, donut, h('ul', { class: 'legend' }, segs.map((s) => h('li', {}, h('i', { style: { background: s.c } }), `${s.k}: ${s.n}`)))));
    }
    const tl = state.audit.slice(0, 12);
    mount($('#activityTimeline'), tl.length ? h('ul', { class: 'timeline' }, tl.map(auditLi)) : emptyState('⏱️', 'Activity appears here as you use the demo.'));
    renderRiskMonitor();
  }

  function renderPage(page) {
    switch (page) {
      case 'wallet': renderWallet(); break;
      case 'merchant': renderMerchant(); break;
      case 'admin': renderAdmin(); break;
      case 'security': renderSecurity(); break;
      case 'settlement': renderSettlement(); break;
      case 'analytics': renderAnalytics(); break;
      default: break;
    }
  }
  // Performance: many actions call renderAll() back-to-back; coalesce them into one render per frame.
  let rafId = 0;
  function renderNow() { rafId = 0; renderHeader(); renderPage(current); }
  function renderAll() { if (!rafId) rafId = requestAnimationFrame(renderNow); }

  /* ---- Modals ---- */
  const modalStack = [];
  function openModal(id) {
    const m = document.getElementById(id); if (!m) return;
    m.dataset.returnFocus = ''; m._prev = document.activeElement;
    m.hidden = false; document.body.classList.add('modal-open');
    requestAnimationFrame(() => m.classList.add('show'));
    if (!modalStack.includes(id)) modalStack.push(id);
    const f = $('.close, button, input', m); if (f) setTimeout(() => f.focus({ preventScroll: true }), 60);
  }
  function closeModal(id) {
    const m = document.getElementById(id); if (!m || m.hidden) return;
    if (id === 'syncModal' && syncing) return;
    if (id === 'tapModal' && ui.tap.running) return;
    m.classList.remove('show');
    setTimeout(() => { m.hidden = true; }, 250);
    const i = modalStack.indexOf(id); if (i >= 0) modalStack.splice(i, 1);
    if (!modalStack.length) document.body.classList.remove('modal-open');
    if (m._prev && m._prev.focus) m._prev.focus({ preventScroll: true });
    renderAll();
  }

  /* ---- Receipt ---- */
  function receiptNode(tx) {
    const m = merchantById(tx.merchantId) || MERCHANTS[0];
    const row = (a, b, cls) => h('div', { class: 'calc-row ' + (cls || '') }, h('span', {}, a), h('span', {}, b));
    const declined = tx.settlementStatus === 'Declined';
    return h('div', { class: 'receipt' },
      row('Reference', h('span', { class: 'mono' }, tx.transactionId)),
      row('Merchant', `${m.name} (${m.id})`),
      row('Time', timeFmt(tx.createdAt)),
      row('Original amount', money(tx.amount)),
      declined ? row('Result', 'Declined — ' + tx.declineReason) : [
        row(`Student discount (${tx.discountPct}%)`, h('span', { class: 'disc' }, '− ' + money(tx.discountAmount))),
        row('Final amount', money(tx.finalAmount), 'final')],
      row('Network mode', tx.networkMode === 'offline' ? 'Offline' : 'Online'),
      row('Status', tx.settlementStatus),
      tx.risk ? row('AI risk score', `${tx.risk.score}/100 (${tx.risk.level})`) : null,
      row('Merchant learned', declined ? 'Not eligible' : 'Eligible · student category only'),
      h('p', { class: 'small muted', style: { marginTop: '8px' } }, 'Simulated receipt — no real payment took place.'));
  }
  function openReceipt(id) {
    const tx = state.transactions.find((t) => t.transactionId === id); if (!tx) return;
    mount($('#receiptBody'), receiptNode(tx));
    openModal('receiptModal');
  }

  /* ---- Tap modal ---- */
  function currentTapAmount() { return $('#tapAmount').value.trim(); }
  function renderTapSelect() {
    mount($('#tapMerchants'), MERCHANTS.map((m) => h('button', { class: 'm-opt', type: 'button', role: 'radio', 'aria-checked': String(m.id === ui.tap.merchantId), onclick: () => { ui.tap.merchantId = m.id; renderTapSelect(); } },
      h('span', { class: 'mi' }, m.icon), h('div', {}, h('b', {}, m.name), h('small', {}, state.rules[m.category] + '% student discount')))));
    mount($('#tapChips'), [50, 100, 250, 500].map((v) => h('button', { class: 'chip-btn', type: 'button', onclick: () => { $('#tapAmount').value = v; renderTapSelect(); } }, '₹' + v)));
    const cred = getWalletCred(); const st = effectiveStatus(cred);
    mount($('#tapCred'), h('span', {}, '🪪 Credential: ', h('b', { class: 'mono' }, cred ? '•••• ' + cred.id.slice(-4) : 'none')), statusBadge(st),
      h('span', { class: 'badge ' + (state.networkMode === 'offline' ? 'warn' : 'ok') }, state.networkMode === 'offline' ? '📴 Offline Mode' : '🟢 Online'));
    const v = validateAmount(currentTapAmount()); const m = merchantById(ui.tap.merchantId);
    if (!v.ok) { mount($('#tapPreview'), h('div', { class: 'muted small' }, 'Enter a valid amount to see the discount calculation.')); return; }
    const d = calcDiscount(v.value, m.category); const row = (a, b, cls) => h('div', { class: 'calc-row ' + (cls || '') }, h('span', {}, a), h('span', {}, b));
    mount($('#tapPreview'), row('Original amount', money(d.amount)), row(`Student discount (${d.pct}%)`, h('span', { class: 'disc' }, '− ' + money(d.discountAmount))), row('Final amount', money(d.finalAmount), 'final'),
      st !== 'active' ? h('div', { class: 'small', style: { color: '#ff9aa8', marginTop: '6px' } }, 'Heads-up: this credential is not active — the tap will be declined.') : null);
  }

  function openTap(preset) {
    if (ui.tap.running) return;
    if (preset && preset.merchantId) ui.tap.merchantId = preset.merchantId;
    ui.tap.override = !!(preset && preset.override);
    $('#tapAmount').value = preset && preset.amount ? preset.amount : ($('#tapAmount').value || 100);
    $('#tapError').textContent = '';
    $('#tapSelect').hidden = false; $('#tapRun').hidden = true; $('#tapResult').hidden = true;
    renderTapSelect(); openModal('tapModal');
    if (preset && preset.auto) setTimeout(startTap, pace(500));
  }

  function buildRunView(merchant) {
    $('#stageMerchant').textContent = merchant.name; $('#stageWallet').textContent = 'Waiting'; $('#stageTerm').textContent = 'Waiting';
    mount($('#tapSteps'), STEP_LABELS.map((l, i) => h('li', { 'data-i': i }, h('span', { class: 'si' }, i + 1), h('span', {}, l))));
    mount($('#tapSees'), h('li', {}, 'Waiting for the tap…'));
    const stage = $('#tapStage');
    const sees = [];
    return {
      step(i, status) {
        const li = $('#tapSteps li[data-i="' + i + '"]'); if (!li) return;
        li.className = status; const si = li.firstChild;
        si.textContent = status === 'done' ? '✓' : status === 'fail' ? '✕' : String(i + 1);
      },
      stage(on) { stage.classList.toggle('scanning', on); $$('.dev', stage).forEach((d) => d.classList.toggle('active', on)); },
      wallet(t) { $('#stageWallet').textContent = t; },
      term(t) { $('#stageTerm').textContent = t; },
      sees(t) { sees.push(t); mount($('#tapSees'), sees.map((s) => h('li', {}, s))); },
    };
  }

  async function startTap() {
    if (ui.tap.running) return;
    const v = validateAmount(currentTapAmount());
    if (!v.ok) { $('#tapError').textContent = v.msg; return; }
    $('#tapError').textContent = '';
    const merchant = merchantById(ui.tap.merchantId);
    ui.tap.running = true;
    $('#tapSelect').hidden = true; $('#tapResult').hidden = true; $('#tapRun').hidden = false;
    const view = buildRunView(merchant);
    let res;
    const override = !!ui.tap.override; ui.tap.override = false;
    try { res = await executeTap({ merchantId: merchant.id, amount: v.value, override }, view); }
    catch (e) { res = { ok: false, code: 'ERROR', reason: 'Unexpected error: ' + e.message }; }
    await sleep(pace(500));
    ui.tap.running = false;
    showTapResult(res, merchant);
    renderAll();
  }

  function showTapResult(res, merchant) {
    $('#tapRun').hidden = true; $('#tapResult').hidden = false;
    const box = $('#tapResult');
    const check = (bad) => {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 100 100'); svg.setAttribute('class', 'check' + (bad ? ' bad' : ''));
      const c = document.createElementNS(svg.namespaceURI, 'circle'); c.setAttribute('cx', 50); c.setAttribute('cy', 50); c.setAttribute('r', 41);
      const p = document.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', bad ? 'M34 34 L66 66 M66 34 L34 66' : 'M30 52 L45 66 L71 36');
      svg.append(c, p); return svg;
    };
    if (res.ok) {
      ui.tap.lastTx = res.tx;
      mount(box, h('div', { class: 'result-hero' }, check(false), h('h2', {}, 'Payment accepted!'),
        h('p', { class: 'muted' }, res.tx.settlementStatus === 'Pending Sync' ? '📴 Stored offline — queued for synchronization.' : '🌐 Settled instantly (simulated ledger).')),
        receiptNode(res.tx),
        h('div', { class: 'btn-row' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => closeModal('tapModal') }, 'Done'), h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => openTap({ merchantId: merchant.id }) }, 'Tap again')));
      if (!prefersReduced()) confetti(110);
      toast(`Paid ${money(res.tx.finalAmount)} — saved ${money(res.tx.discountAmount)}!`, 'ok');
    } else {
      const credProblem = res.tx && ['revoked', 'expired', 'inactive', 'missing'].includes(res.tx.credentialStatus);
      mount(box, h('div', { class: 'result-hero' }, check(true), h('h2', {}, 'Payment declined')),
        h('div', { class: 'result-box' }, h('b', {}, 'Reason'), h('p', {}, res.reason), h('p', { class: 'small muted' }, 'No money moved and no discount was applied. The merchant learned nothing about the student.')),
        h('div', { class: 'btn-row', style: { marginTop: '12px' } },
          credProblem && can('admin-cred') ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { const c = getWalletCred(); if (effectiveStatus(c) === 'expired') renewCred(c.id); else setCredStatus(c.id, 'active'); closeModal('tapModal'); } }, 'Reactivate demo credential') : null,
          res.code === 'RISK_HELD' ? h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { closeModal('tapModal'); setTimeout(() => openTap({ merchantId: merchant.id, amount: res.tx.amount, auto: true, override: true }), 300); } }, "It's me — approve anyway") : null,
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => closeModal('tapModal') }, 'Close')));
      toast('Declined: ' + res.reason, 'error');
    }
  }

  /* ---- Confetti ---- */
  function confetti(n = 100) {
    if (prefersReduced()) return;
    const cv = $('#confetti'); const ctx = cv.getContext('2d');
    cv.width = innerWidth; cv.height = innerHeight;
    const colors = ['#7c5cff', '#22d3ee', '#2dd4bf', '#ff5fa2', '#ffb020', '#a3e635'];
    const ps = Array.from({ length: n }, () => ({ x: innerWidth / 2 + (Math.random() - 0.5) * 200, y: innerHeight * 0.45, vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 12 - 3, s: 5 + Math.random() * 6, c: colors[Math.floor(Math.random() * colors.length)], r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3 }));
    const t0 = performance.now();
    (function frame(now) {
      const t = now - t0; ctx.clearRect(0, 0, cv.width, cv.height);
      ps.forEach((p) => { p.vy += 0.3; p.x += p.vx; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.globalAlpha = Math.max(0, 1 - t / 2000); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore(); });
      if (t < 2000) requestAnimationFrame(frame); else ctx.clearRect(0, 0, cv.width, cv.height);
    })(t0);
  }

  /* ---------------------------------------------------------
     12. NAVIGATION, ACTIONS, SCENARIOS, EVENTS, BOOT
  --------------------------------------------------------- */
  function closeMenu() { $('#mainNav').classList.remove('open'); $('#menuBtn').setAttribute('aria-expanded', 'false'); }
  function navigate(page) {
    if (!PAGES.includes(page)) page = 'home';
    if (!(ROLE_PAGES[state.role] || []).includes(page)) {
      if (currentUser) toast('Your role cannot open that page.', 'warn');
      page = ROLE_HOME[state.role] || 'home';
    }
    current = page;
    $$('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
    if (location.hash !== '#/' + page) history.replaceState(null, '', '#/' + page);
    renderAll(); closeMenu();
    window.scrollTo({ top: 0, behavior: prefersReduced() ? 'auto' : 'smooth' });
  }
  const route = () => navigate((location.hash.replace(/^#\/?/, '') || 'home'));

  function dupTest(fromScenario) {
    const last = state.transactions.find((t) => t.settlementStatus !== 'Declined' && !t.tampered);
    if (!last) { toast('Make a payment first, then replay it.', 'warn'); if (fromScenario) openTap({ merchantId: 'MRC-CAN-01', amount: 100 }); return; }
    const res = submitTransaction({ transactionId: last.transactionId, nonce: last.nonce, merchantId: last.merchantId, amount: last.amount, credId: last.credId, eligibility: { ok: true, ms: 0, credentialStatus: 'active' } });
    ui.lastDup = res.ok
      ? { kind: 'info', title: 'Unexpected: duplicate accepted', body: 'This should never happen.', note: '' }
      : { kind: 'err', title: '🛑 Duplicate transaction rejected', body: `${res.reason} The reference is checked before anything else (idempotency), and the merchant challenge was already consumed, so a captured tap cannot be replayed.`, note: 'Reality check: real offline double-spend prevention needs trusted hardware (secure element), protected monotonic counters and protocol-level safeguards. LocalStorage alone cannot stop a determined attacker.' };
    toast(res.ok ? 'Unexpected result.' : 'Duplicate rejected — ' + res.reason, 'error');
    if (fromScenario && (ROLE_PAGES[state.role] || []).includes('security')) navigate('security'); else renderAll();
  }

  function tamperTest() {
    const tx = { transactionId: rid('TX-', 5), merchantId: 'MRC-CAN-01', amount: 100, discountAmount: 10, finalAmount: 60, credentialStatus: 'active', createdAt: new Date().toISOString(), networkMode: 'offline', settlementStatus: 'Pending Sync', category: 'canteen', discountPct: 10, discountApplied: true, nonce: 'n/a', credId: null, verifyMs: 0, tampered: true };
    state.transactions.unshift(tx);
    logAudit('security', `Injected simulated tampered record ${tx.transactionId} (final ≠ amount − discount)`, 'warn', true);
    save(); renderAll();
    toast('Tampered record queued. Run settlement to watch it get rejected.', 'warn');
  }

  async function runScenario(n) {
    if (ui.tap.running || syncing) return;
    const ensureActive = () => { const c = getWalletCred(); if (c && effectiveStatus(c) !== 'active') { c.status = 'active'; if (effectiveStatus(c) === 'expired') { c.expiry = isoDate(365); c.claims = { credential: c.id, category: 'student', expiry: c.expiry }; return Crypto.sign(c.claims).then((s) => { c.signature = s; }); } } return Promise.resolve(); };
    if (n === 1) {
      await ensureActive();
      if (state.networkMode !== 'offline') { state.networkMode = 'offline'; logAudit('network', 'Scenario 1: switched to Offline mode'); save(); }
      navigate('wallet'); openTap({ merchantId: 'MRC-CAN-01', amount: 100, auto: true });
    } else if (n === 2) {
      navigate('wallet');
      if (!pendingTx().length) { toast('Nothing queued. Run Scenario 1 first.', 'warn'); return; }
      if (state.networkMode === 'offline') await setNetwork('online'); else await runSync('Synchronizing queue');
    } else if (n === 3) {
      dupTest(true);
    } else if (n === 4) {
      const c = getWalletCred(); if (c) { c.status = 'revoked'; logAudit('admin', `Scenario 4: ${c.id} revoked`, 'warn', true); save(); }
      navigate('wallet'); openTap({ merchantId: 'MRC-CAN-01', amount: 100, auto: true });
    }
  }

  async function resetDemo() {
    if (!window.confirm('Reset TapOnce to its initial state? All demo data will be cleared.')) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    const role = state.role;
    state = defaultState(); state.role = role; lastVals.clear(); ui.lastDup = null; ui.rulesDirty = true;
    Crypto.retried = false; await Crypto.init(); await seedCredentials(); save();
    $('#merchantSelect').replaceChildren();
    renderAll(); toast('Demo reset. Replay any scenario!', 'ok');
  }

  function handleAction(a) {
    if (!can(a.startsWith('scenario-') ? 'scenario' : a)) { toast('Your role is not allowed to do this.', 'error'); return null; }
    if (a.startsWith('scenario-')) return runScenario(Number(a.split('-')[1]));
    switch (a) {
      case 'open-tap': return openTap();
      case 'edit-identity': return openIdentity();
      case 'top-up': state.balance = Math.min(100000, state.balance + 500); logAudit('wallet', 'Demo top-up ₹500'); save(); renderAll(); return toast('Added ₹500 demo balance.', 'ok');
      case 'reset': return resetDemo();
      case 'gen-challenge': { const c = issueChallenge(state.activeMerchant, 'merchant-dashboard'); renderAll(); return toast('Challenge ' + c.nonce + ' generated.', 'ok'); }
      case 'dup-test': return dupTest(false);
      case 'tamper-test': return tamperTest();
      case 'run-settlement': return runSync('DRUNIX settlement demo (simulated)');
      default: return null;
    }
  }

  function openIdentity() {
    $('#idNick').value = state.nickname; $('#idUni').value = state.university; $('#idProg').value = state.program; $('#idError').textContent = '';
    mount($('#idCred'), state.credentials.map((c) => h('option', { value: c.id }, `${c.id} · ${c.nickname} · ${effectiveStatus(c)}`)));
    $('#idCred').value = state.walletCredId;
    openModal('identityModal');
  }

  function bindEvents() {
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-go]'); if (go) { navigate(go.dataset.go); return; }
      const sc = e.target.closest('[data-scroll]'); if (sc) { const t = document.getElementById(sc.dataset.scroll); if (t) t.scrollIntoView({ behavior: prefersReduced() ? 'auto' : 'smooth' }); return; }
      const cl = e.target.closest('[data-close]'); if (cl) { closeModal(cl.dataset.close); return; }
      const ac = e.target.closest('[data-action]'); if (ac) handleAction(ac.dataset.action);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalStack.length) closeModal(modalStack[modalStack.length - 1]); });
    window.addEventListener('hashchange', route);
    $('#netToggle').addEventListener('click', () => setNetwork(state.networkMode === 'online' ? 'offline' : 'online'));
    bindAuth(); bindPerf();
    $('#menuBtn').addEventListener('click', () => { const o = $('#mainNav').classList.toggle('open'); $('#menuBtn').setAttribute('aria-expanded', String(o)); });
    $('#merchantSelect').addEventListener('change', (e) => { state.activeMerchant = e.target.value; save(); renderAll(); });
    $('#tapStart').addEventListener('click', startTap);
    $('#tapAmount').addEventListener('input', renderTapSelect);
    $('#syncClose').addEventListener('click', () => { if (!syncing) closeModal('syncModal'); });

    $('#identityForm').addEventListener('submit', (e) => {
      e.preventDefault(); if (!can('edit-identity')) return;
      const nick = $('#idNick').value.trim(), uni = $('#idUni').value.trim(), prog = $('#idProg').value.trim();
      if (!validName(nick)) { $('#idError').textContent = 'Nickname: 2–20 letters, numbers, spaces or ( ) _ . -'; return; }
      if (uni.length < 2 || prog.length < 2) { $('#idError').textContent = 'University and programme need at least 2 characters.'; return; }
      state.nickname = nick; state.university = uni; state.program = prog; state.walletCredId = $('#idCred').value;
      logAudit('wallet', 'Demo identity updated (fictional)'); save(); closeModal('identityModal'); toast('Demo identity saved.', 'ok');
    });
    $('#credForm').addEventListener('submit', async (e) => {
      e.preventDefault(); if (!can('admin-cred')) return;
      const name = $('#credName').value.trim(), exp = $('#credExpiry').value; const err = $('#credError');
      if (!validName(name)) { err.textContent = 'Use a fictional nickname: 2–20 letters, numbers, spaces or ( ) _ . -'; return; }
      if (!exp || exp <= isoDate(0)) { err.textContent = 'Choose a future expiry date.'; return; }
      if (state.credentials.length >= 12) { err.textContent = 'Demo limit of 12 credentials reached.'; return; }
      err.textContent = ''; await createCred(name, exp); $('#credName').value = '';
    });
    $('#ruleForm').addEventListener('submit', (e) => {
      e.preventDefault(); if (!can('admin-rules')) return; const err = $('#ruleError'); const next = {};
      for (const m of MERCHANTS) {
        const raw = $('#rule-' + m.category).value; const n = Number(raw);
        if (raw === '' || !Number.isInteger(n) || n < 0 || n > 50) { err.textContent = `${m.name}: enter a whole number from 0 to 50.`; return; }
        next[m.category] = n;
      }
      err.textContent = ''; state.rules = next; logAudit('admin', 'University updated discount rules: ' + MERCHANTS.map((m) => `${m.category} ${next[m.category]}%`).join(', ')); save(); renderAll(); toast('Discount rules saved.', 'ok');
    });
    $('#limitForm').addEventListener('submit', (e) => {
      e.preventDefault(); if (!can('limits')) return; const err = $('#limitError');
      const a = Number($('#limTx').value), b = Number($('#limTotal').value);
      if (!Number.isInteger(a) || a < 1 || a > 5000) { err.textContent = 'Per-transaction limit: whole number 1–5000.'; return; }
      if (!Number.isInteger(b) || b < 1 || b > 20000) { err.textContent = 'Total limit: whole number 1–20000.'; return; }
      if (a > b) { err.textContent = 'Per-transaction limit cannot exceed the total limit.'; return; }
      err.textContent = ''; state.limits = { perTx: a, offlineTotal: b }; logAudit('security', `Offline limits set: ${money(a)} per tx, ${money(b)} total`, 'info', true); save(); renderAll(); toast('Offline limits saved.', 'ok');
    });

    // live countdown for the merchant challenge (updates one element only)
    setInterval(() => {
      const el = document.getElementById('chCountdown'); if (!el || current !== 'merchant') return;
      const c = state.challenges.find((x) => x.merchantId === state.activeMerchant && x.source === 'merchant-dashboard'); if (c) el.textContent = countdownText(c);
    }, 1000);
  }

  /* ---------------------------------------------------------
     13. AUTHENTICATION (prototype) — PBKDF2 hashes, sessions, lockout, roles
  --------------------------------------------------------- */
  const ROLE_LABEL = { student: '🎓 Student', merchant: '🏪 Merchant', university: '🏛️ University admin' };
  let authDb = { v: 1, users: [] };
  let currentUser = null;
  let session = null;
  let authBusy = false;
  let lastTouch = 0;

  const can = (action) => !!currentUser && (ACTION_ROLES[action] || []).includes(currentUser.role);
  function loadAuth() {
    try { const p = JSON.parse(localStorage.getItem(AUTH_KEY)); if (p && p.v === 1 && Array.isArray(p.users)) authDb = p; } catch (e) { /* start empty */ }
  }
  function saveAuth() { try { localStorage.setItem(AUTH_KEY, JSON.stringify(authDb)); } catch (e) { /* ignore */ } }
  function readSession() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESS_KEY));
      if (s && s.exp > Date.now()) { const u = authDb.users.find((x) => x.id === s.uid && ROLE_PAGES[x.role]); if (u) { session = s; return u; } }
    } catch (e) { /* no session */ }
    return null;
  }
  function writeSession() { try { sessionStorage.setItem(SESS_KEY, JSON.stringify(session)); } catch (e) { /* ignore */ } }

  function setGate(on, msg) {
    $('#authGate').hidden = !on; document.body.classList.toggle('locked', on);
    if (!on) return;
    $('#loginError').textContent = msg || '';
    const secure = TapAuth.available();
    $('#authInsecure').hidden = secure;
    $$('#authGate input, #authGate select, #authGate button[type="submit"]').forEach((el) => { el.disabled = !secure; });
    showAuthTab(authDb.users.length ? 'login' : 'register');
    setTimeout(() => { const f = $(authDb.users.length ? '#loginUser' : '#regUser'); if (f && secure) f.focus({ preventScroll: true }); }, 50);
  }
  function showAuthTab(tab) {
    $('#loginForm').hidden = tab !== 'login'; $('#registerForm').hidden = tab !== 'register';
    $('#tabLogin').setAttribute('aria-selected', String(tab === 'login')); $('#tabRegister').setAttribute('aria-selected', String(tab === 'register'));
    $('#authTitle').textContent = tab === 'login' ? 'Sign in' : 'Create account';
  }
  function applyUser(u, fresh) {
    currentUser = u; state.role = u.role;
    $('#userName').textContent = u.display; $('#userRole').textContent = ROLE_LABEL[u.role] || u.role; $('#userAv').textContent = u.display.slice(0, 1).toUpperCase();
    $('#userChip').hidden = false; $('#aiFab').hidden = !can('assistant');
    setGate(false);
    if (fresh) navigate(ROLE_HOME[u.role] || 'home'); else route();
    save();
  }
  function logout(msg) {
    if (currentUser) { logAudit('auth', `${currentUser.display} signed out`, 'info', true); save(); }
    currentUser = null; session = null;
    try { sessionStorage.removeItem(SESS_KEY); } catch (e) { /* ignore */ }
    toggleAi(false);
    [...modalStack].forEach((id) => { const m = document.getElementById(id); if (m) { m.hidden = true; m.classList.remove('show'); } });
    modalStack.length = 0; document.body.classList.remove('modal-open');
    $('#userChip').hidden = true; $('#aiFab').hidden = true;
    $('#loginForm').reset(); $('#registerForm').reset(); $('#regError').textContent = ''; updateStrength('');
    setGate(true, msg || '');
  }
  function touchSession() {
    if (!currentUser || !session) return;
    const n = Date.now(); if (n - lastTouch < 5000) return;
    lastTouch = n; session.exp = n + TapAuth.SESSION_MS; writeSession();
  }
  function updateStrength(pw) {
    const s = TapAuth.strength(pw);
    const bar = $('#pwBar'); bar.style.width = pw ? (s.score + 1) * 20 + '%' : '0%';
    bar.style.background = ['var(--red)', 'var(--red)', 'var(--amber)', 'var(--teal)', 'var(--ok)'][s.score];
    $('#pwHint').textContent = pw ? s.label + (s.tips.length ? ' — ' + s.tips[0] : '') : 'At least 8 characters with a letter and a number.';
  }

  async function onLogin(e) {
    e.preventDefault();
    if (authBusy) return;
    const err = $('#loginError'); err.textContent = '';
    const name = $('#loginUser').value, pw = $('#loginPass').value;
    if (!name.trim() || !pw) { err.textContent = 'Enter your username and password.'; return; }
    authBusy = true; const btn = $('#loginSubmit'); btn.disabled = true; btn.textContent = 'Checking…';
    try {
      const u = authDb.users.find((x) => x.username === TapAuth.normUser(name));
      if (!u) { await TapAuth.dummyVerify(); logAudit('auth', 'Failed sign-in attempt (unknown user)', 'warn', true); save(); err.textContent = 'Incorrect username or password.'; return; }
      const left = TapAuth.lockRemaining(u, Date.now());
      if (left) { err.textContent = `Too many failed attempts. Try again in ${Math.ceil(left / 1000)} s.`; return; }
      if (!(await TapAuth.verify(u, pw))) {
        TapAuth.registerFailure(u, Date.now()); saveAuth();
        logAudit('auth', `Failed sign-in for ${u.display} (${u.failed}/${TapAuth.MAX_FAILS})`, 'warn', true); save();
        const l2 = TapAuth.lockRemaining(u, Date.now());
        err.textContent = l2 ? `Too many failed attempts. Account locked for ${Math.ceil(l2 / 1000)} s.` : 'Incorrect username or password.';
        return;
      }
      TapAuth.registerSuccess(u); saveAuth();
      session = { uid: u.id, token: rid('S-', 12), exp: Date.now() + TapAuth.SESSION_MS }; writeSession();
      logAudit('auth', `${u.display} signed in as ${u.role}`, 'ok', true);
      $('#loginForm').reset(); applyUser(u, true); toast(`Welcome back, ${u.display}!`, 'ok');
    } catch (ex) { err.textContent = 'Sign-in failed: ' + ex.message; }
    finally { authBusy = false; btn.disabled = false; btn.textContent = 'Sign in'; }
  }
  async function onRegister(e) {
    e.preventDefault();
    if (authBusy) return;
    const err = $('#regError'); err.textContent = '';
    const name = $('#regUser').value.trim(), pw = $('#regPass').value, pw2 = $('#regPass2').value, role = $('#regRole').value;
    const bad = TapAuth.validateUsername(name) || TapAuth.validatePassword(pw, name);
    if (bad) { err.textContent = bad; return; }
    if (pw !== pw2) { err.textContent = 'Passwords do not match.'; return; }
    if (!ROLE_PAGES[role]) { err.textContent = 'Choose a role.'; return; }
    if (authDb.users.some((x) => x.username === TapAuth.normUser(name))) { err.textContent = 'That username is taken.'; return; }
    if (authDb.users.length >= 20) { err.textContent = 'Demo limit of 20 accounts reached.'; return; }
    authBusy = true; const btn = $('#regSubmit'); btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const u = await TapAuth.createUser(name, pw, role);
      authDb.users.push(u); saveAuth();
      session = { uid: u.id, token: rid('S-', 12), exp: Date.now() + TapAuth.SESSION_MS }; writeSession();
      logAudit('auth', `Account created: ${u.display} (${role})`, 'ok', true);
      $('#registerForm').reset(); updateStrength(''); applyUser(u, true); toast(`Account created. Welcome, ${u.display}!`, 'ok');
    } catch (ex) { err.textContent = 'Could not create account: ' + ex.message; }
    finally { authBusy = false; btn.disabled = false; btn.textContent = 'Create account'; }
  }
  function bindAuth() {
    $('#loginForm').addEventListener('submit', onLogin);
    $('#registerForm').addEventListener('submit', onRegister);
    $('#tabLogin').addEventListener('click', () => showAuthTab('login'));
    $('#tabRegister').addEventListener('click', () => showAuthTab('register'));
    $('#regPass').addEventListener('input', (e) => updateStrength(e.target.value));
    $('#logoutBtn').addEventListener('click', () => { logout('You have been signed out.'); });
    ['click', 'keydown', 'pointerdown'].forEach((ev) => document.addEventListener(ev, touchSession, { passive: true }));
    setInterval(() => { if (currentUser && session && Date.now() > session.exp) logout('Session expired after 15 minutes of inactivity.'); }, 15000);
    // AI assistant
    $('#aiFab').addEventListener('click', () => toggleAi(!aiOpen));
    $('#aiClose').addEventListener('click', () => toggleAi(false));
    $('#aiForm').addEventListener('submit', (e) => { e.preventDefault(); const i = $('#aiInput'); aiAsk(i.value); i.value = ''; });
  }
  function bindPerf() {
    window.addEventListener('pagehide', writeNow);
    document.addEventListener('visibilitychange', () => { document.body.classList.toggle('page-hidden', document.hidden); if (document.hidden) writeNow(); });
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
  }

  /* ---------------------------------------------------------
     14. AI ASSISTANT (on-device, answers from live app state)
  --------------------------------------------------------- */
  let aiOpen = false;
  function aiContext() {
    const cred = getWalletCred(); const pend = pendingTx();
    const dec = state.transactions.find((t) => t.settlementStatus === 'Declined');
    const scored = state.transactions.find((t) => t.risk);
    return {
      name: state.nickname, money, balance: state.balance, pending: { count: pend.length, total: sum(pend, (t) => t.finalAmount) },
      insights: aiInsights(), merchants: MERCHANTS, rules: state.rules, limits: state.limits, net: state.networkMode,
      cred: cred ? { id: cred.id, status: effectiveStatus(cred), expiry: cred.expiry } : null,
      lastDeclined: dec ? { merchant: (merchantById(dec.merchantId) || {}).name, reason: dec.declineReason } : null,
      lastRisk: scored ? scored.risk : null, ai: { flagAt: state.ai.flagAt, blockAt: state.ai.blockAt, n: state.ai.n },
    };
  }
  function aiAdd(role, text) {
    const log = $('#aiLog'); log.append(h('div', { class: 'ai-msg ' + role }, text));
    while (log.children.length > 60) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  }
  function aiChips(chips) { mount($('#aiChips'), chips.map((c) => h('button', { class: 'chip-btn', type: 'button', onclick: () => aiAsk(c) }, c))); }
  function aiAsk(q) {
    q = String(q || '').trim().slice(0, 200); if (!q) return;
    aiAdd('user', q);
    const r = TapAI.answer(q, aiContext());
    aiAdd('bot', r.text); aiChips(r.chips);
  }
  function toggleAi(open) {
    aiOpen = open && can('assistant');
    $('#aiPanel').hidden = !aiOpen; $('#aiFab').setAttribute('aria-expanded', String(aiOpen));
    if (aiOpen) {
      if (!$('#aiLog').children.length) { aiAdd('bot', TapAI.answer('hello', aiContext()).text); aiChips(TapAI.CHIPS); }
      setTimeout(() => $('#aiInput').focus({ preventScroll: true }), 50);
    }
  }

  async function boot() {
    load(); loadAuth();
    await Crypto.init();
    if (!state.credentials.length) await seedCredentials();
    if (!getCred(state.walletCredId)) state.walletCredId = state.credentials[0].id;
    save();
    bindEvents();
    ui.rulesDirty = true;
    const u = readSession();
    if (u) applyUser(u, false); else { route(); setGate(true); }
    setTimeout(() => { ui.loading = false; renderAll(); }, pace(700));
  }
  boot();
})();
