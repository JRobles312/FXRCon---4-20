// ============================================================================
// FXR Construction — standalone sales-leads server
// ----------------------------------------------------------------------------
// Use this ONLY if you want to run the sales-lead intake as its own service.
// If you already have an Express app on Render, you do NOT need this file —
// just mount the router in your existing app (see backend/README.md):
//
//     const salesLeads = require('./sales-leads');
//     app.use('/api/sales-leads', salesLeads);
//
// Run standalone:  npm install && npm start
// ============================================================================

const express = require('express');
const cors    = require('cors');
const salesLeads = require('./sales-leads');

const app = express();

app.use(cors());                         // allow fxrcon.com (Netlify) → this API
app.use(express.json({ limit: '2mb' })); // photo URLs only, but leave headroom

app.get('/', (req, res) => res.send('FXR sales-leads API is running.'));
app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/sales-leads', salesLeads);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FXR sales-leads API listening on :${PORT}`));
