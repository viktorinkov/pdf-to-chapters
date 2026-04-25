# Deployment

## Recommended path: $0/month

walnut is a **local-first** tool. The Python backend, the local LLM (Ollama), and the user's PDFs all live on the user's machine. There is no shared multi-tenant compute to host.

That makes deployment a two-part problem and the cheapest answer is **free**:

1. **Tool distribution** — publish to **PyPI** and **GitHub**. Users install with `uvx walnut`.
2. **Marketing/landing site** — static page on **Cloudflare Pages** or **GitHub Pages**. Free forever, no egress charges, no DNS fees if you use a `*.pages.dev` or `*.github.io` subdomain.

**Total monthly cost: $0** for the recommended path.

Custom domain: $8–12/year for a `.com` (Cloudflare Registrar at-cost) — optional.

---

## Part 1 — Distribute the tool (PyPI + GitHub)

### One-time setup

```bash
# 1. Create a GitHub repo
gh repo create viktorminchev/walnut --public --source=. --remote=origin --push

# 2. Register on PyPI (free) and create an API token at https://pypi.org/manage/account/token/

# 3. Add the token to your GitHub repo as a secret named PYPI_API_TOKEN
gh secret set PYPI_API_TOKEN
```

### Release workflow

Create `.github/workflows/release.yml`:

```yaml
name: release
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v3
      - run: uv build
      - run: uv publish
        env:
          UV_PUBLISH_TOKEN: ${{ secrets.PYPI_API_TOKEN }}
      - uses: softprops/action-gh-release@v2
        with:
          files: dist/*
          generate_release_notes: true
```

To cut a release:

```bash
git tag v0.0.1
git push origin v0.0.1
```

GitHub Actions builds the wheel + sdist and publishes them to PyPI for free. Users then install with `uvx walnut` or `uv tool install walnut`.

**GitHub Actions free tier:** 2,000 minutes/month for public repos (effectively unlimited for a release every few weeks).

**PyPI:** free, no quota for sane use.

---

## Part 2 — Host the landing/about site

The website that visitors see needs three things: a 1-paragraph "what is this", an install command they can copy, and a link to the GitHub repo. Build a single static HTML file and host it free.

### Option A — Cloudflare Pages (recommended, free)

```bash
# Make a small landing-site directory
mkdir -p site
# (Build a single index.html — you already have the design language nailed
#  in walnut/web/style.css; reuse the palette + Fraunces brand mark.)

# Deploy via Wrangler CLI (free) or via the dashboard (drag the folder in)
npm i -g wrangler
wrangler login
wrangler pages deploy site --project-name walnut
```

Pricing: **free tier covers 500 builds/month + unlimited bandwidth + unlimited requests.**
URL: `https://walnut.pages.dev` (or attach a custom domain for free, you only pay for the domain).

### Option B — GitHub Pages (also free)

Add `site/` to the repo and a workflow:

```yaml
# .github/workflows/pages.yml
name: pages
on:
  push: { branches: [main] }
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: { pages: write, id-token: write }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with: { path: ./site }
      - uses: actions/deploy-pages@v4
```

URL: `https://viktorminchev.github.io/walnut/`. Free, unlimited bandwidth.

**Cloudflare Pages > GitHub Pages** for one reason: it serves from Cloudflare's CDN with no rate limits on traffic, where GitHub Pages caps at 100 GB bandwidth/month and is "soft-throttled" beyond that. But for a hobby site either is fine.

### Landing page checklist (don't ship without these)

- One-line headline: "**walnut** — add chapter bookmarks to PDFs using a local LLM."
- One-paragraph explanation. Reuse the About modal text from `walnut/web/index.html` verbatim.
- Install command in a copyable block: `uvx walnut`.
- Screenshot or short looping animation of the tool in action (record yourself using it, save as a 2 MB MP4 or APNG).
- "Built by [Viktor Minchev](https://www.linkedin.com/in/viktor-minchev/)" footer with the LinkedIn link.
- No tracking, no analytics, no fake testimonials.
- Reuse the walnut palette + Fraunces serif from `walnut/web/static/style.css`.

---

## Part 3 — If you want a hosted demo too (~$0–5/month)

This is only worth doing if you want random visitors to try walnut without installing anything. It contradicts the "local-first" pitch (their PDFs go through your server) — so you may not want it. If you do:

### Architecture for a hosted demo

- **Frontend:** the existing `walnut/web/index.html` served from Cloudflare Pages.
- **Backend:** the existing FastAPI app on **Fly.io free tier** (3 shared-cpu-1x VMs with 256 MB RAM).
- **LLM:** swap Ollama for **Google Gemini 2.5 Flash** via `ai.google.dev` API.
  - Free tier as of April 2026: 15 RPM, 1,500 RPD, 1M tokens/day.
  - One PDF ≈ one TOC-mode call ≈ ~3k tokens. You get ~330 PDFs/day in free tier.
- **Storage:** ephemeral disk on the Fly VM. Cleaned hourly.

### Code changes needed

1. Add a `walnut/llm_gemini.py` module that mirrors the `OllamaClient` interface but calls Gemini's `generateContent` endpoint with the same JSON schema. The `format=` parameter has a Gemini equivalent (`responseMimeType: "application/json"` + `responseSchema`).
2. Pick the backend at startup based on env var `WALNUT_LLM_BACKEND=ollama|gemini`.
3. Move the Pydantic schema and prompts into a backend-agnostic module (already mostly the case in `walnut/schemas.py` and `walnut/llm.py`).

Estimated effort: ~half a day. Minimal change to the existing pipeline.

### Fly.io setup

```bash
brew install flyctl
fly auth signup
cd /Users/viktorminchev/Development/pdf-to-chapters
fly launch --name walnut-demo --region ord --no-deploy
# fly.toml is generated — set it to use a Dockerfile or buildpack
fly secrets set GEMINI_API_KEY=... WALNUT_LLM_BACKEND=gemini
fly deploy
```

Cost: free tier covers 3 shared-cpu-1x 256 MB VMs (the free allowance is per organization). One VM running 24/7 fits in the free tier. **$0/month** until you exceed the limits.

If traffic outgrows the free tier, the next step is `shared-cpu-1x@1024MB` at ~$3.19/month.

### Why not Render / Railway / Vercel?

- **Render free tier** spins down after 15 min of inactivity → cold start every time someone visits. Awful UX.
- **Railway free tier** has a $5 trial credit but auto-charges after.
- **Vercel** Python serverless functions have a 10s execution cap. PDF processing on a long book exceeds it.
- **Fly.io free tier** runs continuously and the cold-start is fast. Best fit for this workload.

---

## Recommended checklist for shipping today

```
[ ] git init && git add . && git commit -m "initial walnut implementation"
[ ] gh repo create viktorminchev/walnut --public --source=. --push
[ ] Register pypi.org account, create token, add as PYPI_API_TOKEN secret
[ ] Add .github/workflows/release.yml (above)
[ ] git tag v0.0.1 && git push origin v0.0.1
[ ] Create the landing site/ directory with one index.html
[ ] Cloudflare Pages: drag the folder into the dashboard or use wrangler
[ ] (Optional) Buy walnut.pdf or similar domain via Cloudflare Registrar (~$10/yr)
[ ] (Optional) Record a 30-second screen capture of walnut running locally
```

If you stop after the landing page step: total spend = $0.
If you add the custom domain: total spend = ~$10/year.
If you add a hosted demo on Fly.io + Gemini free tier: total spend = $0/month while under quota.

That's the cheapest credible path: free tool distribution via PyPI, free static landing on Cloudflare Pages, optional free hosted demo via Fly.io + Gemini.
