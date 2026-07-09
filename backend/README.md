# FXR Sales Leads — backend

Door-to-door lead intake for the field sales crew. Receives submissions from
`sales.html`, stores them, shows them in `sales-admin.html`, and — on a button
press — builds a PDF and delivers it to WhatsApp for forwarding to Guild.

## What it exposes

Mounted at `/api/sales-leads`:

| Method | Path                     | Purpose                                             |
|--------|--------------------------|-----------------------------------------------------|
| POST   | `/api/sales-leads`       | Create a lead (tagged `source: "door-to-door"`)     |
| GET    | `/api/sales-leads`       | List leads, newest first (dashboard)                |
| POST   | `/api/sales-leads/:id/generate-pdf` | Build PDF → send to WhatsApp via Twilio   |
| GET    | `/api/sales-leads/:id/pdf` | Public PDF stream (this is the Twilio `MediaUrl`) |

Door-to-door leads are tagged `source: "door-to-door"` so they stay separate
from the existing web funnel (`/api/submit-lead`).

## Two ways to run it

### A) Add to your existing Render Express app (recommended)

The intake is a self-contained Express **Router**. In the app that already
serves `/api/submit-lead`, add two lines:

```js
const salesLeads = require('./sales-leads');   // copy sales-leads.js next to your server file
app.use('/api/sales-leads', salesLeads);
```

Make sure your app has `express.json()` and `cors` enabled (it already does if
`/api/submit-lead` works from the browser). Then add the dependencies:

```
npm install pdfkit twilio nodemailer
```

### B) Run it standalone

If you'd rather run it as its own service:

```
cd backend
npm install
npm start          # listens on $PORT (Render sets this) or 3000
```

`server.js` wires up CORS + JSON body parsing and mounts the router.

## Environment variables (Render → Environment)

See `.env.example`. Only Twilio and SMTP need real values; everything else has
a working default.

| Var | Needed for | Notes |
|-----|-----------|-------|
| `PUBLIC_BASE_URL` | WhatsApp | Public URL of this API; used to build the PDF link Twilio fetches. |
| `WHATSAPP_TO` | WhatsApp | Defaults to `+14087699928`. |
| `NOTIFY_EMAIL` | Email | Defaults to `info@fxrcon.com`. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | WhatsApp | Leave blank until Twilio is set up. |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` (+ `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`) | Email | Leave blank to disable email. |
| `DATA_DIR` | Durability | Point at a Render persistent disk to survive restarts. |

## Storage & the Render free tier

v1 stores leads in a flat JSON file under `DATA_DIR` (default `./data`). On
Render's free tier the filesystem is **ephemeral** — it's wiped on redeploy and
on idle spin-down. That's acceptable for v1 because every new lead also emails
`info@fxrcon.com`, so nothing is ever truly lost. To make it durable, either
attach a Render persistent disk and set `DATA_DIR` to it, or replace the four
store helpers (`loadLeads` / `saveLeads` / `getLead` / `updateLead`) at the top
of `sales-leads.js` with calls to whatever database your main app already uses.

## The WhatsApp reality (important)

Twilio WhatsApp needs an approved business sender before it will push media to a
number. The **sandbox** works for testing but the target number must first join
the sandbox (send the join code to Twilio's sandbox number) and the session
expires after 24h of inactivity.

The endpoint is built so this is never a wall:
- `generate-pdf` **always** builds the PDF and **always** emails the link to
  `info@fxrcon.com`, regardless of Twilio.
- If Twilio is configured and succeeds, the response is `whatsapp.sent: true`.
- If Twilio isn't ready, the response is `whatsapp.sent: false` with a reason,
  and the **fallback** is exactly what was planned: open the emailed PDF and
  forward it into WhatsApp manually — one extra tap, same result.

No secrets are hardcoded — Twilio and SMTP credentials come only from
environment variables.
