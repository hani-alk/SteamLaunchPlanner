/* Pay yourself: back pay for the months worked unpaid and a salary from now
   on, drawn from the cash already in hand. Standalone: it doesn't read
   wishlists, sales or forecasts from the other views. */
(() => {
  "use strict";

  // Starting amounts in USD, converted into the display currency on first use.
  const DEFAULTS_USD = { cash: 50000, backPer: 1100, salary: 2000, costs: 300 };
  const DEFAULTS = { worked: 18, spread: 6, ahead: 24 };

  // Amounts are kept in the currency they were typed in, so a rate update never
  // nudges them. Switching currency converts them at the current rate.
  const FIELDS = {
    cash:    { min: 0, max: 1e12, money: true },
    worked:  { min: 0, max: 120 },
    backPer: { min: 0, max: 1e10, money: true },
    spread:  { min: 1, max: 60 },
    salary:  { min: 0, max: 1e10, money: true },
    costs:   { min: 0, max: 1e10, money: true },
    ahead:   { min: 1, max: 120 },
  };
  const KEYS = Object.keys(FIELDS);
  const MONEY_KEYS = KEYS.filter((k) => FIELDS[k].money);
  for (const k of KEYS) FIELDS[k].num = $("#p-" + k);

  // Last valid value per field, plus the currency and rate they're in.
  const state = { code: Money.code, rate: Money.rate() };

  const setValue = (k, x, { keepText = false } = {}) => {
    x = Math.round(clamp(x, FIELDS[k].min, FIELDS[k].max));
    state[k] = x;
    if (!keepText) FIELDS[k].num.value = String(x);
  };
  function setDefaults() {
    state.code = Money.code;
    state.rate = Money.rate();
    for (const k of MONEY_KEYS) setValue(k, roundSig(DEFAULTS_USD[k] * state.rate));
    for (const [k, x] of Object.entries(DEFAULTS)) setValue(k, x);
  }

  // Follow the page's currency: convert on a switch, just note the rate otherwise.
  function syncCurrency() {
    if (state.code !== Money.code) {
      const factor = Money.rate() / state.rate;
      for (const k of MONEY_KEYS) setValue(k, state[k] * factor);
      state.code = Money.code;
    }
    state.rate = Money.rate();
    for (const el of $$("#view-pay .cur")) el.textContent = Money.code;
  }

  for (const k of KEYS) {
    const input = FIELDS[k].num;
    input.addEventListener("input", () => {
      const x = parseFloat(input.value);
      if (!Number.isFinite(x)) return;
      setValue(k, x, { keepText: true });
      render();
    });
    // On blur, settle whatever was typed into a clean, in-range number.
    input.addEventListener("change", () => {
      const x = parseFloat(input.value);
      setValue(k, Number.isFinite(x) ? x : state[k]);
      render();
    });
  }
  $("#pay-controls").addEventListener("submit", (e) => e.preventDefault());

  // ── months: month 0 is this calendar month ──
  const today = new Date();
  const monthAt = (offset) => new Date(Date.UTC(today.getFullYear(), today.getMonth() + offset, 1));
  const shortMonth = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const longMonth = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const fmtShortMonth = (offset) => shortMonth.format(monthAt(offset));
  const fmtLongMonth = (offset) => longMonth.format(monthAt(offset));
  const plural = (n, word) => `${fmtInt(n)} ${word}${n === 1 ? "" : "s"}`;

  // ── model ──
  function plan() {
    const s = state;
    const owed = s.worked * s.backPer;
    const installment = owed / s.spread;
    const monthly = s.salary + s.costs;
    const months = [];
    let left = s.cash, runsOut = null;
    for (let i = 0; i < s.ahead; i++) {
      const backPay = i < s.spread ? installment : 0;
      left -= monthly + backPay;
      months.push({ i, salary: s.salary, backPay, costs: s.costs, left });
      if (left < 0 && runsOut === null) runsOut = i;
    }
    const covered = monthly > 0 ? Math.max(0, s.cash - owed) / monthly : Infinity;
    return { owed, installment, monthly, months, runsOut, covered, left };
  }

  function headline(p) {
    const owed = p.owed > 0 ? `You're owed ${Money.local(p.owed)} in back pay.` : "No back pay is owed.";
    if (p.runsOut !== null) return { owed, rest: `Your cash runs out in ${fmtShortMonth(p.runsOut)}.`, short: true };
    const enough = Number.isFinite(p.covered)
      ? `, enough for about ${plural(Math.floor(p.covered), "month")} of salary and costs in total`
      : "";
    return { owed, rest: `After ${plural(state.ahead, "month")} you still have ${Money.local(p.left)}${enough}.`, short: false };
  }

  // ── chart: unpaid months to the left of now, what goes out each month to the right ──
  let chart = null;

  // Both axes share zero and gridlines: pick how many of the steps sit above
  // zero, then give each axis the smallest round step that fits.
  function niceStep(x) {
    const e = Math.pow(10, Math.floor(Math.log10(x)));
    return [1, 2, 2.5, 5, 10].map((m) => m * e).find((v) => v >= x);
  }
  function alignedAxes(ranges, steps = 6) {
    let best = null;
    for (let k = 1; k < steps; k++) {
      const fit = ranges.map(({ lo, hi }) => niceStep(Math.max(hi / k, -lo / (steps - k)) || 1));
      const waste = sum(fit.map((step, i) => 1 - (ranges[i].hi - ranges[i].lo) / (steps * step)));
      if (!best || waste < best.waste) best = { k, fit, waste };
    }
    return best.fit.map((step) => ({ min: -(steps - best.k) * step, max: best.k * step, stepSize: step }));
  }

  const nowPlugin = {
    id: "payNow",
    afterDatasetsDraw(c) {
      const o = c.options.plugins.payNow;
      if (!o) return;
      const { ctx, chartArea: area, scales: { x } } = c;
      const step = c.data.labels.length > 1 ? x.getPixelForValue(1) - x.getPixelForValue(0) : area.right - area.left;
      const px = Math.round(x.getPixelForValue(o.index) - step / 2) + 0.5;
      ctx.save();
      ctx.strokeStyle = o.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(px, area.top);
      ctx.lineTo(px, area.bottom);
      ctx.stroke();
      // The label sits on a backing, right of the line when there's room.
      ctx.font = '12px "Archivo", sans-serif';
      const text = "Now", w = ctx.measureText(text).width;
      const lx = px + 5 + w <= area.right ? px + 5 : px - 5 - w;
      ctx.fillStyle = o.labelBg;
      ctx.fillRect(lx - 3, area.top + 3, w + 6, 15);
      ctx.fillStyle = o.color;
      ctx.fillText(text, lx, area.top + 14);
      ctx.restore();
    },
  };

  function drawChart(p) {
    if (!window.Chart) return;
    const s = state;
    const ink = cssVar("--ink"), accent = cssVar("--accent"), faint = cssVar("--faint");
    const offsets = Array.from({ length: s.worked + s.ahead }, (_, i) => i - s.worked);
    const future = (fn) => offsets.map((o) => (o >= 0 ? fn(p.months[o]) : null));
    const outflow = (v) => (v > 0 ? -v : null);

    const axes = alignedAxes([
      { lo: -(p.monthly + p.installment), hi: s.worked > 0 ? s.backPer : 0 },
      { lo: Math.min(0, ...p.months.map((m) => m.left)), hi: Math.max(0, s.cash) },
    ]);
    const below = (ctx) => ctx.p0.parsed.y < 0 || ctx.p1.parsed.y < 0;

    const data = {
      labels: offsets.map(fmtShortMonth),
      datasets: [
        { label: "Unpaid work", data: offsets.map((o) => (o < 0 ? s.backPer : null)), order: 1,
          backgroundColor: withAlpha(accent, 0.22), borderColor: accent, borderWidth: 1 },
        { label: "Salary", data: future((m) => outflow(m.salary)), backgroundColor: cssVar("--bar-cut"), order: 1 },
        { label: "Back pay", data: future((m) => outflow(m.backPay)), backgroundColor: accent, order: 1 },
        { label: "Other costs", data: future((m) => outflow(m.costs)), backgroundColor: cssVar("--bar-tax"), order: 1 },
        { label: "Cash left", type: "line", yAxisID: "y1", data: future((m) => m.left), order: 0,
          borderColor: ink, borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 3, fill: false,
          pointBackgroundColor: (ctx) => (ctx.raw < 0 ? accent : ink),
          segment: { borderColor: (ctx) => (below(ctx) ? accent : ink) } },
      ],
    };
    const options = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      layout: { padding: { top: 6 } },
      plugins: {
        legend: { display: false },
        payNow: { index: s.worked, color: ink, labelBg: withAlpha(cssVar("--surface"), 0.85) },
        tooltip: {
          filter: (item) => item.raw != null,
          callbacks: {
            title: (items) => (items.length ? fmtLongMonth(offsets[items[0].dataIndex]) : ""),
            // Outgoings are drawn below zero but read as amounts; only cash left keeps its sign.
            label: (item) => `${item.dataset.label}: ${Money.local(item.dataset.label === "Cash left" ? item.raw : Math.abs(item.raw))}`,
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, border: { color: cssVar("--line") },
             ticks: { color: faint, maxTicksLimit: 8, maxRotation: 0 } },
        y: { stacked: true, ...axes[0], border: { display: false },
             grid: { color: (ctx) => (ctx.tick.value === 0 ? cssVar("--line") : cssVar("--line-soft")) },
             ticks: { color: faint, callback: (v) => Money.localCompact(v) } },
        y1: { position: "right", ...axes[1], grid: { display: false }, border: { display: false },
              ticks: { color: faint, callback: (v) => Money.localCompact(v) } },
      },
      datasets: { bar: { barPercentage: 0.9, categoryPercentage: 0.9, borderRadius: 0 } },
    };

    if (chart) {
      chart.data = data;
      chart.options = options;
      chart.update("none");
    } else {
      chart = new Chart($("#pay-chart"), { type: "bar", data, options, plugins: [nowPlugin] });
    }
    const h = headline(p);
    $("#pay-chart").setAttribute("aria-label",
      `${plural(s.worked, "month")} worked unpaid, then ${plural(s.ahead, "month")} of salary, back pay and costs. ${h.owed} ${h.rest}`);
  }

  // ── render ──
  function render() {
    if ($("#view-pay").hidden) return;
    const p = plan();
    const h = headline(p);

    $("#pay-owed").textContent = h.owed;
    $("#pay-rest").textContent = h.rest;
    $("#pay-rest").classList.toggle("short", h.short);
    $("#pay-live").textContent = `${h.owed} ${h.rest}`;
    $("#pay-tick").textContent = h.short ? `Runs out ${fmtShortMonth(p.runsOut)}` : `${Money.local(p.left)} left`;
    $("#pay-tick").classList.toggle("short", h.short);

    $("#pk-owed").textContent = Money.local(p.owed);
    $("#pk-inst").textContent = p.owed > 0 ? `${Money.local(p.installment)} × ${state.spread}` : "—";
    $("#pk-monthly").textContent = Money.local(p.monthly);

    for (const el of $$("#view-pay .th-cur")) el.textContent = `(${Money.code})`;
    const cell = (v) => (v > 0 ? `<span class="big">${Money.local(v)}</span>` : `<span class="big nil">—</span>`);
    $("#pay-rows").innerHTML = p.months.map((m) => {
      const notes = [m.i === 0 ? "This month" : `Month ${m.i + 1}`];
      if (m.i === p.runsOut) notes.push("cash runs out");
      return `<tr${m.left < 0 ? ` class="short"` : ""}>
        <td><strong>${fmtLongMonth(m.i)}</strong><br><span class="small">${notes.join(" · ")}</span></td>
        <td>${cell(m.salary)}</td>
        <td>${cell(m.backPay)}</td>
        <td>${cell(m.costs)}</td>
        <td><span class="big left">${Money.local(m.left)}</span></td>
      </tr>`;
    }).join("");

    drawChart(p);
    save();
  }

  // ── state in the URL hash + localStorage ──
  // Amounts travel with their currency and rate, so a link opened in another
  // currency converts them rather than reading euros as dollars.
  const KEY = "pay-yourself";
  const serialize = () => ["pay", "v1", ...KEYS.map((k) => state[k]), state.code, state.rate].join(",");
  function apply(str) {
    const p = String(str).split(",");
    if (p[0] !== "pay" || p[1] !== "v1") return false;
    const vals = p.slice(2);
    const code = vals[KEYS.length], rate = parseFloat(vals[KEYS.length + 1]);
    // Same currency: take the amounts as typed, whatever the rate has done since.
    const convert = code !== Money.code && CURRENCIES.some((c) => c.code === code) && rate > 0;
    KEYS.forEach((k, i) => {
      const x = parseFloat(vals[i]);
      if (!Number.isFinite(x)) return;
      setValue(k, FIELDS[k].money && convert ? x * Money.rate() / rate : x);
    });
    return true;
  }
  function save() {
    try { localStorage.setItem(KEY, serialize()); } catch { /* private mode */ }
  }

  $("#pay-copy").addEventListener("click", (e) => {
    const p = plan(), h = headline(p), s = state;
    const lines = [
      "Pay yourself",
      `${Money.local(s.cash)} cash on hand · ${plural(s.worked, "month")} unpaid at ${Money.local(s.backPer)} · ` +
        `back pay over ${plural(s.spread, "month")} · ${Money.local(s.salary)} salary and ${Money.local(s.costs)} other costs a month`,
      "",
      `${h.owed} ${h.rest}`,
      "",
      "A cash plan, not tax or financial advice.",
      `Steam Launch Planner ${$("#ver").textContent}`,
    ];
    toClipboard(lines.join("\n"), e.currentTarget, "Copied");
  });

  $("#pay-link").addEventListener("click", (e) => {
    const s = serialize();
    try { history.replaceState(null, "", "#" + s); } catch { /* sandboxed */ }
    toClipboard(location.href.split("#")[0] + "#" + s, e.currentTarget, "Link copied");
  });

  $("#pay-reset").addEventListener("click", () => {
    try { localStorage.removeItem(KEY); } catch { /* private mode */ }
    setDefaults();
    render();
  });

  Money.onChange(() => { syncCurrency(); save(); render(); });
  onThemeChange(() => { if (chart) { chart.destroy(); chart = null; } render(); });

  // ── boot: URL hash wins, then saved state, then the defaults ──
  setDefaults();
  const hash = decodeURIComponent(location.hash.slice(1));
  if (!(hash.startsWith("pay,") && apply(hash))) {
    try { const stored = localStorage.getItem(KEY); if (stored) apply(stored); } catch { /* private mode */ }
  }
  syncCurrency();

  Views.pay = {
    show() {
      render();
      if (chart) chart.resize();
    },
  };
})();
