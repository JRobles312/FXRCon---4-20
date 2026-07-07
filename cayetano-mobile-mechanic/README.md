# Ramirez Mobile Mechanic — Website & Phone App

A single-page website + installable phone app (PWA) for Ramirez, a mobile
mechanic serving the **San Jose** area. Oil changes and gas engine repair
(no diesel). Everything runs client-side — no server or database required.

## Features

- **Home / Services** — hero, service list, and the makes & models worked on.
- **Our Work** — photo gallery with placeholder tiles (drop in real photos anytime).
- **Book** — a working calendar. Clients pick an open day + time and submit a
  request. Ramirez can **log in ("Mechanic login")** to block whole days,
  block individual hours, and view/remove bookings.
- **Oil Reminders** — clients enter their last oil change + oil type; the app
  estimates the next due date, offers an **"Add to Google Calendar"** link, and
  can save the reminder for Ramirez to follow up.
- **Pay** — Zelle-based. Shows Ramirez Zelle recipient with a copy button
  and step-by-step instructions, plus in-person (cash) options.
- **Contact** — name/phone/email/message **with photo upload** that goes to
  Ramirez email.
- **Clients (mechanic-only)** — a client book behind the mechanic PIN:
  - Add clients with full **vehicle details** (year, make, model, color, plate,
    mileage, VIN) — always viewable and searchable in the app.
  - **Save to phone / Google Contacts** — exports a `.vcf` vCard the phone
    imports into Contacts (vehicle details ride along in the note).
  - **Log each service performed** (oil change, brakes, etc.). Logging a
    service with a follow-up interval **auto-schedules a reminder** — an oil
    change today creates a "due again in 3 months" follow-up.
  - **Follow-ups dashboard** — every client's next due service, color-coded
    (overdue / due soon / on track), with one tap to **text the customer** a
    reminder + booking link, or **Schedule** it straight onto the calendar.
  - **Booking calendar** shows client requests as *Requested* for Ramirez to
    **Confirm**; he can also add confirmed appointments himself.
- **Parts & Estimates (mechanic-only)** — a parts catalog + quote builder:
  - **Parts catalog** with his cost, customer price, and margin. Each part has
    one-tap **live price checks** that open searches at **AutoZone, O'Reilly,
    NAPA, Advance Auto, and RockAuto** for current pricing.
  - **Quick price check** — type any part name/number and open it at each store.
  - **Estimate builder** — add labor + parts (from the catalog) for a client,
    auto-totals with parts tax, then **text the estimate** to the customer or
    **print/PDF** it.
- **Bilingual (English / Spanish)** — an **EN/ES** button in the top nav flips
  the whole site — customer pages *and* the mechanic tools — and remembers the
  choice. Dates, the calendar, and follow-up intervals localize too.
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
  name: "Ramirez",
  phone: "(408) 555-0123",          // shown on the site
  phoneRaw: "+14085550123",         // used by call/text links
  email: "ramirez@example.com",    // where the contact form is delivered
  adminPin: "0420",                 // PIN for "Mechanic login" on the Book page
  formEndpoint: "",                 // see "Contact form" below
  pay: { zelle:"", zelleName:"Ramirez" },    // Zelle recipient (email or phone)
  bookingHours: [8,9,10,11,13,14,15,16,17],   // bookable hours (24h)
  serviceTypes: [ {name:"Oil change", followupMonths:3}, … ], // reminder intervals
  laborRate: 90, taxRate: 9.125,              // estimate defaults ($/hr, parts tax %)
  partSuppliers: [ {name:"AutoZone", url:"…{q}…"}, … ], // live price-check links
  parts: [ … ],                               // starter catalog (editable in-app)
  vehicles: [ ... ],                // makes/models on the home page
  gallery:  [ ... ]                 // work photos (add `img:"url"` to show a real photo)
};
```

### Contact form (photo upload → email)
By default, submitting the contact form opens the visitor's email app with the
message pre-filled to Ramirez. Email links can't carry photo attachments, so
the app reminds the visitor to attach their photos manually.

For **automatic delivery including photos**, create a free form at
[formspree.io](https://formspree.io), then paste its endpoint into
`CONFIG.formEndpoint` (looks like `https://formspree.io/f/abcdwxyz`). Photos are
then emailed straight to Ramirez — no manual attaching needed.

### Privacy — email & Zelle are shielded
Ramirez **email is never shown as text** and there's no static `mailto:`
link in the HTML — the "Email us" buttons build the message in JavaScript on
tap, so bots that scrape visible text or `mailto:` links can't harvest it. His
**Zelle number is masked** on the Pay page (`(•••) •••-3204`); customers tap
**Reveal** to see it or **Copy** to paste it into their bank app. Both values
live only in the `CONFIG` block (needed to function); update them there.

### Payments (Zelle)
Payments are received by **Zelle**. In `CONFIG.pay`, set `zelle` to the email
address or phone number Ramirez Zelle is registered to (e.g.
`"ramirez@example.com"` or `"(408) 555-0123"`), and optionally `zelleName`.
While `zelle` is empty, the Pay page shows a "coming soon" placeholder.

Zelle has no payment link — clients send money from their own bank app — so the
page displays the recipient with a **Copy** button and clear step-by-step
instructions. The amount/note fields are shown as a reminder for the client to
enter in their bank app.

### Translations (English / Spanish)
Every visible string carries its Spanish inline: static text via a
`data-i18n-es="…"` attribute on the element (English stays as the default
content), and dynamic/JS strings via a `t('English','Español')` helper. To fix
or tweak wording, edit the Spanish right where the English lives — there's no
separate translation file to keep in sync. `CONFIG.hoursEs` holds the Spanish
hours, and service-type names are mapped in the `SVC_ES` object near the top of
the script.

### Parts pricing — how the "live" price check works
The big local chains (AutoZone, O'Reilly, NAPA, Advance) don't offer a public
pricing API, so the app links **out** to each store's live search for the part
number/name — giving current pricing in one tap without any paid account. If
Ramirez later gets a **PartsTech** account (an aggregator with a real
parts-ordering API for shops), true in-app wholesale pricing can be added behind
a small serverless proxy; the store links here keep it useful in the meantime.
Edit `CONFIG.partSuppliers` if any store changes its search URL format.

### About the calendar & client data
Blocked days, hours, bookings, saved reminders, **and the client book** are
stored **in the browser on each device** (localStorage). That's perfect for a
single phone/tablet that Ramirez uses as his business device. Two implications:
- Use one main device for the Clients book (or export vCards to keep contacts on
  his phone, which the app already does).
- Reminder **texts are one-tap, not automatic** — the app surfaces who's due and
  pre-writes the SMS, and Ramirez taps send. To sync across devices or send
  reminders automatically, wire the hooks to a small backend or Zapier/Google
  Sheets later. The functions to hook are `submitBooking()`, `saveService()`
  (creates follow-ups), `textReminder()`, and `submitContact()`.

## Run / preview locally

```bash
cd ramirez-mobile-mechanic
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
