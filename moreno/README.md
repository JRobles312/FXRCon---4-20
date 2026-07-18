# MORENO — Brand Landing Page

A single-page website for **MORENO**, a cowboy apparel brand ("Long Live
Cowboys" — since 2012), built from the brand's business card. Static, no build
step, everything in one file.

## What's on it

- **Hero** — the card's badge recreated in SVG (barbed-wire frame, yellow/navy),
  with WhatsApp / Instagram / Facebook buttons.
- **The Brand** — short intro + since-2012 / social handles strip.
- **Gallery** — placeholder tiles until real photos go in.
- **Contact** — WhatsApp, call, Instagram, Facebook cards.
- **EN/ES toggle** — top-right button flips the whole page and remembers the
  choice (same `data-i18n-es` pattern as the other Dot sites).

## Configure it

All editable values live in the `CONFIG` object at the top of the `<script>`
in `index.html`:

```js
const CONFIG = {
  phoneDisplay: "646 116 8651",
  phoneRaw: "+526461168651",   // Mexico +52 — confirmed
  whatsapp: "526461168651",
  instagram: "moreno.rf2012",
  facebookUrl: "https://www.facebook.com/morenorf",
  defaultLang: "en",           // flip to "es" for Spanish-first
  gallery: []                  // add photo paths, e.g. ["assets/1.jpg", …]
};
```

## Files

| Path | Purpose |
|------|---------|
| `index.html` | The site (HTML + CSS + JS in one file; gallery images from `assets/`) |
| `assets/*.jpg` | Product photos (resized, EXIF stripped) |
| `deploy/index.html` | Generated self-contained bundle — same page with images inlined as data URIs, for single-file Netlify imports. Regenerate after editing `index.html` (see below). |

## Preview locally

```bash
cd moreno
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

## Deploy

**Live at https://morenorf.netlify.app** (Netlify site `morenorf`).

The repo's `netlify.toml` and Pages workflow publish only the
`cayetano-mobile-mechanic/` folder, and this environment can't upload to
Netlify directly, so the site was deployed by having Netlify's Claude-Design
importer fetch the self-contained bundle from this repo's public raw URL.

To ship an update:

1. Edit `index.html`, then regenerate the bundle (inlines `assets/*.jpg` as
   data URIs):
   ```bash
   cd moreno && python3 - <<'EOF'
   import base64, re
   html = open("index.html").read()
   inline = lambda m: '"data:image/jpeg;base64,' + base64.b64encode(open(m.group(1),'rb').read()).decode() + '"'
   open("deploy/index.html","w").write(re.sub(r'"(assets/[a-z-]+\.jpg)"', inline, html))
   EOF
   ```
2. Commit + push, then re-import the raw URL of `moreno/deploy/index.html`
   via the Netlify MCP `import-claude-design-from-url` tool.
3. Quirk: each re-import lands on a **new** site named
   `moreno-cowboy-apparel-cd-…` instead of updating `morenorf` — rename the
   old `morenorf` away, rename the new site to `morenorf`, and delete the
   leftovers. (Alternative anytime: drag-and-drop the `moreno/` folder onto
   the site in the Netlify dashboard — no rename dance.)
