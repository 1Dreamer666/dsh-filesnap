# FileSnap documentation website

A bilingual static documentation site for the DSH plugin. The homepage and quick start are written for the website; comparison, architecture, deduplication, ecosystem, roadmap and troubleshooting pages render directly from the existing bilingual Markdown documents. Keep product facts in those sources.

## Local development

From the repository root:

```sh
npm ci --prefix site --ignore-scripts
npm run --prefix site build
npm run --prefix site check
npm run --prefix site preview
```

Open `http://localhost:4174/dsh-filesnap/`. The preview server serves the built output; rebuild after changes. `PORT` overrides 4174. Node 22 or later is needed for the website builder. Website dependencies and output are separate from the published plugin package.

## GitHub Pages deployment

1. In the repository's **Settings → Pages → Build and deployment**, select **GitHub Actions** as the source. This one-time repository setting must exist before `configure-pages` runs.
2. Commit and push the site and `pages.yml` workflow. A change to site, docs or assets on `main` builds and deploys the site. Pull requests only build and validate; they do not deploy. The workflow can also run manually.
3. Open the deployed URL shown in the **Documentation site** workflow's `github-pages` environment. Check both languages, navigation, copy, search, screenshots and video loading.

The build reads `SITE_URL` from `actions/configure-pages` and derives all asset, navigation, canonical and sitemap paths from it. The local default is `https://extracurricular.ai/dsh-filesnap/`, matching the existing organization site's custom domain. GitHub's actual Pages URL is authoritative: do not change the parent site's domain or add a project CNAME merely to match the preview. A project with a different Pages URL can build with, for example:

```sh
SITE_URL=https://extracurricular-ai.github.io/dsh-filesnap npm run --prefix site build
```

Reference: [GitHub's custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Search and content

- Sixteen static HTML pages: eight routes in English and Chinese. Navigation and content work without JavaScript. JavaScript adds local search, copy buttons, workflow tabs and user-loaded video players.
- Each translated route has a unique title/description, canonical, reciprocal hreflang, social image and structured metadata. `sitemap.xml` lists the localized canonical routes. The root entry redirects to English and offers both language links.
- A project-path `robots.txt` cannot control the domain root, so no misleading project robots file is generated. After deployment, inspect the domain's existing robots policy and submit the project sitemap through the relevant Search Console property.
- Search uses a same-origin per-language JSON index, with no analytics or third-party search service. YouTube/Bilibili load only after the user presses the player's load button.
- The blog tutorial and project quick start have different copy and roles; each keeps its own canonical. Link between them rather than duplicating the complete article.
- Reuse the existing approved whale-girl cover and actual screenshots. The homepage stepper is an explanation, not a live DSH session or a benchmark.
- Do not mark planned roadmap items as supported features. Keep the raw-log preservation qualification beside the visible-history warning and the data-retention statement beside uninstall limitations.

Website release verification belongs in the promotion tracker. A successful build does not establish deployment, search indexing or third-party player availability.
