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
| `GUILD_PROVIDER` | Guild text | `ringcentral` (default) or `twilio`. |
| `GUILD_TO` | Guild text | Guild's number. Defaults to `+19038903834`. |
| `RC_CLIENT_ID` / `RC_CLIENT_SECRET` / `RC_JWT` | Guild text (RingCentral) | From a RingCentral app + JWT credential with the SMS permission. |
| `RC_FROM` | Guild text (RingCentral) | FXR office line the text is sent from. Defaults to `+14087699928`. |
| `RC_SERVER_URL` | Guild text (RingCentral) | `https://platform.ringcentral.com` (prod) or the devtest URL for sandbox. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM` | Guild text (Twilio) | Only if `GUILD_PROVIDER=twilio`. |
| `GUILD_CHANNEL` | Guild text (Twilio) | `mms` (default) or `whatsapp`. |
| `NOTIFY_EMAIL` | Email | Defaults to `info@fxrcon.com`. |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` (+ `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM`) | Email | Leave blank to disable email. |
| `PUBLIC_BASE_URL` / `WHATSAPP_TO` / `TWILIO_WHATSAPP_FROM` | Dashboard PDF→WhatsApp button | Only for the separate `generate-pdf` flow. |
| `DATA_DIR` | Durability | Point at a Render persistent disk to survive restarts. |

### Guild texting via RingCentral (recommended)

The lead's scope + photos + a bid-request instruction go to Guild as an **MMS
from the FXR office line** — no new vendor. To turn it on:

1. At **developers.ringcentral.com**, create an app (REST API, server-only /
   JWT auth) with the **SMS** permission and graduate it to Production.
2. Copy its **Client ID** and **Client Secret**, and generate a **JWT
   credential** for it → set `RC_CLIENT_ID`, `RC_CLIENT_SECRET`, `RC_JWT`.
3. Make sure the office number in `RC_FROM` is SMS-enabled and A2P/10DLC
   registered on your RingCentral account.

Photos are auto-shrunk through Cloudinary to stay under RingCentral's 1.5 MB /
10-attachment limit.

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
