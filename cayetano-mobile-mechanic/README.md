# Cayetano's Mobile Mechanic — Website & Phone App

A single-page website + installable phone app (PWA) for Cayetano, a mobile
mechanic serving the **San Jose** area. Oil changes and gas engine repair
(no diesel). Everything runs client-side — no server or database required.

## Features

- **Home / Services** — hero, service list, and the makes & models worked on.
- **Our Work** — photo gallery with placeholder tiles (drop in real photos anytime).
- **Book** — a working calendar. Clients pick an open day + time and submit a
  request. Cayetano can **log in ("Mechanic login")** to block whole days,
  block individual hours, and view/remove bookings.
- **Oil Reminders** — clients enter their last oil change + oil type; the app
  estimates the next due date, offers an **"Add to Google Calendar"** link, and
  can save the reminder for Cayetano to follow up.
- **Pay** — Zelle-based. Shows Cayetano's Zelle recipient with a copy button
  and step-by-step instructions, plus in-person (cash) options.
- **Contact** — name/phone/email/message **with photo upload** that goes to
  Cayetano's email.
- **Installable app** — "Add to Home Screen" on a phone; works offline.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The entire website & app (HTML + CSS + JS in one file) |
| `manifest.json` | Makes it installable as a phone app |
| `sw.js` | Service worker for offline support |
| `assets/icon-192.png`, `icon-512.png` | App icons |

## Configure it (all placeholders live in one place)

Open `index.html` and edit the `CONFIG` object near the top of the `<script>`:

```js
const CONFIG = {
  name: "Cayetano",
  phone: "(408) 555-0123",          // shown on the site
  phoneRaw: "+14085550123",         // used by call/text links
  email: "cayetano@example.com",    // where the contact form is delivered
  adminPin: "0420",                 // PIN for "Mechanic login" on the Book page
  formEndpoint: "",                 // see "Contact form" below
  pay: { zelle:"", zelleName:"Cayetano" },    // Zelle recipient (email or phone)
  bookingHours: [8,9,10,11,13,14,15,16,17],   // bookable hours (24h)
  vehicles: [ ... ],                // makes/models on the home page
  gallery:  [ ... ]                 // work photos (add `img:"url"` to show a real photo)
};
```

### Contact form (photo upload → email)
By default, submitting the contact form opens the visitor's email app with the
message pre-filled to Cayetano. Email links can't carry photo attachments, so
the app reminds the visitor to attach their photos manually.

For **automatic delivery including photos**, create a free form at
[formspree.io](https://formspree.io), then paste its endpoint into
`CONFIG.formEndpoint` (looks like `https://formspree.io/f/abcdwxyz`). Photos are
then emailed straight to Cayetano — no manual attaching needed.

### Payments (Zelle)
Payments are received by **Zelle**. In `CONFIG.pay`, set `zelle` to the email
address or phone number Cayetano's Zelle is registered to (e.g.
`"cayetano@example.com"` or `"(408) 555-0123"`), and optionally `zelleName`.
While `zelle` is empty, the Pay page shows a "coming soon" placeholder.

Zelle has no payment link — clients send money from their own bank app — so the
page displays the recipient with a **Copy** button and clear step-by-step
instructions. The amount/note fields are shown as a reminder for the client to
enter in their bank app.

### About the calendar data
Blocked days, hours, bookings, and saved reminders are stored **in the browser
on each device** (localStorage). That's perfect for a single phone/tablet that
Cayetano uses. If he needs the calendar synced across multiple devices, or
clients' bookings to reach him automatically, wire the booking/reminder actions
to a small backend or a service like Formspree/Zapier/Google Sheets later — the
functions to hook are `submitBooking()`, `saveReminder()`, and `submitContact()`.

## Run / preview locally

```bash
cd cayetano-mobile-mechanic
python3 -m http.server 8080
# open http://127.0.0.1:8080/index.html
```

> The service worker and "install app" prompt require `http://` or `https://`
> (not opening the file directly).

## Deploy

Drop this folder onto any static host — **Netlify**, GitHub Pages, Vercel,
Cloudflare Pages, etc. No build step. Once it's on `https://`, visitors can
tap **Install** / "Add to Home Screen" to use it as a phone app.

## Mechanic login

On the **Book** page, tap **🔒 Mechanic login** and enter the PIN
(`CONFIG.adminPin`, default `0420`) to manage availability. Change the PIN
before going live.
