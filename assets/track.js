/* After launch: a daily sales log per game, projected forward as a
   low / middle / high range. Games are stored only in this browser. */
(() => {
  "use strict";

  const INDEX_KEY = "kolide-sales-saves";
  const SAVE_PREFIX = "kolide-sales-save:";
  const PRIOR_DECAY = 0.72;
  const TAIL_DECAY_PER_DAY = 0.998;
  const MAX_DAYS = 1095;
  const MIN_FRAME_DAYS = 3;
  const FRAME_PRESETS = ["logged", "30", "365", "1095"];
  const CASE_KEYS = ["low", "mid", "high"];

  const DEFAULT_STATE = {
    gameName: "My game",
    days: [],
    settings: {
      price: 9.99, launchDiscountPct: 10, launchDiscountEnds: "", taxRegionalPct: 20,
      refundFallbackPct: 10, withholdingPct: 30, usSharePct: 35, wishlists: 0, tailPct: 1.5,
      lastDayPartial: false, lastDayHours: 12,
    },
    reviews: { positive: 0, negative: 0 },
    plannedSales: [],
    chartPrefs: {
      metric: "units", view: "daily", scale: "linear", preset: "30", totals: "milestones", panel: "totals",
      series: { actual: true, forecast: true, range: true, average: false, periods: true, now: true },
    },
  };

  let state = structuredClone(DEFAULT_STATE);
  let customFrame = null;
  let saveTimer = null;
  let saves = [];
  let activeId = null;
  let deleteArmedId = null;
  let chart = null;
  let lastRender = null;

  // ── dates ──
  function addDaysISO(iso, k) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + k)).toISOString().slice(0, 10);
  }
  function daysBetween(a, b) {
    return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
  }
  function todayISO() {
    const t = new Date();
    return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate())).toISOString().slice(0, 10);
  }
  const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const longDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const fmtDate = (iso) => shortDate.format(new Date(iso + "T00:00:00Z"));
  const fmtLongDate = (iso) => longDate.format(new Date(iso + "T00:00:00Z"));
  const monthDate = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const fmtMonth = (iso) => monthDate.format(new Date(iso + "T00:00:00Z"));

  // ── storage ──
  // Saved games and imported backups are untrusted: a crafted file could put markup where the
  // page expects a number. Keep only numbers, ISO dates, flags and known choices.
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const cleanNum = (v) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : "";
  };
  const cleanDate = (v) => (typeof v === "string" && ISO_DATE.test(v) ? v : "");
  const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
  const CHART_CHOICES = {
    metric: ["units", "net", "payout"], view: ["daily", "cumulative"], scale: ["linear", "log"],
    preset: FRAME_PRESETS, totals: ["milestones", "months"],
    panel: ["totals", "log", "discounts", "money", "audience", "data"],
  };

  // Each field takes the type of its default; strings are dates.
  function cleanFields(defaults, loaded) {
    const out = { ...defaults };
    if (!isObj(loaded)) return out;
    for (const [k, d] of Object.entries(defaults)) {
      if (!(k in loaded)) continue;
      const v = loaded[k];
      if (typeof d === "boolean") out[k] = typeof v === "boolean" ? v : d;
      else if (typeof d === "number") out[k] = cleanNum(v);
      else out[k] = cleanDate(v);
    }
    return out;
  }

  function mergeState(loaded) {
    const merged = structuredClone(DEFAULT_STATE);
    if (!isObj(loaded)) return merged;
    if (typeof loaded.gameName === "string") merged.gameName = loaded.gameName.slice(0, 80);
    if (Array.isArray(loaded.days)) {
      merged.days = loaded.days
        .filter((d) => isObj(d) && ISO_DATE.test(d.date))
        .map((d) => ({ date: d.date, units: cleanNum(d.units), refunds: cleanNum(d.refunds), netUsd: cleanNum(d.netUsd) }));
    }
    if (Array.isArray(loaded.plannedSales)) {
      merged.plannedSales = loaded.plannedSales
        .filter(isObj)
        .map((sale) => ({ start: cleanDate(sale.start), days: cleanNum(sale.days), discountPct: cleanNum(sale.discountPct), boost: cleanNum(sale.boost) }));
    }
    merged.settings = cleanFields(DEFAULT_STATE.settings, loaded.settings);
    merged.reviews = cleanFields(DEFAULT_STATE.reviews, loaded.reviews);
    if (isObj(loaded.chartPrefs)) {
      for (const [k, choices] of Object.entries(CHART_CHOICES)) {
        if (choices.includes(loaded.chartPrefs[k])) merged.chartPrefs[k] = loaded.chartPrefs[k];
      }
      merged.chartPrefs.series = cleanFields(DEFAULT_STATE.chartPrefs.series, loaded.chartPrefs.series);
    }
    merged.days.sort((a, b) => a.date.localeCompare(b.date));
    return merged;
  }

  const setStatus = (text) => { $("#status").textContent = text; };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const stampFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const activeEntry = () => saves.find((s) => s.id === activeId);
  const safeName = () => state.gameName.replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "game";

  function readIndex() {
    try {
      const parsed = JSON.parse(localStorage.getItem(INDEX_KEY) || "[]");
      saves = Array.isArray(parsed) ? parsed.filter((s) => s && s.id && localStorage.getItem(SAVE_PREFIX + s.id) != null) : [];
    } catch (err) {
      console.error("Could not read the game list", err);
      saves = [];
    }
  }
  const writeIndex = () => localStorage.setItem(INDEX_KEY, JSON.stringify(saves));

  function nameTaken(name, exceptId = null) {
    const key = name.trim().toLowerCase();
    return saves.some((s) => s.id !== exceptId && s.name.trim().toLowerCase() === key);
  }
  function uniqueName(name) {
    const base = name.trim() || "Untitled game";
    let candidate = base, i = 2;
    while (nameTaken(candidate)) candidate = `${base} (${i++})`;
    return candidate;
  }
  function addSave(name, data) {
    const id = newId();
    const now = new Date().toISOString();
    data.gameName = name;
    localStorage.setItem(SAVE_PREFIX + id, JSON.stringify(data));
    saves.push({ id, name, createdAt: now, updatedAt: now });
    writeIndex();
    return id;
  }

  function openSave(id) {
    const entry = saves.find((s) => s.id === id);
    const raw = localStorage.getItem(SAVE_PREFIX + id);
    if (!entry || raw == null) {
      console.error("Game data is missing", id);
      saves = saves.filter((s) => s.id !== id);
      writeIndex();
      goHome();
      return;
    }
    state = mergeState(JSON.parse(raw));
    // Nothing logged yet: start where the first day goes in.
    if (!state.days.length) state.chartPrefs.panel = "log";
    activeId = id;
    customFrame = null;
    $("#games").hidden = true;
    $("#project").hidden = false;
    window.scrollTo(0, 0);
    renderAll();
    setStatus("Stored only in this browser");
  }

  function flushPendingSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; saveNow(); }
  }
  function scheduleSave() {
    if (!activeId) return;
    setStatus("Saving…");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400);
  }
  function saveNow() {
    if (!activeId) return;
    try {
      localStorage.setItem(SAVE_PREFIX + activeId, JSON.stringify(state));
      const entry = activeEntry();
      if (entry) { entry.updatedAt = new Date().toISOString(); entry.name = state.gameName; writeIndex(); }
      setStatus("Saved in this browser");
    } catch (err) {
      console.error("Save failed", err);
      setStatus("Couldn't save. Browser storage may be full; download a backup.");
    }
  }

  function goHome({ focus = true } = {}) {
    flushPendingSave();
    activeId = null;
    if (chart) { chart.destroy(); chart = null; }
    $("#project").hidden = true;
    $("#games").hidden = false;
    renderProjectList();
    if (focus) $("#newProjectName").focus();
  }

  function renderProjectList() {
    const list = $("#projectList");
    const sorted = [...saves].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!sorted.length) {
      list.innerHTML = `<li class="empty-projects">No games yet. Add one above to start logging.</li>`;
      return;
    }
    list.innerHTML = sorted.map((p) => {
      let days = 0;
      try { days = (JSON.parse(localStorage.getItem(SAVE_PREFIX + p.id)).days || []).length; } catch { days = 0; }
      const armed = deleteArmedId === p.id;
      return `<li>
        <button class="project-open" type="button" data-open-project="${escapeHtml(p.id)}">
          <span class="pname">${escapeHtml(p.name)}</span>
          <span class="pmeta">${days} day${days === 1 ? "" : "s"} logged · saved ${stampFormat.format(new Date(p.updatedAt))}</span>
        </button>
        <button class="btn danger" type="button" data-delete-project="${escapeHtml(p.id)}">${armed ? "Click again to delete" : "Delete"}</button>
      </li>`;
    }).join("");
  }

  function importBackupAsProject(text, fileName) {
    const restored = mergeState(JSON.parse(text));
    flushPendingSave();
    const name = uniqueName(restored.gameName || fileName.replace(/\.json$/i, ""));
    openSave(addSave(name, restored));
    return name;
  }

  // ── pricing ──
  function saleOn(date) {
    return state.plannedSales.find((s) => s.start && date >= s.start && date <= addDaysISO(s.start, Math.max(1, Math.round(num(s.days, 1))) - 1));
  }
  const launchDiscountEnd = (launch) => state.settings.launchDiscountEnds || addDaysISO(launch, 6);
  function priceOn(date, launch) {
    const base = num(state.settings.price);
    const sale = saleOn(date);
    if (sale) return base * (1 - num(sale.discountPct) / 100);
    return date <= launchDiscountEnd(launch) ? base * (1 - num(state.settings.launchDiscountPct) / 100) : base;
  }
  // Valve withholds only on US-source income: sales to US customers.
  const keepShare = () => 1 - num(state.settings.withholdingPct) / 100 * clamp(num(state.settings.usSharePct, 35), 0, 100) / 100;
  // Per-copy shortcut for charts and CSV; totals use the tiered cut below.
  const payoutShare = () => 0.7 * keepShare();
  const payoutForCumulative = (net) => (net - steamCut(net)) * keepShare();

  // ── model ──
  function buildModel() {
    const days = state.days.filter((d) => d.date);
    if (!days.length) return null;
    const s = state.settings;
    const launch = days[0].date;
    const lastDate = days[days.length - 1].date;
    const n = daysBetween(launch, lastDate) + 1;

    const actual = new Array(n).fill(0);
    const refunds = new Array(n).fill(0);
    const net = new Array(n).fill(null);
    const logged = new Set();
    for (const d of days) {
      const i = daysBetween(launch, d.date);
      logged.add(i);
      actual[i] += Math.max(0, num(d.units));
      refunds[i] += Math.max(0, num(d.refunds));
      if (d.netUsd !== "" && d.netUsd != null && Number.isFinite(parseFloat(d.netUsd))) net[i] = (net[i] || 0) + parseFloat(d.netUsd);
    }

    // A day still in progress is scaled up to a full day for fitting.
    const fitted = actual.slice();
    const hours = clamp(num(s.lastDayHours, 24), 1, 24);
    if (s.lastDayPartial && hours < 24) fitted[n - 1] = actual[n - 1] * 24 / hours;

    const totalUnits = sum(actual);
    const totalRefunds = sum(refunds);
    const refundsLogged = totalRefunds > 0;
    const refundRate = refundsLogged && totalUnits > 0 ? totalRefunds / totalUnits : num(s.refundFallbackPct) / 100;

    let calibNet = 0, calibGross = 0;
    for (let i = 0; i < n; i++) {
      if (net[i] != null && actual[i] > 0) {
        calibNet += net[i];
        calibGross += actual[i] * priceOn(addDaysISO(launch, i), launch);
      }
    }
    const calibrated = calibGross > 0;
    const netFactor = calibrated ? calibNet / calibGross : (1 - num(s.taxRegionalPct) / 100) * (1 - refundRate);

    const peak = Math.max(...fitted, 0);
    return {
      launch, lastDate, n, actual, refunds, net, fitted, refundRate, refundsLogged, netFactor, calibrated,
      peak, peakIdx: fitted.indexOf(peak), totalUnits, totalRefunds, missingDays: n - logged.size,
    };
  }

  function fitDecay(model, tail) {
    const ratios = [];
    for (let i = model.peakIdx + 1; i < model.n; i++) {
      const prev = model.fitted[i - 1] - tail, cur = model.fitted[i] - tail;
      if (prev > 0 && cur > 0) ratios.push(cur / prev);
    }
    const recent = ratios.slice(-4);
    if (!recent.length) return PRIOR_DECAY;
    const geoMean = Math.exp(recent.reduce((t, r) => t + Math.log(r), 0) / recent.length);
    const weight = recent.length / (recent.length + 3);
    return clamp(weight * geoMean + (1 - weight) * PRIOR_DECAY, 0.4, 0.95);
  }

  // How wide the low–high range is: full width with nothing logged after the
  // peak, narrowing to 40% of that over eight weeks of decline.
  function spread(model) {
    const after = Math.max(0, model.n - 1 - model.peakIdx);
    return clamp(1 - 0.6 * after / 56, 0.4, 1);
  }
  // Low falls faster and settles lower; high falls slower and settles higher.
  function scenario(key, s) {
    if (key === "low") return { decayMul: 1 - 0.2 * s, tailMul: 1 - 0.55 * s };
    if (key === "high") return { decayMul: 1 + 0.14 * s, tailMul: 1 + s };
    return { decayMul: 1, tailMul: 1 };
  }

  function project(model, key) {
    const sc = scenario(key, spread(model));
    const tail0 = model.peak * num(state.settings.tailPct) / 100 * sc.tailMul;
    const decay = Math.min(fitDecay(model, tail0) * sc.decayMul, key === "high" ? 0.975 : 0.96);
    const startLevel = Math.max(model.fitted[model.n - 1], tail0);
    const H = Math.max(MAX_DAYS, model.n);

    const units = new Array(H).fill(0);
    const steamNet = new Array(H).fill(0);
    for (let i = 0; i < H; i++) {
      const date = addDaysISO(model.launch, i);
      if (i < model.n) {
        units[i] = model.actual[i];
        steamNet[i] = model.net[i] != null ? model.net[i] : units[i] * priceOn(date, model.launch) * model.netFactor;
        continue;
      }
      const k = i - (model.n - 1);
      const tail = tail0 * Math.pow(TAIL_DECAY_PER_DAY, i);
      let u = tail + (startLevel - tail0) * Math.pow(decay, k);
      const sale = saleOn(date);
      if (sale) u *= Math.max(1, num(sale.boost, 1));
      units[i] = u;
      steamNet[i] = u * priceOn(date, model.launch) * model.netFactor;
    }

    // What's still to come on a day that's in progress.
    const remainder = Math.max(0, model.fitted[model.n - 1] - model.actual[model.n - 1]);
    const remainderNet = remainder * priceOn(model.lastDate, model.launch) * model.netFactor;
    return { units, steamNet, remainder, remainderNet, decay, tail0 };
  }

  function periodTotals(proj, from, to, includeRemainder) {
    let units = sum(proj.units.slice(from, to + 1));
    let net = sum(proj.steamNet.slice(from, to + 1));
    if (includeRemainder) { units += proj.remainder; net += proj.remainderNet; }
    const netBefore = sum(proj.steamNet.slice(0, from));
    const payout = payoutForCumulative(netBefore + net) - payoutForCumulative(netBefore);
    return { units, net, payout };
  }
  function allCases(projections, from, to, rem) {
    const out = {};
    for (const k of CASE_KEYS) out[k] = periodTotals(projections[k], from, to, rem);
    return out;
  }

  // ── framing ──
  function presetFrame(model, preset) {
    const n = model.n;
    if (preset === "logged") return { start: 0, end: Math.max(n - 1, MIN_FRAME_DAYS - 1) };
    return { start: 0, end: Math.max(parseInt(preset, 10) - 1, n + 6) };
  }
  function normalizeFrame({ start, end }) {
    end = clamp(Math.round(end), MIN_FRAME_DAYS - 1, MAX_DAYS - 1);
    start = clamp(Math.round(start), 0, end - (MIN_FRAME_DAYS - 1));
    return { start, end };
  }
  const currentFrame = (model) => normalizeFrame(customFrame || presetFrame(model, state.chartPrefs.preset));
  function setCustomFrame(frame) {
    customFrame = normalizeFrame(frame);
    recompute();
  }
  function zoomFrame(factor, anchorIndex) {
    const model = buildModel();
    if (!model) return;
    const f = currentFrame(model);
    const span = f.end - f.start;
    const anchor = anchorIndex ?? (f.start + f.end) / 2;
    const ratio = span ? (anchor - f.start) / span : 0.5;
    const newSpan = clamp(span * factor, MIN_FRAME_DAYS - 1, MAX_DAYS - 1);
    const start = anchor - newSpan * ratio;
    setCustomFrame({ start, end: start + newSpan });
  }

  // ── rendering ──
  function renderAll() {
    fillBound();
    if (document.activeElement !== $("#titleInput")) $("#titleInput").value = state.gameName;
    renderToggles();
    renderPanels();
    renderLog();
    renderSales();
    recompute();
  }

  function renderPanels() {
    for (const tab of $$(".sec-tab")) {
      const on = tab.dataset.panel === state.chartPrefs.panel;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $("#spanel-" + tab.dataset.panel).hidden = !on;
    }
  }
  function openPanel(name) {
    state.chartPrefs.panel = name;
    renderPanels();
    scheduleSave();
  }

  function fillBound() {
    for (const el of $$("#project [data-bind]")) {
      const value = el.dataset.bind.split(".").reduce((o, k) => (o == null ? undefined : o[k]), state);
      if (el.type === "checkbox") el.checked = !!value;
      else if (document.activeElement !== el) el.value = value ?? "";
    }
  }

  const SEGMENTS = { metricSeg: "metric", viewSeg: "view", scaleSeg: "scale", presetSeg: "preset", totalsSeg: "totals" };
  function renderSegments() {
    for (const [id, key] of Object.entries(SEGMENTS)) {
      for (const b of $$(`#${id} button`)) {
        const pressed = key === "preset" ? !customFrame && b.dataset.value === state.chartPrefs.preset : b.dataset.value === state.chartPrefs[key];
        b.setAttribute("aria-pressed", String(pressed));
      }
    }
    $("#resetFrame").hidden = !customFrame;
  }

  function renderToggles() {
    for (const el of $$("[data-series]")) {
      el.checked = !!state.chartPrefs.series[el.dataset.series];
      if (el.dataset.series === "average") el.disabled = state.chartPrefs.view === "cumulative";
    }
    renderLegend();
  }
  // The legend lists only what's on the chart; the Chart menu turns things on and off.
  function renderLegend() {
    $("#shownLegend").innerHTML = $$("[data-series]")
      .filter((el) => el.checked && !el.disabled)
      .map((el) => `<span>${el.nextElementSibling.outerHTML}${escapeHtml(el.parentElement.textContent.trim())}</span>`)
      .join("");
  }

  function renderLog() {
    const body = $("#logBody");
    if (!state.days.length) {
      body.innerHTML = `<tr><td colspan="5" class="log-empty">No days logged yet. Add your launch day to start.</td></tr>`;
      return;
    }
    body.innerHTML = state.days.map((d, i) => `
      <tr>
        <td><input type="date" value="${d.date}" data-day="${i}" data-field="date" aria-label="Date"></td>
        <td><input class="r" type="number" min="0" step="1" value="${d.units ?? ""}" data-day="${i}" data-field="units" aria-label="Copies sold on ${d.date}"></td>
        <td><input class="r" type="number" min="0" step="1" value="${d.refunds ?? ""}" data-day="${i}" data-field="refunds" aria-label="Refunds on ${d.date}"></td>
        <td><input class="r" type="number" step="0.01" value="${d.netUsd ?? ""}" data-day="${i}" data-field="netUsd" placeholder="optional" aria-label="Steamworks net in USD on ${d.date}"></td>
        <td><button class="del" type="button" data-del="${i}" aria-label="Remove ${d.date}">Remove</button></td>
      </tr>`).join("");
  }

  function renderSales() {
    const box = $("#sales");
    if (!state.plannedSales.length) { box.innerHTML = `<p class="help" style="margin:0">No discounts planned.</p>`; return; }
    box.innerHTML = state.plannedSales.map((s, i) => `
      <div class="sale">
        <div><label for="s-start-${i}">Starts</label><input id="s-start-${i}" type="date" value="${s.start || ""}" data-sale="${i}" data-field="start"></div>
        <div><label for="s-days-${i}">Days</label><input id="s-days-${i}" type="number" min="1" step="1" value="${s.days ?? ""}" data-sale="${i}" data-field="days"></div>
        <div><label for="s-disc-${i}">Off (%)</label><input id="s-disc-${i}" type="number" min="0" max="95" step="1" value="${s.discountPct ?? ""}" data-sale="${i}" data-field="discountPct"></div>
        <div><label for="s-boost-${i}">Boost (×)</label><input id="s-boost-${i}" type="number" min="1" step="0.1" value="${s.boost ?? ""}" data-sale="${i}" data-field="boost"></div>
        <button class="btn" type="button" data-del-sale="${i}" aria-label="Remove discount">Remove</button>
      </div>`).join("");
  }

  function recompute() {
    if (!activeId || $("#view-track").hidden) return;
    const model = buildModel();
    renderReviews(model);
    renderSegments();
    $("#thNet").textContent = `Steam net (${Money.code})`;
    $("#thPayout").textContent = `Your payout (${Money.code})`;
    $("#refHint").textContent = model && model.refundsLogged ? `Using ${fmtPct(model.refundRate)} from your log` : "Used until you log refunds";
    $("#f-ref").disabled = !!(model && model.refundsLogged);

    if (!model) {
      $("#chartEmpty").hidden = false;
      $("#chartEmpty").textContent = "Add your first day of sales below, or import a Steamworks CSV.";
      $("#notes").innerHTML = "";
      $("#frameSummary").textContent = "";
      $("#totals").innerHTML = `<tr><td colspan="4" style="color:var(--muted)">Totals appear once you log a day of sales.</td></tr>`;
      $("#totalsSplit").hidden = true;
      $("#moneyReadout").innerHTML = "";
      $("#wishReadout").innerHTML = "";
      $("#logMsg").textContent = "";
      if (chart) { chart.destroy(); chart = null; }
      lastRender = null;
      return;
    }
    $("#chartEmpty").hidden = true;

    const frame = currentFrame(model);
    const projections = {};
    for (const k of CASE_KEYS) projections[k] = project(model, k);

    renderTotals(model, projections);
    renderNotes(model, projections.mid);
    renderMoney(model);
    renderWishlists(model, projections);
    renderFrameSummary(model, projections, frame);
    renderChart(model, projections, frame);

    $("#logMsg").className = "msg";
    $("#logMsg").textContent = model.missingDays > 0
      ? `${model.missingDays} day${model.missingDays > 1 ? "s are" : " is"} missing between your first and last date and count as zero sales.`
      : "";
  }

  function renderTotals(model, projections) {
    const n = model.n;
    const loggedMoney = model.calibrated ? (v) => Money.exact(v) : (v) => Money.rough(v);
    const launchTo = (i, fmt) => `${fmtDate(model.launch)} to ${fmt(addDaysISO(model.launch, i))}`;
    // A span still has forecast in it if it runs past the log, or ends on a day that's in progress.
    const spanRow = (label, from, to, fmt) => {
      const forecast = to > n - 1 || (to === n - 1 && !!state.settings.lastDayPartial);
      return { label, sub: launchTo(to, fmt), from, to, rem: forecast && to >= n - 1, forecast };
    };
    const running = [
      { label: "Logged so far", sub: launchTo(n - 1, fmtDate), from: 0, to: n - 1, rem: false, forecast: false },
      spanRow("First 30 days", 0, 29, fmtDate),
      spanRow("First year", 0, 364, fmtLongDate),
      spanRow("First three years", 0, MAX_DAYS - 1, fmtLongDate),
    ];
    const ahead = [
      { label: "Next 7 days", sub: `${fmtDate(addDaysISO(model.lastDate, 1))} to ${fmtDate(addDaysISO(model.lastDate, 7))}`, from: n, to: n + 6, rem: true, forecast: true },
    ];
    // Unlogged days from here to the end of the calendar month we're in.
    const [ty, tm] = todayISO().split("-").map(Number);
    const monthEnd = new Date(Date.UTC(ty, tm, 0)).toISOString().slice(0, 10);
    const monthEndIdx = daysBetween(model.launch, monthEnd);
    if (monthEndIdx >= n) {
      const monthName = new Date(monthEnd + "T00:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" });
      ahead.push({ label: `To end of ${monthName}`, sub: `${fmtDate(addDaysISO(model.lastDate, 1))} to ${fmtDate(monthEnd)}`, from: n, to: monthEndIdx, rem: true, forecast: true });
      ahead.sort((a, b) => a.to - b.to);
    }
    const group = (title, note) => `<tr class="group"><th colspan="4">${title} <span>${note}</span></th></tr>`;
    const renderRow = (r) => {
      const t = allCases(projections, r.from, r.to, r.rem);
      if (!r.forecast) {
        const units = sum(model.actual.slice(r.from, r.to + 1));
        const netUnits = model.refundsLogged ? units - sum(model.refunds.slice(r.from, r.to + 1)) : units * (1 - model.refundRate);
        return `<tr>
          <td><strong>${r.label}</strong><br><span class="small">${r.sub}</span></td>
          <td><span class="big">${fmtInt(t.mid.units)}</span><span class="small">${fmtInt(netUnits)} after refunds</span></td>
          <td><span class="big">${loggedMoney(t.mid.net)}</span></td>
          <td><span class="big">${loggedMoney(t.mid.payout)}</span></td>
        </tr>`;
      }
      // Upcoming rows are on top of what's logged, so they read as additions.
      const p = r.added ? "+" : "";
      return `<tr class="forecast">
        <td><strong>${r.label}</strong><br><span class="small">${r.sub}</span></td>
        <td><span class="big">${p}${fmtRange(t.low.units, t.high.units)}</span><span class="small">mid ${p}${fmtRough(t.mid.units)}</span></td>
        <td><span class="big">${p}${Money.range(t.low.net, t.high.net)}</span><span class="small">mid ${p}${Money.rough(t.mid.net)}</span></td>
        <td><span class="big">${p}${Money.range(t.low.payout, t.high.payout)}</span><span class="small">mid ${p}${Money.rough(t.mid.payout)}</span></td>
      </tr>`;
    };
    $("#totals").innerHTML = state.chartPrefs.totals === "months"
      ? group("Each month on its own", "not running totals; Steam pays each month about 30 days after it ends") + monthRows(model).map(renderRow).join("")
      : group("Running totals", "since launch, logged days included") + running.map(renderRow).join("") +
        group("Upcoming only", "days after the last logged one, not added to the above") + ahead.map((r) => renderRow({ ...r, added: true })).join("");
    renderSplit(periodTotals(projections.mid, 0, n - 1, false).net, loggedMoney);
  }

  // Where logged Steam net goes, the same split the estimator draws before launch.
  function renderSplit(net, money) {
    $("#totalsSplit").hidden = !(net > 0);
    if (!(net > 0)) return;
    const cut = steamCut(net), take = payoutForCumulative(net), withheld = net - cut - take;
    const pCut = cut / net * 100, pTax = withheld / net * 100, pTake = take / net * 100;
    const pct = (p) => Math.round(p) + "%";
    $("#t-seg-cut").style.flex = `0 0 ${pCut}%`;
    $("#t-seg-tax").style.flex = `0 0 ${pTax}%`;
    $("#t-seg-take").style.flex = `0 0 ${pTake}%`;
    $("#tl-cut").textContent = `Steam ${money(cut)} (${pct(pCut)})`;
    $("#tl-tax").textContent = `Withheld ${money(withheld)} (${pct(pTax)})`;
    $("#tl-take").textContent = `You ${money(take)} (${pct(pTake)})`;
    $("#t-split").setAttribute("aria-label",
      `Of logged Steam net, Steam takes ${pct(pCut)}, withholding ${pct(pTax)}, you keep ${pct(pTake)}.`);
  }

  // Calendar months from launch: the whole first year, and at least six months past today.
  function monthRows(model) {
    const n = model.n;
    const lastIdx = Math.max(MAX_DAYS, n) - 1;
    const today = todayISO();
    const stop = [addDaysISO(model.launch, 364), addDaysISO(model.lastDate > today ? model.lastDate : today, 183)].sort()[1];
    const rows = [];
    let [y, m] = model.launch.split("-").map(Number);
    for (;;) {
      const start = new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10);
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      const to = daysBetween(model.launch, end);
      if (start > stop || to > lastIdx) break;
      const from = Math.max(0, daysBetween(model.launch, start));
      const holdsLastDay = from <= n - 1 && n - 1 <= to;
      const forecast = to > n - 1 || (to === n - 1 && !!state.settings.lastDayPartial);
      const monthName = new Date(start + "T00:00:00Z").toLocaleString("en-US", { month: "long", timeZone: "UTC" });
      // Valve pays around the 30th of the following month (the 28th or 29th in February).
      const payday = new Date(Date.UTC(y, m, Math.min(30, new Date(Date.UTC(y, m + 1, 0)).getUTCDate()))).toISOString().slice(0, 10);
      const notes = [];
      if (from === 0 && start !== model.launch) notes.push(`From ${fmtDate(model.launch)}`);
      if (forecast && holdsLastDay) notes.push(`${n - from} of ${to - from + 1} days logged`);
      notes.push(`Paid around ${fmtDate(payday)}`);
      rows.push({ label: `${monthName} ${y}`, sub: notes.join(" · "), from, to, rem: forecast && holdsLastDay, forecast });
      if (++m > 12) { m = 1; y++; }
    }
    return rows;
  }

  function renderNotes(model, mid) {
    const lines = [];
    lines.push(`In the middle case, daily sales fall about ${((1 - mid.decay) * 100).toFixed(0)}% a day before settling near ${fmtRough(mid.tail0)} copies a day.`);
    if (model.n === 1) lines.push("With one day logged the forecast leans on a typical launch curve, so the range is wide. It narrows as you add days.");
    if (state.settings.lastDayPartial) lines.push(`The last logged day is projected to finish around ${fmtRough(model.fitted[model.n - 1])} copies.`);
    lines.push(model.calibrated
      ? "Revenue uses your Steamworks net per copy."
      : "Revenue is estimated from price, VAT, regional pricing and refunds. Add Steamworks net figures to use your real numbers.");
    $("#notes").innerHTML = lines.map((l) => `<p>${l}</p>`).join("");
  }

  function renderMoney(model) {
    const s = state.settings;
    const launchPriceUsd = num(s.price) * (1 - num(s.launchDiscountPct) / 100);
    const netPerUnit = launchPriceUsd * model.netFactor;
    const local = Money.code === "USD" ? "" : ` (${Money.exact(launchPriceUsd, 2)})`;
    $("#moneyReadout").innerHTML = `
      <p>At the launch price of $${launchPriceUsd.toFixed(2)}${local}, each copy brings about <strong>${Money.exact(netPerUnit, 2)}</strong> in Steam net and <strong>${Money.exact(netPerUnit * payoutShare(), 2)}</strong> to you.</p>
      <p class="help" style="margin:0">Steam takes 30% up to $10M, 25% up to $50M and 20% after that, in USD.</p>`;
  }

  function renderWishlists(model, projections) {
    const wl = num(state.settings.wishlists);
    if (wl <= 0) { $("#wishReadout").innerHTML = `<p class="help" style="margin:0">Enter your launch wishlists to compare them with sales.</p>`; return; }
    const pct = (v) => fmtPct(v, 0);
    // Days 0 to 6 only; forecast fills in whatever the log hasn't reached yet.
    const weekOpen = model.n < 7 || (model.n === 7 && !!state.settings.lastDayPartial);
    const week = allCases(projections, 0, 6, model.n <= 7);
    const weekText = !weekOpen
      ? `First week: <strong>${pct(week.mid.units / wl)}</strong>.`
      : `First week on the forecast: <strong>${fmtRange(week.low.units / wl, week.high.units / wl, pct)}</strong>.`;
    $("#wishReadout").innerHTML = `
      <p>Copies sold so far equal <strong>${fmtPct(model.totalUnits / wl)}</strong> of your launch wishlists.</p>
      <p>${weekText} The median launch is around 10%.</p>
      <p class="help" style="margin:0">Not every buyer came from a wishlist, so this is a ratio rather than true conversion.</p>`;
  }

  function steamRating(pos, total) {
    if (total < 10) return { label: `${total} user review${total === 1 ? "" : "s"}`, tone: "mid" };
    const p = pos / total;
    if (p >= 0.95 && total >= 500) return { label: "Overwhelmingly Positive", tone: "good" };
    if (p >= 0.8) return { label: total >= 50 ? "Very Positive" : "Positive", tone: "good" };
    if (p >= 0.7) return { label: "Mostly Positive", tone: "good" };
    if (p >= 0.4) return { label: "Mixed", tone: "mid" };
    if (p >= 0.2) return { label: "Mostly Negative", tone: "bad" };
    if (total >= 500) return { label: "Overwhelmingly Negative", tone: "bad" };
    return { label: total >= 50 ? "Very Negative" : "Negative", tone: "bad" };
  }

  function renderReviews(model) {
    const pos = Math.max(0, Math.round(num(state.reviews.positive)));
    const neg = Math.max(0, Math.round(num(state.reviews.negative)));
    const total = pos + neg;
    const box = $("#reviewReadout");
    if (!total) { box.innerHTML = `<p class="help" style="margin-top:12px">Enter the review counts from your store page.</p>`; return; }

    const p = pos / total;
    const rating = steamRating(pos, total);
    const lines = [];
    if (total >= 10) {
      if (p >= 0.7) {
        const buffer = Math.floor(pos / 0.7 - total + 1e-9);
        lines.push(`<strong>${buffer}</strong> more negative review${buffer === 1 ? "" : "s"}, with no new positives, would drop you to Mixed.`);
      } else if (p >= 0.4) {
        const need = Math.ceil((0.7 * total - pos) / 0.3 - 1e-9);
        lines.push(`<strong>${need}</strong> positive review${need === 1 ? "" : "s"} in a row would reach Mostly Positive.`);
      }
      if (p < 0.8) {
        const need = Math.max(Math.ceil((0.8 * total - pos) / 0.2 - 1e-9), 0);
        const flips = Math.ceil(0.8 * total - pos - 1e-9);
        lines.push(`80% takes <strong>${need}</strong> positives in a row, or about <strong>${flips}</strong> negatives changed to positive.`);
      }
    } else {
      lines.push(`Steam shows a rating from 10 reviews. ${10 - total} to go.`);
    }
    if (model && model.totalUnits > 0) lines.push(`${(total / model.totalUnits * 100).toFixed(1)} reviews per 100 copies sold.`);

    box.innerHTML = `
      <div class="rating ${rating.tone}">${rating.label}</div>
      <div class="help" style="margin:0">${fmtPct(p)} positive of ${fmtInt(total)} reviews</div>
      <div class="meter" aria-hidden="true">
        <div class="fill" style="width:${(p * 100).toFixed(1)}%;background:${p >= 0.7 ? "var(--ink)" : "var(--accent)"}"></div>
        <div class="tick" style="left:40%"><span>40%</span></div>
        <div class="tick" style="left:70%"><span>70%</span></div>
        <div class="tick" style="left:80%"><span>80%</span></div>
      </div>
      <div class="readout">${lines.map((l) => `<p>${l}</p>`).join("")}</div>`;
  }

  function renderFrameSummary(model, projections, frame) {
    const days = frame.end - frame.start + 1;
    const loggedEnd = Math.min(frame.end, model.n - 1);
    const loggedUnits = frame.start <= loggedEnd ? sum(model.actual.slice(frame.start, loggedEnd + 1)) : 0;
    const includesRemainder = frame.start <= model.n - 1 && frame.end >= model.n - 1;
    const t = allCases(projections, frame.start, frame.end, includesRemainder);
    const span = `<strong>${fmtLongDate(addDaysISO(model.launch, frame.start))}</strong> to <strong>${fmtLongDate(addDaysISO(model.launch, frame.end))}</strong>, ${days} days.`;
    const forecasting = frame.end > model.n - 1 || (includesRemainder && projections.mid.remainder > 0);
    const body = forecasting
      ? `<strong>${fmtRange(t.low.units, t.high.units)} copies</strong>${loggedUnits ? ` (${fmtInt(loggedUnits)} logged)` : ""}, ` +
        `${Money.range(t.low.net, t.high.net)} Steam net, ${Money.range(t.low.payout, t.high.payout)} payout.`
      : `<strong>${fmtInt(t.mid.units)} copies</strong>, ${Money.rough(t.mid.net)} Steam net, ${Money.rough(t.mid.payout)} payout.`;
    $("#frameSummary").innerHTML = `Showing ${span} ${body}`;
  }

  // ── chart ──
  function dailyMetric(proj) {
    const metric = state.chartPrefs.metric;
    if (metric === "units") return { values: proj.units, remainder: proj.remainder };
    const factor = Money.rate() * (metric === "payout" ? payoutShare() : 1);
    return { values: proj.steamNet.map((v) => v * factor), remainder: proj.remainderNet * factor };
  }

  function buildSeries(model, proj, H) {
    const n = model.n;
    const { values, remainder } = dailyMetric(proj);
    const combined = values.slice(0, H);
    if (n - 1 < H) combined[n - 1] += remainder;
    if (state.chartPrefs.view === "daily") {
      const actual = combined.map((v, i) => (i < n ? values[i] : null));
      const forecast = combined.map((v, i) => (i >= n - 1 ? v : null));
      return { actual, forecast, combined };
    }
    const cumulative = [];
    let running = 0;
    for (let i = 0; i < H; i++) { running += combined[i]; cumulative.push(running); }
    let actualRunning = 0;
    const actual = new Array(H).fill(null);
    for (let i = 0; i < n; i++) { actualRunning += values[i]; actual[i] = actualRunning; }
    const forecast = cumulative.map((v, i) => (i >= n - 1 ? v : null));
    return { actual, forecast, combined: cumulative };
  }

  function trailingAverage(values, window) {
    const out = [];
    let total = 0;
    for (let i = 0; i < values.length; i++) {
      total += values[i];
      if (i >= window) total -= values[i - window];
      out.push(total / Math.min(i + 1, window));
    }
    return out;
  }

  function framePeriods(model, frame) {
    const periods = [];
    const launchEnd = daysBetween(model.launch, launchDiscountEnd(model.launch));
    if (num(state.settings.launchDiscountPct) > 0) periods.push({ from: 0, to: launchEnd, label: `Launch ${num(state.settings.launchDiscountPct)}% off` });
    for (const sale of state.plannedSales) {
      if (!sale.start) continue;
      const from = daysBetween(model.launch, sale.start);
      periods.push({ from, to: from + Math.max(1, Math.round(num(sale.days, 1))) - 1, label: `${num(sale.discountPct)}% off` });
    }
    return periods
      .filter((p) => p.to >= frame.start && p.from <= frame.end)
      .map((p) => ({ ...p, from: Math.max(p.from, frame.start) - frame.start, to: Math.min(p.to, frame.end) - frame.start }));
  }

  const overlayPlugin = {
    id: "frameOverlays",
    beforeDatasetsDraw(c) {
      const o = c.options.plugins.frameOverlays;
      if (!o) return;
      const { ctx, chartArea: area, scales: { x } } = c;
      const step = c.data.labels.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : area.right - area.left;
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      ctx.clip();
      for (const p of o.periods) {
        const left = x.getPixelForValue(p.from) - step / 2;
        const right = x.getPixelForValue(p.to) + step / 2;
        ctx.fillStyle = o.periodFill;
        ctx.fillRect(left, area.top, right - left, area.bottom - area.top);
      }
      if (o.nowIndex != null) {
        const px = x.getPixelForValue(o.nowIndex) + (o.nowOffset ? step / 2 : 0);
        ctx.strokeStyle = o.nowColor;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(px, area.top);
        ctx.lineTo(px, area.bottom);
        ctx.stroke();
      }
      ctx.restore();
    },
    // Labels go on top of the data, on a backing, so tall bars can't cover them.
    afterDatasetsDraw(c) {
      const o = c.options.plugins.frameOverlays;
      if (!o) return;
      const { ctx, chartArea: area, scales: { x } } = c;
      const step = c.data.labels.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : area.right - area.left;
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
      ctx.clip();
      ctx.font = '12px "Archivo", sans-serif';
      const label = (text, lx, y, color) => {
        const w = ctx.measureText(text).width;
        ctx.fillStyle = o.labelBg;
        ctx.fillRect(lx - 3, y - 11, w + 6, 15);
        ctx.fillStyle = color;
        ctx.fillText(text, lx, y);
      };
      for (const p of o.periods) {
        const left = x.getPixelForValue(p.from) - step / 2;
        const right = x.getPixelForValue(p.to) + step / 2;
        // Label only the periods wide enough to hold one.
        const lx = Math.max(left, area.left) + 5;
        if (Math.min(right, area.right) - lx > ctx.measureText(p.label).width + 5) label(p.label, lx, area.top + 14, o.periodText);
      }
      if (o.nowIndex != null) {
        const px = x.getPixelForValue(o.nowIndex) + (o.nowOffset ? step / 2 : 0);
        const text = "Last logged";
        const w = ctx.measureText(text).width;
        // Daily sales sit low by now and a running total sits high, so the label goes where the data isn't:
        // near the top for daily, the bottom for cumulative. Right of the line when there's room, else left.
        const y = o.nowOffset ? area.top + 32 : area.bottom - 6;
        label(text, px + 5 + w <= area.right ? px + 5 : px - 5 - w, y, o.nowColor);
      }
      ctx.restore();
    },
  };

  // Small dots on a clear ground, drawn at device resolution so they stay crisp.
  function dotPattern(color) {
    const dpr = window.devicePixelRatio || 1, size = 4;
    const tile = document.createElement("canvas");
    tile.width = tile.height = Math.round(size * dpr);
    const g = tile.getContext("2d");
    g.fillStyle = color;
    g.beginPath();
    g.arc(tile.width / 2, tile.height / 2, 0.9 * dpr, 0, Math.PI * 2);
    g.fill();
    const pattern = g.createPattern(tile, "repeat");
    pattern.setTransform(new DOMMatrix().scale(1 / dpr));
    return pattern;
  }

  function renderChart(model, projections, frame) {
    if (typeof window.Chart === "undefined") {
      $("#chartEmpty").hidden = false;
      $("#chartEmpty").textContent = "The chart couldn't load. Totals and forecasts below still work.";
      return;
    }
    const prefs = state.chartPrefs;
    const shown = prefs.series;
    const H = frame.end + 1;
    const cut = (arr) => arr.slice(frame.start, frame.end + 1);
    const tickDate = H - frame.start > 180 ? fmtMonth : fmtDate;
    const labels = Array.from({ length: H - frame.start }, (_, i) => tickDate(addDaysISO(model.launch, frame.start + i)));
    const cumulative = prefs.view === "cumulative";
    const logScale = prefs.scale === "log";
    const forLog = (arr) => (logScale ? arr.map((v) => (v != null && v > 0 ? v : null)) : arr);

    const mid = buildSeries(model, projections.mid, H);
    const lo = cut(buildSeries(model, projections.low, H).forecast);
    const hi = cut(buildSeries(model, projections.high, H).forecast);

    const ink = cssVar("--ink"), accent = cssVar("--accent"), muted = cssVar("--muted"), faint = cssVar("--faint");
    // The last logged day isn't over yet when it's marked in progress or dated today; draw it dotted.
    const openDay = state.settings.lastDayPartial || model.lastDate >= todayISO() ? model.n - 1 - frame.start : null;
    const isOpen = (ctx) => ctx.dataIndex === openDay;
    const dots = dotPattern(ink);
    const datasets = [];
    if (shown.actual) {
      datasets.push(cumulative
        ? { label: "Logged", type: "line", data: forLog(cut(mid.actual)), borderColor: ink, borderWidth: 2.5, pointRadius: 0, order: 2,
            segment: { borderDash: (ctx) => (ctx.p1DataIndex === openDay ? [2, 4] : undefined) } }
        : { label: "Logged", type: "bar", data: forLog(cut(mid.actual)), order: 2,
            backgroundColor: (ctx) => (isOpen(ctx) ? dots : ink), borderColor: ink, borderWidth: (ctx) => (isOpen(ctx) ? 1 : 0) });
    }
    if (shown.forecast) datasets.push({ label: "Middle case", type: "line", data: forLog(cut(mid.forecast)), borderColor: accent, borderWidth: 2.5, borderDash: [6, 5], pointRadius: 0, fill: false, order: 0 });
    if (shown.range) {
      datasets.push({ label: "High", type: "line", data: forLog(hi), borderWidth: 0, pointRadius: 0, backgroundColor: withAlpha(accent, 0.2), fill: "+1", order: 3 });
      datasets.push({ label: "Low", type: "line", data: forLog(lo), borderWidth: 0, pointRadius: 0, fill: false, order: 3 });
    }
    if (shown.average && !cumulative) datasets.push({ label: "7-day average", type: "line", data: forLog(cut(trailingAverage(mid.combined, 7))), borderColor: muted, borderWidth: 1.5, pointRadius: 0, fill: false, order: 1 });

    const nowInFrame = shown.now && model.n - 1 >= frame.start && model.n - 1 <= frame.end;
    const isMoney = prefs.metric !== "units";
    const fmtAxis = (v) => (isMoney ? Money.localCompact(v) : fmtCompact(v));
    const fmtExact = (v) => (isMoney ? Money.local(v) : fmtInt(v));
    const fmtEst = (v) => (isMoney ? Money.localRough(v) : fmtRough(v));
    const firstForecast = model.n - frame.start; // index of the first unlogged day

    if (chart) chart.destroy();
    chart = new Chart($("#chart"), {
      type: "bar",
      data: { labels, datasets },
      plugins: [overlayPlugin],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            // Low and high fold into the middle-case line; the logged day the
            // forecast starts from is shown once, as logged.
            filter: (item) => item.raw != null && item.dataset.label !== "High" && item.dataset.label !== "Low" &&
              !(item.dataset.label === "Middle case" && item.dataIndex < firstForecast && shown.actual),
            callbacks: {
              title: (items) => (items.length ? fmtLongDate(addDaysISO(model.launch, frame.start + items[0].dataIndex)) : ""),
              label: (item) => {
                if (item.dataset.label === "Logged") return `Logged: ${fmtExact(item.raw)}${item.dataIndex === openDay ? " so far, day in progress" : ""}`;
                if (item.dataset.label !== "Middle case") return `${item.dataset.label}: ${fmtEst(item.raw)}`;
                const i = item.dataIndex;
                const range = lo[i] != null && hi[i] != null ? ` (${fmtRange(lo[i], hi[i], fmtEst)})` : "";
                return `Middle case: ${fmtEst(item.raw)}${range}`;
              },
            },
          },
          frameOverlays: {
            periods: shown.periods ? framePeriods(model, frame) : [],
            periodFill: withAlpha(accent, 0.1),
            periodText: muted,
            nowIndex: nowInFrame ? model.n - 1 - frame.start : null,
            nowOffset: !cumulative,
            nowColor: ink,
            labelBg: withAlpha(cssVar("--surface"), 0.85),
          },
        },
        scales: {
          x: { grid: { display: false }, border: { color: cssVar("--line") }, ticks: { color: faint, maxTicksLimit: 9, maxRotation: 0 } },
          y: {
            type: logScale ? "logarithmic" : "linear",
            beginAtZero: !logScale,
            grid: { color: cssVar("--line-soft") }, border: { display: false },
            ticks: { color: faint, callback: (v) => fmtAxis(v) },
          },
        },
        datasets: { bar: { barPercentage: 0.9, categoryPercentage: 0.9, borderRadius: 0 } },
      },
    });
    lastRender = { frame };
  }

  // ── chart interaction: drag to zoom, double-click to reset, ctrl+scroll ──
  const canvas = $("#chart");
  const selection = $("#selection");
  let drag = null;

  function indexAtPixel(px) {
    const x = chart.scales.x;
    return lastRender.frame.start + clamp(Math.round(x.getValueForPixel(px)), 0, lastRender.frame.end - lastRender.frame.start);
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (!chart || !lastRender || e.button !== 0) return;
    const area = chart.chartArea;
    if (e.offsetX < area.left || e.offsetX > area.right) return;
    drag = { x0: e.offsetX, x1: e.offsetX };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const area = chart.chartArea;
    drag.x1 = clamp(e.offsetX, area.left, area.right);
    const left = Math.min(drag.x0, drag.x1), width = Math.abs(drag.x1 - drag.x0);
    selection.hidden = width < 4;
    selection.style.left = `${left}px`;
    selection.style.width = `${width}px`;
    selection.style.top = `${area.top}px`;
    selection.style.bottom = `${canvas.clientHeight - area.bottom}px`;
  });
  canvas.addEventListener("pointerup", () => {
    if (!drag) return;
    const { x0, x1 } = drag;
    drag = null;
    selection.hidden = true;
    if (Math.abs(x1 - x0) < 8) return;
    const a = indexAtPixel(Math.min(x0, x1)), b = indexAtPixel(Math.max(x0, x1));
    setCustomFrame({ start: a, end: Math.max(b, a + MIN_FRAME_DAYS - 1) });
  });
  canvas.addEventListener("pointercancel", () => { drag = null; selection.hidden = true; });
  canvas.addEventListener("dblclick", () => { customFrame = null; recompute(); });
  canvas.addEventListener("wheel", (e) => {
    if (!chart || !lastRender || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    zoomFrame(e.deltaY < 0 ? 0.8 : 1.25, indexAtPixel(clamp(e.offsetX, chart.chartArea.left, chart.chartArea.right)));
  }, { passive: false });

  // ── Steamworks CSV ──
  function parseCSV(text) {
    const rows = []; let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === "," || c === "\t") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  }
  function parseNumber(v) {
    if (v == null) return NaN;
    let s = String(v).trim();
    const negative = /^\(.*\)$/.test(s);
    s = s.replace(/[()$,\s]/g, "");
    const n = parseFloat(s);
    return negative ? -n : n;
  }
  function parseDate(v) {
    const s = String(v).trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    const t = Date.parse(s + " UTC");
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
  }

  function importSteamworksCsv(text) {
    const rows = parseCSV(text.replace(/^﻿/, "")).filter((r) => r.some((c) => c.trim()));
    const headerIdx = rows.findIndex((r) => r.some((c) => /date/i.test(c)) && r.some((c) => /unit/i.test(c)));
    if (headerIdx < 0) throw new Error("Couldn't find a header row with Date and Units columns. Export the daily sales CSV from Steamworks and try again.");
    const header = rows[headerIdx].map((c) => c.trim().toLowerCase());
    const find = (pred) => header.findIndex(pred);
    const isRefund = (c) => /return|refund|chargeback/.test(c);
    const isMoney = (c) => /usd|\$|sales|revenue/.test(c);

    const dateCol = find((c) => c.includes("date"));
    let unitsCol = find((c) => c.includes("gross units"));
    let unitsAreNet = false;
    if (unitsCol < 0) unitsCol = find((c) => c.includes("unit") && !isRefund(c) && !c.includes("net") && !isMoney(c));
    if (unitsCol < 0) { unitsCol = find((c) => c.includes("net units")); unitsAreNet = unitsCol >= 0; }
    const refundCol = find((c) => isRefund(c) && !isMoney(c));
    const netCol = find((c) => c.includes("net") && isMoney(c) && !c.includes("unit"));
    if (unitsCol < 0) throw new Error("Couldn't find a units column in that file.");

    const byDate = new Map();
    for (const r of rows.slice(headerIdx + 1)) {
      const date = parseDate(r[dateCol] || "");
      if (!date) continue;
      const entry = byDate.get(date) || { units: 0, refunds: 0, netUsd: null };
      const u = parseNumber(r[unitsCol]);
      const ref = refundCol >= 0 ? Math.abs(parseNumber(r[refundCol])) : 0;
      const nt = netCol >= 0 ? parseNumber(r[netCol]) : NaN;
      if (Number.isFinite(u)) entry.units += unitsAreNet ? u + (Number.isFinite(ref) ? ref : 0) : u;
      if (Number.isFinite(ref)) entry.refunds += ref;
      if (Number.isFinite(nt)) entry.netUsd = (entry.netUsd || 0) + nt;
      byDate.set(date, entry);
    }
    if (!byDate.size) throw new Error("No dated rows found in that file.");

    for (const [date, e] of byDate) {
      const existing = state.days.find((d) => d.date === date);
      const row = { date, units: Math.round(e.units), refunds: Math.round(e.refunds), netUsd: e.netUsd == null ? "" : Math.round(e.netUsd * 100) / 100 };
      if (existing) Object.assign(existing, row); else state.days.push(row);
    }
    state.days.sort((a, b) => a.date.localeCompare(b.date));
    return byDate.size;
  }

  function buildForecastCsv() {
    const model = buildModel();
    if (!model) return null;
    const p = {};
    for (const k of CASE_KEYS) p[k] = project(model, k);
    const code = Money.code.toLowerCase();
    const rate = Money.rate();
    const lines = [`date,type,units_mid,units_low,units_high,steam_net_usd_mid,payout_${code}_mid`];
    p.mid.units.forEach((u, i) => {
      const net = p.mid.steamNet[i];
      lines.push([
        addDaysISO(model.launch, i), i < model.n ? "logged" : "forecast",
        Math.round(u), Math.round(p.low.units[i]), Math.round(p.high.units[i]),
        net.toFixed(2), (net * rate * payoutShare()).toFixed(2),
      ].join(","));
    });
    return lines.join("\n");
  }

  // ── events ──
  function onChange() { scheduleSave(); recompute(); }
  const view = $("#view-track");

  view.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.bind) {
      const value = el.type === "checkbox" ? el.checked : el.type === "number" ? (el.value === "" ? "" : parseFloat(el.value)) : el.value;
      const keys = el.dataset.bind.split(".");
      let target = state;
      keys.slice(0, -1).forEach((k) => { target = target[k]; });
      target[keys[keys.length - 1]] = value;
      onChange();
    } else if (el.dataset.series) {
      state.chartPrefs.series[el.dataset.series] = el.checked;
      renderLegend();
      onChange();
    } else if (el.dataset.day != null && el.dataset.field !== "date") {
      state.days[+el.dataset.day][el.dataset.field] = el.value === "" ? "" : parseFloat(el.value);
      onChange();
    } else if (el.dataset.sale != null) {
      const sale = state.plannedSales[+el.dataset.sale];
      sale[el.dataset.field] = el.type === "number" ? (el.value === "" ? "" : parseFloat(el.value)) : el.value;
      // A deeper discount suggests a bigger boost; the boost stays editable.
      if (el.dataset.field === "discountPct") {
        sale.boost = Math.round((1 + num(el.value) * 0.08) * 10) / 10;
        const boostInput = document.getElementById(`s-boost-${el.dataset.sale}`);
        if (boostInput) boostInput.value = sale.boost;
      }
      onChange();
    }
  });

  view.addEventListener("change", (e) => {
    const el = e.target;
    if (el.dataset.day == null || el.dataset.field !== "date" || !el.value) return;
    const idx = +el.dataset.day;
    if (state.days.some((d, i) => i !== idx && d.date === el.value)) {
      $("#logMsg").textContent = `${fmtDate(el.value)} is already in your log.`;
      el.value = state.days[idx].date;
      return;
    }
    state.days[idx].date = el.value;
    state.days.sort((a, b) => a.date.localeCompare(b.date));
    renderLog();
    onChange();
  });

  view.addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) { state.days.splice(+del.dataset.del, 1); renderLog(); onChange(); return; }
    const delSale = e.target.closest("[data-del-sale]");
    if (delSale) { state.plannedSales.splice(+delSale.dataset.delSale, 1); renderSales(); onChange(); }
  });

  for (const [id, key] of Object.entries(SEGMENTS)) {
    $(`#${id}`).addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.chartPrefs[key] = btn.dataset.value;
      if (key === "preset") customFrame = null;
      if (key === "view") renderToggles();
      onChange();
    });
  }
  $("#resetFrame").addEventListener("click", () => { customFrame = null; recompute(); });

  // Dropdowns close on a click outside them or on Escape.
  document.addEventListener("click", (e) => {
    for (const d of $$("details.dropdown[open]")) if (!d.contains(e.target)) d.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const d of $$("details.dropdown[open]")) { d.open = false; d.querySelector("summary").focus(); }
  });

  for (const tab of $$(".sec-tab")) {
    tab.addEventListener("click", () => openPanel(tab.dataset.panel));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const tabs = $$(".sec-tab"), i = tabs.indexOf(tab);
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      openPanel(next.dataset.panel);
      next.focus();
    });
  }

  $("#addDay").addEventListener("click", () => {
    const last = state.days[state.days.length - 1];
    const date = last ? addDaysISO(last.date, 1) : todayISO();
    state.days.push({ date, units: "", refunds: "", netUsd: "" });
    renderLog();
    onChange();
    const input = document.querySelector(`[data-day="${state.days.length - 1}"][data-field="units"]`);
    if (input) input.focus();
  });

  $("#addSale").addEventListener("click", () => {
    const model = buildModel();
    const start = model ? addDaysISO(model.lastDate, 30) : todayISO();
    state.plannedSales.push({ start, days: 7, discountPct: 20, boost: 2.6 });
    renderSales();
    onChange();
  });

  $("#csvInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    const msg = $("#logMsg");
    try {
      const count = importSteamworksCsv(await file.text());
      customFrame = null;
      renderLog();
      onChange();
      msg.className = "msg";
      msg.textContent = `Imported ${count} day${count === 1 ? "" : "s"} from ${file.name}.`;
    } catch (err) {
      console.error("CSV import failed", err);
      msg.className = "msg err";
      msg.textContent = err.message;
    }
  });

  $("#exportCsv").addEventListener("click", () => {
    const csv = buildForecastCsv();
    if (!csv) { $("#dataMsg").textContent = "Log at least one day first."; return; }
    downloadFile(`${safeName()}-forecast.csv`, csv, "text/csv");
    $("#dataMsg").textContent = "Downloaded the forecast CSV.";
  });

  $("#backup").addEventListener("click", () => {
    downloadFile(`${safeName()}-sales-backup.json`, JSON.stringify(state, null, 2), "application/json");
    $("#dataMsg").textContent = "Downloaded a backup.";
  });

  async function restoreFrom(input, msgEl) {
    const file = input.files[0];
    input.value = "";
    if (!file) return;
    try {
      const name = importBackupAsProject(await file.text(), file.name);
      $("#dataMsg").textContent = `Imported ${file.name} as ${name}.`;
    } catch (err) {
      console.error("Backup import failed", err);
      msgEl.textContent = "That file isn't a backup from this tool.";
    }
  }
  $("#restoreInput").addEventListener("change", (e) => restoreFrom(e.target, $("#dataMsg")));
  $("#homeRestore").addEventListener("change", (e) => restoreFrom(e.target, $("#homeMsg")));

  let clearArmed = false;
  $("#clearAll").addEventListener("click", (e) => {
    if (!activeId) return;
    const btn = e.currentTarget;
    if (!clearArmed) {
      clearArmed = true;
      btn.textContent = "Click again to clear";
      setTimeout(() => { clearArmed = false; btn.textContent = "Clear this game"; }, 4000);
      return;
    }
    clearArmed = false;
    btn.textContent = "Clear this game";
    const name = state.gameName;
    state = structuredClone(DEFAULT_STATE);
    state.gameName = name;
    customFrame = null;
    renderAll();
    saveNow();
    $("#dataMsg").textContent = `Cleared ${name}. The game itself is kept.`;
  });

  $("#newProjectForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#newProjectName").value.trim();
    const error = $("#newProjectError");
    if (!name) { error.textContent = "Give the game a name first."; return; }
    if (nameTaken(name)) { error.textContent = `${name} is already on the list.`; return; }
    try {
      error.textContent = "";
      $("#newProjectName").value = "";
      openSave(addSave(name, structuredClone(DEFAULT_STATE)));
    } catch (err) {
      console.error("Could not add game", err);
      error.textContent = "Couldn't save. Browser storage may be full or blocked for this page.";
    }
  });

  $("#projectList").addEventListener("click", (e) => {
    const open = e.target.closest("[data-open-project]");
    if (open) { deleteArmedId = null; openSave(open.dataset.openProject); return; }
    const del = e.target.closest("[data-delete-project]");
    if (!del) return;
    const id = del.dataset.deleteProject;
    if (deleteArmedId !== id) {
      deleteArmedId = id;
      renderProjectList();
      setTimeout(() => { if (deleteArmedId === id) { deleteArmedId = null; renderProjectList(); } }, 4000);
      return;
    }
    deleteArmedId = null;
    try { localStorage.removeItem(SAVE_PREFIX + id); } catch (err) { console.error("Could not remove game data", err); }
    saves = saves.filter((p) => p.id !== id);
    writeIndex();
    renderProjectList();
  });

  $("#backToProjects").addEventListener("click", () => goHome());

  $("#titleInput").addEventListener("change", (e) => {
    const name = e.target.value.trim();
    if (!name) { e.target.value = state.gameName; return; }
    if (nameTaken(name, activeId)) {
      setStatus(`Another game is already named ${name}`);
      e.target.value = state.gameName;
      return;
    }
    state.gameName = name;
    saveNow();
  });

  window.addEventListener("pagehide", flushPendingSave);
  Money.onChange(recompute);
  onThemeChange(recompute);

  readIndex();
  renderProjectList();

  Views.track = {
    show() {
      if (activeId) recompute();
      else renderProjectList();
    },
  };
})();
