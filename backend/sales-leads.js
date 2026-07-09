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
const NOTIFY_EMAIL      = process.env.NOTIFY_EMAIL       || 'info@fxrcon.com';

const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID   || '';
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN    || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || '';          // e.g. whatsapp:+14155238886 (sandbox)

// --- Guild bid-request text (fires on new lead) ---
const GUILD_TO      = process.env.GUILD_TO      || '+19038903834';            // Guild's number
const GUILD_CHANNEL = (process.env.GUILD_CHANNEL || 'mms').toLowerCase();      // 'mms' (picture text) | 'whatsapp'
const TWILIO_FROM   = process.env.TWILIO_FROM   || TWILIO_WHATSAPP_FROM || ''; // your Twilio sending number

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
      rep:       String(b.rep || '').trim(),
      source:    'door-to-door',            // keeps this flow separate from web /api/submit-lead
      status:    'new',                     // new | sent
      createdAt: new Date().toISOString(),
      sentAt:    null
    };

    const list = loadLeads();
    list.push(lead);
    saveLeads(list);

    // Best-effort email notification (never blocks the response).
    sendEmail(
      `New door-to-door lead — ${lead.ownerName}`,
      newLeadEmailBody(lead)
    ).catch(() => {});

    // Text the lead (scope + photos + instructions) to Guild for a bid.
    const guild = await sendGuild(lead);
    if (guild.sent) updateLead(lead.id, { status: 'sent', sentAt: new Date().toISOString() });

    res.status(201).json({ success: true, id: lead.id, guild, lead });
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

function buildPdf(lead, outPath) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
      const stream = fs.createWriteStream(outPath);
      stream.on('finish', resolve);
      stream.on('error', reject);
      doc.pipe(stream);

      const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const L = doc.page.margins.left;

      // Header band
      doc.rect(0, 0, doc.page.width, 92).fill(NAVY);
      doc.roundedRect(L, 26, 66, 40, 6).fill(BLUE);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text('FXR', L, 36, { width: 66, align: 'center' });
      doc.fillColor('#ffffff').fontSize(15).text('DOOR-TO-DOOR SALES LEAD', L + 82, 32);
      doc.fillColor('#9FB3D6').font('Helvetica').fontSize(9)
         .text('FXR Construction  ·  Solar & Construction  ·  For Guild takeoff / estimating', L + 82, 54);
      doc.moveDown(4);
      doc.y = 116;

      // Meta line
      doc.fillColor(SLATE).font('Helvetica').fontSize(9);
      const created = new Date(lead.createdAt);
      doc.text('Lead ID: ' + lead.id + '     Received: ' + created.toLocaleString('en-US') +
               (lead.rep ? '     Rep: ' + lead.rep : ''), L, doc.y);
      doc.moveDown(1);

      // Section helper
      function section(title) {
        doc.moveDown(0.6);
        doc.fillColor(BLUE).font('Helvetica-Bold').fontSize(11).text(title.toUpperCase(), L, doc.y);
        const y = doc.y + 2;
        doc.moveTo(L, y).lineTo(L + W, y).lineWidth(1).strokeColor('#D5DEEC').stroke();
        doc.moveDown(0.5);
      }
      function field(label, value) {
        const y = doc.y;
        doc.fillColor(SLATE).font('Helvetica-Bold').fontSize(9).text(label.toUpperCase(), L, y, { width: 130 });
        doc.fillColor('#0A1628').font('Helvetica').fontSize(11).text(value || '—', L + 138, y, { width: W - 138 });
        doc.moveDown(0.55);
      }

      section('Property Owner');
      field('Owner Name', lead.ownerName);
      field('Phone', lead.phone);
      field('Email', lead.email);

      section('Work Requested');
      field('Type of Work', (lead.workTypes && lead.workTypes.length) ? lead.workTypes.join(', ') : '—');

      section('Property');
      field('Address', lead.address);
      field('Roof Condition', lead.roof);
      field('Approx. Sq Ft', lead.sqft);

      section('Scope of Work / Notes');
      doc.fillColor('#0A1628').font('Helvetica').fontSize(11)
         .text(lead.scope || 'No notes provided.', L, doc.y, { width: W, align: 'left' });

      // Photos
      const photos = Array.isArray(lead.photos) ? lead.photos : [];
      if (photos.length) {
        section('Site Photos (' + photos.length + ')');
        const gap = 12, cols = 2, cellW = (W - gap) / cols, cellH = 150;
        let col = 0, rowY = doc.y;
        for (let i = 0; i < photos.length; i++) {
          const buf = await fetchImage(photos[i]);
          const x = L + col * (cellW + gap);
          if (rowY + cellH > doc.page.height - doc.page.margins.bottom) {
            doc.addPage(); rowY = doc.page.margins.top; col = 0;
          }
          if (buf) {
            try { doc.image(buf, x, rowY, { fit: [cellW, cellH], align: 'center', valign: 'center' }); }
            catch (e) { drawPhotoError(doc, x, rowY, cellW, cellH); }
          } else {
            drawPhotoError(doc, x, rowY, cellW, cellH, photos[i]);
          }
          col++;
          if (col === cols) { col = 0; rowY += cellH + gap; }
        }
        doc.y = (col === 0 ? rowY : rowY + cellH + gap);
      }

      // Footer
      doc.fontSize(8).fillColor(SLATE).font('Helvetica')
         .text('FXR Construction  ·  CSLB #1116388  ·  408-769-9928  ·  info@fxrcon.com',
               L, doc.page.height - 40, { width: W, align: 'center' });

      doc.end();
    } catch (err) {
      reject(err);
    }
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

async function sendGuild(lead) {
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
    return { sent: true, sid: msg.sid, channel: GUILD_CHANNEL, to: GUILD_TO, photos: media.length };
  } catch (err) {
    return { sent: false, reason: String(err.message || err) };
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
async function sendEmail(subject, html) {
  const t = transporter();
  if (!t) throw new Error('SMTP not configured (set SMTP_HOST / SMTP_USER / SMTP_PASS).');
  await t.sendMail({
    from: process.env.SMTP_FROM || 'FXR Sales <info@fxrcon.com>',
    to: NOTIFY_EMAIL,
    subject,
    html
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}
function newLeadEmailBody(lead) {
  const photos = (lead.photos || []).map(u => `<a href="${esc(u)}">photo</a>`).join(' · ') || '—';
  return `
    <h2 style="font-family:Arial;color:#0A1628">New door-to-door lead</h2>
    <table style="font-family:Arial;font-size:14px;border-collapse:collapse">
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Owner</td><td><b>${esc(lead.ownerName)}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Address</td><td>${esc(lead.address)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Phone</td><td>${esc(lead.phone)}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Email</td><td>${esc(lead.email) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Work</td><td><b>${esc((lead.workTypes || []).join(', ')) || '—'}</b></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Roof</td><td>${esc(lead.roof) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Sq Ft</td><td>${esc(lead.sqft) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Rep</td><td>${esc(lead.rep) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C;vertical-align:top">Scope</td><td>${esc(lead.scope) || '—'}</td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#5A6B8C">Photos</td><td>${photos}</td></tr>
    </table>
    <p style="font-family:Arial;font-size:13px;color:#5A6B8C">Review in the sales admin dashboard, then generate the PDF and send to Guild.</p>`;
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
