/* Shared by every view: formatting, currency, Steam's revenue share, chart
   colours and the tab switch. Loaded before the view scripts. */
"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const num = (v, fallback = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fallback; };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sum = (arr) => arr.reduce((t, v) => t + v, 0);
const fmtInt = (v) => Math.round(v).toLocaleString("en-US");
const fmtPct = (v, digits = 1) => (v * 100).toFixed(digits).replace(/\.0$/, "") + "%";
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Projections are rounded to two significant figures so they never read as
// more precise than they are. Logged figures are shown exactly.
function roundSig(v, sig = 2) {
  if (!v) return 0;
  const e = Math.ceil(Math.log10(Math.abs(v))) - sig;
  const f = Math.pow(10, Math.abs(e));
  return e >= 0 ? Math.round(v / f) * f : Math.round(v * f) / f;
}
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumSignificantDigits: 2 });
function fmtRough(v) {
  const r = roundSig(Math.round(v));
  return Math.abs(r) >= 10000 ? compactFormat.format(r) : fmtInt(r);
}
function fmtRange(lo, hi, fmt = fmtRough) {
  const a = fmt(Math.min(lo, hi)), b = fmt(Math.max(lo, hi));
  return a === b ? a : `${a} – ${b}`;
}
const fmtCompact = (v) => Math.abs(v) >= 10000 ? compactFormat.format(v) : fmtInt(v);

// ── Steam's tiered revenue share, counted from the first dollar ──
const STEAM_TIERS = [
  { upTo: 10e6, cut: 0.30 },
  { upTo: 50e6, cut: 0.25 },
  { upTo: Infinity, cut: 0.20 },
];
function steamCut(gross) {
  let remaining = gross, floor = 0, cut = 0;
  for (const tier of STEAM_TIERS) {
    const band = Math.min(remaining, tier.upTo - floor);
    if (band <= 0) break;
    cut += band * tier.cut;
    remaining -= band;
    floor = tier.upTo;
  }
  return cut;
}

// ── currency: one display setting for the whole page ──
const CURRENCIES = [
  { code: "USD", name: "US dollar", rate: 1, pegged: true },
  { code: "EUR", name: "Euro", rate: 0.86 },
  { code: "GBP", name: "British pound", rate: 0.75 },
  { code: "JOD", name: "Jordanian dinar", rate: 0.709, pegged: true },
  { code: "SAR", name: "Saudi riyal", rate: 3.75, pegged: true },
  { code: "AED", name: "UAE dirham", rate: 3.6725, pegged: true },
  { code: "QAR", name: "Qatari riyal", rate: 3.64, pegged: true },
  { code: "KWD", name: "Kuwaiti dinar", rate: 0.306 },
  { code: "BHD", name: "Bahraini dinar", rate: 0.376, pegged: true },
  { code: "OMR", name: "Omani rial", rate: 0.3845, pegged: true },
  { code: "EGP", name: "Egyptian pound", rate: 48.5 },
  { code: "TRY", name: "Turkish lira", rate: 41.5 },
  { code: "CAD", name: "Canadian dollar", rate: 1.38 },
  { code: "AUD", name: "Australian dollar", rate: 1.52 },
  { code: "NZD", name: "New Zealand dollar", rate: 1.68 },
  { code: "CHF", name: "Swiss franc", rate: 0.8 },
  { code: "SEK", name: "Swedish krona", rate: 9.5 },
  { code: "NOK", name: "Norwegian krone", rate: 10.1 },
  { code: "DKK", name: "Danish krone", rate: 6.4 },
  { code: "PLN", name: "Polish zloty", rate: 3.65 },
  { code: "JPY", name: "Japanese yen", rate: 148 },
  { code: "CNY", name: "Chinese yuan", rate: 7.15 },
  { code: "KRW", name: "South Korean won", rate: 1390 },
  { code: "INR", name: "Indian rupee", rate: 88 },
  { code: "IDR", name: "Indonesian rupiah", rate: 16300 },
  { code: "PHP", name: "Philippine peso", rate: 57 },
  { code: "BRL", name: "Brazilian real", rate: 5.4 },
  { code: "MXN", name: "Mexican peso", rate: 18.5 },
  { code: "ZAR", name: "South African rand", rate: 17.6 },
];
const RATES_URL = "https://open.er-api.com/v6/latest/USD";

const Money = (() => {
  const KEY = "kolide.currency";
  let code = "USD", rates = {}, updated = "";
  // Most recently used first; the header offers them as one-click buttons.
  let recent = ["USD", "EUR", "GBP"];
  // Currencies whose rate was typed by hand, so an automatic refresh leaves them alone.
  let typed = [];
  const listeners = [];
  const known = (c) => CURRENCIES.some((x) => x.code === c);

  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && CURRENCIES.some((c) => c.code === saved.code)) {
      code = saved.code;
      rates = saved.rates && typeof saved.rates === "object" ? saved.rates : {};
      updated = saved.updated || "";
      if (Array.isArray(saved.recent)) recent = [...new Set(saved.recent.filter(known))].slice(0, 4);
      if (Array.isArray(saved.typed)) typed = saved.typed.filter(known);
    }
  } catch { /* private mode or bad data: stay on USD */ }

  const info = (c = code) => CURRENCIES.find((x) => x.code === c) || CURRENCIES[0];
  const rate = () => (code === "USD" ? 1 : num(rates[code], info().rate));
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ code, rates, updated, recent, typed })); } catch { /* private mode */ }
  }
  function changed() { save(); listeners.forEach((fn) => fn()); }

  function formatter(options) {
    try { return new Intl.NumberFormat("en-US", { style: "currency", currency: code, ...options }); }
    catch { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", ...options }); }
  }
  // Already-converted values (chart axes and tooltips).
  const local = (v, digits = 0) => formatter({ minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  const localCompact = (v) => formatter({ notation: "compact", maximumFractionDigits: 1 }).format(v);
  function localRough(v) {
    const r = roundSig(v);
    return Math.abs(r) >= 10000
      ? formatter({ notation: "compact", maximumSignificantDigits: 2 }).format(r)
      : formatter({ maximumFractionDigits: 0 }).format(r);
  }
  // USD in, display currency out.
  const exact = (usd, digits = 0) => local(usd * rate(), digits);
  const rough = (usd) => localRough(usd * rate());
  const range = (lo, hi) => fmtRange(lo, hi, rough);
  // Fetched rates older than a day are worth refreshing when a floating currency is picked.
  const stale = () => !info().pegged && !typed.includes(code) && !(Date.now() - Date.parse(updated) < 864e5);

  return {
    get code() { return code; },
    get updated() { return updated; },
    get recent() { return recent; },
    info, rate, exact, rough, range, local, localCompact, localRough, stale,
    onChange(fn) { listeners.push(fn); },
    setCode(c) {
      code = info(c).code;
      recent = [code, ...recent.filter((x) => x !== code)].slice(0, 4);
      changed();
    },
    setRate(r) {
      if (code === "USD" || !(r > 0)) return;
      rates[code] = r;
      if (!typed.includes(code)) typed.push(code);
      changed();
    },
    setRates(all, when) {
      for (const c of CURRENCIES) if (Number.isFinite(all[c.code])) rates[c.code] = all[c.code];
      updated = when;
      typed = [];
      changed();
    },
  };
})();

// The currency bar in the page header.
(() => {
  const sel = $("#cur"), rateIn = $("#rate"), rateWrap = $("#rate-wrap"), status = $("#rates-status"), quick = $("#cur-quick");
  sel.innerHTML = CURRENCIES.map((c) => `<option value="${c.code}">${c.code} · ${c.name}</option>`).join("");

  function paint() {
    const info = Money.info();
    sel.value = info.code;
    // Recent currencies in list order, so the buttons don't shuffle under the pointer.
    const recent = CURRENCIES.filter((c) => Money.recent.includes(c.code));
    quick.hidden = recent.length < 2;
    quick.innerHTML = recent.map((c) =>
      `<button type="button" data-cur="${c.code}" aria-pressed="${c.code === info.code}" title="${c.name}">${c.code}</button>`).join("");
    rateWrap.hidden = info.code === "USD";
    $("#rate-code").textContent = info.code;
    if (document.activeElement !== rateIn) rateIn.value = Money.rate();
    status.textContent = info.code === "USD" ? ""
      : info.pegged ? "Pegged to the dollar"
      : Money.updated ? `Rate from ${Money.updated.replace(/ \d\d:\d\d:\d\d \+0000$/, "")}`
      : "Approximate rate";
  }
  let fetching = false;
  async function fetchRates() {
    if (fetching) return;
    fetching = true;
    status.textContent = "Fetching rates…";
    try {
      const res = await fetch(RATES_URL);
      const data = await res.json();
      if (data.result !== "success" || !data.rates) throw new Error("Unexpected response from the rate service");
      Money.setRates(data.rates, data.time_last_update_utc || new Date().toUTCString());
    } catch (err) {
      console.error("Rate update failed", err);
      status.textContent = "Couldn't reach the rate service. Type a rate instead.";
    } finally {
      fetching = false;
    }
  }
  // Picking a floating currency refreshes rates older than a day, so no extra click is needed.
  function pick(c) {
    Money.setCode(c);
    if (Money.stale()) fetchRates();
  }
  sel.addEventListener("change", () => pick(sel.value));
  quick.addEventListener("click", (e) => {
    const b = e.target.closest("[data-cur]");
    if (b) { pick(b.dataset.cur); quick.querySelector(`[data-cur="${b.dataset.cur}"]`).focus(); }
  });
  rateIn.addEventListener("input", () => { const r = parseFloat(rateIn.value); if (r > 0) Money.setRate(r); });
  rateIn.addEventListener("change", paint);
  $("#rates-update").addEventListener("click", fetchRates);
  Money.onChange(paint);
  paint();
})();

// ── chart colours come from the CSS tokens, so both themes match ──
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function withAlpha(color, alpha) {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
if (window.Chart) {
  Chart.defaults.font.family = '"Archivo", "Helvetica Neue", Arial, sans-serif';
  Chart.defaults.font.size = 12;
}

// Redraw charts when the theme flips.
function onThemeChange(fn) {
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", fn);
  new MutationObserver(fn).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

function flash(btn, text) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = old; }, 1400);
}
function toClipboard(text, btn, ok) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flash(btn, ok), () => flash(btn, "Couldn't copy"));
    return;
  }
  const t = document.createElement("textarea");
  t.value = text;
  t.style.position = "fixed";
  t.style.opacity = "0";
  document.body.appendChild(t);
  t.select();
  try { document.execCommand("copy"); flash(btn, ok); } catch { flash(btn, "Couldn't copy"); }
  document.body.removeChild(t);
}
function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── tabs: views register a show() hook, called when their tab opens ──
const Views = {};
const Tabs = (() => {
  const KEY = "kolide.tab";
  function open(name, { remember = true } = {}) {
    if (!Views[name]) name = "estimate";
    for (const tab of $$(".tab")) {
      const on = tab.dataset.view === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $("#view-" + tab.dataset.view).hidden = !on;
    }
    if (remember) { try { localStorage.setItem(KEY, name); } catch { /* private mode */ } }
    Views[name].show();
  }
  function boot() {
    const h = location.hash.slice(1);
    // "#track" opens the tracker, "#pay…" the pay planner; any other hash is a shared estimate.
    if (h === "track") return open("track", { remember: false });
    if (/^pay($|,|%2C)/i.test(h)) return open("pay", { remember: false });
    if (h) return open("estimate", { remember: false });
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
    open(saved || "estimate", { remember: false });
  }
  for (const tab of $$(".tab")) {
    tab.addEventListener("click", () => open(tab.dataset.view));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tabs = $$(".tab"), i = tabs.indexOf(tab);
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      open(next.dataset.view);
      next.focus();
    });
  }
  return { open, boot };
})();
