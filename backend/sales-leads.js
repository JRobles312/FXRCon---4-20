// ============================================================================
// FXR Construction — Door-to-Door Sales Lead intake router
// ----------------------------------------------------------------------------
// Drop-in Express Router. Mount it in the existing Render app:
//
//     const salesLeads = require('./sales-leads');
//     app.use('/api/sales-leads', salesLeads);
//
// Endpoints (relative to the /api/sales-leads mount point):
//     POST   /                  create a lead   (source tagged "door-to-door")
//     GET    /                  list leads       (newest first)
//     POST   /:id/generate-pdf  build PDF + send to WhatsApp via Twilio
//     GET    /:id/pdf           public PDF stream (this is the Twilio MediaUrl)
//
// Every outbound integration (email, Twilio, PDF hosting) is best-effort and
// reported back in the JSON response, so a missing credential never hard-fails
// the endpoint — it just shows up as { sent: false, reason: "..." }.
//
// Requires Node 18+ (uses the global fetch).
// ============================================================================

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const PDFDocument = require('pdfkit');

const router = express.Router();

// ---------------------------------------------------------------------------
// Config (all secrets come from Render environment variables — none hardcoded)
// ---------------------------------------------------------------------------
const PUBLIC_BASE_URL   = process.env.PUBLIC_BASE_URL   || 'https://fxrcon-construction.onrender.com';
const WHATSAPP_TO       = process.env.WHATSAPP_TO        || '+19038903834';   // Guild's WhatsApp number (PDF-send route)
const NOTIFY_EMAIL      = process.env.NOTIFY_EMAIL       || 'jesus@fxrcon.com';

const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID   || '';
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN    || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';          // e.g. whatsapp:+14155238886 (sandbox)

// --- Guild bid-request text (fires on new lead) ---
const GUILD_PROVIDER = (process.env.GUILD_PROVIDER || 'none').toLowerCase(); // 'none' (default) | 'ringcentral' | 'twilio'
const GUILD_TO       = process.env.GUILD_TO      || '+19038903834';            // Guild's number
const GUILD_CHANNEL  = (process.env.GUILD_CHANNEL || 'mms').toLowerCase();      // Twilio only: 'mms' | 'whatsapp'
const TWILIO_FROM    = process.env.TWILIO_FROM   || TWILIO_WHATSAPP_FROM || ''; // Twilio sending number

// RingCentral (send the Guild MMS from the FXR office line, no new vendor).
const RC_SERVER_URL    = process.env.RC_SERVER_URL    || 'https://platform.ringcentral.com';
const RC_CLIENT_ID     = process.env.RC_CLIENT_ID     || '';
const RC_CLIENT_SECRET = process.env.RC_CLIENT_SECRET || '';
const RC_JWT           = process.env.RC_JWT           || '';
const RC_FROM          = process.env.RC_FROM          || '+14087699928';        // FXR office RingCentral line

// --- JobTread (push the lead into the CRM on submit) ---
const JT_GRANT_KEY = process.env.JT_GRANT_KEY || '';                 // secret; server-side only
const JT_ORG_ID    = process.env.JT_ORG_ID    || '22PKKRUxRtz8';     // FXR organization id

// ---------------------------------------------------------------------------
// Storage — flat JSON file. Simple, zero external services for v1.
//
// NOTE on Render free tier: the filesystem is ephemeral (wiped on redeploy and
// on idle spin-down). For v1 that's acceptable because every new lead also
// fires an email to info@fxrcon.com, so nothing is ever truly lost. To make it
// durable, point DATA_DIR at a Render persistent disk, or swap the four store
// helpers below for your existing database (Mongo/Postgres/etc.) — the rest of
// the router only touches leads through these four functions.
// ---------------------------------------------------------------------------
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sales-leads.json');
const PDF_DIR   = path.join(DATA_DIR, 'pdfs');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PDF_DIR, { recursive: true });
}
function loadLeads() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) { return []; }
}
function saveLeads(list) {
  ensureDirs();
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}
function getLead(id) { return loadLeads().find(l => l.id === id); }
function updateLead(id, patch) {
  const list = loadLeads();
  const i = list.findIndex(l => l.id === id);
  if (i === -1) return null;
  list[i] = Object.assign({}, list[i], patch);
  saveLeads(list);
  return list[i];
}

const newId = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ===========================================================================
// POST /  — create a new door-to-door lead
// ===========================================================================
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.ownerName || !b.address || !b.phone) {
      return res.status(400).json({ success: false, error: 'ownerName, address, and phone are required.' });
    }

    const lead = {
      id:        newId(),
      ownerName: String(b.ownerName).trim(),
      address:   String(b.address).trim(),
      phone:     String(b.phone).trim(),
      email:     String(b.email || '').trim(),
      workTypes: Array.isArray(b.workTypes) ? b.workTypes.slice(0, 20).map(s => String(s).trim()).filter(Boolean) : [],
      roof:      String(b.roof || '').trim(),
      sqft:      String(b.sqft || '').trim(),
      scope:     String(b.scope || '').trim(),
      photos:    Array.isArray(b.photos) ? b.photos.slice(0, 5) : [],
      photoCaptions: Array.isArray(b.photoCaptions) ? b.photoCaptions.slice(0, 5).map(s => String(s || '').trim()) : [],
      rep:       String(b.rep || '').trim(),
      source:    'door-to-door',            // keeps this flow separate from web /api/submit-lead
      status:    'new',                     // new | sent
      createdAt: new Date().toISOString(),
      sentAt:    null
    };

    const list = loadLeads();
    list.push(lead);
    saveLeads(list);

    // Build the PDF report and email it (with photos) to the office. This is
    // the deliverable Jesus forwards to Guild's WhatsApp.
    const email = await emailLeadReport(lead)
      .then(() => ({ sent: true }))
      .catch(e => ({ sent: false, reason: String(e.message || e) }));

    // Push the lead into JobTread (CRM) with photos attached.
    const jobtread = await pushToJobTread(lead);

    // Optional automated text to Guild (off by default; GUILD_PROVIDER=none).
    const guild = GUILD_PROVIDER === 'none' ? { sent: false, reason: 'disabled' } : await sendGuild(lead);
    if (guild.sent) updateLead(lead.id, { status: 'sent', sentAt: new Date().toISOString() });

    res.status(201).json({ success: true, id: lead.id, email, jobtread, guild, lead });
  } catch (err) {
    console.error('[sales-leads] create error', err);
    res.status(500).json({ success: false, error: 'Server error saving lead.' });
  }
});

// ===========================================================================
// POST /notify-guild  — stateless: text Guild the lead (scope + photos +
// instructions) WITHOUT storing it. Use this when email is handled elsewhere
// (e.g. Netlify Forms) and you only want the Guild bid-request text.
// ===========================================================================
router.post('/notify-guild', async (req, res) => {
  const b = req.body || {};
  if (!b.ownerName || !b.address || !b.phone) {
    return res.status(400).json({ success: false, error: 'ownerName, address, and phone are required.' });
  }
  const lead = {
    ownerName: String(b.ownerName).trim(),
    address:   String(b.address).trim(),
    phone:     String(b.phone).trim(),
    workTypes: Array.isArray(b.workTypes) ? b.workTypes.map(s => String(s).trim()).filter(Boolean) : [],
    roof:      String(b.roof || '').trim(),
    sqft:      String(b.sqft || '').trim(),
    scope:     String(b.scope || '').trim(),
    photos:    Array.isArray(b.photos) ? b.photos.slice(0, 10) : [],
    rep:       String(b.rep || '').trim()
  };
  const guild = await sendGuild(lead);
  res.status(guild.sent ? 200 : 502).json({ success: guild.sent, guild });
});

// ===========================================================================
// POST /push-jobtread  — stateless: create the lead in JobTread (with photos)
// WITHOUT storing/emailing. Use this when email is handled elsewhere (Netlify)
// and you just want the lead pushed into the CRM on Send.
// ===========================================================================
router.post('/push-jobtread', async (req, res) => {
  const b = req.body || {};
  if (!b.ownerName || !b.address || !b.phone) {
    return res.status(400).json({ success: false, error: 'ownerName, address, and phone are required.' });
  }
  const lead = {
    ownerName: String(b.ownerName).trim(),
    address:   String(b.address).trim(),
    phone:     String(b.phone).trim(),
    email:     String(b.email || '').trim(),
    workTypes: Array.isArray(b.workTypes) ? b.workTypes.map(s => String(s).trim()).filter(Boolean) : [],
    roof:      String(b.roof || '').trim(),
    sqft:      String(b.sqft || '').trim(),
    scope:     String(b.scope || '').trim(),
    photos:    Array.isArray(b.photos) ? b.photos.slice(0, 10) : [],
    photoCaptions: Array.isArray(b.photoCaptions) ? b.photoCaptions.map(s => String(s || '').trim()) : [],
    rep:       String(b.rep || '').trim()
  };
  const jt = await pushToJobTread(lead);
  res.status(jt.pushed ? 200 : 502).json({ success: jt.pushed, jobtread: jt });
});

// ===========================================================================
// GET /  — list leads, newest first (for the admin dashboard)
// ===========================================================================
router.get('/', (req, res) => {
  const list = loadLeads().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ success: true, count: list.length, leads: list });
});

// ===========================================================================
// POST /:id/generate-pdf  — build the PDF, host it, send to WhatsApp
// ===========================================================================
router.post('/:id/generate-pdf', async (req, res) => {
  const lead = getLead(req.params.id);
  if (!lead) return res.status(404).json({ success: false, error: 'Lead not found.' });

  try {
    ensureDirs();
    await buildPdf(lead, path.join(PDF_DIR, lead.id + '.pdf'));
    const pdfUrl = `${PUBLIC_BASE_URL}/api/sales-leads/${lead.id}/pdf`;

    // 1) Send to WhatsApp via Twilio (MediaUrl = the public PDF route above).
    const wa = await sendWhatsApp(lead, pdfUrl);

    // 2) Fallback / paper-trail: email the PDF link to the office either way.
    const mail = await sendEmail(
      `Lead PDF ready — ${lead.ownerName} (${lead.address})`,
      pdfEmailBody(lead, pdfUrl, wa)
    ).then(() => ({ sent: true })).catch(e => ({ sent: false, reason: String(e.message || e) }));

    const updated = updateLead(lead.id, {
      status: wa.sent ? 'sent' : lead.status,
      sentAt: wa.sent ? new Date().toISOString() : lead.sentAt
    });

    res.json({ success: true, pdfUrl, whatsapp: wa, email: mail, lead: updated });
  } catch (err) {
    console.error('[sales-leads] generate-pdf error', err);
    res.status(500).json({ success: false, error: 'Failed to generate or send PDF.', detail: String(err.message || err) });
  }
});

// ===========================================================================
// GET /:id/pdf  — public PDF stream (Twilio fetches this as the media)
// ===========================================================================
router.get('/:id/pdf', (req, res) => {
  const file = path.join(PDF_DIR, req.params.id + '.pdf');
  if (!fs.existsSync(file)) return res.status(404).send('PDF not found. Generate it first.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="FXR-Lead-${req.params.id}.pdf"`);
  fs.createReadStream(file).pipe(res);
});

// ===========================================================================
// PDF builder (pdfkit)
// ===========================================================================
const NAVY = '#0A1628', BLUE = '#2196F3', SLATE = '#5A6B8C', GOLD = '#FF8F00';

// Draw the whole report onto a pdfkit doc (shared by the file + buffer builders).
async function renderPdf(doc, lead) {
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const L = doc.page.margins.left;

  // Header band
  doc.rect(0, 0, doc.page.width, 92).fill(NAVY);
  doc.roundedRect(L, 26, 66, 40, 6).fill(BLUE);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('FXR', L, 36, { width: 66, align: 'center' });
  doc.fillColor('#ffffff').fontSize(15).text('FIELD BID REQUEST', L + 82, 32);
  doc.fillColor('#9FB3D6').font('Helvetica').fontSize(9)
     .text('FXR Construction  ·  Solar & Construction  ·  For Guild takeoff / estimating', L + 82, 54);
  doc.y = 116;

  const created = new Date(lead.createdAt || Date.now());
  doc.fillColor(SLATE).font('Helvetica').fontSize(9)
     .text('Received: ' + created.toLocaleString('en-US') + (lead.rep ? '     ·     Rep: ' + lead.rep : ''), L, doc.y);
  doc.moveDown(1);

  function section(title) {
    doc.moveDown(0.6);
    doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), L, doc.y);
    const y = doc.y + 2;
    doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1).strokeColor('#D5DEEC').stroke();
    doc.moveDown(0.5);
  }
  function field(label, value) {
    const y = doc.y;
    doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), L, y, { width: 120 });
    doc.fillColor('#0A1628').font('Helvetica').fontSize(11).text(value || '—', L + 128, y, { width: W - 128 });
    doc.moveDown(0.55);
  }

  section('Property & Owner');
  field('Owner', lead.ownerName);
  field('Address', lead.address);
  field('Phone', lead.phone);
  if (lead.email) field('Email', lead.email);
  field('Type of Work', (lead.workTypes && lead.workTypes.length) ? lead.workTypes.join(', ') : '—');
  const rs = [lead.roof || '', lead.sqft ? '~' + lead.sqft + ' sq ft' : ''].filter(Boolean).join('   ·   ');
  if (rs) field('Roof / Size', rs);

  // SCOPE OF WORK — the headline of the report
  section('Scope of Work');
  doc.fillColor('#0A1628').font('Helvetica').fontSize(12)
     .text(lead.scope || 'No notes provided.', L, doc.y, { width: W, align: 'left', lineGap: 2 });

  // Photos, each with the rep's descriptor beneath
  const photos = Array.isArray(lead.photos) ? lead.photos : [];
  const caps = Array.isArray(lead.photoCaptions) ? lead.photoCaptions : [];
  if (photos.length) {
    section('Site Photos (' + photos.length + ')');
    const gap = 14, cols = 2, cellW = (W - gap) / cols, imgH = 150, capH = 24, rowH = imgH + capH + gap;
    let col = 0, rowY = doc.y;
    for (let i = 0; i < photos.length; i++) {
      if (rowY + rowH > doc.page.height - doc.page.margins.bottom) { doc.addPage(); rowY = doc.page.margins.top; col = 0; }
      const x = L + col * (cellW + gap);
      const buf = await fetchImage(photos[i]);
      if (buf) {
        try { doc.image(buf, x, rowY, { fit: [cellW, imgH], align: 'center', valign: 'center' }); }
        catch (e) { drawPhotoError(doc, x, rowY, cellW, imgH); }
      } else {
        drawPhotoError(doc, x, rowY, cellW, imgH);
      }
      const cap = (caps[i] && caps[i].trim()) ? caps[i].trim() : 'Photo ' + (i + 1);
      doc.fillColor('#0A1628').font('Helvetica-Bold').fontSize(9)
         .text((i + 1) + '. ' + cap, x, rowY + imgH + 5, { width: cellW, align: 'left', height: capH, ellipsis: true });
      col++;
      if (col === cols) { col = 0; rowY += rowH; }
    }
  }

  // Footer (on the final page). Drop the bottom margin so writing into the
  // footer strip doesn't spill onto a fresh blank page.
  doc.page.margins.bottom = 0;
  doc.fontSize(8).fillColor(SLATE).font('Helvetica')
     .text('FXR Construction  ·  CSLB #1116388  ·  408-769-9928  ·  info@fxrcon.com',
           L, doc.page.height - 34, { width: W, align: 'center', lineBreak: false });
}

// Build the PDF to a file (used by the dashboard generate-pdf route).
function buildPdf(lead, outPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
      const stream = fs.createWriteStream(outPath);
      stream.on('finish', resolve);
      stream.on('error', reject);
      doc.pipe(stream);
      await renderPdf(doc, lead);
      doc.end();
    } catch (err) { reject(err); }
  });
}

// Build the PDF into a Buffer (used for email attachments).
function buildPdfBuffer(lead) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
      const chunks = [];
      doc.on('data', d => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      await renderPdf(doc, lead);
      doc.end();
    } catch (err) { reject(err); }
  });
}

function drawPhotoError(doc, x, y, w, h, url) {
  doc.rect(x, y, w, h).lineWidth(1).strokeColor('#D5DEEC').stroke();
  doc.fillColor('#9AA7BE').font('Helvetica').fontSize(8)
     .text('Photo unavailable', x, y + h / 2 - 4, { width: w, align: 'center' });
}

// Fetch a Cloudinary image as a pdfkit-safe JPEG buffer.
// pdfkit only embeds JPEG/PNG, so we force f_jpg via a Cloudinary transform.
async function fetchImage(url) {
  try {
    const jpg = url.replace('/image/upload/', '/image/upload/f_jpg,q_auto,w_1000/');
    const r = await fetch(jpg);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return null;
  }
}

// ===========================================================================
// Twilio WhatsApp
// ===========================================================================
async function sendWhatsApp(lead, pdfUrl) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM) {
    return { sent: false, reason: 'Twilio not configured (set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_WHATSAPP_FROM).' };
  }
  try {
    const twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const from = TWILIO_WHATSAPP_FROM.startsWith('whatsapp:') ? TWILIO_WHATSAPP_FROM : 'whatsapp:' + TWILIO_WHATSAPP_FROM;
    const to   = 'whatsapp:' + WHATSAPP_TO;
    const body = `FXR door-to-door lead\n${lead.ownerName}\n${lead.address}\n${lead.phone}` +
                 ((lead.workTypes && lead.workTypes.length) ? `\nWork: ${lead.workTypes.join(', ')}` : '') +
                 (lead.roof ? `\nRoof: ${lead.roof}` : '') +
                 `\n\nPDF attached — forward to Guild for takeoff.`;
    const msg = await twilio.messages.create({ from, to, body, mediaUrl: [pdfUrl] });
    return { sent: true, sid: msg.sid, to: WHATSAPP_TO };
  } catch (err) {
    return { sent: false, reason: String(err.message || err) };
  }
}

// ===========================================================================
// Guild bid-request text — fires on each new lead.
// Sends the field rep's scope + property details + photos to Guild so they can
// price the job. Channel is MMS (picture text) by default, or WhatsApp if the
// GUILD_CHANNEL env var is set to "whatsapp".
// ===========================================================================
function guildMessage(lead) {
  const L = [];
  L.push('FXR — NEW BID REQUEST');
  L.push('Please prepare a takeoff / estimate for this property.');
  L.push('');
  L.push('Owner: ' + lead.ownerName);
  L.push('Property: ' + lead.address);
  L.push('Phone: ' + lead.phone);
  if (lead.workTypes && lead.workTypes.length) L.push('Work: ' + lead.workTypes.join(', '));
  const rs = [lead.roof ? 'Roof: ' + lead.roof : '', lead.sqft ? '~' + lead.sqft + ' sq ft' : ''].filter(Boolean).join(' · ');
  if (rs) L.push(rs);
  if (lead.rep) L.push('Field rep: ' + lead.rep);
  L.push('');
  L.push('Scope (from rep): ' + (lead.scope || '—'));
  const n = (lead.photos || []).length;
  L.push('');
  L.push(n ? ('📸 ' + n + ' photo' + (n > 1 ? 's' : '') + ' attached. Reply here with the bid.') : 'Reply here with the bid.');
  return L.join('\n');
}

// Dispatch to the configured provider. Off by default ('none') — leads are
// delivered by the emailed PDF report, which Jesus forwards to Guild manually.
async function sendGuild(lead) {
  if (GUILD_PROVIDER === 'none') return { sent: false, reason: 'disabled' };
  if (GUILD_PROVIDER === 'twilio') return sendGuildTwilio(lead);
  return sendGuildRC(lead);
}

// --- RingCentral: send the MMS from the FXR office line ---
// Photos are shrunk via Cloudinary so the whole message stays under
// RingCentral's 1.5MB / 10-attachment cap.
async function fetchSmallImage(url) {
  try {
    const small = url.replace('/image/upload/', '/image/upload/f_jpg,q_auto:eco,w_800/');
    const r = await fetch(small);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    return null;
  }
}

async function sendGuildRC(lead) {
  if (!RC_CLIENT_ID || !RC_CLIENT_SECRET || !RC_JWT || !RC_FROM) {
    return { sent: false, reason: 'RingCentral not configured (set RC_CLIENT_ID / RC_CLIENT_SECRET / RC_JWT / RC_FROM).' };
  }
  try {
    const { SDK } = require('@ringcentral/sdk');
    const FormData = require('form-data');
    const rcsdk = new SDK({ server: RC_SERVER_URL, clientId: RC_CLIENT_ID, clientSecret: RC_CLIENT_SECRET });
    const platform = rcsdk.platform();
    await platform.login({ jwt: RC_JWT });

    const body = { from: { phoneNumber: RC_FROM }, to: [{ phoneNumber: GUILD_TO }], text: guildMessage(lead) };

    // Collect photos as small JPEGs, staying under the 1.5MB combined cap.
    const media = [];
    let total = 0;
    for (const url of (Array.isArray(lead.photos) ? lead.photos : []).slice(0, 10)) {
      const buf = await fetchSmallImage(url);
      if (!buf) continue;
      if (total + buf.length > 1400000) break;   // headroom under RingCentral's 1.5MB
      media.push(buf); total += buf.length;
    }

    let response;
    if (media.length) {
      const form = new FormData();
      form.append('json', Buffer.from(JSON.stringify(body)), { filename: 'request.json', contentType: 'application/json' });
      media.forEach(function (buf, i) {
        form.append('attachment', buf, { filename: 'photo' + (i + 1) + '.jpg', contentType: 'image/jpeg' });
      });
      response = await platform.post('/restapi/v1.0/account/~/extension/~/sms', form);
    } else {
      response = await platform.post('/restapi/v1.0/account/~/extension/~/sms', body);
    }
    const json = await response.json();
    platform.logout().catch(function () {});
    return { sent: true, id: json.id, to: GUILD_TO, from: RC_FROM, photos: media.length, provider: 'ringcentral' };
  } catch (err) {
    return { sent: false, reason: String((err && err.message) || err) };
  }
}

// --- Twilio: alternative sender (MMS or WhatsApp) ---
async function sendGuildTwilio(lead) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
    return { sent: false, reason: 'Twilio not configured (set TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM).' };
  }
  try {
    const twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
    const wa   = GUILD_CHANNEL === 'whatsapp';
    const from = wa ? (TWILIO_FROM.startsWith('whatsapp:') ? TWILIO_FROM : 'whatsapp:' + TWILIO_FROM) : TWILIO_FROM;
    const to   = wa ? 'whatsapp:' + GUILD_TO : GUILD_TO;
    const media = (Array.isArray(lead.photos) ? lead.photos : []).slice(0, 10); // MMS/WhatsApp media cap
    const params = { from, to, body: guildMessage(lead) };
    if (media.length) params.mediaUrl = media;
    const msg = await twilio.messages.create(params);
    return { sent: true, sid: msg.sid, channel: GUILD_CHANNEL, to: GUILD_TO, photos: media.length, provider: 'twilio' };
  } catch (err) {
    return { sent: false, reason: String(err.message || err) };
  }
}

// ===========================================================================
// JobTread — push the lead into the CRM (Pave API). Best effort.
// Creates a customer (lead) Account, attaches each photo (JobTread pulls it
// straight from the public Cloudinary URL), and adds the scope as a message.
// ===========================================================================
async function pave(ops) {
  const r = await fetch('https://api.jobtread.com/pave', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: Object.assign({ $: { grantKey: JT_GRANT_KEY } }, ops) })
  });
  const j = await r.json().catch(() => ({}));
  return j;
}

async function pushToJobTread(lead) {
  if (!JT_GRANT_KEY) return { pushed: false, reason: 'JobTread not configured (set JT_GRANT_KEY).' };
  try {
    // 1) Create the lead as a customer Account.
    const acctName = (lead.ownerName || 'Lead') + (lead.address ? ' — ' + lead.address : '');
    const created = await pave({
      createAccount: {
        $: { organizationId: JT_ORG_ID, name: acctName, type: 'customer', suffixIfNecessary: true },
        createdAccount: { id: {} }
      }
    });
    const accountId = created && created.createAccount && created.createAccount.createdAccount && created.createAccount.createdAccount.id;
    if (!accountId) throw new Error('createAccount failed: ' + JSON.stringify(created).slice(0, 300));

    // 2) Attach photos — JobTread fetches each from its public Cloudinary URL.
    const photos = Array.isArray(lead.photos) ? lead.photos.slice(0, 10) : [];
    const caps = Array.isArray(lead.photoCaptions) ? lead.photoCaptions : [];
    let attached = 0;
    for (let i = 0; i < photos.length; i++) {
      try {
        const jpg = String(photos[i]).replace('/image/upload/', '/image/upload/f_jpg,q_auto/');
        const ur = await pave({ createUploadRequest: { $: { organizationId: JT_ORG_ID, url: jpg }, createdUploadRequest: { id: {} } } });
        const urid = ur && ur.createUploadRequest && ur.createUploadRequest.createdUploadRequest && ur.createUploadRequest.createdUploadRequest.id;
        if (!urid) continue;
        const nm = ((caps[i] && caps[i].trim()) ? caps[i].trim().replace(/[^\w.\- ]+/g, '') : 'photo-' + (i + 1)) + '.jpg';
        await pave({ createFile: { $: { uploadRequestId: urid, targetType: 'account', targetId: accountId, name: nm } } });
        attached++;
      } catch (e) { /* skip a bad photo, keep going */ }
    }

    // 3) Add the field details (scope, contact, work) as a message on the account.
    try {
      await pave({ createComment: { $: { targetType: 'account', targetId: accountId, name: 'Field intake — Sales Lead to Bid', message: guildMessage(lead) } } });
    } catch (e) { /* non-fatal */ }

    return { pushed: true, accountId, photos: attached };
  } catch (err) {
    return { pushed: false, reason: String((err && err.message) || err) };
  }
}

// ===========================================================================
// Email (nodemailer) — best effort. Configure SMTP_* env vars to enable.
// ===========================================================================
let _transporter;
function transporter() {
  if (_transporter !== undefined) return _transporter;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    _transporter = null;
    return null;
  }
  const nodemailer = require('nodemailer');
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return _transporter;
}
async function sendEmail(subject, html, attachments) {
  const t = transporter();
  if (!t) throw new Error('SMTP not configured (set SMTP_HOST / SMTP_USER / SMTP_PASS).');
  const msg = {
    from: process.env.SMTP_FROM || 'FXR Sales <jesus@fxrcon.com>',
    to: NOTIFY_EMAIL,
    subject,
    html
  };
  if (attachments && attachments.length) msg.attachments = attachments;
  await t.sendMail(msg);
}

// Build the PDF report + attach the photos, and email it all to the office.
// This is the deliverable Jesus forwards to Guild.
async function emailLeadReport(lead) {
  const safe = (lead.ownerName || 'lead').replace(/[^\w.\- ]+/g, '').trim() || 'lead';
  const attachments = [];

  // The PDF report.
  const pdf = await buildPdfBuffer(lead);
  attachments.push({ filename: `FXR Bid Request - ${safe}.pdf`, content: pdf, contentType: 'application/pdf' });

  // The photos as individual files, named by their descriptor so the filename
  // itself tells you what each one is.
  const photos = Array.isArray(lead.photos) ? lead.photos : [];
  const caps = Array.isArray(lead.photoCaptions) ? lead.photoCaptions : [];
  for (let i = 0; i < photos.length; i++) {
    const buf = await fetchImage(photos[i]);
    if (!buf) continue;
    const label = (caps[i] && caps[i].trim()) ? caps[i].trim().replace(/[^\w.\- ]+/g, '') : 'photo';
    attachments.push({ filename: `${i + 1} - ${label}.jpg`, content: buf, contentType: 'image/jpeg' });
  }

  await sendEmail(`New lead — ${lead.ownerName} — ${lead.address}`, newLeadEmailBody(lead), attachments);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
// Turn a Cloudinary URL into a reasonably sized inline-embeddable JPEG.
function inlineImg(url) {
  return String(url).replace('/image/upload/', '/image/upload/f_jpg,q_auto,w_640/');
}
function newLeadEmailBody(lead) {
  const caps = Array.isArray(lead.photoCaptions) ? lead.photoCaptions : [];
  // Photos embedded inline (not links) so the report is grab-and-go.
  const photoBlocks = (lead.photos || []).map((u, i) => {
    const cap = caps[i] && caps[i].trim() ? caps[i].trim() : 'Photo ' + (i + 1);
    return `
      <div style="margin:0 0 16px">
        <div style="font-family:Arial;font-size:13px;font-weight:bold;color:#0A1628;margin-bottom:4px">${i + 1}. ${esc(cap)}</div>
        <img src="${esc(inlineImg(u))}" alt="${esc(cap)}" width="560" style="width:100%;max-width:560px;height:auto;border-radius:8px;border:1px solid #D5DEEC;display:block"/>
      </div>`;
  }).join('');
  return `
    <h2 style="font-family:Arial;color:#0A1628;margin-bottom:2px">New lead — ${esc(lead.ownerName)}</h2>
    <p style="font-family:Arial;font-size:13px;color:#5A6B8C;margin-top:0">Field bid request — forward to Guild's WhatsApp. Photos are below; the same report is also attached as a PDF.</p>
    <table style="font-family:Arial;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Owner</td><td><b>${esc(lead.ownerName)}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Address</td><td>${esc(lead.address)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Phone</td><td>${esc(lead.phone)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Work</td><td><b>${esc((lead.workTypes || []).join(', ')) || '—'}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Roof / Size</td><td>${esc([lead.roof, lead.sqft ? '~' + lead.sqft + ' sq ft' : ''].filter(Boolean).join(' · ')) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Rep</td><td>${esc(lead.rep) || '—'}</td></tr>
    </table>
    <p style="font-family:Arial;font-size:13px;color:#0A1628;margin-bottom:2px"><b>Scope of Work</b></p>
    <p style="font-family:Arial;font-size:14px;color:#0A1628;margin-top:0;white-space:pre-wrap">${esc(lead.scope) || '—'}</p>
    ${photoBlocks ? `<p style="font-family:Arial;font-size:13px;color:#0A1628;margin:14px 0 8px"><b>Photos</b></p>${photoBlocks}` : ''}`;
}
function pdfEmailBody(lead, pdfUrl, wa) {
  const status = wa.sent
    ? `<span style="color:#1B5E20">Sent to WhatsApp ${esc(WHATSAPP_TO)} (SID ${esc(wa.sid)}).</span>`
    : `<span style="color:#B71C1C">WhatsApp not sent: ${esc(wa.reason)}</span> — open the PDF below and forward it into WhatsApp manually.`;
  return `
    <h2 style="font-family:Arial;color:#0A1628">Lead PDF ready — ${esc(lead.ownerName)}</h2>
    <p style="font-family:Arial;font-size:14px">${esc(lead.address)}</p>
    <p style="font-family:Arial;font-size:14px"><a href="${esc(pdfUrl)}" style="background:#FF8F00;color:#0A1628;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:bold">Open PDF</a></p>
    <p style="font-family:Arial;font-size:13px">${status}</p>`;
}

module.exports = router;
