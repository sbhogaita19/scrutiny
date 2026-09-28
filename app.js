/* Scrutiny — balanced politics news for AQA A-level Politics (7152) */
(() => {
  "use strict";

  // ------------------------------------------------------------------ state & storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem("scrutiny." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("scrutiny." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const S = {
    tax: null, news: null, brief: null, byId: new Map(),
    route: "today",
    topic: store.get("topic", {}),          // per-section selected topic
    nation: "all",
    latestRegion: "all",
    compare: store.get("compare", "executives"),
    saved: store.get("saved", {}),          // id -> item snapshot
    prefs: store.get("prefs", {}),          // { ideology, theme }
    show: {},                               // pagination per list
    installEvt: null,
    lastLoad: 0,
  };

  const OPTIONAL_IDEOLOGIES = ["nationalism", "feminism", "multiculturalism", "anarchism", "ecologism"];
  const SECTION_COLOUR = { today: "var(--accent)", ukgov: "var(--ukgov)", ukpol: "var(--ukpol)", us: "var(--us)", ideas: "var(--ideas)", compare: "var(--compare)" };
  const LEAN = {
    "left": { pos: 5, label: "Left-leaning" },
    "centre-left": { pos: 27, label: "Centre-left" },
    "centre": { pos: 50, label: "Centre" },
    "centre-right": { pos: 73, label: "Centre-right" },
    "right": { pos: 95, label: "Right-leaning" },
    "non-partisan": { pos: null, label: "Non-partisan" },
  };
  const TYPE = {
    news: { label: "News", badge: null, note: null },
    commentary: { label: "Opinion & commentary", badge: "Opinion", cls: "opinion", note: "This is an <b>opinion piece</b>: it argues a case. Great for finding arguments, but check the facts against a news or non-partisan source." },
    analysis: { label: "Analysis", badge: "Analysis", note: "<b>Expert analysis</b> from a non-partisan organisation. Useful for evidence and context in essays." },
    academic: { label: "Academic", badge: "Academic", note: "Written by <b>academics</b>. Strong for evaluation and scholarly views you can cite." },
    official: { label: "Parliament research", badge: "Parliament", note: "Impartial research from <b>Parliament's own library</b>. Excellent, reliable evidence." },
    factcheck: { label: "Fact check", badge: "Fact check", cls: "factcheck", note: "A <b>fact check</b> from an independent fact-checking charity." },
  };
  const NATION = { scotland: "Scotland", wales: "Wales", ni: "N. Ireland" };

  const $ = (s, el = document) => el.querySelector(s);
  const main = $("#main");

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");
  const ago = (iso) => {
    const d = new Date(iso); const m = Math.round((Date.now() - d) / 60000);
    if (isNaN(m)) return "";
    if (m < 1) return "just now"; if (m < 60) return m + "m ago";
    const h = Math.round(m / 60); if (h < 24) return h + "h ago";
    const days = Math.round(h / 24); if (days < 7) return days + "d ago";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  const fullDate = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const icon = {
    bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4.2-6 4.2z"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    ext: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };

  function toast(msg) {
    const t = $(".toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2200);
  }

  // ------------------------------------------------------------------ taxonomy helpers
  let TOPIC = {};   // topic id -> {label, section, blurb, core}
  function indexTaxonomy() {
    TOPIC = {};
    for (const s of S.tax.sections) for (const t of s.topics) TOPIC[t.id] = { ...t, section: s.id };
    for (const t of S.tax.hidden_topics || []) TOPIC[t.id] = { ...t, hidden: true };
  }
  const section = (id) => S.tax.sections.find((s) => s.id === id);
  const ideology = () => S.prefs.ideology;
  function visibleTopics(sec) {
    const s = section(sec);
    if (sec !== "ideas") return s.topics;
    return s.topics.filter((t) => t.core || t.id === ideology());
  }
  function itemTopicsIn(item, sec) {
    const ids = new Set(visibleTopics(sec).map((t) => t.id));
    if (sec === "ukgov") ids.add("rights");
    return (item.tags || []).filter((t) => ids.has(t));
  }
  function displayTags(item) {
    return (item.tags || []).filter((t) => {
      const tp = TOPIC[t];
      if (!tp || tp.hidden) return false;
      if (tp.section === "ideas" && !tp.core && t !== ideology()) return false;
      return true;
    });
  }

  // ------------------------------------------------------------------ data
  async function loadData(force) {
    const bust = force ? "?t=" + Date.now() : "";
    const opts = { cache: force ? "reload" : "no-cache" };
    const [tax, news, brief] = await Promise.all([
      S.tax ? Promise.resolve(S.tax) : fetch("taxonomy.json", opts).then((r) => r.json()),
      fetch("data/news.json" + bust, opts).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("data/briefing.json" + bust, opts).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    S.tax = tax; indexTaxonomy();
    if (news) {
      S.news = news;
      S.byId = new Map(news.items.map((i) => [i.id, i]));
      // refresh saved snapshots with newest versions of the same story
      let changed = false;
      for (const id of Object.keys(S.saved)) if (S.byId.has(id)) { S.saved[id] = { ...S.byId.get(id), savedAt: S.saved[id].savedAt }; changed = true; }
      if (changed) store.set("saved", S.saved);
    }
    S.brief = brief;
    S.lastLoad = Date.now();
  }
  const items = () => (S.news ? S.news.items : []);
  const getItem = (id) => S.byId.get(id) || S.saved[id];
  function clusterMates(item) {
    if (!item.cluster) return [];
    return items().filter((i) => i.cluster === item.cluster && i.id !== item.id);
  }
  function inSection(item, sec) { return itemTopicsIn(item, sec).length > 0; }
  function matches(item, sec, topic, nation) {
    const t = itemTopicsIn(item, sec);
    if (!t.length) return false;
    if (topic && topic !== "all" && !t.includes(topic)) return false;
    if (nation && nation !== "all" && (sec === "ukgov" || sec === "ukpol")) {
      if (nation === "westminster") return !item.nation && item.region === "uk";
      return item.nation === nation;
    }
    return true;
  }
  function dedupeClusters(list) {
    const seen = new Set(); const out = [];
    for (const i of list) { if (i.cluster) { if (seen.has(i.cluster)) continue; seen.add(i.cluster); } out.push(i); }
    return out;
  }

  // ------------------------------------------------------------------ components
  function leanHTML(lean) {
    const L = LEAN[lean] || LEAN.centre;
    if (L.pos === null) return `<span class="lean-np" title="Non-partisan source">${icon.check}<span>Non-partisan</span></span>`;
    return `<span class="lean" title="${L.label}"><span class="lean-bar"><i style="left:${L.pos}%"></i></span><span class="sr">${L.label}</span></span>`;
  }
  function tagHTML(t) {
    const tp = TOPIC[t]; if (!tp) return "";
    return `<span class="tag sec-${tp.section}">${esc(tp.label)}</span>`;
  }
  function card(item, opts = {}) {
    const saved = !!S.saved[item.id];
    const ty = TYPE[item.type] || TYPE.news;
    const mates = clusterMates(item);
    const tags = (opts.tagsIn ? itemTopicsIn(item, opts.tagsIn).filter((t) => !TOPIC[t].hidden) : displayTags(item)).slice(0, opts.compact ? 1 : 3);
    return `<article class="card${opts.compact ? " compact" : ""}" data-action="open" data-id="${item.id}" tabindex="0" role="button" aria-label="${esc(item.title)}">
      <div class="meta"><span class="src">${esc(item.sourceName)}</span>${leanHTML(item.lean)}${opts.compact ? "" : `<span>· ${ago(item.date)}</span>`}${ty.badge && !opts.compact ? `<span class="type-badge ${ty.cls || ""}">${ty.badge}</span>` : ""}</div>
      <h3>${esc(item.title)}</h3>
      ${opts.compact || !item.summary ? "" : `<p class="sum">${esc(item.summary)}</p>`}
      ${opts.compact ? `<div class="foot" style="margin-top:5px"><span class="time">${ago(item.date)}</span>${mates.length ? `<span class="also">· +${mates.length} outlet${mates.length > 1 ? "s" : ""}</span>` : ""}</div>` :
        `<div class="foot">${tags.map(tagHTML).join("")}${item.nation ? `<span class="tag nation">${NATION[item.nation]}</span>` : ""}${mates.length ? `<span class="also">+${mates.length} other outlet${mates.length > 1 ? "s" : ""}</span>` : ""}</div>`}
      <button class="save-btn" data-action="save" data-id="${item.id}" aria-pressed="${saved}" aria-label="${saved ? "Remove from saved" : "Save story"}">${icon.bookmark}</button>
    </article>`;
  }
  function listHTML(list, key, opts = {}, step = 20) {
    if (!list.length) return `<div class="empty">${opts.empty || "No stories yet."}</div>`;
    const n = S.show[key] || step;
    return `<div class="list">${list.slice(0, n).map((i) => card(i, opts)).join("")}</div>
      ${list.length > n ? `<button class="btn more" data-action="more" data-key="${key}" data-step="${step}">Show more (${list.length - n})</button>` : ""}`;
  }
  function updatedLine() {
    if (!S.news) return "";
    const mins = (Date.now() - new Date(S.news.generated_at)) / 60000;
    return `<div class="updated"><span class="dot${mins > 300 ? " stale" : ""}"></span>News updated ${ago(S.news.generated_at)} · ${S.news.health.filter((h) => h.ok).length} sources checked</div>`;
  }

  // ------------------------------------------------------------------ views
  function viewToday() {
    const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    let html = `<div class="page-head"><div class="kicker">${esc(today)}</div><h1 class="page-title">Today in politics</h1>${updatedLine()}</div>`;
    html += S.brief && S.brief.briefing ? briefingHTML() : topStoriesHTML();
    html += balanceHTML();

    const region = S.latestRegion;
    const all = items().filter((i) => region === "all" || i.region === region);
    html += `<div class="section-h"><h2>Latest</h2>
      <div class="seg" role="group" aria-label="Filter latest by region">
        ${["all", "uk", "us", "eu"].map((r) => `<button data-action="latest-region" data-region="${r}" aria-pressed="${region === r}">${r === "all" ? "All" : r.toUpperCase()}</button>`).join("")}
      </div></div>`;
    html += listHTML(dedupeClusters(all), "latest-" + region, { empty: "No stories found. Try refreshing." }, 15);
    return html;
  }

  function briefingHTML() {
    const B = S.brief.briefing, refs = S.brief.refs || {};
    const refLinks = (ids = []) => ids.filter((id) => refs[id] || getItem(id)).map((id) => {
      const r = getItem(id) || refs[id];
      return `<a class="ref" href="${esc(safeUrl(r.link))}" target="_blank" rel="noopener">${esc(r.sourceName)} ${leanHTML(r.lean)}</a>`;
    }).join("");
    const stories = (B.stories || []).map((s, i) => {
      const sec = TOPIC[s.topic]?.section || s.section || "ukgov";
      const topicLabel = TOPIC[s.topic] ? `${section(sec)?.label || ""} › ${TOPIC[s.topic].label}` : (section(sec)?.label || "");
      return `<div class="bstory" data-open="${i === 0}" style="--sec:${SECTION_COLOUR[sec] || "var(--accent)"}">
        <button class="bstory-top" data-action="toggle-bstory" aria-expanded="${i === 0}">
          <span class="bstory-num">${i + 1}</span>
          <span><span class="kicker">${esc(topicLabel)}</span><h3>${esc(s.title)}</h3><p class="what">${esc(s.what_happened)}</p></span>
          ${icon.chev}
        </button>
        <div class="bstory-more">
          <h4>Why it matters</h4><p>${esc(s.why_it_matters)}</p>
          ${s.perspectives?.length ? `<h4>The arguments</h4><div class="persp">${s.perspectives.map((p) => `<div><b>${esc(p.label)}</b>${esc(p.text)}</div>`).join("")}</div>` : ""}
          ${s.key_term?.term ? `<div class="keyterm"><b>Key term: ${esc(s.key_term.term)}</b> — ${esc(s.key_term.definition)}</div>` : ""}
          ${s.exam_use ? `<h4>Use it in an essay</h4><p>${esc(s.exam_use)}</p>` : ""}
          <h4>Read the reporting</h4><div class="refs">${refLinks(s.sources)}</div>
        </div>
      </div>`;
    }).join("");

    const cmp = B.compare && B.compare.uk ? `<div class="panel" style="--sec:var(--compare)">
        <div class="kicker">Compare · ${esc((S.tax.compare.find((c) => c.id === B.compare.theme) || {}).label || "UK v US")}</div>
        <div class="two-col"><div><b style="color:var(--ukgov)">UK</b>${esc(B.compare.uk)}</div><div><b style="color:var(--us)">US</b>${esc(B.compare.us)}</div></div>
        <p style="margin-top:10px">${esc(B.compare.insight)}</p>
        ${S.tax.compare.find((c) => c.id === B.compare.theme) ? `<button class="link-btn" data-action="go-compare" data-theme="${esc(B.compare.theme)}">See side-by-side coverage →</button>` : ""}
      </div>` : "";
    const lens = B.ideas_lens && B.ideas_lens.text ? `<div class="panel" style="--sec:var(--ideas)">
        <div class="kicker">Ideas lens · ${esc(TOPIC[B.ideas_lens.ideology]?.label || B.ideas_lens.ideology)}</div>
        <p style="margin-top:6px">${esc(B.ideas_lens.text)}</p>
        ${B.ideas_lens.sources?.length ? `<div class="refs">${refLinks(B.ideas_lens.sources)}</div>` : ""}
      </div>` : "";
    const q = B.exam_question && B.exam_question.question ? `<div class="panel" style="--sec:var(--accent)">
        <div class="kicker">Exam practice</div>
        <h3>${esc(B.exam_question.question)}</h3>
        <button class="link-btn" data-action="reveal">Show planning tip</button>
        <p class="reveal" hidden>${esc(B.exam_question.tip)}</p>
      </div>` : "";

    return `<section class="brief" aria-label="The Commentator's Briefing">
        <div class="brief-head"><div class="kicker">The Commentator's Briefing · ${esc(ago(S.brief.generated_at))}</div>
        <h1>${esc(B.headline)}</h1><p>${esc(B.overview)}</p></div>
        ${stories}
        <p class="brief-note">AI-written summary of the linked reporting, balanced across viewpoints. Always check the original articles before quoting.</p>
      </section>${cmp}${lens}${q}`;
  }

  function topStoriesHTML() {
    // Fallback when there is no AI briefing: stories covered by the most outlets
    const since = Date.now() - 36 * 3600e3;
    const groups = new Map();
    for (const i of items()) {
      if (new Date(i.date) < since || !i.tags.length) continue;
      const k = i.cluster || i.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    const top = [...groups.values()].sort((a, b) => new Set(b.map((x) => x.source)).size - new Set(a.map((x) => x.source)).size || new Date(b[0].date) - new Date(a[0].date)).slice(0, 6).map((g) => g[0]);
    return `<div class="section-h"><h2>Most covered right now</h2><span class="count">by number of outlets</span></div>${listHTML(top, "top", {}, 6)}`;
  }

  function balanceHTML() {
    const since = Date.now() - 24 * 3600e3;
    const recent = items().filter((i) => new Date(i.date) >= since);
    if (recent.length < 5) return "";
    const order = ["left", "centre-left", "centre", "centre-right", "right", "non-partisan"];
    const counts = Object.fromEntries(order.map((k) => [k, 0]));
    recent.forEach((i) => (counts[i.lean] = (counts[i.lean] || 0) + 1));
    const used = order.filter((k) => counts[k]);
    return `<div class="panel balance"><div class="kicker" style="color:var(--muted)">Where today's ${recent.length} stories come from</div>
      <div class="balance-bar" style="margin-top:9px" role="img" aria-label="${used.map((k) => `${LEAN[k].label} ${counts[k]}`).join(", ")}">${used.map((k) => `<span class="l-${k}" style="flex:${counts[k]}"></span>`).join("")}</div>
      <div class="balance-legend">${used.map((k) => `<span><i class="l-${k}"></i>${LEAN[k].label} ${counts[k]}</span>`).join("")}</div>
      <button class="link-btn" style="margin-top:8px;font-size:13px" data-action="settings" data-focus="sources">How we choose sources →</button></div>`;
  }

  function viewSection(sec) {
    const s = section(sec);
    const topic = S.topic[sec] || "all";
    const nation = S.nation;
    const topics = visibleTopics(sec);
    const tp = topics.find((t) => t.id === topic);
    let html = `<div class="page-head"><div class="kicker">AQA A-level Politics</div><h1 class="page-title">${esc(s.label)}</h1>${updatedLine()}</div>`;
    html += `<div class="chips" role="group" aria-label="Topics">
      <button class="chip" data-action="topic" data-sec="${sec}" data-topic="all" aria-pressed="${topic === "all"}">All</button>
      ${topics.map((t) => `<button class="chip" data-action="topic" data-sec="${sec}" data-topic="${t.id}" aria-pressed="${topic === t.id}">${esc(t.label)}</button>`).join("")}
      ${sec === "ideas" ? `<button class="chip ghost" data-action="pick-ideology">${ideology() ? "Change 5th ideology" : "Choose 5th ideology"}</button>` : ""}
    </div>`;
    if (sec === "ukgov" || sec === "ukpol") {
      html += `<div class="chips small" role="group" aria-label="Nation">
        ${[["all", "All UK"], ["westminster", "Westminster & UK-wide"], ["scotland", "Scotland"], ["wales", "Wales"], ["ni", "N. Ireland"]].map(([k, l]) => `<button class="chip" data-action="nation" data-nation="${k}" aria-pressed="${nation === k}">${l}</button>`).join("")}
      </div>`;
    }
    if (tp) html += `<p class="blurb">${esc(tp.blurb)}</p>`;
    else if (sec === "ideas" && !ideology()) html += `<p class="blurb">Showing the three core ideologies. <button class="link-btn" data-action="pick-ideology">Pick your fifth ideology</button> to add it.</p>`;

    const saved = Object.values(S.saved).filter((i) => matches(i, sec, topic, nation)).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    const savedIds = new Set(saved.map((i) => i.id));
    const latest = dedupeClusters(items().filter((i) => !savedIds.has(i.id) && matches(i, sec, topic, nation)));
    html += `<div class="section-h"><h2>Saved</h2><span class="count">${saved.length ? saved.length + " stor" + (saved.length > 1 ? "ies" : "y") : ""}</span></div>`;
    html += saved.length ? listHTML(saved, `saved-${sec}-${topic}`, { tagsIn: sec }, 5)
      : `<div class="empty">Tap the ${icon.bookmark.replace('viewBox', 'style="width:15px;height:15px;vertical-align:-2px" viewBox')} on any story to save it here as essay evidence.</div>`;
    html += `<div class="section-h"><h2>Latest</h2><span class="count">${latest.length} stories</span></div>`;
    html += listHTML(latest, `latest-${sec}-${topic}-${nation}`, { tagsIn: sec, empty: "Nothing on this topic in the last few days. Check back soon." });
    return html;
  }

  function viewCompare() {
    const theme = S.tax.compare.find((c) => c.id === S.compare) || S.tax.compare[0];
    const pick = (region, topics) => {
      const list = [...Object.values(S.saved), ...items().filter((i) => !S.saved[i.id])]
        .filter((i) => (region === "uk" ? i.region === "uk" || i.region === "eu" : i.region === "us") && (i.tags || []).some((t) => topics.includes(t)));
      const saved = list.filter((i) => S.saved[i.id]);
      const rest = dedupeClusters(list.filter((i) => !S.saved[i.id]));
      return [...saved, ...rest];
    };
    const uk = pick("uk", theme.uk), us = pick("us", theme.us);
    const col = (label, colour, list, key) => `<div class="cmp-col" style="--c:${colour}"><h2>${label}<small>${list.length}</small></h2>
      ${listHTML(list, key, { compact: true, empty: "No recent stories." }, 8)}</div>`;
    return `<div class="page-head"><div class="kicker">Comparative politics</div><h1 class="page-title">UK v US</h1>
        <p class="page-sub">The same theme, both systems, side by side. Saved stories appear first.</p></div>
      <div class="chips" role="group" aria-label="Themes">
        ${S.tax.compare.map((c) => `<button class="chip" data-action="compare-theme" data-theme="${c.id}" aria-pressed="${c.id === theme.id}">${esc(c.label)}</button>`).join("")}
      </div>
      <div class="panel cmp-q"><div class="kicker">Essay question</div><h3>${esc(theme.q)}</h3>
        <p class="hint" style="margin:0">UK: ${theme.uk.map((t) => TOPIC[t]?.label || t).join(", ")} · US: ${theme.us.map((t) => TOPIC[t]?.label || t).join(", ")}</p></div>
      <div class="cmp-grid">${col("UK", "var(--ukgov)", uk, "cmp-uk-" + theme.id)}${col("US", "var(--us)", us, "cmp-us-" + theme.id)}</div>`;
  }

  // ------------------------------------------------------------------ sheets
  const sheet = $(".sheet"), backdrop = $(".sheet-backdrop");
  let lastFocus = null;
  function openSheet(html, onOpen) {
    lastFocus = document.activeElement;
    $(".sheet-body", sheet).innerHTML = html;
    sheet.hidden = false; backdrop.hidden = false;
    requestAnimationFrame(() => { sheet.classList.add("show"); backdrop.classList.add("show"); });
    $(".sheet-body", sheet).scrollTop = 0;
    document.body.style.overflow = "hidden";
    setTimeout(() => { (onOpen && onOpen()) || $(".close", sheet)?.focus(); }, 60);
  }
  function closeSheet() {
    sheet.classList.remove("show"); backdrop.classList.remove("show");
    document.body.style.overflow = "";
    setTimeout(() => { sheet.hidden = true; backdrop.hidden = true; }, 250);
    if (lastFocus) lastFocus.focus?.();
  }
  const closeBtn = `<button class="close" data-action="close-sheet" aria-label="Close">${icon.close}</button>`;

  function openStory(id) {
    const it = getItem(id); if (!it) return;
    const src = (S.news?.sources || []).find((s) => s.id === it.source) || {};
    const ty = TYPE[it.type] || TYPE.news;
    const L = LEAN[it.lean] || LEAN.centre;
    const mates = clusterMates(it);
    const saved = !!S.saved[id];
    openSheet(`
      <div class="sheet-top"><div class="meta" style="padding:0"><span class="src">${esc(it.sourceName)}</span>${leanHTML(it.lean)}<span>· ${esc(fullDate(it.date))}</span></div>${closeBtn}</div>
      <h2 id="sheet-title">${esc(it.title)}</h2>
      ${it.author ? `<p class="hint" style="margin:0 0 6px">By ${esc(it.author)}</p>` : ""}
      ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}
      <div class="foot" style="display:flex;flex-wrap:wrap;gap:6px">${displayTags(it).map((t) => `<button class="tag sec-${TOPIC[t].section}" data-action="go-topic" data-topic="${t}">${esc(TOPIC[t].label)} →</button>`).join("")}${it.nation ? `<span class="tag nation">${NATION[it.nation]}</span>` : ""}</div>
      <div class="actions">
        <a class="btn primary" href="${esc(safeUrl(it.link))}" target="_blank" rel="noopener">Read full article ${icon.ext}</a>
        <button class="btn" data-action="save" data-id="${id}" aria-pressed="${saved}" aria-label="${saved ? "Remove from saved" : "Save story"}" style="color:${saved ? "var(--save)" : "inherit"}">${icon.bookmark.replace("<svg", `<svg style="fill:${saved ? "currentColor" : "none"}"`)}</button>
        <button class="btn" data-action="share" data-id="${id}" aria-label="Share">${icon.share}</button>
      </div>
      <div class="note"><b>About this source:</b> ${esc(it.sourceName)} is ${L.pos === null ? "a <b>non-partisan</b>" : `generally seen as <b>${esc(L.label.toLowerCase())}</b>`} ${esc((ty.label || "news").toLowerCase())} source.${ty.note ? " " + ty.note : ""}</div>
      ${mates.length ? `<div class="section-h" style="margin-top:18px"><h2>Compare the coverage</h2><span class="count">${mates.length + 1} outlets</span></div>
        <p class="hint" style="margin:0">Same story, different outlets. Notice what each one leads with.</p>
        <div class="cov">${mates.map((m) => `<a href="${esc(safeUrl(m.link))}" target="_blank" rel="noopener"><div class="meta"><span class="src">${esc(m.sourceName)}</span>${leanHTML(m.lean)}<span>· ${ago(m.date)}</span></div><div>${esc(m.title)}</div></a>`).join("")}</div>` : ""}
      ${src.home ? `<p class="hint" style="margin-top:16px">More from <a href="${esc(safeUrl(src.home))}" target="_blank" rel="noopener">${esc(src.name)}</a></p>` : ""}
    `);
  }

  function ideologyPicker(first) {
    const blurbs = Object.fromEntries(section("ideas").topics.map((t) => [t.id, t.blurb]));
    return `<div class="field" role="radiogroup" aria-label="Fifth ideology">${OPTIONAL_IDEOLOGIES.map((id) => `
      <button class="option" role="radio" aria-checked="${ideology() === id}" data-action="set-ideology" data-id="${id}" data-first="${first ? 1 : 0}">
        <span class="radio"></span><span><b>${esc(TOPIC[id].label)}</b><small>${esc(blurbs[id])}</small></span>
      </button>`).join("")}</div>`;
  }

  function openOnboarding() {
    openSheet(`
      <div class="sheet-top"><div class="kicker">Welcome to Scrutiny</div></div>
      <h2 id="sheet-title">Politics news, sorted by your AQA course</h2>
      <p>Every story is filed under UK Government, UK Politics, US Politics and Political Ideas, from sources across the spectrum, so you can see every side of the argument.</p>
      <p><b>One quick question:</b> alongside liberalism, conservatism and socialism, which fifth ideology are you studying?</p>
      ${ideologyPicker(true)}
      <button class="btn full" data-action="skip-onboarding">I'm not sure yet — ask me later</button>
    `);
  }

  function openIdeologyPicker() {
    openSheet(`<div class="sheet-top"><div class="kicker">Political Ideas</div>${closeBtn}</div>
      <h2 id="sheet-title">Your fifth ideology</h2><p class="hint">The Ideas tab will show liberalism, conservatism, socialism and this one.</p>${ideologyPicker(false)}`);
  }

  function installHTML() {
    const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
    if (standalone) return "";
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (S.installEvt) return `<div class="install"><span>Install Scrutiny on your home screen for one-tap access.</span><button class="btn primary" data-action="install">Install</button></div>`;
    if (ios) return `<div class="install">To install on iPhone: tap <b>Share</b> ${icon.share.replace("<svg", '<svg style="width:16px;height:16px;vertical-align:-3px"')} in Safari, then <b>Add to Home Screen</b>.</div>`;
    return `<div class="install">To install: open your browser menu and choose <b>Add to Home screen</b> / <b>Install app</b>.</div>`;
  }

  function openSettings(focus) {
    const theme = S.prefs.theme || "system";
    const health = Object.fromEntries((S.news?.health || []).map((h) => [h.id, h]));
    const srcs = (S.news?.sources || []).slice().sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name));
    const regionLabel = { uk: "UK", us: "US", eu: "EU" };
    openSheet(`
      <div class="sheet-top"><div class="kicker">Settings</div>${closeBtn}</div>
      <h2 id="sheet-title">Scrutiny</h2>
      ${installHTML()}
      <div class="section-h"><h2>Your fifth ideology</h2></div>
      ${ideologyPicker(false)}
      <div class="section-h"><h2>Appearance</h2></div>
      <div class="seg" role="group" aria-label="Theme">${["system", "light", "dark"].map((t) => `<button data-action="theme" data-theme="${t}" aria-pressed="${theme === t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
      <div class="section-h" id="sources"><h2>Our sources</h2><span class="count">${srcs.length}</span></div>
      <p class="hint">Chosen for balance and reliability: established outlets from centre-left to centre-right, plus non-partisan academics, Parliament's own researchers and independent fact-checkers. No extreme or hyper-partisan sites. The spectrum marker is a broad guide to each outlet's editorial lean — a media-literacy tool, not a verdict.</p>
      ${srcs.map((s) => { const h = health[s.id]; return `<div class="src-row"><div><a href="${esc(safeUrl(s.home))}" target="_blank" rel="noopener">${esc(s.name)}</a><small>${regionLabel[s.region] || ""}${s.nation ? " · " + NATION[s.nation] : ""} · ${esc(TYPE[s.type]?.label || s.type)} · ${esc(LEAN[s.lean]?.label || s.lean)}</small></div>
        <span class="status ${h?.ok ? "ok" : "bad"}">${h ? (h.ok ? "Live" : "Unavailable") : ""}</span></div>`; }).join("")}
      <div class="section-h"><h2>How it works</h2></div>
      <p class="hint">News is collected automatically every two hours and filed under the AQA 7152 specification. The Commentator's Briefing is written by an AI model a few times a day using only the linked articles, and is instructed to give every side a fair hearing. It can still make mistakes, so always read the original reporting before using it in an essay.</p>
      <p class="hint">Saved stories and your settings stay on this phone.</p>
      <div class="section-h"><h2>Saved stories</h2><span class="count">${Object.keys(S.saved).length}</span></div>
      <button class="btn" data-action="clear-saved" ${Object.keys(S.saved).length ? "" : "disabled"}>Clear all saved stories</button>
      <p class="hint" style="margin-top:22px">${S.news ? `News updated ${esc(fullDate(S.news.generated_at))}` : ""}${S.brief ? ` · Briefing ${esc(fullDate(S.brief.generated_at))}` : ""}</p>
    `, focus === "sources" ? () => { $("#sources")?.scrollIntoView({ block: "start" }); return true; } : null);
  }

  function openSearch() {
    openSheet(`<div class="sheet-top"><div class="kicker">Search</div>${closeBtn}</div>
      <input class="search-input" type="search" placeholder="e.g. Supreme Court, Senedd, filibuster" aria-label="Search stories" autocomplete="off">
      <div class="search-results" style="margin-top:12px"><p class="hint">Search every story from the last 10 days plus your saved stories — handy for finding essay examples.</p></div>`,
      () => { $(".search-input", sheet).focus(); return true; });
    const input = $(".search-input", sheet);
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      const out = $(".search-results", sheet);
      if (q.length < 2) { out.innerHTML = `<p class="hint">Type at least two letters.</p>`; return; }
      const words = q.split(/\s+/);
      const pool = [...Object.values(S.saved), ...items().filter((i) => !S.saved[i.id])];
      const hits = pool.filter((i) => { const t = (i.title + " " + i.summary + " " + i.sourceName).toLowerCase(); return words.every((w) => t.includes(w)); });
      S.show["search"] = 25;
      out.innerHTML = `<p class="hint">${hits.length} result${hits.length === 1 ? "" : "s"}</p>` + listHTML(hits, "search", {}, 25);
    });
  }

  // ------------------------------------------------------------------ render & routing
  function render() {
    const r = S.route;
    document.documentElement.style.setProperty("--sec", SECTION_COLOUR[r]);
    main.style.setProperty("--sec", SECTION_COLOUR[r]);
    document.querySelectorAll(".tabbar button").forEach((b) => b.setAttribute("aria-current", b.dataset.route === r ? "page" : "false"));
    if (!S.tax) return;
    if (!S.news) {
      main.innerHTML = `<div class="page-head"><h1 class="page-title">No news yet</h1><p class="page-sub">The first news update hasn't run yet, or you're offline. Pull the refresh button above in a minute.</p></div>`;
      return;
    }
    main.innerHTML = r === "today" ? viewToday() : r === "compare" ? viewCompare() : viewSection(r);
  }

  function go(route, push = true) {
    if (!["today", "ukgov", "ukpol", "us", "ideas", "compare"].includes(route)) route = "today";
    const changed = route !== S.route;
    S.route = route;
    if (push && location.hash !== "#" + route) history.pushState(null, "", "#" + route);
    render();
    if (changed) window.scrollTo({ top: 0 });
  }

  function toggleSave(id) {
    const it = getItem(id); if (!it) return;
    if (S.saved[id]) { delete S.saved[id]; toast("Removed from saved"); }
    else { S.saved[id] = { ...it, savedAt: Date.now() }; toast("Saved — find it in its section"); }
    store.set("saved", S.saved);
  }

  function applyTheme() {
    const t = S.prefs.theme || "system";
    if (t === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
  }

  async function refresh(manual) {
    const btn = $('[data-action="refresh"]');
    btn.classList.add("spin");
    try {
      await loadData(true);
      render();
      if (manual) toast("Up to date");
    } catch {
      if (manual) toast("Couldn't refresh — are you offline?");
    } finally { btn.classList.remove("spin"); }
  }

  // ------------------------------------------------------------------ events
  document.addEventListener("click", async (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const a = el.dataset.action;
    if (el.tagName === "A") return;
    switch (a) {
      case "go": closeSheetIfOpen(); go(el.dataset.route); break;
      case "open": openStory(el.dataset.id); break;
      case "save": {
        e.stopPropagation(); toggleSave(el.dataset.id);
        const inSheet = el.closest(".sheet");
        render();
        if (inSheet && !sheet.hidden) openStoryRefresh(el.dataset.id);
        break;
      }
      case "share": {
        const it = getItem(el.dataset.id);
        if (navigator.share) navigator.share({ title: it.title, text: `${it.title} (${it.sourceName})`, url: it.link }).catch(() => {});
        else { navigator.clipboard?.writeText(it.link); toast("Link copied"); }
        break;
      }
      case "more": S.show[el.dataset.key] = (S.show[el.dataset.key] || +el.dataset.step) + +el.dataset.step; render(); if (el.closest(".sheet")) $(".search-input", sheet)?.dispatchEvent(new Event("input")); break;
      case "topic": S.topic[el.dataset.sec] = el.dataset.topic; store.set("topic", S.topic); render(); break;
      case "nation": S.nation = el.dataset.nation; render(); break;
      case "latest-region": S.latestRegion = el.dataset.region; render(); break;
      case "compare-theme": S.compare = el.dataset.theme; store.set("compare", S.compare); render(); break;
      case "go-compare": S.compare = el.dataset.theme; store.set("compare", S.compare); go("compare"); break;
      case "go-topic": { const t = TOPIC[el.dataset.topic]; if (!t) break; closeSheet(); S.topic[t.section] = t.id; store.set("topic", S.topic); go(t.section); break; }
      case "toggle-bstory": { const b = el.closest(".bstory"); const open = b.dataset.open !== "true"; b.dataset.open = open; el.setAttribute("aria-expanded", open); break; }
      case "reveal": { const p = el.nextElementSibling; p.hidden = !p.hidden; el.textContent = p.hidden ? "Show planning tip" : "Hide tip"; break; }
      case "search": openSearch(); break;
      case "refresh": refresh(true); break;
      case "settings": openSettings(el.dataset.focus); break;
      case "pick-ideology": openIdeologyPicker(); break;
      case "set-ideology": {
        S.prefs.ideology = el.dataset.id; store.set("prefs", S.prefs);
        sheet.querySelectorAll('[data-action="set-ideology"]').forEach((b) => b.setAttribute("aria-checked", b.dataset.id === el.dataset.id));
        toast(`${TOPIC[el.dataset.id].label} added to Ideas`);
        render();
        if (el.dataset.first === "1" || !sheet.querySelector('[aria-label="Theme"]')) setTimeout(closeSheet, 350);
        break;
      }
      case "skip-onboarding": S.prefs.onboarded = true; store.set("prefs", S.prefs); closeSheet(); break;
      case "theme": S.prefs.theme = el.dataset.theme; store.set("prefs", S.prefs); applyTheme(); sheet.querySelectorAll('[data-action="theme"]').forEach((b) => b.setAttribute("aria-pressed", b.dataset.theme === el.dataset.theme)); break;
      case "clear-saved": if (confirmClear(el)) { S.saved = {}; store.set("saved", S.saved); render(); closeSheet(); toast("Saved stories cleared"); } break;
      case "install": if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; closeSheet(); } break;
      case "close-sheet": closeSheet(); break;
    }
  });
  // two-tap confirm (no blocking browser dialogs)
  function confirmClear(el) {
    if (el.dataset.armed) return true;
    el.dataset.armed = "1"; el.textContent = "Tap again to confirm"; el.style.color = "var(--danger)";
    setTimeout(() => { delete el.dataset.armed; el.textContent = "Clear all saved stories"; el.style.color = ""; }, 3000);
    return false;
  }
  function closeSheetIfOpen() { if (!sheet.hidden) closeSheet(); }
  function openStoryRefresh(id) {
    const body = $(".sheet-body", sheet); const top = body.scrollTop;
    const saved = !!S.saved[id];
    const b = body.querySelector(`[data-action="save"][data-id="${id}"]`);
    if (b) { b.setAttribute("aria-pressed", saved); b.style.color = saved ? "var(--save)" : "inherit"; b.querySelector("svg").style.fill = saved ? "currentColor" : "none"; }
    body.scrollTop = top;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !sheet.hidden) closeSheet();
    if ((e.key === "Enter" || e.key === " ") && e.target.matches(".card[data-action='open']")) { e.preventDefault(); openStory(e.target.dataset.id); }
  });
  window.addEventListener("popstate", () => go(location.hash.slice(1), false));
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvt = e; });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - S.lastLoad > 15 * 60e3) refresh(false);
  });

  // swipe down on the sheet handle to close
  (() => {
    let y0 = null;
    sheet.addEventListener("touchstart", (e) => { if ($(".sheet-body", sheet).scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
    sheet.addEventListener("touchmove", (e) => { if (y0 !== null && e.touches[0].clientY - y0 > 90) { y0 = null; closeSheet(); } }, { passive: true });
    sheet.addEventListener("touchend", () => (y0 = null));
  })();

  // ------------------------------------------------------------------ boot
  async function boot() {
    applyTheme();
    S.route = (location.hash.slice(1) || "today");
    try { await loadData(false); } catch (e) { console.error(e); }
    if (!S.tax) { main.innerHTML = `<div class="empty" style="margin-top:30vh">Couldn't load Scrutiny. Check your connection and try again.</div>`; return; }
    go(S.route, false);
    if (!S.prefs.ideology && !S.prefs.onboarded) setTimeout(openOnboarding, 400);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  boot();
})();
