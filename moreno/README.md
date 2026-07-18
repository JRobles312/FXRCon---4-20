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

## Still open

- **Gallery photos** — the plan is to use photos from the brand's Facebook page
  (facebook.com/morenorf); drop them into `assets/` and list them in
  `CONFIG.gallery`.

## Preview locally

```bash
cd moreno
python3 -m http.server 8080
# open http://127.0.0.1:8080/
```

## Deploy

Any static host — Netlify, GitHub Pages, Vercel, Cloudflare Pages. Note the
repo's existing `netlify.toml` and Pages workflow publish the
`cayetano-mobile-mechanic/` folder only; give Moreno its own Netlify site
(publish dir `moreno`) or extend the workflow when it's ready to go live.
