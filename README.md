# Scrutiny — politics, weighed properly

A phone app (installable web app) that brings balanced, verified politics news to an AQA A-level Politics (7152) student, filed under the course:

- **UK Government**: constitution, Parliament, PM & cabinet, judiciary, devolution
- **UK Politics**: democracy & participation, elections & referendums, parties, pressure groups, the EU
- **US Politics**: constitution, Congress, the President, the courts, elections & direct democracy, parties, pressure groups, civil rights
- **Political Ideas**: liberalism, conservatism, socialism + the student's fifth ideology (asked once, remembered on the phone)
- **Compare**: UK and US coverage side by side for constitutions, legislatures, executives, courts, elections, parties, pressure groups and civil rights

Every section shows the student's **saved stories** first, then the latest matching stories. The **Today** tab has the *Commentator's Briefing*: an AI-written, balanced daily analysis with arguments on each side, key terms, essay use and an exam practice question.

## Sources

About 26 feeds chosen for balance and reliability: BBC (incl. Scotland, Wales, NI), Sky, Guardian, Telegraph, New Statesman, PoliticsHome, Nation.Cymru, Politico Europe, NPR, PBS, The Hill, Christian Science Monitor, National Review; plus non-partisan Institute for Government, House of Commons Library, UK in a Changing Europe, LSE, The Conversation, SCOTUSblog, Full Fact and FactCheck.org. Edit `scripts/sources.json` to change them. The Settings screen shows which feeds are live.

## How it works

- `.github/workflows/update.yml` runs every 2 hours (06:00–midnight UK). It runs `scripts/build_news.py`, which fetches the feeds, tags stories with `taxonomy.json` keywords, groups stories several outlets are covering, and saves `data/news.json`.
- A few times a day it writes `data/briefing.json` using a free AI API: **Groq** (model `openai/gpt-oss-120b`), with **OpenRouter** as an optional backup. Any story that isn't grounded in a real fetched article is thrown away.
- The site is then published to GitHub Pages.

## One-time setup

1. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
2. **Settings → Secrets and variables → Actions → New repository secret:** `GROQ_API_KEY` (free key from console.groq.com). Optional backup: `OPENROUTER_API_KEY` (free key from openrouter.ai).
3. **Actions tab → "Update news and publish" → Run workflow** (tick *force briefing* the first time).
4. Open `https://sbhogaita19.github.io/scrutiny/` on the phone:
   - iPhone (Safari): Share → **Add to Home Screen**
   - Android (Chrome): menu → **Install app**

If the briefing ever stops appearing, check the latest Actions run log for a "model error" line. The models tried are set by `PROVIDERS` in the script (or `GROQ_MODELS` / `OPENROUTER_MODELS` environment variables).
