#!/usr/bin/env python3
"""
Scrutiny news builder.

Fetches curated RSS/Atom feeds, tags every story against the AQA A-level
Politics (7152) sections, groups stories that several outlets are covering,
and (optionally) writes a daily "Commentator's Briefing" using a free AI API:
Groq first (GROQ_API_KEY), OpenRouter as a backup (OPENROUTER_API_KEY).

Standard library only, so it runs anywhere with Python 3.9+.

Usage:
  python scripts/build_news.py                 # fetch + tag + briefing if due
  python scripts/build_news.py --no-briefing   # skip the AI step
  python scripts/build_news.py --force-briefing
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import email.utils
import hashlib
import html
import html.entities
import json
import os
import re
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
NEWS_FILE = DATA / "news.json"
BRIEFING_FILE = DATA / "briefing.json"

UA = "Mozilla/5.0 (compatible; ScrutinyNewsBot/1.0; +https://github.com/sbhogaita19/scrutiny)"
NOW = dt.datetime.now(dt.timezone.utc)

KEEP_DAYS_TAGGED = 10      # tagged stories stay this long (keeps niche topics populated)
KEEP_DAYS_UNTAGGED = 2     # untagged stories only appear in "Latest"
MAX_PER_SOURCE_FETCH = 40
SUMMARY_CHARS = 320

BRIEFING_MAX_AGE_HOURS = float(os.environ.get("BRIEFING_MAX_AGE_HOURS", "5"))
def _models(env, default):
    return [m.strip() for m in os.environ.get(env, default).split(",") if m.strip()]


# Free AI providers, tried in order. Each needs its key saved as a repository secret.
PROVIDERS = [
    {"name": "groq", "key_env": "GROQ_API_KEY",
     "endpoint": "https://api.groq.com/openai/v1/chat/completions",
     "models": _models("GROQ_MODELS", "openai/gpt-oss-120b,openai/gpt-oss-20b"),
     "json_mode": True},
    {"name": "openrouter", "key_env": "OPENROUTER_API_KEY",
     "endpoint": "https://openrouter.ai/api/v1/chat/completions",
     "models": _models("OPENROUTER_MODELS", "openrouter/free"),
     "json_mode": False},
]
BRIEFING_MAX_TOKENS = int(os.environ.get("BRIEFING_MAX_TOKENS", "4000"))


# --------------------------------------------------------------------------- helpers

def log(*a):
    print(*a, file=sys.stderr, flush=True)


def iso(d):
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s):
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


_XML_SAFE = {"amp", "lt", "gt", "quot", "apos"}


def _fix_entities(raw: str) -> str:
    """Replace HTML named entities (invalid in XML, common in feeds) with characters."""
    def rep(m):
        name = m.group(1)
        if name in _XML_SAFE:
            return m.group(0)
        cp = html.entities.name2codepoint.get(name)
        return chr(cp) if cp else " "
    return re.sub(r"&([A-Za-z][A-Za-z0-9]*);", rep, raw)


TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def clean_text(s, limit=None):
    if not s:
        return ""
    s = html.unescape(s)
    s = TAG_RE.sub(" ", s)
    s = html.unescape(s)
    s = WS_RE.sub(" ", s).strip()
    # common feed boilerplate
    s = re.sub(r"\s*(Continue reading\.*|Read more\.*|The post .* appeared first on .*)$", "", s, flags=re.I)
    if limit and len(s) > limit:
        cut = s[:limit].rsplit(" ", 1)[0]
        s = cut.rstrip(",;:-") + "…"
    return s


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = email.utils.parsedate_to_datetime(s)
        if d:
            return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
    except Exception:
        pass
    try:
        d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)
    except Exception:
        return None


def local(tag):
    return tag.rsplit("}", 1)[-1].lower() if isinstance(tag, str) else ""


def child_text(el, *names):
    for c in el:
        if local(c.tag) in names:
            txt = "".join(c.itertext()) if len(c) else (c.text or "")
            if txt and txt.strip():
                return txt.strip()
    return ""


def atom_link(el):
    best = ""
    for c in el:
        if local(c.tag) == "link":
            href = c.get("href") or (c.text or "").strip()
            rel = c.get("rel", "alternate")
            if href and rel == "alternate":
                return href
            if href and not best:
                best = href
    return best


def parse_feed(raw: bytes):
    text = raw.decode("utf-8", errors="replace")
    text = text.lstrip("﻿ \n\r\t")
    text = _fix_entities(text)
    root = ET.fromstring(text.encode("utf-8"))
    items = []
    for el in root.iter():
        name = local(el.tag)
        if name not in ("item", "entry"):
            continue
        title = clean_text(child_text(el, "title"))
        link = atom_link(el) if name == "entry" else (child_text(el, "link") or atom_link(el))
        if not link:
            guid = child_text(el, "guid", "id")
            link = guid if guid.startswith("http") else ""
        summary = child_text(el, "description", "summary") or child_text(el, "encoded", "content")
        date = parse_date(child_text(el, "pubdate", "published", "updated", "date", "issued"))
        author = clean_text(child_text(el, "creator", "author"))
        if author and "\n" in author:
            author = author.split("\n")[0]
        if title and link:
            items.append({"title": title, "link": link.strip(), "summary": clean_text(summary, SUMMARY_CHARS),
                          "date": date, "author": author[:80]})
    return items


def fetch(src):
    req = urllib.request.Request(src["url"], headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
    })
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            raw = r.read()
        items = parse_feed(raw)
        return src, items[:MAX_PER_SOURCE_FETCH], None
    except Exception as e:  # noqa: BLE001 - we record every failure and move on
        return src, [], f"{type(e).__name__}: {e}"[:200]


# --------------------------------------------------------------------------- tagging

def compile_kw(words):
    words = sorted({w.lower() for w in words}, key=len, reverse=True)
    return [(w, re.compile(r"(?<![a-z0-9])" + re.escape(w).replace(r"\ ", r"[\s\-]+") + r"(?![a-z0-9])")) for w in words]


class Tagger:
    def __init__(self, tax):
        self.topics = []  # (topic_id, section_id, region, compiled)
        for s in tax["sections"]:
            for t in s["topics"]:
                self.topics.append((t["id"], s["id"], s["region"], compile_kw(t["keywords"])))
        for t in tax.get("hidden_topics", []):
            self.topics.append((t["id"], t["section"], t["region"], compile_kw(t["keywords"])))
        self.nations = {n: compile_kw(k) for n, k in tax["nations"].items()}
        self.uk_markers = compile_kw(["uk", "britain", "british", "westminster", "downing street", "commons", "labour",
                                      "tory", "tories", "conservatives", "holyrood", "senedd", "stormont", "england",
                                      "scotland", "wales", "northern ireland", "nhs", "reform uk", "lib dem"])
        self.us_markers = compile_kw(["us", "u.s.", "america", "american", "americans", "washington", "white house",
                                      "congress", "senate", "republican", "republicans", "gop", "trump", "biden",
                                      "democrats", "capitol hill", "pentagon", "supreme court justice", "maga",
                                      "governor", "federal"])

    @staticmethod
    def hits(compiled, text):
        return {w for w, rx in compiled if rx.search(text)}

    def region_for(self, src, title, summary):
        base = src["region"]
        text = f"{title} {summary}".lower()
        uk = len(self.hits(self.uk_markers, text))
        us = len(self.hits(self.us_markers, text))
        if base in ("uk", "eu") and us >= uk + 2:
            return "us"
        if base == "us" and uk >= us + 2:
            return "uk"
        return base

    def tag(self, src, title, summary, region):
        t = title.lower()
        s = summary.lower()
        tags = []
        for tid, sid, treg, comp in self.topics:
            if treg == "uk" and region not in ("uk", "eu"):
                continue
            if treg == "us" and region != "us":
                continue
            th = self.hits(comp, t)
            sh = self.hits(comp, s) - th
            score = 2 * len(th) + len(sh)
            need = 3 if sid == "ideas" else 2
            if score >= need:
                tags.append((score, tid))
        # EU outlets: always file under The EU so EU stories stay visible
        if region == "eu" and "eu" not in [x[1] for x in tags]:
            tags.append((2, "eu"))
        # devolved-nation outlets: devolved politics is always relevant to Devolution
        if src.get("nation") and "devolution" not in [x[1] for x in tags]:
            tags.append((2, "devolution"))
        tags.sort(reverse=True)
        return [tid for _, tid in tags[:5]]

    def nation(self, src, title, summary, region):
        if region != "uk":
            return None
        if src.get("nation"):
            return src["nation"]
        text = f"{title} {summary}".lower()
        scores = {n: len(self.hits(c, text)) for n, c in self.nations.items()}
        best = max(scores, key=scores.get)
        return best if scores[best] >= 2 or (scores[best] >= 1 and self.hits(self.nations[best], title.lower())) else None


# --------------------------------------------------------------------------- clustering

STOP = set("""a an the and or but if of to in on at by for with from as is are was were be been being it its this that
these those after before over under about into up down out off than then so not no new says say said will would could
should may might can has have had do does did he she they we you i his her their our your who what why how when where
which amid more most very just also back first last one two three week year years day days govt government uk us
britain british news live latest update updates report reports plan plans row calls call warns warn told tells""".split())


def sig_tokens(title):
    words = re.findall(r"[a-z0-9']+", title.lower())
    out = set()
    for w in words:
        w = w.strip("'")
        if w.endswith("'s"):
            w = w[:-2]
        if len(w) > 2 and w not in STOP:
            out.add(w[:7])  # crude stemming: 'elections'/'election' collide
    return out


def cluster(items):
    parent = list(range(len(items)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    toks = [sig_tokens(it["title"]) for it in items]
    times = [parse_iso(it["date"]) for it in items]
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            if items[i]["source"] == items[j]["source"]:
                continue
            if abs((times[i] - times[j]).total_seconds()) > 60 * 3600:
                continue
            a, b = toks[i], toks[j]
            inter = len(a & b)
            if inter >= 3 and inter / max(1, len(a | b)) >= 0.28:
                parent[find(i)] = find(j)
    groups = {}
    for i in range(len(items)):
        groups.setdefault(find(i), []).append(i)
    for members in groups.values():
        if len(members) < 2:
            continue
        cid = "c" + items[min(members)]["id"][:8]
        for m in members:
            items[m]["cluster"] = cid


# --------------------------------------------------------------------------- AI briefing (Groq / OpenRouter)

SYSTEM_PROMPT = """You are a world-class political commentator writing a daily briefing for a sixth-form student \
studying AQA A-level Politics (7152) in England: UK Government, UK Politics, US Politics (with comparison) and Political Ideas.

Your standards:
- Strictly balanced and fair. Present the strongest version of competing views (government and opposition; left and right; \
supporters and critics). Never tell the reader what to think, never use loaded language, never take a side.
- Accurate. Use ONLY the facts in the stories supplied. Do not invent quotes, numbers, names or events. If something is \
uncertain or disputed, say so. Every story you write about must cite the ids of the supplied items it is based on.
- Educational. Link each story to the AQA specification, name a key term and define it simply, and show how the story \
could be used as evidence in an essay. Plain British English, clear enough for a 17-year-old, no jargon without explanation.
- Concise. Every sentence must earn its place.

Return ONLY a JSON object with exactly this shape:
{
  "headline": "the day's political story in under 12 words",
  "overview": "2-3 sentences: the state of play today",
  "stories": [
    {
      "title": "short neutral title",
      "section": "ukgov | ukpol | us | ideas",
      "topic": "one topic id from the list provided",
      "what_happened": "2 sentences, facts only",
      "why_it_matters": "2 sentences linking it to the A-level course",
      "perspectives": [ {"label": "e.g. Supporters argue / Critics argue / From the right / From the left", "text": "1-2 sentences"} ],
      "key_term": {"term": "...", "definition": "one sentence"},
      "exam_use": "one sentence: how to use this as evidence and in which kind of essay",
      "sources": ["item ids"]
    }
  ],
  "compare": {"theme": "one of: constitutions, legislatures, executives, courts, elections, parties, pressure, rights", "uk": "1-2 sentences", "us": "1-2 sentences", "insight": "1-2 sentences on what the contrast shows", "sources": ["item ids"]},
  "ideas_lens": {"ideology": "liberalism | conservatism | socialism | nationalism | feminism | multiculturalism | anarchism | ecologism", "text": "2 sentences connecting a current story to the ideology's core ideas and thinkers", "sources": ["item ids"]},
  "exam_question": {"question": "an AQA-style question inspired by today's news", "section": "ukgov | ukpol | us | ideas", "tip": "one sentence planning tip"}
}
Write 5 or 6 stories. Include at least one UK Government, one UK Politics and one US Politics story where the material allows. \
Each story needs 2 or 3 perspectives."""


def pick_briefing_inputs(items, tax, limit=24):
    cutoff = NOW - dt.timedelta(hours=36)
    recent = [it for it in items if parse_iso(it["date"]) >= cutoff and it["tags"]]
    if len(recent) < 15:
        recent = [it for it in items if it["tags"]][:60]
    size = {}
    for it in recent:
        if it.get("cluster"):
            size.setdefault(it["cluster"], set()).add(it["source"])

    def score(it):
        hrs = (NOW - parse_iso(it["date"])).total_seconds() / 3600
        breadth = len(size.get(it.get("cluster"), {it["source"]}))
        return breadth * 3 + len(it["tags"]) - hrs / 12

    chosen, seen_clusters, per_section = [], set(), {}
    topic_section = {t["id"]: s["id"] for s in tax["sections"] for t in s["topics"]}
    for it in sorted(recent, key=score, reverse=True):
        c = it.get("cluster")
        if c and c in seen_clusters:
            continue
        sec = topic_section.get(it["tags"][0], "ukgov")
        if per_section.get(sec, 0) >= limit // 3:
            continue
        chosen.append(it)
        per_section[sec] = per_section.get(sec, 0) + 1
        if c:
            seen_clusters.add(c)
        if len(chosen) >= limit:
            break
    return chosen


def _post(url, key, body, extra_headers=None):
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json",
               "Accept": "application/json", "User-Agent": UA}
    headers.update(extra_headers or {})
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=headers)
    with urllib.request.urlopen(req, timeout=150) as r:
        raw = r.read().decode("utf-8", "replace")
    try:
        return json.loads(raw)
    except ValueError:
        raise RuntimeError(f"non-JSON reply: {raw[:200]!r}")


def call_models(messages):
    """Try each configured provider/model until one returns text. Returns (label, content)."""
    last_err, tried = None, 0
    for p in PROVIDERS:
        key = os.environ.get(p["key_env"], "").strip()
        if not key:
            log(f"  {p['name']}: no {p['key_env']} secret, skipping")
            continue
        extra = {"HTTP-Referer": "https://sbhogaita19.github.io/scrutiny/", "X-Title": "Scrutiny"} \
            if p["name"] == "openrouter" else None
        bad_key = False
        for model in p["models"]:
            if bad_key:
                break
            modes = (True, False) if p["json_mode"] else (False,)
            for use_json in modes:
                tried += 1
                body = {"model": model, "messages": messages, "temperature": 0.3,
                        "max_tokens": BRIEFING_MAX_TOKENS}
                if use_json:
                    body["response_format"] = {"type": "json_object"}
                if p["name"] == "groq" and "gpt-oss" in model:
                    body["reasoning_effort"] = "low"   # keep thinking short so the answer fits
                label = f"{p['name']}:{model}"
                try:
                    data = _post(p["endpoint"], key, body, extra)
                    if data.get("error"):
                        raise RuntimeError(str(data["error"])[:300])
                    content = (data["choices"][0]["message"].get("content") or "").strip()
                    if not content:
                        raise RuntimeError("empty reply")
                    return label, content
                except urllib.error.HTTPError as e:
                    detail = e.read().decode("utf-8", "replace")[:300]
                    last_err = f"{label} HTTP {e.code}: {detail}"
                    log("  model error:", last_err)
                    if e.code == 400 and use_json:
                        continue          # retry same model without JSON mode
                    bad_key = e.code in (401, 403)
                    break                 # otherwise try the next model
                except Exception as e:  # noqa: BLE001
                    last_err = f"{label}: {e}"
                    log("  model error:", last_err)
                    break
    if not tried:
        raise RuntimeError("no AI key configured (add GROQ_API_KEY or OPENROUTER_API_KEY as a repository secret)")
    raise RuntimeError(last_err or "no model available")


def extract_json(text):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text).strip()
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError(f"no JSON object in reply: {text[:200]!r}")
    chunk = text[start:end + 1]
    try:
        return json.loads(chunk)
    except ValueError:
        return json.loads(re.sub(r",\s*([}\]])", r"\1", chunk))   # tolerate trailing commas


def _ids(v):
    if isinstance(v, (str, int)):
        v = [v]
    return [str(x).strip().strip("[]").strip() for x in (v or [])]


def build_briefing(items, tax, force=False):
    if not any(os.environ.get(p["key_env"], "").strip() for p in PROVIDERS):
        log("No AI key (GROQ_API_KEY / OPENROUTER_API_KEY): skipping AI briefing.")
        return
    if BRIEFING_FILE.exists() and not force:
        try:
            old = json.loads(BRIEFING_FILE.read_text())
            age = (NOW - parse_iso(old["generated_at"])).total_seconds() / 3600
            if age < BRIEFING_MAX_AGE_HOURS:
                log(f"Briefing is {age:.1f}h old: not due yet.")
                return
        except Exception:
            pass

    chosen = pick_briefing_inputs(items, tax)
    if len(chosen) < 5:
        log("Too few stories for a briefing.")
        return
    valid_ids = {it["id"] for it in chosen}
    topics = [f'{t["id"]} ({s["label"]}: {t["label"]})' for s in tax["sections"] for t in s["topics"]]
    lines = []
    for it in chosen:
        lines.append(f'[{it["id"]}] {it["sourceName"]} ({it["lean"]}) | {it["date"][:16]} | tags: {",".join(it["tags"][:3])}\n'
                     f'  {it["title"]}\n  {it["summary"][:180]}')
    user = (f"Today is {NOW.strftime('%A %d %B %Y')}.\nTopic ids: {'; '.join(topics)}\n\n"
            f"Stories (id, outlet and its broad lean, time, tags, headline, summary):\n\n" + "\n".join(lines))
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]
    try:
        model, content = call_models(messages)
        b = extract_json(content)
    except Exception as e:  # noqa: BLE001
        log("Briefing failed, keeping previous one:", e)
        return

    # Validate: keep only stories grounded in supplied items
    stories = []
    for s in b.get("stories", []) if isinstance(b.get("stories"), list) else []:
        if not isinstance(s, dict):
            continue
        srcs = [x for x in _ids(s.get("sources")) if x in valid_ids]
        if not srcs or not s.get("title"):
            continue
        s["sources"] = srcs
        s["perspectives"] = [p for p in (s.get("perspectives") or []) if isinstance(p, dict) and p.get("text")][:3]
        stories.append(s)
    if len(stories) < 3:
        log("Briefing had too few grounded stories; keeping previous one.")
        return
    b["stories"] = stories
    for k in ("compare", "ideas_lens"):
        if isinstance(b.get(k), dict):
            b[k]["sources"] = [x for x in _ids(b[k].get("sources")) if x in valid_ids]
    by_id = {it["id"]: it for it in chosen}
    refs = {}
    for s in stories + [b.get("compare") or {}, b.get("ideas_lens") or {}]:
        for x in s.get("sources", []):
            it = by_id[x]
            refs[x] = {k: it[k] for k in ("id", "title", "link", "source", "sourceName", "lean", "date")}
    out = {"generated_at": iso(NOW), "model": model, "briefing": b, "refs": refs,
           "disclaimer": "AI-written summary of the linked reporting. Always read the original sources."}
    BRIEFING_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1))
    log(f"Briefing written with {model}: {len(stories)} stories.")


# --------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-briefing", action="store_true")
    ap.add_argument("--force-briefing", action="store_true")
    args = ap.parse_args()

    DATA.mkdir(exist_ok=True)
    sources = json.loads(Path(os.environ.get("SOURCES_FILE", ROOT / "scripts" / "sources.json")).read_text())["sources"]
    tax = json.loads((ROOT / "taxonomy.json").read_text())
    tagger = Tagger(tax)
    src_by_id = {s["id"]: s for s in sources}

    old_items = {}
    if NEWS_FILE.exists():
        try:
            for it in json.loads(NEWS_FILE.read_text()).get("items", []):
                old_items[it["id"]] = it
        except Exception:
            pass

    health = []
    fresh = {}
    with cf.ThreadPoolExecutor(12) as ex:
        for src, items, err in ex.map(fetch, sources):
            health.append({"id": src["id"], "ok": err is None and len(items) > 0, "count": len(items), "error": err})
            log(f'{src["id"]:<13} {"OK " if not err else "ERR"} {len(items):>3} {err or ""}')
            for raw in items:
                d = raw["date"] or NOW
                if d > NOW + dt.timedelta(hours=2):
                    d = NOW
                iid = hashlib.sha1(raw["link"].encode()).hexdigest()[:12]
                region = tagger.region_for(src, raw["title"], raw["summary"])
                tags = tagger.tag(src, raw["title"], raw["summary"], region)
                prev = old_items.get(iid)
                fresh[iid] = {
                    "id": iid,
                    "title": raw["title"],
                    "link": raw["link"],
                    "summary": raw["summary"],
                    "author": raw["author"],
                    "date": prev["date"] if prev and not raw["date"] else iso(d),
                    "source": src["id"],
                    "sourceName": src["name"],
                    "lean": src["lean"],
                    "type": src["type"],
                    "region": region,
                    "nation": tagger.nation(src, raw["title"], raw["summary"], region),
                    "tags": tags,
                }

    # merge with previous run so stories persist after they drop out of a feed
    merged = dict(old_items)
    merged.update(fresh)
    items = []
    for it in merged.values():
        if it["source"] not in src_by_id:
            continue
        d = parse_iso(it["date"])
        if not d:
            continue
        age_days = (NOW - d).total_seconds() / 86400
        keep = KEEP_DAYS_TAGGED if it["tags"] else KEEP_DAYS_UNTAGGED
        if age_days <= keep:
            it.pop("cluster", None)
            items.append(it)
    items.sort(key=lambda x: x["date"], reverse=True)
    cluster(items)

    ok = sum(1 for h in health if h["ok"])
    if ok == 0 and old_items:
        log("Every feed failed; leaving previous data in place.")
        sys.exit(0)

    NEWS_FILE.write_text(json.dumps({
        "generated_at": iso(NOW),
        "sources": sources,
        "health": health,
        "items": items,
    }, ensure_ascii=False, separators=(",", ":")))
    log(f"{len(items)} stories written ({ok}/{len(sources)} feeds OK).")

    if not args.no_briefing:
        build_briefing(items, tax, force=args.force_briefing)


if __name__ == "__main__":
    main()
