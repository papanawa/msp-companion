'use strict';

// ─── STATE ────────────────────────────────────────────────────────
const state = {
  alerts: [], sites: [], tickets: {},
  atStatusPicklist: null, atPriorityPicklist: null, atResources: [], atBillingCodes: [], atRoles: [],
  resolvedIds: new Set(), snoozedIds: new Set(), excludedClients: new Set(), psaExcludedClients: new Set(), atQueues: [],
  notesDrafts: {}, aiResults: {}, chatHistories: {},
  ticketChatHistories: {},
  kbContextCache: {}, historyContextCache: {},
  investigations: {},
  currentView: 'dashboard', currentAlert: null, currentTicket: null,
  alertFilter: 'all', alertClient: 'all', settings: {},
  ticketStatusFilter: 'active', ticketShowStale: false,
  reportsRange: 30, reportsResolvedTickets: null, reportsResolvedAlerts: null,
  clients: null,                      // unified client list (AT companies + Datto sites)
  hiddenClients: new Set(),           // client names hidden from the list
  showHiddenClients: false,           // toggle to reveal hidden clients
  currentClient: null,                // currently-viewed client object
  clientDevicesCache: {},             // siteUid → { devices, fetchedAt }
  clientResolvedCache: null,          // { items, fetchedAt } — resolved tickets last 14d
  drillPanel: null,                   // active drill-down panel state
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
  state.hiddenClients = new Set(LS.get('msp_hidden_clients', []));
  state.notesDrafts   = LS.get('msp_notes', {});
  state.aiResults     = LS.get('msp_ai', {});
  state.chatHistories = LS.get('msp_chats', {});
  state.ticketChatHistories = LS.get('msp_ticket_chats', {});
  state.kbContextCache      = LS.get('msp_kb_context_cache', {});
  state.historyContextCache = LS.get('msp_history_context_cache', {});
  state.investigations      = LS.get('msp_investigations', {});
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

// ─── Datto Device Cache ──────────────────────────────────────────
const DEVICE_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
state.deviceCache = state.deviceCache || {};

async function fetchDattoDevice(deviceUid) {
  if (!deviceUid) return null;
  const cached = state.deviceCache[deviceUid];
  if (cached && (Date.now() - cached.fetchedAt) < DEVICE_CACHE_TTL_MS) return cached.data;
  try {
    const [device, openAlerts] = await Promise.all([
      dattoFetch(`/device/${deviceUid}`),
      dattoFetch(`/device/${deviceUid}/alerts/open?max=50`).catch(() => ({ alerts: [] })),
    ]);
    const data = { device, openAlertCount: (openAlerts?.alerts || openAlerts?.items || []).length };
    state.deviceCache[deviceUid] = { data, fetchedAt: Date.now() };
    return data;
  } catch(e) { console.warn('Device fetch failed:', e.message); return null; }
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
    else if (cls.includes('srvc') || cls.includes('service') || cls.includes('process') || monitorType.includes('service')) {
      const service = ctx.serviceName || ctx.processName || ctx.name || ctx.service || '';
      const status  = (ctx.status || ctx.state || '').toUpperCase();
      if (service && status) alertMessage = `Service '${service}' is ${status.toLowerCase()}`;
      else if (service) alertMessage = `Service alert: ${service}`;
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
    deviceUid:   src.deviceUid  || raw.deviceUid  || null,
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
// Also expose state itself on window so you can poke at it from the console.
window.state = state;
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

// Debug: compare cached ticket data vs live Autotask for one ticket.
// Usage: await debugTicket('T20260416.0044')
window.debugTicket = async (ticketNumber) => {
  const cached = state.tickets[ticketNumber];
  console.log('=== CACHED IN COMPANION ===');
  console.log(cached || '(not in cache)');
  if (!cached?.id) { console.log('No id to query AT with'); return; }
  try {
    const fresh = await atFetch(`/Tickets/${cached.id}`);
    const t = fresh?.item || fresh;
    console.log('=== LIVE FROM AUTOTASK ===');
    console.log({
      id: t.id,
      ticketNumber: t.ticketNumber,
      status: t.status,
      assignedResourceID: t.assignedResourceID,
      queueID: t.queueID,
      priority: t.priority,
      title: t.title,
      companyID: t.companyID,
    });
    const resourceName = t.assignedResourceID
      ? (state.atResources.find(r => r.id === t.assignedResourceID)?.name || `(ID ${t.assignedResourceID} not in loaded resources)`)
      : '(unassigned)';
    console.log('Live resource name:', resourceName);
    console.log('Cached resource name:', cached.assignedResourceName);
    if (cached.assignedResourceID !== t.assignedResourceID) {
      console.log('⚠️ MISMATCH — cached has assignedResourceID=' + cached.assignedResourceID + ' but AT has =' + t.assignedResourceID);
    }
  } catch(e) {
    console.log('AT fetch failed:', e.message);
  }
};

// Nuke cached tickets and force a clean resync. Console: await resetTickets()
window.resetTickets = async () => {
  console.log('Clearing msp_tickets cache...');
  state.tickets = {};
  LS.set('msp_tickets', {});
  console.log('Cache cleared. Clicking Refresh now...');
  document.getElementById('ticketRefreshBtn')?.click();
};

// Direct AT query to see what's really coming back. Console: await debugTicketQuery()
window.debugTicketQuery = async () => {
  console.log('=== STATUS PICKLIST ===');
  const pl = await loadAtStatusPicklist();
  Object.entries(pl).forEach(([v, i]) => console.log(`  ${v}: ${i.label}${i.done ? ' [DONE]' : ''}`));

  console.log('\n=== TRY 1: Only exclude status=5 (standard "Complete") ===');
  try {
    const r1 = await atFetch('/Tickets/query', 'POST', {
      MaxRecords: 500,
      filter: [{ op: 'noteq', field: 'status', value: 5 }],
      IncludeFields: ['id', 'ticketNumber', 'status', 'assignedResourceID'],
    });
    console.log(`  Got ${r1?.items?.length || 0} tickets`);
    console.log('  Status distribution:', (r1?.items || []).reduce((a, t) => { a[t.status] = (a[t.status]||0)+1; return a; }, {}));
    console.log('  Assigned breakdown:', (r1?.items || []).reduce((a, t) => {
      const k = t.assignedResourceID || 'unassigned';
      a[k] = (a[k]||0)+1;
      return a;
    }, {}));
  } catch(e) { console.error('  Failed:', e.message); }

  console.log('\n=== TRY 2: What Companion actually uses ===');
  try {
    const items = await fetchAtTicketQueue();
    console.log(`  Got ${items.length} tickets`);
  } catch(e) { console.error('  Failed:', e.message); }

  console.log('\n=== RESOURCES ===');
  await loadAtResources();
  console.log(`  ${state.atResources.length} resources loaded`);
  state.atResources.forEach(r => console.log(`    ${r.id}: ${r.name}`));
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

async function loadAtPriorityPicklist() {
  if (state.atPriorityPicklist) return state.atPriorityPicklist;
  const cached = LS.get('msp_at_priority_picklist');
  if (cached) { state.atPriorityPicklist = cached; return cached; }
  try {
    const data = await atFetch('/Tickets/entityInformation/fields');
    const field = (data?.fields || []).find(f => f.name === 'priority');
    const pl = {};
    (field?.picklistValues || []).forEach(pv => {
      if (pv.isActive === false) return;
      const l = (pv.label||'').toLowerCase();
      let color = '#8bacc8';
      if (l.includes('critical'))           color = '#c8102e';
      else if (l.includes('high'))          color = '#e07b00';
      else if (l.includes('medium')||l.includes('normal')) color = '#c8a000';
      else if (l.includes('low'))           color = '#2a9d5c';
      pl[pv.value] = { label: pv.label, color };
    });
    state.atPriorityPicklist = pl;
    LS.set('msp_at_priority_picklist', pl);
    return pl;
  } catch(e) { console.warn('AT priority picklist failed:', e.message); return {}; }
}

// Consolidated loader for Issue Type, Sub-Issue Type, Source picklists (one API call)
async function loadAtTicketPicklists() {
  if (state.atTicketPicklists) return state.atTicketPicklists;
  const cached = LS.get('msp_at_ticket_picklists');
  if (cached) { state.atTicketPicklists = cached; return cached; }
  try {
    const data = await atFetch('/Tickets/entityInformation/fields');
    const fields = data?.fields || [];
    const buildMap = (name) => {
      const f = fields.find(x => x.name === name);
      const m = {};
      (f?.picklistValues || []).forEach(pv => {
        if (pv.isActive === false) return;
        m[pv.value] = { label: pv.label, parentValue: pv.parentValue };
      });
      return m;
    };
    const pl = {
      issueType: buildMap('issueType'),
      subIssueType: buildMap('subIssueType'),
      source: buildMap('source'),
    };
    state.atTicketPicklists = pl;
    LS.set('msp_at_ticket_picklists', pl);
    return pl;
  } catch(e) { console.warn('AT ticket picklists failed:', e.message); return { issueType:{}, subIssueType:{}, source:{} }; }
}

async function fetchAtContractName(contractId) {
  if (!contractId) return null;
  state.atContractCache = state.atContractCache || {};
  if (state.atContractCache[contractId]) return state.atContractCache[contractId];
  try {
    const data = await atFetch(`/Contracts/${contractId}`);
    const name = (data?.item || data)?.contractName || null;
    if (name) state.atContractCache[contractId] = name;
    return name;
  } catch(e) { console.warn('Contract fetch failed:', e.message); return null; }
}

async function fetchAtTicketActivityNotes(ticketId) {
  // Expanded version of fetchAtTicketNotes — pulls 10 notes with noteType + resource for activity feed
  try {
    const data = await atFetch(`/Tickets/${ticketId}/Notes/query`, 'POST', {
      MaxRecords: 10,
      filter: [{ op: 'gte', field: 'id', value: 0 }],
      IncludeFields: ['id','title','description','noteType','publish','createDateTime','lastActivityDate','creatorResourceID'],
    });
    const items = data?.items || [];
    items.sort((a,b) => {
      const aT = a.createDateTime || a.lastActivityDate || '';
      const bT = b.createDateTime || b.lastActivityDate || '';
      return bT.localeCompare(aT);
    });
    return items.slice(0, 10);
  } catch(e) { console.warn('Activity notes fetch failed:', e.message); return []; }
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
        IncludeFields: ['id','ticketNumber','status','title','priority','queueID','assignedResourceID','lastActivityDate','companyID'],
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
          priority: t.priority, queueID: t.queueID,
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
    const data = await atFetch('/Resources/query', 'POST', {
      filter:[{op:'eq',field:'isActive',value:true}],
      IncludeFields: ['id','firstName','lastName','defaultServiceDeskRoleID'],
    });
    state.atResources = (data?.items||[])
      .filter(r => { const n = ((r.firstName||'')+' '+(r.lastName||'')).trim().toLowerCase(); return !n.includes('api')&&!n.includes('integration'); })
      .map(r => ({
        id: r.id,
        name: ((r.firstName||'')+' '+(r.lastName||'')).trim(),
        defaultRoleID: r.defaultServiceDeskRoleID || null,
      }));
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
    const data = await atFetch('/Roles/query','POST',{
      filter:[{op:'eq',field:'isActive',value:true}],
      IncludeFields: ['id','name','isSystemRole','roleType'],
    });
    state.atRoles = (data?.items||[]).map(r => ({
      id: r.id,
      name: r.name,
      isSystem: !!r.isSystemRole,
      roleType: r.roleType, // 1 = Service Desk role in AT
    }));
    console.log('Loaded roles:', state.atRoles.map(r => `${r.id}: ${r.name} (type ${r.roleType}${r.isSystem?', system':''})`));
  } catch(e) { console.warn('Roles failed:', e.message); }
}

// Pick a service-desk-eligible role for ticket assignment when a resource has no default.
// Avoids system roles and non-service-desk role types that AT rejects on ticket patches.
function findFallbackServiceDeskRoleId() {
  if (!state.atRoles.length) return null;
  // Prefer roleType=1 (Service Desk), non-system, name like "Tech" / "Engineer" / "Support"
  const sdRoles = state.atRoles.filter(r => !r.isSystem);
  const preferred = sdRoles.find(r =>
    /tech|engineer|support|service.*desk|tier/i.test(r.name)
  );
  if (preferred) return preferred.id;
  // Otherwise any roleType=1 role
  const anySd = sdRoles.find(r => r.roleType === 1);
  if (anySd) return anySd.id;
  // Last resort
  return sdRoles[0]?.id || null;
}

// Cache of Autotask companyID -> company name
let atCompanyCache = {};

async function loadAtQueues() {
  if (state.atQueues?.length) return;
  try {
    // queueID is a picklist on the Tickets entity — same endpoint we use for status
    const data = await atFetch('/Tickets/entityInformation/fields');
    const queueField = (data?.fields || []).find(f => f.name === 'queueID');
    state.atQueues = (queueField?.picklistValues || [])
      .filter(q => q.isActive !== false && q.label)
      .map(q => ({ id: parseInt(q.value), name: q.label }))
      .sort((a, b) => a.name.localeCompare(b.name));
    console.log('Loaded queues:', state.atQueues.map(q => q.name));
  } catch(e) { console.warn('Queue fetch failed:', e.message); state.atQueues = []; }
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
  // Chunk requests — querying 100+ IDs in one filter sometimes upsets AT's zone proxy
  const CHUNK = 100;
  const chunks = [];
  for (let i = 0; i < missing.length; i += CHUNK) chunks.push(missing.slice(i, i + CHUNK));
  for (const chunk of chunks) {
    try {
      // Autotask REST uses 'Companies' endpoint; companyName is the canonical field.
      // IncludeFields with accountName causes "Unable to find accountName in Company Entity" 500s on some zones.
      const data = await atFetch('/Companies/query', 'POST', {
        MaxRecords: 500,
        filter: [{ op: 'in', field: 'id', value: chunk }],
        IncludeFields: ['id', 'companyName'],
      });
      (data?.items || []).forEach(c => {
        const name = c.companyName || c.name || null;
        if (c.id && name) atCompanyCache[c.id] = name;
      });
      if (!data?.items?.length) {
        console.warn('AT Companies query returned no items. IDs:', chunk.slice(0, 5));
      }
    } catch(e) {
      console.warn('Company name chunk failed (non-fatal):', e.message, 'IDs:', chunk.slice(0, 5));
      // No fallback to /Accounts — that endpoint doesn't exist in modern AT REST.
    }
  }
  LS.set('msp_at_companies', atCompanyCache);
}

async function fetchAtTicketQueue() {
  await loadAtStatusPicklist();
  const pl = state.atStatusPicklist || {};
  const doneValues = Object.entries(pl).filter(([,i])=>i.done).map(([v])=>parseInt(v)).filter(Boolean);
  const filter = doneValues.length > 0
    ? doneValues.map(v => ({ op:'noteq', field:'status', value:v }))
    : [{ op:'noteq', field:'status', value:5 }];
  console.log('[fetchAtTicketQueue] Excluding done statuses:', doneValues, 'Filter:', filter);
  const data = await atFetch('/Tickets/query','POST',{
    MaxRecords: 500,
    filter,
    IncludeFields: ['id','ticketNumber','status','title','priority','queueID','assignedResourceID','companyID','lastActivityDate','createDate'],
  });
  const items = data?.items || [];
  console.log('[fetchAtTicketQueue] AT returned', items.length, 'tickets. Page details:', data?.pageDetails);
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
  // Map Datto priority to Autotask priority ID (Synobis AT picklist: 4=Critical, 1=High, 2=Normal)
  const priorityMap = { Critical: 4, High: 1, Moderate: 2, Low: 2, Information: 2 };
  const atPriority = priorityMap[alert.priority] || 2;

  // Build title — clean and concise
  const title = `${alert.hostname} - ${alert.priority}: ${alert.alertMessage.substring(0, 80)}`;

  // Build description — clean, no redundant header block, fits in AT's limit
  const aiText = state.aiResults[alert.alertUid] || '';
  const descParts = [
    `Device: ${alert.hostname} | Client: ${alert.siteName}`,
    `Priority: ${alert.priority} | Monitor: ${alert.monitorType}`,
    `Time: ${new Date(alert.timestampMs).toLocaleString()}`,
    '',
    alert.alertMessage,
  ];
  if (aiText) {
    descParts.push('', '── AI TRIAGE ──', aiText.substring(0, 500));
  }
  descParts.push('', '── MSP Companion · Synobis Network Solutions ──');
  const description = descParts.join('\n');

  // Find the Autotask company ID — check cache first, then query AT directly
  let companyId = Object.entries(atCompanyCache).find(([, name]) => name === alert.siteName)?.[0];
  if (!companyId) {
    // Not in cache — query AT Companies directly by name
    try {
      const compData = await atFetch('/Companies/query', 'POST', {
        MaxRecords: 5,
        filter: [{ op: 'contains', field: 'companyName', value: alert.siteName }],
        IncludeFields: ['id', 'companyName'],
      });
      const match = (compData?.items || []).find(c =>
        c.companyName?.toLowerCase() === alert.siteName?.toLowerCase()
      ) || compData?.items?.[0];
      if (match) {
        companyId = match.id;
        atCompanyCache[match.id] = match.companyName;
        LS.set('msp_at_companies', atCompanyCache);
      }
    } catch(e) { console.warn('Company lookup failed:', e.message); }
  }
  if (!companyId) throw new Error(`Company "${alert.siteName}" not found in Autotask. Check company name matches exactly.`);

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
  // AT REST API returns {"itemId": 12345} on create
  const ticketId = data?.itemId || data?.item?.id || data?.id;
  if (!ticketId) {
    console.log('AT create ticket response:', JSON.stringify(data));
    throw new Error('Ticket created but no ID returned');
  }
  // Fetch the full ticket so we have ticketNumber etc.
  const ticketData = await atFetch(`/Tickets/${ticketId}`);
  const newTicket = ticketData?.item || ticketData;
  newTicket.id = newTicket.id || ticketId;
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

// ─── TICKET FIELD PATCHES ─────────────────────────────────────────
async function patchTicketField(ticket, field, rawValue) {
  // Normalize value: picklist fields need numbers, null clears assignment
  let value = rawValue;
  if (rawValue === '' || rawValue === 'null') value = null;
  else if (['status','priority','queueID','assignedResourceID'].includes(field) && value !== null) value = parseInt(value);

  const body = { id: parseInt(ticket.id) };
  body[field] = value;

  // AT requires assignedResourceRoleID alongside assignedResourceID — sending one without the other = 500 "Data violation"
  let resolvedRoleId = null;
  if (field === 'assignedResourceID') {
    if (value === null) {
      // Unassigning — clear role too
      body.assignedResourceRoleID = null;
    } else {
      // Need a role. Use the resource's default service desk role.
      await loadAtResources();
      const r = state.atResources.find(r => r.id === value);
      resolvedRoleId = r?.defaultRoleID || null;
      if (!resolvedRoleId) {
        // Fallback: try to fetch the resource directly to grab its default role
        try {
          const fresh = await atFetch(`/Resources/${value}`);
          resolvedRoleId = (fresh?.item || fresh)?.defaultServiceDeskRoleID || null;
        } catch(e) { /* ignore */ }
      }
      if (!resolvedRoleId) {
        // Last resort: pick a service-desk-eligible role so AT accepts the patch.
        await loadAtRoles();
        resolvedRoleId = findFallbackServiceDeskRoleId();
        if (resolvedRoleId) console.warn(`No default role for resource ${value}, using fallback service desk role ${resolvedRoleId}. Set their default in Autotask → Admin → Resources to silence this.`);
      }
      if (!resolvedRoleId) {
        throw new Error('Cannot assign resource — no role available. Check resource has a default service desk role in Autotask.');
      }
      body.assignedResourceRoleID = resolvedRoleId;
    }
  }

  await atFetch('/Tickets', 'PATCH', body);

  // Mirror to local state
  ticket[field] = value;
  if (field === 'status') {
    const pl = state.atStatusPicklist || {};
    const si = pl[value] || { label:`Status ${value}`, color:'#8bacc8', done:false };
    ticket.statusLabel = si.label;
    ticket.statusColor = si.color;
    ticket.isDone = si.done;
  }
  if (field === 'assignedResourceID') {
    const r = state.atResources.find(r => r.id === value);
    ticket.assignedResourceName = r ? r.name : null;
    ticket.assignedResourceRoleID = resolvedRoleId;
  }
  state.tickets[ticket.ticketNumber] = ticket;
  LS.set('msp_tickets', state.tickets);
}

function findCompleteStatusID() {
  const pl = state.atStatusPicklist || {};
  // Prefer exact "Complete" or "Completed", fall back to any done status
  const entries = Object.entries(pl);
  const preferred = entries.find(([,i]) => ['complete','completed'].includes((i.label||'').toLowerCase()));
  if (preferred) return parseInt(preferred[0]);
  const anyDone = entries.find(([,i]) => i.done);
  return anyDone ? parseInt(anyDone[0]) : null;
}

async function ensureMyResource() {
  if (state.settings.myResourceID) {
    // Verify it still exists in resources list
    await loadAtResources();
    const exists = state.atResources.find(r => r.id === parseInt(state.settings.myResourceID));
    if (exists) return parseInt(state.settings.myResourceID);
  }
  // Prompt
  await loadAtResources();
  return new Promise(resolve => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:420px">
      <div style="font-family:var(--cond);font-size:15px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px">👤 WHO ARE YOU?</div>
      <div style="font-size:12px;color:var(--textdim);margin-bottom:16px">Pick your Autotask resource. Saved for future Accept / Log Time actions.</div>
      <select id="myResSelect" style="width:100%;padding:10px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:13px">
        <option value="">— Select your resource —</option>
        ${state.atResources.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}
      </select>
      <div style="display:flex;gap:8px;margin-top:16px">
        <button id="myResSave" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">✓ SAVE</button>
        <button id="myResCancel" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    $('myResCancel').addEventListener('click', () => { document.body.removeChild(modal); resolve(null); });
    $('myResSave').addEventListener('click', () => {
      const v = $('myResSelect').value;
      if (!v) return;
      saveSettings({ myResourceID: parseInt(v) });
      document.body.removeChild(modal);
      resolve(parseInt(v));
    });
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

// ─── AI CONTEXT ENRICHMENT ────────────────────────────────────────
// Caches (TTLs vary: KB articles change slowly, ticket history moves faster)
const KB_TTL_MS = 6 * 60 * 60 * 1000;        // 6 hours
const HISTORY_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const CONTEXT_CACHE_MAX = 50;                 // cap per cache

const AI_STOP_WORDS = new Set([
  'with','that','this','from','have','been','they','their','when','will','your','which',
  'were','about','there','would','could','should','using','after','before','alert','threshold',
  'trigger','triggered','policy','windows','message','issue','problem','device','server'
]);

function extractAlertKeywords(alert) {
  const keywords = [];
  // Monitor type is usually the best single keyword ("Disk Usage", "CPU", etc.)
  if (alert.monitorType) keywords.push(alert.monitorType);
  // Extract additional keywords from alertMessage by frequency
  const text = (alert.alertMessage || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = text.split(/\s+/).filter(w => w.length >= 5 && !AI_STOP_WORDS.has(w) && !/^\d/.test(w));
  const freq = {};
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1; });
  const topWords = Object.entries(freq).sort((a,b) => b[1] - a[1]).slice(0, 3).map(e => e[0]);
  keywords.push(...topWords);
  // Dedupe, cap at 4 (AT KB search supports up to 4 parallel term queries)
  return [...new Set(keywords.map(k => k.trim()).filter(Boolean))].slice(0, 4);
}

function pruneContextCache(cache, maxSize) {
  const entries = Object.entries(cache);
  if (entries.length <= maxSize) return;
  entries.sort((a,b) => (a[1].fetchedAt || 0) - (b[1].fetchedAt || 0));
  while (entries.length > maxSize) {
    const [key] = entries.shift();
    delete cache[key];
  }
}

async function fetchAtKbArticles(keywords) {
  if (!keywords?.length) return [];
  // Parallel query per keyword, 5 results each
  const searches = keywords.slice(0, 4).map(term =>
    atFetch('/KnowledgeBaseArticles/query', 'POST', {
      MaxRecords: 5,
      filter: [{ op: 'contains', field: 'title', value: term }],
    }).catch(() => ({ items: [] }))
  );
  const results = await Promise.all(searches);
  // Dedupe by id
  const seen = new Set();
  const articles = [];
  for (const r of results) {
    for (const item of (r?.items || [])) {
      if (!seen.has(item.id)) { seen.add(item.id); articles.push(item); }
    }
  }
  // Fetch plain text content for top 3
  const top3 = articles.slice(0, 3);
  const withContent = await Promise.all(top3.map(async a => {
    try {
      const c = await atFetch(`/KnowledgeBaseArticles/${a.id}/ArticlePlainTextContent`);
      const content = (c?.items || []).map(i => i.content || '').join(' ').trim();
      return { id: a.id, title: a.title, content: content.substring(0, 800) };
    } catch {
      return { id: a.id, title: a.title, content: '' };
    }
  }));
  return withContent;
}

async function resolveCompanyIdForAlert(alert) {
  if (!alert?.siteName) return null;
  // Check local cache first
  const cached = Object.entries(atCompanyCache).find(([, name]) => name === alert.siteName);
  if (cached) return parseInt(cached[0]);
  // Query AT by exact name
  try {
    const data = await atFetch('/Companies/query', 'POST', {
      MaxRecords: 5,
      filter: [{ op: 'contains', field: 'companyName', value: alert.siteName }],
      IncludeFields: ['id', 'companyName'],
    });
    const match = (data?.items || []).find(c =>
      c.companyName?.toLowerCase() === alert.siteName?.toLowerCase()
    ) || data?.items?.[0];
    if (match) {
      atCompanyCache[match.id] = match.companyName;
      LS.set('msp_at_companies', atCompanyCache);
      return match.id;
    }
  } catch(e) { console.warn('Company lookup failed for history:', e.message); }
  return null;
}

async function fetchClientTicketHistory(alert) {
  const companyId = await resolveCompanyIdForAlert(alert);
  if (!companyId) return [];
  // Done statuses from the picklist
  await loadAtStatusPicklist();
  const pl = state.atStatusPicklist || {};
  const doneStatusIds = Object.entries(pl).filter(([,i]) => i.done).map(([v]) => parseInt(v)).filter(Boolean);
  if (!doneStatusIds.length) return [];
  // 90-day cutoff so we pull recent resolved work, not ancient
  const cutoff = new Date(Date.now() - 90*24*60*60*1000).toISOString();
  try {
    const data = await atFetch('/Tickets/query', 'POST', {
      MaxRecords: 20,
      filter: [
        { op: 'eq', field: 'companyID', value: companyId },
        { op: 'in', field: 'status', value: doneStatusIds },
        { op: 'gte', field: 'createDate', value: cutoff },
      ],
      IncludeFields: ['id','ticketNumber','title','resolution','createDate','resolvedDateTime','lastActivityDate'],
    });
    const items = data?.items || [];
    // Sort newest-first by resolvedDateTime (fall back to lastActivityDate or createDate)
    items.sort((a,b) => {
      const aT = a.resolvedDateTime || a.lastActivityDate || a.createDate || '';
      const bT = b.resolvedDateTime || b.lastActivityDate || b.createDate || '';
      return bT.localeCompare(aT);
    });
    return items.slice(0, 5).map(t => ({
      ticketNumber: t.ticketNumber,
      title: t.title,
      resolution: (t.resolution || '').substring(0, 400),
      resolvedDate: (t.resolvedDateTime || t.lastActivityDate || t.createDate || '').substring(0, 10),
    }));
  } catch(e) { console.warn('Ticket history fetch failed:', e.message); return []; }
}

function buildKbContextString(articles) {
  if (!articles?.length) return '';
  let out = '\n\n── AUTOTASK KB ARTICLES ──';
  articles.forEach((a, i) => {
    out += `\n\nAT-KB-${i+1}: ${a.title || 'Untitled'}`;
    if (a.content) out += `\nContent: ${a.content}`;
  });
  return out;
}

function buildHistoryContextString(tickets, clientName) {
  if (!tickets?.length) return '';
  let out = `\n\n── RECENT RESOLVED TICKETS FOR ${clientName || 'THIS CLIENT'} ──`;
  tickets.forEach((t, i) => {
    out += `\n\nHIST-${i+1}: ${t.ticketNumber || '?'} — ${t.title || '(no title)'}`;
    if (t.resolvedDate) out += `\nResolved: ${t.resolvedDate}`;
    if (t.resolution) out += `\nResolution: ${t.resolution}`;
  });
  return out;
}

async function getKbContextForAlert(alert) {
  if (state.settings.includeKbContext === false) return '';
  if (!alert?.alertUid) return '';
  const cached = state.kbContextCache[alert.alertUid];
  if (cached && (Date.now() - cached.fetchedAt) < KB_TTL_MS) return cached.text || '';
  try {
    const keywords = extractAlertKeywords(alert);
    const articles = await fetchAtKbArticles(keywords);
    const text = buildKbContextString(articles);
    state.kbContextCache[alert.alertUid] = { text, fetchedAt: Date.now() };
    pruneContextCache(state.kbContextCache, CONTEXT_CACHE_MAX);
    LS.set('msp_kb_context_cache', state.kbContextCache);
    return text;
  } catch(e) { console.warn('KB context build failed:', e.message); return ''; }
}

async function getHistoryContextForAlert(alert) {
  if (state.settings.includeTicketHistory === false) return '';
  if (!alert?.alertUid) return '';
  const cached = state.historyContextCache[alert.alertUid];
  if (cached && (Date.now() - cached.fetchedAt) < HISTORY_TTL_MS) return cached.text || '';
  try {
    const tickets = await fetchClientTicketHistory(alert);
    const text = buildHistoryContextString(tickets, alert.siteName);
    state.historyContextCache[alert.alertUid] = { text, fetchedAt: Date.now() };
    pruneContextCache(state.historyContextCache, CONTEXT_CACHE_MAX);
    LS.set('msp_history_context_cache', state.historyContextCache);
    return text;
  } catch(e) { console.warn('History context build failed:', e.message); return ''; }
}

// ─── TICKET INVESTIGATION (ANALYZE → CHECKLIST → DRAFT RESOLUTION) ─
const INV_STEP_NOTES_MAX = 2000;

function saveInvestigations() { LS.set('msp_investigations', state.investigations); }

function getInvestigation(ticketId) {
  const key = String(ticketId);
  return state.investigations[key] || null;
}

function setInvestigation(ticketId, inv) {
  const key = String(ticketId);
  state.investigations[key] = inv;
  saveInvestigations();
}

function newStepId() { return 's-' + Math.random().toString(36).slice(2, 10); }

async function fetchAtTicketFull(ticketId) {
  try {
    const data = await atFetch(`/Tickets/${ticketId}`);
    return data?.item || data || null;
  } catch(e) { console.warn('Ticket fetch failed:', e.message); return null; }
}

async function fetchAtTicketNotes(ticketId) {
  // Uses the standard AT REST child-collection query pattern
  try {
    const data = await atFetch(`/Tickets/${ticketId}/Notes/query`, 'POST', {
      MaxRecords: 10,
      filter: [{ op: 'gte', field: 'id', value: 0 }],
      IncludeFields: ['id','title','description','noteType','createDateTime','lastActivityDate'],
    });
    const items = data?.items || [];
    // Newest-first by createDateTime / lastActivityDate
    items.sort((a,b) => {
      const aT = a.createDateTime || a.lastActivityDate || '';
      const bT = b.createDateTime || b.lastActivityDate || '';
      return bT.localeCompare(aT);
    });
    return items.slice(0, 5).map(n => ({
      title: (n.title || '').substring(0, 120),
      description: (n.description || '').substring(0, 500),
      date: (n.createDateTime || n.lastActivityDate || '').substring(0, 10),
    }));
  } catch(e) { console.warn('AT notes fetch failed (non-fatal):', e.message); return []; }
}

function findLinkedAlertForTicket(ticket) {
  if (!ticket?.ticketNumber) return null;
  return state.alerts.find(a => a.ticketNumber === ticket.ticketNumber) || null;
}

async function buildTicketContextBlob(ticket) {
  // Pull ticket data, recent AT notes, KB + history context, and linked-alert context in parallel
  const linkedAlert = findLinkedAlertForTicket(ticket);
  const [fullTicket, atNotes, kbCtx, histCtx] = await Promise.all([
    fetchAtTicketFull(ticket.id),
    fetchAtTicketNotes(ticket.id),
    // Reuse Tier C engine — use the linked alert if present, otherwise synthesize a minimal "alert" from ticket data
    linkedAlert ? getKbContextForAlert(linkedAlert) : Promise.resolve(''),
    linkedAlert ? getHistoryContextForAlert(linkedAlert) : getHistoryContextForAlert({
      alertUid: 'ticket-' + ticket.id,
      siteName: ticket.companyName,
      monitorType: 'Ticket',
      alertMessage: ticket.title || '',
    }),
  ]);

  const pieces = [];
  pieces.push(`TICKET ${ticket.ticketNumber || ticket.id}`);
  pieces.push(`Title: ${ticket.title || '(no title)'}`);
  if (ticket.companyName)    pieces.push(`Client: ${ticket.companyName}`);
  if (ticket.statusLabel)    pieces.push(`Status: ${ticket.statusLabel}`);
  if (fullTicket?.description) pieces.push(`\nDescription:\n${fullTicket.description.substring(0, 1500)}`);

  if (linkedAlert) {
    pieces.push(`\nLINKED DATTO ALERT:`);
    pieces.push(`Device: ${linkedAlert.hostname}`);
    pieces.push(`Monitor: ${linkedAlert.monitorType}`);
    pieces.push(`Priority: ${linkedAlert.priority}`);
    pieces.push(`Alert: ${linkedAlert.alertMessage}`);
    const alertAi = state.aiResults[linkedAlert.alertUid];
    if (alertAi) pieces.push(`\nPRIOR ALERT TRIAGE:\n${alertAi.substring(0, 800)}`);
  }

  if (atNotes.length) {
    pieces.push('\n── RECENT AUTOTASK NOTES ──');
    atNotes.forEach((n, i) => {
      pieces.push(`\nNOTE-${i+1} (${n.date || 'no date'}): ${n.title || '(no title)'}`);
      if (n.description) pieces.push(n.description);
    });
  }

  return pieces.join('\n') + (kbCtx || '') + (histCtx || '');
}

function buildTicketInvestigationSystemPrompt() {
  return `You are an expert MSP tier-2/3 engineer at Synobis Network Solutions. You investigate tickets and produce a concrete, ordered action plan a technician can execute.

Use all provided context (ticket detail, AT notes, linked Datto alert, KB articles, client history) to understand the issue and produce a plan.

If the user message contains a "TECHNICIAN CONTEXT" block, treat it as high-priority input. The technician may specify their usual first steps, environment quirks, specific tools they prefer, prior knowledge about this client, or things they've already tried. Incorporate that guidance into the plan's ordering and step wording. Do not ignore it. Do not contradict it unless the ticket context clearly makes it wrong (and if so, say so in understanding).

Respond ONLY with valid JSON in this EXACT shape, no markdown fences, no preamble:

{
  "understanding": "2-3 sentences describing the issue and most likely root cause.",
  "confidence": 0-100,
  "relevantContext": ["brief bullet citing which KB article or prior ticket informed the plan, if any"],
  "plan": [
    { "num": 1, "text": "Concrete actionable step with specific commands, paths, or check criteria." },
    { "num": 2, "text": "..." }
  ]
}

Rules:
- plan MUST have 4-7 steps, ordered from verify-first → remediate → verify-after → document.
- Each step must be concrete and verifiable. Prefer exact commands, file paths, UI navigation ("Services.msc → find X → Restart"), or specific thresholds.
- Avoid steps like "investigate further" or "check logs" without saying which logs.
- relevantContext may be an empty array if nothing provided was materially relevant. Do not invent citations.
- Do not restate the ticket description. Do not include markdown.`;
}

function buildResolutionDraftSystemPrompt() {
  return `You are an MSP technician writing a resolution note for Autotask. You receive the ticket's plan and the technician's per-step notes documenting what they actually did.

Write a professional, concise resolution note suitable for posting to the client-visible ticket record.

STRICT RULES:
- Use ONLY information present in the step notes. Do NOT invent actions, findings, diagnostics, or outcomes not mentioned in the notes.
- If step notes are thin, empty, or only partially filled in, write a brief honest note acknowledging the work done and suggest reviewing the ticket timeline. Do not fabricate.
- Past tense, flowing professional prose. No bullet points, no headers, no step-by-step rehash.
- 3-5 sentences. Tight.
- MSP tone: factual, calm, confident. Not salesy.
- Return only the resolution text. No preamble, no sign-off, no quotes.`;
}

function formatStepNotesForResolution(steps) {
  const lines = [];
  steps.forEach((s, i) => {
    const num = i + 1;
    const done = s.done ? '[DONE]' : '[NOT DONE]';
    const mins = s.minutes ? ` (${s.minutes}m)` : '';
    lines.push(`Step ${num} ${done}${mins}: ${s.text || '(no step text)'}`);
    if (s.notes?.trim()) lines.push(`Notes: ${s.notes.trim()}`);
    lines.push('');
  });
  return lines.join('\n');
}

async function runTicketInvestigation(ticket, progressFn, techContext) {
  progressFn?.('Gathering ticket context...');
  const contextBlob = await buildTicketContextBlob(ticket);
  progressFn?.('Analyzing with AI...');
  const system = buildTicketInvestigationSystemPrompt();
  const techBlock = (techContext || '').trim()
    ? `\n\n── TECHNICIAN CONTEXT (the tech working this ticket provided the following — treat this as high-priority input that should shape your plan) ──\n${techContext.trim()}`
    : '';
  const userMessage = `INVESTIGATE THIS TICKET AND PRODUCE A PLAN.\n\n${contextBlob}${techBlock}`;
  const raw = await callAI(system, [{ role: 'user', content: userMessage }]);
  // Strip potential code fences
  const cleaned = (raw || '').replace(/```json|```/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch(e) {
    throw new Error('AI returned non-JSON. Raw: ' + cleaned.substring(0, 200));
  }
  if (!Array.isArray(parsed.plan) || !parsed.plan.length) throw new Error('AI response missing a plan array');
  // Build investigation state
  const steps = parsed.plan.map(p => ({
    id: newStepId(),
    text: String(p.text || '').trim(),
    done: false,
    notes: '',
    minutes: 0,
  }));
  return {
    analysis: {
      understanding: String(parsed.understanding || '').trim(),
      confidence: parseInt(parsed.confidence) || 0,
      relevantContext: Array.isArray(parsed.relevantContext) ? parsed.relevantContext.slice(0, 6) : [],
    },
    steps,
    techContext: (techContext || '').trim(),
    lastAnalyzedAt: Date.now(),
  };
}

async function draftResolutionFromSteps(ticket, investigation) {
  if (!investigation?.steps?.length) throw new Error('No investigation plan to draft from');
  const system = buildResolutionDraftSystemPrompt();
  const userMessage = `TICKET: ${ticket.ticketNumber || ticket.id} — ${ticket.title || ''}\n\nSTEP NOTES:\n${formatStepNotesForResolution(investigation.steps)}`;
  const text = await callAI(system, [{ role: 'user', content: userMessage }]);
  return (text || '').trim();
}

function buildKbDraftSystemPrompt() {
  return `You are an MSP engineer writing a Knowledge Base entry from a completed ticket investigation. The output goes into a searchable internal KB that Synobis techs will read in the future when they encounter similar issues.

You will receive: the ticket title and resolution text, optionally the original analysis and step notes. Produce a clean KB entry with Symptom / Diagnosis / Fix structure.

Respond ONLY with valid JSON in this EXACT shape, no markdown fences, no preamble:

{
  "title": "Short, searchable title that another tech would type into KB search. ~6-12 words. Lead with the symptom, not the client.",
  "symptoms": "What does this look like to a tech encountering it for the first time? 2-4 sentences describing the observable problem, error messages, or alert content. Avoid client-specific names — make it generalizable.",
  "diagnosis": "What was the actual underlying cause? 1-3 sentences. Be specific.",
  "fix": "Concrete numbered steps to remediate. Use exact commands, paths, or UI navigation. A tech should be able to follow these and resolve the issue without re-investigating.",
  "tags": ["short", "lowercase", "tags", "for", "search"]
}

Rules:
- Strip all client-specific identifiers from title/symptoms/diagnosis/fix (no hostnames, no usernames, no IPs unless they're conventionally meaningful like 127.0.0.1). Make the entry reusable across clients.
- The "fix" section should be actionable. If the tech's notes only describe the problem and not the solution, say so plainly in the fix field — don't invent steps.
- Tags should be lowercase, short, and searchable. Examples: "disk", "dhcp", "veeam", "windows-update", "service-restart". Skip tags like the client name, ticket number, or hostname.
- Do not include markdown formatting in any field.
- Title must be under 100 characters.`;
}

async function draftKbEntryFromTicket(ticket, investigation, finalResolution) {
  const system = buildKbDraftSystemPrompt();
  const stepNotes = investigation?.steps?.length ? formatStepNotesForResolution(investigation.steps) : '';
  const analysis = investigation?.analysis?.understanding || '';
  const userMessage = `TICKET: ${ticket.ticketNumber || ticket.id}
Title: ${ticket.title || '(no title)'}
${ticket.companyName ? `Client: ${ticket.companyName}\n` : ''}
${analysis ? `\nANALYSIS / UNDERSTANDING:\n${analysis}\n` : ''}
${stepNotes ? `\nSTEP NOTES:\n${stepNotes}\n` : ''}
${finalResolution ? `\nFINAL RESOLUTION POSTED:\n${finalResolution}\n` : ''}`.trim();
  const raw = await callAI(system, [{ role: 'user', content: userMessage }]);
  const cleaned = (raw || '').replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch(e) { throw new Error('AI returned non-JSON. Raw: ' + cleaned.substring(0, 200)); }
  return {
    title: String(parsed.title || '').substring(0, 100).trim(),
    symptoms: String(parsed.symptoms || '').trim(),
    diagnosis: String(parsed.diagnosis || '').trim(),
    fix: String(parsed.fix || '').trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : [],
  };
}

// ─── TICKET INVESTIGATION CHAT ────────────────────────────────────
function buildTicketChatSystemPrompt(ticket, inv, contextBlob) {
  const stepsState = (inv?.steps || []).map((s, i) => {
    const status = s.done ? 'DONE' : 'NOT DONE';
    const noteSnip = s.notes?.trim() ? ` — Notes: ${s.notes.trim().substring(0, 240)}` : '';
    const mins = s.minutes ? ` (${s.minutes}m)` : '';
    return `Step ${i+1} [${status}]${mins}: ${s.text || '(no step text)'}${noteSnip}`;
  }).join('\n');

  return `You are an expert MSP tier-2/3 engineer at Synobis Network Solutions, helping a technician work through an active ticket investigation.

You are NOT analyzing this ticket fresh — there's already an action plan and the tech has been working it. Your job is to answer follow-up questions, help when steps don't go as expected, suggest next moves, or help the tech think through what they're seeing.

Be concise and concrete. Tech is in the middle of work — they want answers, not lectures.

Rules:
- Use only the context provided. Don't invent device specifics, errors, or environmental details that weren't given.
- If the tech asks something you don't have data for, say so plainly and suggest what they could check to find out.
- Do not propose modifying the action plan structure — the tech edits steps directly. You can suggest what should go in step notes, or recommend a new step they could add.
- Do not draft the final resolution — there's a separate button for that.
- Keep replies under ~150 words unless the tech explicitly asks for detail.
- If a step is marked DONE but the tech is asking about it, treat the notes on that step as ground truth for what actually happened.

──── TICKET CONTEXT ────
${contextBlob}

──── INVESTIGATION ANALYSIS (what the AI initially concluded) ────
${inv?.analysis?.understanding || '(no analysis recorded)'}
Confidence: ${inv?.analysis?.confidence || 0}%

──── CURRENT PLAN STATE ────
${stepsState || '(no steps)'}

${inv?.techContext ? `──── TECH-PROVIDED CONTEXT (from start of investigation) ────\n${inv.techContext}\n` : ''}`;
}

async function sendTicketChat(ticketId, message) {
  const ticket = Object.values(state.tickets).find(t => String(t.id) === String(ticketId));
  if (!ticket) return;
  const inv = getInvestigation(ticket.id);
  if (!inv) return;
  const input = $('ticketChatInput'), histEl = $('ticketChatHistory');
  if (!input || !histEl) return;
  input.value = ''; input.disabled = true;
  const key = String(ticket.id);
  if (!state.ticketChatHistories[key]) state.ticketChatHistories[key] = [];
  state.ticketChatHistories[key].push({ role:'user', content: message });
  renderTicketChatHistory(ticket.id);
  const tid = 'tc-typing-' + Date.now();
  histEl.insertAdjacentHTML('beforeend', `<div id="${tid}" style="display:flex;gap:8px;align-items:center;padding:8px 0"><div style="display:flex;gap:3px"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out infinite;display:inline-block"></span><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out 0.2s infinite;display:inline-block"></span><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:pulse 1s ease-in-out 0.4s infinite;display:inline-block"></span></div><span style="font-family:var(--cond);font-size:11px;color:var(--textdim)">AI IS THINKING...</span></div>`);
  histEl.scrollTop = histEl.scrollHeight;
  try {
    // Build context once per send (cheap — caches under the hood)
    const contextBlob = await buildTicketContextBlob(ticket);
    const system = buildTicketChatSystemPrompt(ticket, inv, contextBlob);
    const msgs = state.ticketChatHistories[key].map(m => ({ role: m.role, content: m.content }));
    const reply = await callAI(system, msgs);
    state.ticketChatHistories[key].push({ role:'assistant', content: reply });
    LS.set('msp_ticket_chats', state.ticketChatHistories);
  } catch(e) {
    state.ticketChatHistories[key].push({ role:'assistant', content: `Error: ${e.message}` });
  }
  $(tid)?.remove(); input.disabled = false; input.focus();
  renderTicketChatHistory(ticket.id);
  histEl.scrollTop = histEl.scrollHeight;
}

function renderTicketChatHistory(ticketId) {
  const el = $('ticketChatHistory'); if (!el) return;
  const key = String(ticketId);
  el.innerHTML = (state.ticketChatHistories[key] || []).map(msg => {
    const isUser = msg.role === 'user';
    return `<div style="display:flex;flex-direction:column;gap:3px;align-self:${isUser?'flex-end':'flex-start'};max-width:92%">
      <div class="chat-lbl ${isUser?'you':''}">${isUser?'YOU':'★ AI ASSISTANT'}</div>
      <div class="chat-msg ${isUser?'chat-you':'chat-ai'}">${esc(msg.content)}</div>
    </div>`;
  }).join('');
}

function clearTicketChat(ticketId) {
  const key = String(ticketId);
  delete state.ticketChatHistories[key];
  LS.set('msp_ticket_chats', state.ticketChatHistories);
}

// ─── ALERT AI SYSTEM PROMPT ───────────────────────────────────────
async function buildAlertSystemPrompt(alert) {
  const ticket = alert.ticketNumber ? state.tickets[alert.ticketNumber] : null;
  let resolutionState = 'NO_TICKET';
  if (ticket) {
    if (ticket.isDone) resolutionState = 'TICKET_DONE';
    else if (['in progress','assigned','dispatched'].some(s=>ticket.statusLabel?.toLowerCase().includes(s))) resolutionState = 'IN_PROGRESS';
    else resolutionState = 'TICKET_OPEN';
  }

  // Pull KB + history context in parallel (both return '' if toggles off, empty, or failed)
  const [kbContext, historyContext] = await Promise.all([
    getKbContextForAlert(alert),
    getHistoryContextForAlert(alert),
  ]);
  const extraContext = (kbContext + historyContext).trim();
  const contextGuidance = extraContext
    ? '\n\nUse the context below to ground your analysis. Cite relevant KB article titles or past ticket numbers when they materially inform the recommendation. Do not invent context — if nothing below is relevant, say so briefly.'
    : '';

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

Be concise, practical, and specific. Include exact commands or paths when relevant.${contextGuidance}${extraContext ? '\n' + extraContext : ''}`;
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

// Status ID classifications — mirrors AT dashboard "Open Tickets" widget behavior.
// Active = actively-worked tickets. Stale = waiting/on-hold/admin tickets hidden by default.
const ACTIVE_STATUS_IDS = new Set([1, 8, 10, 11, 21, 23]);
// 1=New, 8=In Progress, 10=Dispatched, 11=Escalate, 21=Assigned, 23=Ready to Schedule

function getOpenTickets(opts = {}) {
  // Build set of excluded company IDs using PSA exclusion list
  const excludedIds = new Set();
  Object.entries(atCompanyCache).forEach(([id, name]) => {
    if (state.psaExcludedClients.has(name)) excludedIds.add(parseInt(id));
  });

  const includeStale = opts.includeStale ?? state.ticketShowStale;

  return Object.values(state.tickets).filter(t => {
    if (t.isDone) return false;
    if (t.companyName && state.psaExcludedClients.has(t.companyName)) return false;
    if (!t.companyName && t.companyID && excludedIds.has(t.companyID)) return false;
    // Unless showing stale, hide tickets whose status isn't in the active set
    if (!includeStale && t.status && !ACTIVE_STATUS_IDS.has(t.status)) return false;
    return true;
  });
}

// Separate helper for alert-linkage checks — never filters by status, always returns truth.
// Used by the dashboard/pipeline so "Waiting Customer" tickets still light up as linked to alerts.
function getTicketByNumber(ticketNumber) {
  return ticketNumber ? state.tickets[ticketNumber] : null;
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
  updateBadge('navAlertBadge',  visible.length||null);
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
    const isLocked = !!ticket && !ticket.isDone;
    const ticketBadge = ticket
      ? `<span class="badge" style="color:${ticket.statusColor};background:${ticket.statusColor}22;border:1px solid ${ticket.statusColor}44">${isLocked?'🔒 ':''}${esc(ticket.statusLabel)}${ticket.assignedResourceName ? ' · ' + esc(ticket.assignedResourceName.split(' ')[0]) : ''}</span>`
      : `<span class="badge" style="color:#5a7a96;background:rgba(90,122,150,0.1);border:1px solid rgba(90,122,150,0.3)">No Ticket</span>`;
    return `<div class="list-row ${isActive?'active':''} ${isLocked?'list-row-locked':''}" data-uid="${esc(a.alertUid)}">
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
  window._lastAlert = alert;
  const sv     = SEV[alert.priority]||SEV.Information;
  const ticket = alert.ticketNumber ? state.tickets[alert.ticketNumber] : null;
  const ai     = state.aiResults[alert.alertUid];
  const notes  = state.notesDrafts[alert.alertUid]||'';
  const zone   = state.settings.atZone||'14';
  const atBase = `https://ww${zone}.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx`;
  const created = new Date(alert.timestampMs).toLocaleString();
  const isTicketed = !!ticket;

  // ─── LOCKED-DOWN MODE: alert is being worked on the ticket side ───
  if (isTicketed) {
    const tUrl = `${atBase}?Code=OpenTicketDetail&TicketNumber=${encodeURIComponent(alert.ticketNumber)}`;
    const dattoBtn = alert.deviceUid
      ? `<button class="abtn abtn-ticket datto-open-btn" data-action="open-in-datto" data-device-uid="${esc(alert.deviceUid)}" title="Open device in Datto RMM (Web Remote, Agent Browser, etc.)">📟 Open in Datto</button>`
      : '';
    const siteAlerts = getVisibleAlerts().filter(a=>a.siteName===alert.siteName&&a.alertUid!==alert.alertUid);
    dp.innerHTML = `
      <div class="detail-card alert-locked" style="border-top:3px solid ${sv.color}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap">
          <span class="alert-title">${esc(alert.hostname)}</span>
          ${badgeHtml(alert.priority,sv.color,sv.bg)}
          <span class="badge" style="color:${ticket.statusColor};background:${ticket.statusColor}22;border:1px solid ${ticket.statusColor}44">AT: ${esc(ticket.statusLabel)}</span>
          <span class="badge alert-locked-badge">🔒 BEING WORKED ON TICKET</span>
        </div>
        <div class="alert-meta">
          <span style="color:#00b4d8;font-weight:600">${esc(alert.siteName)}</span>
          <span class="meta-sep">·</span><span>${esc(alert.monitorType)}</span>
          <span class="meta-sep">·</span><span style="color:var(--textdim);font-family:var(--mono);font-size:11px">${esc(alert.ticketNumber)}</span>
          <span class="meta-sep">·</span><span style="color:var(--textdim)">${created}</span>
        </div>
        <div class="alert-msg">${esc(alert.alertMessage)}</div>
      </div>

      <div class="detail-card jump-card">
        <div class="card-label">→ THIS ALERT IS BEING WORKED</div>
        <div class="jump-summary">
          <div class="jump-summary-row">
            <span class="jump-label">TICKET</span>
            <span class="jump-value">${esc(alert.ticketNumber)}</span>
          </div>
          <div class="jump-summary-row">
            <span class="jump-label">STATUS</span>
            <span class="jump-value" style="color:${ticket.statusColor||'var(--text)'}">${esc(ticket.statusLabel||'Unknown')}</span>
          </div>
          <div class="jump-summary-row">
            <span class="jump-label">ASSIGNED</span>
            <span class="jump-value">${esc(ticket.assignedResourceName||'Unassigned')}</span>
          </div>
          ${ticket.lastActivity ? `<div class="jump-summary-row">
            <span class="jump-label">LAST ACTIVITY</span>
            <span class="jump-value">${esc(fmtRelativeTime(ticket.lastActivity))}</span>
          </div>` : ''}
        </div>
        <div class="jump-locked-msg">
          Investigation, notes, and resolution drafting all live on the ticket. The alert will be auto-resolved when the ticket is completed.
        </div>
        <div class="action-row" style="margin-top:12px">
          <button class="abtn abtn-ai" data-action="jump-to-ticket" data-ticket-id="${ticket.id}">→ JUMP TO TICKET</button>
          <a href="${tUrl}" target="_blank" class="abtn abtn-ticket">🎫 Open in Autotask</a>
          ${dattoBtn}
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
    document.querySelectorAll('#alertList .list-row').forEach(r => r.classList.toggle('active', r.dataset.uid===alert.alertUid));
    return;
  }

  // ─── FULL-FUNCTIONAL MODE: no linked ticket, alert is fully workable ───
  // Map Datto priority to Autotask priority ID
  const priorityMap = { Critical: 4, High: 1, Moderate: 2, Low: 2, Information: 2 };
  const atPriority = priorityMap[alert.priority] || 2;
  const ticketTitle = `${alert.hostname} - ${alert.priority}: ${alert.alertMessage.substring(0, 60)}`;
  const ticketBtn = `<button class="abtn abtn-create" data-action="create-ticket" data-uid="${esc(alert.alertUid)}">＋ CREATE TICKET</button>`;
  const dattoBtn = alert.deviceUid
    ? `<button class="abtn abtn-ticket datto-open-btn" data-action="open-in-datto" data-device-uid="${esc(alert.deviceUid)}" title="Open device in Datto RMM (Web Remote, Agent Browser, etc.)">📟 OPEN IN DATTO</button>`
    : '';
  const siteAlerts = getVisibleAlerts().filter(a=>a.siteName===alert.siteName&&a.alertUid!==alert.alertUid);

  dp.innerHTML = `
    <div class="detail-card" style="border-top:3px solid ${sv.color}">
      ${renderResolutionFlow(alert)}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap">
        <span class="alert-title">${esc(alert.hostname)}</span>
        ${badgeHtml(alert.priority,sv.color,sv.bg)}
      </div>
      <div class="alert-meta">
        <span style="color:#00b4d8;font-weight:600">${esc(alert.siteName)}</span>
        <span class="meta-sep">·</span><span>${esc(alert.monitorType)}</span>
        <span class="meta-sep">·</span><span style="color:var(--textdim)">${created}</span>
      </div>
      <div class="alert-msg">${esc(alert.alertMessage)}</div>
      <div class="action-row">
        <button class="abtn abtn-resolve" data-action="resolve" data-uid="${esc(alert.alertUid)}">✓ RESOLVE</button>
        <button class="abtn abtn-snooze"  data-action="snooze"  data-uid="${esc(alert.alertUid)}">⏸ SNOOZE</button>
        ${ticketBtn}${dattoBtn}
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
    const system = await buildAlertSystemPrompt(alert);
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
  // All tickets, active + stale, for toolbar counts
  const allOpen = getOpenTickets({ includeStale: true });
  const activeCount = allOpen.filter(t => t.status && ACTIVE_STATUS_IDS.has(t.status)).length;
  const staleCount  = allOpen.length - activeCount;

  const toolbarHtml = `<div class="ticket-status-toolbar">
    <label class="ticket-stale-toggle">
      <input type="checkbox" id="ticketShowStale" ${state.ticketShowStale?'checked':''} />
      <span>Show waiting/hold tickets</span>
      <span class="ticket-stale-count">${staleCount}</span>
    </label>
    <div class="ticket-active-summary">${activeCount} active</div>
  </div>`;

  const tickets = getOpenTickets();
  if (!tickets.length) {
    el.innerHTML = toolbarHtml + '<div class="loading-state">No active tickets — click Refresh, or enable "Show waiting/hold" above.</div>';
    return;
  }
  const UNASSIGNED='__unassigned__';
  const groups={};
  tickets.forEach(t => {
    const key = t.assignedResourceName || UNASSIGNED;
    if(!groups[key]) groups[key]={name:key===UNASSIGNED?'Unassigned':key,tickets:[],isUnassigned:key===UNASSIGNED};
    groups[key].tickets.push(t);
  });
  const sorted = Object.values(groups).sort((a,b)=>{ if(a.isUnassigned) return -1; if(b.isUnassigned) return 1; return a.name.localeCompare(b.name); });
  sorted.forEach(g => g.tickets.sort((a,b)=>(a.statusLabel||'').localeCompare(b.statusLabel||'')));
  el.innerHTML = toolbarHtml + sorted.map(group => {
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

// ─── TIER B: DEVICE / ACTIVITY / METADATA RENDERERS ─────────────
function fmtBytes(mb) {
  if (mb == null || isNaN(mb)) return '';
  if (mb > 1024*1024) return (mb/1024/1024).toFixed(1) + ' TB';
  if (mb > 1024)      return (mb/1024).toFixed(1) + ' GB';
  return Math.round(mb) + ' MB';
}

function fmtRelativeTime(ts) {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (isNaN(d)) return 'unknown';
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff/60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs/24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

function fmtSlaClock(dueDateStr) {
  if (!dueDateStr) return { text: '—', color: 'var(--textdim)' };
  const d = new Date(dueDateStr);
  if (isNaN(d)) return { text: '—', color: 'var(--textdim)' };
  const diff = d.getTime() - Date.now();
  const absH = Math.floor(Math.abs(diff) / 3600000);
  const absD = Math.floor(absH / 24);
  if (diff < 0) {
    const t = absD >= 1 ? `Overdue ${absD}d` : `Overdue ${absH}h`;
    return { text: t, color: '#c8102e' };
  }
  if (absH < 4) return { text: `Due in ${absH}h`, color: '#e07b00' };
  if (absD < 1) return { text: `Due in ${absH}h`, color: '#c8a000' };
  return { text: `Due in ${absD}d`, color: 'var(--textmid)' };
}

function getDattoUiBaseUrl() {
  // Convert the API URL (e.g. https://concord-api.centrastage.net) to the actual UI URL (e.g. https://concord.rmm.datto.com)
  // Datto migrated from centrastage.net → rmm.datto.com
  const apiUrl = (state.settings.platformUrl || 'https://concord-api.centrastage.net').replace(/\/$/, '');
  // Extract region from the API hostname (e.g. "concord" from "concord-api.centrastage.net")
  const m = apiUrl.match(/https?:\/\/([a-z0-9-]+?)(-api)?\.(centrastage\.net|rmm\.datto\.com)/i);
  const region = m ? m[1] : 'concord';
  return `https://${region}.rmm.datto.com`;
}

function buildDattoDeviceUrl(device) {
  if (!device) return null;
  const base = getDattoUiBaseUrl();
  // Datto's actual device URL format: /device/<numericId>/<hostname-slug>
  // The hostname slug is optional for routing but Datto's web app includes it.
  if (device.id) {
    const slug = (device.hostname || device.description || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    return slug ? `${base}/device/${device.id}/${slug}` : `${base}/device/${device.id}`;
  }
  return null;
}

// For places where we only have the deviceUid (e.g. alert detail) without a numeric id.
// Returns null — caller should lazy-fetch the device on click to get the numeric ID.
function buildDattoDeviceUrlFromUid(deviceUid) {
  // Datto's device URLs require the numeric ID, not the UID — UID-based URLs land on the home page.
  // Caller must use lazy-fetch via openDattoDeviceForAlert() instead.
  return null;
}

// Lazy-fetch device by UID, then open the proper URL in a new tab.
// Used by alert-side buttons where we only have deviceUid at render time.
async function openDattoDeviceForAlert(deviceUid, btnEl) {
  if (!deviceUid) return;
  const origLabel = btnEl?.textContent;
  if (btnEl) { btnEl.textContent = 'Loading...'; btnEl.style.pointerEvents = 'none'; }
  try {
    const data = await fetchDattoDevice(deviceUid);
    const device = data?.device;
    const url = buildDattoDeviceUrl(device);
    if (url) {
      window.open(url, '_blank', 'noopener');
    } else {
      showToast('Could not resolve device URL — try refreshing alerts', 'err');
    }
  } catch(e) {
    showToast(`Datto fetch failed: ${e.message}`, 'err');
  } finally {
    if (btnEl) { btnEl.textContent = origLabel; btnEl.style.pointerEvents = ''; }
  }
}

function renderDevicePanel(ticket) {
  // Try to find a linked Datto device via the linked alert
  const linkedAlert = findLinkedAlertForTicket(ticket);
  const deviceUid = linkedAlert?.deviceUid;
  if (!deviceUid) {
    return ''; // No device linkage — skip this card entirely
  }
  // Alert status pill — quick at-a-glance "is the underlying alert still firing?"
  const alertStillOpen = !!state.alerts.find(a => a.alertUid === linkedAlert.alertUid);
  const alertPill = alertStillOpen
    ? `<span class="alert-status-pill alert-status-open" title="The Datto alert that opened this ticket is still firing">🔴 ALERT OPEN</span>`
    : `<span class="alert-status-pill alert-status-resolved" title="The Datto alert has been resolved">🟢 ALERT RESOLVED</span>`;
  // Card shell — will be hydrated async (Open in Datto button slot is filled by hydrate once device.id is known)
  return `<div class="detail-card" id="devicePanelCard" data-device-uid="${esc(deviceUid)}">
    <div class="card-label" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <span style="display:flex;align-items:center;gap:8px">📟 DATTO DEVICE ${alertPill}</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span id="devicePanelOpenSlot"></span>
        <button class="inv-step-btn" data-action="device-refresh" data-device-uid="${esc(deviceUid)}" title="Refresh device info" style="width:auto;padding:0 8px;height:22px;font-size:11px">↺</button>
      </span>
    </div>
    <div id="devicePanelBody">
      <div style="color:var(--textdim);font-size:12px;padding:10px 0">Loading device info...</div>
    </div>
  </div>`;
}

function hydrateDevicePanel(deviceData) {
  const body = document.getElementById('devicePanelBody');
  const openSlot = document.getElementById('devicePanelOpenSlot');
  if (!body) return;
  if (!deviceData) {
    body.innerHTML = `<div style="color:var(--textdim);font-size:12px;padding:6px 0">Device info unavailable. Check Datto RMM connection.</div>`;
    return;
  }
  const d = deviceData.device || {};
  // Populate the "Open in Datto" link in the header — opens device summary, where Web Remote / Agent Browser / Open in PSA all live
  if (openSlot) {
    const dattoUrl = buildDattoDeviceUrl(d);
    if (dattoUrl) {
      openSlot.innerHTML = `<a href="${esc(dattoUrl)}" target="_blank" rel="noopener" class="inv-step-btn datto-open-btn" title="Open device in Datto RMM (Web Remote, Agent Browser, etc.)" style="width:auto;padding:0 10px;height:22px;font-size:11px;text-decoration:none;display:inline-flex;align-items:center;gap:4px">📟 OPEN IN DATTO</a>`;
    }
  }
  const openAlerts = deviceData.openAlertCount || 0;
  const online = d.online === true || d.online === 'true';
  const onlineColor = online ? '#2a9d5c' : '#c8102e';
  const onlineLabel = online ? 'ONLINE' : 'OFFLINE';
  const lastSeen = d.lastSeen || d.lastSeenDate || null;
  const os = d.operatingSystem || d.osType || 'Unknown OS';
  const desc = d.description || d.hostname || '';
  const user = d.lastLoggedInUser || null;
  const domain = d.domain || null;
  // Storage — Datto typically returns an array with volumes
  let storageRow = '';
  const vols = d.volumes || d.storage || [];
  if (Array.isArray(vols) && vols.length) {
    storageRow = vols.slice(0, 3).map(v => {
      const name = v.name || v.volume || v.drive || 'Drive';
      const total = v.totalSize || v.capacity || v.total;
      const free = v.freeSpace || v.free;
      if (total && free != null) {
        const pct = Math.round((1 - free/total) * 100);
        const warn = pct >= 90 ? '#c8102e' : pct >= 80 ? '#e07b00' : '#2a9d5c';
        return `<div class="device-storage-row">
          <div class="device-storage-label"><span>${esc(name)}</span><span style="color:${warn};font-weight:700">${pct}%</span></div>
          <div class="device-storage-bar"><div class="device-storage-fill" style="width:${pct}%;background:${warn}"></div></div>
          <div class="device-storage-sub">${fmtBytes(free)} free of ${fmtBytes(total)}</div>
        </div>`;
      }
      return '';
    }).join('');
  }
  // AV/Patch/Software — defensive
  const av = d.antivirus || d.antivirusStatus;
  const patch = d.patchStatus || d.patch;
  const health = [];
  if (av)    health.push(`<span class="device-health-pill ${av.productName || av.status ? 'ok' : ''}">AV: ${esc(av.productName || av.status || 'Unknown')}</span>`);
  if (patch) health.push(`<span class="device-health-pill">Patch: ${esc(typeof patch === 'string' ? patch : patch.status || 'Unknown')}</span>`);

  body.innerHTML = `
    <div class="device-header">
      <div>
        <div class="device-name">${esc(d.hostname || desc || 'Unknown device')}</div>
        ${domain ? `<div class="device-meta">${esc(domain)}</div>` : ''}
      </div>
      <span class="device-status-badge" style="color:${onlineColor};background:${onlineColor}22;border:1px solid ${onlineColor}55">${onlineLabel}</span>
    </div>
    <div class="device-grid">
      <div class="device-grid-cell"><div class="device-grid-label">OS</div><div class="device-grid-value">${esc(os)}</div></div>
      <div class="device-grid-cell"><div class="device-grid-label">LAST SEEN</div><div class="device-grid-value">${esc(fmtRelativeTime(lastSeen))}</div></div>
      ${user ? `<div class="device-grid-cell"><div class="device-grid-label">LAST USER</div><div class="device-grid-value">${esc(user)}</div></div>` : ''}
      <div class="device-grid-cell"><div class="device-grid-label">OPEN ALERTS</div><div class="device-grid-value" style="color:${openAlerts>0?'#e07b00':'var(--text)'};font-weight:${openAlerts>0?'700':'400'}">${openAlerts}</div></div>
    </div>
    ${storageRow ? `<div class="device-section"><div class="device-section-label">STORAGE</div>${storageRow}</div>` : ''}
    ${health.length ? `<div class="device-section"><div class="device-health-row">${health.join('')}</div></div>` : ''}
  `;
}

function renderActivityFeed(ticket) {
  return `<div class="detail-card" id="activityFeedCard">
    <div class="card-label" style="display:flex;align-items:center;justify-content:space-between">
      <span>⌚ ACTIVITY</span>
      <button class="inv-step-btn" data-action="activity-refresh" data-ticket-id="${ticket.id}" title="Refresh activity" style="width:auto;padding:0 8px;height:22px;font-size:11px">↺</button>
    </div>
    <div id="activityFeedBody">
      <div style="color:var(--textdim);font-size:12px;padding:10px 0">Loading recent notes...</div>
    </div>
  </div>`;
}

function hydrateActivityFeed(notes) {
  const body = document.getElementById('activityFeedBody');
  if (!body) return;
  if (!notes?.length) {
    body.innerHTML = `<div style="color:var(--textdim);font-size:12px;padding:6px 0">No notes on this ticket yet.</div>`;
    return;
  }
  const resourceMap = {};
  state.atResources.forEach(r => { resourceMap[r.id] = r.name; });
  const rows = notes.map(n => {
    const creator = resourceMap[n.creatorResourceID] || 'System';
    const date = n.createDateTime || n.lastActivityDate || '';
    const dateStr = date ? new Date(date).toLocaleString() : '';
    const isInternal = n.publish === 2 || n.noteType === 2;
    const typeBadge = isInternal
      ? `<span class="activity-type activity-type-internal">INTERNAL</span>`
      : `<span class="activity-type activity-type-public">PUBLIC</span>`;
    const desc = (n.description || '').trim();
    const preview = desc.length > 280 ? desc.substring(0, 280) + '…' : desc;
    return `<div class="activity-row">
      <div class="activity-head">
        <span class="activity-author">${esc(creator)}</span>
        <span class="activity-date">${esc(dateStr)}</span>
        ${typeBadge}
      </div>
      ${n.title ? `<div class="activity-title">${esc(n.title)}</div>` : ''}
      ${preview ? `<div class="activity-desc">${esc(preview)}</div>` : ''}
    </div>`;
  }).join('');
  body.innerHTML = rows;
}

function renderMetadataPanel(ticket) {
  return `<div class="detail-card" id="metadataPanelCard">
    <div class="card-label">ℹ️ TICKET METADATA</div>
    <div id="metadataPanelBody">
      <div style="color:var(--textdim);font-size:12px;padding:10px 0">Loading metadata...</div>
    </div>
  </div>`;
}

function hydrateMetadataPanel(ticket, fullTicket, picklists, contractName) {
  const body = document.getElementById('metadataPanelBody');
  if (!body) return;
  const f = fullTicket || {};
  const pl = picklists || { issueType:{}, subIssueType:{}, source:{} };
  const lookup = (map, val) => (map[val]?.label || (val ? `#${val}` : '—'));
  const issueLabel     = lookup(pl.issueType,    f.issueType);
  const subIssueLabel  = lookup(pl.subIssueType, f.subIssueType);
  const sourceLabel    = lookup(pl.source,       f.source);
  const due = f.dueDateTime || f.dueDate;
  const sla = fmtSlaClock(due);
  const workType = f.billingCodeID
    ? (state.atBillingCodes.find(b => b.id === f.billingCodeID)?.name || `#${f.billingCodeID}`)
    : '—';

  body.innerHTML = `
    <div class="meta-grid">
      <div class="meta-cell"><div class="meta-label">ISSUE TYPE</div><div class="meta-value">${esc(issueLabel)}</div></div>
      <div class="meta-cell"><div class="meta-label">SUB-ISSUE</div><div class="meta-value">${esc(subIssueLabel)}</div></div>
      <div class="meta-cell"><div class="meta-label">SOURCE</div><div class="meta-value">${esc(sourceLabel)}</div></div>
      <div class="meta-cell"><div class="meta-label">WORK TYPE</div><div class="meta-value">${esc(workType)}</div></div>
      <div class="meta-cell"><div class="meta-label">DUE DATE</div><div class="meta-value">${due ? esc(new Date(due).toLocaleDateString()) : '—'}</div></div>
      <div class="meta-cell"><div class="meta-label">SLA</div><div class="meta-value" style="color:${sla.color};font-weight:600">${esc(sla.text)}</div></div>
      <div class="meta-cell"><div class="meta-label">EST. HOURS</div><div class="meta-value">${f.estimatedHours != null ? esc(String(f.estimatedHours)) : '—'}</div></div>
      <div class="meta-cell"><div class="meta-label">CONTRACT</div><div class="meta-value">${contractName ? esc(contractName) : '—'}</div></div>
    </div>
  `;
}

async function hydrateTierBPanels(ticket) {
  // Runs async, populates all three panels as data arrives. Guarded by currentTicket check.
  const linkedAlert = findLinkedAlertForTicket(ticket);
  const deviceUid = linkedAlert?.deviceUid;

  // Device panel
  if (deviceUid) {
    fetchDattoDevice(deviceUid).then(data => {
      if (state.currentTicket?.id === ticket.id) hydrateDevicePanel(data);
    });
  }

  // Activity feed
  Promise.all([
    fetchAtTicketActivityNotes(ticket.id),
    loadAtResources(),
  ]).then(([notes]) => {
    if (state.currentTicket?.id === ticket.id) hydrateActivityFeed(notes);
  });

  // Metadata panel — full ticket + picklists + contract name + billing codes
  Promise.all([
    fetchAtTicketFull(ticket.id),
    loadAtTicketPicklists(),
    loadAtBillingCodes(),
  ]).then(async ([fullTicket, picklists]) => {
    const contractName = fullTicket?.contractID ? await fetchAtContractName(fullTicket.contractID) : null;
    if (state.currentTicket?.id === ticket.id) hydrateMetadataPanel(ticket, fullTicket, picklists, contractName);
  });
}

function renderInvestigationCard(ticket) {
  const inv = getInvestigation(ticket.id);
  const hasInv = !!(inv && inv.steps?.length);
  const headerHtml = `<div class="card-label" style="display:flex;align-items:center;justify-content:space-between">
    <span>★ AI INVESTIGATION</span>
    ${hasInv ? `<span style="font-size:11px;color:var(--textdim);font-weight:400;letter-spacing:0.03em;text-transform:none">Last analyzed ${new Date(inv.lastAnalyzedAt).toLocaleString()}</span>` : ''}
  </div>`;

  if (!hasInv) {
    const draft = state.notesDrafts['tech-ctx-' + ticket.id] || '';
    return `<div class="detail-card" id="investigationCard">
      ${headerHtml}
      <div style="color:var(--textdim);font-size:12px;margin:8px 0 12px">Pulls ticket detail, Autotask notes, KB articles, client history, and any linked Datto alert. Produces an editable action plan.</div>
      <div class="field-group" style="margin-bottom:10px">
        <label style="display:block;font-family:var(--cond);font-size:11px;font-weight:700;letter-spacing:0.09em;color:var(--textdim);margin-bottom:4px">TECH CONTEXT <span style="font-weight:400;text-transform:none;letter-spacing:0.02em">(optional — your usual first steps, environment quirks, prior knowledge)</span></label>
        <textarea id="techContextInput" data-ticket-id="${ticket.id}" rows="3" placeholder="e.g. My first step is normally to check if the computer is on. Client runs SQL cluster with AG — don't restart primary without failover. Try cached credentials before AD lookup.">${esc(draft)}</textarea>
      </div>
      <button class="abtn abtn-ai" data-action="ticket-analyze" data-ticket-id="${ticket.id}">▶ ANALYZE TICKET</button>
      <div id="investigationStatus" style="font-family:var(--cond);font-size:12px;color:var(--textdim);margin-top:8px;min-height:14px"></div>
    </div>`;
  }

  const { analysis, steps } = inv;
  const conf = analysis.confidence || 0;
  const confColor = conf >= 75 ? '#2a9d5c' : conf >= 50 ? '#c8a000' : '#e07b00';
  const ctxBadges = (analysis.relevantContext || []).map(c =>
    `<div class="inv-ctx-badge">${esc(c)}</div>`
  ).join('');
  const techCtxBlock = inv.techContext ? `<div class="inv-tech-ctx">
    <div class="inv-tech-ctx-label">TECH CONTEXT USED</div>
    <div class="inv-tech-ctx-body">${esc(inv.techContext)}</div>
  </div>` : '';

  const stepsHtml = steps.map((s, idx) => `
    <div class="inv-step ${s.done?'inv-step-done':''}" data-step-id="${esc(s.id)}" data-ticket-id="${ticket.id}">
      <div class="inv-step-header">
        <input type="checkbox" class="inv-step-done-cb" data-action="inv-step-toggle" ${s.done?'checked':''} />
        <span class="inv-step-num">${idx+1}</span>
        <input type="text" class="inv-step-text" data-action="inv-step-text" value="${esc(s.text)}" placeholder="Step description..." />
        <button class="inv-step-btn" data-action="inv-step-up"  title="Move up"   ${idx===0?'disabled':''}>↑</button>
        <button class="inv-step-btn" data-action="inv-step-down" title="Move down" ${idx===steps.length-1?'disabled':''}>↓</button>
        <input type="number" class="inv-step-mins" data-action="inv-step-mins" value="${s.minutes||''}" placeholder="min" min="0" />
        <button class="inv-step-btn inv-step-delete" data-action="inv-step-delete" title="Delete step">×</button>
      </div>
      <textarea class="inv-step-notes" data-action="inv-step-notes" placeholder="What did you do / find?" maxlength="${INV_STEP_NOTES_MAX}">${esc(s.notes||'')}</textarea>
    </div>
  `).join('');

  return `<div class="detail-card" id="investigationCard">
    ${headerHtml}
    <div class="inv-analysis">
      <div class="inv-analysis-row">
        <span class="inv-conf-badge" style="color:${confColor};background:${confColor}22;border:1px solid ${confColor}55">CONFIDENCE ${conf}%</span>
      </div>
      <div class="inv-understanding">${esc(analysis.understanding || '(no summary)')}</div>
      ${ctxBadges ? `<div class="inv-ctx-wrap">${ctxBadges}</div>` : ''}
      ${techCtxBlock}
    </div>
    <div class="inv-steps-wrap">
      ${stepsHtml}
    </div>
    <div class="inv-step-add-row">
      <button class="abtn abtn-kb" data-action="inv-step-add" data-ticket-id="${ticket.id}" style="font-size:11px;padding:6px 10px">+ ADD STEP</button>
    </div>
    <div class="inv-actions-row">
      <button class="abtn abtn-ghost" data-action="ticket-reanalyze" data-ticket-id="${ticket.id}">↺ Re-analyze</button>
      <button class="abtn abtn-ai" data-action="ticket-draft-resolution" data-ticket-id="${ticket.id}">✓ DRAFT RESOLUTION</button>
    </div>
    <div id="investigationStatus" style="font-family:var(--cond);font-size:12px;color:var(--textdim);margin-top:8px;min-height:14px"></div>

    <div class="inv-chat-section">
      <div class="inv-chat-label">💬 ASK THE AI ABOUT THIS INVESTIGATION</div>
      <div class="chat-history" id="ticketChatHistory" data-ticket-id="${ticket.id}"></div>
      <div class="chat-input-row">
        <textarea class="chat-textarea" id="ticketChatInput" rows="2" data-ticket-id="${ticket.id}" placeholder="e.g. Step 2 didn't work, the service won't restart — what should I check next?"></textarea>
        <button class="chat-send" data-action="send-ticket-chat" data-ticket-id="${ticket.id}">SEND ➤</button>
      </div>
      <div class="chat-hint">Enter to send · Shift+Enter for new line · The AI sees your plan, your notes, and the ticket context</div>
    </div>
  </div>`;
}

function renderTicketDetail(ticket) {
  const dp=$('ticketDetail'); if(!dp) return;
  const zone=state.settings.atZone||'14';
  const atBase=`https://ww${zone}.autotask.net/Autotask/AutotaskExtend/ExecuteCommand.aspx`;
  const tUrl=`${atBase}?Code=OpenTicketDetail&TicketNumber=${encodeURIComponent(ticket.ticketNumber)}`;

  // Kick off picklist loads in parallel — rebuild when each resolves
  loadAtStatusPicklist().then(() => renderTicketDetail._rehydrateSelects?.(ticket));
  loadAtPriorityPicklist().then(() => renderTicketDetail._rehydrateSelects?.(ticket));
  loadAtQueues().then(() => renderTicketDetail._rehydrateSelects?.(ticket));
  loadAtResources().then(() => renderTicketDetail._rehydrateSelects?.(ticket));

  const myRid = parseInt(state.settings.myResourceID) || null;
  const isMine = myRid && ticket.assignedResourceID === myRid;
  const isComplete = ticket.isDone;

  dp.innerHTML=`
    <div class="detail-card" style="border-top:3px solid ${ticket.statusColor||'#8bacc8'}">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;flex-wrap:wrap">
        <span class="alert-title" style="font-size:18px">${esc(ticket.ticketNumber)}</span>
        <span class="badge" style="color:${ticket.statusColor||'#8bacc8'};background:${ticket.statusColor||'#8bacc8'}22;border:1px solid ${ticket.statusColor||'#8bacc8'}44">${esc(ticket.statusLabel||'Unknown')}</span>
      </div>
      <div class="alert-msg" style="margin:10px 0">${esc(ticket.title||'No title')}</div>
      ${ticket.companyName ? `<div style="font-size:13px;color:var(--accent);margin-bottom:10px">${esc(ticket.companyName)}</div>` : ''}
      ${ticket.assignedResourceName ? `<div style="font-size:12px;color:var(--textdim);margin-bottom:10px">Assigned: ${esc(ticket.assignedResourceName)}${isMine?' (you)':''}</div>` : `<div style="font-size:12px;color:var(--textdim);margin-bottom:10px">Unassigned</div>`}
      <div class="action-row">
        <a href="${tUrl}" target="_blank" class="abtn abtn-ticket">🎫 Open in Autotask</a>
        ${!isMine && !isComplete ? `<button class="abtn abtn-accept" data-action="ticket-accept" data-ticket-id="${ticket.id}">✋ Accept</button>` : ''}
        ${!isComplete ? `<button class="abtn abtn-complete" data-action="ticket-complete" data-ticket-id="${ticket.id}">✓ Complete</button>` : ''}
        <button class="abtn abtn-time" data-action="log-time-ticket" data-ticket-id="${ticket.id}">⏱ Log Time</button>
      </div>
    </div>

    ${renderDevicePanel(ticket)}

    <div class="detail-card">
      <div class="card-label">⚙️ TICKET FIELDS</div>
      <div class="ticket-fields-grid">
        <div class="field-group">
          <label>STATUS</label>
          <select class="ticket-field-select" data-field="status" data-ticket-id="${ticket.id}" id="tf-status"></select>
        </div>
        <div class="field-group">
          <label>PRIORITY</label>
          <select class="ticket-field-select" data-field="priority" data-ticket-id="${ticket.id}" id="tf-priority"></select>
        </div>
        <div class="field-group">
          <label>QUEUE</label>
          <select class="ticket-field-select" data-field="queueID" data-ticket-id="${ticket.id}" id="tf-queue"></select>
        </div>
        <div class="field-group">
          <label>PRIMARY RESOURCE</label>
          <select class="ticket-field-select" data-field="assignedResourceID" data-ticket-id="${ticket.id}" id="tf-resource"></select>
        </div>
      </div>
    </div>

    ${renderMetadataPanel(ticket)}

    ${renderActivityFeed(ticket)}

    ${renderInvestigationCard(ticket)}

    <div class="detail-card">
      <div class="card-label">✅ RESOLUTION</div>
      <textarea id="ticketNotesInput" rows="4" placeholder="Final resolution — what fixed the issue? (Posts to the ticket's Resolution field and adds a note.)">${esc(state.notesDrafts['ticket-'+ticket.id]||'')}</textarea>
      <div class="notes-footer">
        <span></span>
        <div style="display:flex;gap:6px">
          <button class="abtn abtn-kb" data-action="save-ticket-to-kb" data-ticket-id="${ticket.id}" style="font-size:11px;padding:6px 12px" title="AI-format this resolution and save to Knowledge Base">💾 Save to KB</button>
          <button class="abtn abtn-post" data-action="post-ticket-resolution" data-ticket-id="${ticket.id}" style="font-size:11px;padding:6px 12px">↑ POST RESOLUTION</button>
        </div>
      </div>
    </div>`;

  // Populate selects — called now and re-called as picklists resolve
  renderTicketDetail._rehydrateSelects = (t) => {
    if (state.currentTicket?.id !== t.id) return; // user moved on
    const statusSel = document.getElementById('tf-status');
    const prioSel   = document.getElementById('tf-priority');
    const queueSel  = document.getElementById('tf-queue');
    const resSel    = document.getElementById('tf-resource');

    if (statusSel && state.atStatusPicklist) {
      const entries = Object.entries(state.atStatusPicklist).sort((a,b)=>a[1].label.localeCompare(b[1].label));
      statusSel.innerHTML = entries.map(([v,i]) =>
        `<option value="${v}" ${String(t.status)===v?'selected':''}>${esc(i.label)}</option>`
      ).join('');
    }
    if (prioSel && state.atPriorityPicklist) {
      const entries = Object.entries(state.atPriorityPicklist);
      prioSel.innerHTML = entries.map(([v,i]) =>
        `<option value="${v}" ${String(t.priority)===v?'selected':''}>${esc(i.label)}</option>`
      ).join('');
    }
    if (queueSel && state.atQueues?.length) {
      queueSel.innerHTML = `<option value="">— None —</option>` +
        state.atQueues.map(q =>
          `<option value="${q.id}" ${String(t.queueID)===String(q.id)?'selected':''}>${esc(q.name)}</option>`
        ).join('');
    }
    if (resSel && state.atResources?.length) {
      const sorted = [...state.atResources].sort((a,b)=>a.name.localeCompare(b.name));
      resSel.innerHTML = `<option value="">— Unassigned —</option>` +
        sorted.map(r =>
          `<option value="${r.id}" ${String(t.assignedResourceID)===String(r.id)?'selected':''}>${esc(r.name)}</option>`
        ).join('');
    }
  };
  renderTicketDetail._rehydrateSelects(ticket);
  hydrateTierBPanels(ticket);
  // Hydrate ticket investigation chat history if there's an analyzed plan and prior chat
  if (state.ticketChatHistories[String(ticket.id)]?.length) {
    renderTicketChatHistory(ticket.id);
    const h = $('ticketChatHistory'); if (h) h.scrollTop = h.scrollHeight;
  }
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

    // Match alerts to tickets created by Companion (where Datto doesn't know the ticket number yet)
    // Look for tickets whose title contains the alert's hostname
    alerts.forEach(a => {
      if (a.ticketNumber) return; // Already linked
      const matched = Object.values(state.tickets).find(t =>
        !t.isDone && t.title && t.title.includes(a.hostname) &&
        t.companyName === a.siteName
      );
      if (matched) a.ticketNumber = matched.ticketNumber;
    });
    LS.set('msp_alerts', alerts);

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
  if (state.currentAlert) renderAlertDetail(state.currentAlert);
}

function startAutoRefresh() {
  if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
  if (state.settings.autoRefresh===false) return;
  const mins = parseInt(state.settings.refreshInterval)||5;
  state.autoRefreshTimer = setInterval(()=>refreshAll(), mins*60000);
}

// ─── CLIENT HEALTH DASHBOARD ──────────────────────────────────────
const CLIENT_RESOLVED_CACHE_TTL = 5 * 60 * 1000;
const CLIENT_DEVICES_CACHE_TTL = 30 * 60 * 1000;

async function fetchAllAtCompanies() {
  // Pulls every active company so quiet clients show up in the list
  try {
    const data = await atFetch('/Companies/query', 'POST', {
      MaxRecords: 500,
      filter: [{ op: 'eq', field: 'isActive', value: true }],
      IncludeFields: ['id', 'companyName', 'companyType', 'phone', 'city', 'state'],
    });
    return (data?.items || []).map(c => ({
      atId: c.id,
      name: c.companyName,
      city: c.city,
      stateAbbr: c.state,
      phone: c.phone,
      companyType: c.companyType,
    }));
  } catch(e) { console.warn('Companies fetch failed:', e.message); return []; }
}

async function fetchAllDattoSites() {
  // Datto's /account/sites returns every site
  try {
    const data = await dattoFetch('/account/sites');
    return (data?.sites || data?.items || []).map(s => ({
      siteUid: s.uid || s.id,
      name: s.name,
      numberOfOpenAlerts: s.numberOfOpenAlerts,
      numberOfOpenCriticalAlerts: s.numberOfOpenCriticalAlerts,
      numberOfDevices: s.numberOfDevices,
      numberOfOnlineDevices: s.numberOfOnlineDevices,
      numberOfOfflineDevices: s.numberOfOfflineDevices,
    }));
  } catch(e) { console.warn('Datto sites fetch failed:', e.message); return []; }
}

function buildUnifiedClientList(atCompanies, dattoSites) {
  // Match Datto sites to AT companies by name (case-insensitive). Unmatched ones still appear.
  const byName = {};
  atCompanies.forEach(c => {
    const key = (c.name || '').toLowerCase().trim();
    if (!key) return;
    byName[key] = { name: c.name, atId: c.atId, city: c.city, stateAbbr: c.stateAbbr, phone: c.phone };
  });
  dattoSites.forEach(s => {
    const key = (s.name || '').toLowerCase().trim();
    if (!key) return;
    if (byName[key]) {
      Object.assign(byName[key], {
        siteUid: s.siteUid,
        dattoOpenAlerts: s.numberOfOpenAlerts,
        dattoCriticalAlerts: s.numberOfOpenCriticalAlerts,
        dattoDeviceCount: s.numberOfDevices,
        dattoOnline: s.numberOfOnlineDevices,
        dattoOffline: s.numberOfOfflineDevices,
      });
    } else {
      byName[key] = {
        name: s.name,
        siteUid: s.siteUid,
        dattoOpenAlerts: s.numberOfOpenAlerts,
        dattoCriticalAlerts: s.numberOfOpenCriticalAlerts,
        dattoDeviceCount: s.numberOfDevices,
        dattoOnline: s.numberOfOnlineDevices,
        dattoOffline: s.numberOfOfflineDevices,
      };
    }
  });
  return Object.values(byName).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

async function loadClients(force = false) {
  if (state.clients && !force) return state.clients;
  const [atCompanies, dattoSites] = await Promise.all([
    fetchAllAtCompanies(),
    fetchAllDattoSites(),
  ]);
  state.clients = buildUnifiedClientList(atCompanies, dattoSites);
  // Refresh atCompanyCache too — useful elsewhere
  atCompanies.forEach(c => { if (c.atId) atCompanyCache[c.atId] = c.name; });
  LS.set('msp_at_companies', atCompanyCache);
  return state.clients;
}

function getClientOpenAlerts(client) {
  if (!client?.name) return [];
  return state.alerts.filter(a => (a.siteName || '').toLowerCase() === client.name.toLowerCase());
}

function getClientOpenTickets(client) {
  if (!client) return [];
  return Object.values(state.tickets).filter(t => {
    if (t.isDone) return false;
    if (client.atId && t.companyID === client.atId) return true;
    if (client.name && t.companyName && t.companyName.toLowerCase() === client.name.toLowerCase()) return true;
    return false;
  });
}

async function getClientResolvedTickets(client, days = 14) {
  if (!client) return [];
  // Reuse the reports cache pattern — pull last 14d resolved tickets, filter to this client
  if (!state.clientResolvedCache ||
      Date.now() - state.clientResolvedCache.fetchedAt > CLIENT_RESOLVED_CACHE_TTL) {
    state.clientResolvedCache = {
      items: await fetchResolvedTicketsForReports(days),
      fetchedAt: Date.now(),
    };
  }
  const all = state.clientResolvedCache.items || [];
  return all.filter(t => {
    if (client.atId && t.companyID === client.atId) return true;
    return false;
  });
}

async function fetchClientDevices(client) {
  if (!client?.siteUid) return [];
  const cached = state.clientDevicesCache[client.siteUid];
  if (cached && Date.now() - cached.fetchedAt < CLIENT_DEVICES_CACHE_TTL) return cached.devices;
  try {
    const data = await dattoFetch(`/site/${client.siteUid}/devices`);
    const devices = (data?.devices || data?.items || []).map(d => ({
      uid: d.uid || d.id,
      id: d.id,
      hostname: d.hostname || d.description || 'unknown',
      online: d.online === true || d.online === 'true',
      lastSeen: d.lastSeen || d.lastSeenDate,
      operatingSystem: d.operatingSystem || d.osType,
      type: d.deviceType || d.type,
    }));
    state.clientDevicesCache[client.siteUid] = { devices, fetchedAt: Date.now() };
    return devices;
  } catch(e) { console.warn('Client devices fetch failed:', e.message); return []; }
}

function calcClientHealth(client) {
  const alerts = getClientOpenAlerts(client);
  const tickets = getClientOpenTickets(client);
  const hasCriticalAlert = alerts.some(a => a.priority === 'Critical');
  const hasHighAlert = alerts.some(a => a.priority === 'High');
  const oldestTicketDays = tickets.reduce((max, t) => {
    if (!t.createDate) return max;
    const age = (Date.now() - new Date(t.createDate).getTime()) / 86400000;
    return age > max ? age : max;
  }, 0);
  const offline = client.dattoOffline || 0;
  if (hasCriticalAlert || oldestTicketDays > 60) {
    return { level: 'critical', color: '#c8102e', label: 'CRITICAL', icon: '🔴' };
  }
  if (hasHighAlert || oldestTicketDays > 14 || offline > 0) {
    return { level: 'watch', color: '#e07b00', label: 'WATCH', icon: '🟡' };
  }
  return { level: 'healthy', color: '#2a9d5c', label: 'HEALTHY', icon: '🟢' };
}

// ─── DRILL-DOWN PANEL ─────────────────────────────────────────────
function ensureDrillPanelEl() {
  let panel = document.getElementById('drillPanel');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'drillPanel';
  panel.className = 'drill-panel';
  panel.innerHTML = `
    <div class="drill-panel-header">
      <span class="drill-panel-title" id="drillPanelTitle">—</span>
      <button class="drill-panel-close" data-action="drill-close" title="Close">×</button>
    </div>
    <div class="drill-panel-body" id="drillPanelBody"></div>
  `;
  document.body.appendChild(panel);
  return panel;
}

function openDrillPanel(title, bodyHtml) {
  const panel = ensureDrillPanelEl();
  document.getElementById('drillPanelTitle').textContent = title;
  document.getElementById('drillPanelBody').innerHTML = bodyHtml;
  panel.classList.add('open');
  state.drillPanel = { open: true, title };
}

function closeDrillPanel() {
  const panel = document.getElementById('drillPanel');
  if (panel) panel.classList.remove('open');
  state.drillPanel = null;
}

function drillTicketRows(tickets) {
  if (!tickets.length) return '<div class="drill-empty">No tickets to show.</div>';
  return tickets.map(t => {
    const ageDays = t.createDate ? Math.floor((Date.now() - new Date(t.createDate).getTime()) / 86400000) : null;
    return `<div class="drill-row" data-action="drill-open-ticket" data-ticket-number="${esc(t.ticketNumber || '')}">
      <div class="drill-row-main">
        <span class="drill-tn">${esc(t.ticketNumber || '')}</span>
        <span class="drill-title">${esc(t.title || '(no title)')}</span>
      </div>
      <div class="drill-row-meta">
        ${t.statusLabel ? `<span class="drill-pill" style="color:${t.statusColor||'var(--textdim)'};border-color:${t.statusColor||'var(--border)'}44">${esc(t.statusLabel)}</span>` : ''}
        <span class="drill-tech">${esc(t.assignedResourceName || 'Unassigned')}</span>
        ${ageDays != null ? `<span class="drill-age">${ageDays}d</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function drillAlertRows(alerts) {
  if (!alerts.length) return '<div class="drill-empty">No alerts to show.</div>';
  return alerts.map(a => {
    const sv = SEV[a.priority] || SEV.Information;
    return `<div class="drill-row" data-action="drill-open-alert" data-alert-uid="${esc(a.alertUid)}">
      <div class="drill-row-main">
        <span class="drill-tn">${esc(a.hostname)}</span>
        <span class="drill-title">${esc(a.alertMessage || '')}</span>
      </div>
      <div class="drill-row-meta">
        <span class="drill-pill" style="color:${sv.color};border-color:${sv.color}55">${esc(a.priority)}</span>
        <span class="drill-tech">${esc(a.monitorType || '')}</span>
        ${a.ticketNumber ? `<span class="drill-age">${esc(a.ticketNumber)}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function drillDeviceRows(devices) {
  if (!devices.length) return '<div class="drill-empty">No devices to show.</div>';
  return devices.map(d => {
    const onlineColor = d.online ? '#2a9d5c' : '#c8102e';
    return `<div class="drill-row">
      <div class="drill-row-main">
        <span class="drill-tn">${esc(d.hostname)}</span>
        <span class="drill-title">${esc(d.operatingSystem || '')}</span>
      </div>
      <div class="drill-row-meta">
        <span class="drill-pill" style="color:${onlineColor};border-color:${onlineColor}55">${d.online?'ONLINE':'OFFLINE'}</span>
        ${d.lastSeen ? `<span class="drill-age">${esc(fmtRelativeTime(d.lastSeen))}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ─── CLIENT LIST + DETAIL VIEWS ───────────────────────────────────
async function renderClientsView() {
  const root = document.getElementById('view-clients');
  if (!root) return;

  if (state.currentClient) {
    return renderClientDetail(state.currentClient);
  }

  root.innerHTML = `
    <div class="clients-wrap">
      <div class="clients-header">
        <div class="clients-title">👥 Clients</div>
        <input id="clientSearch" type="text" placeholder="Filter clients..." class="clients-search" />
        <label class="clients-show-hidden" title="Show clients you've hidden">
          <input type="checkbox" id="showHiddenClientsToggle" ${state.showHiddenClients?'checked':''} />
          <span>Show hidden</span>
          <span class="ticket-stale-count" id="hiddenClientsCount">${state.hiddenClients.size}</span>
        </label>
        <button class="reports-range-btn" data-action="clients-refresh" title="Refresh client list">↺</button>
      </div>
      <div id="clientsListBody"><div class="loading-state">Loading clients...</div></div>
    </div>
  `;

  try {
    const clients = await loadClients();
    renderClientsListBody(clients, '');
  } catch(e) {
    document.getElementById('clientsListBody').innerHTML = `<div class="loading-state" style="color:#c8102e">Error: ${esc(e.message)}</div>`;
  }
}

function renderClientsListBody(clients, filter) {
  const body = document.getElementById('clientsListBody');
  if (!body) return;
  const f = (filter || '').toLowerCase().trim();
  let working = clients;
  // Filter by hidden state — unless toggle says show them
  if (!state.showHiddenClients) {
    working = working.filter(c => !state.hiddenClients.has(c.name));
  }
  // Apply text filter
  const filtered = f
    ? working.filter(c => (c.name || '').toLowerCase().includes(f))
    : working;
  if (!filtered.length) {
    const totalHidden = clients.filter(c => state.hiddenClients.has(c.name)).length;
    const hint = !f && totalHidden && !state.showHiddenClients
      ? `All ${totalHidden} clients are hidden. Toggle "Show hidden" above to see them.`
      : 'No clients match.';
    body.innerHTML = `<div class="loading-state">${esc(hint)}</div>`;
    return;
  }
  body.innerHTML = filtered.map(c => {
    const health = calcClientHealth(c);
    const alertsN = getClientOpenAlerts(c).length;
    const ticketsN = getClientOpenTickets(c).length;
    const offline = c.dattoOffline || 0;
    const isHidden = state.hiddenClients.has(c.name);
    return `<div class="client-row ${isHidden?'client-row-hidden':''}" data-client-name="${esc(c.name)}">
      <div class="client-row-left" data-action="open-client" data-client-name="${esc(c.name)}">
        <span class="client-health" style="color:${health.color}" title="${health.label}">${health.icon}</span>
        <span class="client-name">${esc(c.name)}</span>
        ${c.city ? `<span class="client-city">${esc(c.city)}${c.stateAbbr?', '+esc(c.stateAbbr):''}</span>` : ''}
      </div>
      <div class="client-row-right">
        ${alertsN ? `<span class="client-stat client-stat-alerts">${alertsN} alerts</span>` : ''}
        ${ticketsN ? `<span class="client-stat client-stat-tickets">${ticketsN} tickets</span>` : ''}
        ${offline ? `<span class="client-stat client-stat-offline">${offline} offline</span>` : ''}
        ${c.dattoDeviceCount != null ? `<span class="client-stat client-stat-devices">${c.dattoDeviceCount} devices</span>` : ''}
        <button class="client-hide-btn" data-action="toggle-client-hidden" data-client-name="${esc(c.name)}" title="${isHidden?'Show this client':'Hide this client'}">${isHidden?'👁':'🙈'}</button>
      </div>
    </div>`;
  }).join('');
}

async function renderClientDetail(client) {
  const root = document.getElementById('view-clients');
  if (!root) return;
  const health = calcClientHealth(client);
  const openAlerts = getClientOpenAlerts(client);
  const openTickets = getClientOpenTickets(client);
  const criticalAlerts = openAlerts.filter(a => a.priority === 'Critical');
  const highAlerts = openAlerts.filter(a => a.priority === 'High');
  const otherAlerts = openAlerts.filter(a => !['Critical','High'].includes(a.priority));
  const aging = openTickets.filter(t => t.createDate && (Date.now() - new Date(t.createDate).getTime()) > 14 * 86400000);
  const zone = state.settings.atZone || '14';
  const atUrl = client.atId ? `https://ww${zone}.autotask.net/Mvc/CRM/AccountDetails.mvc?accountId=${client.atId}` : null;
  const dattoUrl = client.siteUid ? `${getDattoUiBaseUrl()}/site/${client.siteUid}` : null;

  root.innerHTML = `
    <div class="clients-wrap">
      <div class="clients-header" style="margin-bottom:14px">
        <button class="abtn abtn-ghost" data-action="back-to-clients" style="margin-right:8px">← Back</button>
        <div class="clients-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="color:${health.color}">${health.icon}</span>
          <span>${esc(client.name)}</span>
          <span class="health-badge" style="color:${health.color};background:${health.color}22;border:1px solid ${health.color}44">${health.label}</span>
        </div>
        <div style="margin-left:auto;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          ${atUrl ? `<a href="${esc(atUrl)}" target="_blank" rel="noopener" class="reports-range-btn">🎫 Open in Autotask</a>` : ''}
          ${dattoUrl ? `<a href="${esc(dattoUrl)}" target="_blank" rel="noopener" class="reports-range-btn">📟 Open in Datto</a>` : ''}
          <button class="reports-range-btn" data-action="client-refresh" data-client-name="${esc(client.name)}" title="Refresh">↺</button>
        </div>
      </div>

      <div class="reports-stats">
        <div class="reports-stat-card client-drill" data-action="drill" data-drill="open-alerts" data-client-name="${esc(client.name)}">
          <div class="reports-stat-label">OPEN ALERTS</div>
          <div class="reports-stat-value" style="color:${openAlerts.length?'#e07b00':'var(--text)'}">${openAlerts.length}</div>
          <div class="reports-stat-sub">${criticalAlerts.length} crit · ${highAlerts.length} high · ${otherAlerts.length} other</div>
        </div>
        <div class="reports-stat-card client-drill" data-action="drill" data-drill="open-tickets" data-client-name="${esc(client.name)}">
          <div class="reports-stat-label">OPEN TICKETS</div>
          <div class="reports-stat-value">${openTickets.length}</div>
          <div class="reports-stat-sub">${aging.length} aging > 14d</div>
        </div>
        <div class="reports-stat-card client-drill" data-action="drill" data-drill="aging-tickets" data-client-name="${esc(client.name)}">
          <div class="reports-stat-label">AGING TICKETS</div>
          <div class="reports-stat-value" style="color:${aging.length?'#e07b00':'var(--text)'}">${aging.length}</div>
          <div class="reports-stat-sub">open > 14 days</div>
        </div>
        <div class="reports-stat-card client-drill" data-action="drill" data-drill="devices" data-client-name="${esc(client.name)}">
          <div class="reports-stat-label">DEVICES</div>
          <div class="reports-stat-value">${client.dattoDeviceCount != null ? client.dattoDeviceCount : '—'}</div>
          <div class="reports-stat-sub">${client.dattoOnline != null ? `${client.dattoOnline} online · ${client.dattoOffline||0} offline` : 'no Datto site linked'}</div>
        </div>
        <div class="reports-stat-card client-drill" data-action="drill" data-drill="recent-resolutions" data-client-name="${esc(client.name)}">
          <div class="reports-stat-label">RESOLVED 14D</div>
          <div class="reports-stat-value" id="clientResolvedCount">…</div>
          <div class="reports-stat-sub">click to see what we did</div>
        </div>
      </div>

      ${criticalAlerts.length ? `<div class="reports-card">
        <div class="card-label" style="color:#c8102e">🚨 ACTIVE CRITICALS (${criticalAlerts.length})</div>
        ${drillAlertRows(criticalAlerts)}
      </div>` : ''}

      ${aging.length ? `<div class="reports-card">
        <div class="card-label" style="color:#e07b00">🕐 AGING TICKETS</div>
        ${drillTicketRows(aging.slice(0, 10))}
        ${aging.length > 10 ? `<div class="aging-more">+ ${aging.length - 10} more (click stat above to see all)</div>` : ''}
      </div>` : ''}

      ${client.phone || client.city ? `<div class="reports-card">
        <div class="card-label">CONTACT INFO</div>
        <div class="meta-grid">
          ${client.phone ? `<div class="meta-cell"><div class="meta-label">PHONE</div><div class="meta-value">${esc(client.phone)}</div></div>` : ''}
          ${client.city ? `<div class="meta-cell"><div class="meta-label">CITY</div><div class="meta-value">${esc(client.city)}${client.stateAbbr?', '+esc(client.stateAbbr):''}</div></div>` : ''}
          ${client.atId ? `<div class="meta-cell"><div class="meta-label">AT ID</div><div class="meta-value">${client.atId}</div></div>` : ''}
        </div>
      </div>` : ''}
    </div>
  `;

  // Async-fetch resolved count
  getClientResolvedTickets(client).then(items => {
    const el = document.getElementById('clientResolvedCount');
    if (el) el.textContent = items.length;
  });
}

async function handleClientDrill(drill, clientName) {
  const client = (state.clients || []).find(c => c.name === clientName);
  if (!client) return;
  if (drill === 'open-alerts') {
    openDrillPanel(`Open alerts — ${client.name}`, drillAlertRows(getClientOpenAlerts(client)));
  } else if (drill === 'open-tickets') {
    openDrillPanel(`Open tickets — ${client.name}`, drillTicketRows(getClientOpenTickets(client)));
  } else if (drill === 'aging-tickets') {
    const aging = getClientOpenTickets(client).filter(t => t.createDate && (Date.now() - new Date(t.createDate).getTime()) > 14 * 86400000)
      .sort((a, b) => new Date(a.createDate).getTime() - new Date(b.createDate).getTime());
    openDrillPanel(`Aging tickets — ${client.name}`, drillTicketRows(aging));
  } else if (drill === 'devices') {
    openDrillPanel(`Devices — ${client.name}`, '<div class="loading-state">Loading from Datto...</div>');
    const devices = await fetchClientDevices(client);
    devices.sort((a, b) => Number(a.online) - Number(b.online)); // offline first
    openDrillPanel(`Devices — ${client.name} (${devices.filter(d=>!d.online).length} offline)`, drillDeviceRows(devices));
  } else if (drill === 'recent-resolutions') {
    openDrillPanel(`Resolved last 14d — ${client.name}`, '<div class="loading-state">Loading...</div>');
    const items = await getClientResolvedTickets(client);
    // Items don't have all the fields used by drillTicketRows; reshape
    const reshaped = items.map(t => ({
      ticketNumber: t.ticketNumber,
      title: t.title,
      statusLabel: 'Complete',
      statusColor: '#2a9d5c',
      assignedResourceName: state.atResources.find(r => r.id === t.assignedResourceID)?.name || 'Unassigned',
      createDate: t.createDate,
    }));
    openDrillPanel(`Resolved last 14d — ${client.name} (${reshaped.length})`, drillTicketRows(reshaped));
  }
}


// ─── REPORTS ──────────────────────────────────────────────────────
const REPORTS_RANGES = [
  { days: 7,  label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
];

async function fetchResolvedTicketsForReports(days) {
  // Cache key includes days so switching ranges refetches
  const cacheKey = `tickets-${days}`;
  if (state.reportsResolvedTickets?.key === cacheKey &&
      Date.now() - state.reportsResolvedTickets.fetchedAt < 5 * 60 * 1000) {
    return state.reportsResolvedTickets.items;
  }
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const pl = await loadAtStatusPicklist();
  const doneIds = Object.entries(pl).filter(([,i]) => i.done).map(([v]) => parseInt(v)).filter(Boolean);
  if (!doneIds.length) return [];
  try {
    const data = await atFetch('/Tickets/query','POST',{
      MaxRecords: 500,
      filter: [
        { op: 'in',  field: 'status',     value: doneIds },
        { op: 'gte', field: 'createDate', value: cutoff },
      ],
      IncludeFields: ['id','ticketNumber','title','companyID','assignedResourceID','status','createDate','resolvedDateTime','lastActivityDate'],
    });
    const items = data?.items || [];
    state.reportsResolvedTickets = { key: cacheKey, items, fetchedAt: Date.now() };
    return items;
  } catch(e) { console.warn('Resolved tickets fetch failed:', e.message); return []; }
}

async function fetchResolvedAlertsForReports(days) {
  const cacheKey = `alerts-${days}`;
  if (state.reportsResolvedAlerts?.key === cacheKey &&
      Date.now() - state.reportsResolvedAlerts.fetchedAt < 5 * 60 * 1000) {
    return state.reportsResolvedAlerts.items;
  }
  // Datto resolved alerts endpoint — we'll grab a wide window and filter client-side by date
  try {
    let allItems = [];
    let pageNum = 0;
    const max = 250;
    // Paginate up to 4 pages (1000 alerts) to be safe; stop early if a page returns < max
    while (pageNum < 4) {
      const data = await dattoFetch(`/account/alerts/resolved?max=${max}&page=${pageNum}`);
      const items = data?.alerts || data?.items || [];
      if (!items.length) break;
      allItems = allItems.concat(items);
      if (items.length < max) break;
      pageNum++;
    }
    // Normalize and filter to window
    const cutoffMs = Date.now() - days * 86400000;
    const filtered = allItems
      .map(a => ({
        alertUid: a.alertUid || a.id,
        timestampMs: a.timestamp ? new Date(a.timestamp).getTime() : (a.alertContext?.timestamp || 0),
        resolvedMs:  a.resolved?.resolvedTimestamp ? new Date(a.resolved.resolvedTimestamp).getTime()
                    : a.resolvedTimestamp ? new Date(a.resolvedTimestamp).getTime() : null,
        priority: a.priority || a.alertSourceInfo?.priority || 'Unknown',
        siteName: a.alertSourceInfo?.siteName || a.siteName || 'Unknown',
        hostname: a.alertSourceInfo?.deviceName || a.deviceName || 'Unknown',
      }))
      .filter(a => a.resolvedMs && a.resolvedMs >= cutoffMs);
    state.reportsResolvedAlerts = { key: cacheKey, items: filtered, fetchedAt: Date.now() };
    return filtered;
  } catch(e) { console.warn('Resolved alerts fetch failed:', e.message); return []; }
}

// Tiny SVG line-chart helper. Two series overlaid (e.g., opened vs resolved).
function svgLineChart(buckets, opts = {}) {
  const w = opts.width || 720;
  const h = opts.height || 180;
  const padL = 36, padR = 14, padT = 14, padB = 24;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const labels = buckets.map(b => b.label);
  const seriesA = buckets.map(b => b.a || 0);
  const seriesB = buckets.map(b => b.b || 0);
  const maxY = Math.max(1, ...seriesA, ...seriesB);
  const xStep = buckets.length > 1 ? innerW / (buckets.length - 1) : 0;
  const px = i => padL + i * xStep;
  const py = v => padT + innerH - (v / maxY) * innerH;
  const pathA = seriesA.map((v,i) => (i===0?'M':'L') + px(i) + ',' + py(v)).join(' ');
  const pathB = seriesB.map((v,i) => (i===0?'M':'L') + px(i) + ',' + py(v)).join(' ');
  const yTicks = [0, Math.ceil(maxY/2), maxY];
  const colorA = opts.colorA || '#e07b00';
  const colorB = opts.colorB || '#2a9d5c';
  // Show every Nth label so they don't overlap
  const labelStride = Math.max(1, Math.ceil(buckets.length / 8));
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;display:block">
    ${yTicks.map(t => `<line x1="${padL}" y1="${py(t)}" x2="${w-padR}" y2="${py(t)}" stroke="var(--border)" stroke-dasharray="2,3"/>
                       <text x="4" y="${py(t)+3}" fill="var(--textdim)" font-size="10" font-family="var(--cond)">${t}</text>`).join('')}
    <path d="${pathA}" stroke="${colorA}" stroke-width="2" fill="none"/>
    <path d="${pathB}" stroke="${colorB}" stroke-width="2" fill="none"/>
    ${seriesA.map((v,i) => `<circle cx="${px(i)}" cy="${py(v)}" r="2.5" fill="${colorA}"/>`).join('')}
    ${seriesB.map((v,i) => `<circle cx="${px(i)}" cy="${py(v)}" r="2.5" fill="${colorB}"/>`).join('')}
    ${labels.map((l,i) => i % labelStride === 0 ? `<text x="${px(i)}" y="${h-6}" text-anchor="middle" fill="var(--textdim)" font-size="9" font-family="var(--cond)">${esc(l)}</text>` : '').join('')}
  </svg>`;
}

function svgBarChart(rows, opts = {}) {
  const w = opts.width || 360;
  const h = Math.max(40, rows.length * 28 + 8);
  const labelW = opts.labelW || 130;
  const valueW = 36;
  const barAreaW = w - labelW - valueW - 12;
  const maxV = Math.max(1, ...rows.map(r => r.value));
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
    ${rows.map((r, i) => {
      const y = i * 28 + 4;
      const barW = (r.value / maxV) * barAreaW;
      const color = r.color || '#00b4d8';
      return `
        <text x="${labelW-6}" y="${y+18}" text-anchor="end" fill="var(--text)" font-size="12" font-family="inherit">${esc(r.label)}</text>
        <rect x="${labelW}" y="${y+5}" width="${barW}" height="18" fill="${color}" opacity="0.85" rx="2"/>
        <text x="${labelW+barW+6}" y="${y+18}" fill="var(--textdim)" font-size="11" font-family="var(--cond);font-weight:700">${r.value}</text>
      `;
    }).join('')}
  </svg>`;
}

function bucketByDay(items, days, getTime) {
  const today = new Date();
  today.setHours(0,0,0,0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    buckets.push({
      day: d,
      label: (d.getMonth()+1) + '/' + d.getDate(),
      startMs: d.getTime(),
      endMs: d.getTime() + 86400000,
      a: 0, b: 0,
    });
  }
  return buckets;
}

async function buildAlertTrendData(days) {
  // a = opened in day, b = resolved in day
  const buckets = bucketByDay(null, days);
  // Opened — use current open alerts (state.alerts) timestampMs
  state.alerts.forEach(a => {
    const ts = a.timestampMs;
    if (!ts) return;
    const b = buckets.find(b => ts >= b.startMs && ts < b.endMs);
    if (b) b.a++;
  });
  // Resolved — fetch from Datto
  const resolved = await fetchResolvedAlertsForReports(days);
  resolved.forEach(a => {
    if (!a.resolvedMs) return;
    const b = buckets.find(b => a.resolvedMs >= b.startMs && a.resolvedMs < b.endMs);
    if (b) b.b++;
  });
  // Also count opened from resolved alerts (those would be missing from state.alerts)
  resolved.forEach(a => {
    if (!a.timestampMs) return;
    const b = buckets.find(b => a.timestampMs >= b.startMs && a.timestampMs < b.endMs);
    if (b) b.a++;
  });
  return buckets;
}

function calcMTTR(items, getStartMs, getEndMs) {
  const durations = items
    .map(i => {
      const s = getStartMs(i), e = getEndMs(i);
      return (s && e && e >= s) ? (e - s) : null;
    })
    .filter(d => d !== null && d > 0);
  if (!durations.length) return null;
  const avg = durations.reduce((a,b) => a+b, 0) / durations.length;
  return avg;
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const hrs = ms / 3600000;
  if (hrs < 24) return hrs.toFixed(1) + 'h';
  const days = hrs / 24;
  return days.toFixed(1) + 'd';
}

async function buildReportsData(days) {
  const [resolvedTickets, resolvedAlerts] = await Promise.all([
    fetchResolvedTicketsForReports(days),
    fetchResolvedAlertsForReports(days),
  ]);
  // Need company name resolution for resolved tickets
  const companyIds = [...new Set(resolvedTickets.map(t => t.companyID).filter(Boolean))];
  await loadAtCompanyNames(companyIds);
  await loadAtResources();

  // MTTR — tickets
  const ticketMttr = calcMTTR(
    resolvedTickets,
    t => t.createDate ? new Date(t.createDate).getTime() : null,
    t => (t.resolvedDateTime || t.lastActivityDate) ? new Date(t.resolvedDateTime || t.lastActivityDate).getTime() : null
  );
  // Prior period for trend
  const priorTickets = await fetchResolvedTicketsForReports(days * 2);
  const priorOnly = priorTickets.filter(t => {
    const cd = new Date(t.createDate).getTime();
    return cd < Date.now() - days * 86400000;
  });
  const priorMttr = calcMTTR(
    priorOnly,
    t => t.createDate ? new Date(t.createDate).getTime() : null,
    t => (t.resolvedDateTime || t.lastActivityDate) ? new Date(t.resolvedDateTime || t.lastActivityDate).getTime() : null
  );
  // MTTR — alerts
  const alertMttr = calcMTTR(
    resolvedAlerts,
    a => a.timestampMs,
    a => a.resolvedMs
  );

  // Tech workload: open ticket count + average age per resource
  const openTickets = getOpenTickets({ includeStale: true });
  const techMap = {};
  openTickets.forEach(t => {
    const name = t.assignedResourceName || 'Unassigned';
    if (!techMap[name]) techMap[name] = { name, count: 0, ageDays: [] };
    techMap[name].count++;
    if (t.createDate) {
      const age = (Date.now() - new Date(t.createDate).getTime()) / 86400000;
      techMap[name].ageDays.push(age);
    }
  });
  const techRows = Object.values(techMap)
    .map(t => ({
      name: t.name,
      count: t.count,
      avgAge: t.ageDays.length ? (t.ageDays.reduce((a,b)=>a+b,0)/t.ageDays.length) : 0,
    }))
    .sort((a,b) => b.count - a.count);

  // Top clients by ticket volume (opened in window)
  // Count from resolvedTickets + currently-open tickets created in window
  const clientCounts = {};
  resolvedTickets.forEach(t => {
    const cid = t.companyID;
    if (!cid) return;
    const name = atCompanyCache[cid] || `Company ${cid}`;
    clientCounts[name] = (clientCounts[name] || 0) + 1;
  });
  openTickets.forEach(t => {
    if (!t.createDate) return;
    const ageMs = Date.now() - new Date(t.createDate).getTime();
    if (ageMs > days * 86400000) return; // older than window, skip
    const name = t.companyName || (t.companyID ? `Company ${t.companyID}` : null);
    if (!name) return;
    clientCounts[name] = (clientCounts[name] || 0) + 1;
  });
  const topClients = Object.entries(clientCounts)
    .map(([name, count]) => ({ label: name, value: count }))
    .sort((a,b) => b.value - a.value)
    .slice(0, 10);

  // Aging tickets — open > 14 days
  const AGE_THRESHOLD_DAYS = 14;
  const agingTickets = openTickets
    .filter(t => t.createDate && (Date.now() - new Date(t.createDate).getTime()) > AGE_THRESHOLD_DAYS * 86400000)
    .map(t => ({
      ticketNumber: t.ticketNumber,
      title: t.title,
      tech: t.assignedResourceName || 'Unassigned',
      client: t.companyName || (t.companyID ? `Company ${t.companyID}` : 'Unknown'),
      ageDays: Math.floor((Date.now() - new Date(t.createDate).getTime()) / 86400000),
      statusLabel: t.statusLabel,
      statusColor: t.statusColor,
    }))
    .sort((a,b) => b.ageDays - a.ageDays);

  return {
    days,
    ticketsResolvedCount: resolvedTickets.length,
    alertsResolvedCount: resolvedAlerts.length,
    ticketMttr, priorMttr, alertMttr,
    techRows,
    topClients,
    agingTickets,
    alertTrendBuckets: await buildAlertTrendData(days),
  };
}

function trendArrow(current, prior) {
  if (current == null || prior == null) return '';
  if (Math.abs(current - prior) / prior < 0.05) return '<span style="color:var(--textdim)">→ flat</span>';
  if (current < prior) return `<span style="color:#2a9d5c">↓ ${Math.round((1-current/prior)*100)}% better</span>`;
  return `<span style="color:#c8102e">↑ ${Math.round((current/prior-1)*100)}% slower</span>`;
}

async function renderReportsView() {
  const root = document.getElementById('view-reports');
  if (!root) return;
  // Date range tabs + skeleton
  const days = state.reportsRange || 30;
  root.innerHTML = `
    <div class="reports-wrap">
      <div class="reports-header">
        <div class="reports-title">📊 Reports</div>
        <div class="reports-range">
          ${REPORTS_RANGES.map(r => `<button class="reports-range-btn ${r.days===days?'active':''}" data-action="reports-range" data-days="${r.days}">${r.label}</button>`).join('')}
          <button class="reports-range-btn" data-action="reports-refresh" title="Refresh data" style="margin-left:auto">↺</button>
        </div>
      </div>
      <div id="reportsBody"><div class="loading-state">Crunching numbers...</div></div>
    </div>
  `;
  try {
    const data = await buildReportsData(days);
    renderReportsBody(data);
  } catch(e) {
    console.error('Reports error:', e);
    document.getElementById('reportsBody').innerHTML =
      `<div class="loading-state" style="color:#c8102e">Error: ${esc(e.message)}</div>`;
  }
}

function renderReportsBody(data) {
  const body = document.getElementById('reportsBody');
  if (!body) return;
  const ticketTrend = trendArrow(data.ticketMttr, data.priorMttr);

  body.innerHTML = `
    <!-- Top stats row -->
    <div class="reports-stats">
      <div class="reports-stat-card">
        <div class="reports-stat-label">TICKETS RESOLVED</div>
        <div class="reports-stat-value">${data.ticketsResolvedCount}</div>
        <div class="reports-stat-sub">last ${data.days} days</div>
      </div>
      <div class="reports-stat-card">
        <div class="reports-stat-label">ALERTS RESOLVED</div>
        <div class="reports-stat-value">${data.alertsResolvedCount}</div>
        <div class="reports-stat-sub">last ${data.days} days</div>
      </div>
      <div class="reports-stat-card">
        <div class="reports-stat-label">MTTR — TICKETS</div>
        <div class="reports-stat-value">${fmtDuration(data.ticketMttr)}</div>
        <div class="reports-stat-sub">${ticketTrend || 'no prior period'}</div>
      </div>
      <div class="reports-stat-card">
        <div class="reports-stat-label">MTTR — ALERTS</div>
        <div class="reports-stat-value">${fmtDuration(data.alertMttr)}</div>
        <div class="reports-stat-sub">last ${data.days} days</div>
      </div>
    </div>

    <!-- Alert trend -->
    <div class="reports-card">
      <div class="card-label" style="display:flex;align-items:center;justify-content:space-between">
        <span>📈 ALERT TREND — OPENED vs RESOLVED</span>
        <div class="reports-legend">
          <span><span class="legend-swatch" style="background:#e07b00"></span>Opened</span>
          <span><span class="legend-swatch" style="background:#2a9d5c"></span>Resolved</span>
        </div>
      </div>
      ${data.alertTrendBuckets.length ? svgLineChart(data.alertTrendBuckets) :
        '<div class="loading-state">No data in window</div>'}
    </div>

    <!-- Two-column: Tech workload + Top clients -->
    <div class="reports-grid-two">
      <div class="reports-card">
        <div class="card-label">👥 TECH WORKLOAD — OPEN TICKETS</div>
        ${data.techRows.length ? svgBarChart(
          data.techRows.map(r => ({ label: r.name, value: r.count })),
          { labelW: 130 }
        ) + `<div class="reports-tech-detail">
          ${data.techRows.map(r => `<div class="tech-detail-row">
            <span>${esc(r.name)}</span>
            <span class="tech-avg-age">${r.avgAge ? r.avgAge.toFixed(1) + 'd avg age' : '—'}</span>
          </div>`).join('')}
        </div>` : '<div class="loading-state">No open tickets</div>'}
      </div>

      <div class="reports-card">
        <div class="card-label">🏢 TOP CLIENTS BY TICKET VOLUME</div>
        ${data.topClients.length ? svgBarChart(data.topClients, { labelW: 160 })
          : '<div class="loading-state">No client data in window</div>'}
      </div>
    </div>

    <!-- Aging tickets -->
    <div class="reports-card">
      <div class="card-label">🕐 AGING TICKETS — OPEN > 14 DAYS (${data.agingTickets.length})</div>
      ${data.agingTickets.length ? `<div class="aging-list">
        ${data.agingTickets.slice(0, 30).map(t => {
          const ageColor = t.ageDays > 60 ? '#c8102e' : t.ageDays > 30 ? '#e07b00' : '#c8a000';
          return `<div class="aging-row" data-ticket-number="${esc(t.ticketNumber)}">
            <div class="aging-row-main">
              <span class="aging-tn">${esc(t.ticketNumber)}</span>
              <span class="aging-title">${esc(t.title || '(no title)')}</span>
            </div>
            <div class="aging-row-meta">
              <span class="aging-tech">${esc(t.tech)}</span>
              <span class="aging-client">${esc(t.client)}</span>
              <span class="aging-status" style="color:${t.statusColor||'var(--textdim)'};border-color:${t.statusColor||'var(--border)'}44">${esc(t.statusLabel||'')}</span>
              <span class="aging-age" style="color:${ageColor};font-weight:700">${t.ageDays}d</span>
            </div>
          </div>`;
        }).join('')}
        ${data.agingTickets.length > 30 ? `<div class="aging-more">+ ${data.agingTickets.length - 30} more</div>` : ''}
      </div>` : '<div class="loading-state" style="color:#2a9d5c">✓ Nothing aging — all tickets under 14 days</div>'}
    </div>
  `;
}

// ─── NAVIGATION ───────────────────────────────────────────────────
function setView(view) {
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${view}`));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===view));
  if (view==='kb') renderKB();
  if (view==='clients') renderClientsView();
  if (view==='reports') renderReportsView();
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

  // Aging tickets in Reports — click jumps to ticket detail
  document.addEventListener('click', e => {
    const row = e.target.closest('.aging-row[data-ticket-number]');
    if (!row) return;
    const tn = row.dataset.ticketNumber;
    const ticket = state.tickets[tn];
    if (!ticket) {
      showToast(`Ticket ${tn} not in cache. Try Tickets → Refresh.`, 'info');
      return;
    }
    state.currentTicket = ticket;
    setView('tickets');
    renderTicketDetail(ticket);
    renderTicketList();
  });

  // Ticket refresh — REPLACES the entire open-ticket cache rather than merging,
  // so tickets that are now closed/assigned-to-someone-else/out-of-window get properly dropped.
  $('ticketRefreshBtn')?.addEventListener('click', async () => {
    const btn=$('ticketRefreshBtn');
    if(btn){btn.textContent='↺ Loading...';btn.disabled=true;}
    try {
      const items=await fetchAtTicketQueue();
      const priorCount = Object.values(state.tickets).filter(t => !t.isDone).length;
      // Safety net: if we had >20 tickets before and the fetch returned <10, something went wrong.
      // Keep the old cache and warn instead of nuking to an empty state.
      if (priorCount > 20 && items.length < 10) {
        console.warn('[refresh] Aborting cache replace — fetch returned only', items.length, 'but cache had', priorCount, 'open tickets. Likely partial API failure. Run debugTicketQuery() in console for details.');
        showToast(`⚠️ Fetch returned ${items.length}, keeping cached ${priorCount}. Check console.`, 'err');
        if(btn){btn.textContent='↺ Refresh';btn.disabled=false;}
        return;
      }
      // Preserve any tickets that are linked to open Datto alerts (even if outside the current query window)
      // so alert→ticket links don't break. Everything else is replaced.
      const linkedTicketNumbers = new Set(state.alerts.map(a => a.ticketNumber).filter(Boolean));
      const preserved = {};
      linkedTicketNumbers.forEach(tn => {
        if (state.tickets[tn]) preserved[tn] = state.tickets[tn];
      });
      // Rebuild state.tickets from scratch with fresh data
      state.tickets = { ...preserved };
      items.forEach(t=>{
        state.tickets[t.ticketNumber]={
          id:t.id,ticketNumber:t.ticketNumber,status:t.status,statusLabel:t.statusLabel,statusColor:t.statusColor,isDone:t.isDone,
          priority:t.priority,queueID:t.queueID,
          title:t.title,companyID:t.companyID,companyName:t.companyName,lastActivity:t.lastActivityDate,
          createDate:t.createDate,
          assignedResourceID:t.assignedResourceID,assignedResourceName:t.assignedResourceName,
        };
      });
      // For preserved tickets not in the fresh items list, refresh their status so mismatches update
      const freshNumbers = new Set(items.map(t => t.ticketNumber));
      const stalePreserved = Object.keys(preserved).filter(tn => !freshNumbers.has(tn));
      if (stalePreserved.length) {
        try { await syncTicketStatuses(stalePreserved); } catch(e) { console.warn('Preserved ticket sync failed:', e.message); }
      }
      LS.set('msp_tickets',state.tickets);
      render();
      showToast(`✓ Loaded ${items.length} open tickets`,'ok');
    } catch(e){showToast(`Ticket sync error: ${e.message}`,'err'); console.error('[refresh] fetch threw:', e);}
    finally{if(btn){btn.textContent='↺ Refresh';btn.disabled=false;}}
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
        // Link alert to ticket and persist
        alert.ticketNumber = newTicket.ticketNumber;
        LS.set('msp_alerts', state.alerts);
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
      const setLoadingText = (txt) => {
        if (aiOut) aiOut.innerHTML = `<div class="ai-loading"><div class="pulse-dot"></div>${esc(txt)}</div>`;
      };
      const kbOn = state.settings.includeKbContext !== false;
      const histOn = state.settings.includeTicketHistory !== false;
      // Only show context-fetch line if something is being fetched AND not already cached
      const kbCached = state.kbContextCache[uid] && (Date.now() - state.kbContextCache[uid].fetchedAt) < KB_TTL_MS;
      const histCached = state.historyContextCache[uid] && (Date.now() - state.historyContextCache[uid].fetchedAt) < HISTORY_TTL_MS;
      const willFetchKb = kbOn && !kbCached;
      const willFetchHist = histOn && !histCached;
      if (willFetchKb && willFetchHist)      setLoadingText('Gathering KB + ticket history...');
      else if (willFetchKb)                  setLoadingText('Gathering KB context...');
      else if (willFetchHist)                setLoadingText('Pulling ticket history...');
      else                                   setLoadingText('Analyzing alert with full context...');
      el.textContent='Analyzing...'; el.disabled=true;
      try {
        const system = await buildAlertSystemPrompt(alert);
        setLoadingText('Analyzing alert with full context...');
        const result = await callAI(system,[{role:'user',content:`Analyze this alert for ${alert.hostname} — ${alert.alertMessage}`}]);
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

    if (action==='send-ticket-chat') {
      const tid = el.dataset.ticketId;
      const input = $('ticketChatInput');
      const msg = input?.value.trim();
      if (tid && msg) sendTicketChat(tid, msg);
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

    if (action==='save-ticket-to-kb') {
      const ticketId = el.dataset.ticketId;
      const ticket = Object.values(state.tickets).find(t => String(t.id) === ticketId);
      if (!ticket) return;
      const input = $('ticketNotesInput');
      const finalResolution = input?.value.trim() || '';
      const inv = getInvestigation(ticket.id);
      // Need at least *something* to draft from
      if (!finalResolution && !inv?.steps?.some(s => s.notes?.trim())) {
        showToast('Add a resolution or work the investigation first', 'info');
        return;
      }
      const origLabel = el.textContent;
      el.disabled = true; el.textContent = '✨ Drafting...';
      try {
        const draft = await draftKbEntryFromTicket(ticket, inv, finalResolution);
        // Combine diagnosis + fix into the resolution field of the existing modal
        const resolutionCombined = [
          draft.diagnosis ? `DIAGNOSIS:\n${draft.diagnosis}` : '',
          draft.fix ? `FIX:\n${draft.fix}` : '',
        ].filter(Boolean).join('\n\n');
        showKBModal({
          title: draft.title,
          symptoms: draft.symptoms,
          resolution: resolutionCombined,
          tags: (draft.tags || []).join(', '),
        });
      } catch(err) {
        showToast(`KB draft failed: ${err.message}`, 'err');
      } finally {
        el.disabled = false; el.textContent = origLabel;
      }
    }

    if (action==='ticket-accept') {
      const ticketId=el.dataset.ticketId;
      const ticket=Object.values(state.tickets).find(t=>String(t.id)===ticketId); if(!ticket) return;
      try {
        const rid = await ensureMyResource();
        if (!rid) return;
        el.disabled = true; el.textContent = 'Accepting...';
        await patchTicketField(ticket, 'assignedResourceID', rid);
        // Also bump status to "In Progress" if currently "New"
        const pl = state.atStatusPicklist || {};
        const inProgress = Object.entries(pl).find(([,i]) => (i.label||'').toLowerCase().includes('progress'));
        if (inProgress && (ticket.statusLabel||'').toLowerCase() === 'new') {
          await patchTicketField(ticket, 'status', parseInt(inProgress[0]));
        }
        state.currentTicket = ticket;
        renderTicketDetail(ticket); renderTicketList();
        showToast('✓ Ticket accepted', 'ok');
      } catch(e) {
        showToast(`Accept failed: ${e.message}`, 'err');
        renderTicketDetail(ticket);
      }
    }

    if (action==='ticket-complete') {
      const ticketId=el.dataset.ticketId;
      const ticket=Object.values(state.tickets).find(t=>String(t.id)===ticketId); if(!ticket) return;
      await loadAtStatusPicklist();
      const doneId = findCompleteStatusID();
      if (!doneId) { showToast('No Complete status found in picklist', 'err'); return; }

      const origLabel = el.textContent;
      const resetBtn = () => { el.disabled = false; el.textContent = origLabel; };

      const input = $('ticketNotesInput');
      const unpostedText = (input?.value || '').trim();

      // Fetch the ticket's current resolution from AT to know what we're working with
      el.disabled = true; el.textContent = 'Checking...';
      let currentResolution = '';
      try {
        const data = await atFetch(`/Tickets/${ticket.id}`);
        currentResolution = ((data?.item?.resolution ?? data?.resolution) || '').trim();
      } catch(e) {
        console.warn('Could not verify resolution:', e.message);
      }

      // Guard: no resolution anywhere — block and focus the field
      if (!currentResolution && !unpostedText) {
        resetBtn();
        showToast('Add a resolution before completing', 'err');
        input?.focus();
        return;
      }

      // Unposted text that differs from what's on the ticket — offer to post first
      if (unpostedText && unpostedText !== currentResolution) {
        const msg = currentResolution
          ? `The ticket already has a different resolution posted.\n\nReplace it with the text in your Resolution field and complete?`
          : `Post this resolution and mark ticket ${ticket.ticketNumber} complete?`;
        if (!confirm(msg)) { resetBtn(); return; }
        try {
          el.textContent = 'Posting resolution...';
          await postResolutionToAt(ticket.id, unpostedText, ticket.assignedResourceID);
          state.notesDrafts['ticket-'+ticket.id] = '';
        } catch(e) {
          showToast(`Failed to post resolution: ${e.message}`, 'err');
          resetBtn();
          return;
        }
      } else {
        // Resolution already present (or textarea matches it) — simple confirm
        if (!confirm(`Mark ticket ${ticket.ticketNumber} as Complete?`)) { resetBtn(); return; }
      }

      // Do the status PATCH to Complete
      try {
        el.textContent = 'Completing...';
        await patchTicketField(ticket, 'status', doneId);

        // Auto-resolve any open Datto alerts linked to this ticket (no confirm — user opted into fast-mode)
        const linkedAlerts = state.alerts.filter(a => a.ticketNumber === ticket.ticketNumber);
        let alertsResolved = 0;
        let alertsFailed = 0;
        if (linkedAlerts.length) {
          for (const a of linkedAlerts) {
            try {
              await resolveAlert(a.alertUid);
              alertsResolved++;
            } catch(e) {
              console.warn(`Auto-resolve of alert ${a.alertUid} failed:`, e.message);
              alertsFailed++;
            }
          }
          // Drop resolved alerts from local state
          if (alertsResolved > 0) {
            const resolvedUids = new Set(linkedAlerts.map(a => a.alertUid));
            state.alerts = state.alerts.filter(a => !resolvedUids.has(a.alertUid));
            LS.set('msp_alerts', state.alerts);
          }
        }
        state.currentTicket = ticket;
        renderTicketDetail(ticket); renderTicketList();
        if (alertsResolved > 0 && alertsFailed === 0) {
          showToast(`✓ Ticket completed + ${alertsResolved} alert${alertsResolved!==1?'s':''} resolved`, 'ok');
        } else if (alertsResolved > 0 && alertsFailed > 0) {
          showToast(`✓ Ticket completed · ${alertsResolved} alert${alertsResolved!==1?'s':''} resolved, ${alertsFailed} failed (see console)`, 'info');
        } else if (alertsFailed > 0) {
          showToast(`✓ Ticket completed · ${alertsFailed} linked alert${alertsFailed!==1?'s':''} failed to auto-resolve (see console)`, 'info');
        } else {
          showToast('✓ Ticket completed', 'ok');
        }
      } catch(e) {
        showToast(`Complete failed: ${e.message}`, 'err');
        resetBtn();
        renderTicketDetail(ticket);
      }
    }

    // ─── TICKET INVESTIGATION HANDLERS ────────────────────────────
    const findTicketByBtn = () => {
      const tid = el.dataset.ticketId;
      return Object.values(state.tickets).find(t => String(t.id) === tid);
    };

    const setInvStatus = (msg) => {
      const s = document.getElementById('investigationStatus');
      if (s) s.textContent = msg || '';
    };

    if (action==='ticket-analyze') {
      const ticket = findTicketByBtn(); if (!ticket) return;
      const origLabel = el.textContent;
      el.disabled = true;
      el.textContent = 'Analyzing...';
      try {
        const techCtxEl = document.getElementById('techContextInput');
        const techContext = (techCtxEl?.value || '').trim();
        const inv = await runTicketInvestigation(ticket, setInvStatus, techContext);
        setInvestigation(ticket.id, inv);
        // Clear the draft context now that it's been folded in
        delete state.notesDrafts['tech-ctx-' + ticket.id];
        LS.set('msp_notes', state.notesDrafts);
        renderTicketDetail(ticket);
        showToast('✓ Investigation complete', 'ok');
      } catch(err) {
        showToast(`Analyze failed: ${err.message}`, 'err');
        setInvStatus(`Error: ${err.message}`);
        el.disabled = false; el.textContent = origLabel;
      }
    }

    if (action==='ticket-reanalyze') {
      const ticket = findTicketByBtn(); if (!ticket) return;
      const currentInv = getInvestigation(ticket.id);
      const priorContext = currentInv?.techContext || '';
      // Small modal to edit context before re-running
      const newCtx = await new Promise(resolve => {
        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
        modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:20px;width:100%;max-width:520px">
          <div style="font-family:var(--cond);font-size:14px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px">↺ RE-ANALYZE TICKET</div>
          <div style="font-size:12px;color:var(--textdim);margin-bottom:12px">This will replace the current plan and clear all step notes. Revise your tech context below if needed, then re-run.</div>
          <label style="display:block;font-family:var(--cond);font-size:11px;font-weight:700;letter-spacing:0.09em;color:var(--textdim);margin-bottom:4px">TECH CONTEXT (optional)</label>
          <textarea id="reAnalyzeCtx" rows="4" style="width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:8px;border-radius:4px;font-size:13px;font-family:inherit;resize:vertical" placeholder="e.g. Tried restart already. Client is on cellular backup.">${esc(priorContext)}</textarea>
          <div style="display:flex;gap:8px;margin-top:14px">
            <button id="reAnalyzeGo" style="flex:2;cursor:pointer;background:linear-gradient(135deg, rgba(147,51,234,0.25), rgba(0,180,216,0.25));border:1px solid rgba(147,51,234,0.5);color:var(--text);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">▶ RE-ANALYZE</button>
            <button id="reAnalyzeCancel" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Cancel</button>
          </div>
        </div>`;
        document.body.appendChild(modal);
        const ctxInput = document.getElementById('reAnalyzeCtx');
        ctxInput?.focus();
        document.getElementById('reAnalyzeCancel').addEventListener('click', () => {
          document.body.removeChild(modal); resolve(null);
        });
        document.getElementById('reAnalyzeGo').addEventListener('click', () => {
          const v = ctxInput?.value || '';
          document.body.removeChild(modal); resolve(v);
        });
      });
      if (newCtx === null) return; // cancelled

      const origLabel = el.textContent;
      el.disabled = true; el.textContent = 'Re-analyzing...';
      try {
        const inv = await runTicketInvestigation(ticket, setInvStatus, newCtx.trim());
        setInvestigation(ticket.id, inv);
        clearTicketChat(ticket.id);
        renderTicketDetail(ticket);
        showToast('✓ Re-analysis complete', 'ok');
      } catch(err) {
        showToast(`Re-analyze failed: ${err.message}`, 'err');
        setInvStatus(`Error: ${err.message}`);
        el.disabled = false; el.textContent = origLabel;
      }
    }

    if (action==='inv-step-add') {
      const ticket = findTicketByBtn(); if (!ticket) return;
      const inv = getInvestigation(ticket.id); if (!inv) return;
      inv.steps.push({ id: newStepId(), text: '', done: false, notes: '', minutes: 0 });
      setInvestigation(ticket.id, inv);
      renderTicketDetail(ticket);
    }

    if (action==='reports-range') {
      const days = parseInt(el.dataset.days);
      if (!days || state.reportsRange === days) return;
      state.reportsRange = days;
      renderReportsView();
    }

    if (action==='reports-refresh') {
      // Bust caches and re-render
      state.reportsResolvedTickets = null;
      state.reportsResolvedAlerts = null;
      renderReportsView();
    }

    // ─── CLIENTS / DRILL-DOWN HANDLERS ────────────────────────────
    if (action==='clients-refresh') {
      state.clients = null;
      state.clientResolvedCache = null;
      renderClientsView();
    }
    if (action==='open-client') {
      const name = el.dataset.clientName;
      const client = (state.clients || []).find(c => c.name === name);
      if (!client) return;
      state.currentClient = client;
      renderClientDetail(client);
    }
    if (action==='toggle-client-hidden') {
      const name = el.dataset.clientName;
      if (!name) return;
      if (state.hiddenClients.has(name)) {
        state.hiddenClients.delete(name);
      } else {
        state.hiddenClients.add(name);
      }
      LS.set('msp_hidden_clients', [...state.hiddenClients]);
      // Update count badge in header
      const count = document.getElementById('hiddenClientsCount');
      if (count) count.textContent = state.hiddenClients.size;
      // Re-render list with current filter
      const filterInput = document.getElementById('clientSearch');
      renderClientsListBody(state.clients || [], filterInput?.value || '');
    }
    if (action==='back-to-clients') {
      state.currentClient = null;
      closeDrillPanel();
      renderClientsView();
    }
    if (action==='client-refresh') {
      const name = el.dataset.clientName;
      const client = (state.clients || []).find(c => c.name === name);
      if (!client) return;
      state.clientResolvedCache = null;
      if (client.siteUid) delete state.clientDevicesCache[client.siteUid];
      renderClientDetail(client);
    }
    if (action==='drill') {
      const drill = el.dataset.drill;
      const name = el.dataset.clientName;
      await handleClientDrill(drill, name);
    }
    if (action==='drill-close') {
      closeDrillPanel();
    }
    if (action==='drill-open-ticket') {
      const tn = el.dataset.ticketNumber;
      const ticket = state.tickets[tn];
      if (!ticket) {
        showToast(`Ticket ${tn} not in cache. Try Tickets → Refresh.`, 'info');
        return;
      }
      closeDrillPanel();
      state.currentTicket = ticket;
      setView('tickets');
      renderTicketDetail(ticket);
      renderTicketList();
    }
    if (action==='drill-open-alert') {
      const uid = el.dataset.alertUid;
      const alert = state.alerts.find(a => a.alertUid === uid);
      if (!alert) {
        showToast('Alert not in cache.', 'info');
        return;
      }
      closeDrillPanel();
      state.currentAlert = alert;
      setView('alerts');
      renderAlertDetail(alert);
    }

    if (action==='jump-to-ticket') {
      const tid = el.dataset.ticketId;
      const ticket = Object.values(state.tickets).find(t => String(t.id) === tid);
      if (!ticket) {
        showToast('Ticket not in cache. Try Tickets → Refresh.', 'info');
        return;
      }
      state.currentTicket = ticket;
      setView('tickets');
      renderTicketDetail(ticket);
      renderTicketList();
    }

    if (action==='open-in-datto') {
      const deviceUid = el.dataset.deviceUid;
      await openDattoDeviceForAlert(deviceUid, el);
    }

    if (action==='device-refresh') {
      const deviceUid = el.dataset.deviceUid;
      if (!deviceUid) return;
      delete state.deviceCache[deviceUid];
      const body = document.getElementById('devicePanelBody');
      if (body) body.innerHTML = '<div style="color:var(--textdim);font-size:12px;padding:10px 0">Refreshing...</div>';
      const data = await fetchDattoDevice(deviceUid);
      if (state.currentTicket) hydrateDevicePanel(data);
    }

    if (action==='activity-refresh') {
      const ticket = findTicketByBtn(); if (!ticket) return;
      const body = document.getElementById('activityFeedBody');
      if (body) body.innerHTML = '<div style="color:var(--textdim);font-size:12px;padding:10px 0">Refreshing...</div>';
      const notes = await fetchAtTicketActivityNotes(ticket.id);
      await loadAtResources();
      if (state.currentTicket?.id === ticket.id) hydrateActivityFeed(notes);
    }

    if (action==='inv-step-delete' || action==='inv-step-up' || action==='inv-step-down') {
      const stepEl = el.closest('.inv-step'); if (!stepEl) return;
      const tid = stepEl.dataset.ticketId;
      const sid = stepEl.dataset.stepId;
      const ticket = Object.values(state.tickets).find(t => String(t.id) === tid); if (!ticket) return;
      const inv = getInvestigation(ticket.id); if (!inv) return;
      const idx = inv.steps.findIndex(s => s.id === sid);
      if (idx < 0) return;
      if (action==='inv-step-delete') {
        if (!confirm('Delete this step?')) return;
        inv.steps.splice(idx, 1);
      } else if (action==='inv-step-up' && idx > 0) {
        [inv.steps[idx-1], inv.steps[idx]] = [inv.steps[idx], inv.steps[idx-1]];
      } else if (action==='inv-step-down' && idx < inv.steps.length - 1) {
        [inv.steps[idx], inv.steps[idx+1]] = [inv.steps[idx+1], inv.steps[idx]];
      }
      setInvestigation(ticket.id, inv);
      renderTicketDetail(ticket);
    }

    if (action==='ticket-draft-resolution') {
      const ticket = findTicketByBtn(); if (!ticket) return;
      const inv = getInvestigation(ticket.id); if (!inv) return;
      const hasAnyNotes = inv.steps.some(s => s.notes?.trim());
      if (!hasAnyNotes) {
        if (!confirm('No step notes captured yet. Draft will be minimal / honest about lack of documentation. Continue?')) return;
      }
      const origLabel = el.textContent;
      el.disabled = true; el.textContent = 'Drafting...';
      try {
        setInvStatus('Drafting resolution from step notes...');
        const draft = await draftResolutionFromSteps(ticket, inv);
        const resInput = document.getElementById('ticketNotesInput');
        if (resInput) {
          resInput.value = draft;
          state.notesDrafts['ticket-'+ticket.id] = draft;
          LS.set('msp_notes', state.notesDrafts);
          resInput.focus();
          resInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        setInvStatus('✓ Draft ready — review and edit above, then POST RESOLUTION');
        showToast('✓ Resolution drafted — review before posting', 'ok');
      } catch(err) {
        showToast(`Draft failed: ${err.message}`, 'err');
        setInvStatus(`Error: ${err.message}`);
      } finally {
        el.disabled = false; el.textContent = origLabel;
      }
    }
  });

  // Ticket field inline edits (status, priority, queue, resource)
  document.addEventListener('change', async e => {
    // Show-stale toggle on ticket list
    if (e.target.id === 'ticketShowStale') {
      state.ticketShowStale = !!e.target.checked;
      renderTicketList();
      return;
    }
    // Show-hidden toggle on clients list
    if (e.target.id === 'showHiddenClientsToggle') {
      state.showHiddenClients = !!e.target.checked;
      const filterInput = document.getElementById('clientSearch');
      renderClientsListBody(state.clients || [], filterInput?.value || '');
      return;
    }
    // Investigation: toggle step done
    if (e.target.classList?.contains('inv-step-done-cb')) {
      const stepEl = e.target.closest('.inv-step'); if (!stepEl) return;
      const ticket = Object.values(state.tickets).find(t => String(t.id) === stepEl.dataset.ticketId);
      if (!ticket) return;
      const inv = getInvestigation(ticket.id); if (!inv) return;
      const step = inv.steps.find(s => s.id === stepEl.dataset.stepId);
      if (!step) return;
      step.done = !!e.target.checked;
      setInvestigation(ticket.id, inv);
      stepEl.classList.toggle('inv-step-done', step.done);
      return;
    }
    if (!e.target.classList?.contains('ticket-field-select')) return;
    const sel = e.target;
    const ticketId = sel.dataset.ticketId;
    const field = sel.dataset.field;
    const ticket = Object.values(state.tickets).find(t => String(t.id) === ticketId);
    if (!ticket) return;
    const prevValue = ticket[field];
    const newValue = sel.value;
    sel.disabled = true;
    try {
      await patchTicketField(ticket, field, newValue);
      state.currentTicket = ticket;
      // Refresh header color/badge without blowing away select focus
      renderTicketDetail(ticket); renderTicketList();
      const label = sel.options[sel.selectedIndex]?.text || '';
      showToast(`✓ ${field.replace('ID','')} → ${label}`, 'ok');
    } catch(err) {
      sel.value = prevValue ?? '';
      showToast(`Update failed: ${err.message}`, 'err');
    } finally {
      sel.disabled = false;
    }
  });

  // Enter to send chat
  document.addEventListener('keydown', e => {
    if(e.target.id==='aiChatInput'&&e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      const uid=e.target.dataset.uid, msg=e.target.value.trim();
      if(uid&&msg) sendChat(uid,msg);
    }
    if(e.target.id==='ticketChatInput'&&e.key==='Enter'&&!e.shiftKey){
      e.preventDefault();
      const tid = e.target.dataset.ticketId, msg = e.target.value.trim();
      if (tid && msg) sendTicketChat(tid, msg);
    }
    // ESC closes drill panel if open
    if (e.key === 'Escape' && state.drillPanel?.open) {
      closeDrillPanel();
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
    if(e.target.id==='techContextInput'){
      const ticketId = e.target.dataset.ticketId;
      if (ticketId) {
        state.notesDrafts['tech-ctx-' + ticketId] = e.target.value;
        clearTimeout(window._techCtxSaveTimer);
        window._techCtxSaveTimer = setTimeout(() => LS.set('msp_notes', state.notesDrafts), 400);
      }
    }
    // Client list filter
    if (e.target.id === 'clientSearch') {
      renderClientsListBody(state.clients || [], e.target.value);
    }
    // Investigation per-step autosave (text / notes / minutes)
    const invField = e.target.dataset?.action;
    if (invField === 'inv-step-text' || invField === 'inv-step-notes' || invField === 'inv-step-mins') {
      const stepEl = e.target.closest('.inv-step'); if (!stepEl) return;
      const ticket = Object.values(state.tickets).find(t => String(t.id) === stepEl.dataset.ticketId);
      if (!ticket) return;
      const inv = getInvestigation(ticket.id); if (!inv) return;
      const step = inv.steps.find(s => s.id === stepEl.dataset.stepId); if (!step) return;
      if (invField === 'inv-step-text')  step.text    = e.target.value;
      if (invField === 'inv-step-notes') step.notes   = e.target.value.slice(0, INV_STEP_NOTES_MAX);
      if (invField === 'inv-step-mins')  step.minutes = parseInt(e.target.value) || 0;
      // Debounce LS writes — schedule via a shared timer
      clearTimeout(window._invSaveTimer);
      window._invSaveTimer = setTimeout(() => saveInvestigations(), 400);
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

// ─── TIER A STYLES (inline-injected — self-contained) ────────────
function injectTierAStyles() {
  if (document.getElementById('tierA-styles')) return;
  const style = document.createElement('style');
  style.id = 'tierA-styles';
  style.textContent = `
    .ticket-fields-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px 14px;
    }
    @media (max-width: 640px) {
      .ticket-fields-grid { grid-template-columns: 1fr; }
    }
    .ticket-fields-grid .field-group { margin-bottom: 0; }
    .ticket-fields-grid label {
      display: block;
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: var(--textdim);
      margin-bottom: 4px;
    }
    select.ticket-field-select {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 4px;
      font-size: 13px;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    select.ticket-field-select:hover:not(:disabled) {
      border-color: var(--accent);
    }
    select.ticket-field-select:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 2px rgba(0,180,216,0.15);
    }
    select.ticket-field-select:disabled {
      opacity: 0.5;
      cursor: wait;
    }
    .abtn-accept {
      background: rgba(0,180,216,0.12);
      border: 1px solid rgba(0,180,216,0.4);
      color: #00b4d8;
    }
    .abtn-accept:hover:not(:disabled) {
      background: rgba(0,180,216,0.22);
      border-color: rgba(0,180,216,0.7);
    }
    .abtn-complete {
      background: rgba(42,157,92,0.12);
      border: 1px solid rgba(42,157,92,0.4);
      color: #2a9d5c;
    }
    .abtn-complete:hover:not(:disabled) {
      background: rgba(42,157,92,0.22);
      border-color: rgba(42,157,92,0.7);
    }
    /* AI Investigation card */
    .abtn-ai {
      background: linear-gradient(135deg, rgba(147,51,234,0.18), rgba(0,180,216,0.18));
      border: 1px solid rgba(147,51,234,0.45);
      color: var(--text);
      font-weight: 700;
    }
    .abtn-ai:hover:not(:disabled) {
      background: linear-gradient(135deg, rgba(147,51,234,0.28), rgba(0,180,216,0.28));
      border-color: rgba(147,51,234,0.7);
    }
    .abtn-ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textmid);
    }
    .abtn-ghost:hover:not(:disabled) { border-color: var(--accent); color: var(--text); }
    .inv-analysis {
      background: rgba(147,51,234,0.05);
      border: 1px solid rgba(147,51,234,0.2);
      border-radius: 6px;
      padding: 10px 12px;
      margin: 10px 0 14px;
    }
    .inv-analysis-row { margin-bottom: 6px; }
    .inv-conf-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.09em;
    }
    .inv-understanding {
      font-size: 13px;
      line-height: 1.5;
      color: var(--text);
    }
    .inv-ctx-wrap { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .inv-ctx-badge {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 3px;
      background: rgba(0,180,216,0.1);
      border: 1px solid rgba(0,180,216,0.3);
      color: var(--textmid);
    }
    .inv-tech-ctx {
      margin-top: 10px;
      padding: 8px 10px;
      background: rgba(0,180,216,0.06);
      border-left: 3px solid var(--accent);
      border-radius: 3px;
    }
    .inv-tech-ctx-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: var(--accent);
      margin-bottom: 4px;
    }
    .inv-tech-ctx-body {
      font-size: 12px;
      color: var(--text);
      line-height: 1.45;
      white-space: pre-wrap;
    }
    .inv-steps-wrap { display: flex; flex-direction: column; gap: 8px; }
    .inv-step {
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      background: var(--bg);
      transition: opacity 0.15s;
    }
    .inv-step.inv-step-done { opacity: 0.55; }
    .inv-step.inv-step-done .inv-step-text { text-decoration: line-through; color: var(--textdim); }
    .inv-step-header {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .inv-step-done-cb {
      width: 16px; height: 16px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .inv-step-num {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 13px;
      font-weight: 700;
      color: var(--textdim);
      min-width: 18px;
      text-align: center;
    }
    .inv-step-text {
      flex: 1;
      background: transparent;
      border: 1px solid transparent;
      color: var(--text);
      padding: 4px 6px;
      border-radius: 3px;
      font-size: 13px;
      font-family: inherit;
      min-width: 0;
    }
    .inv-step-text:hover:not(:focus) { border-color: var(--border); }
    .inv-step-text:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--bg);
    }
    .inv-step-btn {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textmid);
      width: 24px;
      height: 24px;
      border-radius: 3px;
      cursor: pointer;
      font-size: 13px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: border-color 0.15s, color 0.15s;
    }
    .inv-step-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--text); }
    .inv-step-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .inv-step-delete:hover:not(:disabled) { border-color: #c8102e; color: #c8102e; }
    .inv-step-mins {
      width: 50px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 3px 5px;
      border-radius: 3px;
      font-size: 12px;
      text-align: center;
      -moz-appearance: textfield;
    }
    .inv-step-mins::-webkit-outer-spin-button,
    .inv-step-mins::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
    .inv-step-notes {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 6px 8px;
      border-radius: 3px;
      font-size: 12px;
      font-family: inherit;
      line-height: 1.45;
      margin-top: 6px;
      min-height: 38px;
      resize: vertical;
    }
    .inv-step-notes:focus {
      outline: none;
      border-color: var(--accent);
    }
    .inv-step-add-row { margin-top: 10px; }
    .inv-actions-row {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
    }
    @media (max-width: 640px) {
      .inv-step-header { flex-wrap: wrap; }
      .inv-step-text { order: 10; flex-basis: 100%; margin-top: 4px; }
    }
    /* Tier B: Device / Activity / Metadata */
    .device-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin: 6px 0 12px;
    }
    .device-name {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 16px;
      font-weight: 700;
      letter-spacing: 0.04em;
      color: var(--text);
    }
    .device-meta {
      font-size: 11px;
      color: var(--textdim);
      margin-top: 2px;
    }
    .device-status-badge {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      padding: 3px 8px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .device-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 8px 12px;
      padding: 10px 12px;
      background: rgba(0,180,216,0.04);
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .device-grid-cell { min-width: 0; }
    .device-grid-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--textdim);
      margin-bottom: 2px;
    }
    .device-grid-value {
      font-size: 12px;
      color: var(--text);
      word-break: break-word;
    }
    .device-section {
      margin-top: 12px;
    }
    .device-section-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--textdim);
      margin-bottom: 6px;
    }
    .device-storage-row { margin-bottom: 8px; }
    .device-storage-label {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 3px;
    }
    .device-storage-bar {
      width: 100%;
      height: 6px;
      background: var(--border);
      border-radius: 3px;
      overflow: hidden;
    }
    .device-storage-fill {
      height: 100%;
      transition: width 0.3s;
    }
    .device-storage-sub {
      font-size: 10px;
      color: var(--textdim);
      margin-top: 2px;
    }
    .device-health-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .device-health-pill {
      font-size: 11px;
      padding: 3px 8px;
      border-radius: 3px;
      background: rgba(42,157,92,0.1);
      border: 1px solid rgba(42,157,92,0.3);
      color: var(--textmid);
    }
    /* Activity feed */
    .activity-row {
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
    }
    .activity-row:last-child { border-bottom: 0; }
    .activity-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 3px;
    }
    .activity-author {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: var(--accent);
    }
    .activity-date {
      font-size: 10px;
      color: var(--textdim);
    }
    .activity-type {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.1em;
      padding: 1px 6px;
      border-radius: 2px;
    }
    .activity-type-internal {
      background: rgba(224,123,0,0.12);
      color: #e07b00;
      border: 1px solid rgba(224,123,0,0.4);
    }
    .activity-type-public {
      background: rgba(42,157,92,0.12);
      color: #2a9d5c;
      border: 1px solid rgba(42,157,92,0.4);
    }
    .activity-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 3px;
    }
    .activity-desc {
      font-size: 12px;
      color: var(--textmid);
      line-height: 1.45;
      white-space: pre-wrap;
    }
    /* Metadata */
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 10px 14px;
      padding: 4px 0;
    }
    .meta-cell { min-width: 0; }
    .meta-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--textdim);
      margin-bottom: 2px;
    }
    .meta-value {
      font-size: 12px;
      color: var(--text);
      word-break: break-word;
    }
    /* Ticket list status filter toolbar */
    .ticket-status-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      margin-bottom: 8px;
      background: rgba(0,180,216,0.04);
      border: 1px solid var(--border);
      border-radius: 4px;
    }
    .ticket-stale-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 12px;
      color: var(--textmid);
    }
    .ticket-stale-toggle input[type="checkbox"] { cursor: pointer; }
    .ticket-stale-count {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      padding: 2px 6px;
      border-radius: 3px;
      background: rgba(200,160,0,0.12);
      color: #c8a000;
      border: 1px solid rgba(200,160,0,0.35);
    }
    .ticket-active-summary {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      color: var(--accent);
    }
    /* Reports view */
    .reports-wrap { padding: 16px; max-width: 1200px; }
    .reports-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      gap: 12px;
      flex-wrap: wrap;
    }
    .reports-title {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    .reports-range {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
    }
    .reports-range-btn {
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textmid);
      padding: 6px 14px;
      border-radius: 4px;
      font-family: var(--cond);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.07em;
      transition: all 0.15s;
    }
    .reports-range-btn:hover { border-color: var(--accent); color: var(--text); }
    .reports-range-btn.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .reports-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .reports-stat-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 12px 14px;
    }
    .reports-stat-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: var(--textdim);
      margin-bottom: 4px;
    }
    .reports-stat-value {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 26px;
      font-weight: 700;
      color: var(--text);
      line-height: 1.1;
    }
    .reports-stat-sub {
      font-size: 10px;
      color: var(--textdim);
      margin-top: 3px;
    }
    .reports-card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .reports-grid-two {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 14px;
    }
    .reports-grid-two .reports-card { margin-bottom: 0; }
    @media (max-width: 800px) { .reports-grid-two { grid-template-columns: 1fr; } }
    .reports-legend {
      display: flex;
      gap: 12px;
      font-size: 11px;
      color: var(--textmid);
      font-family: var(--cond);
      letter-spacing: 0.04em;
      text-transform: none;
      font-weight: 400;
    }
    .legend-swatch {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 2px;
      margin-right: 4px;
      vertical-align: middle;
    }
    .reports-tech-detail {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px solid var(--border);
    }
    .tech-detail-row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      font-size: 11px;
      color: var(--textdim);
    }
    .tech-avg-age { font-family: var(--cond); font-weight: 700; }
    .aging-list { display: flex; flex-direction: column; gap: 4px; }
    .aging-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      flex-wrap: wrap;
    }
    .aging-row:hover {
      border-color: var(--accent);
      background: rgba(0,180,216,0.04);
    }
    .aging-row-main { flex: 1; min-width: 0; }
    .aging-tn {
      font-family: var(--cond);
      font-weight: 700;
      font-size: 13px;
      color: var(--accent);
      margin-right: 8px;
    }
    .aging-title {
      font-size: 13px;
      color: var(--text);
    }
    .aging-row-meta {
      display: flex;
      gap: 10px;
      align-items: center;
      font-size: 11px;
      flex-wrap: wrap;
    }
    .aging-tech { color: var(--textmid); font-weight: 600; }
    .aging-client { color: var(--textdim); }
    .aging-status {
      padding: 2px 6px;
      border: 1px solid;
      border-radius: 3px;
      font-family: var(--cond);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.07em;
    }
    .aging-age {
      font-family: var(--cond);
      font-size: 13px;
      min-width: 36px;
      text-align: right;
    }
    .aging-more {
      text-align: center;
      padding: 8px;
      color: var(--textdim);
      font-size: 12px;
    }
    /* Alert/ticket connection visuals */
    .list-row-locked {
      opacity: 0.72;
    }
    .list-row-locked:hover { opacity: 1; }
    .list-row-locked.active { opacity: 1; }
    .alert-locked-badge {
      background: rgba(0,180,216,0.12);
      color: var(--accent);
      border: 1px solid rgba(0,180,216,0.4);
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      letter-spacing: 0.08em;
      font-size: 10px;
      font-weight: 700;
    }
    .jump-card {
      background: linear-gradient(135deg, rgba(0,180,216,0.06), rgba(147,51,234,0.04));
      border: 1px solid rgba(0,180,216,0.3);
    }
    .jump-summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 8px 14px;
      margin: 10px 0;
    }
    .jump-summary-row {
      display: flex;
      flex-direction: column;
    }
    .jump-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: var(--textdim);
    }
    .jump-value {
      font-size: 14px;
      color: var(--text);
      font-weight: 500;
      margin-top: 2px;
    }
    .jump-locked-msg {
      font-size: 12px;
      color: var(--textdim);
      padding: 8px 10px;
      background: rgba(0,0,0,0.08);
      border-radius: 4px;
      border-left: 3px solid var(--accent);
      margin-top: 10px;
      line-height: 1.5;
    }
    .alert-status-pill {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      padding: 2px 7px;
      border-radius: 3px;
      text-transform: none;
    }
    .alert-status-open {
      background: rgba(200,16,46,0.12);
      color: #c8102e;
      border: 1px solid rgba(200,16,46,0.4);
    }
    .alert-status-resolved {
      background: rgba(42,157,92,0.12);
      color: #2a9d5c;
      border: 1px solid rgba(42,157,92,0.4);
    }
    .datto-open-btn {
      color: var(--accent) !important;
      border-color: rgba(0,180,216,0.4) !important;
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-weight: 700;
      letter-spacing: 0.07em;
    }
    .datto-open-btn:hover {
      border-color: var(--accent) !important;
      background: rgba(0,180,216,0.08);
    }
    .inv-chat-section {
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid var(--border);
    }
    .inv-chat-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: var(--accent);
      margin-bottom: 8px;
    }
    .inv-chat-section .chat-history {
      max-height: 360px;
      overflow-y: auto;
    }
    .inv-chat-section .chat-history:empty {
      display: none;
    }
    /* Clients view */
    #view-clients { display: none; }
    #view-clients.active { display: flex; flex-direction: column; flex: 1 1 0%; overflow-y: auto; }
    .clients-wrap { padding: 16px; max-width: 1200px; }
    .clients-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
    }
    .clients-title {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.06em;
    }
    .clients-search {
      flex: 1;
      min-width: 200px;
      padding: 8px 12px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 4px;
      font-size: 13px;
      font-family: inherit;
    }
    .clients-search:focus {
      outline: none;
      border-color: var(--accent);
    }
    .client-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 14px;
      padding: 10px 14px;
      margin-bottom: 6px;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s, transform 0.1s;
      flex-wrap: wrap;
    }
    .client-row:hover {
      border-color: var(--accent);
      background: rgba(0,180,216,0.04);
    }
    .client-row:active { transform: scale(0.998); }
    .client-row-left {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 1;
      min-width: 0;
    }
    .client-health { font-size: 14px; }
    .client-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }
    .client-city {
      font-size: 11px;
      color: var(--textdim);
    }
    .client-row-right {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .client-stat {
      font-family: var(--cond);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      padding: 3px 8px;
      border-radius: 3px;
      border: 1px solid var(--border);
      color: var(--textdim);
    }
    .client-stat-alerts { color: #e07b00; border-color: rgba(224,123,0,0.4); background: rgba(224,123,0,0.08); }
    .client-stat-tickets { color: var(--accent); border-color: rgba(0,180,216,0.35); background: rgba(0,180,216,0.06); }
    .client-stat-offline { color: #c8102e; border-color: rgba(200,16,46,0.4); background: rgba(200,16,46,0.08); }
    .client-stat-devices { color: var(--textmid); }
    .client-hide-btn {
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textdim);
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 13px;
      line-height: 1;
      transition: border-color 0.15s, color 0.15s;
    }
    .client-hide-btn:hover {
      border-color: var(--accent);
      color: var(--text);
    }
    .client-row-hidden {
      opacity: 0.5;
    }
    .client-row-hidden:hover { opacity: 0.8; }
    .clients-show-hidden {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 12px;
      color: var(--textmid);
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 4px;
      white-space: nowrap;
    }
    .clients-show-hidden input[type="checkbox"] { cursor: pointer; }
    .health-badge {
      font-family: var(--cond);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.09em;
      padding: 3px 8px;
      border-radius: 3px;
    }
    .client-drill {
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .client-drill:hover {
      border-color: var(--accent);
      background: rgba(0,180,216,0.04);
    }
    /* Drill panel */
    .drill-panel {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 460px;
      max-width: 100%;
      background: var(--panel);
      border-left: 1px solid var(--border);
      box-shadow: -4px 0 20px rgba(0,0,0,0.3);
      transform: translateX(100%);
      transition: transform 0.25s cubic-bezier(0.2, 0, 0.2, 1);
      z-index: 1000;
      display: flex;
      flex-direction: column;
    }
    .drill-panel.open { transform: translateX(0); }
    @media (max-width: 600px) {
      .drill-panel { width: 100%; }
    }
    .drill-panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
    }
    .drill-panel-title {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 0.07em;
      color: var(--text);
    }
    .drill-panel-close {
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textmid);
      width: 28px; height: 28px;
      border-radius: 4px;
      font-size: 16px;
      line-height: 1;
    }
    .drill-panel-close:hover { border-color: var(--accent); color: var(--text); }
    .drill-panel-body {
      flex: 1;
      overflow-y: auto;
      padding: 12px 14px;
    }
    .drill-row {
      padding: 9px 10px;
      margin-bottom: 4px;
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .drill-row:hover {
      border-color: var(--accent);
      background: rgba(0,180,216,0.04);
    }
    .drill-row-main {
      display: flex;
      gap: 8px;
      align-items: baseline;
      margin-bottom: 4px;
    }
    .drill-tn {
      font-family: var(--cond);
      font-weight: 700;
      font-size: 12px;
      color: var(--accent);
      flex-shrink: 0;
    }
    .drill-title {
      font-size: 13px;
      color: var(--text);
      line-height: 1.4;
    }
    .drill-row-meta {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      font-size: 11px;
    }
    .drill-pill {
      font-family: var(--cond);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.07em;
      padding: 2px 6px;
      border: 1px solid;
      border-radius: 3px;
    }
    .drill-tech { color: var(--textmid); }
    .drill-age { color: var(--textdim); font-family: var(--cond); font-weight: 700; }
    .drill-empty {
      padding: 20px;
      text-align: center;
      color: var(--textdim);
      font-size: 13px;
    }
  `;
  document.head.appendChild(style);
}

// ─── AI CONTEXT TOGGLES (injected into Preferences card at boot) ─
// ─── CLIENTS NAV + VIEW INJECTION ─────────────────────────────────
function injectClientsViewAndNav() {
  // Inject the view container if not present (renderClientsView writes into #view-clients)
  if (!document.getElementById('view-clients')) {
    // Find the parent of an existing view to put our new view alongside
    const sibling = document.getElementById('view-tickets')
                 || document.getElementById('view-dashboard')
                 || document.getElementById('view-alerts');
    const div = document.createElement('div');
    div.id = 'view-clients';
    div.className = 'view'; // .active class is toggled by setView; CSS in main.css controls display
    if (sibling?.parentNode) {
      sibling.parentNode.appendChild(div);
    } else {
      (document.querySelector('main') || document.body).appendChild(div);
    }
  }
  // Inject the nav button between Tickets and KB
  const tickets = document.querySelector('.nav-item[data-view="tickets"]');
  if (!tickets || document.querySelector('.nav-item[data-view="clients"]')) return;
  // Clone the Tickets nav for identical structural CSS, then replace its label and icon.
  const navItem = tickets.cloneNode(true);
  navItem.dataset.view = 'clients';
  navItem.classList.remove('active');
  // Remove any badge counts that came along with the clone
  navItem.querySelectorAll('.nav-badge, [class*="badge"], [class*="count"]').forEach(el => el.remove());
  // Replace the text node(s). Walk children and find/replace text content.
  const setLabel = (root, label) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue.trim()) { node.nodeValue = label; return true; }
    }
    return false;
  };
  setLabel(navItem, 'CLIENTS');
  // Replace icon — cloned tickets has its own SVG/icon. Replace the first SVG or icon-bearing element.
  const icon = navItem.querySelector('svg, i, [class*="icon"], [class*="lucide"]');
  if (icon) {
    const span = document.createElement('span');
    span.textContent = '👥';
    span.style.cssText = 'font-size:16px;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px';
    icon.parentNode.replaceChild(span, icon);
  }
  navItem.addEventListener('click', () => setView('clients'));
  // Insert after Tickets, before KB if KB exists
  const kb = document.querySelector('.nav-item[data-view="kb"]');
  if (kb && kb.parentNode === tickets.parentNode) {
    tickets.parentNode.insertBefore(navItem, kb);
  } else {
    tickets.parentNode.insertBefore(navItem, tickets.nextSibling);
  }
}

function injectAiContextToggles() {
  if (document.getElementById('aiCtxToggleBlock')) return;
  // Anchor on the Save Preferences button — it's a reliable marker for the prefs card
  const saveBtn = document.getElementById('savePrefsBtn');
  if (!saveBtn) return; // Settings view HTML not present yet — caller will retry later
  const container = saveBtn.parentElement;
  if (!container) return;

  const kbDefault = state.settings.includeKbContext !== false;
  const histDefault = state.settings.includeTicketHistory !== false;

  const block = document.createElement('div');
  block.id = 'aiCtxToggleBlock';
  block.style.cssText = 'margin:14px 0;padding:12px;border:1px solid var(--border);border-radius:6px;background:rgba(0,180,216,0.04)';
  block.innerHTML = `
    <div style="font-family:var(--cond);font-size:11px;font-weight:700;letter-spacing:0.09em;color:var(--textdim);margin-bottom:10px">★ AI CONTEXT ENRICHMENT</div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;font-size:13px">
      <input type="checkbox" id="set-includeKbContext" ${kbDefault?'checked':''} style="cursor:pointer" />
      <span>Include Autotask Knowledge Base in AI analysis</span>
    </label>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;font-size:13px">
      <input type="checkbox" id="set-includeTicketHistory" ${histDefault?'checked':''} style="cursor:pointer" />
      <span>Include client's recent resolved tickets in AI analysis</span>
    </label>
    <div style="display:flex;gap:8px;margin-top:8px">
      <button id="clearAiContextCacheBtn" style="cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:6px 10px;border-radius:4px;font-family:var(--cond);font-size:11px;font-weight:600;letter-spacing:0.07em">↺ CLEAR CONTEXT CACHE</button>
    </div>
    <div id="aiCtxToggleStatus" style="font-family:var(--cond);font-size:11px;min-height:14px;margin-top:6px;color:var(--textdim)"></div>
  `;
  container.insertBefore(block, saveBtn);

  const statusEl = document.getElementById('aiCtxToggleStatus');
  const flash = (msg) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2000);
  };

  document.getElementById('set-includeKbContext')?.addEventListener('change', e => {
    saveSettings({ includeKbContext: !!e.target.checked });
    flash(e.target.checked ? '✓ KB context ON' : '✓ KB context OFF');
  });
  document.getElementById('set-includeTicketHistory')?.addEventListener('change', e => {
    saveSettings({ includeTicketHistory: !!e.target.checked });
    flash(e.target.checked ? '✓ Ticket history ON' : '✓ Ticket history OFF');
  });
  document.getElementById('clearAiContextCacheBtn')?.addEventListener('click', () => {
    state.kbContextCache = {};
    state.historyContextCache = {};
    LS.set('msp_kb_context_cache', {});
    LS.set('msp_history_context_cache', {});
    showToast('✓ AI context cache cleared', 'ok');
    flash('Cache cleared — next AI run will refetch');
  });
}

// ─── BOOT ─────────────────────────────────────────────────────────
async function boot() {
  injectTierAStyles();
  registerSW();
  loadSettings();
  injectAiContextToggles();
  injectClientsViewAndNav();
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
