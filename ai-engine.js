/* =========================================================
   TapOnce — ai-engine.js
   On-device AI. Pure logic (no DOM, no network) so it is fast,
   private and unit-testable in Node.

   What is in here (honest description):
   1. Risk model   — online-learning statistics (Welford mean/variance,
                     hour-of-day histogram, merchant history, velocity)
                     feeding an explainable logistic-regression scorer.
   2. Insights     — spend/savings analytics, EWMA + least-squares trend,
                     balance runway and rule-based recommendations.
   3. Assistant    — intent-retrieval chatbot answering from real app state.
   It is NOT a large language model and makes no cloud calls.
   ========================================================= */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TapAI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const sigmoid = (x) => 1 / (1 + Math.exp(-x));
  const round1 = (x) => Math.round(x * 10) / 10;
  const defMoney = (n) => '₹' + (Math.round(n * 100) / 100).toLocaleString('en-IN');

  /* ---------------- 1. RISK MODEL ---------------- */
  const WEIGHTS = { bias: -3.2, amountZ: 0.7, velocity: 1.3, oddHour: 1.6, newMerchant: 0.9, offlineLoad: 1.1, balanceShare: 1.5 };
  const LABELS = {
    amountZ: 'Amount is unusual compared with your history',
    velocity: 'Several payments in a short time',
    oddHour: 'Unusual time of day',
    newMerchant: 'First payment at this merchant',
    offlineLoad: 'Large share of the offline per-payment limit',
    balanceShare: 'Large share of the wallet balance',
  };

  function newModel() {
    return { version: 1, n: 0, mean: 0, m2: 0, hours: new Array(24).fill(0), merchants: {}, recent: [], flagAt: 60, blockAt: 85 };
  }
  /** Repair a model loaded from storage (never trust stored shapes). */
  function sane(m) {
    const d = newModel();
    const o = Object.assign(d, m && typeof m === 'object' ? m : {});
    if (!Array.isArray(o.hours) || o.hours.length !== 24 || o.hours.some((x) => !Number.isFinite(x))) o.hours = new Array(24).fill(0);
    if (!Array.isArray(o.recent)) o.recent = [];
    if (!o.merchants || typeof o.merchants !== 'object') o.merchants = {};
    ['n', 'mean', 'm2'].forEach((k) => { if (!Number.isFinite(o[k])) o[k] = 0; });
    if (!Number.isFinite(o.flagAt) || !Number.isFinite(o.blockAt) || o.flagAt >= o.blockAt) { o.flagAt = 60; o.blockAt = 85; }
    return o;
  }
  const stdDev = (m) => (m.n > 1 ? Math.sqrt(m.m2 / (m.n - 1)) : 0);

  function features(m, c) {
    const warm = m.n >= 3;
    const mean = warm ? m.mean : 150;                                // cold-start prior
    const sd = warm ? Math.max(stdDev(m), 0.15 * m.mean, 20) : 120;
    const f = {};
    f.amountZ = clamp((c.amount - mean) / sd, 0, 5);
    const burst = m.recent.filter((t) => c.now - t <= 10 * 60 * 1000).length + 1;
    f.velocity = clamp(burst - 2, 0, 4);
    const total = m.hours.reduce((a, b) => a + b, 0);
    if (total >= 5) { const p = (m.hours[c.hour] + 1) / (total + 24); f.oddHour = clamp((0.08 - p) / 0.08, 0, 1); }
    else f.oddHour = c.hour < 5 ? 0.6 : 0;
    f.newMerchant = warm && !m.merchants[c.merchantId] ? 0.5 : 0;
    f.offlineLoad = c.offline && c.perTxLimit > 0 ? clamp(c.finalAmount / c.perTxLimit, 0, 1.5) : 0;
    f.balanceShare = c.balance > 0 ? clamp(c.finalAmount / c.balance, 0, 1) : 1;
    return f;
  }

  /** Score a payment 0–100 and explain the top contributing signals. Read-only. */
  function scoreRisk(m, ctx) {
    const f = features(m, ctx);
    let z = WEIGHTS.bias;
    const parts = [];
    for (const k of Object.keys(f)) {
      const c = WEIGHTS[k] * f[k];
      z += c;
      if (c > 0.05) parts.push({ key: k, label: LABELS[k], contribution: round1(c) });
    }
    parts.sort((a, b) => b.contribution - a.contribution);
    const score = Math.round(sigmoid(z) * 100);
    const action = score >= m.blockAt ? 'block' : score >= m.flagAt ? 'flag' : 'allow';
    const level = score >= m.blockAt ? 'critical' : score >= m.flagAt ? 'high' : score >= 35 ? 'medium' : 'low';
    return { score, level, action, factors: parts.slice(0, 3), features: f };
  }

  /** Online learning step — call only for ACCEPTED payments. */
  function learn(m, o) {
    m.n++;
    const d = o.amount - m.mean;
    m.mean += d / m.n;
    m.m2 += d * (o.amount - m.mean);
    m.hours[o.hour]++;
    m.merchants[o.merchantId] = (m.merchants[o.merchantId] || 0) + 1;
    m.recent.push(o.at);
    if (m.recent.length > 20) m.recent.shift();
  }

  /* ---------------- 2. INSIGHTS ---------------- */
  function insights(txs, o) {
    o = o || {};
    const money = o.money || defMoney;
    const ok = txs.filter((t) => t.settlementStatus !== 'Declined' && !t.tampered)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const out = { count: ok.length, spent: 0, saved: 0, original: 0, avgSavePct: 0, best: null, perMerchant: {}, nextSpend: null, monthlySavings: null, runwayDays: null, trend: 'flat', tips: [] };
    if (!ok.length) { out.tips.push({ icon: '👋', text: 'Make your first payment — personalised insights appear after a few taps.' }); return out; }

    const names = {};
    (o.merchants || []).forEach((m) => { names[m.id] = m.name; });
    for (const t of ok) {
      out.spent += t.finalAmount; out.saved += t.discountAmount; out.original += t.amount;
      const pm = out.perMerchant[t.merchantId] || (out.perMerchant[t.merchantId] = { id: t.merchantId, name: names[t.merchantId] || t.merchantId, count: 0, saved: 0, spent: 0 });
      pm.count++; pm.saved += t.discountAmount; pm.spent += t.finalAmount;
    }
    out.avgSavePct = out.original ? (out.saved / out.original) * 100 : 0;
    out.best = Object.values(out.perMerchant).sort((a, b) => b.saved - a.saved)[0] || null;

    const t0 = +new Date(ok[0].createdAt), t1 = +new Date(ok[ok.length - 1].createdAt);
    const spanDays = Math.max(1, (t1 - t0) / 864e5);
    const perDay = out.spent / spanDays;

    if (ok.length >= 2) {                                   // EWMA of the bill sizes
      let e = ok[0].finalAmount;
      for (let i = 1; i < ok.length; i++) e = 0.4 * ok[i].finalAmount + 0.6 * e;
      out.nextSpend = e;
    }
    if (ok.length >= 4) {                                   // least-squares slope over the last 10 bills
      const ys = ok.slice(-10).map((t) => t.finalAmount); const n = ys.length;
      const xm = (n - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0;
      ys.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) * (i - xm); });
      const rel = ym ? num / den / ym : 0;
      out.trend = rel > 0.08 ? 'rising' : rel < -0.08 ? 'falling' : 'flat';
    }
    if (ok.length >= 3) {
      out.monthlySavings = (out.saved / spanDays) * 30;
      if (perDay > 0 && o.balance > 0) out.runwayDays = o.balance / perDay;
    }

    const tips = out.tips;
    tips.push({ icon: '💸', text: `You've saved ${money(out.saved)} (${out.avgSavePct.toFixed(1)}% of ${money(out.original)} billed) over ${out.count} payment${out.count > 1 ? 's' : ''}.` });
    if (out.best && out.best.saved > 0) tips.push({ icon: '🏆', text: `${out.best.name} is your biggest saver so far (${money(out.best.saved)} across ${out.best.count} payment${out.best.count > 1 ? 's' : ''}).` });
    const rates = (o.merchants || []).map((m) => ({ m, pct: Number((o.rules || {})[m.category]) || 0 })).sort((a, b) => b.pct - a.pct);
    if (rates[0] && rates[0].pct > 0 && out.count >= 3) {
      const used = (out.perMerchant[rates[0].m.id] || { count: 0 }).count;
      if (used / out.count < 0.4) tips.push({ icon: '🎯', text: `${rates[0].m.name} offers the highest student discount (${rates[0].pct}%), but only ${used} of your ${out.count} payments went there.` });
    }
    if (o.pending && o.pending.count) tips.push({ icon: '📴', text: `${money(o.pending.total)} across ${o.pending.count} offline payment${o.pending.count > 1 ? 's' : ''} is waiting to sync — reconnect to settle it.` });
    if (out.runwayDays !== null && out.runwayDays < 7) tips.push({ icon: '⚠️', text: `At your current pace the balance lasts about ${Math.max(1, Math.round(out.runwayDays))} day(s). Consider a top-up.` });
    if (out.trend === 'rising') tips.push({ icon: '📈', text: 'Your bills are trending upward — worth keeping an eye on the offline limit.' });
    if (o.flagged) tips.push({ icon: '🚩', text: `${o.flagged} payment${o.flagged > 1 ? 's were' : ' was'} flagged by the risk model. Check the risk list.` });
    return out;
  }

  /* ---------------- 3. ASSISTANT ---------------- */
  const tokenize = (s) => String(s).toLowerCase().replace(/[^a-z0-9%₹\s]/g, ' ').split(/\s+/).filter(Boolean);
  const hit = (tokens, key) => (key[0] === '=' ? tokens.includes(key.slice(1)) : tokens.some((t) => t.startsWith(key)));

  const CHIPS = ['How much have I saved?', 'Why was my payment declined?', 'What is my risk score?', 'Explain offline mode', 'Is my credential valid?'];

  const INTENTS = [
    { id: 'greeting', w: 3, keys: ['=hi', '=hello', '=hey', '=namaste'],
      reply: (c) => `Hi ${c.name}! I'm the on-device TapOnce assistant. Ask me about your balance, savings, offline queue, risk scores or why a payment was declined.` },
    { id: 'balance', w: 1, keys: ['balanc', '=wallet', '=left', 'remain', '=fund', '=money', 'afford'],
      reply: (c) => `Your demo wallet balance is ${c.money(c.balance)}.` + (c.pending.count ? ` ${c.pending.count} offline payment(s) worth ${c.money(c.pending.total)} are already deducted and waiting to sync.` : '') },
    { id: 'savings', w: 2, keys: ['sav', 'benefit'], phrases: [/how much.*(discount|sav)/],
      reply: (c) => {
        const i = c.insights;
        if (!i.count) return 'No payments yet, so nothing saved so far. Make a tap and I will track it.';
        return `You've saved ${c.money(i.saved)} across ${i.count} payment(s) — about ${i.avgSavePct.toFixed(1)}% off ${c.money(i.original)} billed.` + (i.best ? ` Biggest saver: ${i.best.name} (${c.money(i.best.saved)}).` : '');
      } },
    { id: 'discounts', w: 1, keys: ['discount', 'rule', 'percent', '%', '=rate', 'offer', '=deal', 'cheap', '=best'],
      reply: (c) => {
        const rows = c.merchants.map((m) => ({ n: m.name, p: Number(c.rules[m.category]) || 0 })).sort((a, b) => b.p - a.p);
        return 'Current student discounts:\n' + rows.map((r) => `• ${r.n}: ${r.p}%`).join('\n') + `\nBest rate right now: ${rows[0].n} (${rows[0].p}%).`;
      } },
    { id: 'declined', w: 1, keys: ['declin', 'reject', '=fail', 'failed', 'refus', 'deni', '=why', '=held', '=hold', '=block', '=error'],
      reply: (c) => (c.lastDeclined
        ? `Your most recent declined payment${c.lastDeclined.merchant ? ' at ' + c.lastDeclined.merchant : ''}: ${c.lastDeclined.reason}`
        : 'No declined payments so far. Common reasons are a revoked/expired credential, the offline limit, a duplicate reference, insufficient balance, or a high AI risk score.') },
    { id: 'credential', w: 1, keys: ['credential', 'valid', 'expir', 'revok', 'eligib', '=status', '=active', 'inactive'],
      reply: (c) => {
        if (!c.cred) return 'No credential is linked to this wallet. Ask the university admin to issue one.';
        if (c.cred.status === 'active') return `Credential ${c.cred.id} is active and valid until ${c.cred.expiry}.`;
        return `Credential ${c.cred.id} is ${c.cred.status}, so taps will be declined. The university admin can ${c.cred.status === 'expired' ? 'renew' : 'reactivate'} it.`;
      } },
    { id: 'offline', w: 1, keys: ['offline', 'queue', 'network', 'internet', 'wifi', 'pending', 'sync', '=limit', 'limits', '=online'],
      reply: (c) => `You're ${c.net === 'offline' ? 'OFFLINE — payments are queued on this device' : 'online — payments settle instantly (simulated)'}. Offline limits: ${c.money(c.limits.perTx)} per payment and ${c.money(c.limits.offlineTotal)} queued in total. Pending now: ${c.pending.count} (${c.money(c.pending.total)}). Queued payments sync automatically when you go back online.` },
    { id: 'privacy', w: 1, keys: ['privacy', 'private', '=photo', '=roll', 'identity', '=name', '=share', 'zero', 'expos', '=data', 'anonym'],
      reply: () => 'The merchant only learns “eligible: student”, the discount category, a reference and the amount. Your name, photo, roll number and profile never leave the wallet. (Prototype note: this is a signed eligibility result, not a zero-knowledge proof.)' },
    { id: 'security', w: 1, keys: ['replay', 'duplicat', 'double', 'fraud', 'secur', 'attack', 'nonce', 'challeng', '=safe', 'tamper'],
      reply: () => 'Each tap uses a single-use merchant challenge (120 s), every payment has a unique reference checked for duplicates, and settlement re-verifies the amounts. Real offline double-spend protection would also need secure hardware.' },
    { id: 'risk', w: 1, keys: ['risk', '=score', '=ai', 'anomal', 'suspicio', '=model', 'flag', 'learn'],
      reply: (c) => (c.lastRisk
        ? `Your latest payment scored ${c.lastRisk.score}/100 (${c.lastRisk.level}).` + (c.lastRisk.factors.length ? ' Main signals: ' + c.lastRisk.factors.map((f) => f.label.toLowerCase()).join('; ') + '.' : ' No notable risk signals.') + ` Payments ≥${c.ai.flagAt} are flagged and ≥${c.ai.blockAt} are held. The model has learned from ${c.ai.n} payment(s) on this device.`
        : `No payment has been scored yet. Payments scoring ≥${c.ai.flagAt} are flagged and ≥${c.ai.blockAt} are held. The model learns your normal bill size, shops and times on this device.`) },
    { id: 'forecast', w: 1, keys: ['forecast', 'predict', 'project', 'month', 'runway', 'futur', 'trend', '=next', '=will'],
      reply: (c) => {
        const i = c.insights;
        if (i.count < 3) return 'I need at least 3 payments to forecast reliably.';
        return `Your next bill is likely around ${c.money(i.nextSpend)} (trend: ${i.trend}). Projected savings: about ${c.money(i.monthlySavings)} per month` + (i.runwayDays !== null ? `, and the balance lasts roughly ${Math.max(1, Math.round(i.runwayDays))} day(s) at this pace.` : '.');
      } },
  ];

  function answer(q, ctx) {
    const tokens = tokenize(q);
    const text = tokens.join(' ');
    let best = null, bestScore = 0;
    for (const it of INTENTS) {
      let s = it.keys.filter((k) => hit(tokens, k)).length * it.w;
      if (it.phrases) s += it.phrases.filter((r) => r.test(text)).length * 2;
      if (s > bestScore) { best = it; bestScore = s; }
    }
    if (!best) {
      return { intent: 'fallback', confidence: 0, chips: CHIPS, text: 'I can answer questions about your balance, savings, discount rules, credential status, offline mode, privacy, security, risk scores and forecasts. Try one of the suggestions below.' };
    }
    return { intent: best.id, confidence: Math.min(1, bestScore / 3), chips: CHIPS.filter(() => true).slice(0, 4), text: best.reply(ctx) };
  }

  return { newModel, sane, scoreRisk, learn, insights, answer, WEIGHTS, CHIPS };
});
