/* Before launch: wishlists and conversion in; a low / middle / high range of
   copies and take-home out, for the first week, month, year and three years. */
(() => {
  "use strict";

  const PRESETS = {
    impulse: { price: 4.99,  held: 3600,   win: 2400,  conv: 15, winconv: 7.5, organic: 1.8, tail: 3.0, reg: 30, ref: 10 },
    indie:   { price: 9.99,  held: 7000,   win: 3000,  conv: 12, winconv: 6,   organic: 1.4, tail: 2.5, reg: 25, ref: 8  },
    premium: { price: 24.99, held: 24000,  win: 6000,  conv: 10, winconv: 5,   organic: 1.3, tail: 2.0, reg: 22, ref: 6  },
    hit:     { price: 19.99, held: 160000, win: 90000, conv: 18, winconv: 9,   organic: 2.2, tail: 3.5, reg: 24, ref: 6  },
  };

  // The inputs are the middle case. Low and high move the least certain parts.
  // Organic and tail factors apply to the part above 1.0×.
  const CASES = {
    low:  { conv: 0.6, winconv: 0.5, organic: 0.5, tail: 0.7, ref: 1.25 },
    high: { conv: 1.5, winconv: 1.7, organic: 1.5, tail: 1.4, ref: 0.8 },
  };

  // Share of revenue from US customers, the only part Valve withholds on.
  const US_DEFAULT = 35;

  const YEAR_WEEKS = 52;
  const MAX_WEEKS = 156;
  // Steam's Personal Calendar shows games releasing in the next eight weeks.
  const WINDOW_WEEKS = 8;
  // Week one feels half the price erosion: regional pricing and VAT apply from
  // day one, deeper discounts come later.
  const LAUNCH_SHARE = 0.5;

  // ── wishlist sliders: 0 at the left end, then log scale 100 → 1,000,000 ──
  const WL_MIN = 100, WL_SPAN = 4;
  function posToWl(pos) {
    if (pos <= 0) return 0;
    const raw = WL_MIN * Math.pow(10, (pos / 1000) * WL_SPAN);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)) - 1);
    return Math.max(WL_MIN, Math.round(raw / mag) * mag);
  }
  function wlToPos(w) {
    if (w <= 0) return 0;
    return Math.max(1, Math.round(1000 * Math.log10(Math.max(WL_MIN, w) / WL_MIN) / WL_SPAN));
  }

  // ── inputs: each value has a typed field (the truth) and a slider (a handle) ──
  // The number field can go past the slider's range; the slider pins to its end.
  const FIELDS = {
    price:   { min: 0.99, max: 199.99, dec: 2 },
    held:    { min: 0,    max: 1e7,    dec: 0, log: true },
    win:     { min: 0,    max: 1e7,    dec: 0, log: true },
    conv:    { min: 0,    max: 100,    dec: 1 },
    winconv: { min: 0,    max: 100,    dec: 1 },
    organic: { min: 1,    max: 10,     dec: 1 },
    tail:    { min: 1,    max: 30,     dec: 1 },
    reg:     { min: 0,    max: 90,     dec: 0 },
    ref:     { min: 0,    max: 50,     dec: 1 },
    us:      { min: 0,    max: 100,    dec: 0 },
  };
  const KEYS = Object.keys(FIELDS);
  const taxSel = $("#s-tax");
  for (const k of KEYS) {
    FIELDS[k].num = $("#i-" + k);
    FIELDS[k].range = $("#s-" + k);
  }

  // Last valid value per field, so a half-typed number never blanks the panel.
  const state = {};
  const get = (k) => state[k];

  function clampTo(k, x) {
    const f = FIELDS[k], p = Math.pow(10, f.dec);
    return Math.round(clamp(x, f.min, f.max) * p) / p;
  }
  // Prices keep their cents; everything else drops a trailing ".0".
  const text = (k, x) => (FIELDS[k].dec === 2 ? x.toFixed(2) : String(x));
  function setValue(k, x, { keepText = false } = {}) {
    const f = FIELDS[k];
    x = clampTo(k, x);
    state[k] = x;
    if (!keepText) f.num.value = text(k, x);
    f.range.value = f.log ? wlToPos(x) : x;
  }

  for (const k of KEYS) {
    const f = FIELDS[k];
    f.range.addEventListener("input", () => {
      setValue(k, f.log ? posToWl(parseInt(f.range.value, 10)) : parseFloat(f.range.value));
      markPreset(null);
      render();
    });
    f.num.addEventListener("input", () => {
      const x = parseFloat(f.num.value);
      if (!Number.isFinite(x)) return;
      setValue(k, x, { keepText: true });
      markPreset(null);
      render();
    });
    // On blur, settle whatever was typed into a clean, in-range number.
    f.num.addEventListener("change", () => {
      const x = parseFloat(f.num.value);
      setValue(k, Number.isFinite(x) ? x : state[k]);
      render();
    });
  }

  // ── model ──
  function read() {
    return {
      price: get("price"),
      held: get("held"),
      win: get("win"),
      conv: get("conv") / 100,
      winconv: get("winconv") / 100,
      organic: get("organic"),
      tail: get("tail"),
      reg: get("reg") / 100,
      ref: get("ref") / 100,
      tax: parseFloat(taxSel.value) / 100,
      us: get("us") / 100,
    };
  }
  function shifted(v, c) {
    return {
      ...v,
      conv: Math.min(v.conv * c.conv, 1),
      winconv: Math.min(v.winconv * c.winconv, 1),
      organic: 1 + (v.organic - 1) * c.organic,
      tail: 1 + (v.tail - 1) * c.tail,
      ref: Math.min(v.ref * c.ref, 0.9),
    };
  }

  // Copies accumulate on a power curve, cumulative(n) = week one × n^a, with
  // a = ln(year-one multiple) / ln(52) so week 52 lands on the first year.
  // Inside week one the curve is a straight ramp from zero.
  function cumulative(week1, yearMult, weeks) {
    if (weeks <= 1) return week1 * Math.max(weeks, 0);
    if (yearMult <= 1) return week1;
    const a = Math.log(yearMult) / Math.log(YEAR_WEEKS);
    return week1 * Math.pow(Math.min(weeks, MAX_WEEKS), a);
  }

  function model(v) {
    // Each pile of wishlists buys at its own rate; organic buyers scale the sum.
    const firstWeek = (v.held * v.conv + v.win * v.winconv) * v.organic;
    const u = {
      week: firstWeek,
      month: cumulative(firstWeek, v.tail, 4),
      year: firstWeek * v.tail,
      three: cumulative(firstWeek, v.tail, MAX_WEEKS),
    };
    const paidFor = 1 - v.ref;
    // Erosion ramps with how much of the first year has sold.
    const grossAt = (units) => {
      const share = u.year > 0 ? Math.min(units / u.year, 1) : 1;
      return units * paidFor * v.price * (1 - v.reg * (LAUNCH_SHARE + (1 - LAUNCH_SHARE) * share));
    };
    // Clamped downward so no milestone can out-earn a later one.
    const gThree = grossAt(u.three);
    const gYear = Math.min(grossAt(u.year), gThree);
    const gMonth = Math.min(grossAt(u.month), gYear);
    const gWeek = Math.min(grossAt(u.week), gMonth);

    const at = (units, gross) => {
      const cut = steamCut(gross);
      // Valve withholds only on US-source income: sales to US customers.
      const withheld = (gross - cut) * v.us * v.tax;
      return { units, paidUnits: units * paidFor, gross, cut, withheld, take: gross - cut - withheld };
    };
    return {
      v, firstWeek,
      week: at(u.week, gWeek), month: at(u.month, gMonth),
      year: at(u.year, gYear), three: at(u.three, gThree),
    };
  }
  function cases(v) {
    return { low: model(shifted(v, CASES.low)), mid: model(v), high: model(shifted(v, CASES.high)) };
  }
  const copiesAt = (m, wk) => cumulative(m.firstWeek, m.v.tail, wk);

  // ── chart: eight weeks of calendar window, launch, then the curve ──
  const HKEY = "kolide.estimate.horizon";
  let horizon = 52;
  try { if (localStorage.getItem(HKEY) === "156") horizon = 156; } catch { /* private mode */ }
  let chart = null;

  const X_TICKS = {
    52: [[-8, "−8 wk"], [0, "launch"], [13, "3 mo"], [26, "6 mo"], [39, "9 mo"], [52, "1 yr"]],
    156: [[0, "launch"], [26, "6 mo"], [52, "1 yr"], [104, "2 yr"], [156, "3 yr"]],
  };

  const windowPlugin = {
    id: "calendarWindow",
    beforeDatasetsDraw(c) {
      const o = c.options.plugins.calendarWindow;
      if (!o) return;
      const { ctx, chartArea: a, scales: { x } } = c;
      const l = x.getPixelForValue(-WINDOW_WEEKS), r = Math.round(x.getPixelForValue(0)) + 0.5;
      ctx.save();
      ctx.fillStyle = o.band;
      ctx.fillRect(l, a.top, r - l, a.bottom - a.top);
      ctx.strokeStyle = o.ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r, a.top);
      ctx.lineTo(r, a.bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function drawChart(m) {
    const accent = cssVar("--accent"), muted = cssVar("--muted"), faint = cssVar("--faint");
    const v = m.mid.v;
    const weeks = Array.from({ length: horizon + 1 }, (_, i) => i);
    const curve = (mm) => weeks.map((w) => ({ x: w, y: copiesAt(mm, w) }));
    const wl = [];
    for (let w = -WINDOW_WEEKS; w <= 0; w++) wl.push({ x: w, y: v.held + v.win * (w + WINDOW_WEEKS) / WINDOW_WEEKS });
    const ticks = X_TICKS[horizon];

    const data = {
      datasets: [
        { label: "High", data: curve(m.high), borderWidth: 0, pointRadius: 0, fill: "+1", backgroundColor: withAlpha(accent, 0.18) },
        { label: "Low", data: curve(m.low), borderWidth: 0, pointRadius: 0, fill: false },
        { label: "Middle", data: curve(m.mid), borderColor: accent, borderWidth: 2, pointRadius: 0, fill: false },
        { label: "Wishlists", data: wl, borderColor: muted, borderWidth: 2, borderDash: [5, 4], pointRadius: 0, fill: false },
      ],
    };
    const options = {
      responsive: true, maintainAspectRatio: false, animation: false,
      parsing: false, normalized: true,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      layout: { padding: { top: 6, right: 4 } },
      plugins: {
        legend: { display: false },
        calendarWindow: { band: cssVar("--band"), ink: cssVar("--ink") },
        tooltip: {
          displayColors: false,
          filter: (item) => item.dataset.label === "Wishlists" || (item.dataset.label === "Middle" && item.parsed.x > 0),
          callbacks: {
            title: (items) => {
              const w = Math.round(items[0].parsed.x);
              return w < 0 ? `${-w} week${w === -1 ? "" : "s"} before launch` : w === 0 ? "Launch" : `Week ${w}`;
            },
            label: (item) => {
              if (item.dataset.label === "Wishlists") return `Wishlists: ${fmtInt(item.parsed.y)}`;
              const w = item.parsed.x;
              return `Copies: ${fmtRange(copiesAt(m.low, w), copiesAt(m.high, w))} (middle ${fmtRough(item.parsed.y)})`;
            },
          },
        },
      },
      scales: {
        x: {
          type: "linear",
          min: -WINDOW_WEEKS,
          max: horizon,
          grid: { display: false },
          border: { color: cssVar("--line") },
          afterBuildTicks: (axis) => { axis.ticks = ticks.map(([value]) => ({ value })); },
          ticks: { color: faint, maxRotation: 0, autoSkip: false, callback: (value) => (ticks.find((t) => t[0] === value) || [0, ""])[1] },
        },
        y: {
          beginAtZero: true,
          grid: { color: cssVar("--line-soft") },
          border: { display: false },
          ticks: { color: faint, maxTicksLimit: 5, callback: (value) => fmtCompact(value) },
        },
      },
    };

    if (!window.Chart) return;
    if (chart) {
      chart.data = data;
      chart.options = options;
      chart.update("none");
    } else {
      chart = new Chart($("#est-chart"), { type: "line", data, options, plugins: [windowPlugin] });
    }
    $("#est-chart").setAttribute("aria-label",
      `${fmtInt(v.held)} wishlists before the calendar window, ${fmtInt(v.held + v.win)} at launch. ` +
      `First-year copies ${fmtRange(m.low.year.units, m.high.year.units)}, middle case ${fmtRough(m.mid.year.units)}.`);
  }

  function markHorizon() {
    for (const b of $$("#horizon button")) b.setAttribute("aria-pressed", String(+b.dataset.value === horizon));
  }
  $("#horizon").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    horizon = +b.dataset.value;
    try { localStorage.setItem(HKEY, String(horizon)); } catch { /* private mode */ }
    render();
  });

  // ── render ──
  const ROWS = [["week", "First week"], ["month", "First month"], ["year", "First year"], ["three", "Three years"]];

  function render() {
    if ($("#view-estimate").hidden) return;
    const v = read();
    const m = cases(v);
    const lo = m.low, mid = m.mid, hi = m.high;
    markPricePoint(v.price);
    markHorizon();

    $("#h-units").textContent = fmtRange(lo.year.units, hi.year.units);
    $("#h-take").textContent = Money.range(lo.year.take, hi.year.take);
    $("#mid-line").textContent =
      `Middle case: about ${fmtRough(mid.year.units)} copies and ${Money.rough(mid.year.take)} take-home.`;

    $("#e-rows").innerHTML = ROWS.map(([k, label]) => `
      <tr class="${k === "three" ? "far" : ""}">
        <th scope="row">${label}</th>
        <td><b>${fmtRange(lo[k].units, hi[k].units)}</b><small>mid ${fmtRough(mid[k].units)}</small></td>
        <td class="gross"><b>${Money.range(lo[k].gross, hi[k].gross)}</b><small>mid ${Money.rough(mid[k].gross)}</small></td>
        <td><b>${Money.range(lo[k].take, hi[k].take)}</b><small>mid ${Money.rough(mid[k].take)}</small></td>
      </tr>`).join("");

    // where the first year's money goes, middle case
    const y = mid.year, g = y.gross || 1;
    const pCut = y.cut / g * 100, pTax = y.withheld / g * 100, pTake = y.take / g * 100;
    const pct = (p) => Math.round(p) + "%";
    $("#seg-cut").style.flex = `0 0 ${pCut}%`;
    $("#seg-tax").style.flex = `0 0 ${pTax}%`;
    $("#seg-take").style.flex = `0 0 ${pTake}%`;
    $("#l-cut").textContent = `Steam ${pct(pCut)}`;
    $("#l-tax").textContent = `Withheld ${pct(pTax)}`;
    $("#l-take").textContent = `You ${pct(pTake)}`;
    $("#split").setAttribute("aria-label",
      `Of gross revenue, Steam takes ${pct(pCut)}, withholding ${pct(pTax)}, you keep ${pct(pTake)}.`);

    const paid = y.paidUnits;
    $("#o-wl").textContent = fmtInt(v.held + v.win);
    $("#o-eff").textContent = paid > 0 ? Money.exact(y.gross / paid, 2) : "—";
    $("#o-per").textContent = paid > 0 ? Money.exact(y.take / paid, 2) : "—";

    $("#t-units").textContent = fmtRange(lo.year.units, hi.year.units);
    $("#t-take").textContent = Money.range(lo.year.take, hi.year.take);
    // A short live region: dragging a slider announces the headline, not every cell.
    $("#live").textContent = `First year: ${fmtRange(lo.year.units, hi.year.units)} copies, ` +
      `${Money.range(lo.year.take, hi.year.take)} take-home.`;

    drawChart(m);
    save();
  }

  // ── state in the URL hash + localStorage ──
  // v3 stores the two wishlist piles and their rates. v2 stored one wishlist
  // count with a late share; v1 stored the wishlist slider position. Both are
  // still read. The currency slots are kept for format stability but ignored:
  // the viewer's own currency setting wins. The US share came later, so it
  // sits after them.
  const KEY = "kolide.steam-estimator";
  const ORDER = ["price", "held", "win", "conv", "winconv", "organic", "tail", "reg", "ref"];
  const serialize = () => ["v3", ...ORDER.map(get), taxSel.value, Money.code, Money.rate(), get("us")].join(",");
  const numOrNull = (s) => { const x = parseFloat(s); return Number.isFinite(x) ? x : null; };

  function applyLegacy(p, v1) {
    // [price, wl, conv, organic, tail, reg, ref, tax, cur, rate, late]
    if (p.length < 8) return false;
    let wl = numOrNull(p[1]);
    if (wl !== null && v1 && wl <= 1000) wl = WL_MIN * Math.pow(10, (wl / 1000) * WL_SPAN);
    const late = (numOrNull(p[10]) || 0) / 100;
    const conv = numOrNull(p[2]);
    const set = (k, x) => { if (x !== null) setValue(k, x); };
    set("price", numOrNull(p[0]));
    if (wl !== null) { setValue("held", wl * (1 - late)); setValue("win", wl * late); }
    if (conv !== null) { setValue("conv", conv); setValue("winconv", conv / 2); }
    set("organic", numOrNull(p[3]));
    set("tail", numOrNull(p[4]));
    set("reg", numOrNull(p[5]));
    set("ref", numOrNull(p[6]));
    if (numOrNull(p[7]) !== null) taxSel.value = p[7];
    return true;
  }
  function apply(str) {
    const p = String(str).split(",");
    if (p[0] === "v2") return applyLegacy(p.slice(1), false);
    if (p[0] !== "v3") return applyLegacy(p, true);
    p.shift();
    ORDER.forEach((k, i) => { if (numOrNull(p[i]) !== null) setValue(k, numOrNull(p[i])); });
    if (numOrNull(p[9]) !== null) taxSel.value = p[9];
    if (numOrNull(p[12]) !== null) setValue("us", numOrNull(p[12]));
    return true;
  }
  function save() {
    try { localStorage.setItem(KEY, serialize()); } catch { /* private mode */ }
  }

  // ── presets and price points ──
  function setPreset(name) {
    const p = PRESETS[name] || PRESETS.indie;
    for (const k of KEYS) if (k in p) setValue(k, p[k]);
    markPreset(name);
    render();
  }
  function markPreset(name) {
    for (const c of $$("#view-estimate .chip")) c.setAttribute("aria-pressed", String(c.dataset.preset === name));
  }
  function markPricePoint(price) {
    for (const b of $$(".pt")) b.setAttribute("aria-pressed", String(Math.abs(parseFloat(b.dataset.price) - price) < 0.005));
  }
  for (const b of $$(".pt")) {
    b.addEventListener("click", () => { setValue("price", parseFloat(b.dataset.price)); markPreset(null); render(); });
  }
  for (const c of $$("#view-estimate .chip")) c.addEventListener("click", () => setPreset(c.dataset.preset));

  taxSel.addEventListener("change", render);
  // Enter in a number field settles it rather than submitting the form.
  $("#controls").addEventListener("submit", (e) => e.preventDefault());

  $("#btn-copy").addEventListener("click", (e) => {
    const v = read(), m = cases(v);
    const line = ([k, label]) =>
      `${label}: ${fmtRange(m.low[k].units, m.high[k].units)} copies, ` +
      `${Money.range(m.low[k].take, m.high[k].take)} take-home ` +
      `(middle case ${fmtRough(m.mid[k].units)} copies, ${Money.rough(m.mid[k].take)})`;
    const lines = [
      "Steam sales estimate",
      `$${v.price.toFixed(2)} · ${fmtInt(v.held)} wishlists + ${fmtInt(v.win)} gained in the calendar window · ` +
        `week-one conversion ${fmtPct(v.conv)} / ${fmtPct(v.winconv)} · ${v.organic.toFixed(1)}× beyond wishlists · ` +
        `${v.tail.toFixed(1)}× year one`,
      "",
      ...ROWS.map(line),
      "",
      `Take-home in ${Money.code} after refunds, Steam's cut and ${fmtPct(v.tax, 0)} withholding on the ${fmtPct(v.us, 0)} of sales from the US. ` +
        "Ranges, not predictions: results can land outside them.",
      `Steam Launch Planner ${$("#ver").textContent}`,
    ];
    toClipboard(lines.join("\n"), e.currentTarget, "Copied");
  });

  $("#btn-link").addEventListener("click", (e) => {
    const s = serialize();
    try { history.replaceState(null, "", "#" + s); } catch { /* sandboxed */ }
    toClipboard(location.href.split("#")[0] + "#" + s, e.currentTarget, "Link copied");
  });

  $("#btn-reset").addEventListener("click", () => {
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
    taxSel.value = "30";
    setValue("us", US_DEFAULT);
    setPreset("indie");
  });

  Money.onChange(render);
  onThemeChange(() => { if (chart) { chart.destroy(); chart = null; } render(); });

  // ── boot: URL hash wins, then saved state, then the default preset ──
  for (const k of KEYS) setValue(k, parseFloat(FIELDS[k].num.value));
  let booted = false, preset = null;
  const hash = decodeURIComponent(location.hash.slice(1));
  if (hash && hash !== "track" && hash !== "pay" && !hash.startsWith("pay,")) booted = apply(hash);
  if (!booted) {
    try { const stored = localStorage.getItem(KEY); if (stored) booted = apply(stored); } catch { /* private mode */ }
  }
  if (!booted) { for (const k of KEYS) if (k in PRESETS.indie) setValue(k, PRESETS.indie[k]); preset = "indie"; }
  markPreset(preset);

  Views.estimate = {
    show() {
      render();
      if (chart) chart.resize();
    },
  };
})();
