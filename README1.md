# TapOnce — The One-Tap Student Benefit Wallet

**One Tap. Zero Exposure. Instant Benefits.**
Hack Build’26 · FinTech Track · Team NovaStack

TapOnce is a privacy-first student wallet prototype. A student proves campus-discount eligibility **and** pays in a single simulated NFC tap — the merchant learns only “eligible: student”, never a name, photo or roll number. It also works offline: taps queue on-device and sync later to a simulated settlement ledger.

> ⚠️ **Hackathon prototype.** NFC, the university credential, proof verification, the offline rail and DRUNIX settlement are all **local simulations**. No real money, banking, or personal data is involved.

## Folder structure

```
taponce/
├── index.html   # structure: 7 pages + modals
├── style.css    # design system, animations, responsive layout
├── script.js    # app logic (state, tap, queue, settlement, UI, login wiring, assistant)
├── auth.js      # NEW: PBKDF2 password hashing, validation, lockout
├── ai-engine.js # NEW: on-device AI (risk model, insights, assistant)
├── sw.js        # NEW: service worker (instant repeat loads, offline)
└── README.md
```

## Run it (VS Code)

1. Install **VS Code** and the **Live Server** extension (Ritwick Dey).
2. `File → Open Folder…` → choose the `taponce` folder.
3. Right-click `index.html` → **Open with Live Server** (opens `http://127.0.0.1:5500`).
4. No Live Server? In the VS Code terminal run `python -m http.server 8000` and open `http://localhost:8000`.

No backend, API key, npm install or internet connection is needed. Use a local server (not just double-clicking the file) so Web Crypto is guaranteed to be available; without it the app falls back to a clearly-labelled simulated check.

## Features

- **Landing page** — hero, animated NFC link, 10-second problem/privacy/tap/offline cards, animated 3-step flow.
- **Student Wallet** — glowing card, fictional editable identity, balance, discounts, history, network toggle, **Tap to Pay**.
- **Tap experience** — merchant picker, amount chips, live discount math, animated rings, 6 step indicators (incl. AI risk check), “what the merchant sees”, success animation + receipt.
- **Discount engine** — configurable per-merchant rules (integer-paise maths), applied exactly once per transaction.
- **Offline simulator** — amber “Offline Mode”, queue with pending badge, spending limits, reconnect animation, auto-sync with progress and summary.
- **Privacy panel** — merchant receives vs never receives.
- **Security Center** — unique references, single-use merchant challenges (120 s), duplicate detection, **Test Duplicate Transaction**, configurable limits, expiry/revocation, audit trail, tampered-record injector.
- **Settlement simulator** — flow diagram, multi-organization network, ledger, pending/synced/rejected lists, **Run Settlement Demo**.
- **Merchant dashboard** — restricted view (no identities), KPIs, receipts, challenge generator.
- **University admin** — issue/deactivate/revoke/reactivate/renew fictional credentials, edit rules, stats, merchant activity, security events.
- **Analytics** — counters, bar chart, donut, activity timeline — all computed from real demo interactions (nothing seeded except 4 labelled fictional credentials).
- **Login & roles (v2)** — register/sign in as Student, Merchant or University admin; PBKDF2-SHA256 salted hashes (120k iterations), password rules + strength meter, lockout after 5 failures (escalating), 15-min idle session timeout, per-role pages **and** per-action permission checks, audit log of sign-ins.
- **On-device AI (v2)** — (1) *Risk engine*: online-learning model (running mean/variance, hour-of-day and merchant history, velocity) feeding an explainable logistic scorer; every payment gets a 0–100 score with reasons, ≥60 is flagged, ≥85 is held (user can approve with “It’s me”). (2) *Insights*: savings, best merchant, EWMA next-bill forecast, trend, balance runway, tips. (3) *Assistant*: floating chat that answers from live app state. No cloud, no LLM — all local and private.
- **Performance (v2)** — debounced storage writes, one render per frame, 500-record cap, paused animations in hidden tabs, CSS containment, deferred scripts, service-worker cache.
- Toasts, skeleton loaders, tooltips, confetti, `prefers-reduced-motion` support.

## Architecture (script.js sections)

| # | Section | Responsibility |
|---|---------|----------------|
| 1 | Utilities | safe DOM builder `h()` (no `innerHTML`), formatting, IDs |
| 2 | App state | single `state` object + transaction model |
| 3 | Persistence | LocalStorage load/save |
| 4 | Crypto | ECDSA P-256 sign/verify via Web Crypto |
| 5 | Wallet/Eligibility | credential status + verification |
| 6 | Discount engine | rules → paise-exact calculation |
| 7 | Replay protection + processing | `submitTransaction()` — idempotent entry point |
| 8 | Tap simulation | `executeTap()` drives the 5 animated steps |
| 9 | Offline queue + settlement | `setNetwork()`, `runSync()`, explicit status transitions |
| 10 | Admin | credential lifecycle |
| 11 | UI rendering | one render function per page |
| 12 | Events + boot | navigation, actions, scenarios, forms |

Transaction model: `transactionId, merchantId, amount, discountAmount, finalAmount, credentialStatus, createdAt, networkMode, settlementStatus` (+ `category, nonce, verifyMs`).
Allowed transitions: `Pending Sync → Synced | Rejected`. Declined taps are stored as `Declined` and never change.

## Simulated vs production

| Component | In this prototype | In production |
|-----------|-------------------|---------------|
| NFC tap | animation + button | NFC hardware (HCE / secure element) |
| University credential | locally generated ECDSA key signs fictional credentials | issuer-held keys, PKI, revocation service |
| Proof | real ECDSA signature check, reveals only eligibility result — **not zero-knowledge** | ZK / selective-disclosure credentials (e.g. BBS+, SD-JWT) |
| Offline double-spend protection | challenge nonces + reference checks in LocalStorage | secure element, monotonic counters, protocol-level safeguards |
| Settlement | local ledger array | real DRUNIX (or other) test environment — **not integrated** |
| Login / roles | browser-side PBKDF2 accounts + session in sessionStorage; role checks run in the client | server-side auth (TLS, sessions/JWT, rate limiting, MFA, IdP); authorization enforced on the server |
| AI | small statistical model + rules, trained only on this device's demo data | server-side fraud ML with far more signals, device attestation, model monitoring |

## Manual testing checklist

- [ ] All 7 nav links open their page; mobile ☰ menu works.
- [ ] “Try the Demo” opens the wallet; “Explore How It Works” scrolls.
- [ ] Tap to Pay: select each merchant; ₹100 → ₹10 / ₹8 / ₹5 discount shown correctly.
- [ ] Invalid amounts (blank, 0, 5001, 1.234) show an error.
- [ ] Online tap → status **Synced**; balance decreases by final amount.
- [ ] Offline tap → **Pending Sync**, header badge increments, reload page → still there.
- [ ] Offline tap above ₹300 or beyond ₹500 queued → declined with limit message.
- [ ] Go online → reconnect animation → sync modal → statuses become **Synced**.
- [ ] Run Settlement Demo offline → error toast; with empty queue → info toast.
- [ ] Test Duplicate Transaction → rejected, counter increases, explanation shown.
- [ ] Revoke credential in Admin → tap declined with reason; Reactivate → works again.
- [ ] Expired credential (CR-1003 via Demo identity) declined; Renew fixes it.
- [ ] Inject tampered record → Run Settlement → **Rejected**.
- [ ] Admin rule edit (e.g. canteen 15%) changes discount; invalid values (51, -1) rejected.
- [ ] Merchant dashboard KPIs update; challenge generator works; no student identity shown.
- [ ] Analytics shows empty states first, then real numbers.
- [ ] Reset button restores the initial state; all 4 scenarios replay.
- [ ] OS “reduce motion” setting disables heavy animation.

## Two-minute demo script

**0:00–0:15 — Problem.** “Students show a full ID — name, photo, roll number — for a ₹10 discount, often with no network.” Show the landing page.
**0:15–0:30 — Idea.** “TapOnce proves *only* eligibility.” Click **Try the Demo**; point at the privacy panel.
**0:30–1:00 — Scenario 1.** Click **1 · Offline lunch ₹100**. Narrate the steps: challenge → private proof → ₹100 − ₹10 = ₹90 → queued offline.
**1:00–1:20 — Scenario 2.** Click **2 · Reconnect & sync**. “Reconnects, queue flows to the simulated DRUNIX ledger.”
**1:20–1:40 — Scenario 3.** Click **3 · Duplicate replay**. “Same reference — rejected. And honestly: real offline needs secure hardware.”
**1:40–1:55 — Scenario 4.** Click **4 · Revoked credential**. “University revoked it — declined, with a reason.”
**1:55–2:00 — Close.** Open Analytics: “Every number is from what you just did. One Tap. Zero Exposure.” Press **Reset** to replay.

## Known limitations

- LocalStorage can be edited by the user — this is a demo, not a secure offline rail.
- Login is client-side only: anyone with DevTools can edit accounts/roles in storage. It demonstrates the UX and flow, not real security.
- The AI is a lightweight statistical model, not a large language model; it needs a few payments before it personalises.
- Judge scenarios are demo shortcuts and can reset a revoked credential.
- The “university” key lives in the same browser as the wallet.
- No claim of real DRUNIX settlement, blockchain hashes, or zero-knowledge proofs is made.
