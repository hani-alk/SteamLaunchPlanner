/* Pay yourself: back pay for the months worked unpaid, shares of what's left
   paid out after it, and a salary from now on, drawn from the cash already in
   hand after setting shares of it aside.
   Cash on hand can start from the payout logged in After launch; nothing else
   is read from the other views. */
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

  // Last valid value per field, plus the currency and rate they're in, where
  // cash on hand comes from ("" when typed), the savings rows and the shares
  // paid out after back pay.
  const state = { code: Money.code, rate: Money.rate(), source: "", savings: [], shares: [] };
  const MAX_ROWS = 12;
  const cleanRow = (label, pct) => ({
    label: String(label ?? "").slice(0, 40),
    pct: Math.round(clamp(num(pct), 0, 100) * 10) / 10,
  });

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
    state.source = "";
    state.savings = [];
    state.shares = [];
    renderSavings();
    renderShares();
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

  // ── starting from the payout logged in After launch ──
  // Worked out when the view opens rather than on every keystroke.
  const sourceSel = $("#p-source");
  const ALL = "all";
  let payouts = [];
  function refreshPayouts() {
    payouts = Views.track && Views.track.payouts ? Views.track.payouts() : [];
  }
  function sourcePayout() {
    if (!state.source) return null;
    const games = state.source === ALL ? payouts : payouts.filter((g) => g.id === state.source);
    return games.length ? { usd: sum(games.map((g) => g.payoutUsd)), games } : null;
  }
  function paintSource() {
    // A game that's been deleted, or has nothing logged any more, falls back to typing.
    if (state.source && !sourcePayout()) state.source = "";
    const opt = (value, text) => `<option value="${escapeHtml(value)}">${escapeHtml(text)}</option>`;
    const games = payouts.map((g) => opt(g.id, `Payout from ${g.name} · ${Money.local(g.payoutUsd * Money.rate())}`));
    if (payouts.length > 1) games.push(opt(ALL, `Payout from all games · ${Money.local(sum(payouts.map((g) => g.payoutUsd)) * Money.rate())}`));
    sourceSel.innerHTML = opt("", "An amount I type") +
      (games.length ? games.join("") : "<option disabled>No sales logged in After launch yet</option>");
    sourceSel.value = state.source;

    const linked = sourcePayout();
    FIELDS.cash.num.readOnly = !!linked;
    FIELDS.cash.num.closest(".num").classList.toggle("linked", !!linked);
    if (linked) {
      setValue("cash", linked.usd * Money.rate());
      const names = linked.games.length > 1 ? `${linked.games.length} games` : linked.games[0].name;
      $("#p-cash-tip").textContent = `Your payout on the days logged for ${names}, after Steam's cut and US withholding. Set tax aside below.`;
    } else {
      $("#p-cash-tip").textContent = "After setting money aside for tax, or set tax aside below.";
    }
  }
  sourceSel.addEventListener("change", () => {
    state.source = sourceSel.value;
    render();
  });

  // ── rows of a label and a percentage: savings take a share of cash on hand,
  // shares take one of what's left after back pay ──
  // The first row suggests a label; later ones start blank.
  function rowList(key, box, add, noun, first) {
    function paint() {
      box.innerHTML = state[key].map((r, i) => `
        <div class="saving">
          <input class="saving-name" type="text" maxlength="40" value="${escapeHtml(r.label)}" placeholder="Label" data-row="${i}" data-field="label" aria-label="${noun} ${i + 1} label" />
          <div class="num"><input type="number" min="0" max="100" step="0.5" inputmode="decimal" value="${r.pct}" data-row="${i}" data-field="pct" aria-label="${noun} ${i + 1} percentage" /><span class="suf">%</span></div>
          <button class="btn-quiet" type="button" data-del-row="${i}" aria-label="Remove ${noun.toLowerCase()} ${i + 1}">Remove</button>
          <div class="tip" data-amount="${i}"></div>
        </div>`).join("");
      add.hidden = state[key].length >= MAX_ROWS;
    }
    box.addEventListener("input", (e) => {
      const el = e.target;
      if (el.dataset.row == null) return;
      const r = state[key][+el.dataset.row];
      if (el.dataset.field === "label") r.label = el.value.slice(0, 40);
      else if (Number.isFinite(parseFloat(el.value))) r.pct = cleanRow("", el.value).pct;
      render();
    });
    // On blur, a percentage settles into its clean, in-range value.
    box.addEventListener("change", (e) => {
      const el = e.target;
      if (el.dataset.row != null && el.dataset.field === "pct") el.value = state[key][+el.dataset.row].pct;
    });
    box.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del-row]");
      if (!del) return;
      state[key].splice(+del.dataset.delRow, 1);
      paint();
      render();
      add.focus();
    });
    add.addEventListener("click", () => {
      if (state[key].length >= MAX_ROWS) return;
      state[key].push(state[key].length ? cleanRow("", 10) : cleanRow(...first));
      paint();
      render();
      const names = box.querySelectorAll(".saving-name");
      names[names.length - 1].focus();
    });
    return paint;
  }
  const renderSavings = rowList("savings", $("#p-savings"), $("#p-add-saving"), "Savings", ["Tax", 25]);
  const renderShares = rowList("shares", $("#p-shares"), $("#p-add-share"), "Share", ["Reinvest", 20]);

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
    const asideShare = sum(s.savings.map((sv) => sv.pct)) / 100;
    const aside = s.savings.map((sv) => ({ ...sv, amount: s.cash * sv.pct / 100 }));
    const pool = s.cash * Math.max(0, 1 - asideShare);
    const owed = s.worked * s.backPer;
    const installment = owed / s.spread;
    // Shares come out of the cash actually left once the last back pay payment,
    // and that month's salary and costs, are paid.
    const sharesShare = sum(s.shares.map((r) => r.pct)) / 100;
    const shareMonth = owed > 0 ? s.spread - 1 : 0;
    const monthly = s.salary + s.costs;
    const afterBack = Math.max(0, pool - owed - monthly * (shareMonth + 1));
    const out = afterBack * Math.min(1, sharesShare);
    const months = [];
    let left = pool, runsOut = null;
    for (let i = 0; i < s.ahead; i++) {
      const backPay = i < s.spread ? installment : 0;
      const share = i === shareMonth ? out : 0;
      left -= monthly + backPay + share;
      months.push({ i, salary: s.salary, backPay, share, costs: s.costs, left });
      if (left < 0 && runsOut === null) runsOut = i;
    }
    const shares = s.shares.map((r) => ({ ...r, amount: afterBack * r.pct / 100 }));
    const covered = monthly > 0 ? Math.max(0, pool - owed - out) / monthly : Infinity;
    return { aside, asideShare, pool, owed, installment, afterBack, shares, sharesShare, out, shareMonth,
      monthly, months, runsOut, covered, left };
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
      { lo: -Math.max(0, ...p.months.map((m) => m.salary + m.costs + m.backPay + m.share)), hi: s.worked > 0 ? s.backPer : 0 },
      { lo: Math.min(0, ...p.months.map((m) => m.left)), hi: Math.max(0, p.pool) },
    ]);
    const below = (ctx) => ctx.p0.parsed.y < 0 || ctx.p1.parsed.y < 0;

    const data = {
      labels: offsets.map(fmtShortMonth),
      datasets: [
        { label: "Unpaid work", data: offsets.map((o) => (o < 0 ? s.backPer : null)), order: 1,
          backgroundColor: withAlpha(accent, 0.22), borderColor: accent, borderWidth: 1 },
        { label: "Salary", data: future((m) => outflow(m.salary)), backgroundColor: cssVar("--bar-cut"), order: 1 },
        { label: "Back pay", data: future((m) => outflow(m.backPay)), backgroundColor: accent, order: 1 },
        { label: "After back pay", data: future((m) => outflow(m.share)), backgroundColor: withAlpha(accent, 0.5), order: 1 },
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
      `${plural(s.worked, "month")} worked unpaid, then ${plural(s.ahead, "month")} of salary, back pay and costs. ${h.owed} ${sharesLine(p)} ${h.rest}`);
  }

  // ── render ──
  // " for Tax, Rainy day and Next game", from the rows' labels.
  function forNames(rows) {
    const names = rows.map((r) => r.label.trim()).filter(Boolean);
    return !names.length ? ""
      : names.length === 1 ? ` for ${names[0]}`
      : ` for ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  }

  // What the savings rows take out, in a sentence.
  function asideLine(p) {
    if (!p.aside.length) return "";
    if (p.asideShare > 1) return `Savings add up to ${fmtPct(p.asideShare)} of cash on hand, so nothing is left for the plan.`;
    return `${Money.local(sum(p.aside.map((a) => a.amount)))} (${fmtPct(p.asideShare)}) is set aside${forNames(p.aside)}, ` +
      `so the plan starts from ${Money.local(p.pool)}.`;
  }

  // What the shares after back pay pay out, and when.
  function sharesLine(p) {
    if (!p.shares.length) return "";
    const when = `in ${fmtShortMonth(p.shareMonth)}`;
    if (p.sharesShare > 1) return `Shares after back pay add up to ${fmtPct(p.sharesShare)}, so all ` +
      `${Money.local(p.afterBack)} left after back pay goes out ${when} and nothing is left for salary or costs.`;
    return `${Money.local(p.out)} (${fmtPct(p.sharesShare)} of the ${Money.local(p.afterBack)} left after back pay) ` +
      `goes out${forNames(p.shares)} ${when}.`;
  }

  function render() {
    if ($("#view-pay").hidden) return;
    paintSource();
    const p = plan();
    const h = headline(p);

    const aside = asideLine(p);
    $("#pay-aside").hidden = !aside;
    $("#pay-aside").textContent = aside;
    $("#pay-aside").classList.toggle("short", p.asideShare > 1);
    for (const el of $$("#p-savings [data-amount]")) {
      const a = p.aside[+el.dataset.amount];
      el.textContent = a ? `${Money.local(a.amount)} of ${Money.local(state.cash)}` : "";
    }

    const shares = sharesLine(p);
    $("#pay-shares").hidden = !shares;
    $("#pay-shares").textContent = shares;
    $("#pay-shares").classList.toggle("short", p.sharesShare > 1);
    for (const el of $$("#p-shares [data-amount]")) {
      const a = p.shares[+el.dataset.amount];
      el.textContent = a ? `${Money.local(a.amount)} of ${Money.local(p.afterBack)} left after back pay` : "";
    }

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
        <td>${cell(m.share)}</td>
        <td>${cell(m.costs)}</td>
        <td><span class="big left">${Money.local(m.left)}</span></td>
      </tr>`;
    }).join("");

    drawChart(p);
    save();
  }

  // ── state in the URL hash + localStorage ──
  // Amounts travel with their currency and rate, so a link opened in another
  // currency converts them rather than reading euros as dollars. v2 adds the
  // savings rows as label, percentage pairs, labels URI-encoded so commas are
  // safe. v3 puts the number of savings rows first, then the shares after back
  // pay follow them. Where cash came from stays in this browser: a link carries
  // the amount.
  const KEY = "pay-yourself";
  const SOURCE_KEY = "pay-yourself.source";
  const pairs = (rows) => rows.flatMap((r) => [encodeURIComponent(r.label), r.pct]);
  const serialize = () => ["pay", "v3", ...KEYS.map((k) => state[k]), state.code, state.rate,
    state.savings.length, ...pairs(state.savings), ...pairs(state.shares)].join(",");
  function readPairs(vals) {
    const rows = [];
    for (let i = 0; i + 1 < vals.length && rows.length < MAX_ROWS; i += 2) {
      let label = "";
      try { label = decodeURIComponent(vals[i]); } catch { /* malformed: leave it blank */ }
      rows.push(cleanRow(label, vals[i + 1]));
    }
    return rows;
  }
  function apply(str) {
    const p = String(str).split(",");
    if (p[0] !== "pay" || !["v1", "v2", "v3"].includes(p[1])) return false;
    const vals = p.slice(2);
    const code = vals[KEYS.length], rate = parseFloat(vals[KEYS.length + 1]);
    // Same currency: take the amounts as typed, whatever the rate has done since.
    const convert = code !== Money.code && CURRENCIES.some((c) => c.code === code) && rate > 0;
    KEYS.forEach((k, i) => {
      const x = parseFloat(vals[i]);
      if (!Number.isFinite(x)) return;
      setValue(k, FIELDS[k].money && convert ? x * Money.rate() / rate : x);
    });
    let rows = vals.slice(KEYS.length + 2), nSavings = Infinity;
    if (p[1] === "v3") {
      nSavings = clamp(Math.floor(num(rows[0])), 0, MAX_ROWS);
      rows = rows.slice(1);
    }
    state.savings = readPairs(rows.slice(0, nSavings * 2));
    state.shares = readPairs(rows.slice(nSavings * 2));
    renderSavings();
    renderShares();
    return true;
  }
  function save() {
    try {
      localStorage.setItem(KEY, serialize());
      localStorage.setItem(SOURCE_KEY, state.source);
    } catch { /* private mode */ }
  }

  $("#pay-copy").addEventListener("click", (e) => {
    const p = plan(), h = headline(p), s = state;
    const lines = [
      "Pay yourself",
      `${Money.local(s.cash)} cash on hand${sourcePayout() ? " from logged Steam payout" : ""} · ` +
        `${plural(s.worked, "month")} unpaid at ${Money.local(s.backPer)} · ` +
        `back pay over ${plural(s.spread, "month")} · ${Money.local(s.salary)} salary and ${Money.local(s.costs)} other costs a month`,
      ...p.aside.map((a) => `Set aside for ${a.label.trim() || "savings"}: ${fmtPct(a.pct / 100)}, ${Money.local(a.amount)}`),
      ...p.shares.map((a) => `After back pay, for ${a.label.trim() || "a share"}: ${fmtPct(a.pct / 100)}, ${Money.local(a.amount)}`),
      "",
      ...(p.aside.length ? [asideLine(p)] : []),
      ...(p.shares.length ? [sharesLine(p)] : []),
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
  // The hash is split before it's decoded, so an encoded comma stays inside its
  // label. A link some app encoded as a whole is unwrapped once first.
  setDefaults();
  const raw = location.hash.slice(1);
  const hash = /^pay%2C/i.test(raw) ? decodeURIComponent(raw) : raw;
  if (!(hash.startsWith("pay,") && apply(hash))) {
    try {
      const stored = localStorage.getItem(KEY);
      if (stored) apply(stored);
      state.source = localStorage.getItem(SOURCE_KEY) || "";
    } catch { /* private mode */ }
  }
  syncCurrency();

  Views.pay = {
    show() {
      refreshPayouts();
      render();
      if (chart) chart.resize();
    },
  };
})();
