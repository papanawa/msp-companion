'use strict';

// ─── STATE ────────────────────────────────────────────────────────
const state = {
  alerts: [], sites: [], tickets: {},
  atStatusPicklist: null, atResources: [], atBillingCodes: [], atRoles: [],
  resolvedIds: new Set(), snoozedIds: new Set(), excludedClients: new Set(), psaExcludedClients: new Set(), atQueues: [],
  notesDrafts: {}, aiResults: {}, chatHistories: {},
  currentView: 'dashboard', currentAlert: null, currentTicket: null,
  alertFilter: 'all', alertClient: 'all', settings: {},
  autoRefreshTimer: null,
};

const SEV = {
  Critical:    { color: '#c8102e', bg: 'rgba(200,16,46,0.12)'  },
  High:        { color: '#e07b00', bg: 'rgba(224,123,0,0.12)'  },
  Moderate:    { color: '#c8a000', bg: 'rgba(200,160,0,0.12)'  },
  Low:         { color: '#2a9d5c', bg: 'rgba(42,157,92,0.12)'  },
  Information: { color: '#5a7a96', bg: 'rgba(90,122,150,0.12)' },
};

const DONE_LABELS = new Set(['complete','completed','closed','resolved','denied','cancelled','canceled']);

// ─── UTILS ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function showToast(msg, type='info') {
  const t = $('toast'); if (!t) return;
  t.textContent = msg;
  t.style.borderColor = type==='ok' ? 'rgba(42,157,92,0.5)' : type==='err' ? 'rgba(200,16,46,0.5)' : 'var(--border)';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// ─── LOCAL STORAGE ────────────────────────────────────────────────
const LS = {
  get: (k, def=null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ─── SETTINGS ─────────────────────────────────────────────────────
function loadSettings() {
  state.settings      = LS.get('msp_settings', {});
  state.resolvedIds   = new Set(LS.get('msp_resolved', []));
  state.snoozedIds    = new Set(LS.get('msp_snoozed', []));
  state.excludedClients    = new Set(LS.get('msp_excluded', []));
  state.psaExcludedClients = new Set(LS.get('msp_psa_excluded', []));
  state.notesDrafts   = LS.get('msp_notes', {});
  state.aiResults     = LS.get('msp_ai', {});
  state.chatHistories = LS.get('msp_chats', {});
  const s = state.settings;
  setVal('set-apiKey',          s.apiKey || '');
  setVal('set-secretKey',       s.secretKey || '');
  setVal('set-platformUrl',     s.platformUrl || 'https://concord-api.centrastage.net');
  setVal('set-atUser',          s.atUser || '');
  setVal('set-atSecret',        s.atSecret || '');
  setVal('set-atZone',          s.atZone || '14');
  setVal('set-atIntCode',       s.atIntCode || '');
  setVal('set-anthropicKey',    s.anthropicKey || '');
  setVal('set-defaultQueue',    s.defaultQueue || '');
  setVal('set-autoResolveInfo', s.autoResolveInfo !== false);
  setVal('set-notifications',   s.notifications !== false);
  setVal('set-autoRefresh',     s.autoRefresh !== false);
  setVal('set-refreshInterval', s.refreshInterval || 5);
  renderExcludedChips();
}

function setVal(id, val) {
  const el = $(id); if (!el) return;
  if (el.type === 'checkbox') el.checked = !!val;
  else el.value = val ?? '';
}

function saveSettings(partial) {
  state.settings = { ...state.settings, ...partial };
  LS.set('msp_settings', state.settings);
}

// ─── DARK/LIGHT MODE ──────────────────────────────────────────────
function applyMode(isLight) {
  document.body.classList.toggle('light', isLight);
  const lbl = $('modeLabel');
  if (lbl) lbl.textContent = isLight ? 'DARK MODE' : 'LIGHT MODE';
  LS.set('msp_lightmode', isLight);
}

// ─── DATTO RMM API ────────────────────────────────────────────────
let dattoToken = null, dattoTokenExpiry = 0;

async function dattoAuth() {
  if (dattoToken && Date.now() < dattoTokenExpiry) return dattoToken;
  const s = state.settings;
  if (!s.apiKey || !s.secretKey) throw new Error('Datto credentials not configured. Go to Settings.');
  const platformUrl = (s.platformUrl || 'https://concord-api.centrastage.net').replace(/\/$/, '');
  const creds = btoa('public-client:public');
  const authBody = `grant_type=password&username=${encodeURIComponent(s.apiKey)}&password=${encodeURIComponent(s.secretKey)}`;
  const res = await fetch('/api/datto?path=%2Fauth%2Foauth%2Ftoken&method=POST', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded', 'x-platform-url': platformUrl },
    body: authBody,
  });
  if (!res.ok) throw new Error(`Datto auth failed: HTTP ${res.status}`);
  const data = await res.json();
  dattoToken = data.access_token;
  dattoTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return dattoToken;
}

async function dattoFetch(path) {
  const token = await dattoAuth();
  const platformUrl = (state.settings.platformUrl || 'https://concord-api.centrastage.net').replace(/\/$/, '');
  const res = await fetch(`/api/datto?path=${encodeURIComponent(path)}&method=GET`, {
    headers: { 'Authorization': `Bearer ${token}`, 'x-platform-url': platformUrl }
  });
  if (!res.ok) throw new Error(`Datto API error: HTTP ${res.status}`);
  return res.json();
}

function normalizeAlert(raw) {
  const src = raw.alertSourceInfo || {};
  const ctx = raw.alertContext || {};
  const src2 = raw.alertSourceInfo || {};

  // Priority order for alert message:
  // 1. alertMessage on the raw object (Datto usually puts the full message here)
  // 2. alertSourceInfo message fields
  // 3. Parse from alertContext
  let alertMessage = raw.alertMessage
    || src2.alertMessage
    || src2.message
    || ctx.alertMessage
    || ctx.message
    || ctx.description
    || '';

  const cls = (ctx['@class'] || '').toLowerCase();
  const monitorType = (raw.alertMonitorType || raw.monitorType || '').toLowerCase();

  // Only try to parse context if we still don't have a meaningful message
  if (!alertMessage || alertMessage === 'Alert triggered') {

    // ── Disk Usage ────────────────────────────────────────────────
    if (cls.includes('disk') || monitorType.includes('disk')) {
      const drive = ctx.diskName || ctx.driveLetter || ctx.volume || ctx.drive || 'C:';
      // Datto sends freeSpace and totalVolume in MB (not bytes)
      const freeMB  = ctx.freeSpace ?? ctx.freeSpaceBytes ?? ctx.free;
      const totalMB = ctx.totalVolume ?? ctx.driveCapacity ?? ctx.totalSpaceBytes ?? ctx.total;
      const pct     = ctx.usagePercent ?? ctx.percentUsed ?? ctx.percent;
      if (freeMB !== undefined && totalMB !== undefined) {
        // Determine if values are in bytes or MB based on magnitude
        const isBytes = totalMB > 1e9;
        const freeGB  = isBytes ? freeMB/1e9  : freeMB/1024;
        const totalGB = isBytes ? totalMB/1e9 : totalMB/1024;
        const pctUsed = totalMB > 0 ? Math.round((1 - freeMB/totalMB)*100) : (pct || 0);
        const freeStr  = freeGB  >= 1 ? freeGB.toFixed(1)+' GB'  : Math.round(freeGB*1024)+' MB';
        const totalStr = totalGB >= 1 ? totalGB.toFixed(1)+' GB' : Math.round(totalGB*1024)+' MB';
        alertMessage = `Disk Usage: ${drive} — ${freeStr} free of ${totalStr} (${pctUsed}% used)`;
      } else if (pct !== undefined) {
        alertMessage = `Disk Usage: ${drive} — ${pct}% used`;
      } else if (ctx.threshold) {
        alertMessage = `Disk Usage: ${drive} — exceeded ${ctx.threshold}% threshold`;
      }
    }

    // ── CPU ───────────────────────────────────────────────────────
    else if (cls.includes('cpu') || monitorType.includes('cpu')) {
      const usage = ctx.cpuUsage ?? ctx.usage ?? ctx.percent ?? ctx.value;
      const threshold = ctx.threshold ?? ctx.alertThreshold;
      if (usage !== undefined) alertMessage = `CPU Usage: ${Math.round(usage)}%${threshold ? ` (threshold: ${threshold}%)` : ''}`;
      else if (threshold) alertMessage = `CPU Usage exceeded ${threshold}% threshold`;
    }

    // ── Memory / RAM ──────────────────────────────────────────────
    else if (cls.includes('memory') || cls.includes('ram') || monitorType.includes('memory')) {
      const usage = ctx.memoryUsage ?? ctx.usage ?? ctx.percent ?? ctx.value;
      const free  = ctx.freeMemory ?? ctx.free;
      const total = ctx.totalMemory ?? ctx.total;
      if (free !== undefined && total !== undefined) {
        const freeStr  = free  > 1e9 ? (free/1e9).toFixed(1)+' GB'  : (free/1e6).toFixed(0)+' MB';
        const totalStr = total > 1e9 ? (total/1e9).toFixed(1)+' GB' : (total/1e6).toFixed(0)+' MB';
        alertMessage = `Memory: ${freeStr} free of ${totalStr} (${Math.round((1-free/total)*100)}% used)`;
      } else if (usage !== undefined) {
        alertMessage = `Memory Usage: ${Math.round(usage)}%`;
      }
    }

    // ── Network / Connectivity ────────────────────────────────────
    else if (cls.includes('network') || cls.includes('connectivity') || monitorType.includes('network') || monitorType.includes('ping')) {
      const iface = ctx.interface || ctx.networkInterface || ctx.adapter || '';
      const latency = ctx.latency ?? ctx.responseTime ?? ctx.pingTime;
      const loss = ctx.packetLoss ?? ctx.loss;
      if (loss !== undefined) alertMessage = `Network: ${iface ? iface+' — ' : ''}${loss}% packet loss${latency ? `, ${latency}ms latency` : ''}`;
      else if (latency !== undefined) alertMessage = `Network: ${iface ? iface+' — ' : ''}${latency}ms response time`;
      else alertMessage = `Network connectivity issue${iface ? ': '+iface : ''}`;
    }

    // ── Service / Process ─────────────────────────────────────────
    else if (cls.includes('service') || cls.includes('process') || monitorType.includes('service')) {
      const service = ctx.serviceName || ctx.processName || ctx.name || ctx.service || '';
      const status  = ctx.status || ctx.state || '';
      if (service) alertMessage = `Service ${status ? status+': ' : 'alert: '}${service}`;
      else alertMessage = `Service/process alert${status ? ': '+status : ''}`;
    }

    // ── Backup ────────────────────────────────────────────────────
    else if (cls.includes('backup') || monitorType.includes('backup')) {
      const job    = ctx.jobName || ctx.backupJob || ctx.name || '';
      const status = ctx.status || ctx.result || ctx.state || '';
      const size   = ctx.backupSize ?? ctx.size;
      const sizeStr = size ? (size > 1e9 ? (size/1e9).toFixed(1)+' GB' : (size/1e6).toFixed(0)+' MB') : '';
      alertMessage = `Backup ${status || 'alert'}${job ? ': '+job : ''}${sizeStr ? ' ('+sizeStr+')' : ''}`;
    }

    // ── Temperature ───────────────────────────────────────────────
    else if (cls.includes('temp') || monitorType.includes('temp')) {
      const temp  = ctx.temperature ?? ctx.temp ?? ctx.value;
      const unit  = ctx.unit || 'C';
      const comp  = ctx.component || ctx.sensor || '';
      if (temp !== undefined) alertMessage = `Temperature: ${temp}°${unit}${comp ? ' ('+comp+')' : ''}`;
    }

    // ── Event Log ─────────────────────────────────────────────────
    else if (cls.includes('event') || monitorType.includes('event')) {
      const source = ctx.source || ctx.eventSource || '';
      const id     = ctx.eventId || ctx.id || '';
      const msg    = ctx.eventMessage || ctx.logMessage || '';
      if (msg) alertMessage = `Event Log: ${msg.substring(0, 100)}`;
      else alertMessage = `Event Log alert${source ? ': '+source : ''}${id ? ' (ID: '+id+')' : ''}`;
    }

    // ── SNMP ──────────────────────────────────────────────────────
    else if (cls.includes('snmp') || monitorType.includes('snmp')) {
      const oid = ctx.oid || ctx.objectId || '';
      const val = ctx.value ?? ctx.currentValue;
      alertMessage = `SNMP alert${oid ? ': '+oid : ''}${val !== undefined ? ' — value: '+val : ''}`;
    }

    // ── Generic fallback — scrape anything useful from context ────
    else {
      const candidates = [
        ctx.message, ctx.description, ctx.details, ctx.summary,
        ctx.alertMessage, ctx.text, ctx.info,
        ctx.errorMessage, ctx.error,
      ].filter(Boolean);
      if (candidates.length) {
        alertMessage = String(candidates[0]).substring(0, 200);
      } else {
        // Last resort — show monitor type and any numeric values
        const vals = Object.entries(ctx)
          .filter(([k,v]) => typeof v === 'number' && !k.startsWith('@'))
          .map(([k,v]) => `${k}: ${v}`)
          .slice(0, 3)
          .join(', ');
        const rawType = raw.alertMonitorType || cls.split('.').pop() || '';
        alertMessage = rawType
          ? `${rawType.replace(/_/g,' ').replace(/ctx$/i,'').trim()} alert${vals ? ' — '+vals : ''}`
          : (vals || 'Alert triggered — check Datto RMM for details');
      }
    }
  }

  return {
    alertUid:    raw.alertUid || raw.id,
    hostname:    src.deviceName || raw.deviceName || 'Unknown Device',
    siteName:    src.siteName   || raw.siteName   || 'Unknown Client',
    siteUid:     src.siteUid   || raw.siteUid,
    priority:    raw.priority   || 'Information',
    monitorType: (raw.alertMonitorType || cls.split('.').pop() || 'Unknown')
      .replace(/Context$/i,'').replace(/_/g,' ').replace(/([A-Z])/g,' $1').trim(),
    alertMessage: alertMessage || 'Alert triggered — check Datto RMM for details',
    ticketNumber: raw.ticketNumber || null,
    timestampMs:  raw.createdAt ? new Date(raw.createdAt).getTime() : Date.now(),
    alertContext: ctx,
    _raw: raw,
  };
}

// Debug helper — paste in console: debugAlert()
window.debugAlert = () => {
  const a = window._lastAlert;
  if (!a) { console.log('No alert selected yet'); return; }
  console.log('=== RAW ALERT DATA ===');
  console.log('alertMessage:', a._raw?.alertMessage);
  console.log('alertMonitorType:', a._raw?.alertMonitorType);
  console.log('alertSourceInfo:', JSON.stringify(a._raw?.alertSourceInfo, null, 2));
  console.log('alertContext:', JSON.stringify(a._raw?.alertContext, null, 2));
  console.log('=== NORMALIZED ===');
  console.log('message:', a.alertMessage);
  console.log('monitorType:', a.monitorType);
};

async function fetchAlerts() {
  const pages = []; let page = 0;
  while (true) {
    const data = await dattoFetch(`/account/alerts/open?max=250&page=${page}`);
    const items = data.alerts || data.items || [];
    pages.push(...items);
    if (!data.pageDetails?.nextPage) break;
    if (++page > 20) break;
  }
  return pages.map(normalizeAlert);
}

async function fetchSites() {
  const pages = []; let page = 0;
  while (true) {
    const data = await dattoFetch(`/account/sites?max=250&page=${page}`);
    const items = data.sites || data.items || [];
    pages.push(...items);
    if (!data.pageDetails?.nextPage) break;
    if (++page > 10) break;
  }
  return pages;
}

async function resolveAlert(alertUid) {
  const token = await dattoAuth();
  const platformUrl = (state.settings.platformUrl || 'https://concord-api.centrastage.net').replace(/\/$/, '');
  const res = await fetch(`/api/datto?path=${encodeURIComponent('/alert/'+alertUid+'/resolve')}&method=POST`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'x-platform-url': platformUrl }
  });
  if (!res.ok && res.status !== 204) throw new Error(`Resolve failed: HTTP ${res.status}`);
}

// ─── AUTOTASK API ─────────────────────────────────────────────────
function atHeaders() {
  const s = state.settings;
  return { 'Content-Type':'application/json', 'UserName':s.atUser||'', 'Secret':s.atSecret||'', 'ApiIntegrationCode':s.atIntCode||'' };
}

async function atFetch(path, method='GET', body=null) {
  const zone = state.settings.atZone || '14';
  const h = atHeaders();
  const opts = {
    method,
    headers: { 'Content-Type':'application/json', 'username':h.UserName, 'secret':h.Secret, 'apiintegrationcode':h.ApiIntegrationCode, 'x-at-zone':zone }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`/api/autotask?path=${encodeURIComponent(path)}&method=${method}`, opts);
  if (!res.ok) {
    const txt = await res.text();
    let err = {}; try { err = JSON.parse(txt); } catch {}
    throw new Error(`AT API ${res.status}: ${err?.errors?.[0] || txt.substring(0,120)}`);
  }
  return res.json();
}

async function loadAtStatusPicklist() {
  if (state.atStatusPicklist) return state.atStatusPicklist;
  const cached = LS.get('msp_at_picklist');
  if (cached) { state.atStatusPicklist = cached; return cached; }
  try {
    const data = await atFetch('/Tickets/entityInformation/fields');
    const statusField = (data?.fields || []).find(f => f.name === 'status');
    const picklist = {};
    (statusField?.picklistValues || []).forEach(pv => {
      const l = (pv.label||'').toLowerCase();
      let color = '#8bacc8';
      if (DONE_LABELS.has(l))                                                    color = '#2a9d5c';
      else if (l.includes('progress')||l.includes('assigned')||l.includes('dispatched')) color = '#00b4d8';
      else if (l.includes('waiting')||l.includes('hold')||l.includes('pending')) color = '#c8a000';
      else if (l.includes('escalat')||l.includes('problem'))                     color = '#e07b00';
      else if (l.includes('new'))                                                color = '#4e7fff';
      picklist[pv.value] = { label: pv.label, color, done: DONE_LABELS.has(l) };
    });
    state.atStatusPicklist = picklist;
    LS.set('msp_at_picklist', picklist);
    return picklist;
  } catch(e) { console.warn('AT picklist failed:', e.message); return {}; }
}

async function syncTicketStatuses(ticketNumbers) {
  if (!ticketNumbers?.length) return;
  const pl = await loadAtStatusPicklist();
  const chunks = [];
  for (let i = 0; i < ticketNumbers.length; i += 50) chunks.push(ticketNumbers.slice(i, i+50));
  for (const chunk of chunks) {
    try {
      const data = await atFetch('/Tickets/query', 'POST', {
        filter: [{ op:'in', field:'ticketNumber', value:chunk }],
        IncludeFields: ['id','ticketNumber','status','title','assignedResourceID','lastActivityDate','companyID'],
      });
      // Build company name map from alerts
      const companyIds2 = (data?.items||[]).map(t=>t.companyID).filter(Boolean);
      await loadAtCompanyNames(companyIds2);
      const companyNameMap = buildCompanyNameMap();
      (data?.items || []).forEach(t => {
        const si = pl[t.status] || { label:`Status ${t.status}`, color:'#8bacc8', done:false };
        state.tickets[t.ticketNumber] = {
          id: t.id, ticketNumber: t.ticketNumber,
          status: t.status, statusLabel: si.label, statusColor: si.color, isDone: si.done,
          title: t.title, companyID: t.companyID, companyName: companyNameMap[t.companyID] || null,
          assignedResourceID: t.assignedResourceID, assignedResourceName: null,
          lastActivity: t.lastActivityDate,
        };
      });
    } catch(e) { console.warn('Ticket sync chunk failed:', e.message); }
  }
  LS.set('msp_tickets', state.tickets);
}

async function loadAtResources() {
  if (state.atResources.length) return;
  try {
    const data = await atFetch('/Resources/query', 'POST', { filter:[{op:'eq',field:'isActive',value:true}] });
    state.atResources = (data?.items||[])
      .filter(r => { const n = ((r.firstName||'')+' '+(r.lastName||'')).trim().toLowerCase(); return !n.includes('api')&&!n.includes('integration'); })
      .map(r => ({ id:r.id, name:((r.firstName||'')+' '+(r.lastName||'')).trim() }));
  } catch(e) { console.warn('Resources failed:', e.message); }
}

async function loadAtBillingCodes() {
  if (state.atBillingCodes.length) return;
  try {
    const data = await atFetch('/BillingCodes/query','POST',{filter:[{op:'eq',field:'isActive',value:true}]});
    state.atBillingCodes = (data?.items||[]).filter(b=>b.billingCodeType===0||b.billingCodeType===2).map(b=>({id:b.id,name:b.name}));
  } catch(e) { console.warn('Billing codes failed:', e.message); }
}

async function loadAtRoles() {
  if (state.atRoles.length) return;
  try {
    const data = await atFetch('/Roles/query','POST',{filter:[{op:'eq',field:'isActive',value:true}]});
    state.atRoles = (data?.items||[]).map(r=>({id:r.id,name:r.name}));
  } catch(e) { console.warn('Roles failed:', e.message); }
}

// Cache of Autotask companyID -> company name
let atCompanyCache = {};

async function loadAtQueues() {
  if (state.atQueues?.length) return;
  try {
    const data = await atFetch('/ServiceCallTicketResources/query', 'POST', {
      filter: [{ op: 'eq', field: 'isActive', value: true }]
    });
    state.atQueues = (data?.items || []).map(q => ({ id: q.id, name: q.name }));
  } catch(e) {
    // Try alternate endpoint
    try {
      const data2 = await atFetch('/Tickets/entityInformation/fields');
      const queueField = (data2?.fields || []).find(f => f.name === 'queueID');
      state.atQueues = (queueField?.picklistValues || [])
        .filter(q => q.isActive !== false)
        .map(q => ({ id: q.value, name: q.label }));
    } catch(e2) { console.warn('Queue fetch failed:', e2.message); state.atQueues = []; }
  }
}

function buildCompanyNameMap() {
  // Start with AT company cache (most reliable)
  const map = { ...atCompanyCache };
  // Also try Datto sites as fallback
  state.sites.forEach(s => {
    if (s.id && s.name) map[s.id] = s.name;
    if (s.uid && s.name) map[s.uid] = s.name;
  });
  return map;
}

async function loadAtCompanyNames(companyIds) {
  const missing = [...new Set(companyIds)].filter(id => id && !atCompanyCache[id]);
  if (!missing.length) return;
  try {
    // Autotask REST API uses 'Companies' endpoint
    const data = await atFetch('/Companies/query', 'POST', {
      MaxRecords: 500,
      filter: [{ op: 'in', field: 'id', value: missing }],
      IncludeFields: ['id', 'companyName', 'accountName'],
    });
    (data?.items || []).forEach(c => {
      // Try both field names — different AT API versions use different names
      const name = c.companyName || c.accountName || c.name || null;
      if (c.id && name) atCompanyCache[c.id] = name;
    });
    // If API returned nothing useful, log for debugging
    if (!data?.items?.length) {
      console.warn('AT Companies query returned no items. IDs:', missing.slice(0,5));
    }
    LS.set('msp_at_companies', atCompanyCache);
  } catch(e) {
    console.warn('Company name fetch failed:', e.message);
    // Try alternate endpoint name
    try {
      const data2 = await atFetch('/Accounts/query', 'POST', {
        MaxRecords: 500,
        filter: [{ op: 'in', field: 'id', value: missing }],
        IncludeFields: ['id', 'accountName'],
      });
      (data2?.items || []).forEach(c => {
        const name = c.accountName || c.companyName || c.name || null;
        if (c.id && name) atCompanyCache[c.id] = name;
      });
      LS.set('msp_at_companies', atCompanyCache);
    } catch(e2) { console.warn('Alternate company fetch also failed:', e2.message); }
  }
}

async function fetchAtTicketQueue() {
  await loadAtStatusPicklist();
  const pl = state.atStatusPicklist || {};
  const doneValues = Object.entries(pl).filter(([,i])=>i.done).map(([v])=>parseInt(v)).filter(Boolean);
  const filter = doneValues.length > 0
    ? doneValues.map(v => ({ op:'noteq', field:'status', value:v }))
    : [{ op:'noteq', field:'status', value:5 }];
  const data = await atFetch('/Tickets/query','POST',{
    MaxRecords: 200, filter,
    IncludeFields: ['id','ticketNumber','status','title','priority','assignedResourceID','companyID','lastActivityDate'],
  });
  const items = data?.items || [];
  await loadAtResources();
  const resourceMap = {};
  state.atResources.forEach(r => { resourceMap[r.id] = r.name; });
  // Fetch company names from Autotask for all unique company IDs
  const companyIds = [...new Set(items.map(t => t.companyID).filter(Boolean))];
  await loadAtCompanyNames(companyIds);
  const companyNameMap = buildCompanyNameMap();
  items.forEach(t => {
    const si = pl[t.status] || { label:`Status ${t.status}`, color:'#8bacc8', done:false };
    t.statusLabel = si.label;
    t.statusColor = si.color;
    t.isDone = si.done;
    t.assignedResourceName = t.assignedResourceID ? (resourceMap[t.assignedResourceID] || null) : null;
    t.companyName = companyNameMap[t.companyID] || null;
  });
  return items;
}

async function createTicketForAlert(alert) {
  // Map Datto priority to Autotask priority ID
  const priorityMap = { Critical: 1, High: 2, Moderate: 3, Low: 4, Information: 4 };
  const atPriority = priorityMap[alert.priority] || 3;

  // Build title
  const title = `${alert.hostname} - ${alert.priority}: ${alert.alertMessage.substring(0, 80)}`;

  // Build description
  const aiText = state.aiResults[alert.alertUid] || '';
  const sep = '─────────────────────────────';
  const description = [
    'ALERT DETAILS', sep,
    `Device:       ${alert.hostname}`,
    `Client:       ${alert.siteName}`,
    `Priority:     ${alert.priority}`,
    `Monitor Type: ${alert.monitorType}`,
    `Alert Time:   ${new Date(alert.timestampMs).toLocaleString()}`,
    '',
    'ALERT MESSAGE', sep,
    alert.alertMessage,
    aiText ? ('\nAI TRIAGE ANALYSIS\n' + sep + '\n' + aiText.substring(0, 1000)) : '',
    '',
    sep,
    'Generated by MSP Companion — Synobis Network Solutions',
  ].filter(Boolean).join('\n');

  // Find the Autotask company ID from our cache
  const companyId = Object.entries(atCompanyCache).find(([, name]) => name === alert.siteName)?.[0];
  if (!companyId) throw new Error(`Company not found in AT cache for: ${alert.siteName}. Refresh tickets first.`);

  const queueID = parseInt(state.settings.defaultQueue) || null;
  const body = {
    companyID: parseInt(companyId),
    title,
    description,
    priority: atPriority,
    status: 1, // New
    ticketType: 1, // Service Request
  };
  if (queueID) body.queueID = queueID;

  const data = await atFetch('/Tickets', 'POST', body);
  const newTicket = data?.item;
  if (!newTicket?.id) throw new Error('Ticket created but no ID returned');

  return newTicket;
}

async function postResolutionToAt(ticketId, text, resourceId) {
  await atFetch('/Tickets','PATCH',{ id:parseInt(ticketId), resolution:text });
  const noteBody = { ticketID:parseInt(ticketId), title:'Resolution — MSP Companion', description:text, noteType:1, publish:1 };
  if (resourceId) noteBody.creatorResourceID = parseInt(resourceId);
  await atFetch(`/Tickets/${ticketId}/Notes`,'POST',noteBody);
}

async function postTimeEntry(ticketId, resourceId, roleId, billingCodeId, hours, summary) {
  const start = new Date().toISOString();
  const end   = new Date(Date.now() + hours*3600000).toISOString();
  await atFetch('/TimeEntries','POST',{
    ticketID:parseInt(ticketId), resourceID:parseInt(resourceId), roleID:parseInt(roleId),
    billingCodeID:parseInt(billingCodeId), dateWorked:start.substring(0,10),
    startDateTime:start, endDateTime:end, hoursWorked:parseFloat(hours),
    summaryNotes:summary||'', isInternalNoteVisible:true, offsetHours:0,
  });
}

// ─── ANTHROPIC AI ─────────────────────────────────────────────────
async function callAI(systemPrompt, messages) {
  const key = state.settings.anthropicKey;
  if (!key) throw new Error('Anthropic API key not configured. Go to Settings.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01', 'anthropic-dangerous-direct-browser-access':'true' },
    body: JSON.stringify({ model:'claude-sonnet-4-20250514', max_tokens:1024, system:systemPrompt, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`AI API ${res.status}: ${data?.error?.message||'Unknown error'}`);
  return data.content?.find(b=>b.type==='text')?.text || 'No response received.';
}

function buildAlertSystemPrompt(alert) {
  const ticket = alert.ticketNumber ? state.tickets[alert.ticketNumber] : null;
  let resolutionState = 'NO_TICKET';
  if (ticket) {
    if (ticket.isDone) resolutionState = 'TICKET_DONE';
    else if (['in progress','assigned','dispatched'].some(s=>ticket.statusLabel?.toLowerCase().includes(s))) resolutionState = 'IN_PROGRESS';
    else resolutionState = 'TICKET_OPEN';
  }
  return `You are an expert MSP engineer AI assistant for Synobis Network Solutions — a veteran-owned MSP in San Antonio, TX. You are embedded in MSP Companion, a unified Datto RMM + Autotask platform.

INCIDENT CONTEXT:
Device: ${alert.hostname}
Client: ${alert.siteName}
Priority: ${alert.priority}
Monitor Type: ${alert.monitorType}
Alert Message: ${alert.alertMessage}
Alert Time: ${new Date(alert.timestampMs).toLocaleString()}
Ticket: ${alert.ticketNumber || 'NONE'}
Ticket Status: ${ticket ? ticket.statusLabel : 'No ticket'}

RESOLUTION STATE: ${resolutionState}
${resolutionState==='NO_TICKET' ? '→ No ticket exists yet. Guide the tech through creating one and beginning remediation.' : ''}
${resolutionState==='TICKET_OPEN' ? '→ Ticket exists and is open. Guide the tech through working the ticket to resolution.' : ''}
${resolutionState==='IN_PROGRESS' ? '→ Ticket is actively being worked. Provide targeted remediation guidance.' : ''}
${resolutionState==='TICKET_DONE' ? '→ Ticket is complete but Datto alert is still open. Confirm it is safe to resolve the alert.' : ''}

RESOLUTION FLOW: Alert Seen → Ticket Created/Linked → Work Ticket → Post Resolution → Resolve Alert → Close Ticket → Log to KB

Your response MUST follow this exact format:
ASSESSMENT: [2-3 sentences on what's happening and urgency]
IMMEDIATE STEPS:
1. [First action]
2. [Second action]
3. [Third action]
ROOT CAUSE: [Most likely cause in one sentence]
ESCALATE IF: [Specific conditions that warrant escalation]
RECONCILIATION PATH: [How to complete the full resolution cycle from current state to KB logged]

Be concise, practical, and specific. Include exact commands or paths when relevant.`;
}

// ─── RESOLUTION STATE ─────────────────────────────────────────────
function getResolutionState(alert) {
  const ticket = alert.ticketNumber ? state.tickets[alert.ticketNumber] : null;
  if (!ticket) return 'no-ticket';
  if (ticket.isDone) return 'mismatch';
  const sl = (ticket.statusLabel||'').toLowerCase();
  if (sl.includes('progress')||sl.includes('assigned')||sl.includes('dispatched')) return 'in-progress';
  return 'ticket-open';
}

function getPipelineColumn(alert) {
  const s = getResolutionState(alert);
  if (s==='no-ticket')   return 'needs';
  if (s==='ticket-open') return 'ticket';
  if (s==='in-progress') return 'progress';
  if (s==='mismatch')    return 'ready';
  return 'needs';
}

// ─── FILTERS ──────────────────────────────────────────────────────
function getVisibleAlerts() {
  return state.alerts.filter(a =>
    !state.resolvedIds.has(a.alertUid) &&
    !state.snoozedIds.has(a.alertUid) &&
    !state.excludedClients.has(a.siteName)
  );
}

function getFilteredAlerts() {
  return getVisibleAlerts()
    .filter(a => state.alertClient === 'all' || a.siteName === state.alertClient)
    .filter(a => {
      if (state.alertFilter === 'all') return true;
      if (['Critical','High','Moderate','Information'].includes(state.alertFilter)) return a.priority === state.alertFilter;
      if (state.alertFilter === 'no-ticket') return !a.ticketNumber;
      if (state.alertFilter === 'mismatch') return a.ticketNumber && state.tickets[a.ticketNumber]?.isDone;
      return true;
    });
}

function getOpenTickets() {
  // Build set of excluded company IDs using PSA exclusion list
  const excludedIds = new Set();
  Object.entries(atCompanyCache).forEach(([id, name]) => {
    if (state.psaExcludedClients.has(name)) excludedIds.add(parseInt(id));
  });

  return Object.values(state.tickets).filter(t => {
    if (t.isDone) return false;
    if (t.companyName && state.psaExcludedClients.has(t.companyName)) return false;
    if (!t.companyName && t.companyID && excludedIds.has(t.companyID)) return false;
    return true;
  });
}

// ─── RENDER HELPERS ───────────────────────────────────────────────
function badgeHtml(label, color, bg) {
  return `<span class="badge" style="color:${color};background:${bg};border:1px solid ${color}44">${esc(label)}</span>`;
}

function renderAIResult(text) {
  const HDRS = ['ASSESSMENT:','IMMEDIATE STEPS:','ROOT CAUSE:','ESCALATE IF:','RECONCILIATION PATH:'];
  return `<div class="ai-result">${text.split('\n').map(line => {
    const isHdr = HDRS.some(h => line.trim().startsWith(h));
    return isHdr ? `<div class="ai-section-hdr">${esc(line)}</div>` : `<div class="ai-section-body">${esc(line)}</div>`;
  }).join('')}</div>`;
}

function renderResolutionFlow(alert) {
  const rs = getResolutionState(alert);
  const steps = [
    { icon:'⚡', label:'Alert Seen',  done:true,                    active:false },
    { icon:'🎫', label:'Ticket',      done:rs!=='no-ticket',         active:rs==='no-ticket' },
    { icon:'🔧', label:'Working',     done:rs==='in-progress'||rs==='mismatch', active:rs==='ticket-open' },
    { icon:'✓',  label:'Resolved',    done:rs==='mismatch',          active:rs==='in-progress' },
    { icon:'📚', label:'KB Logged',   done:false,                    active:false },
  ];
  return `<div class="resolution-flow">${steps.map(s =>
    `<div class="flow-step ${s.done?'done':s.active?'active':''}">
      <div class="flow-step-icon">${s.icon}</div>
      <div class="flow-step-label">${s.label}</div>
    </div>`).join('')}</div>`;
}

// ─── DASHBOARD ────────────────────────────────────────────────────
function renderDashboard() {
  const visible     = getVisibleAlerts();
  const crit        = visible.filter(a=>a.priority==='Critical');
  const high        = visible.filter(a=>a.priority==='High');
  const noTicket    = visible.filter(a=>!a.ticketNumber);
  const mismatch    = visible.filter(a=>a.ticketNumber&&state.tickets[a.ticketNumber]?.isDone);
  const openTickets = getOpenTickets();

  const setText = (id,v) => { const el=$(id); if(el) el.textContent=v; };
  setText('statOpenAlerts', visible.length);
  setText('statCritical',   crit.length);
  setText('statHigh',       high.length);
  setText('statOpenTickets',openTickets.length);
  setText('statMismatch',   mismatch.length);
  setText('statNoTicket',   noTicket.length);

  const updateBadge = (id, count) => { const el=$(id); if(!el) return; if(count){el.style.display='block';el.textContent=count>99?'99+':count;}else el.style.display='none'; };
  updateBadge('navAlertBadge',  crit.length||null);
  updateBadge('navTicketBadge', openTickets.length||null);

  const greetEl = $('dashGreeting');
  if (greetEl) greetEl.textContent = `${greeting()} — ${visible.length} open alert${visible.length!==1?'s':''}, ${crit.length} critical.`;

  const bulkBar = $('bulkBar');
  if (bulkBar) {
    bulkBar.style.display = mismatch.length ? 'flex' : 'none';
    const bc = $('bulkBarCount'); if(bc) bc.textContent = mismatch.length;
  }

  renderPipeline(visible);
  renderClientGrid(visible);
}

function renderPipeline(alerts) {
  const cols = { needs:[], ticket:[], progress:[], ready:[] };
  alerts.forEach(a => { const c=getPipelineColumn(a); if(cols[c]) cols[c].push(a); });
  const sv = { Critical:'#c8102e', High:'#e07b00', Moderate:'#c8a000', Low:'#2a9d5c', Information:'#5a7a96' };
  [
    ['Needs','needs','pipeNeedsAttention'],
    ['Ticket','ticket','pipeTicketOpen'],
    ['Progress','progress','pipeInProgress'],
    ['Ready','ready','pipeReadyClose'],
  ].forEach(([cap,key,countId]) => {
    const items = cols[key];
    const countEl = $(countId); if(countEl) countEl.textContent = items.length;
    const el = $(`pipeCol${cap}`); if(!el) return;
    if (!items.length) { el.innerHTML='<div class="pipeline-empty">NONE</div>'; return; }
    el.innerHTML = items.slice(0,6).map(a=>`
      <div class="pipeline-item" data-uid="${esc(a.alertUid)}">
        <div class="pipeline-item-device">${esc(a.hostname)}</div>
        <div class="pipeline-item-client">${esc(a.siteName)}</div>
        <span class="pipeline-item-badge" style="color:${sv[a.priority]||'#5a7a96'};background:${sv[a.priority]||'#5a7a96'}22;border:1px solid ${sv[a.priority]||'#5a7a96'}44">${esc(a.priority)}</span>
      </div>`).join('');
    if (items.length>6) el.insertAdjacentHTML('beforeend',`<div class="pipeline-empty">+${items.length-6} more</div>`);
  });
}

function renderClientGrid(alerts) {
  const el = $('dashClientGrid'); if(!el) return;
  const byClient = {};
  alerts.forEach(a => {
    if(!byClient[a.siteName]) byClient[a.siteName]={crit:0,high:0,mod:0,total:0};
    byClient[a.siteName].total++;
    if(a.priority==='Critical') byClient[a.siteName].crit++;
    else if(a.priority==='High') byClient[a.siteName].high++;
    else if(a.priority==='Moderate') byClient[a.siteName].mod++;
  });
  const clients = Object.entries(byClient).sort((a,b)=>(b[1].crit-a[1].crit)||(b[1].high-a[1].high));
  if (!clients.length) { el.innerHTML='<div class="loading-state">No active alerts</div>'; return; }
  el.innerHTML = clients.map(([name,c])=>`
    <div class="client-card" data-client-filter="${esc(name)}">
      <div class="client-card-name" title="${esc(name)}">${esc(name)}</div>
      <div class="client-card-badges">
        ${c.crit ? badgeHtml(`${c.crit} Critical`,'#c8102e','rgba(200,16,46,0.1)') : ''}
        ${c.high ? badgeHtml(`${c.high} High`,    '#e07b00','rgba(224,123,0,0.1)') : ''}
        ${c.mod  ? badgeHtml(`${c.mod} Moderate`, '#c8a000','rgba(200,160,0,0.1)') : ''}
        ${(!c.crit&&!c.high&&!c.mod) ? badgeHtml(`${c.total} Info`,'#5a7a96','rgba(90,122,150,0.1)') : ''}
      </div>
    </div>`).join('');
}

// ─── ALERT LIST ───────────────────────────────────────────────────
function renderAlertList() {
  const filtered = getFilteredAlerts();
  const el = $('alertList'); if(!el) return;
  const cntEl = $('alertListCount'); if(cntEl) cntEl.textContent = `${filtered.length} alert${filtered.length!==1?'s':''}`;
  const critEl = $('alertCritCount'); if(critEl) critEl.textContent = `${filtered.filter(a=>a.priority==='Critical').length} critical`;
  if (!filtered.length) { el.innerHTML='<div class="loading-state">No alerts match current filters</div>'; return; }
  const order = {Critical:0,High:1,Moderate:2,Low:3,Information:4};
  const sorted = [...filtered].sort((a,b)=>(order[a.priority]??5)-(order[b.priority]??5)||b.timestampMs-a.timestampMs);
  el.innerHTML = sorted.map(a => {
    const sv     = SEV[a.priority]||SEV.Information;
    const ticket = a.ticketNumber ? state.tickets[a.ticketNumber] : null;
    const rs     = getResolutionState(a);
    const isActive = state.currentAlert?.alertUid === a.alertUid;
    const ticketBadge = ticket
      ? `<span class="badge" style="color:${ticket.statusColor};background:${ticket.statusColor}22;border:1px solid ${ticket.statusColor}44">AT: ${esc(ticket.statusLabel)}</span>`
      : `<span class="badge" style="color:#5a7a96;background:rgba(90,122,150,0.1);border:1px solid rgba(90,122,150,0.3)">No Ticket</span>`;
    return `<div class="list-row ${isActive?'active':''}" data-uid="${esc(a.alertUid)}">
      <div class="row-top">
        <span class="row-device">${esc(a.hostname)}</span>
        <div class="row-badges">
          ${badgeHtml(a.priority,sv.color,sv.bg)}
          ${rs==='mismatch' ? badgeHtml('⚠ MISMATCH','#c8960c','rgba(200,150,12,0.12)') : ''}
        </div>
      </div>
      <div class="row-client">${esc(a.siteName)}</div>
      <div class="row-msg">${esc(a.alertMessage)}</div>
      <div class="row-foot"><span class="row-type">${esc(a.monitorType)}</span>${ticketBadge}</div>
    </div>`;
  }).join('');
}

function renderClientChips() {
  const el = $('alertClientChips'); if(!el) return;
  const visible = getVisibleAlerts();
  const clients = [...new Set(visible.map(a=>a.siteName))].sort();
  const counts = {};
  visible.forEach(a => { counts[a.siteName]=(counts[a.siteName]||0)+1; });
  el.innerHTML = `<span class="client-chip ${state.alertClient==='all'?'on':''}" data-client="all">All</span>` +
    clients.map(c=>`<span class="client-chip ${state.alertClient===c?'on':''}" data-client="${esc(c)}">${esc(c.split(' ').slice(0,2).join(' '))}<span class="chip-count">${counts[c]}</span></span>`).join('');
}

// ─── ALERT DETAIL ─────────────────────────────────────────────────
async function renderAlertDetail(alert) {
  const dp = $('alertDetail'); if(!dp) return;
  state.currentAlert = alert;
  window._lastAlert = alert; // For console debugging — type debugAlert()
  const sv     = SEV[alert.priority]||SEV.Information;
  const ticket = alert.ticketNumber ? state.tickets[alert.ticketNumber] : null;
  const ai     = state.aiResults[alert.alertUid];
  const notes  = state.notesDrafts[alert.alertUid]||'';
  const rs     = getResolutionState(alert);
  const zone   = state.settings.atZone||'14';
  const atBase = `https://ww${zone}.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx`;
  const created = new Date(alert.timestampMs).toLocaleString();

  const mismatchWarning = ticket?.isDone ? `
    <div class="mismatch-warning">⚠ AUTOTASK TICKET IS <strong>${ticket.statusLabel.toUpperCase()}</strong> — DATTO ALERT STILL OPEN. Consider resolving this alert.</div>` : '';

  let ticketBtn = '';
  if (ticket) {
    const tUrl = `${atBase}?Code=OpenTicketDetail&TicketNumber=${encodeURIComponent(alert.ticketNumber)}`;
    ticketBtn = `<a href="${tUrl}" target="_blank" class="abtn abtn-ticket">🎫 OPEN ${esc(alert.ticketNumber)}</a>`;
  } else {
    // Map Datto priority to Autotask priority ID: 1=Critical, 2=High, 3=Medium, 4=Low
    const priorityMap = { Critical: 1, High: 2, Moderate: 3, Low: 4, Information: 4 };
    const atPriority = priorityMap[alert.priority] || 3;

    // Keep title short — AT URL has length limits
    const ticketTitle = `${alert.hostname} - ${alert.priority}: ${alert.alertMessage.substring(0, 60)}`;

    ticketBtn = `<button class="abtn abtn-create" data-action="create-ticket" data-uid="${esc(alert.alertUid)}">＋ CREATE TICKET</button>`;
  }

  const postBtn = ticket && !ticket.isDone ? `<button class="abtn abtn-post" data-action="post-resolution" data-uid="${esc(alert.alertUid)}">↑ POST RESOLUTION</button>` : '';
  const timeBtn = ticket ? `<button class="abtn abtn-time" data-action="log-time" data-uid="${esc(alert.alertUid)}">⏱ LOG TIME</button>` : '';
  const siteAlerts = getVisibleAlerts().filter(a=>a.siteName===alert.siteName&&a.alertUid!==alert.alertUid);

  dp.innerHTML = `
    ${mismatchWarning}
    <div class="detail-card" style="border-top:3px solid ${sv.color}">
      ${renderResolutionFlow(alert)}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap">
        <span class="alert-title">${esc(alert.hostname)}</span>
        ${badgeHtml(alert.priority,sv.color,sv.bg)}
        ${ticket ? `<span class="badge" style="color:${ticket.statusColor};background:${ticket.statusColor}22;border:1px solid ${ticket.statusColor}44">AT: ${esc(ticket.statusLabel)}</span>` : ''}
      </div>
      <div class="alert-meta">
        <span style="color:#00b4d8;font-weight:600">${esc(alert.siteName)}</span>
        <span class="meta-sep">·</span><span>${esc(alert.monitorType)}</span>
        ${alert.ticketNumber ? `<span class="meta-sep">·</span><span style="color:var(--textdim);font-family:var(--mono);font-size:11px">${esc(alert.ticketNumber)}</span>` : ''}
        <span class="meta-sep">·</span><span style="color:var(--textdim)">${created}</span>
      </div>
      <div class="alert-msg">${esc(alert.alertMessage)}</div>
      <div class="action-row">
        <button class="abtn abtn-resolve" data-action="resolve" data-uid="${esc(alert.alertUid)}">✓ RESOLVE</button>
        <button class="abtn abtn-snooze"  data-action="snooze"  data-uid="${esc(alert.alertUid)}">⏸ SNOOZE</button>
        ${ticketBtn}${postBtn}${timeBtn}
        <button class="abtn abtn-kb" data-action="save-kb" data-uid="${esc(alert.alertUid)}">📚 SAVE TO KB</button>
      </div>
    </div>

    <div class="detail-card">
      <div class="ai-header">
        <div>
          <div class="ai-title">★ AI TRIAGE ASSISTANT</div>
          <div class="ai-sub">Powered by Claude · MSP Companion · Synobis AI Solutions</div>
        </div>
        <button class="ai-analyze-btn" data-action="run-ai" data-uid="${esc(alert.alertUid)}">${ai?'↺ RE-ANALYZE':'⚡ ANALYZE ALERT'}</button>
      </div>
      <div id="aiOutput">${ai ? renderAIResult(ai) : '<div class="ai-empty">CLICK ANALYZE ALERT TO GET AI TRIAGE GUIDANCE</div>'}</div>
      ${ai ? `
      <div class="chat-section">
        <div class="chat-history" id="aiChatHistory"></div>
        <div class="chat-input-row">
          <textarea class="chat-textarea" id="aiChatInput" rows="2" data-uid="${esc(alert.alertUid)}" placeholder="Ask a follow-up question about this alert..."></textarea>
          <button class="chat-send" data-action="send-chat" data-uid="${esc(alert.alertUid)}">SEND ➤</button>
        </div>
        <div class="chat-hint">Enter to send · Shift+Enter for new line</div>
      </div>` : ''}
    </div>

    <div class="detail-card">
      <div class="card-label">📝 TECHNICIAN NOTES & AUDIT LOG</div>
      <textarea id="notesInput" rows="4" data-uid="${esc(alert.alertUid)}" placeholder="Log actions taken, findings, or handoff notes...">${esc(notes)}</textarea>
      <div class="notes-footer">
        <span class="saved-lbl" id="notesSaved" style="visibility:hidden">✓ SAVED</span>
        <button class="abtn abtn-ticket" data-action="save-notes" data-uid="${esc(alert.alertUid)}" style="font-size:11px;padding:6px 12px">SAVE NOTES</button>
      </div>
    </div>

    <div class="detail-card">
      <div class="card-label">CLIENT INTELLIGENCE — <span style="color:#00b4d8">${esc(alert.siteName.toUpperCase())}</span></div>
      <div class="site-stats">
        <div class="site-stat"><div class="site-stat-val" style="color:#c8102e">${siteAlerts.filter(a=>a.priority==='Critical').length}</div><div class="site-stat-lbl">CRITICAL</div></div>
        <div class="site-stat"><div class="site-stat-val" style="color:#e07b00">${siteAlerts.filter(a=>a.priority==='High').length}</div><div class="site-stat-lbl">HIGH</div></div>
        <div class="site-stat"><div class="site-stat-val" style="color:#00b4d8">${siteAlerts.length}</div><div class="site-stat-lbl">OTHER ALERTS</div></div>
      </div>
      ${siteAlerts.slice(0,3).map(a2=>`
        <div class="other-alert" data-uid="${esc(a2.alertUid)}">
          <span>${esc(a2.hostname)} — ${esc(a2.alertMessage.substring(0,50))}</span>
          ${badgeHtml(a2.priority,SEV[a2.priority]?.color||'#5a7a96',SEV[a2.priority]?.bg||'transparent')}
        </div>`).join('')}
    </div>`;

  if (ai && state.chatHistories[alert.alertUid]?.length) {
    renderChatHistory(alert.alertUid);
    const h=$('aiChatHistory'); if(h) h.scrollTop=h.scrollHeight;
  }
  document.querySelectorAll('#alertList .list-row').forEach(r => r.classList.toggle('active', r.dataset.uid===alert.alertUid));
}

// ─── AI CHAT ──────────────────────────────────────────────────────
async function sendChat(uid, message) {
  const alert = state.alerts.find(a=>a.alertUid===uid); if(!alert) return;
  const input=$('aiChatInput'), histEl=$('aiChatHistory');
  if(!input||!histEl) return;
  input.value=''; input.disabled=true;
  if(!state.chatHistories[uid]) state.chatHistories[uid]=[];
  state.chatHistories[uid].push({role:'user',content:message});
  renderChatHistory(uid);
  const tid='typing-'+Date.now();
  histEl.insertAdjacentHTML('beforeend',`<div id="${tid}" style="display:flex;gap:8px;align-items:center;padding:8px 0"><div style="display:flex;gap:3px"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite;display:inline-block"></span><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out 0.2s infinite;display:inline-block"></span><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out 0.4s infinite;display:inline-block"></span></div><span style="font-family:var(--cond);font-size:11px;color:var(--textdim)">AI IS THINKING...</span></div>`);
  histEl.scrollTop=histEl.scrollHeight;
  try {
    const system = buildAlertSystemPrompt(alert);
    const msgs   = state.chatHistories[uid].map(m=>({role:m.role,content:m.content}));
    const reply  = await callAI(system, msgs);
    state.chatHistories[uid].push({role:'assistant',content:reply});
    LS.set('msp_chats', state.chatHistories);
  } catch(e) {
    state.chatHistories[uid].push({role:'assistant',content:`Error: ${e.message}`});
  }
  $(tid)?.remove(); input.disabled=false; input.focus();
  renderChatHistory(uid);
  histEl.scrollTop=histEl.scrollHeight;
}

function renderChatHistory(uid) {
  const el=$('aiChatHistory'); if(!el) return;
  el.innerHTML=(state.chatHistories[uid]||[]).map(msg=>{
    const isUser=msg.role==='user';
    return `<div style="display:flex;flex-direction:column;gap:3px;align-self:${isUser?'flex-end':'flex-start'};max-width:92%">
      <div class="chat-lbl ${isUser?'you':''}">${isUser?'YOU':'★ AI ASSISTANT'}</div>
      <div class="chat-msg ${isUser?'chat-you':'chat-ai'}">${esc(msg.content)}</div>
    </div>`;
  }).join('');
}

// ─── TICKET LIST ──────────────────────────────────────────────────
function renderTicketList() {
  const el=$('ticketList'); if(!el) return;
  const tickets = getOpenTickets();
  if (!tickets.length) { el.innerHTML='<div class="loading-state">No open tickets — click Refresh to load</div>'; return; }
  const UNASSIGNED='__unassigned__';
  const groups={};
  tickets.forEach(t => {
    const key = t.assignedResourceName || UNASSIGNED;
    if(!groups[key]) groups[key]={name:key===UNASSIGNED?'Unassigned':key,tickets:[],isUnassigned:key===UNASSIGNED};
    groups[key].tickets.push(t);
  });
  const sorted = Object.values(groups).sort((a,b)=>{ if(a.isUnassigned) return -1; if(b.isUnassigned) return 1; return a.name.localeCompare(b.name); });
  sorted.forEach(g => g.tickets.sort((a,b)=>(a.statusLabel||'').localeCompare(b.statusLabel||'')));
  el.innerHTML = sorted.map(group => {
    const initials = group.isUnassigned ? '?' : group.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
    const rows = group.tickets.map(t=>`
      <div class="list-row ticket-row ${state.currentTicket?.id===t.id?'active':''}" data-ticket-id="${t.id}">
        <div class="row-top">
          <span class="row-device" style="font-size:13px">${esc(t.ticketNumber)}</span>
          <span class="badge" style="color:${t.statusColor||'#8bacc8'};background:${t.statusColor||'#8bacc8'}22;border:1px solid ${t.statusColor||'#8bacc8'}44">${esc(t.statusLabel||'Unknown')}</span>
        </div>
        <div class="row-client purple">${esc(t.title?.substring(0,55)||'No title')}</div>
        <div class="row-foot">
          <span class="row-type">${esc(t.companyName||'AT Ticket')}</span>
          <span style="font-size:11px;color:var(--textdim)">${t.lastActivity?new Date(t.lastActivity).toLocaleDateString():''}</span>
        </div>
      </div>`).join('');
    return `<div class="resource-group">
      <div class="resource-group-header">
        <div class="resource-group-avatar ${group.isUnassigned?'unassigned':''}">${initials}</div>
        <span class="resource-group-name ${group.isUnassigned?'unassigned':''}">${esc(group.name)}</span>
        <span class="resource-group-count">${group.tickets.length}</span>
      </div>${rows}</div>`;
  }).join('');
}

function renderTicketDetail(ticket) {
  const dp=$('ticketDetail'); if(!dp) return;
  const zone=state.settings.atZone||'14';
  const atBase=`https://ww${zone}.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx`;
  const tUrl=`${atBase}?Code=OpenTicketDetail&TicketNumber=${encodeURIComponent(ticket.ticketNumber)}`;
  dp.innerHTML=`
    <div class="detail-card" style="border-top:3px solid ${ticket.statusColor||'#8bacc8'}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap">
        <span class="alert-title" style="font-size:18px">${esc(ticket.ticketNumber)}</span>
        <span class="badge" style="color:${ticket.statusColor||'#8bacc8'};background:${ticket.statusColor||'#8bacc8'}22;border:1px solid ${ticket.statusColor||'#8bacc8'}44">${esc(ticket.statusLabel||'Unknown')}</span>
      </div>
      <div class="alert-msg" style="margin:10px 0">${esc(ticket.title||'No title')}</div>
      ${ticket.companyName ? `<div style="font-size:13px;color:var(--accent);margin-bottom:10px">${esc(ticket.companyName)}</div>` : ''}
      ${ticket.assignedResourceName ? `<div style="font-size:12px;color:var(--textdim);margin-bottom:10px">Assigned: ${esc(ticket.assignedResourceName)}</div>` : ''}
      <div class="action-row">
        <a href="${tUrl}" target="_blank" class="abtn abtn-ticket">🎫 Open in Autotask</a>
        <button class="abtn abtn-time" data-action="log-time-ticket" data-ticket-id="${ticket.id}">⏱ Log Time</button>
        <button class="abtn abtn-kb" data-action="save-kb-ticket" data-ticket-id="${ticket.id}">📚 Save to KB</button>
      </div>
    </div>
    <div class="detail-card">
      <div class="card-label">📝 TECHNICIAN NOTES</div>
      <textarea id="ticketNotesInput" rows="4" placeholder="Log actions taken for this ticket...">${esc(state.notesDrafts['ticket-'+ticket.id]||'')}</textarea>
      <div class="notes-footer">
        <span></span>
        <button class="abtn abtn-post" data-action="post-ticket-resolution" data-ticket-id="${ticket.id}" style="font-size:11px;padding:6px 12px">↑ POST TO AUTOTASK</button>
      </div>
    </div>`;
}

// ─── QUEUE LIST ───────────────────────────────────────────────────
function renderQueueList() {
  const el=$('queueList'); if(!el) return;
  const alerts  = getVisibleAlerts();
  const tickets = getOpenTickets();
  const items = [
    ...alerts.map(a=>({type:'alert',data:a,priority:{Critical:0,High:1,Moderate:2,Low:3,Information:4}[a.priority]??5})),
    ...tickets.map(t=>({type:'ticket',data:t,priority:3})),
  ].sort((a,b)=>a.priority-b.priority);
  if (!items.length) { el.innerHTML='<div class="loading-state">Queue is clear</div>'; return; }
  el.innerHTML = items.map(item => {
    if (item.type==='alert') {
      const a=item.data, sv=SEV[a.priority]||SEV.Information;
      const ticket=a.ticketNumber?state.tickets[a.ticketNumber]:null;
      return `<div class="list-row" data-uid="${esc(a.alertUid)}">
        <div class="row-top"><span class="row-device">${esc(a.hostname)}</span>${badgeHtml(a.priority,sv.color,sv.bg)}</div>
        <div class="row-client">${esc(a.siteName)}</div>
        <div class="row-msg">${esc(a.alertMessage)}</div>
        <div class="row-foot"><span class="row-type">⚡ Alert</span>${ticket?`<span class="badge" style="color:${ticket.statusColor};background:${ticket.statusColor}22;border:1px solid ${ticket.statusColor}44">${esc(ticket.statusLabel)}</span>`:'<span class="row-type" style="color:#c8960c">No Ticket</span>'}</div>
      </div>`;
    } else {
      const t=item.data;
      return `<div class="list-row ticket-row" data-ticket-id="${t.id}">
        <div class="row-top"><span class="row-device" style="font-size:13px">${esc(t.ticketNumber)}</span><span class="badge" style="color:${t.statusColor||'#8bacc8'};background:${t.statusColor||'#8bacc8'}22;border:1px solid ${t.statusColor||'#8bacc8'}44">${esc(t.statusLabel||'Unknown')}</span></div>
        <div class="row-client purple">${esc(t.title?.substring(0,60)||'')}</div>
        <div class="row-foot"><span class="row-type">🎫 ${esc(t.companyName||'Ticket')}</span></div>
      </div>`;
    }
  }).join('');
}

// ─── KNOWLEDGE BASE ───────────────────────────────────────────────
function renderKB(filter='') {
  const kb=LS.get('msp_kb',[]); const el=$('kbList'); if(!el) return;
  const filtered = filter ? kb.filter(e=>[e.title,e.symptoms,e.resolution,...(e.tags||[])].join(' ').toLowerCase().includes(filter.toLowerCase())) : kb;
  if (!filtered.length) { el.innerHTML='<div class="loading-state">No KB entries yet. Resolve an alert and save it to KB to begin.</div>'; return; }
  el.innerHTML=filtered.map(e=>`
    <div class="kb-card">
      <div class="kb-card-title">${esc(e.title)}</div>
      <div class="kb-card-meta">Saved ${new Date(e.savedAt).toLocaleDateString()}${e.client?` · ${esc(e.client)}`:''}</div>
      ${e.symptoms?`<div class="kb-card-preview">${esc(e.symptoms.substring(0,120))}...</div>`:''}
      ${e.resolution?`<div class="kb-card-preview" style="margin-top:4px;color:var(--green)">✓ ${esc(e.resolution.substring(0,100))}...</div>`:''}
      <div class="kb-card-tags">${(e.tags||[]).map(t=>`<span class="kb-tag">${esc(t)}</span>`).join('')}</div>
    </div>`).join('');
}

function saveToKB(alert) {
  const notes=state.notesDrafts[alert.alertUid]||'', ai=state.aiResults[alert.alertUid]||'';
  const kb=LS.get('msp_kb',[]);
  kb.unshift({ id:'kb-'+Date.now(), savedAt:Date.now(), title:`${alert.monitorType} — ${alert.hostname}`, client:alert.siteName, symptoms:alert.alertMessage, resolution:notes||ai.substring(0,500), tags:[alert.siteName,alert.monitorType,alert.ticketNumber].filter(Boolean) });
  LS.set('msp_kb',kb.slice(0,500));
  showToast('✓ Saved to Knowledge Base','ok');
}

function showKBModal(prefill={}) {
  const modal=document.createElement('div');
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  modal.innerHTML=`<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:520px;margin:auto">
    <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)">📚 Save to Knowledge Base</div>
    <div class="field-group"><label>TITLE</label><input type="text" id="kbTitle" value="${esc(prefill.title||'')}" placeholder="Issue title..." /></div>
    <div class="field-group"><label>SYMPTOMS</label><textarea id="kbSymptoms" rows="3" placeholder="What was the problem?">${esc(prefill.symptoms||'')}</textarea></div>
    <div class="field-group"><label>RESOLUTION</label><textarea id="kbResolution" rows="4" placeholder="How was it resolved?">${esc(prefill.resolution||'')}</textarea></div>
    <div class="field-group"><label>TAGS (comma-separated)</label><input type="text" id="kbTags" value="${esc(prefill.tags||'')}" placeholder="client, monitor type..." /></div>
    <div id="kbModalResult" style="font-family:var(--cond);font-size:11px;min-height:14px;margin-bottom:8px"></div>
    <div style="display:flex;gap:8px">
      <button id="kbSaveBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">✓ SAVE TO KB</button>
      <button id="kbCancelBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  $('kbCancelBtn').addEventListener('click',()=>document.body.removeChild(modal));
  $('kbSaveBtn').addEventListener('click',()=>{
    const title=$('kbTitle').value.trim();
    if(!title){$('kbModalResult').textContent='Please enter a title.';return;}
    const kb=LS.get('msp_kb',[]);
    kb.unshift({id:'kb-'+Date.now(),savedAt:Date.now(),title,symptoms:$('kbSymptoms').value.trim(),resolution:$('kbResolution').value.trim(),tags:$('kbTags').value.split(',').map(t=>t.trim()).filter(Boolean)});
    LS.set('msp_kb',kb.slice(0,500));
    document.body.removeChild(modal);
    renderKB();
    showToast('✓ Saved to Knowledge Base','ok');
  });
}

// ─── SETTINGS UI ──────────────────────────────────────────────────
function renderChipList(elId, clientSet) {
  const el=$(elId); if(!el) return;
  const clients=[...clientSet];
  el.innerHTML='';
  if (!clients.length) {
    const s=document.createElement('span');
    s.style.cssText='font-family:var(--cond);font-size:11px;color:var(--textdim)';
    s.textContent='No clients excluded';
    el.appendChild(s); return;
  }
  clients.forEach(c => {
    const chip=document.createElement('span');
    chip.className='excluded-chip';
    chip.textContent='🚫 '+c+' ';
    const rem=document.createElement('span');
    rem.className='excluded-chip-remove';
    rem.textContent='×';
    rem.dataset.remove=c;
    rem.dataset.list=elId;
    chip.appendChild(rem);
    el.appendChild(chip);
  });
}

function renderExcludedChips() {
  renderChipList('rmmExcludedChips', state.excludedClients);
  renderChipList('psaExcludedChips', state.psaExcludedClients);
}

function populateKnownClients() {
  // RMM known clients — from Datto alerts
  const rmmEl=$('rmmKnownClientsList');
  if (rmmEl) {
    rmmEl.innerHTML='';
    const rmmKnown=[...new Set(state.alerts.map(a=>a.siteName).filter(Boolean))].sort();
    rmmKnown.forEach(c => {
      const span=document.createElement('span');
      span.className='known-chip'+(state.excludedClients.has(c)?' excluded':'');
      span.textContent=(state.excludedClients.has(c)?'🚫 ':'')+c;
      span.dataset.known=c; span.dataset.list='rmm';
      rmmEl.appendChild(span);
    });
  }
  // PSA known clients — from Autotask company cache
  const psaEl=$('psaKnownClientsList');
  if (psaEl) {
    psaEl.innerHTML='';
    const psaKnown=[...new Set(Object.values(atCompanyCache).filter(Boolean))].sort();
    psaKnown.forEach(c => {
      const span=document.createElement('span');
      span.className='known-chip'+(state.psaExcludedClients.has(c)?' excluded':'');
      span.textContent=(state.psaExcludedClients.has(c)?'🚫 ':'')+c;
      span.dataset.known=c; span.dataset.list='psa';
      psaEl.appendChild(span);
    });
  }
}

function showSettingsStatus(id, msg, type) {
  const el=$(id); if(!el) return;
  el.textContent=msg; el.className=`settings-status ${type}`;
}

// ─── TIME ENTRY MODAL ─────────────────────────────────────────────
async function showTimeEntryModal(ticketId, ticketNumber) {
  await Promise.all([loadAtResources(),loadAtBillingCodes(),loadAtRoles()]);
  const resOptions  = state.atResources.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const roleOptions = state.atRoles.map(r=>`<option value="${r.id}">${esc(r.name)}</option>`).join('');
  const codeOptions = state.atBillingCodes.map(b=>`<option value="${b.id}">${esc(b.name)}</option>`).join('');
  const modal=document.createElement('div');
  modal.style.cssText='position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
  modal.innerHTML=`<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:480px">
    <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid var(--border)">⏱ LOG TIME — ${esc(ticketNumber||'')}</div>
    <div class="time-form">
      <div class="time-field" style="grid-column:span 2"><label>RESOURCE</label><select id="timeResource">${resOptions}</select></div>
      <div class="time-field"><label>ROLE</label><select id="timeRole">${roleOptions}</select></div>
      <div class="time-field"><label>BILLING CODE</label><select id="timeBillingCode">${codeOptions}</select></div>
      <div class="time-field"><label>HOURS WORKED</label><input type="number" id="timeHours" value="0.5" min="0.25" max="24" step="0.25" /></div>
      <div class="time-field"><label>DATE</label><input type="date" id="timeDate" value="${new Date().toISOString().substring(0,10)}" /></div>
      <div class="time-field" style="grid-column:span 2"><label>SUMMARY</label><input type="text" id="timeSummary" placeholder="Brief description of work done..." /></div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="timeSubmitBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">↑ POST TIME ENTRY</button>
      <button id="timeCancelBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Cancel</button>
    </div>
    <div id="timeResult" style="margin-top:8px;font-family:var(--cond);font-size:11px;min-height:16px"></div>
  </div>`;
  document.body.appendChild(modal);
  $('timeCancelBtn').addEventListener('click',()=>document.body.removeChild(modal));
  $('timeSubmitBtn').addEventListener('click',async()=>{
    const btn=$('timeSubmitBtn'); btn.textContent='Posting...'; btn.disabled=true;
    try {
      await postTimeEntry(ticketId,$('timeResource').value,$('timeRole').value,$('timeBillingCode').value,$('timeHours').value,$('timeSummary').value);
      document.body.removeChild(modal);
      showToast('✓ Time entry posted to Autotask','ok');
    } catch(e) { $('timeResult').textContent=`Error: ${e.message}`; $('timeResult').style.color='#f87191'; btn.textContent='↑ POST TIME ENTRY'; btn.disabled=false; }
  });
}

// ─── MAIN REFRESH ─────────────────────────────────────────────────
async function refreshAll() {
  const btn=$('dashRefreshBtn');
  if(btn){btn.textContent='↺ Refreshing...';btn.disabled=true;}
  try {
    const alerts = await fetchAlerts();
    if (state.settings.autoResolveInfo!==false) {
      for (const a of alerts.filter(a=>a.priority==='Information').slice(0,50)) {
        try { await resolveAlert(a.alertUid); state.resolvedIds.add(a.alertUid); } catch {}
      }
      LS.set('msp_resolved',[...state.resolvedIds]);
    }
    state.alerts = alerts;
    LS.set('msp_alerts', alerts);
    const sites = await fetchSites();
    state.sites = sites;
    const ticketNumbers = [...new Set(alerts.map(a=>a.ticketNumber).filter(Boolean))];
    if (ticketNumbers.length && state.settings.atUser) await syncTicketStatuses(ticketNumbers);
    render();
    showToast(`✓ Refreshed — ${alerts.length} alerts`,'ok');
  } catch(e) {
    showToast(`Error: ${e.message}`,'err');
    console.error('Refresh error:', e);
  } finally {
    if(btn){btn.textContent='↺ Refresh All';btn.disabled=false;}
  }
}

function render() {
  renderDashboard();
  renderClientChips();
  renderAlertList();
  renderTicketList();
  renderQueueList();
  if (state.currentAlert) renderAlertDetail(state.currentAlert);
}

function startAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  if (state.settings.autoRefresh===false) return;
  const mins = parseInt(state.settings.refreshInterval)||5;
  state.autoRefreshTimer = setInterval(()=>refreshAll(), mins*60000);
}

// ─── NAVIGATION ───────────────────────────────────────────────────
function setView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${view}`));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===view));
  if (view==='kb') renderKB();
  if (view==='settings') {
    populateKnownClients();
    // Load queues and populate dropdown
    loadAtQueues().then(() => {
      const sel = document.getElementById('set-defaultQueue');
      if (!sel || !state.atQueues?.length) return;
      const current = state.settings.defaultQueue || '';
      sel.innerHTML = '<option value="">— Select a queue —</option>' +
        state.atQueues.map(q => `<option value="${q.id}" ${String(q.id)===String(current)?'selected':''}>${q.name}</option>`).join('');
    }).catch(() => {});
  }
  LS.set('msp_view', view);
}

// ─── EVENT WIRING ─────────────────────────────────────────────────
function wireEvents() {

  // Mode toggle
  document.getElementById('modeToggleBtn')?.addEventListener('click', () => {
    applyMode(!document.body.classList.contains('light'));
  });

  // Nav
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // Dashboard
  $('dashRefreshBtn')?.addEventListener('click', () => refreshAll());
  $('bulkResolveBtn')?.addEventListener('click', async () => {
    const mismatches = getVisibleAlerts().filter(a=>a.ticketNumber&&state.tickets[a.ticketNumber]?.isDone);
    if (!mismatches.length) return;
    if (!confirm(`Resolve ${mismatches.length} alerts with completed Autotask tickets?`)) return;
    let done=0;
    for (const a of mismatches) { try { await resolveAlert(a.alertUid); state.resolvedIds.add(a.alertUid); done++; } catch {} }
    LS.set('msp_resolved',[...state.resolvedIds]);
    render();
    showToast(`✓ Bulk resolved ${done} alerts`,'ok');
  });

  // Pipeline click
  $('dashPipeline')?.addEventListener('click', e => {
    const item=e.target.closest('[data-uid]'); if(!item?.dataset.uid) return;
    const alert=state.alerts.find(a=>a.alertUid===item.dataset.uid);
    if(alert){setView('alerts');renderAlertDetail(alert);}
  });

  // Client grid click
  $('dashClientGrid')?.addEventListener('click', e => {
    const card=e.target.closest('[data-client-filter]'); if(!card) return;
    state.alertClient=card.dataset.clientFilter;
    setView('alerts'); renderClientChips(); renderAlertList();
  });

  // Alert filters
  $('alertFilters')?.addEventListener('click', e => {
    const chip=e.target.closest('.filter-chip'); if(!chip) return;
    state.alertFilter=chip.dataset.filter;
    document.querySelectorAll('#alertFilters .filter-chip').forEach(c=>c.classList.toggle('active',c.dataset.filter===state.alertFilter));
    renderAlertList();
  });

  // Client chips
  $('alertClientChips')?.addEventListener('click', e => {
    const chip=e.target.closest('.client-chip'); if(!chip) return;
    state.alertClient=chip.dataset.client;
    document.querySelectorAll('.client-chip').forEach(c=>c.classList.toggle('on',c.dataset.client===state.alertClient));
    renderAlertList();
  });

  // Alert list
  $('alertList')?.addEventListener('click', e => {
    const row=e.target.closest('.list-row'); if(!row?.dataset.uid) return;
    const alert=state.alerts.find(a=>a.alertUid===row.dataset.uid);
    if(alert) renderAlertDetail(alert);
  });

  // Ticket list
  $('ticketList')?.addEventListener('click', e => {
    const row=e.target.closest('[data-ticket-id]'); if(!row) return;
    const ticket=Object.values(state.tickets).find(t=>String(t.id)===row.dataset.ticketId);
    if(ticket){state.currentTicket=ticket;renderTicketDetail(ticket);renderTicketList();}
  });

  // Ticket refresh
  $('ticketRefreshBtn')?.addEventListener('click', async () => {
    const btn=$('ticketRefreshBtn');
    if(btn){btn.textContent='↺ Loading...';btn.disabled=true;}
    try {
      const items=await fetchAtTicketQueue();
      items.forEach(t=>{
        state.tickets[t.ticketNumber]={
          id:t.id,ticketNumber:t.ticketNumber,status:t.status,statusLabel:t.statusLabel,statusColor:t.statusColor,isDone:t.isDone,
          title:t.title,companyID:t.companyID,companyName:t.companyName,lastActivity:t.lastActivityDate,
          assignedResourceID:t.assignedResourceID,assignedResourceName:t.assignedResourceName,
        };
      });
      LS.set('msp_tickets',state.tickets);
      render();
      showToast(`✓ Loaded ${items.length} open tickets`,'ok');
    } catch(e){showToast(`Ticket sync error: ${e.message}`,'err');}
    finally{if(btn){btn.textContent='↺ Refresh';btn.disabled=false;}}
  });

  // Queue list
  $('queueList')?.addEventListener('click', e => {
    const row=e.target.closest('.list-row'); if(!row) return;
    if(row.dataset.uid){
      const alert=state.alerts.find(a=>a.alertUid===row.dataset.uid);
      if(alert){setView('alerts');renderAlertDetail(alert);}
    } else if(row.dataset.ticketId){
      const ticket=Object.values(state.tickets).find(t=>String(t.id)===row.dataset.ticketId);
      if(ticket){setView('tickets');state.currentTicket=ticket;renderTicketDetail(ticket);}
    }
  });

  // Detail panel delegated actions
  document.addEventListener('click', async e => {
    const el=e.target.closest('[data-action]'); if(!el) return;
    const action=el.dataset.action, uid=el.dataset.uid;

    if (action==='create-ticket') {
      const alert=state.alerts.find(a=>a.alertUid===uid); if(!alert) return;
      el.textContent='Creating...'; el.disabled=true;
      try {
        const newTicket = await createTicketForAlert(alert);
        // Store ticket in state
        state.tickets[newTicket.ticketNumber] = {
          id: newTicket.id, ticketNumber: newTicket.ticketNumber,
          status: newTicket.status, statusLabel: 'New', statusColor: '#4e7fff', isDone: false,
          title: newTicket.title, companyID: newTicket.companyID,
          companyName: alert.siteName, assignedResourceID: null, assignedResourceName: null,
          lastActivity: new Date().toISOString(),
        };
        LS.set('msp_tickets', state.tickets);
        // Link alert to ticket
        alert.ticketNumber = newTicket.ticketNumber;
        // Open ticket in Autotask
        const zone = state.settings.atZone || '14';
        const tUrl = `https://ww${zone}.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketNumber=${encodeURIComponent(newTicket.ticketNumber)}`;
        window.open(tUrl, '_blank');
        render();
        await renderAlertDetail(alert);
        showToast(`✓ Ticket ${newTicket.ticketNumber} created in Autotask`, 'ok');
      } catch(e) {
        showToast(`Error creating ticket: ${e.message}`, 'err');
        el.textContent='＋ CREATE TICKET'; el.disabled=false;
      }
      return;
    }

    if (action==='resolve') {
      if(!confirm('Resolve this alert in Datto RMM?')) return;
      try {
        await resolveAlert(uid);
        state.resolvedIds.add(uid); LS.set('msp_resolved',[...state.resolvedIds]);
        state.currentAlert=null;
        $('alertDetail').innerHTML='<div class="empty-detail"><div class="empty-icon">✓</div><div class="empty-title">Alert Resolved</div></div>';
        render(); showToast('✓ Alert resolved','ok');
      } catch(e){showToast(`Error: ${e.message}`,'err');}
    }

    if (action==='snooze') {
      state.snoozedIds.add(uid); LS.set('msp_snoozed',[...state.snoozedIds]);
      state.currentAlert=null;
      $('alertDetail').innerHTML='<div class="empty-detail"><div class="empty-icon">⏸</div><div class="empty-title">Alert Snoozed</div></div>';
      render(); showToast('Alert snoozed','info');
    }

    if (action==='run-ai') {
      const alert=state.alerts.find(a=>a.alertUid===uid); if(!alert) return;
      const aiOut=$('aiOutput');
      if(aiOut) aiOut.innerHTML='<div class="ai-loading"><div class="pulse-dot"></div>Analyzing alert with full context...</div>';
      el.textContent='Analyzing...'; el.disabled=true;
      try {
        const result=await callAI(buildAlertSystemPrompt(alert),[{role:'user',content:`Analyze this alert for ${alert.hostname} — ${alert.alertMessage}`}]);
        state.aiResults[uid]=result; LS.set('msp_ai',state.aiResults);
        await renderAlertDetail(alert);
      } catch(err) {
        if(aiOut) aiOut.innerHTML=`<div class="ai-empty" style="color:#f87191">Error: ${esc(err.message)}</div>`;
        el.textContent='⚡ ANALYZE ALERT'; el.disabled=false;
      }
    }

    if (action==='send-chat') {
      const input=$('aiChatInput');
      const msg=input?.value.trim();
      if(uid&&msg) sendChat(uid,msg);
    }

    if (action==='save-notes') {
      const input=$('notesInput');
      if(input){
        state.notesDrafts[uid]=input.value; LS.set('msp_notes',state.notesDrafts);
        const lbl=$('notesSaved');
        if(lbl){lbl.style.visibility='visible';setTimeout(()=>lbl.style.visibility='hidden',2000);}
        showToast('Notes saved','ok');
      }
    }

    if (action==='save-kb') {
      const alert=state.alerts.find(a=>a.alertUid===uid);
      if(alert) saveToKB(alert);
    }

    if (action==='post-resolution') {
      const alert=state.alerts.find(a=>a.alertUid===uid); if(!alert?.ticketNumber) return;
      const ticket=state.tickets[alert.ticketNumber]; if(!ticket) return;
      const notes=state.notesDrafts[uid]||state.aiResults[uid]||'';
      if(!notes){showToast('Add notes or analyze with AI first','info');return;}
      try { await postResolutionToAt(ticket.id,notes,ticket.assignedResourceID); showToast('✓ Resolution posted to Autotask','ok'); }
      catch(e){showToast(`Error: ${e.message}`,'err');}
    }

    if (action==='log-time') {
      const alert=state.alerts.find(a=>a.alertUid===uid); if(!alert?.ticketNumber) return;
      const ticket=state.tickets[alert.ticketNumber]; if(!ticket) return;
      showTimeEntryModal(ticket.id, ticket.ticketNumber);
    }

    if (action==='log-time-ticket') {
      const ticketId=el.dataset.ticketId;
      const ticket=Object.values(state.tickets).find(t=>String(t.id)===ticketId); if(!ticket) return;
      showTimeEntryModal(ticket.id, ticket.ticketNumber);
    }

    if (action==='post-ticket-resolution') {
      const ticketId=el.dataset.ticketId;
      const ticket=Object.values(state.tickets).find(t=>String(t.id)===ticketId); if(!ticket) return;
      const input=$('ticketNotesInput'); if(!input?.value.trim()){showToast('Enter notes first','info');return;}
      try { await postResolutionToAt(ticket.id,input.value.trim(),ticket.assignedResourceID); showToast('✓ Resolution posted to Autotask','ok'); }
      catch(e){showToast(`Error: ${e.message}`,'err');}
    }

    if (action==='save-kb-ticket') {
      showKBModal();
    }
  });

  // Enter to send chat
  document.addEventListener('keydown', e => {
    if(e.target.id==='aiChatInput'&&e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      const uid=e.target.dataset.uid, msg=e.target.value.trim();
      if(uid&&msg) sendChat(uid,msg);
    }
  });

  // Notes autosave
  document.addEventListener('input', e => {
    if(e.target.id==='notesInput'){
      const uid=e.target.dataset.uid;
      if(uid) state.notesDrafts[uid]=e.target.value;
    }
    if(e.target.id==='ticketNotesInput'){
      const ticketId=state.currentTicket?.id;
      if(ticketId) state.notesDrafts['ticket-'+ticketId]=e.target.value;
    }
  });

  // KB
  $('kbSearch')?.addEventListener('input', e=>renderKB(e.target.value));
  $('kbAddBtn')?.addEventListener('click', ()=>showKBModal());

  // Settings — Datto
  $('saveDattoBtn')?.addEventListener('click', () => {
    saveSettings({apiKey:$('set-apiKey')?.value.trim(),secretKey:$('set-secretKey')?.value.trim(),platformUrl:$('set-platformUrl')?.value.trim()});
    showSettingsStatus('dattoStatus','✓ Datto credentials saved','ok');
  });
  $('testDattoBtn')?.addEventListener('click', async () => {
    saveSettings({apiKey:$('set-apiKey')?.value.trim(),secretKey:$('set-secretKey')?.value.trim(),platformUrl:$('set-platformUrl')?.value.trim()});
    showSettingsStatus('dattoStatus','Testing...','info');
    dattoToken=null; dattoTokenExpiry=0;
    try { await dattoAuth(); showSettingsStatus('dattoStatus','✓ Connected to Datto RMM','ok'); }
    catch(e){showSettingsStatus('dattoStatus',`✗ ${e.message}`,'err');}
  });

  // Settings — Autotask
  $('saveAtBtn')?.addEventListener('click', () => {
    saveSettings({atUser:$('set-atUser')?.value.trim(),atSecret:$('set-atSecret')?.value.trim(),atZone:$('set-atZone')?.value.trim(),atIntCode:$('set-atIntCode')?.value.trim()});
    showSettingsStatus('atStatus','✓ Autotask credentials saved','ok');
  });
  $('testAtBtn')?.addEventListener('click', async () => {
    saveSettings({atUser:$('set-atUser')?.value.trim(),atSecret:$('set-atSecret')?.value.trim(),atZone:$('set-atZone')?.value.trim(),atIntCode:$('set-atIntCode')?.value.trim()});
    showSettingsStatus('atStatus','Testing...','info');
    try { state.atStatusPicklist=null; LS.set('msp_at_picklist',null); await loadAtStatusPicklist(); showSettingsStatus('atStatus','✓ Connected to Autotask','ok'); }
    catch(e){showSettingsStatus('atStatus',`✗ ${e.message}`,'err');}
  });

  // Settings — AI
  $('saveAiBtn')?.addEventListener('click', () => {
    const key=$('set-anthropicKey')?.value.trim();
    if(!key){showSettingsStatus('aiStatus','✗ Please enter your API key','err');return;}
    saveSettings({anthropicKey:key}); showSettingsStatus('aiStatus','✓ API key saved','ok');
  });
  $('testAiBtn')?.addEventListener('click', async () => {
    const key=$('set-anthropicKey')?.value.trim();
    saveSettings({anthropicKey:key}); showSettingsStatus('aiStatus','Testing AI...','info');
    try { const reply=await callAI('You are a helpful assistant.',[{role:'user',content:'Reply with just: AI OK'}]); showSettingsStatus('aiStatus',`✓ AI working — ${reply.substring(0,30)}`,'ok'); }
    catch(e){showSettingsStatus('aiStatus',`✗ ${e.message}`,'err');}
  });

  // Settings — Preferences
  $('savePrefsBtn')?.addEventListener('click', () => {
    saveSettings({
      autoResolveInfo: $('set-autoResolveInfo')?.checked,
      notifications:   $('set-notifications')?.checked,
      autoRefresh:     $('set-autoRefresh')?.checked,
      refreshInterval: parseInt($('set-refreshInterval')?.value)||5,
      defaultQueue:    $('set-defaultQueue')?.value || '',
    });
    startAutoRefresh(); showSettingsStatus('prefsStatus','✓ Preferences saved','ok');
  });

  // Settings — RMM Excluded clients
  $('rmmAddExcludeBtn')?.addEventListener('click', () => {
    const val=$('rmmExcludeInput')?.value.trim();
    if(val&&!state.excludedClients.has(val)){
      state.excludedClients.add(val);
      if($('rmmExcludeInput'))$('rmmExcludeInput').value='';
      renderExcludedChips();
    }
  });
  $('rmmExcludeInput')?.addEventListener('keydown', e=>{if(e.key==='Enter')$('rmmAddExcludeBtn')?.click();});
  $('rmmSaveExcludeBtn')?.addEventListener('click', () => {
    LS.set('msp_excluded',[...state.excludedClients]);
    render(); showToast(`✓ RMM exclusions saved — ${state.excludedClients.size} client(s) excluded`,'ok');
  });

  // Settings — PSA Excluded clients
  $('psaAddExcludeBtn')?.addEventListener('click', () => {
    const val=$('psaExcludeInput')?.value.trim();
    if(val&&!state.psaExcludedClients.has(val)){
      state.psaExcludedClients.add(val);
      if($('psaExcludeInput'))$('psaExcludeInput').value='';
      renderExcludedChips();
    }
  });
  $('psaExcludeInput')?.addEventListener('keydown', e=>{if(e.key==='Enter')$('psaAddExcludeBtn')?.click();});
  $('psaSaveExcludeBtn')?.addEventListener('click', () => {
    LS.set('msp_psa_excluded',[...state.psaExcludedClients]);
    render(); showToast(`✓ PSA exclusions saved — ${state.psaExcludedClients.size} client(s) excluded`,'ok');
  });

  // Chip remove — works for both lists
  document.addEventListener('click', e => {
    const rem=e.target.closest('.excluded-chip-remove[data-remove]');
    if (!rem) return;
    const list=rem.dataset.list, name=rem.dataset.remove;
    if(list==='psaExcludedChips') state.psaExcludedClients.delete(name);
    else state.excludedClients.delete(name);
    renderExcludedChips();
  }, true);

  // Known client chip toggle — works for both lists
  document.addEventListener('click', e => {
    const chip=e.target.closest('.known-chip[data-known]'); if(!chip) return;
    const name=chip.dataset.known, list=chip.dataset.list;
    if(list==='psa'){
      if(state.psaExcludedClients.has(name)) state.psaExcludedClients.delete(name);
      else state.psaExcludedClients.add(name);
      chip.classList.toggle('excluded',state.psaExcludedClients.has(name));
      chip.textContent=(state.psaExcludedClients.has(name)?'🚫 ':'')+name;
      chip.dataset.known=name;
    } else {
      if(state.excludedClients.has(name)) state.excludedClients.delete(name);
      else state.excludedClients.add(name);
      chip.classList.toggle('excluded',state.excludedClients.has(name));
      chip.textContent=(state.excludedClients.has(name)?'🚫 ':'')+name;
      chip.dataset.known=name;
    }
    renderExcludedChips();
  }, true);
}

// ─── SERVICE WORKER ───────────────────────────────────────────────
function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(e=>console.warn('SW failed:',e));
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────
async function boot() {
  registerSW();
  loadSettings();
  applyMode(LS.get('msp_lightmode', false));
  const lastView = LS.get('msp_view','dashboard');
  setView(lastView);

  // Restore AT company name cache
  atCompanyCache = LS.get('msp_at_companies', {});

  // Load and sanitize cached data
  const cachedAlerts = LS.get('msp_alerts',[]);
  if (cachedAlerts.length) {
    state.alerts = cachedAlerts;
    const rawTickets = LS.get('msp_tickets',{});
    Object.values(rawTickets).forEach(t=>{
      if(!t.statusColor) t.statusColor='#8bacc8';
      if(!t.statusLabel) t.statusLabel='Unknown';
      if(t.isDone===undefined) t.isDone=false;
      if(!t.assignedResourceName) t.assignedResourceName=null;
      if(!t.companyName) t.companyName=null;
    });
    state.tickets = rawTickets;
    render();
  }

  wireEvents();
  populateKnownClients();
  startAutoRefresh();

  if (state.settings.apiKey && state.settings.secretKey) {
    await refreshAll();
  } else {
    setView('settings');
    showToast('Welcome to MSP Companion — configure your credentials in Settings','info');
  }
}

boot();
