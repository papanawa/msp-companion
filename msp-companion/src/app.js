// MSP Companion — Main app
import { injectAppStyles } from './styles.js';
import { $, esc, greeting, LS, fmtMsAsDuration, fmtDuration, fmtRelativeTime, fmtBytes, fmtSlaClock, fmtHandoffContent } from './utils.js';
import { init as initDatto, resetDattoToken, clearDeviceCacheEntry, dattoAuth, dattoFetch, fetchDattoDevice, normalizeAlert, fetchAlerts, fetchSites, resolveAlert, fetchAllDattoSites } from './api/datto.js';
import { init as initAt, atFetch } from './api/autotask.js';
import { init as initAI, callAI } from './api/anthropic.js';
import { KB_TTL_MS, HISTORY_TTL_MS, CONTEXT_CACHE_MAX, AI_STOP_WORDS, extractAlertKeywords, pruneContextCache, buildKbContextString, buildHistoryContextString, formatStepNotesForResolution, buildTicketInvestigationSystemPrompt, buildResolutionDraftSystemPrompt, buildKbDraftSystemPrompt, buildTemplateScaffoldSystemPrompt, buildTicketChatSystemPrompt, buildHandoffSystemPrompt, buildIncidentClusterPrompt, renderAIResult } from './ai/prompts.js';

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
  templates: {},                      // { templateId: { name, steps, ... } } reusable investigation patterns
  currentView: 'dashboard', currentAlert: null, currentTicket: null,
  alertFilter: 'all', alertClient: 'all', settings: {},
  incidents: {},                      // { incidentId: { id, title, alertUids[], createdAt, source, ticketNumber?, expanded? } }
  alertSelectMode: false,             // toggled when multi-selecting alerts to create an incident
  alertSelected: new Set(),           // alertUids currently selected
  ticketShowStale: false,
  reportsRange: 30, reportsResolvedTickets: null, reportsResolvedAlerts: null,
  criticalPromptSnoozes: {},          // alertUid → snoozedUntilMs
  criticalPromptDismissed: new Set(), // alertUids permanently dismissed for this session
  criticalScanTimer: null,
  lastHandoff: null,                  // { generatedAtMs, generatedBy, hours, content, techNotes }
  clients: null,                      // unified client list (AT companies + Datto sites)
  hiddenClients: new Set(),           // client names hidden from the list
  showHiddenClients: false,           // toggle to reveal hidden clients
  currentClient: null,                // currently-viewed client object
  clientDevicesCache: {},             // siteUid → { devices, fetchedAt }
  clientResolvedCache: null,          // { items, fetchedAt } — resolved tickets last 14d
  drillPanel: null,                   // active drill-down panel state
  pendingTicketEdits: {},             // ticketId → { field: newValue } for unsaved field changes
  autoRefreshTimer: null,
};

const SEV = {
  Critical:    { color: '#c8102e', bg: 'rgba(200,16,46,0.12)',  rank: 1 },
  High:        { color: '#e07b00', bg: 'rgba(224,123,0,0.12)',  rank: 2 },
  Moderate:    { color: '#c8a000', bg: 'rgba(200,160,0,0.12)',  rank: 3 },
  Low:         { color: '#2a9d5c', bg: 'rgba(42,157,92,0.12)',  rank: 4 },
  Information: { color: '#5a7a96', bg: 'rgba(90,122,150,0.12)', rank: 5 },
};

const DONE_LABELS = new Set(['complete','completed','closed','resolved','denied','cancelled','canceled']);

// ─── UTILS ────────────────────────────────────────────────────────
// Pure helpers ($, esc, greeting, LS, formatters) live in utils.js — imported above.

function showToast(msg, type='info') {
  const t = $('toast'); if (!t) return;
  t.textContent = msg;
  t.style.borderColor = type==='ok' ? 'rgba(42,157,92,0.5)' : type==='err' ? 'rgba(200,16,46,0.5)' : 'var(--border)';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── LOCAL STORAGE ────────────────────────────────────────────────
// LS.get / LS.set are imported from utils.js

// ─── SETTINGS ─────────────────────────────────────────────────────
function loadSettings() {
  state.settings      = LS.get('msp_settings', {});
  state.resolvedIds   = new Set(LS.get('msp_resolved', []));
  state.snoozedIds    = new Set(LS.get('msp_snoozed', []));
  state.excludedClients    = new Set(LS.get('msp_excluded', []));
  state.psaExcludedClients = new Set(LS.get('msp_psa_excluded', []));
  state.hiddenClients = new Set(LS.get('msp_hidden_clients', []));
  state.notesDrafts   = LS.get('msp_notes', {});
  state.incidents     = LS.get('msp_incidents', {});
  state.aiResults     = LS.get('msp_ai', {});
  state.chatHistories = LS.get('msp_chats', {});
  state.ticketChatHistories = LS.get('msp_ticket_chats', {});
  state.kbContextCache      = LS.get('msp_kb_context_cache', {});
  state.historyContextCache = LS.get('msp_history_context_cache', {});
  state.investigations      = LS.get('msp_investigations', {});
  state.criticalPromptSnoozes = LS.get('msp_critical_snoozes', {});
  state.lastHandoff = LS.get('msp_last_handoff', null);
  state.templates           = LS.get('msp_templates', {});
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


// ─── DATTO RMM API — moved to api/datto.js ──────────────────────
// dattoAuth, dattoFetch, fetchDattoDevice, normalizeAlert,
// fetchAlerts, fetchSites, resolveAlert, fetchAllDattoSites

// ─── AUTOTASK API — moved to api/autotask.js ─────────────────────
// atHeaders, atFetch

// ─── ANTHROPIC AI — moved to api/anthropic.js ────────────────────
// callAI

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
  // AT REST v1.0: use top-level /TicketNotes/query with ticketID filter.
  try {
    const data = await atFetch('/TicketNotes/query', 'POST', {
      MaxRecords: 10,
      filter: [{ op: 'eq', field: 'ticketID', value: parseInt(ticketId) }],
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
  if (!ticketNumbers?.length) return { droppedGhosts: [] };
  const pl = await loadAtStatusPicklist();
  const chunks = [];
  for (let i = 0; i < ticketNumbers.length; i += 50) chunks.push(ticketNumbers.slice(i, i+50));
  const seenInAt = new Set();
  for (const chunk of chunks) {
    try {
      const data = await atFetch('/Tickets/query', 'POST', {
        filter: [{ op:'in', field:'ticketNumber', value:chunk }],
        IncludeFields: ['id','ticketNumber','status','title','priority','queueID','assignedResourceID','billingCodeID','lastActivityDate','companyID'],
      });
      // Build company name map from alerts
      const companyIds2 = (data?.items||[]).map(t=>t.companyID).filter(Boolean);
      await loadAtCompanyNames(companyIds2);
      const companyNameMap = buildCompanyNameMap();
      (data?.items || []).forEach(t => {
        seenInAt.add(t.ticketNumber);
        const si = pl[t.status] || { label:`Status ${t.status}`, color:'#8bacc8', done:false };
        state.tickets[t.ticketNumber] = {
          id: t.id, ticketNumber: t.ticketNumber,
          status: t.status, statusLabel: si.label, statusColor: si.color, isDone: si.done,
          priority: t.priority, queueID: t.queueID, billingCodeID: t.billingCodeID,
          title: t.title, companyID: t.companyID, companyName: companyNameMap[t.companyID] || null,
          assignedResourceID: t.assignedResourceID, assignedResourceName: null,
          lastActivity: t.lastActivityDate,
        };
      });
    } catch(e) { console.warn('Ticket sync chunk failed:', e.message); }
  }
  // Identify and drop ghost tickets — ones we asked AT about but AT didn't return
  const droppedGhosts = [];
  ticketNumbers.forEach(tn => {
    if (!seenInAt.has(tn) && state.tickets[tn]) {
      droppedGhosts.push(tn);
      delete state.tickets[tn];
      // Also unlink any alerts that pointed to this ghost
      state.alerts.forEach(a => { if (a.ticketNumber === tn) a.ticketNumber = null; });
    }
  });
  if (droppedGhosts.length) {
    LS.set('msp_alerts', state.alerts);
    console.warn(`Dropped ${droppedGhosts.length} ghost tickets no longer in AT:`, droppedGhosts);
  }
  LS.set('msp_tickets', state.tickets);
  return { droppedGhosts };
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
  const data = await atFetch('/Tickets/query','POST',{
    MaxRecords: 500,
    filter,
    IncludeFields: ['id','ticketNumber','status','title','priority','queueID','assignedResourceID','billingCodeID','companyID','lastActivityDate','createDate'],
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
    console.warn('AT create ticket — unexpected response shape:', data);
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

// Batch version: patches multiple fields in one API call.
// edits = { fieldName: rawValue, ... }
async function patchTicketFields(ticket, edits) {
  const fieldNames = Object.keys(edits);
  if (!fieldNames.length) return [];

  const body = { id: parseInt(ticket.id) };
  let resolvedRoleId = null;

  // Normalize each field's value into the body
  for (const field of fieldNames) {
    let value = edits[field];
    if (value === '' || value === 'null') value = null;
    else if (['status','priority','queueID','assignedResourceID','billingCodeID'].includes(field) && value !== null) value = parseInt(value);

    if (field === 'assignedResourceID') {
      if (value === null) {
        body.assignedResourceID = null;
        body.assignedResourceRoleID = null;
      } else {
        await loadAtResources();
        const r = state.atResources.find(r => r.id === value);
        resolvedRoleId = r?.defaultRoleID || null;
        if (!resolvedRoleId) {
          try {
            const fresh = await atFetch(`/Resources/${value}`);
            resolvedRoleId = (fresh?.item || fresh)?.defaultServiceDeskRoleID || null;
          } catch(e) { /* ignore */ }
        }
        if (!resolvedRoleId) {
          await loadAtRoles();
          resolvedRoleId = findFallbackServiceDeskRoleId();
          if (resolvedRoleId) console.warn(`No default role for resource ${value}, using fallback ${resolvedRoleId}.`);
        }
        if (!resolvedRoleId) {
          throw new Error('Cannot assign resource — no role available.');
        }
        body.assignedResourceID = value;
        body.assignedResourceRoleID = resolvedRoleId;
      }
    } else {
      body[field] = value;
    }
  }

  await atFetch('/Tickets', 'PATCH', body);

  // Mirror to local state for each field
  const changedSummary = [];
  for (const field of fieldNames) {
    let value = edits[field];
    if (value === '' || value === 'null') value = null;
    else if (['status','priority','queueID','assignedResourceID','billingCodeID'].includes(field) && value !== null) value = parseInt(value);

    ticket[field] = value;
    if (field === 'status') {
      const pl = state.atStatusPicklist || {};
      const si = pl[value] || { label:`Status ${value}`, color:'#8bacc8', done:false };
      ticket.statusLabel = si.label;
      ticket.statusColor = si.color;
      ticket.isDone = si.done;
      changedSummary.push(`status → ${si.label}`);
    } else if (field === 'priority') {
      const pl = state.atPriorityPicklist || {};
      changedSummary.push(`priority → ${pl[value]?.label || value}`);
    } else if (field === 'queueID') {
      const q = state.atQueues?.find(q => q.id === value);
      changedSummary.push(`queue → ${q?.name || (value ? `#${value}` : 'none')}`);
    } else if (field === 'assignedResourceID') {
      const r = state.atResources.find(r => r.id === value);
      ticket.assignedResourceName = r ? r.name : null;
      ticket.assignedResourceRoleID = resolvedRoleId;
      changedSummary.push(`resource → ${r?.name || 'unassigned'}`);
    } else if (field === 'billingCodeID') {
      const b = state.atBillingCodes.find(b => b.id === value);
      changedSummary.push(`work type → ${b?.name || (value ? `#${value}` : 'none')}`);
    }
  }
  state.tickets[ticket.ticketNumber] = ticket;
  LS.set('msp_tickets', state.tickets);
  return changedSummary;
}

// Updates the visibility and contents of the ticket field save bar based on pending edits.
function updateTicketSaveBar(ticketId) {
  const bar = document.getElementById(`ticketSaveBar-${ticketId}`);
  const summary = document.getElementById(`ticketSaveSummary-${ticketId}`);
  if (!bar || !summary) return;
  const pending = state.pendingTicketEdits[ticketId];
  const fieldCount = pending ? Object.keys(pending).length : 0;
  if (!fieldCount) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  summary.textContent = `${fieldCount} unsaved change${fieldCount !== 1 ? 's' : ''}`;
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

// ─── AI CONTEXT ENRICHMENT ────────────────────────────────────────
// Caches (TTLs vary: KB articles change slowly, ticket history moves faster)

// ─── AI PROMPT BUILDERS & HELPERS — moved to ai/prompts.js ─────
// extractAlertKeywords, pruneContextCache, buildKbContextString,
// buildHistoryContextString, formatStepNotesForResolution,
// buildTicketInvestigationSystemPrompt, buildResolutionDraftSystemPrompt,
// buildKbDraftSystemPrompt, buildTemplateScaffoldSystemPrompt,
// buildTicketChatSystemPrompt, buildHandoffSystemPrompt,
// buildIncidentClusterPrompt, renderAIResult


// ─── COMPLIANCE — DEVICE FETCH ─────────────────────────────────────
const COMPLIANCE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
state.complianceCache = null;
state.complianceShowWarranty = false;

async function fetchAllDevices(forceRefresh = false) {
  if (!forceRefresh && state.complianceCache &&
      (Date.now() - state.complianceCache.fetchedAt) < COMPLIANCE_CACHE_TTL) {
    return state.complianceCache.devices;
  }
  const allDevices = [];
  let page = 0;
  while (true) {
    const data = await dattoFetch(`/account/devices?max=250&page=${page}`);
    const items = data.devices || data.items || [];
    allDevices.push(...items);
    if (!data.pageDetails?.nextPage) break;
    if (++page > 40) break;
  }
  state.complianceCache = { devices: allDevices, fetchedAt: Date.now() };
  return allDevices;
}

function getDeviceComplianceStatus(d, warrantyOn = false) {
  const issues = [];
  // Software compliance
  const sw = (d.softwareStatus || '').toLowerCase();
  if (sw === 'noncompliant') issues.push({ type: 'software', label: 'Non-Compliant Software', color: '#c8102e' });
  else if (sw === 'unmanaged')  issues.push({ type: 'software', label: 'Unmanaged', color: '#c8960c' });
  // Patch management
  const pm = d.patchManagement || {};
  if (pm.patchStatus === 'PatchesApprovedAndPending')
    issues.push({ type: 'patch', label: `${pm.patchesApprovedPending || 0} Patches Pending`, color: '#c8960c' });
  else if (pm.patchStatus === 'NotFullyPatched' || pm.patchStatus === 'Failed')
    issues.push({ type: 'patch', label: 'Not Fully Patched', color: '#c8102e' });
  // Antivirus
  const av = (d.antivirus?.antivirusStatus || '').toLowerCase();
  if (av && av !== 'runninganduptodate') {
    const avLabel = av === 'notrunning' ? 'AV Not Running'
      : av === 'notinstalled' ? 'AV Not Installed'
      : av === 'disabled' ? 'AV Disabled'
      : 'AV Issue';
    issues.push({ type: 'av', label: avLabel, color: '#c8102e' });
  }
  // Reboot required
  if (d.rebootRequired) issues.push({ type: 'reboot', label: 'Reboot Required', color: '#e07b00' });
  // Warranty (only shown when warrantyOn toggle is active)
  if (warrantyOn && d.warrantyDate) {
    const exp = new Date(d.warrantyDate);
    const daysLeft = Math.floor((exp - Date.now()) / 86400000);
    if (daysLeft < 0)   issues.push({ type: 'warranty', label: 'Warranty Expired', color: '#c8102e' });
    else if (daysLeft < 90) issues.push({ type: 'warranty', label: `Warranty Exp. ${exp.toLocaleDateString()}`, color: '#c8960c' });
  }
  return issues;
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

// Find a ticket by its numeric id. Falls back to state.currentTicket when the
// ticket isn't in state.tickets (e.g. tickets dropped from cache by status filter,
// or opened from a drill-down with a stale reference).
function findTicketById(ticketId) {
  const idStr = String(ticketId);
  const fromCache = Object.values(state.tickets).find(t => String(t.id) === idStr);
  if (fromCache) return fromCache;
  if (state.currentTicket && String(state.currentTicket.id) === idStr) return state.currentTicket;
  return null;
}

function setInvestigation(ticketId, inv) {
  const key = String(ticketId);
  state.investigations[key] = inv;
  saveInvestigations();
}

// ─── TIME-ON-TICKET TRACKING ──────────────────────────────────────
const MAX_SESSION_MS = 4 * 3600000; // Auto-stop a session after 4 uninterrupted hours

// state-level — only one timer can be active at a time (the currently-viewed ticket)
state.activeTimer = null;       // { ticketId, startedMs } — running session
state.pausedTimer = null;       // { ticketId, accumulatedMs } — paused session, preserves time so far

function getOrInitTimeTracking(inv) {
  if (!inv.timeTracking) {
    inv.timeTracking = { sessions: [], totalMs: 0, technicians: {} };
  }
  if (!inv.timeTracking.technicians) inv.timeTracking.technicians = {};
  return inv.timeTracking;
}

function startTicketTimer(ticketId) {
  if (!ticketId) return;
  const idStr = String(ticketId);
  // If a different ticket has an active or paused timer, stop it first
  if (state.activeTimer && state.activeTimer.ticketId !== idStr) {
    stopTicketTimer();
  }
  if (state.pausedTimer && state.pausedTimer.ticketId !== idStr) {
    // Different ticket was paused — commit it as a closed session
    commitPausedTimer();
  }
  if (state.activeTimer && state.activeTimer.ticketId === idStr) return; // already running
  const inv = getInvestigation(ticketId);
  if (!inv) return; // No investigation = no timer
  // Resume from paused state if applicable, otherwise fresh start
  if (state.pausedTimer && state.pausedTimer.ticketId === idStr) {
    state.activeTimer = {
      ticketId: idStr,
      startedMs: Date.now(),
      accumulatedMs: state.pausedTimer.accumulatedMs || 0,
    };
    state.pausedTimer = null;
  } else {
    state.activeTimer = { ticketId: idStr, startedMs: Date.now(), accumulatedMs: 0 };
  }
  // Tick the display once a minute while running
  if (state._timerTickInterval) clearInterval(state._timerTickInterval);
  state._timerTickInterval = setInterval(() => {
    if (!state.activeTimer) { clearInterval(state._timerTickInterval); state._timerTickInterval = null; return; }
    // 4-hour session cap — auto-stop and toast the user so they know
    if (Date.now() - state.activeTimer.startedMs >= MAX_SESSION_MS) {
      const cappedTicketId = state.activeTimer.ticketId;
      stopTicketTimer();
      showToast(`⏱ Auto-stopped timer at 4h on ticket ${cappedTicketId} — assumed forgotten`, 'info');
      // Re-render the investigation card to update the badge
      if (state.currentTicket && String(state.currentTicket.id) === cappedTicketId) {
        renderTicketDetail(state.currentTicket);
      }
      return;
    }
    const display = document.getElementById(`invTimeDisplay-${state.activeTimer.ticketId}`);
    if (display) display.textContent = fmtMsAsDuration(getInvestigationTotalMs(state.activeTimer.ticketId));
  }, 60000);
}

function pauseTicketTimer() {
  if (!state.activeTimer) return;
  const { ticketId, startedMs, accumulatedMs } = state.activeTimer;
  const sessionMs = Date.now() - startedMs;
  const total = (accumulatedMs || 0) + sessionMs;
  state.pausedTimer = { ticketId, accumulatedMs: total };
  state.activeTimer = null;
  if (state._timerTickInterval) { clearInterval(state._timerTickInterval); state._timerTickInterval = null; }
  // Re-render to swap badge to paused state
  if (state.currentTicket && String(state.currentTicket.id) === ticketId) {
    renderTicketDetail(state.currentTicket);
  }
}

// Commit a paused timer's accumulated time as a session (called when leaving the ticket without resuming)
function commitPausedTimer() {
  if (!state.pausedTimer) return;
  const { ticketId, accumulatedMs } = state.pausedTimer;
  state.pausedTimer = null;
  if (accumulatedMs < 5000) return;
  const inv = getInvestigation(ticketId);
  if (!inv) return;
  const tt = getOrInitTimeTracking(inv);
  const techName = getMyResourceName();
  const endedMs = Date.now();
  tt.sessions.push({ startMs: endedMs - accumulatedMs, endMs: endedMs, durationMs: accumulatedMs, tech: techName });
  tt.totalMs = (tt.totalMs || 0) + accumulatedMs;
  tt.technicians[techName] = (tt.technicians[techName] || 0) + accumulatedMs;
  setInvestigation(ticketId, inv);
}

function stopTicketTimer() {
  if (state._timerTickInterval) { clearInterval(state._timerTickInterval); state._timerTickInterval = null; }
  // If paused, commit and clear
  if (state.pausedTimer) {
    commitPausedTimer();
    return;
  }
  if (!state.activeTimer) return;
  const { ticketId, startedMs, accumulatedMs } = state.activeTimer;
  const endedMs = Date.now();
  const sessionMs = endedMs - startedMs;
  const totalDuration = (accumulatedMs || 0) + sessionMs;
  state.activeTimer = null;
  if (totalDuration < 5000) return; // ignore sub-5-second sessions
  const inv = getInvestigation(ticketId);
  if (!inv) return;
  const tt = getOrInitTimeTracking(inv);
  const techName = getMyResourceName();
  tt.sessions.push({ startMs: endedMs - totalDuration, endMs: endedMs, durationMs: totalDuration, tech: techName });
  tt.totalMs = (tt.totalMs || 0) + totalDuration;
  tt.technicians[techName] = (tt.technicians[techName] || 0) + totalDuration;
  setInvestigation(ticketId, inv);
}

function getCurrentSessionMs() {
  if (state.activeTimer) {
    return (state.activeTimer.accumulatedMs || 0) + (Date.now() - state.activeTimer.startedMs);
  }
  if (state.pausedTimer) return state.pausedTimer.accumulatedMs || 0;
  return 0;
}

function isTimerActiveFor(ticketId) {
  return state.activeTimer?.ticketId === String(ticketId);
}

function isTimerPausedFor(ticketId) {
  return state.pausedTimer?.ticketId === String(ticketId);
}

function getInvestigationTotalMs(ticketId) {
  const inv = getInvestigation(ticketId);
  if (!inv?.timeTracking) {
    // No saved sessions yet — but live timer might be running on this ticket
    if (isTimerActiveFor(ticketId) || isTimerPausedFor(ticketId)) {
      return getCurrentSessionMs();
    }
    return 0;
  }
  let total = inv.timeTracking.totalMs || 0;
  // Add live session time if this ticket has the active or paused timer
  if (isTimerActiveFor(ticketId) || isTimerPausedFor(ticketId)) {
    total += getCurrentSessionMs();
  }
  return total;
}

function newStepId() { return 's-' + Math.random().toString(36).slice(2, 10); }

async function fetchAtTicketFull(ticketId) {
  try {
    const data = await atFetch(`/Tickets/${ticketId}`);
    return data?.item || data || null;
  } catch(e) { console.warn('Ticket fetch failed:', e.message); return null; }
}

async function fetchAtTicketNotes(ticketId) {
  // AT REST v1.0 does not support child-collection POST query (/Tickets/{id}/Notes/query).
  // Correct pattern: top-level /TicketNotes/query with a ticketID filter.
  try {
    const data = await atFetch('/TicketNotes/query', 'POST', {
      MaxRecords: 10,
      filter: [{ op: 'eq', field: 'ticketID', value: parseInt(ticketId) }],
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
    verification: String(p.verification || '').trim(),
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

// ─── INVESTIGATION TEMPLATES ──────────────────────────────────────
function newTemplateId() { return 'tpl-' + Math.random().toString(36).slice(2, 10); }

function saveTemplates() { LS.set('msp_templates', state.templates); }

function getTemplate(id) {
  return state.templates[id] || null;
}

function getMyResourceName() {
  const id = state.settings.myResourceID;
  if (!id) return 'Unknown';
  const r = state.atResources.find(r => r.id === parseInt(id));
  return r?.name || 'Unknown';
}

// Convert an investigation into a template by stripping per-instance data.
function buildTemplateFromInvestigation(inv, ticket, opts = {}) {
  const steps = (inv.steps || []).map(s => ({
    text: (s.text || '').trim(),
    verification: (s.verification || '').trim(),
  })).filter(s => s.text);
  if (!steps.length) throw new Error('Investigation has no steps to save as template');
  return {
    id: newTemplateId(),
    name: opts.name || `${ticket?.title?.substring(0, 60) || 'Untitled template'}`,
    description: opts.description || '',
    steps,
    tags: opts.tags || [],
    isPublic: opts.isPublic !== false,
    createdBy: getMyResourceName(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sourceTicketId: ticket?.id || null,
    usageCount: 0,
    version: 1,
  };
}

function saveTemplate(template) {
  state.templates[template.id] = template;
  saveTemplates();
  return template;
}

function deleteTemplate(id) {
  if (state.templates[id]) {
    delete state.templates[id];
    saveTemplates();
  }
}

// Update an existing template (bumps version, updatedAt).
function updateTemplate(id, changes) {
  const t = state.templates[id];
  if (!t) return null;
  Object.assign(t, changes, {
    updatedAt: Date.now(),
    version: (t.version || 1) + 1,
  });
  saveTemplates();
  return t;
}

// Apply a template to a ticket — produces a fresh investigation with template steps as the plan.
function applyTemplateToTicket(template, ticket) {
  const t = template;
  // Bump usage
  t.usageCount = (t.usageCount || 0) + 1;
  saveTemplates();
  const inv = {
    analysis: {
      understanding: `Applied template: ${t.name}${t.description ? ' — ' + t.description : ''}`,
      confidence: 0,
      relevantContext: t.tags?.length ? [`Template tags: ${t.tags.join(', ')}`] : [],
    },
    steps: t.steps.map(s => ({
      id: newStepId(),
      text: s.text,
      verification: s.verification || '',
      done: false,
      notes: '',
      minutes: 0,
    })),
    techContext: '',
    appliedTemplateId: t.id,
    // Snapshot of the original template steps — used later to detect changes
    appliedTemplateSnapshot: t.steps.map(s => ({ text: s.text, verification: s.verification || '' })),
    lastAnalyzedAt: Date.now(),
  };
  setInvestigation(ticket.id, inv);
  return inv;
}

// Score a template's relevance to a ticket — used for auto-suggestions.
function scoreTemplateForTicket(template, ticket) {
  if (!ticket) return 0;
  const titleWords = (ticket.title || '').toLowerCase().split(/\W+/).filter(w => w.length >= 4);
  const tagSet = new Set((template.tags || []).map(t => t.toLowerCase()));
  let score = 0;
  // Tag overlap with ticket title keywords
  titleWords.forEach(w => { if (tagSet.has(w)) score += 3; });
  // Linked alert's monitor type matching tags
  const linkedAlert = findLinkedAlertForTicket(ticket);
  if (linkedAlert) {
    const monitor = (linkedAlert.monitorType || '').toLowerCase();
    tagSet.forEach(tag => { if (monitor.includes(tag) || tag.includes(monitor)) score += 5; });
  }
  // Template name overlap with ticket title
  const tplWords = (template.name || '').toLowerCase().split(/\W+/).filter(w => w.length >= 4);
  const titleSet = new Set(titleWords);
  tplWords.forEach(w => { if (titleSet.has(w)) score += 2; });
  // Lightly favor frequently-used templates
  score += Math.min(template.usageCount || 0, 5) * 0.5;
  return score;
}

function suggestTemplatesForTicket(ticket, limit = 3, minScore = 4) {
  if (!ticket) return [];
  const myName = getMyResourceName();
  const candidates = Object.values(state.templates)
    .filter(t => t.isPublic !== false || t.createdBy === myName) // private only visible to creator
    .map(t => ({ template: t, score: scoreTemplateForTicket(t, ticket) }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return candidates.map(c => c.template);
}

function getVisibleTemplatesForUser() {
  const myName = getMyResourceName();
  return Object.values(state.templates)
    .filter(t => t.isPublic !== false || t.createdBy === myName)
    .sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0) || a.name.localeCompare(b.name));
}

// Detect if the current investigation has diverged from its applied template.
function detectTemplateDrift(inv) {
  if (!inv?.appliedTemplateId || !inv.appliedTemplateSnapshot) return null;
  const tpl = state.templates[inv.appliedTemplateId];
  if (!tpl) return null; // template was deleted; nothing to update
  const snapshot = inv.appliedTemplateSnapshot;
  const current = (inv.steps || []).map(s => ({
    text: (s.text || '').trim(),
    verification: (s.verification || '').trim(),
  }));
  // Compute simple diff
  const added = [];
  const modified = [];
  const removedTexts = [];

  // Check for added/modified
  current.forEach((cur, i) => {
    const orig = snapshot[i];
    if (!orig) {
      added.push(cur);
    } else if (orig.text !== cur.text || orig.verification !== cur.verification) {
      modified.push({ from: orig, to: cur, idx: i });
    }
  });
  // Snapshot longer than current = removed
  if (snapshot.length > current.length) {
    for (let i = current.length; i < snapshot.length; i++) {
      removedTexts.push(snapshot[i]);
    }
  }
  if (!added.length && !modified.length && !removedTexts.length) return null;
  return { template: tpl, added, modified, removed: removedTexts, currentSteps: current };
}

// Auto-suggest tags for a new template based on the ticket and steps.
function suggestTagsForTemplate(ticket, steps) {
  const tags = new Set();
  const linkedAlert = ticket ? findLinkedAlertForTicket(ticket) : null;
  if (linkedAlert?.monitorType) {
    linkedAlert.monitorType.toLowerCase().split(/[\s_-]+/).forEach(w => {
      if (w.length >= 3) tags.add(w);
    });
  }
  // Mine the steps for common keywords
  const KEYWORDS = ['disk','cleanup','dhcp','dns','dc','restart','service','backup','veeam','windows','update','patch','restart','reboot','memory','cpu','network','vpn','printer','firewall','sql','exchange','m365','office','anti?virus','av','printer','offline','online','event','log'];
  const allText = steps.map(s => (s.text + ' ' + (s.verification || '')).toLowerCase()).join(' ');
  KEYWORDS.forEach(kw => {
    const re = new RegExp(`\\b${kw}\\b`, 'i');
    if (re.test(allText)) tags.add(kw.replace('?', ''));
  });
  return [...tags].slice(0, 6);
}

// ─── TEMPLATE MODALS ──────────────────────────────────────────────
function showSaveTemplateModal(ticket, inv) {
  const suggestedTags = suggestTagsForTemplate(ticket, inv.steps || []);
  const defaultName = ticket?.title?.substring(0, 80) || 'Untitled template';
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:560px;margin:auto">
    <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px">💾 Save as Template</div>
    <div style="font-size:12px;color:var(--textdim);margin-bottom:14px">Saving ${(inv.steps || []).length} steps. Per-instance data (notes, done state, minutes) is stripped — only step text and verification criteria are kept.</div>

    <label class="tpl-modal-label">NAME</label>
    <input id="tplModalName" type="text" class="tpl-modal-input" maxlength="120" value="${esc(defaultName)}" placeholder="Disk Space Cleanup — Windows Server" />

    <label class="tpl-modal-label">DESCRIPTION (optional)</label>
    <textarea id="tplModalDesc" class="tpl-modal-input" rows="2" placeholder="When to use this template — what symptoms or alert types it applies to."></textarea>

    <label class="tpl-modal-label">TAGS (comma-separated, used for search and auto-suggestion)</label>
    <input id="tplModalTags" type="text" class="tpl-modal-input" value="${esc(suggestedTags.join(', '))}" placeholder="disk, cleanup, windows" />

    <div style="display:flex;align-items:center;gap:8px;margin:14px 0 4px">
      <input type="checkbox" id="tplModalPublic" checked style="cursor:pointer" />
      <label for="tplModalPublic" style="cursor:pointer;font-size:13px">Public — visible to all techs</label>
    </div>
    <div style="font-size:11px;color:var(--textdim);margin-bottom:14px">Uncheck to keep this template private to you. Default is public so the team benefits.</div>

    <div style="display:flex;gap:8px">
      <button id="tplSaveBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">✓ SAVE TEMPLATE</button>
      <button id="tplCancelBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  document.getElementById('tplModalName').focus();

  const close = () => document.body.removeChild(modal);
  document.getElementById('tplCancelBtn').addEventListener('click', close);
  document.getElementById('tplSaveBtn').addEventListener('click', () => {
    const name = document.getElementById('tplModalName').value.trim();
    const description = document.getElementById('tplModalDesc').value.trim();
    const tagsRaw = document.getElementById('tplModalTags').value.trim();
    const tags = tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    const isPublic = document.getElementById('tplModalPublic').checked;
    if (!name) {
      showToast('Template needs a name', 'info');
      return;
    }
    try {
      const tpl = buildTemplateFromInvestigation(inv, ticket, { name, description, tags, isPublic });
      saveTemplate(tpl);
      close();
      showToast(`✓ Saved template — "${tpl.name}"`, 'ok');
    } catch(err) {
      showToast(`Save failed: ${err.message}`, 'err');
    }
  });
}

function showTemplatePickerModal(ticket) {
  const templates = getVisibleTemplatesForUser();
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';

  if (!templates.length) {
    modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:480px;margin:auto">
      <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px">📋 Templates</div>
      <div style="font-size:13px;color:var(--textmid);margin-bottom:14px">No templates saved yet. You can either save one from a worked investigation, or author one from scratch right now.</div>
      <div style="display:flex;gap:8px">
        <button id="tplPickerCreateNewBtn" style="cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px 18px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">+ Create Template</button>
        <button id="tplPickerCloseBtn" style="cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px 18px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Close</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    const close = () => document.body.removeChild(modal);
    document.getElementById('tplPickerCloseBtn').addEventListener('click', close);
    document.getElementById('tplPickerCreateNewBtn').addEventListener('click', () => {
      close();
      showTemplateEditorModal(null, ticket);
    });
    return;
  }

  const myName = getMyResourceName();
  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:680px;margin:auto">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
      <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em">📋 Templates</div>
      <button id="tplPickerCreateNewBtn" class="abtn abtn-post" style="font-size:11px;padding:6px 12px">+ Create New Template</button>
    </div>
    <div style="font-size:12px;color:var(--textdim);margin-bottom:14px">${templates.length} template${templates.length!==1?'s':''} available. Applying populates the investigation plan — you can still edit before starting work.</div>
    <input id="tplPickerSearch" type="text" class="tpl-modal-input" placeholder="Filter templates..." style="margin-bottom:12px" />
    <div id="tplPickerList" style="max-height:60vh;overflow-y:auto;margin-bottom:14px">
      ${templates.map(t => `
        <div class="tpl-picker-row" data-template-id="${esc(t.id)}">
          <div class="tpl-picker-main">
            <div class="tpl-picker-name">
              ${esc(t.name)}
              ${t.isPublic === false ? `<span class="tpl-private-pill">private</span>` : ''}
              ${t.createdBy === myName ? `<span class="tpl-mine-pill">yours</span>` : ''}
            </div>
            ${t.description ? `<div class="tpl-picker-desc">${esc(t.description)}</div>` : ''}
            <div class="tpl-picker-meta">
              <span>${t.steps.length} steps</span>
              ${t.usageCount ? `<span>· used ${t.usageCount}×</span>` : ''}
              ${t.tags?.length ? `<span>· ${esc(t.tags.join(', '))}</span>` : ''}
              <span class="tpl-picker-author">· by ${esc(t.createdBy || 'unknown')}</span>
            </div>
          </div>
          <div class="tpl-picker-actions">
            <button class="abtn abtn-ai" data-action="apply-template" data-template-id="${esc(t.id)}" data-ticket-id="${ticket.id}">Apply</button>
            <button class="abtn abtn-ghost" data-action="edit-template" data-template-id="${esc(t.id)}" title="Edit this template" style="font-size:11px;padding:5px 10px">Edit</button>
            <button class="tpl-delete-btn" data-action="delete-template" data-template-id="${esc(t.id)}" title="Delete template">×</button>
          </div>
        </div>
      `).join('')}
    </div>
    <button id="tplPickerCloseBtn" style="cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px 18px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Close</button>
  </div>`;
  document.body.appendChild(modal);

  // Wire close
  const closeFn = () => { if (document.body.contains(modal)) document.body.removeChild(modal); };
  document.getElementById('tplPickerCloseBtn').addEventListener('click', closeFn);
  modal._closeFn = closeFn;

  // Wire Create New
  document.getElementById('tplPickerCreateNewBtn').addEventListener('click', () => {
    closeFn();
    showTemplateEditorModal(null, ticket);
  });

  // Filter
  document.getElementById('tplPickerSearch').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    const rows = modal.querySelectorAll('.tpl-picker-row');
    rows.forEach(r => {
      const tplId = r.dataset.templateId;
      const t = state.templates[tplId];
      if (!t) { r.style.display = 'none'; return; }
      const haystack = [t.name, t.description || '', ...(t.tags || [])].join(' ').toLowerCase();
      r.style.display = (q === '' || haystack.includes(q)) ? '' : 'none';
    });
  });
  document.getElementById('tplPickerSearch').focus();
}

function showTemplateDriftModal(drift, inv, ticket) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  const tpl = drift.template;
  const summaryParts = [];
  if (drift.added.length) summaryParts.push(`${drift.added.length} step${drift.added.length!==1?'s':''} added`);
  if (drift.modified.length) summaryParts.push(`${drift.modified.length} edited`);
  if (drift.removed.length) summaryParts.push(`${drift.removed.length} removed`);

  const addedHtml = drift.added.map(s => `<li>${esc(s.text)}${s.verification?` <em style="color:var(--textdim)">(${esc(s.verification)})</em>`:''}</li>`).join('');
  const modifiedHtml = drift.modified.map(m => `<li>Step ${m.idx+1}: <span style="text-decoration:line-through;color:var(--textdim)">${esc(m.from.text)}</span> → ${esc(m.to.text)}</li>`).join('');
  const removedHtml = drift.removed.map(s => `<li style="color:var(--textdim)"><s>${esc(s.text)}</s></li>`).join('');

  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:600px;margin:auto">
    <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px">📋 Update Template?</div>
    <div style="font-size:13px;color:var(--textmid);margin-bottom:14px">You modified the <strong>${esc(tpl.name)}</strong> template during this investigation (${summaryParts.join(', ')}). Apply your changes back to the template so the next tech benefits?</div>
    ${drift.added.length ? `<div class="tpl-drift-section"><div class="tpl-drift-label" style="color:#2a9d5c">+ ADDED</div><ul>${addedHtml}</ul></div>` : ''}
    ${drift.modified.length ? `<div class="tpl-drift-section"><div class="tpl-drift-label" style="color:#c8a000">~ EDITED</div><ul>${modifiedHtml}</ul></div>` : ''}
    ${drift.removed.length ? `<div class="tpl-drift-section"><div class="tpl-drift-label" style="color:#c8102e">− REMOVED</div><ul>${removedHtml}</ul></div>` : ''}
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="tplDriftUpdateBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">✓ Update Template</button>
      <button id="tplDriftSkipBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Keep As-Is</button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  const close = () => document.body.removeChild(modal);
  document.getElementById('tplDriftSkipBtn').addEventListener('click', close);
  document.getElementById('tplDriftUpdateBtn').addEventListener('click', () => {
    updateTemplate(tpl.id, { steps: drift.currentSteps });
    // Update the snapshot on the investigation so we don't re-prompt
    inv.appliedTemplateSnapshot = drift.currentSteps.map(s => ({ ...s }));
    setInvestigation(ticket.id, inv);
    close();
    showToast(`✓ Updated template — ${tpl.name} (v${(tpl.version||1)+1})`, 'ok');
  });
}

// ─── TEMPLATE EDITOR (create from scratch / edit existing) ─────────
// AI scaffolding: generates a starter checklist from a description.
async function scaffoldTemplateFromDescription(description) {
  if (!description?.trim()) throw new Error('Description is required');
  const system = buildTemplateScaffoldSystemPrompt();
  const userMsg = `Generate a template for this procedure:\n\n${description.trim()}`;
  const raw = await callAI(system, [{ role: 'user', content: userMsg }]);
  const cleaned = (raw || '').replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch(e) { throw new Error('AI returned non-JSON. Raw: ' + cleaned.substring(0, 200)); }
  return {
    name: String(parsed.name || '').substring(0, 100).trim(),
    description: String(parsed.description || '').trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : [],
    steps: Array.isArray(parsed.steps) ? parsed.steps.map(s => ({
      text: String(s.text || '').trim(),
      verification: String(s.verification || '').trim(),
    })).filter(s => s.text) : [],
  };
}

// Editor modal — used for both Create New (existingTemplate=null) and Edit Existing.
// Returns nothing; side effect is saving/updating template + closing modal.
// `ticket` is optional context (used for tag suggestions and back-navigation).
function showTemplateEditorModal(existingTemplate, ticket) {
  const isEdit = !!existingTemplate;
  // Working state — kept on the modal closure, not in app state, so cancellation is clean
  let working = isEdit
    ? {
        name: existingTemplate.name || '',
        description: existingTemplate.description || '',
        tags: [...(existingTemplate.tags || [])],
        isPublic: existingTemplate.isPublic !== false,
        steps: (existingTemplate.steps || []).map(s => ({
          id: 's-' + Math.random().toString(36).slice(2, 8),
          text: s.text || '',
          verification: s.verification || '',
        })),
      }
    : {
        name: '',
        description: '',
        tags: [],
        isPublic: true,
        steps: [{ id: 's-' + Math.random().toString(36).slice(2, 8), text: '', verification: '' }],
      };

  const modal = document.createElement('div');
  modal.className = 'tpl-editor-modal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  document.body.appendChild(modal);

  const render = () => {
    modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:760px;margin:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex-wrap:wrap;gap:8px">
        <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em">${isEdit ? '📝 Edit Template' : '＋ Create Template'}</div>
        ${!isEdit ? `<button id="tplEdAiScaffoldBtn" class="abtn abtn-ai" style="font-size:11px;padding:6px 12px" title="Describe what the template does and have AI scaffold the steps">✨ AI Scaffold from Description</button>` : ''}
      </div>
      <div style="font-size:12px;color:var(--textdim);margin-bottom:14px">${isEdit ? `Editing v${existingTemplate.version || 1}. Saving creates a new version. Existing investigations using this template will keep their snapshot until they re-apply or get drift updates.` : 'Author a reusable investigation pattern. Each step has text + an optional verification criterion (the success check the next tech will run).'}</div>

      <label class="tpl-modal-label">NAME</label>
      <input id="tplEdName" type="text" class="tpl-modal-input" maxlength="120" placeholder="e.g. Windows Server Graceful Reboot" />

      <label class="tpl-modal-label">DESCRIPTION (optional)</label>
      <textarea id="tplEdDesc" class="tpl-modal-input" rows="2" placeholder="When to use this template — what symptoms or conditions it applies to."></textarea>

      <label class="tpl-modal-label">TAGS (comma-separated, used for search and auto-suggestion)</label>
      <input id="tplEdTags" type="text" class="tpl-modal-input" placeholder="reboot, windows, server" />

      <div style="display:flex;align-items:center;gap:8px;margin:14px 0 4px">
        <input type="checkbox" id="tplEdPublic" style="cursor:pointer" />
        <label for="tplEdPublic" style="cursor:pointer;font-size:13px">Public — visible to all techs</label>
      </div>
      <div style="font-size:11px;color:var(--textdim);margin-bottom:14px">Uncheck to keep this template private to you.</div>

      <div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px">
        <label class="tpl-modal-label" style="margin:0">STEPS (${working.steps.length})</label>
        <button id="tplEdAddStepBtn" class="abtn abtn-ghost" style="font-size:11px;padding:5px 10px">+ Add Step</button>
      </div>

      <div id="tplEdStepsList" style="max-height:50vh;overflow-y:auto;padding-right:4px">
        ${working.steps.map((s, i) => `
          <div class="tpl-ed-step" data-step-id="${esc(s.id)}">
            <div class="tpl-ed-step-head">
              <span class="tpl-ed-step-num">${i+1}</span>
              <input type="text" class="tpl-ed-step-text" data-field="text" placeholder="Step description (e.g. 'Run cleanmgr /sageset:65535')" value="${esc(s.text)}" />
              <button class="inv-step-btn" data-action="tpl-ed-step-up" ${i===0?'disabled':''} title="Move up">↑</button>
              <button class="inv-step-btn" data-action="tpl-ed-step-down" ${i===working.steps.length-1?'disabled':''} title="Move down">↓</button>
              <button class="inv-step-btn inv-step-delete" data-action="tpl-ed-step-delete" title="Delete step">×</button>
            </div>
            <div class="tpl-ed-step-verify">
              <span class="inv-step-verify-label">VERIFY:</span>
              <input type="text" class="tpl-ed-step-verify-input" data-field="verification" placeholder="Success criterion (optional, e.g. 'Disk free > 20GB')" value="${esc(s.verification)}" />
            </div>
          </div>
        `).join('')}
      </div>

      <div id="tplEdStatus" style="font-family:var(--cond);font-size:11px;min-height:14px;margin-top:10px;color:var(--textdim)"></div>

      <div style="display:flex;gap:8px;margin-top:12px">
        <button id="tplEdSaveBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">${isEdit ? '✓ SAVE CHANGES' : '✓ CREATE TEMPLATE'}</button>
        <button id="tplEdCancelBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Cancel</button>
      </div>
    </div>`;

    // Populate with current working state
    document.getElementById('tplEdName').value = working.name;
    document.getElementById('tplEdDesc').value = working.description;
    document.getElementById('tplEdTags').value = working.tags.join(', ');
    document.getElementById('tplEdPublic').checked = working.isPublic;
    wireRenderedHandlers();
  };

  const status = (msg, color) => {
    const el = document.getElementById('tplEdStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color = color || 'var(--textdim)';
    clearTimeout(status._t);
    status._t = setTimeout(() => { if (el) el.textContent = ''; }, 4000);
  };

  // Sync DOM input values into `working` (called before save / before re-render of steps section)
  const syncFromDom = () => {
    working.name = document.getElementById('tplEdName')?.value || '';
    working.description = document.getElementById('tplEdDesc')?.value || '';
    working.tags = (document.getElementById('tplEdTags')?.value || '')
      .split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    working.isPublic = !!document.getElementById('tplEdPublic')?.checked;
    // Per-step values
    document.querySelectorAll('#tplEdStepsList .tpl-ed-step').forEach(stepEl => {
      const id = stepEl.dataset.stepId;
      const step = working.steps.find(s => s.id === id);
      if (!step) return;
      step.text = stepEl.querySelector('[data-field="text"]')?.value || '';
      step.verification = stepEl.querySelector('[data-field="verification"]')?.value || '';
    });
  };

  const close = () => { if (document.body.contains(modal)) document.body.removeChild(modal); };

  const wireRenderedHandlers = () => {
    document.getElementById('tplEdCancelBtn').addEventListener('click', () => {
      // Confirm if there are meaningful changes to discard
      const hasContent = working.name.trim() || working.description.trim() || working.steps.some(s => s.text.trim());
      if (hasContent && !isEdit && !confirm('Discard this template? Your work will be lost.')) return;
      close();
    });

    document.getElementById('tplEdSaveBtn').addEventListener('click', () => {
      syncFromDom();
      // Validation
      if (!working.name.trim()) {
        status('Template needs a name', '#c8102e');
        document.getElementById('tplEdName').focus();
        return;
      }
      const cleanSteps = working.steps
        .map(s => ({ text: s.text.trim(), verification: s.verification.trim() }))
        .filter(s => s.text);
      if (!cleanSteps.length) {
        status('Template needs at least one step with text', '#c8102e');
        return;
      }
      try {
        if (isEdit) {
          updateTemplate(existingTemplate.id, {
            name: working.name.trim(),
            description: working.description.trim(),
            tags: working.tags,
            isPublic: working.isPublic,
            steps: cleanSteps,
          });
          showToast(`✓ Updated template — ${working.name} (v${(existingTemplate.version || 1) + 1})`, 'ok');
        } else {
          const tpl = {
            id: newTemplateId(),
            name: working.name.trim(),
            description: working.description.trim(),
            steps: cleanSteps,
            tags: working.tags,
            isPublic: working.isPublic,
            createdBy: getMyResourceName(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            sourceTicketId: null,
            usageCount: 0,
            version: 1,
          };
          saveTemplate(tpl);
          showToast(`✓ Created template — ${tpl.name}`, 'ok');
        }
        close();
        // Reopen the picker so user sees their new/updated template in context
        if (ticket) showTemplatePickerModal(ticket);
      } catch(err) {
        status(`Save failed: ${err.message}`, '#c8102e');
      }
    });

    document.getElementById('tplEdAddStepBtn').addEventListener('click', () => {
      syncFromDom();
      working.steps.push({ id: 's-' + Math.random().toString(36).slice(2, 8), text: '', verification: '' });
      render();
      // Focus the new step's text field
      setTimeout(() => {
        const last = document.querySelector('#tplEdStepsList .tpl-ed-step:last-child .tpl-ed-step-text');
        last?.focus();
      }, 50);
    });

    // Step actions (delegated within the modal)
    modal.querySelectorAll('[data-action="tpl-ed-step-up"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const stepEl = btn.closest('.tpl-ed-step');
        const id = stepEl.dataset.stepId;
        const idx = working.steps.findIndex(s => s.id === id);
        if (idx <= 0) return;
        syncFromDom();
        [working.steps[idx-1], working.steps[idx]] = [working.steps[idx], working.steps[idx-1]];
        render();
      });
    });
    modal.querySelectorAll('[data-action="tpl-ed-step-down"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const stepEl = btn.closest('.tpl-ed-step');
        const id = stepEl.dataset.stepId;
        const idx = working.steps.findIndex(s => s.id === id);
        if (idx < 0 || idx >= working.steps.length - 1) return;
        syncFromDom();
        [working.steps[idx], working.steps[idx+1]] = [working.steps[idx+1], working.steps[idx]];
        render();
      });
    });
    modal.querySelectorAll('[data-action="tpl-ed-step-delete"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const stepEl = btn.closest('.tpl-ed-step');
        const id = stepEl.dataset.stepId;
        if (working.steps.length <= 1) {
          status('Template needs at least one step', '#e07b00');
          return;
        }
        syncFromDom();
        working.steps = working.steps.filter(s => s.id !== id);
        render();
      });
    });

    // AI Scaffold (only present in create mode)
    const scaffoldBtn = document.getElementById('tplEdAiScaffoldBtn');
    if (scaffoldBtn) {
      scaffoldBtn.addEventListener('click', async () => {
        const description = prompt('Describe the procedure to generate steps for:\n\nExamples:\n- "Windows Server graceful reboot procedure"\n- "M365 license assignment for new hire"\n- "VPN client troubleshooting basics"\n\nThe AI will draft a starter checklist you can edit before saving.');
        if (!description?.trim()) return;
        scaffoldBtn.disabled = true;
        const origLabel = scaffoldBtn.textContent;
        scaffoldBtn.textContent = '✨ Scaffolding...';
        status('Asking AI to draft steps...', 'var(--textdim)');
        try {
          const drafted = await scaffoldTemplateFromDescription(description);
          // Merge into working state — AI-drafted fields replace empty fields,
          // but if user already typed something, AI doesn't overwrite it.
          if (!working.name.trim() && drafted.name) working.name = drafted.name;
          if (!working.description.trim() && drafted.description) working.description = drafted.description;
          if (!working.tags.length && drafted.tags?.length) working.tags = drafted.tags;
          // For steps: if user has only the empty default step, replace with drafted; otherwise append
          const allEmpty = working.steps.every(s => !s.text.trim());
          if (allEmpty) {
            working.steps = drafted.steps.map(s => ({
              id: 's-' + Math.random().toString(36).slice(2, 8),
              text: s.text,
              verification: s.verification,
            }));
          } else {
            // Append drafted steps to existing
            drafted.steps.forEach(s => working.steps.push({
              id: 's-' + Math.random().toString(36).slice(2, 8),
              text: s.text,
              verification: s.verification,
            }));
          }
          render();
          status(`✓ Scaffolded ${drafted.steps.length} steps — review and edit before saving`, '#2a9d5c');
        } catch(err) {
          status(`Scaffold failed: ${err.message}`, '#c8102e');
          scaffoldBtn.disabled = false;
          scaffoldBtn.textContent = origLabel;
        }
      });
    }
  };

  render();
}

// ─── TICKET INVESTIGATION CHAT ────────────────────────────────────
async function sendTicketChat(ticketId, message) {
  const ticket = findTicketById(ticketId);
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
    const system = buildTicketChatSystemPrompt(ticket, inv, contextBlob, state.templates);
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

// ─── CRITICAL ALERT PROMPT (Auto-suggest ticket creation for old Criticals) ─
const CRITICAL_SCAN_INTERVAL_MS = 60 * 1000; // scan once per minute

function getCriticalPromptThresholdMs() {
  const min = parseInt(state.settings.autoCreatePromptThresholdMin) || 15;
  return min * 60 * 1000;
}

function getCriticalPromptExcludedSites() {
  return new Set(state.settings.autoCreatePromptExcluded || []);
}

function findCriticalsNeedingPrompt() {
  if (state.settings.autoCreatePromptCritical !== true) return [];
  const threshold = getCriticalPromptThresholdMs();
  const excluded = getCriticalPromptExcludedSites();
  const now = Date.now();
  return (state.alerts || []).filter(a => {
    if (a.priority !== 'Critical') return false;
    if (a.ticketNumber) return false; // already has a ticket
    if (excluded.has(a.siteName)) return false;
    if (state.criticalPromptDismissed.has(a.alertUid)) return false;
    const snoozeUntil = state.criticalPromptSnoozes[a.alertUid];
    if (snoozeUntil && snoozeUntil > now) return false;
    const age = now - (a.timestampMs || 0);
    return age >= threshold;
  });
}

function snoozeCriticalPrompt(alertUid, hours = 1) {
  state.criticalPromptSnoozes[alertUid] = Date.now() + hours * 3600000;
  LS.set('msp_critical_snoozes', state.criticalPromptSnoozes);
}

function dismissCriticalPrompt(alertUid) {
  state.criticalPromptDismissed.add(alertUid);
  // Persist as a long-lived snooze (30 days) so dismiss survives page reload
  snoozeCriticalPrompt(alertUid, 30 * 24);
}

function pruneCriticalSnoozes() {
  const now = Date.now();
  let changed = false;
  Object.entries(state.criticalPromptSnoozes).forEach(([uid, until]) => {
    if (until < now - 7 * 86400000) {
      delete state.criticalPromptSnoozes[uid];
      changed = true;
    }
  });
  // Also drop snoozes/dismisses for alerts that no longer exist
  const liveUids = new Set(state.alerts.map(a => a.alertUid));
  Object.keys(state.criticalPromptSnoozes).forEach(uid => {
    if (!liveUids.has(uid)) { delete state.criticalPromptSnoozes[uid]; changed = true; }
  });
  if (changed) LS.set('msp_critical_snoozes', state.criticalPromptSnoozes);
}

function renderCriticalPromptBanner() {
  const container = document.getElementById('criticalPromptContainer') || (() => {
    const dash = document.getElementById('view-dashboard');
    const alertsView = document.getElementById('view-alerts');
    if (!dash && !alertsView) return null;
    const c = document.createElement('div');
    c.id = 'criticalPromptContainer';
    c.className = 'critical-prompt-container';
    // Insert at the top of whichever view is active — but both contain it. Easier: append to body, fixed pos.
    document.body.appendChild(c);
    return c;
  })();
  if (!container) return;
  const candidates = findCriticalsNeedingPrompt();
  if (!candidates.length) {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  container.innerHTML = candidates.slice(0, 3).map(a => {
    const ageMin = Math.floor((Date.now() - a.timestampMs) / 60000);
    return `<div class="critical-prompt-banner" data-alert-uid="${esc(a.alertUid)}">
      <div class="critical-prompt-msg">
        <span class="critical-prompt-icon">⚠</span>
        <strong>Critical at ${esc(a.siteName)}</strong> · ${esc(a.hostname)} · open ${ageMin}m, no ticket
        <div class="critical-prompt-detail">${esc((a.alertMessage || '').substring(0, 110))}</div>
      </div>
      <div class="critical-prompt-actions">
        <button class="abtn abtn-create" data-action="critical-prompt-jump" data-alert-uid="${esc(a.alertUid)}">View Alert</button>
        <button class="abtn abtn-ghost" data-action="critical-prompt-snooze" data-alert-uid="${esc(a.alertUid)}" title="Hide for 1 hour">Snooze 1h</button>
        <button class="abtn abtn-ghost" data-action="critical-prompt-dismiss" data-alert-uid="${esc(a.alertUid)}" title="Don't prompt again for this alert">Dismiss</button>
      </div>
    </div>`;
  }).join('') + (candidates.length > 3
    ? `<div class="critical-prompt-more">+ ${candidates.length - 3} more Critical${candidates.length-3!==1?'s':''} pending</div>`
    : '');
}

function startCriticalScanner() {
  if (state.criticalScanTimer) clearInterval(state.criticalScanTimer);
  state.criticalScanTimer = setInterval(() => {
    pruneCriticalSnoozes();
    renderCriticalPromptBanner();
  }, CRITICAL_SCAN_INTERVAL_MS);
  // Run once immediately
  pruneCriticalSnoozes();
  renderCriticalPromptBanner();
}

// ─── SHIFT HANDOFF REPORT ─────────────────────────────────────────
function getHandoffWindowHours() {
  const h = parseInt(state.settings.handoffWindowHours);
  return (!h || h < 1 || h > 168) ? 12 : h;
}

// Gather everything that happened in the last N hours into a structured payload for the AI.
async function buildHandoffData(hours) {
  const cutoffMs = Date.now() - hours * 3600000;

  // Currently open critical/high alerts
  const openCritical = (state.alerts || []).filter(a => a.priority === 'Critical');
  const openHigh = (state.alerts || []).filter(a => a.priority === 'High');

  // Active investigations — anything with steps and recent activity
  const activeInvestigations = [];
  Object.entries(state.investigations || {}).forEach(([ticketId, inv]) => {
    if (!inv?.steps?.length) return;
    const lastSession = inv.timeTracking?.sessions?.slice(-1)[0];
    const lastActivityMs = lastSession?.endMs || inv.lastAnalyzedAt || 0;
    if (lastActivityMs < cutoffMs) return;
    const ticket = Object.values(state.tickets).find(t => String(t.id) === ticketId);
    if (!ticket || ticket.isDone) return;
    const completedSteps = inv.steps.filter(s => s.done).length;
    const recentNotes = inv.steps
      .filter(s => s.notes?.trim())
      .map(s => `Step ${inv.steps.indexOf(s)+1}: ${s.notes.trim()}`)
      .join('\n');
    activeInvestigations.push({
      ticketNumber: ticket.ticketNumber,
      title: ticket.title,
      client: ticket.companyName,
      assignee: ticket.assignedResourceName || 'Unassigned',
      progress: `${completedSteps}/${inv.steps.length} steps complete`,
      timeSpent: fmtMsAsDuration(inv.timeTracking?.totalMs || 0),
      recentNotes: recentNotes || '(no notes captured)',
    });
  });

  // Tickets resolved in window — try to fetch from AT
  let resolvedTickets = [];
  try {
    const days = Math.max(1, Math.ceil(hours / 24));
    const all = await fetchResolvedTicketsForReports(days);
    resolvedTickets = all.filter(t => {
      const resolvedMs = t.resolvedDateTime ? new Date(t.resolvedDateTime).getTime()
                       : t.lastActivityDate ? new Date(t.lastActivityDate).getTime()
                       : 0;
      return resolvedMs >= cutoffMs;
    });
  } catch(e) { console.warn('Resolved tickets fetch for handoff failed:', e.message); }

  // Aging tickets (open > 14 days)
  const agingTickets = Object.values(state.tickets || []).filter(t => {
    if (t.isDone) return false;
    if (!t.createDate) return false;
    return Date.now() - new Date(t.createDate).getTime() > 14 * 86400000;
  }).slice(0, 10);

  // Mismatches — ticket closed but Datto alert still open
  const mismatches = (state.alerts || []).filter(a => {
    if (!a.ticketNumber) return false;
    const t = state.tickets[a.ticketNumber];
    return t?.isDone;
  });

  // Critical clients — clients with multiple criticals or unhandled criticals
  const criticalClients = {};
  openCritical.forEach(a => {
    if (!criticalClients[a.siteName]) criticalClients[a.siteName] = 0;
    criticalClients[a.siteName]++;
  });

  return {
    windowHours: hours,
    generatedAt: new Date().toISOString(),
    openCritical: openCritical.map(a => ({
      hostname: a.hostname,
      client: a.siteName,
      message: a.alertMessage,
      ageMin: Math.floor((Date.now() - a.timestampMs) / 60000),
      ticketNumber: a.ticketNumber,
    })),
    openHighCount: openHigh.length,
    activeInvestigations,
    resolvedTickets: resolvedTickets.map(t => ({
      ticketNumber: t.ticketNumber,
      title: t.title,
      tech: state.atResources.find(r => r.id === t.assignedResourceID)?.name || 'Unknown',
    })),
    agingTickets: agingTickets.map(t => ({
      ticketNumber: t.ticketNumber,
      title: t.title,
      client: t.companyName,
      ageDays: Math.floor((Date.now() - new Date(t.createDate).getTime()) / 86400000),
      assignee: t.assignedResourceName || 'Unassigned',
    })),
    mismatchCount: mismatches.length,
    criticalClients: Object.entries(criticalClients).map(([client, count]) => ({ client, count })),
  };
}

async function generateHandoffReport(hours, techNotes) {
  const data = await buildHandoffData(hours);
  const system = buildHandoffSystemPrompt();
  const techNotesBlock = (techNotes || '').trim()
    ? `\n\n── OUTGOING TECH HANDOFF NOTES ──\n${techNotes.trim()}`
    : '';
  const userMsg = `SHIFT HANDOFF — last ${hours} hours.\n\n` +
    JSON.stringify(data, null, 2) +
    techNotesBlock;
  const content = await callAI(system, [{ role: 'user', content: userMsg }]);
  const handoff = {
    generatedAtMs: Date.now(),
    generatedBy: getMyResourceName(),
    hours,
    content: (content || '').trim(),
    techNotes: (techNotes || '').trim(),
  };
  state.lastHandoff = handoff;
  LS.set('msp_last_handoff', handoff);
  return handoff;
}

function showHandoffModal() {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';

  const last = state.lastHandoff;
  const lastDisplay = last
    ? `Last generated: <strong>${new Date(last.generatedAtMs).toLocaleString()}</strong> by ${esc(last.generatedBy || 'unknown')} (${last.hours}h window)`
    : 'No prior handoff on file';
  const defaultHours = getHandoffWindowHours();
  const myName = getMyResourceName();

  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:760px;margin:auto">
    <div style="font-family:var(--cond);font-size:18px;font-weight:700;letter-spacing:0.07em;margin-bottom:6px">📋 Shift Handoff</div>
    <div style="font-size:12px;color:var(--textdim);margin-bottom:14px">${lastDisplay}</div>

    ${last ? `<div class="handoff-saved">
      <div class="handoff-saved-label">SAVED HANDOFF (read-only)</div>
      <div class="handoff-content">${fmtHandoffContent(last.content)}</div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        <button id="handoffCopyBtn" class="abtn abtn-ghost" style="font-size:11px;padding:6px 12px">📋 Copy</button>
      </div>
    </div>` : ''}

    <div class="handoff-generate-block">
      <div class="handoff-generate-label">${last ? 'GENERATE NEW HANDOFF' : 'GENERATE HANDOFF'}</div>

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
        <label style="font-size:12px;color:var(--textmid)">Look back</label>
        <input id="handoffHours" type="number" min="1" max="168" value="${defaultHours}" style="width:60px;padding:5px 8px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;font-size:13px" />
        <label style="font-size:12px;color:var(--textmid)">hours</label>
      </div>

      <label style="display:block;font-family:var(--cond);font-size:11px;font-weight:700;letter-spacing:0.09em;color:var(--textdim);margin-bottom:4px">YOUR HANDOFF NOTES (optional, surfaced verbatim in report)</label>
      <textarea id="handoffNotes" rows="3" placeholder="e.g. Wallquest has scheduled SQL maintenance 2-4am, ignore disk alerts. Erik is taking over the M365 ticket."
        style="width:100%;padding:8px 10px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:4px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box"></textarea>

      <div id="handoffStatus" style="font-family:var(--cond);font-size:11px;min-height:14px;margin-top:6px;color:var(--textdim)"></div>

      <div style="display:flex;gap:8px;margin-top:14px">
        <button id="handoffGenerateBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">✨ Generate Handoff</button>
        <button id="handoffCloseBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Close</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(modal);

  const close = () => { if (document.body.contains(modal)) document.body.removeChild(modal); };
  document.getElementById('handoffCloseBtn').addEventListener('click', close);

  document.getElementById('handoffCopyBtn')?.addEventListener('click', () => {
    if (!last?.content) return;
    navigator.clipboard.writeText(last.content).then(() => {
      const btn = document.getElementById('handoffCopyBtn');
      if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = '📋 Copy', 1500); }
    });
  });

  document.getElementById('handoffGenerateBtn')?.addEventListener('click', async () => {
    const btn = document.getElementById('handoffGenerateBtn');
    const status = document.getElementById('handoffStatus');
    const hoursInput = document.getElementById('handoffHours');
    const notesInput = document.getElementById('handoffNotes');
    const hours = parseInt(hoursInput?.value) || 12;
    const techNotes = (notesInput?.value || '').trim();
    btn.disabled = true; btn.textContent = '✨ Generating...';
    if (status) { status.textContent = 'Gathering shift data and asking AI...'; status.style.color = 'var(--textdim)'; }
    try {
      await generateHandoffReport(hours, techNotes);
      if (status) { status.textContent = '✓ Handoff generated and saved'; status.style.color = '#2a9d5c'; }
      // Persist also as default for next time
      saveSettings({ handoffWindowHours: hours });
      // Close and reopen so the saved-handoff section appears
      close();
      setTimeout(showHandoffModal, 200);
    } catch(err) {
      if (status) { status.textContent = `Error: ${err.message}`; status.style.color = '#c8102e'; }
      btn.disabled = false; btn.textContent = '✨ Generate Handoff';
    }
  });
}

function injectHandoffButton() {
  if (document.getElementById('handoffBtn')) return;
  const refresh = document.getElementById('dashRefreshBtn');
  if (!refresh) return;
  const btn = document.createElement('button');
  btn.id = 'handoffBtn';
  btn.className = refresh.className; // mirror styling
  btn.title = 'Generate a shift handoff report for the next tech';
  btn.innerHTML = '📋 Shift Handoff';
  btn.style.marginRight = '6px';
  btn.addEventListener('click', showHandoffModal);
  refresh.parentNode.insertBefore(btn, refresh);
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

// ─── INCIDENTS (ALERT GROUPING) ───────────────────────────────────
const INCIDENT_MIN_CLUSTER_SIZE = 3;        // rule-based clusterer needs at least this many
const INCIDENT_TIME_WINDOW_MS = 5 * 60000;  // alerts must fire within 5 minutes

function newIncidentId() { return 'inc-' + Math.random().toString(36).slice(2, 10); }

function saveIncidents() { LS.set('msp_incidents', state.incidents); }

function getAlertIncident(alertUid) {
  return Object.values(state.incidents).find(i => i.alertUids?.includes(alertUid)) || null;
}

function isAlertGrouped(alertUid) {
  return !!getAlertIncident(alertUid);
}

// Returns ungrouped alerts and all incidents (with their alerts hydrated).
// Used by the alerts list when grouping mode is on.
function getGroupedAlertView(visibleAlerts) {
  const visibleUids = new Set(visibleAlerts.map(a => a.alertUid));
  const incidents = [];
  Object.values(state.incidents).forEach(inc => {
    const alerts = (inc.alertUids || []).filter(u => visibleUids.has(u))
                                         .map(u => visibleAlerts.find(a => a.alertUid === u))
                                         .filter(Boolean);
    if (alerts.length) incidents.push({ ...inc, alerts });
  });
  // Drop incidents whose alerts are all gone
  const inIncident = new Set();
  incidents.forEach(inc => inc.alerts.forEach(a => inIncident.add(a.alertUid)));
  const ungrouped = visibleAlerts.filter(a => !inIncident.has(a.alertUid));
  // Sort incidents: by highest-priority child alert, then alert count desc
  incidents.sort((a, b) => {
    const ap = Math.min(...a.alerts.map(x => SEV[x.priority]?.rank ?? 99));
    const bp = Math.min(...b.alerts.map(x => SEV[x.priority]?.rank ?? 99));
    if (ap !== bp) return ap - bp;
    return b.alerts.length - a.alerts.length;
  });
  return { incidents, ungrouped };
}

function pruneEmptyIncidents() {
  // Drop any incident whose alertUids are all gone from state.alerts (e.g. after a refresh)
  const liveUids = new Set(state.alerts.map(a => a.alertUid));
  let changed = false;
  Object.entries(state.incidents).forEach(([id, inc]) => {
    inc.alertUids = (inc.alertUids || []).filter(u => liveUids.has(u));
    if (inc.alertUids.length === 0) {
      delete state.incidents[id];
      changed = true;
    } else if (inc.alertUids.length === 1) {
      // Solo alert, no point keeping the incident wrapper
      delete state.incidents[id];
      changed = true;
    }
  });
  if (changed) saveIncidents();
}

// Rule-based clusterer. Groups ungrouped alerts by site + monitorType within a time window.
function runRuleBasedClustering() {
  if (state.settings.groupAlerts !== true) return 0;
  const ungrouped = state.alerts.filter(a => !isAlertGrouped(a.alertUid));
  // Bucket by (siteName, monitorType)
  const buckets = {};
  ungrouped.forEach(a => {
    const key = `${a.siteName || ''}\u0001${a.monitorType || ''}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(a);
  });

  let createdCount = 0;
  for (const [key, alerts] of Object.entries(buckets)) {
    if (alerts.length < INCIDENT_MIN_CLUSTER_SIZE) continue;
    // Sort by time, then walk and split when time gap exceeds window
    alerts.sort((x, y) => x.timestampMs - y.timestampMs);
    let currentBatch = [alerts[0]];
    const finalized = [];
    for (let i = 1; i < alerts.length; i++) {
      if (alerts[i].timestampMs - currentBatch[currentBatch.length - 1].timestampMs <= INCIDENT_TIME_WINDOW_MS) {
        currentBatch.push(alerts[i]);
      } else {
        if (currentBatch.length >= INCIDENT_MIN_CLUSTER_SIZE) finalized.push(currentBatch);
        currentBatch = [alerts[i]];
      }
    }
    if (currentBatch.length >= INCIDENT_MIN_CLUSTER_SIZE) finalized.push(currentBatch);

    for (const batch of finalized) {
      const [siteName, monitorType] = key.split('\u0001');
      const id = newIncidentId();
      state.incidents[id] = {
        id,
        title: `${batch.length}× ${monitorType || 'alerts'} on ${siteName || 'site'}`,
        alertUids: batch.map(a => a.alertUid),
        createdAt: Date.now(),
        source: 'rule',
        expanded: false,
      };
      createdCount++;
    }
  }
  if (createdCount > 0) saveIncidents();
  return createdCount;
}

function createManualIncident(alertUids, title) {
  if (!alertUids || alertUids.length < 2) throw new Error('Manual incident needs at least 2 alerts');
  // Eject any of these alerts from existing incidents first
  alertUids.forEach(uid => ejectAlertFromIncident(uid, /* skipSave */ true));
  const id = newIncidentId();
  state.incidents[id] = {
    id,
    title: title || `Manual incident — ${alertUids.length} alerts`,
    alertUids: [...alertUids],
    createdAt: Date.now(),
    source: 'manual',
    expanded: true,
  };
  saveIncidents();
  return state.incidents[id];
}

function ejectAlertFromIncident(alertUid, skipSave) {
  const inc = getAlertIncident(alertUid);
  if (!inc) return;
  inc.alertUids = inc.alertUids.filter(u => u !== alertUid);
  if (inc.alertUids.length < 2) {
    // Drop the incident entirely if it would be a 1-alert incident
    delete state.incidents[inc.id];
  }
  if (!skipSave) saveIncidents();
}

function ungroupIncident(incidentId) {
  if (state.incidents[incidentId]) {
    delete state.incidents[incidentId];
    saveIncidents();
  }
}

function toggleIncidentExpand(incidentId) {
  if (state.incidents[incidentId]) {
    state.incidents[incidentId].expanded = !state.incidents[incidentId].expanded;
    saveIncidents();
  }
}

// ─── AI INCIDENT CLUSTERING ───────────────────────────────────────
async function runAiIncidentClustering() {
  // Only consider ungrouped alerts to avoid re-shuffling existing incidents
  const ungrouped = state.alerts.filter(a => !isAlertGrouped(a.alertUid));
  if (ungrouped.length < 2) {
    return { proposals: [], totalCandidates: 0 };
  }
  const summary = ungrouped.map(a => ({
    uid: a.alertUid,
    host: a.hostname,
    site: a.siteName,
    priority: a.priority,
    monitor: a.monitorType,
    msg: (a.alertMessage || '').substring(0, 200),
    ts: new Date(a.timestampMs).toISOString(),
  }));
  const system = buildIncidentClusterPrompt();
  const userMsg = `OPEN ALERTS TO ANALYZE (${ungrouped.length}):\n\n${JSON.stringify(summary, null, 2)}`;
  const raw = await callAI(system, [{ role: 'user', content: userMsg }]);
  const cleaned = (raw || '').replace(/```json|```/g, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch(e) { throw new Error('AI returned non-JSON. Raw: ' + cleaned.substring(0, 200)); }
  const proposals = (parsed.incidents || [])
    .filter(p => Array.isArray(p.alertUids) && p.alertUids.length >= 2)
    .map(p => ({
      title: String(p.title || '').substring(0, 100),
      reasoning: String(p.reasoning || ''),
      alertUids: p.alertUids.filter(u => ungrouped.some(a => a.alertUid === u)),
    }))
    .filter(p => p.alertUids.length >= 2);
  return { proposals, totalCandidates: ungrouped.length };
}

function showAiClusterReviewModal(proposals, totalCandidates) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  if (!proposals.length) {
    modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:520px;margin:auto">
      <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:8px">✨ AI Incident Detection</div>
      <div style="font-size:13px;color:var(--textmid);margin-bottom:14px">Reviewed ${totalCandidates} alerts. AI didn't find any clusters — they all look like separate incidents.</div>
      <button id="aiClusterCloseBtn" style="cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px 18px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">OK</button>
    </div>`;
    document.body.appendChild(modal);
    document.getElementById('aiClusterCloseBtn').addEventListener('click', () => document.body.removeChild(modal));
    return;
  }

  const proposalsHtml = proposals.map((p, i) => {
    const alerts = p.alertUids.map(u => state.alerts.find(a => a.alertUid === u)).filter(Boolean);
    const alertsHtml = alerts.map(a => `
      <div class="ai-cluster-alert">
        <span class="badge" style="color:${SEV[a.priority]?.color||'#5a7a96'};background:${SEV[a.priority]?.color||'#5a7a96'}22;border:1px solid ${SEV[a.priority]?.color||'#5a7a96'}55">${esc(a.priority)}</span>
        <span class="ai-cluster-host">${esc(a.hostname)}</span>
        <span class="ai-cluster-msg">${esc((a.alertMessage || '').substring(0, 80))}</span>
      </div>`).join('');
    return `<div class="ai-cluster-proposal" data-proposal-index="${i}">
      <div class="ai-cluster-head">
        <label class="ai-cluster-checkbox">
          <input type="checkbox" class="ai-cluster-accept" data-idx="${i}" checked />
          <span class="ai-cluster-title">${esc(p.title)}</span>
        </label>
        <span class="ai-cluster-count">${p.alertUids.length} alerts</span>
      </div>
      <div class="ai-cluster-reasoning">${esc(p.reasoning)}</div>
      <div class="ai-cluster-alerts">${alertsHtml}</div>
    </div>`;
  }).join('');

  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:720px;margin:auto">
    <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px">✨ AI Incident Detection</div>
    <div style="font-size:12px;color:var(--textdim);margin-bottom:16px">Reviewed ${totalCandidates} alerts. AI proposes ${proposals.length} incident${proposals.length!==1?'s':''}. Uncheck any you disagree with.</div>
    <div style="max-height:60vh;overflow-y:auto;margin-bottom:16px">${proposalsHtml}</div>
    <div style="display:flex;gap:8px">
      <button id="aiClusterAcceptBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">Create Selected Incidents</button>
      <button id="aiClusterCancelBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  document.getElementById('aiClusterCancelBtn').addEventListener('click', () => document.body.removeChild(modal));
  document.getElementById('aiClusterAcceptBtn').addEventListener('click', () => {
    const checked = [...modal.querySelectorAll('.ai-cluster-accept:checked')].map(el => parseInt(el.dataset.idx));
    let created = 0;
    checked.forEach(idx => {
      const p = proposals[idx];
      if (!p) return;
      try {
        const inc = createManualIncident(p.alertUids, p.title);
        inc.source = 'ai';
        saveIncidents();
        created++;
      } catch(e) { console.warn('Failed to create AI incident:', e.message); }
    });
    document.body.removeChild(modal);
    if (created > 0) {
      showToast(`✓ Created ${created} incident${created!==1?'s':''}`, 'ok');
      renderAlertList();
    }
  });
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

  const groupingOn = state.settings.groupAlerts === true;
  const renderAlertRow = (a, opts = {}) => {
    const sv     = SEV[a.priority]||SEV.Information;
    const ticket = a.ticketNumber ? state.tickets[a.ticketNumber] : null;
    const rs     = getResolutionState(a);
    const isActive = state.currentAlert?.alertUid === a.alertUid;
    const isLocked = !!ticket && !ticket.isDone;
    const ticketBadge = ticket
      ? `<span class="badge" style="color:${ticket.statusColor};background:${ticket.statusColor}22;border:1px solid ${ticket.statusColor}44">${isLocked?'🔒 ':''}${esc(ticket.statusLabel)}${ticket.assignedResourceName ? ' · ' + esc(ticket.assignedResourceName.split(' ')[0]) : ''}</span>`
      : `<span class="badge" style="color:#5a7a96;background:rgba(90,122,150,0.1);border:1px solid rgba(90,122,150,0.3)">No Ticket</span>`;
    const selectable = state.alertSelectMode;
    const checked = state.alertSelected.has(a.alertUid);
    const childIndicator = opts.isChild ? '<span class="incident-child-indicator">↳</span>' : '';
    const ejectBtn = opts.isChild
      ? `<button class="incident-eject-btn" data-action="incident-eject" data-uid="${esc(a.alertUid)}" title="Remove from incident">×</button>`
      : '';
    const selectBox = selectable
      ? `<input type="checkbox" class="alert-select-cb" data-action="alert-select" data-uid="${esc(a.alertUid)}" ${checked?'checked':''} />`
      : '';
    return `<div class="list-row ${isActive?'active':''} ${isLocked?'list-row-locked':''} ${opts.isChild?'list-row-child':''}" data-uid="${esc(a.alertUid)}">
      <div class="row-top">
        ${selectBox}${childIndicator}
        <span class="row-device">${esc(a.hostname)}</span>
        <div class="row-badges">
          ${badgeHtml(a.priority,sv.color,sv.bg)}
          ${rs==='mismatch' ? badgeHtml('⚠ MISMATCH','#c8960c','rgba(200,150,12,0.12)') : ''}
          ${ejectBtn}
        </div>
      </div>
      <div class="row-client">${esc(a.siteName)}</div>
      <div class="row-msg">${esc(a.alertMessage)}</div>
      <div class="row-foot"><span class="row-type">${esc(a.monitorType)}</span>${ticketBadge}</div>
    </div>`;
  };

  // Toolbar above the list — multi-select + bulk actions + grouping
  // Select toggle and bulk actions are always available; grouping-specific buttons only show when grouping is on.
  const selN = state.alertSelected.size;
  const toolbarHtml = `<div class="alert-list-toolbar">
    <button class="abtn abtn-ghost" data-action="toggle-alert-select" title="Multi-select alerts for bulk actions">${state.alertSelectMode ? '✓ Selecting' : '☐ Select'}</button>
    ${state.alertSelectMode && selN >= 2 && groupingOn ? `<button class="abtn abtn-post" data-action="create-manual-incident" title="Group selected alerts into one incident">+ Group ${selN}</button>` : ''}
    ${state.alertSelectMode && selN >= 1 ? `<button class="abtn abtn-resolve" data-action="bulk-resolve" title="Resolve all selected alerts in Datto">✓ Resolve ${selN}</button>` : ''}
    ${state.alertSelectMode && selN >= 1 ? `<button class="abtn abtn-create" data-action="bulk-create-tickets" title="Create a ticket for each selected alert (one at a time)">🎫 Ticket ${selN}</button>` : ''}
    ${state.alertSelectMode && selN >= 2 ? `<button class="abtn abtn-kb" data-action="bulk-save-kb" title="AI-format selected alerts as one KB entry">📚 Save ${selN} to KB</button>` : ''}
    ${state.alertSelectMode && selN >= 1 ? `<button class="abtn abtn-snooze" data-action="bulk-snooze" title="Snooze all selected alerts">⏸ Snooze ${selN}</button>` : ''}
    ${groupingOn ? `<button class="abtn abtn-ai" data-action="ai-cluster-alerts" title="Use AI to detect related alerts">✨ AI Detect</button>` : ''}
  </div>`;

  if (!groupingOn) {
    // Old behavior — flat list
    el.innerHTML = toolbarHtml + sorted.map(a => renderAlertRow(a)).join('');
    return;
  }

  // Grouped view — incidents as expandable parent rows, ungrouped alerts inline
  const { incidents, ungrouped } = getGroupedAlertView(sorted);

  const incidentHtml = incidents.map(inc => {
    const childCritical = inc.alerts.filter(a => a.priority === 'Critical').length;
    const topPrio = inc.alerts.reduce((acc, a) => {
      const r = SEV[a.priority]?.rank ?? 99;
      return r < acc.rank ? { rank: r, name: a.priority } : acc;
    }, { rank: 99, name: 'Information' });
    const sv = SEV[topPrio.name] || SEV.Information;
    const sourceLabel = inc.source === 'ai' ? '✨ AI' : inc.source === 'manual' ? '👤 Manual' : '⚙ Auto';
    const childRows = inc.expanded ? inc.alerts.map(a => renderAlertRow(a, { isChild: true })).join('') : '';
    return `<div class="incident-block">
      <div class="incident-header" data-action="incident-toggle" data-incident-id="${esc(inc.id)}">
        <span class="incident-arrow">${inc.expanded ? '▼' : '▶'}</span>
        <div class="incident-meta">
          <div class="incident-title">${esc(inc.title)}</div>
          <div class="incident-sub">
            ${badgeHtml(topPrio.name, sv.color, sv.bg)}
            <span class="incident-count">${inc.alerts.length} alerts${childCritical?' · '+childCritical+' critical':''}</span>
            <span class="incident-source">${sourceLabel}</span>
          </div>
        </div>
        <button class="incident-ungroup-btn" data-action="incident-ungroup" data-incident-id="${esc(inc.id)}" title="Ungroup this incident" onclick="event.stopPropagation()">Ungroup</button>
      </div>
      ${childRows}
    </div>`;
  }).join('');

  const ungroupedHtml = ungrouped.map(a => renderAlertRow(a)).join('');

  el.innerHTML = toolbarHtml + incidentHtml + ungroupedHtml;
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

// ─── TICKET DETAIL PANELS: DEVICE / ACTIVITY / METADATA ─────────
// fmtBytes, fmtRelativeTime, fmtSlaClock imported from utils.js

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

  body.innerHTML = `
    <div class="meta-grid">
      <div class="meta-cell"><div class="meta-label">ISSUE TYPE</div><div class="meta-value">${esc(issueLabel)}</div></div>
      <div class="meta-cell"><div class="meta-label">SUB-ISSUE</div><div class="meta-value">${esc(subIssueLabel)}</div></div>
      <div class="meta-cell"><div class="meta-label">SOURCE</div><div class="meta-value">${esc(sourceLabel)}</div></div>
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
  const totalMs = hasInv ? getInvestigationTotalMs(ticket.id) : 0;
  const isActive = isTimerActiveFor(ticket.id);
  const isPaused = isTimerPausedFor(ticket.id);
  let timeBadge = '';
  if (hasInv && (totalMs > 0 || isActive || isPaused)) {
    if (isActive) {
      timeBadge = `<button class="inv-time-badge inv-time-active" data-action="timer-pause" data-ticket-id="${ticket.id}" title="Click to pause — phone call, lunch, etc.">⏱ <span id="invTimeDisplay-${ticket.id}">${esc(fmtMsAsDuration(totalMs))}</span> <span class="inv-time-action">⏸ pause</span></button>`;
    } else if (isPaused) {
      timeBadge = `<button class="inv-time-badge inv-time-paused" data-action="timer-resume" data-ticket-id="${ticket.id}" title="Click to resume timer">⏸ <span id="invTimeDisplay-${ticket.id}">${esc(fmtMsAsDuration(totalMs))}</span> <span class="inv-time-action">▶ resume</span></button>`;
    } else {
      timeBadge = `<span class="inv-time-badge" title="Total tracked time across sessions">⏱ <span id="invTimeDisplay-${ticket.id}">${esc(fmtMsAsDuration(totalMs))}</span></span>`;
    }
  }
  const headerHtml = `<div class="card-label" style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px">
    <span>★ AI INVESTIGATION</span>
    <span style="display:flex;align-items:center;gap:8px">
      ${timeBadge}
      ${hasInv ? `<span style="font-size:11px;color:var(--textdim);font-weight:400;letter-spacing:0.03em;text-transform:none">Last analyzed ${new Date(inv.lastAnalyzedAt).toLocaleString()}</span>` : ''}
    </span>
  </div>`;

  if (!hasInv) {
    const draft = state.notesDrafts['tech-ctx-' + ticket.id] || '';
    const suggestions = suggestTemplatesForTicket(ticket);
    const suggestionsHtml = suggestions.length ? `
      <div class="tpl-suggestions">
        <div class="tpl-suggestions-label">📋 ${suggestions.length} matching template${suggestions.length!==1?'s':''} found:</div>
        ${suggestions.map(t => `
          <div class="tpl-suggestion-row" data-action="apply-template" data-template-id="${esc(t.id)}" data-ticket-id="${ticket.id}">
            <div class="tpl-suggestion-name">${esc(t.name)}</div>
            <div class="tpl-suggestion-meta">
              <span>${t.steps.length} steps</span>
              ${t.usageCount ? `<span>· used ${t.usageCount}×</span>` : ''}
              ${t.tags?.length ? `<span>· ${esc(t.tags.slice(0,3).join(', '))}</span>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    ` : '';
    return `<div class="detail-card" id="investigationCard">
      ${headerHtml}
      <div style="color:var(--textdim);font-size:12px;margin:8px 0 12px">Pulls ticket detail, Autotask notes, KB articles, client history, and any linked Datto alert. Produces an editable action plan.</div>
      ${suggestionsHtml}
      <div class="field-group" style="margin-bottom:10px">
        <label style="display:block;font-family:var(--cond);font-size:11px;font-weight:700;letter-spacing:0.09em;color:var(--textdim);margin-bottom:4px">TECH CONTEXT <span style="font-weight:400;text-transform:none;letter-spacing:0.02em">(optional — your usual first steps, environment quirks, prior knowledge)</span></label>
        <textarea id="techContextInput" data-ticket-id="${ticket.id}" rows="3" placeholder="e.g. My first step is normally to check if the computer is on. Client runs SQL cluster with AG — don't restart primary without failover. Try cached credentials before AD lookup.">${esc(draft)}</textarea>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="abtn abtn-ai" data-action="ticket-analyze" data-ticket-id="${ticket.id}">▶ ANALYZE TICKET</button>
        <button class="abtn abtn-ghost" data-action="open-template-picker" data-ticket-id="${ticket.id}" title="Apply an existing template or create a new one">📋 Templates</button>
      </div>
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
  const appliedTpl = inv.appliedTemplateId ? state.templates[inv.appliedTemplateId] : null;
  const tplBadge = appliedTpl ? `<div class="inv-template-badge">📋 Template: ${esc(appliedTpl.name)}</div>` : '';

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
      ${s.verification ? `<div class="inv-step-verify"><span class="inv-step-verify-label">VERIFY:</span> <input type="text" class="inv-step-verify-input" data-action="inv-step-verification" value="${esc(s.verification)}" placeholder="Success criteria for this step" /></div>` : `<div class="inv-step-verify-empty"><button class="inv-step-add-verify" data-action="inv-step-add-verification">+ Add verification criteria</button></div>`}
      <textarea class="inv-step-notes" data-action="inv-step-notes" placeholder="What did you do / find?" maxlength="${INV_STEP_NOTES_MAX}">${esc(s.notes||'')}</textarea>
    </div>
  `).join('');

  return `<div class="detail-card" id="investigationCard">
    ${headerHtml}
    ${tplBadge}
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
      <button class="abtn abtn-ghost" data-action="open-template-picker" data-ticket-id="${ticket.id}" title="Apply a template to overwrite the current plan">📋 Templates</button>
      <button class="abtn abtn-ghost" data-action="save-as-template" data-ticket-id="${ticket.id}">💾 Save as Template</button>
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

  // Start the timer BEFORE building HTML — so the time badge renders with the active state
  // (only if there's an investigation; otherwise nothing to track).
  // Don't restart if it's already running on this ticket, and don't auto-resume if user has paused.
  if (getInvestigation(ticket.id) && !isTimerActiveFor(ticket.id) && !isTimerPausedFor(ticket.id)) {
    startTicketTimer(ticket.id);
  } else if (!getInvestigation(ticket.id)) {
    stopTicketTimer();
  }

  // Kick off picklist loads in parallel — rebuild when each resolves
  loadAtStatusPicklist().then(() => renderTicketDetail._rehydrateSelects?.(ticket));
  loadAtPriorityPicklist().then(() => renderTicketDetail._rehydrateSelects?.(ticket));
  loadAtQueues().then(() => renderTicketDetail._rehydrateSelects?.(ticket));
  loadAtResources().then(() => renderTicketDetail._rehydrateSelects?.(ticket));
  loadAtBillingCodes().then(() => renderTicketDetail._rehydrateSelects?.(ticket));

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
        <div class="field-group">
          <label>WORK TYPE</label>
          <select class="ticket-field-select" data-field="billingCodeID" data-ticket-id="${ticket.id}" id="tf-worktype"></select>
        </div>
      </div>
      <div class="ticket-save-bar" id="ticketSaveBar-${ticket.id}" style="display:none">
        <span class="ticket-save-summary" id="ticketSaveSummary-${ticket.id}"></span>
        <div class="ticket-save-actions">
          <button class="abtn abtn-ghost" data-action="ticket-discard-changes" data-ticket-id="${ticket.id}">Discard</button>
          <button class="abtn abtn-post" data-action="ticket-save-changes" data-ticket-id="${ticket.id}">💾 Save Changes</button>
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
    const pending = state.pendingTicketEdits[t.id] || {};
    // Resolve effective value: pending edit if present, else ticket's actual value
    const effective = (field) => {
      if (Object.prototype.hasOwnProperty.call(pending, field)) return pending[field];
      const v = t[field];
      return v == null ? '' : String(v);
    };
    const statusSel = document.getElementById('tf-status');
    const prioSel   = document.getElementById('tf-priority');
    const queueSel  = document.getElementById('tf-queue');
    const resSel    = document.getElementById('tf-resource');
    const wtSel     = document.getElementById('tf-worktype');

    if (statusSel && state.atStatusPicklist) {
      const cur = effective('status');
      const entries = Object.entries(state.atStatusPicklist).sort((a,b)=>a[1].label.localeCompare(b[1].label));
      statusSel.innerHTML = entries.map(([v,i]) =>
        `<option value="${v}" ${cur===v?'selected':''}>${esc(i.label)}</option>`
      ).join('');
      statusSel.classList.toggle('ticket-field-dirty', 'status' in pending);
    }
    if (prioSel && state.atPriorityPicklist) {
      const cur = effective('priority');
      const entries = Object.entries(state.atPriorityPicklist);
      prioSel.innerHTML = entries.map(([v,i]) =>
        `<option value="${v}" ${cur===v?'selected':''}>${esc(i.label)}</option>`
      ).join('');
      prioSel.classList.toggle('ticket-field-dirty', 'priority' in pending);
    }
    if (queueSel && state.atQueues?.length) {
      const cur = effective('queueID');
      queueSel.innerHTML = `<option value="">— None —</option>` +
        state.atQueues.map(q =>
          `<option value="${q.id}" ${cur===String(q.id)?'selected':''}>${esc(q.name)}</option>`
        ).join('');
      queueSel.classList.toggle('ticket-field-dirty', 'queueID' in pending);
    }
    if (resSel && state.atResources?.length) {
      const cur = effective('assignedResourceID');
      const sorted = [...state.atResources].sort((a,b)=>a.name.localeCompare(b.name));
      resSel.innerHTML = `<option value="">— Unassigned —</option>` +
        sorted.map(r =>
          `<option value="${r.id}" ${cur===String(r.id)?'selected':''}>${esc(r.name)}</option>`
        ).join('');
      resSel.classList.toggle('ticket-field-dirty', 'assignedResourceID' in pending);
    }
    if (wtSel && state.atBillingCodes?.length) {
      const cur = effective('billingCodeID');
      const sorted = [...state.atBillingCodes].sort((a,b)=>a.name.localeCompare(b.name));
      wtSel.innerHTML = `<option value="">— None —</option>` +
        sorted.map(b =>
          `<option value="${b.id}" ${cur===String(b.id)?'selected':''}>${esc(b.name)}</option>`
        ).join('');
      wtSel.classList.toggle('ticket-field-dirty', 'billingCodeID' in pending);
    }
    updateTicketSaveBar(t.id);
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
      // Strip auto-resolved Information alerts from state so counts stay consistent
      // with what Datto RMM shows after the resolve calls land.
    }
    state.alerts = alerts.filter(a => !state.resolvedIds.has(a.alertUid));
    LS.set('msp_alerts', alerts);
    // Prune incidents whose alerts are gone, then run rule-based clustering on fresh data
    pruneEmptyIncidents();
    runRuleBasedClustering();
    const sites = await fetchSites();
    state.sites = sites;

    // Pull the full active ticket list — same logic as the Tickets-tab refresh.
    // Without this, refreshAll only knows about tickets that are linked to an alert.
    if (state.settings.atUser) {
      try {
        const ticketItems = await fetchAtTicketQueue();
        // Preserve tickets linked to alerts even if outside the active query window
        const linkedTicketNumbers = new Set(alerts.map(a => a.ticketNumber).filter(Boolean));
        const preserved = {};
        linkedTicketNumbers.forEach(tn => {
          if (state.tickets[tn]) preserved[tn] = state.tickets[tn];
        });
        state.tickets = { ...preserved };
        ticketItems.forEach(t => {
          state.tickets[t.ticketNumber] = {
            id:t.id, ticketNumber:t.ticketNumber,
            status:t.status, statusLabel:t.statusLabel, statusColor:t.statusColor, isDone:t.isDone,
            priority:t.priority, queueID:t.queueID, billingCodeID:t.billingCodeID,
            title:t.title, companyID:t.companyID, companyName:t.companyName,
            lastActivity:t.lastActivityDate, createDate:t.createDate,
            assignedResourceID:t.assignedResourceID, assignedResourceName:t.assignedResourceName,
          };
        });
        // Sync any preserved-but-not-fresh tickets, including dropping ghosts
        const freshNumbers = new Set(ticketItems.map(t => t.ticketNumber));
        const stalePreserved = Object.keys(preserved).filter(tn => !freshNumbers.has(tn));
        if (stalePreserved.length) {
          try { await syncTicketStatuses(stalePreserved); } catch(e) { console.warn('Stale preserved sync failed:', e.message); }
        }
        LS.set('msp_tickets', state.tickets);
      } catch(e) { console.warn('Ticket fetch in refreshAll failed:', e.message); }
    }
    // Also sync any link-only tickets that came in from alerts (catches edge cases)
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
    const ticketCount = Object.keys(state.tickets).length;
    showToast(`✓ Refreshed — ${alerts.length} alerts, ${ticketCount} tickets`,'ok');
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
  // Use getVisibleAlerts() so this stays consistent with the dashboard badge —
  // resolved, snoozed, and excluded-client alerts are all filtered out.
  return getVisibleAlerts().filter(a => (a.siteName || '').toLowerCase() === client.name.toLowerCase());
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

function drillMismatchRows(alerts) {
  if (!alerts.length) return '<div class="drill-empty">No mismatches to show.</div>';
  return alerts.map(a => {
    const t = state.tickets[a.ticketNumber];
    const sv = SEV[a.priority] || SEV.Information;
    return `<div class="drill-row" data-action="drill-open-alert" data-alert-uid="${esc(a.alertUid)}">
      <div class="drill-row-main">
        <span class="drill-tn">${esc(a.hostname)}</span>
        <span class="drill-title">${esc(a.alertMessage || '')}</span>
      </div>
      <div class="drill-row-meta">
        <span class="drill-pill" style="color:${sv.color};border-color:${sv.color}55">${esc(a.priority)}</span>
        <span class="drill-tech">${esc(a.ticketNumber || '')}</span>
        <span class="drill-age" style="color:#c8960c" title="Ticket is closed but alert still open">⚠ closed ticket</span>
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

// Cache for client trend data — recomputed when fresh ticket data arrives
const CLIENT_TREND_CACHE_TTL = 5 * 60 * 1000;
state._clientTrendCache = null;

async function ensureClientTrendData(days = 30) {
  // Pull resolved tickets for the window once, cache the entire pool
  if (state._clientTrendCache && Date.now() - state._clientTrendCache.fetchedAt < CLIENT_TREND_CACHE_TTL) {
    return state._clientTrendCache;
  }
  let resolved = [];
  try { resolved = await fetchResolvedTicketsForReports(days); }
  catch(e) { console.warn('Trend resolved fetch failed:', e.message); }
  state._clientTrendCache = {
    fetchedAt: Date.now(),
    resolved,
    days,
  };
  return state._clientTrendCache;
}

// Build a daily open-ticket count series for one client over the window.
// Uses currently-open tickets from state.tickets + resolved tickets from the cache.
function buildClientTicketTrend(client, trendCache) {
  if (!client?.atId || !trendCache) return null;
  const days = trendCache.days || 30;
  const now = Date.now();
  const today = new Date(); today.setHours(23, 59, 59, 999);
  // Build day buckets from oldest to newest
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    buckets.push({ endMs: d.getTime(), count: 0 });
  }
  // Combine open + resolved tickets, but only for this client
  const clientResolved = trendCache.resolved.filter(t => t.companyID === client.atId);
  const clientOpen = Object.values(state.tickets).filter(t => !t.isDone && t.companyID === client.atId);
  const allClientTickets = [...clientOpen, ...clientResolved];

  for (const t of allClientTickets) {
    const createMs = t.createDate ? new Date(t.createDate).getTime() : null;
    if (!createMs) continue;
    // Resolved date — for resolved tickets prefer resolvedDateTime, fallback to lastActivityDate
    const resolvedMs = t.resolvedDateTime ? new Date(t.resolvedDateTime).getTime()
                     : (clientResolved.includes(t) && t.lastActivityDate) ? new Date(t.lastActivityDate).getTime()
                     : null;
    // For each bucket, increment if ticket was open at end-of-day for that bucket
    for (const b of buckets) {
      if (createMs > b.endMs) continue; // not created yet at this point
      if (resolvedMs && resolvedMs <= b.endMs) continue; // already resolved by this point
      b.count++;
    }
  }
  return buckets;
}

function svgSparkline(values, opts = {}) {
  if (!values?.length) return '';
  const w = opts.width || 80;
  const h = opts.height || 18;
  const max = Math.max(1, ...values);
  const min = 0; // always anchor to 0
  const range = max - min || 1;
  const step = values.length > 1 ? (w - 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const x = 1 + i * step;
    const y = h - 1 - ((v - min) / range) * (h - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const color = opts.color || '#00b4d8';
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="none" style="display:block">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;
}

// Trend delta: compare last 7 days avg vs prior 7 days avg
function trendDelta(values) {
  if (!values || values.length < 14) return null;
  const recent = values.slice(-7).reduce((a, b) => a + b.count, 0) / 7;
  const prior = values.slice(-14, -7).reduce((a, b) => a + b.count, 0) / 7;
  if (prior < 0.5 && recent < 0.5) return null; // basically zero, no trend
  if (prior === 0) return { dir: recent > 0 ? 'up' : 'flat', pct: null };
  const pct = Math.round(((recent - prior) / prior) * 100);
  if (Math.abs(pct) < 10) return { dir: 'flat', pct };
  return { dir: pct > 0 ? 'up' : 'down', pct };
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
        <span class="client-trend" data-trend-for="${esc(c.name)}"><span class="client-trend-loading">…</span></span>
        ${alertsN ? `<span class="client-stat client-stat-alerts">${alertsN} alerts</span>` : ''}
        ${ticketsN ? `<span class="client-stat client-stat-tickets">${ticketsN} tickets</span>` : ''}
        ${offline ? `<span class="client-stat client-stat-offline">${offline} offline</span>` : ''}
        ${c.dattoDeviceCount != null ? `<span class="client-stat client-stat-devices">${c.dattoDeviceCount} devices</span>` : ''}
        <button class="client-hide-btn" data-action="toggle-client-hidden" data-client-name="${esc(c.name)}" title="${isHidden?'Show this client':'Hide this client'}">${isHidden?'👁':'🙈'}</button>
      </div>
    </div>`;
  }).join('');

  // Async: hydrate sparklines once trend data is ready
  hydrateClientTrends(filtered);
}

async function hydrateClientTrends(clients) {
  const trendCache = await ensureClientTrendData(30);
  if (!trendCache) return;
  clients.forEach(c => {
    const slot = document.querySelector(`.client-trend[data-trend-for="${CSS.escape(c.name)}"]`);
    if (!slot) return;
    if (!c.atId) { slot.innerHTML = ''; return; }
    const trend = buildClientTicketTrend(c, trendCache);
    if (!trend || trend.every(b => b.count === 0)) {
      slot.innerHTML = '<span class="client-trend-empty">no activity</span>';
      return;
    }
    const values = trend.map(b => b.count);
    const max = Math.max(...values);
    // Color by overall scale — more red for higher counts
    const color = max >= 10 ? '#c8102e' : max >= 5 ? '#e07b00' : max >= 2 ? '#c8a000' : '#2a9d5c';
    const delta = trendDelta(trend);
    let deltaIcon = '';
    if (delta) {
      if (delta.dir === 'up')   deltaIcon = `<span class="client-trend-delta client-trend-up" title="Worsening: ${delta.pct}% more tickets vs prior 7 days">↑${delta.pct != null ? Math.abs(delta.pct) + '%' : ''}</span>`;
      else if (delta.dir === 'down') deltaIcon = `<span class="client-trend-delta client-trend-down" title="Improving: ${Math.abs(delta.pct)}% fewer tickets vs prior 7 days">↓${Math.abs(delta.pct)}%</span>`;
      else                       deltaIcon = `<span class="client-trend-delta client-trend-flat" title="Stable">→</span>`;
    }
    slot.innerHTML = svgSparkline(values, { color }) + deltaIcon;
  });
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

// fmtDuration imported from utils.js

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

  // Tracked labor — sum tracked time across all investigations within the window
  const cutoffMs = Date.now() - days * 86400000;
  const laborTotals = { totalMs: 0, byTech: {}, ticketCount: 0 };
  Object.values(state.investigations || {}).forEach(inv => {
    if (!inv?.timeTracking?.sessions) return;
    const sessionsInWindow = inv.timeTracking.sessions.filter(s => (s.endMs || s.startMs) >= cutoffMs);
    if (!sessionsInWindow.length) return;
    laborTotals.ticketCount++;
    sessionsInWindow.forEach(s => {
      const dur = s.durationMs || 0;
      laborTotals.totalMs += dur;
      const tech = s.tech || 'Unknown';
      laborTotals.byTech[tech] = (laborTotals.byTech[tech] || 0) + dur;
    });
  });

  // ─── TREND SERIES & PRIOR-PERIOD COUNTS FOR STAT CARDS ───
  const trendCutoffMs = Date.now() - days * 86400000;
  const priorWindowStartMs = Date.now() - 2 * days * 86400000;

  // Per-day buckets for current window
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const dayBuckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    dayBuckets.push({
      endMs: d.getTime(),
      startMs: d.getTime() - 86400000,
      ticketsResolved: 0,
      alertsResolved: 0,
      ticketMttrSamples: [],
      alertMttrSamples: [],
      laborMs: 0,
    });
  }

  const bucketForMs = (ms) => dayBuckets.find(b => ms > b.startMs && ms <= b.endMs);

  // Tickets resolved per day + ticket MTTR per day
  resolvedTickets.forEach(t => {
    const resolvedMs = (t.resolvedDateTime || t.lastActivityDate)
      ? new Date(t.resolvedDateTime || t.lastActivityDate).getTime() : null;
    if (!resolvedMs) return;
    const b = bucketForMs(resolvedMs);
    if (!b) return;
    b.ticketsResolved++;
    if (t.createDate) {
      const dur = resolvedMs - new Date(t.createDate).getTime();
      if (dur > 0) b.ticketMttrSamples.push(dur);
    }
  });

  // Alerts resolved per day + alert MTTR per day
  resolvedAlerts.forEach(a => {
    if (!a.resolvedMs) return;
    const b = bucketForMs(a.resolvedMs);
    if (!b) return;
    b.alertsResolved++;
    if (a.timestampMs) {
      const dur = a.resolvedMs - a.timestampMs;
      if (dur > 0) b.alertMttrSamples.push(dur);
    }
  });

  // Labor per day from investigations
  Object.values(state.investigations || {}).forEach(inv => {
    inv.timeTracking?.sessions?.forEach(s => {
      const ms = s.endMs || s.startMs;
      if (!ms) return;
      const b = bucketForMs(ms);
      if (b) b.laborMs += s.durationMs || 0;
    });
  });

  // Compute MTTR per day as rolling 7-day average for smoother sparkline
  const ticketMttrSeries = dayBuckets.map((_, i) => {
    const window = dayBuckets.slice(Math.max(0, i - 6), i + 1);
    const samples = window.flatMap(b => b.ticketMttrSamples);
    return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  });
  const alertMttrSeries = dayBuckets.map((_, i) => {
    const window = dayBuckets.slice(Math.max(0, i - 6), i + 1);
    const samples = window.flatMap(b => b.alertMttrSamples);
    return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  });

  // Prior-period counts (for delta calculation, not for sparkline)
  const priorTicketsResolved = priorTickets.filter(t => {
    const r = (t.resolvedDateTime || t.lastActivityDate)
      ? new Date(t.resolvedDateTime || t.lastActivityDate).getTime() : 0;
    return r >= priorWindowStartMs && r < trendCutoffMs;
  }).length;

  let priorAlertsResolved = 0;
  try {
    const priorAlerts = await fetchResolvedAlertsForReports(days * 2);
    priorAlertsResolved = priorAlerts.filter(a => a.resolvedMs >= priorWindowStartMs && a.resolvedMs < trendCutoffMs).length;
  } catch(e) { /* leave at 0 */ }

  // Prior labor — sessions in prior window
  let priorLaborMs = 0;
  Object.values(state.investigations || {}).forEach(inv => {
    inv.timeTracking?.sessions?.forEach(s => {
      const ms = s.endMs || s.startMs;
      if (ms >= priorWindowStartMs && ms < trendCutoffMs) priorLaborMs += s.durationMs || 0;
    });
  });

  return {
    days,
    ticketsResolvedCount: resolvedTickets.length,
    alertsResolvedCount: resolvedAlerts.length,
    ticketMttr, priorMttr, alertMttr,
    techRows,
    topClients,
    agingTickets,
    laborTotals,
    alertTrendBuckets: await buildAlertTrendData(days),
    // Trend data for stat cards
    trendSeries: {
      ticketsResolved: dayBuckets.map(b => b.ticketsResolved),
      alertsResolved: dayBuckets.map(b => b.alertsResolved),
      ticketMttr: ticketMttrSeries,
      alertMttr: alertMttrSeries,
      labor: dayBuckets.map(b => b.laborMs),
    },
    priorPeriodCounts: {
      ticketsResolved: priorTicketsResolved,
      alertsResolved: priorAlertsResolved,
      laborMs: priorLaborMs,
    },
  };
}

function trendArrow(current, prior) {
  if (current == null || prior == null) return '';
  if (Math.abs(current - prior) / prior < 0.05) return '<span style="color:var(--textdim)">→ flat</span>';
  if (current < prior) return `<span style="color:#2a9d5c">↓ ${Math.round((1-current/prior)*100)}% better</span>`;
  return `<span style="color:#c8102e">↑ ${Math.round((current/prior-1)*100)}% slower</span>`;
}

// Trend badge for Reports stat cards. lowerIsBetter: false (default) = up arrow is bad (e.g. tickets opened);
// lowerIsBetter: true (e.g. MTTR) = up arrow is bad (slower is bad), down arrow is good.
// Actually for both meanings: ↑ on a count metric = "worse" if higher; ↓ on a duration metric = "better".
// We use a single rule: caller picks color via lowerIsBetter flag.
function reportsTrendBadge(current, prior, opts = {}) {
  if (current == null || prior == null || (current === 0 && prior === 0)) return '';
  if (prior === 0) {
    // No prior data — just show direction without %
    return current > 0
      ? `<span class="rpt-trend rpt-trend-flat" title="No prior period to compare">new</span>`
      : '';
  }
  const pct = Math.round(((current - prior) / prior) * 100);
  if (Math.abs(pct) < 10) {
    return `<span class="rpt-trend rpt-trend-flat" title="Within 10% of prior period">→ flat</span>`;
  }
  // For MTTR (lowerIsBetter=true), going up is bad. For counts (lowerIsBetter=false default), depends.
  // For "more tickets resolved" the user generally wants UP = good. So flip color logic via 'upIsGood'.
  const upIsGood = opts.upIsGood === true;
  const goingUp = pct > 0;
  const isGood = goingUp === upIsGood;
  const cls = isGood ? 'rpt-trend-good' : 'rpt-trend-bad';
  const arrow = goingUp ? '↑' : '↓';
  return `<span class="rpt-trend ${cls}" title="${goingUp?'Up':'Down'} ${Math.abs(pct)}% vs prior ${opts.windowLabel||'period'}">${arrow} ${Math.abs(pct)}%</span>`;
}

// Tiny sparkline — same look as the client-trend one but configurable color
function reportsSparkline(values, opts = {}) {
  if (!values?.length) return '';
  return svgSparkline(values, { width: opts.width || 90, height: opts.height || 20, color: opts.color || '#00b4d8' });
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
          <button class="reports-range-btn" data-action="reports-generate-report" title="Generate PDF compliance report" style="background:var(--accent);color:#fff;border-color:var(--accent)">📄 Report</button>
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

  // Trend visuals — sparkline + delta badge per metric
  const tr = data.trendSeries || {};
  const pp = data.priorPeriodCounts || {};
  // For MTTR series, we want a sparkline of the rolling avg in *minutes* for chart scaling
  const ticketMttrSeriesMin = (tr.ticketMttr || []).map(ms => ms / 60000);
  const alertMttrSeriesMin = (tr.alertMttr || []).map(ms => ms / 60000);
  const laborSeriesMin = (tr.labor || []).map(ms => ms / 60000);

  body.innerHTML = `
    <!-- Top stats row -->
    <div class="reports-stats">
      <div class="reports-stat-card">
        <div class="reports-stat-label">TICKETS RESOLVED</div>
        <div class="reports-stat-value">${data.ticketsResolvedCount}</div>
        <div class="reports-stat-spark">${reportsSparkline(tr.ticketsResolved, { color: '#2a9d5c' })}</div>
        <div class="reports-stat-sub">${reportsTrendBadge(data.ticketsResolvedCount, pp.ticketsResolved, { upIsGood: true, windowLabel: data.days+'d' })} <span class="reports-stat-window">last ${data.days} days</span></div>
      </div>
      <div class="reports-stat-card">
        <div class="reports-stat-label">ALERTS RESOLVED</div>
        <div class="reports-stat-value">${data.alertsResolvedCount}</div>
        <div class="reports-stat-spark">${reportsSparkline(tr.alertsResolved, { color: '#2a9d5c' })}</div>
        <div class="reports-stat-sub">${reportsTrendBadge(data.alertsResolvedCount, pp.alertsResolved, { upIsGood: true, windowLabel: data.days+'d' })} <span class="reports-stat-window">last ${data.days} days</span></div>
      </div>
      <div class="reports-stat-card">
        <div class="reports-stat-label">MTTR — TICKETS</div>
        <div class="reports-stat-value">${fmtDuration(data.ticketMttr)}</div>
        <div class="reports-stat-spark">${reportsSparkline(ticketMttrSeriesMin, { color: '#c8a000' })}</div>
        <div class="reports-stat-sub">${ticketTrend || '<span class="reports-stat-window">no prior period</span>'}</div>
      </div>
      <div class="reports-stat-card">
        <div class="reports-stat-label">MTTR — ALERTS</div>
        <div class="reports-stat-value">${fmtDuration(data.alertMttr)}</div>
        <div class="reports-stat-spark">${reportsSparkline(alertMttrSeriesMin, { color: '#c8a000' })}</div>
        <div class="reports-stat-sub"><span class="reports-stat-window">last ${data.days} days</span></div>
      </div>
      <div class="reports-stat-card">
        <div class="reports-stat-label">TRACKED LABOR</div>
        <div class="reports-stat-value">${esc(fmtMsAsDuration(data.laborTotals.totalMs))}</div>
        <div class="reports-stat-spark">${reportsSparkline(laborSeriesMin, { color: '#00b4d8' })}</div>
        <div class="reports-stat-sub">${reportsTrendBadge(data.laborTotals.totalMs, pp.laborMs, { upIsGood: true, windowLabel: data.days+'d' })} <span class="reports-stat-window">${data.laborTotals.ticketCount} ticket${data.laborTotals.ticketCount!==1?'s':''}</span></div>
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

    <!-- Tracked labor per tech -->
    ${Object.keys(data.laborTotals.byTech || {}).length ? `<div class="reports-card">
      <div class="card-label">⏱ TRACKED LABOR PER TECH (last ${data.days} days)</div>
      ${svgBarChart(
        Object.entries(data.laborTotals.byTech)
          .map(([name, ms]) => ({ label: name, value: Math.round(ms / 60000) })) // minutes for chart scaling
          .sort((a, b) => b.value - a.value),
        { labelW: 130 }
      )}
      <div class="reports-tech-detail">
        ${Object.entries(data.laborTotals.byTech)
          .sort((a,b) => b[1] - a[1])
          .map(([name, ms]) => `<div class="tech-detail-row">
            <span>${esc(name)}</span>
            <span class="tech-avg-age">${esc(fmtMsAsDuration(ms))}</span>
          </div>`).join('')}
      </div>
    </div>` : ''}

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

// ─── COMPLIANCE VIEW ────────────────────────────────────────────────
async function renderComplianceView(forceRefresh = false) {
  const root = document.getElementById('view-compliance');
  if (!root) return;

  root.innerHTML = `
    <div class="clients-wrap">
      <div class="clients-header">
        <div class="clients-title">🛡 Compliance</div>
        <input id="complianceSearch" type="text" placeholder="Filter clients..." class="clients-search" />
        <button id="complianceWarrantyBtn" class="reports-range-btn" data-action="compliance-warranty-toggle" title="Toggle warranty issue visibility">🔖 Warranty OFF</button>
        <button class="reports-range-btn" data-action="compliance-generate-report" title="Generate PDF compliance report" style="background:var(--accent);color:#fff;border-color:var(--accent)">📄 Report</button>
        <button class="reports-range-btn" data-action="compliance-refresh" title="Refresh compliance data">↺</button>
      </div>
      <div id="complianceBody"><div class="loading-state">Loading device compliance data...</div></div>
    </div>`;

  try {
    const devices = await fetchAllDevices(forceRefresh);
    renderComplianceBody(devices, '', state.complianceShowWarranty);

    // Wire search
    document.getElementById('complianceSearch')?.addEventListener('input', e => {
      renderComplianceBody(devices, e.target.value.toLowerCase().trim(), state.complianceShowWarranty);
    });
  } catch(e) {
    document.getElementById('complianceBody').innerHTML =
      `<div class="loading-state" style="color:#c8102e">Error: ${esc(e.message)}</div>`;
  }
}

function renderComplianceBody(devices, filter, warrantyOn = false) {
  const body = document.getElementById('complianceBody');
  if (!body) return;

  // Group by site
  const bySite = {};
  for (const d of devices) {
    const site = d.siteName || 'Unknown';
    if (!bySite[site]) bySite[site] = [];
    bySite[site].push(d);
  }

  // Sort sites: most issues first
  const siteEntries = Object.entries(bySite)
    .filter(([name]) => !filter || name.toLowerCase().includes(filter))
    .map(([name, devs]) => {
      const withIssues = devs.filter(d => getDeviceComplianceStatus(d, warrantyOn).length > 0);
      const offline    = devs.filter(d => !d.online);
      return { name, devs, withIssues, offline };
    })
    .sort((a, b) => b.withIssues.length - a.withIssues.length);

  if (!siteEntries.length) {
    body.innerHTML = '<div class="loading-state">No clients match.</div>';
    return;
  }

  const totalDevices  = devices.length;
  const totalIssues   = devices.filter(d => getDeviceComplianceStatus(d, warrantyOn).length > 0).length;
  const totalClean    = totalDevices - totalIssues;

  body.innerHTML = `
    <div class="compliance-summary">
      <div class="compliance-summary-stat">
        <span class="compliance-summary-val" style="color:#2a9d5c">${totalClean}</span>
        <span class="compliance-summary-lbl">Clean</span>
      </div>
      <div class="compliance-summary-stat">
        <span class="compliance-summary-val" style="color:#c8102e">${totalIssues}</span>
        <span class="compliance-summary-lbl">Issues</span>
      </div>
      <div class="compliance-summary-stat">
        <span class="compliance-summary-val" style="color:var(--textdim)">${totalDevices}</span>
        <span class="compliance-summary-lbl">Total Devices</span>
      </div>
    </div>
    <div class="compliance-grid">
      ${siteEntries.map(({ name, devs, withIssues, offline }) => {
        const clean = devs.length - withIssues.length;
        const pct   = devs.length > 0 ? Math.round((clean / devs.length) * 100) : 100;
        const barColor = pct === 100 ? '#2a9d5c' : pct >= 75 ? '#c8960c' : '#c8102e';
        return `
          <div class="compliance-card" data-action="compliance-drill" data-site="${esc(name)}">
            <div class="compliance-card-name">${esc(name)}</div>
            <div class="compliance-card-stats">
              <span style="color:#2a9d5c">${clean} clean</span>
              <span style="color:#c8102e">${withIssues.length} issues</span>
              <span style="color:var(--textdim)">${devs.length} total</span>
            </div>
            <div class="compliance-bar-track">
              <div class="compliance-bar-fill" style="width:${pct}%;background:${barColor}"></div>
            </div>
            <div class="compliance-card-pct" style="color:${barColor}">${pct}%</div>
          </div>`;
      }).join('')}
    </div>`;
}

function renderComplianceDrill(siteName, devices) {
  const siteDevs = devices.filter(d => d.siteName === siteName);
  if (!siteDevs.length) return '<div class="drill-empty">No devices found.</div>';

  // Sort: issues first, then alpha
  siteDevs.sort((a, b) => {
    const ai = getDeviceComplianceStatus(a, state.complianceShowWarranty).length;
    const bi = getDeviceComplianceStatus(b, state.complianceShowWarranty).length;
    if (bi !== ai) return bi - ai;
    return a.hostname.localeCompare(b.hostname);
  });

  return siteDevs.map(d => {
    const issues = getDeviceComplianceStatus(d, state.complianceShowWarranty);
    const online = d.online;
    const onlineColor = online ? '#2a9d5c' : '#c8102e';
    const chips = issues.map(i =>
      `<span class="drill-pill" style="color:${i.color};border-color:${i.color}55">${esc(i.label)}</span>`
    ).join('');
    const cleanChip = issues.length === 0
      ? `<span class="drill-pill" style="color:#2a9d5c;border-color:#2a9d5c55">✓ Clean</span>`
      : '';

    return `
      <div class="drill-row">
        <div class="drill-row-main">
          <span class="drill-tn" style="color:${onlineColor}" title="${online?'Online':'Offline'}">${online?'●':'○'}</span>
          <span class="drill-title">${esc(d.hostname)}</span>
          <span class="drill-tech" style="color:var(--textdim)">${esc(d.operatingSystem?.replace('Microsoft ','') || '')}</span>
        </div>
        <div class="drill-row-meta">
          ${chips}${cleanChip}
          ${d.lastLoggedInUser ? `<span class="drill-age">${esc(d.lastLoggedInUser.split('\\').pop())}</span>` : ''}
        </div>
      </div>`;
  }).join('');
}

// ─── PDF COMPLIANCE REPORT ─────────────────────────────────────────
const SYNOBIS_LOGO_B64 = 'data:image/png;base64,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XvbIB9sOUSQxgMmG/89//vP6kEMOYePGjXz6058Wxx57rE7TlBtvvFFEUURXdy9vfOMb9VlnnUUURfzwhz/kpptuElEBkWkNrB8EHH744fpDH/oQUkp++9vfctUPrxTNhnEKP/nJT+qFCxfiui6f+9znePihh4SZodyhWqvRbDQ448wz9Tve8Q5c1+WGG27gO9/6tuju7mZiYmIKgBDg61//uq5UKiil+Lu/+zvWr18vgHwiUrlc5nXnXaAvvPBCkiThvvvu40tf+pJA6ylOwUknn6zf+c53cscdd/DNb35TWBIIm41405vepC+88EI6nQ433XQTV199tbBc1W984xv10qVLabVaPPnkk/zHf/yHaDabuyFjX/e61+k3vOEN9Pb2cvvtt/PjH/+YL33pS4yOjlKr1YiiiH/+53/moYceElJK5s6dq//1X/+V8YkJtm/fzmc+8xnR6XRAa4JSCc/z+Od//mfd1dXF5Zdfzsr77xdgHJY0TdFKZej2cMq1WEMfxzH77ruv/ru/+zs8z+OWW27hiiuuEFYXveUtb9Fnn302K1as4Mtf/rKw+6XYhnPJJZfo888/n0ajwfXXX89Pf/pTAdDb28sFF1ygX/e619EOO9x3333893//t2g0GjnS13GcHIvxve9/X9uo9tK3vtWmjrLOB4kfBLz//e/Xhx56KL7v87GPfUxs3bLFvCwzDDLLfHz84x/XBx10EFEUcfnll/PImlXCpnptBPqZz3xG77fffiRJwvve9z5he3VhskbuOI7RRe0WBx50kP7whz9MX1+fXRvjqGXX6GcpabTmkre8RV9wwQW0222uv/56rv7Rj4Sbca5fcskl+pRTTkEpxerVq/nqV78qbD3eGrdqtcpRRx2l3/3ud+O6Lr+64UZ+9atfibe+9a362muvZe3atcJxHA477DD9wQ9+kGq1ytq1a/n617/OU089tZs+OnDxQfpzn/scO3fuZMWKFXz7W98S9rovfdvb9Nlnn81NN93Ed7/7XbErhsRxXdL45VGyezZ5znyC3dQ2FaS15q677hI/+tGP8s08ODjI+Pg4nufR3d3N3/3d3/GmN71JS8ehUa/jBwGu5xF2Orli0JmRsyCJojdm5cVKydimbps+sQfapk7drHaklKLVbOIHAW+99FL9rne9K48eLAuWBRdYY/tSi3Ug4jjG9vK1Wi3+8z//82VvYIGc6aaI7uzu7s7pKW2abtasWRxxxBH6vvvu47e//a2w6bz6xATf+ta3xNatWwnDkPe+9714npfP+QXzXKu1GgceeKD+8Ic/TLlcZvny5XzjiiuErTNGYci//Mu/iE6nw/DwMB/96EcZyAAvjuua9ifIxxnavSCEYGJiIndy7HW5rsuTTz6ZA4EWLVpEuVxGa00Yhjm5xfHHH58blkMPPTTPqBQdzv7+fnzfZ9WqVSRxjMqyPK7n8eY3v1mfe+65SCn5p3/6J37wgx8I284RhiFXXXWV+MEPfsDs2bM58sgj+cQnPrFbjrtcLrNz5066urrodDrMmDGDf/iHf2B8fBzf94njmFarRaVSyRmfGo2GaDabdHV10dvbizWwYJzjT33qU3pwcJB//ud/ZuXKlblhSuJ4SttZEARTmJSUUkRRRH9/Px//+Mfp6+tj8+bNXHHFFcI6LEII7rrrLlzXZWJiIn8uQK5Pzj//fP36178eIQRf/vKX+dnPfibsZ4yNjfHDH/5QfPvb36a7u5vjjjuOv/zLv9TlctlEsFmK9vmMgvSyyGz+/Pn09fVNbZ/JokAbRVqdV6lUCIKAUuaM2HNg90GtVstbeew923VtNpv53rP6Z9OmTaKnp4dWq2Xqu4X1dD2PKAxzA3vWWWeRJAlf/OIXufpHPxKe75OmKc1Gg+9973vim9/8JmEYcswxx/C+971PW33tuKadstlo5G1ONrty/vnn68suu0xs2LBBWOKWlStXiu985zskScLChQt5zWtek5e0rI6v1Wp85CMfodVqsW3bNr79rW8Jk/U0jsHy5cuntFBJx8EPgnwiXPoSBzjPV57TyNoFSdOUOI5ztNv3v/99sXz5cjNrVim6u7tzhSmy+ar/+3//b33Y4YdrIK/tWnE9bzJFm4lNT1uD/mKg96xxtWAVKxYtaj+nq7sbtGb2nDn8zd/8jT7nnHOQUuZgj0qlkoM/bNrw5QAesqmqarVKq9XC8zy++MUv5srnlSBFRaK1zq/d3lu73abRaOA4DhMTE7lhLBqi22+/nWq1yo4dOzj99NONcsj2W7Vapdlo8Na3vpUkSQjDkCuvvFJUa7Upe7DZbHLLLbcwbdo0fN/nzDPP1GTpSYBqrYbv+0xMTDA2NobrurmjZveqPR9JknDXXXfRbrfxfZ+jjz56N3q86dOnM2PGDLZv344QgkqlwsxZs/Cy+c2O6yIdhxNOOIE4jrnnnnuEdByCUokkjtl///31eeedR3d3N7fffjuPPfaYSZVnE6CswfrVr34l7rvvPkZHRznwwAM5/fTTddGZbbfb+TNotVoMDAywatUqPvnJT4q3ve1t4pJLLhF/9Vd/Je68886c4MDzPHp7ewnD0JyRLIIVUvKRj3xEz5w5ky9/+cs88sgjeWTuOA4iywCBwQVYhwOMo6WUIggCyuUy3d3dbN++nWq1Snd3d25UyuUyXV1dxHFMpVLJnRcwWapFixbpSy+9lE6nw4oVK1i5cqWwKWQL8lRKccMNN4i77roLpRRHHHEEBx98sCFSzXAqzwd9rzK0pm1vzPuE7X0KQZxN4wpKpbzmK4QZvGIBdXY/W9SyRWfb11sdZs+FdfS6e3rwfZ8gCHJcjd33YaeTR+OHHHqofsMb3oDrutx99908sHKlCDKglFaKoFSi3WqxbNkyMTIyQqPR4IgjjuD0M87QQRBMGjQh6OrqQgiB7/scfPDB/Pd//7coIq5tQLJixQrRbDZRSnHKKafkOAZ7H7NmzdIW3DVnzhyA/KzFcUx3d/dk+1L2PKJsJjaQZ0Nf7vKcV2m9FSBP49hF+sY3viFuv/12Op1OXg8MgiB/4AcddBAf+MAHePvb365nzJyZ9cwaMoQkjqlUq7mispvI1mJfLAOmC0oSTDqqp6cnvycr9YkJzj7nHP2pT31KL1q0CDAHtru7O6/vWC9UKUW9Xs+VxUspVilZ6P8XvvAF1q9fL4r9zy93sYcmCAIqmZdaLpeJ45gkSZgzZw5KKVatWsXY2BgwSUUH5gBasEqlUmFwcBA3M3YAjXqdVx9zjF6wYEGOFg3DkGajMSXixbRD5AbqkEMOMem+bL/baLarqwvf9/MeyyKKtpQpUiA3nlJK+vv782i9VqsRxzEnnniijqKIX/7yl3mEePLJJ2v79/bs9ff3s2PHDhOlZYpXSMlZZ50FwNjYGHfeeWfu+Nn6b1dXV74Ga9asoVarUa/XOf3006egZYvX3dPTQxiGfOlLXxKbN2/OX2OnTNmaWbPZZHR0NH9OlWqVsNPhL//yL/Whhx7KD37wA5bdemue4hNCkGZpxzBzxkuFM7graM/Wc7u6upg2bRrHH3+8MYCuS6vVymu9nU4nN0J2zU444YR8b9x+++34vk+lUsmfi31/IQSPPvoo5XKZkZERLrzwwnxv7RoAPJMUnSvHcXLHw96n7/uQ3XvY6eQgqiRJ6O42RDaO40zRR1YnWmNqf2YdHOs8hWHIxPg4YWZ4KoWZ39YAScfB9TzOOOMMxsfHabfbrFixAiGleQ5ZhGifSRLH3HXXXcRxTKPR4OSTT85Bk7WuLsgcgTAMGR8fz8lIOp1Ofg6klDmpkQ3OBgcH6e3tza8vq7uKoaEhyuUy5XKZ0884YxJakzkZ1jB7vk9QKuXdEa8keV6uQPHhgtmk1pP86le+In7961/j+37uxY+OjuJ5Hq1Wi1qtxmmnncanP/1p/Za3vlV3d3fnhfRWlu/fFWq+K6LuhYo1kLambDeb3RQnnXSS/s8vf1m/5z3vYWBgAM/zGB8fR0qZp4ptatAq15cLCbfv+3Syw3z11Vdz1113CYsGfbmTs4O5fru2NtUNk+k/KSUTExP5gAOR1YVsPdymjtatW4d1LAYGBkw0kKb4mSM0f/78PJsxPDycG7w4iqjWaoCJYMbHx9Fa5wpQK0USx1MMgmUCsmUOi1cAqGf4g3K5zJo1a4Q1eAsXLmTJkiUaoNFoIKXk6KOPJgxDfvvb34p6vY5SiiOPPBKVprkyOfTQQ7Xnedx77735fkuy6OOAAw4gTVN6e3vZsWNHHklYJ9deS5IkPPDAA1QqFXp7e+nv7897McG0itTr9Rw1vGHDhjwrVTybaZrm61Yul3OwTE9PD61mk3e/5z36+OOP54tf/CI33HCDsGsvM6MCRvmXKxVcz6OTga3s+bLlgSiKaDQaDA8P59dxySWX8Ld/+7d62rRpCCFYtWqVeNOb3iSuueYasWuW6ogjjmB4eJju7m6GhobydPeU55rtlSeeeIJ2u01fXx/77rvvlP7xKQ7YM0lmAOxzjaKIepaJcVwXiw0QhQjNRntRFFGtVkmShHa7nXd02NpwrVbLjZe9PxvlW3GzEp3NAtjaazGwSOI4L1fMmDGDHTt2TGnBsvVb1/OQjsMDDzxAtVqlq6uL/fbbj0r22kbmZDqOg+d5DA4Osn79+jyQsU6uvVbHcVi3bl2uc+fNm6et0yalZPPmzTlAKo5jPvjBD/LXf/3Xetr06QgpWb1qlXjb294m/utrXxNxFBFmZ8nz/ef3bF4m8ryMrE3bwWQds16vU61WEVLywx/+UPzTP/1THpHaQ2s9F0vTeNZZZ/Ev//Iv+l3vfreev2CBLr6fTRXn0cmLZMCK0VzxPQcHBznmmGP016+4Qr/97W8nCAIajQYjIyPEccycOXOo1+uUSqV8w9nNYoEKL4d0cSfzjn/xi1/ws5/9TJTLZTqdTl7fermLVfSVSiXfYzadaqMD245Qr9eFjaIscKjdauVAGzCKwLZZALmS6+7uzrEFTz31FFopSuUyXd3dNBuNDIRjUlRJkjA6Okq1Ws0VjDUuNiVn8QN2Soollu/J0ncWxPLQQw8BJtqcM2dOfm+zZ89m/vz5PProoyRxzJo1a5BSMjAwQF9/f75X99lnH2q1Ghs3bsw9+HKlwuC0afT39+O6Lp1Oh7GxMWGjQatwLTgvCAK2bdsmWq0WIyMjTJs2jdmzZ2u71hMTEwRBkDsv1kjbdfc8L6cahEmMg+saZGitVuNb3/62PuaYY0iShOOOOw4ppVl7IYwSz1KoQgjarVbOn50kSf7cW61W/r6NRoN//dd/FUUjs//++3PZZZfpd7zjHXru3Lk5UrfY/jJr1iwWLFiA7/uMjo7S6XSElDJvQ7KlCNt2NDY2JsbGxnJE79y5c7V95r9Pm1tvb29O0FHc29YJtM9Ta02tVqOvry8nN7H7yn7v6uqypZH8HNt1CgvpUhu5WgfGUuNKx8nTu0op+vr76evrI01Ttm7dSr1eFxaMaq/PtmuqNKXRaIiiUztv3jx78bieh9aaTqfDxMRE7mxZh7PVauWkRhaQ2dfXl++fYjYB4O///u+FdaQajQaHHnool19+uf7zP/9zPThtWv66SmZr0Jo4ivI09ytBnlc+0aL/pJREUZTDsJvNJkIab23VqlXiK1/5in7Tm95ET08PtVqNsbGx/JDmaaVKhTPPPJNjjz2WzZs361/fdCOPP/642LlzZ64Y8ot7EQjYbZHebtR9991Xn3LKKRx99NH09/fTCQ1gyP6+u7ubKIrYsWMHfX199iBSq9Vyg23Xw6bQXkqRUrJhwwauvfZaYWs9lmf3lUBgbx2worIpRohADrqxaTaLJG232whp7rHRaOS1SEse4GcAkTiK6O3tzffuqaeeyqmnnqqjKEI6JtVnU4i2zQBg27ZttJpNnMJ4tyKyPIoiyuUyrVYrBzhZshZ7bxs2bOC4447DdV0OO+wwfvOb3yCE4IgjjtBCCJYtW4bn+6xZs4YTTjgBgMMOO0wvu/VW4bgur3rVq3j66ad5+OGHhU1dt1stent7c4VugU7tdntK5Gl7LcHUv6SUlMvlvL5d5Bb2fZ+hoaF8nWAyE2IR/vbcF9eq0+nQarX4wAc+IN6SIVcPPfRQTjrpJH3LLbcIlaZmyEamFDUmqpNS5oagONKtuF+3bdvGZZddxiWXXMLBBx+c94CeeeaZnHrqqfrqq6/m+uuvF2EY5qhbgNHRUbTWVKvV/KzatbLPyaKvlVIMDg7m531wcJCNGzY8/w2c1VynGENbe1SK9h7AkY0MPGSdA1sqs+fVlt8qlcqU1iarH62T32q1QJh9Vq1WiaJoSv+2dRyt02kj52q1qkeGhwWZwwMmmrUtYcWWtGIN1bbFWRasnTt35tiWIle13YtWX7ZaLUqlEsPDw7tNL9qyeTOXX345F198MUuWLMnncC9dupRTTjlF/+QnP+HnP/+5sB0ffhDkQK5XCrr4eRnZ4kOGqSkkS9cXhSG3LVsmdu7cqd/85jdzyCGH5EAcmx7p6upCa41FJS5cuJAlf/URJiYm9BNPPMHdd9/Nww8/LIZ37gQgSRTS8aYCEHbp3SqKVYb2d16Wwl64cKE+6qijOPjgg3NQi1KKOJlsSwJyJwJMOsx6WLumQIre9x9b7Ca3yEPr2QdBwMTEBFs2P80XvvAFYXvdilM7Xu4GFiZbdWx9zUZJxWb7crlMlIFHbFo5VwJKITNCBAtqCYLApCGz6DMolRgdHc0N4/Lly7ni6183rQKk2DYdMHtIa40dag9mL1jPv1Qq5fvEAoVsq5ndE/bagiDglltuERdddJEWQrBo0aK8PeToo4+m2Wzy2GOPiTRNefTRR/MSxjHHHMOyW2+lu7ubefPmce+9905pg7NpM2VT2QVeYbt2tqYH2LSu0FprW9YZGRkRdu8rpWi327lRso7OrrNN7TMo9qG6rmtGACrFtddeK4444gg9c+ZM3v72t7Nx40b91FNPiTwizFozihGNTTPaf+fAoYzMYt26deIzn/kMS5cu1UuXLmXWrFn4vk+z2eTSSy9lv/3201/84heFLTOEYZi/p90TxVZA67zZ9bGlH4uK3bFjh3nOmUGRGcmD53m5gcgVvXnD3KhO6cIo9HMWU9AW1GQNqL0mq1dsT7E1itY5sFk+q5+KOtjqoylEFZY4JTsvRcep2WwKe3+5ZGAwmNriWCzdddptvCxbWcwgFDtQbOrb6iKb+YmiiJ6eHtavX5/rMvu+jz36qPjUpz7F2WefrU855RQWLFiQ0/xefPHF7L///vpfL7tMeL4/5Uy/UhitXhRkzGTPW8ya1avF5ZdfzoUXXqjPPffc/AEPDAwwOjpKkiQ51L1arebfjzzySI444gjiONajo6OsX7+ejRs38tRTTzExMcHOnTvF+Ph4DoN3MsVaHAs1MDCgZ8yYwdy5c1mwYAGzZs1izpw5+YO2XqGNyq0D8HIWGynZtKCtC4+NjTE+Ps4XvvAFMTIyAjBFkcArY6ZnGIb09vYyNjaWp4Ydx6HdbucpeRvhFD1+WwfSyDytZ5+pHefnZG0GURSxceNG2u02tVqN3t7evHewqGxEIbqi4MjlQ8gzJTI+Pk65XGZwcHDKlBQbMdn1D8OQMAx54okn2H///W1tVj/11FNi/vz53H333XlP9saNG0Wr1dKVSoV99tkHgAULFmjP81i3bl3eb2mfZ71eN2C3rG5XLpe167qiGOnDJC95rVbT1mm011ZUUlbxWbAJTCr/oqK1P7P4C+k4edqyUa/z7W9/m89+9rMMDQ3xnve8h49//OOUMidpSvkiWyNrsO3ZtGlqayTtz2+//XZx0003cfbZZ+uLL7441ycnnngia9eu1b/85S+FNfidTodKpUKz2WTatGl6ZGREgAGctVotbF8zgO/72qa9JyYmGM4iPGtg7drY6B1MCUJmmYA0MQ6Z3Z+eNzUosHrRfu/q6jLvkUWMtj/cvrd1oi3OwmZVrKHatZ9cmBKDtunb/v7+nOjDRqa217WrqwulFLVazUSyhetD63zv9/b25sQrSim2bNli2p8yw7Yry5flDyhOCyoGZBaYVnQC8k4Sz5igOIq48YYbxLJlyzjrrLP02WefzcDAAGNjYxxyyCFc8PrX65//7GeiWqsZp/Bl0D75fOUFG9n88BdI50eGh7n22mvF448/ri+++GJmzpzJ+Pg4SZLkKMtccWUejT2Enucxc+ZMpk2bxmGHHZanYXSmuawSs8bSKRwEm/azh9XWduzfWWNbrKO93BG4o6OjOeITJlOb69ev59/+7d9Eoz6e99ZNTEzkNa1X0sBma2B3vWaraGx0U1T+xdc5GWLcKivbKpJmnrxWim3btlGpVOh0OixcuDD3iDvtdk6YEgSBAeNkisfu7TRJ8qjW930GBwdpt9s52AjIe/lslA2TGaDVq1dz1FFHUa1WWbx4MUuWLNHlcpnbb7/dvGcWGa1Zs4bDDz+cOXPmsHD//fXBBx+M1poHHnggN/jWgLeaTdavX8/BS5YQRRFHHXUU69evnzIP1baqKKVYtGhR3s++atWqHJxojbIFkhV7v63Rtf+2tdlms5m3stXr9Sl/s2bNGnHdddfpE088kTlz5vDnf/7n+htXXJH3PxbJaWB3whlrzA477DD94Q9/mJtvvpmrr746j1Rvu+02sXLlSv72b/9WDwwMMDw8zMKFCwHyNPCaNWt4zWteQ7vdZr/99uOxxx7LMRcwCeAplUpYZirXdXn44YfzbIg1HO2sFNBqtahWq/nesDVMtHE0bElDKUW5UsnTpdbZs600vb29uSNpszLAbo6G53l0dXXlzqZ9Xf6+Wb1UK8XExIQIgkDb8lb28HPns9Nu8+ijj7LffvtRq9U4/PDDGRoayulzwehx+yxmzJiRZ5dWrlxpolTXzbM9trxj66zF3m9rQO0+rdVqU9uLCufikEMO0X/1kQ9z11138bWvflXY+7v2pz8V99xzDx//+Mf1ggULGBoaytm67LjOV5K84JynbYqHybw+QjC8cyfLb7tN/P3f/7144IEHcBwnRyTbdpNiC0RPT0/ef2VTnpbOzaYQHcfJ4e0WZWe9KmusrfFst9s0m828j873/ZwNxqbE/k+lfF+IFA2sdULuvfde/v3f/1006vX83usFxVVM8b3cZVeDZJGTs2bNAsjTfV1dXbkyt8reSpokTExMUCqV6O7upqenJzdKjuNQKpdZvWqVWLlyZY6MP/+CC3SpXMYPglzp24g2KSh9u7d1FnGNj4/TarXodDr09PTke7PT6eRpR9u+YNd/27ZtbN++PQfSzZ07l3q9zpo1a4RN6wWlUk6w0G63WbBgATNmzGBiYoJNmzZN0SpOdu+33XYbaZoyMDDAMcccM6V9KAiCvCwCMG/evPwaV69enadjwTgzlpd3YGCAXdHpNmq1PbHZWdZJkjAwMEC9Xsf1PLq6u0mThK//13+JdrtNHMecfPLJHP3qV2vLetSo13OwTSnDadjPAHInUQiRK+hOp5OjYVutFsPDw9x4443U63UGBgZ4+umn878VQnD//ffnvL9nnXXWlHSm/beNFg844IB8n91555155AjQbrVwsy6JarXKxMQESRxTrdVI4jhHrqs0ZdWqVfmazp07V6N1bmCtc3j2OedoG03aenbxrBb7qCuVCps2bZqCUbDrlNdISyVqXV2EYZg7pPZ6bL+s5/u4nseyZcuYPn06SZJw7LHH5qUWXfj8KHMwlixZQlf2vnfddRftViuPcivVah7hFolELCuYRU8XgWa2vdM6NxbfYnW/PSdBqZSDqzZv2sRPf/pTnnrqKfr7+9mZlRDt+sDzRH+/DOTF08LZjccZhBygq7uboR07+MynPy2uuuoqdu7cmTcZW4Novad6vU6j0cj7cK1HZOtrSqm8xcMym+RRSyEytWmbUqmUMyDZh29h8/Y1/ivgIVnFbetsN954I1/84hfF+NgY5YwgwwIUYLKh/ZUi9hnalGNxGLg1FJ1OZ0p9qkjg7vm+YRTLnI3R0dEcfBSUSqRJQqfdxg8CvvnNbwpbM/qTP/kTA3ILw7x1QTpOfnD/6sMf1v39/XmGBkyacMuWLbkBmDZtmvmcDFU6c+ZMLrroIm2noFgDfMcdd4jBwUE6nQ6LFi1i0aJF3HzzzXk/pk03Pv7448LWuV71qlexcOFCHn300Rz3AEaBWsW8YsUKcfvtt+flmDPPPFNbJ8WmqrXWLF68WJ977rlEUcS6dev45S9/KWBSYZdKpdwBtucQyKM5e66sZGdNAHmKMolj6hMTuVPyla98JWcsete73sWMmTNNdsnz8lRfp5DNKiKXbY9skiR5h0Kz2cwNsXW89913X5RSLFu2TAA55mP58uXivvvuI01TZs2axWmnnabjOJ4CrIzjmIULF+rTTjsN3/e57777uOOOO0Qnqy8HdkZuluK1zhlCTLJ/FdKjq1evplwuI4Rg8eLF5odZf2wUhvhBwJw5c/jpT3+ar21PT8+Uc2D30v33308cx0yfPp0FCxZom9avVCqce+652tal2+02jXo9b0uq1+vGgHnZYPkM9JfEMQ8++KC47rrrkFKyZMkSQ7SSnZFimWTx4sX6hBNOQCnFvffey/LlywUY41quVGg1mzmNru1RFsKMPLRn2HYAWGfBZkp6enry19r6swVsgSHPsBwKnu/T3d3NwoUL2bJlC3ffffcU8glZoBV9ucsLN7KZx2YNq/WcwBA8CCkplcv84rrrxMc//nFx8803Y1lAbGrIepmVSoVarZaParLpKwsqsWQFlo7M1m6KdSLbRmSVqQU0VCoVKpVKrliKPZkvZ7HTNQB+/OMf840rrhB2M7azWq11KnaNBl4J6WKbJrbPwipB6yDZVhjLIlMul3MCcoscto359lDnrSzZOoFRiEM7dvCP//iP+QDuf//3f9cXvP712s8YllSacuCBB+rP/8u/6FmzZjFz5kxtr9HK9u3bxSOPPEIcxyxevJjTTjtNR1HE7Nmz+eQnP6ltq4T9G+sAPvDAA/T393PooYfS3d3N448/DpjzIrO658jwMKtXr86ZdGq1GsuWLcvXxRp7rVSeYr7iiivEbbfdxrRp07j00ku55JJL9MKFC7U9C6eddpr+wAc+wPj4OHfddRf/+I//aGpxhZpakmUCrOK3c2FhEmBjs0dWSqWSttmlothI78EHHhDXX3894+PjVKtV3vve9+okjvM0vI3GbbS9K4jFRkuLFy/mkksu0cU67dKlS/Xb3vY2nnzySf7pn/4p3zt2rm0Yhnzxi18UK1eupF6v85d/+Zd8+MMf1nPnzs2N2dKlS/Xf/M3f0Gq1+MUvfsFXvvIVYfmt7d6xRA6W4Wt8fDw3jEIaBif7+t/97nfCZiIuvfRSTj/jjLwn9PBXvUp/4AMf0Lfeeiv1en23nmqbKgbjwKxdu5bx8XGUUpx//vl0d3fnDGRnn302c+bMyQ2vBepZMoqRkRGSOM6NptXFrWaT733ve+Kee+5heHiYt7/97Xzkox/VfX19+X46+5xz9KWXXkqlUuG6667jK1/5ipDScDO3mk3arRZOlklsNpt5L681rhYEaJ3AIlDLBkf2PoMgoF6vMzIywplnnsk73/Uubfe2dBzOPfdc/aY3vYmdO3fyzW9+k40bNuTZHK12n637cpYXIbktCyCASW83n5hQEKsY9pk3T7/nPe9h/vz5+L7xGIt1VgtuKeb8i0Pk7eG2KZZdUXDFVLD9WfFvbf3WAGxe/lNpdu7cyfe+9z3uXLEiJ8+GjGw9iXbbcBY88kqJaC2yuIigvPLKK7XdBzZdGMcxQ0NDXHHFFTlR/dGvPlb/+Z//OTNnziSOY7Zv3868efNoNBps376dj3z4w0JmJYKi53vm0qV67ty5nHrayTki2XEcli1bxhNPPMEN118/ZZoPkANJunt6OOOMM/R5551HtWz6e3/yk5+wYcMG7r777pwcoVar5VHhpZdeqpcuXZojeT/60Y9m9JBGiVnl/6d/+qf6nHPOoauriyiKeM973iNs5Fc8U+VKZQr4Y99999WLFy/mggsuyOt+dmjBz3/+c+699142bNggbObIAlUuuOACfe655zJ79mzbb5v3VEZRxGc/+1k2bdqUU1mecMIJ+h3veEeOA+hkmRb73P7X//pfPL1xo6hkE3M+//nPa4vJmD17Nj/5yU/4xhVXFEA3k/Vj2xttz3dPTw+vfvWr9WmnncbMmTPzenej0eBnP/sZd9xxh7BUp5ZmsNlsTmnn2X///fWSJUs477zzcifbkoH86Ec/4pHHHmXr1q0i7HSmoIaPfc1r9Ac+8IFcj1he59HRURzH4bOf/SxPrVsnzNQucyb7+vt5zWteo88991ymTZuWp5mvvPJKfnbttQLg9DPO0O9///sZGhpiYGCAJA752te+xi233CJg0uk8/vjj9RlnnMEhhxxCkiSsX7+ee++9l1tuuUXYevpBBx2kP/G/Pkmz2WTWrFns2LEjb8EaHx/nc5/7HBvWr5/UGdn3AxYt0osXL+bMM89k7ty5+T4ZHx/nt7/9LbfffrvYvm1bvi8tkOsNf/Zn+k/+5E/ytLzv+6gkZceOHYyPj/O3f/u3uT35xCc+oZcsWZKvd7VapVwuMzY2xve//31+85vfCCEEc/aZq4888khOPfVUarVazrEwPj7Orbfeyq9+9SthnT6LbtZZYFcql+m0Cgjpl6m8YCPrekFew8qRapB757YJXWud85taL/G8887TF198cWYos3mv0gUUWgu0TjFIeJ3/HCRaZyPzmOwdKzaB21RdmqZTGqWtFNPRrvvyrluuXbuWb33rW2xYv17krQDZBjcKQU3pYy4a1xdritEfUyzUv4ia3HVCTKVSyaMVC4SzoLUkUbkhFBaZmvFk520C2bMvTrbJFapQufEstoflPwPIlH6a9UCqNJ00vnrqNRZbE2B3hHdx1FcQBIRR9rvsGm20WmQdim2myO7xwl62xtI+a+tETq7P5PxbKWXef2mJH2y62BLUF4FTtkxjW17sdVs0uH3/4r7kGSKMYhtLpVrNUdWeN7lfd33uxXvaU+RiX7/r3xXPw67Xblt3bPZLC7PWVnd5mb4oBgzFvVBs7THPaTLTkSZJ/j7FPWmjs6KjN9k2NjnLuxhgWKT6ntpq7H0JIdC7zQI1UnTChJT09fUxMjyc/7/OwEz2Pr2sf7g40GBXXW6BXMX3QJOf3aK+sYa42C5VvPZcxOT62qyTEGISoV1ogzLrne72+S93eclhWgcuPki//e1v55CDD2N0bDgbHeWSJho/cGm3QvzAReAQxR1UCq5n5tOaA+Y994c8q7xQ1pBnN9JF4EJxAoVRGsYAuK7M6xgAAwMDbN26lZtvvpmrrrrqJX9Ge2Wv7JW9slf+MHnJFXi5apqyX//61+s/+7M/Q2vN2NhYPlnDTj0B40HbdJFlbEmTqTNhf3/54xpZS2Ru0ZkW6GPSYhq08cwsG5HneTz00ENcc801rFq16iV/Pntlr+yVvbJX/nB56ZW4IE8J7Ldwob744ov5/9o7f5804jCMP9/jQER0cDD+SCAkDC5MGImbx+Rmwn/p5AIjDi7IQtK0sSftSAglwYOBYC1yHeC9+3KN19SmPdHns0rOY3q4+77P5y2VSvMdh+OxX/BenGXp3uD5643ov0IYEq4yqZlY7G+UaUe1eF2USCQwGAxQr9dRq9WU9ON0gQAhhJDVIvKEMsz5WY3UUX48PsIql91KpeL1EOWcQt87Ke/+1xLrYZePHKWdDUrtZMmuY8wnCq+urlCr1ZQsKJAhkNd+pkoIIeR5Ig9ZfbgC8Ac5dnZ2cHJy4p6fn3tdWenOSS3HNE1MHl53V0p6rjI1qYvvDcNA++4zLi4uYNu20gc8VkGJSAghJJzIQxZYnvgLTl+apomzszO3XC5ja2vLk3VLd9KMR784PYzZbOZZmxzHwebmJpLJJBqNBi4vL/H1y52SyoIeqmKmWhUJNiGEkF+JPGSDYmnA3zghT61iibIsy7UsCwcHB54Byvjr6eJ/ixS3RRfZbDZRrVbVt14P66kUHr9PlpSCsgs0WEsghBCyekQesnrnKx6Pe09uYd24fD7vnp6e4vj4GGvJ1P++5T8iFovBtm1cX1+j1Wqp0XAYWNc3W/qhoffh9Kd6Qgghq0fkIfsSpG9qGAZKpZJ7dHSEQqHgLRSQ81rd6SvlblEuypQvVPjSdVlgLKV3KVjLddzZ1BOzi1RBKYXb21vc3Nyg0Wgo0QPKvQel34QQQt4mKxmygC8V1y02h4eHbrFYRD6fx/b2tidu192gYnvyZONP4UEXnAwWmYS8/k2uzXfSOo4D27bRarXQbrfVaDTyPq+HPUOWEELeD5GH7EtvQGEeYE+uL5PQlV3pdBrZbNbN5XLY3d1FJpPB3t4eUqmU51mdTqeImeGbeCSUxW07Ho8xGAzQ7XbR7/fx6eMHdDodJauYfle7keCV6xJCCHm7vPqQVXjezwn4blfxYkrQ6n5MWRUnfdv9/X13Y2MD6XQamWwu9P9PJhP0ej0Mh0Pc398rx3H8Py7UiLqnUwh6YBmuhBDy/vgJIA3fmh5CHXAAAAAASUVORK5CYII=';

function buildReportHTML(clients, devices, mode) {
  // mode: 'client' | 'internal'
  const now = new Date();
  const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const generated = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const clientSections = clients.map(clientName => {
    const clientDevices = devices.filter(d => d.siteName === clientName);
    if (!clientDevices.length) return '';

    const withIssues = clientDevices.filter(d => getDeviceComplianceStatus(d, false).length > 0);
    const clean = clientDevices.length - withIssues.length;
    const pct = clientDevices.length > 0 ? Math.round((clean / clientDevices.length) * 100) : 100;
    const barColor = pct === 100 ? '#2a9d5c' : pct >= 75 ? '#c8960c' : '#c8102e';

    const deviceRows = clientDevices.map(d => {
      const issues = getDeviceComplianceStatus(d, false);
      const pm = d.patchManagement || {};
      const av = d.antivirus || {};
      const statusColor = issues.length === 0 ? '#2a9d5c' : '#c8102e';
      const statusLabel = issues.length === 0 ? '✓ Clean' : issues.map(i => i.label).join(', ');
      return `
        <tr>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf2;font-size:12px;font-weight:600">${esc(d.hostname)}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf2;font-size:11px;color:#555">${esc((d.operatingSystem||'').replace('Microsoft ','').substring(0,30))}</td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf2;font-size:11px;text-align:center">
            <span style="color:${pm.patchStatus==='FullyPatched'?'#2a9d5c':'#c8102e'};font-weight:700">
              ${pm.patchStatus==='FullyPatched'?'✓':pm.patchesApprovedPending>0?pm.patchesApprovedPending+' pending':'✗'}
            </span>
          </td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf2;font-size:11px;text-align:center">
            <span style="color:${(av.antivirusStatus||'').toLowerCase()==='runninganduptodate'?'#2a9d5c':'#c8102e'};font-weight:700">
              ${(av.antivirusStatus||'').toLowerCase()==='runninganduptodate'?'✓ Active':av.antivirusProduct||'✗'}
            </span>
          </td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf2;font-size:11px;text-align:center">
            <span style="color:${d.rebootRequired?'#e07b00':'#2a9d5c'};font-weight:700">${d.rebootRequired?'Required':'—'}</span>
          </td>
          <td style="padding:7px 10px;border-bottom:1px solid #e8edf2;font-size:11px;color:${statusColor};font-weight:600">${statusLabel}</td>
        </tr>`;
    }).join('');

    return `
      <div style="margin-bottom:36px;page-break-inside:avoid">
        <div style="background:#1e2a3a;color:#fff;padding:12px 18px;border-radius:6px 6px 0 0;display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:15px;font-weight:700;letter-spacing:0.03em">${esc(clientName)}</div>
          <div style="font-size:13px;color:#a0b4c8">${clientDevices.length} devices · ${pct}% compliant</div>
        </div>
        <div style="background:#f0f4f8;padding:12px 18px;display:flex;gap:24px;border-left:1px solid #dde3ea;border-right:1px solid #dde3ea">
          <div><span style="font-size:22px;font-weight:700;color:#2a9d5c">${clean}</span> <span style="font-size:12px;color:#666">Clean</span></div>
          <div><span style="font-size:22px;font-weight:700;color:#c8102e">${withIssues.length}</span> <span style="font-size:12px;color:#666">Issues</span></div>
          <div style="flex:1;display:flex;align-items:center;padding-left:12px">
            <div style="flex:1;height:8px;background:#dde3ea;border-radius:4px;overflow:hidden">
              <div style="width:${pct}%;height:100%;background:${barColor};border-radius:4px"></div>
            </div>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;border:1px solid #dde3ea;border-top:none">
          <thead>
            <tr style="background:#f8fafc">
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;color:#666;text-transform:uppercase;border-bottom:2px solid #dde3ea">Device</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;color:#666;text-transform:uppercase;border-bottom:2px solid #dde3ea">OS</th>
              <th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;color:#666;text-transform:uppercase;border-bottom:2px solid #dde3ea">Patches</th>
              <th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;color:#666;text-transform:uppercase;border-bottom:2px solid #dde3ea">Antivirus</th>
              <th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;letter-spacing:0.08em;color:#666;text-transform:uppercase;border-bottom:2px solid #dde3ea">Reboot</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;letter-spacing:0.08em;color:#666;text-transform:uppercase;border-bottom:2px solid #dde3ea">Status</th>
            </tr>
          </thead>
          <tbody>${deviceRows}</tbody>
        </table>
      </div>`;
  }).join('');

  const totalDevices = devices.filter(d => clients.includes(d.siteName));
  const allIssues = devices.filter(d => clients.includes(d.siteName) && getDeviceComplianceStatus(d, false).length > 0);
  const overallPct = totalDevices.length > 0 ? Math.round(((totalDevices.length - allIssues.length) / totalDevices.length) * 100) : 100;

  const reportTitle = mode === 'internal'
    ? 'Fleet Compliance Report'
    : clients.length === 1 ? `Compliance Report — ${clients[0]}` : 'Compliance Report';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a2332; background: #fff; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
  <!-- Header -->
  <div style="background:#1e2a3a;padding:16px 28px;display:flex;justify-content:space-between;align-items:center">
    <img src="${SYNOBIS_LOGO_B64}" style="height:44px" />
    <div style="text-align:right;color:#a0b4c8;font-size:12px;line-height:1.6">
      <div>${reportTitle} | ${monthYear}</div>
      <div>Synobis Network Solutions</div>
    </div>
  </div>

  <!-- Title block -->
  <div style="background:#253447;color:#fff;padding:28px 28px 24px">
    <div style="font-size:24px;font-weight:700;margin-bottom:6px">${reportTitle}</div>
    <div style="font-size:13px;color:#a0b4c8">${monthYear} &nbsp;|&nbsp; Prepared by Synobis Network Solutions &nbsp;|&nbsp; Generated ${generated}</div>
  </div>

  <!-- Fleet summary (internal only or multi-client) -->
  ${clients.length > 1 ? `
  <div style="background:#f0f4f8;padding:20px 28px;border-bottom:2px solid #dde3ea;display:flex;gap:32px;align-items:center">
    <div><div style="font-size:28px;font-weight:700;color:#1e2a3a">${totalDevices.length}</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.08em">Total Devices</div></div>
    <div><div style="font-size:28px;font-weight:700;color:#2a9d5c">${totalDevices.length - allIssues.length}</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.08em">Clean</div></div>
    <div><div style="font-size:28px;font-weight:700;color:#c8102e">${allIssues.length}</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.08em">Issues</div></div>
    <div><div style="font-size:28px;font-weight:700;color:#4a90c8">${clients.length}</div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.08em">Organizations</div></div>
    <div style="flex:1;padding-left:16px">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span style="font-size:12px;color:#666">Overall Compliance</span>
        <span style="font-size:12px;font-weight:700;color:${overallPct>=90?'#2a9d5c':overallPct>=70?'#c8960c':'#c8102e'}">${overallPct}%</span>
      </div>
      <div style="height:10px;background:#dde3ea;border-radius:5px;overflow:hidden">
        <div style="width:${overallPct}%;height:100%;background:${overallPct>=90?'#2a9d5c':overallPct>=70?'#c8960c':'#c8102e'};border-radius:5px"></div>
      </div>
    </div>
  </div>` : ''}

  <!-- Client sections -->
  <div style="padding:24px 28px">
    ${clientSections}
  </div>


</body></html>`;
}

async function generateCompliancePDF(selectedClients, mode) {
  // Ensure we have device data
  let devices;
  try {
    devices = await fetchAllDevices();
  } catch(e) {
    alert('Failed to load device data: ' + e.message);
    return;
  }

  // Load jsPDF + html2canvas dynamically
  const loadScript = src => new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });

  try {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  } catch(e) {
    alert('Failed to load PDF libraries. Check your internet connection.');
    return;
  }

  // Generate one PDF per client (or combined for internal)
  const clientsToProcess = mode === 'internal' ? [selectedClients] : selectedClients.map(c => [c]);

  for (const clientGroup of clientsToProcess) {
    const html = buildReportHTML(clientGroup, devices, mode);

    // Render to hidden iframe
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;left:-9999px;top:0;width:1100px;height:1px;border:none';
    document.body.appendChild(iframe);
    iframe.contentDocument.open();
    iframe.contentDocument.write(html);
    iframe.contentDocument.close();

    // Wait for images to load
    await new Promise(r => setTimeout(r, 800));
    const bodyEl = iframe.contentDocument.body;
    const contentH = bodyEl.scrollHeight;
    iframe.style.height = contentH + 'px';
    await new Promise(r => setTimeout(r, 200));

    const canvas = await html2canvas(bodyEl, {
      scale: 1.5,
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      width: 1100,
      windowWidth: 1100,
      height: contentH,
      windowHeight: contentH,
    });
    document.body.removeChild(iframe);

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgW = pageW;

    const pageHeightPx = (pageH / imgW) * canvas.width;
    let yPx = 0;
    let pageCount = 0;
    while (yPx < canvas.height) {
      if (pageCount > 0) pdf.addPage();
      const sliceH = Math.min(pageHeightPx, canvas.height - yPx);
      const sliceCanvas = document.createElement('canvas');
      sliceCanvas.width = canvas.width;
      sliceCanvas.height = sliceH;
      sliceCanvas.getContext('2d').drawImage(canvas, 0, yPx, canvas.width, sliceH, 0, 0, canvas.width, sliceH);
      const sliceImgH = (sliceH * pageW) / canvas.width;
      pdf.addImage(sliceCanvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pageW, sliceImgH);
      yPx += sliceH;
      pageCount++;
    }

    // Add footer to every page
    const totalPages = pdf.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      pdf.setPage(p);
      pdf.setFontSize(8);
      pdf.setTextColor(160, 180, 200);
      pdf.text('Synobis Network Solutions  ·  Manage · Analyze · Protect', 10, pageH - 6);
      pdf.text('Confidential — prepared for authorized recipients only', pageW - 10, pageH - 6, { align: 'right' });
      // Footer rule line
      pdf.setDrawColor(60, 80, 110);
      pdf.setLineWidth(0.3);
      pdf.line(10, pageH - 10, pageW - 10, pageH - 10);
    }

    const filename = mode === 'internal'
      ? `Synobis_Fleet_Compliance_${new Date().toISOString().slice(0,7)}.pdf`
      : `Synobis_Compliance_${clientGroup[0].replace(/[^a-z0-9]/gi,'_')}_${new Date().toISOString().slice(0,7)}.pdf`;
    pdf.save(filename);

    // Small delay between multiple PDFs
    if (clientsToProcess.length > 1) await new Promise(r => setTimeout(r, 300));
  }
}

function openReportModal() {
  // Remove existing modal if present
  document.getElementById('reportModal')?.remove();

  const devices = state.complianceCache?.devices || [];
  const siteNames = [...new Set(devices.map(d => d.siteName).filter(Boolean))].sort();

  if (!devices.length) {
    alert('No compliance data loaded. Please visit the Compliance view first to load device data.');
    return;
  }

  const modal = document.createElement('div');
  modal.id = 'reportModal';
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;width:520px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden">
      <div style="padding:18px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.05em">📄 GENERATE COMPLIANCE REPORT</div>
        <button id="reportModalClose" style="background:none;border:none;color:var(--textdim);font-size:18px;cursor:pointer">✕</button>
      </div>
      <div style="padding:18px 20px;border-bottom:1px solid var(--border)">
        <div style="font-family:var(--cond);font-size:11px;letter-spacing:0.08em;color:var(--textdim);margin-bottom:8px">REPORT TYPE</div>
        <div style="display:flex;gap:10px">
          <button class="report-type-btn active" data-type="client" style="flex:1;padding:10px;border-radius:5px;border:2px solid var(--accent);background:rgba(0,180,216,0.08);color:var(--accent);font-family:var(--cond);font-weight:700;font-size:13px;cursor:pointer">
            👤 Client-Facing<br><span style="font-size:10px;font-weight:400;opacity:0.8">One PDF per selected org</span>
          </button>
          <button class="report-type-btn" data-type="internal" style="flex:1;padding:10px;border-radius:5px;border:2px solid var(--border);background:none;color:var(--text);font-family:var(--cond);font-weight:700;font-size:13px;cursor:pointer">
            🏢 Internal<br><span style="font-size:10px;font-weight:400;opacity:0.8">All selected orgs in one PDF</span>
          </button>
        </div>
      </div>
      <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div style="font-family:var(--cond);font-size:11px;letter-spacing:0.08em;color:var(--textdim)">SELECT ORGANIZATIONS</div>
        <div style="display:flex;gap:8px">
          <button id="reportSelectAll" style="background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;font-family:var(--cond)">SELECT ALL</button>
          <button id="reportSelectNone" style="background:none;border:none;color:var(--textdim);font-size:12px;cursor:pointer;font-family:var(--cond)">NONE</button>
        </div>
      </div>
      <div id="reportClientList" style="flex:1;overflow-y:auto;padding:10px 20px">
        ${siteNames.map(name => {
          const siteDevices = devices.filter(d => d.siteName === name);
          const issues = siteDevices.filter(d => getDeviceComplianceStatus(d, false).length > 0).length;
          const pct = siteDevices.length > 0 ? Math.round(((siteDevices.length - issues) / siteDevices.length) * 100) : 100;
          const color = pct === 100 ? '#2a9d5c' : pct >= 75 ? '#c8960c' : '#c8102e';
          return `<label style="display:flex;align-items:center;gap:10px;padding:8px 4px;cursor:pointer;border-bottom:1px solid var(--border)">
            <input type="checkbox" class="report-client-cb" value="${esc(name)}" checked style="width:15px;height:15px;accent-color:var(--accent)" />
            <span style="flex:1;font-size:13px">${esc(name)}</span>
            <span style="font-size:11px;color:${color};font-family:var(--cond);font-weight:700">${pct}%</span>
            <span style="font-size:11px;color:var(--textdim)">${siteDevices.length} devices</span>
          </label>`;
        }).join('')}
      </div>
      <div style="padding:16px 20px;display:flex;gap:10px;justify-content:flex-end">
        <button id="reportModalCancel" style="padding:9px 18px;background:none;border:1px solid var(--border);border-radius:5px;color:var(--text);cursor:pointer;font-family:var(--cond)">CANCEL</button>
        <button id="reportGenerateBtn" style="padding:9px 20px;background:var(--accent);border:none;border-radius:5px;color:#fff;font-family:var(--cond);font-weight:700;font-size:13px;cursor:pointer;letter-spacing:0.05em">⬇ GENERATE PDF</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  let reportMode = 'client';

  // Type toggle
  modal.querySelectorAll('.report-type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      reportMode = btn.dataset.type;
      modal.querySelectorAll('.report-type-btn').forEach(b => {
        const active = b.dataset.type === reportMode;
        b.style.border = active ? '2px solid var(--accent)' : '2px solid var(--border)';
        b.style.background = active ? 'rgba(0,180,216,0.08)' : 'none';
        b.style.color = active ? 'var(--accent)' : 'var(--text)';
      });
    });
  });

  // Select all / none
  document.getElementById('reportSelectAll').addEventListener('click', () => {
    modal.querySelectorAll('.report-client-cb').forEach(cb => cb.checked = true);
  });
  document.getElementById('reportSelectNone').addEventListener('click', () => {
    modal.querySelectorAll('.report-client-cb').forEach(cb => cb.checked = false);
  });

  // Close
  const closeModal = () => modal.remove();
  document.getElementById('reportModalClose').addEventListener('click', closeModal);
  document.getElementById('reportModalCancel').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Generate
  document.getElementById('reportGenerateBtn').addEventListener('click', async () => {
    const selected = [...modal.querySelectorAll('.report-client-cb:checked')].map(cb => cb.value);
    if (!selected.length) { alert('Please select at least one organization.'); return; }
    const btn = document.getElementById('reportGenerateBtn');
    btn.textContent = '⏳ Generating...';
    btn.disabled = true;
    try {
      await generateCompliancePDF(selected, reportMode);
      closeModal();
    } catch(e) {
      alert('PDF generation failed: ' + e.message);
      btn.textContent = '⬇ GENERATE PDF';
      btn.disabled = false;
    }
  });
}

// ─── COMPLIANCE NAV + VIEW INJECTION ───────────────────────────────
function injectComplianceViewAndNav() {
  if (!document.getElementById('view-compliance')) {
    const sibling = document.getElementById('view-clients')
                 || document.getElementById('view-tickets')
                 || document.getElementById('view-dashboard');
    const div = document.createElement('div');
    div.id = 'view-compliance';
    div.className = 'view';
    if (sibling?.parentNode) sibling.parentNode.appendChild(div);
    else (document.querySelector('main') || document.body).appendChild(div);
  }
  // Nav button — insert after Clients (built from scratch to avoid clone text bleed)
  const clients = document.querySelector('.nav-item[data-view="clients"]');
  if (!clients || document.querySelector('.nav-item[data-view="compliance"]')) return;
  const navItem = document.createElement('button');
  navItem.className = 'nav-item';
  navItem.dataset.view = 'compliance';
  navItem.title = 'Compliance';
  navItem.innerHTML = `<span class="nav-icon">🛡</span><span class="nav-label">Compliance</span>`;
  clients.parentNode.insertBefore(navItem, clients.nextSibling);
  navItem.addEventListener('click', () => setView('compliance'));
}

function setView(view) {
  // Stop timer if leaving the tickets view (we're no longer viewing that ticket)
  if (state.currentView === 'tickets' && view !== 'tickets') {
    stopTicketTimer();
  }
  state.currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${view}`));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.dataset.view===view));
  if (view==='kb') renderKB();
  if (view==='clients') renderClientsView();
  if (view==='compliance') renderComplianceView();
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
    // Don't navigate when clicking interactive elements inside the row (checkboxes, buttons, action triggers)
    if (e.target.closest('input, button, [data-action]')) return;
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
          priority:t.priority,queueID:t.queueID,billingCodeID:t.billingCodeID,
          title:t.title,companyID:t.companyID,companyName:t.companyName,lastActivity:t.lastActivityDate,
          createDate:t.createDate,
          assignedResourceID:t.assignedResourceID,assignedResourceName:t.assignedResourceName,
        };
      });
      // For preserved tickets not in the fresh items list, refresh their status so mismatches update.
      // syncTicketStatuses now drops any preserved ticket AT no longer returns (ghost cleanup).
      const freshNumbers = new Set(items.map(t => t.ticketNumber));
      const stalePreserved = Object.keys(preserved).filter(tn => !freshNumbers.has(tn));
      let droppedGhosts = [];
      if (stalePreserved.length) {
        try {
          const result = await syncTicketStatuses(stalePreserved);
          droppedGhosts = result?.droppedGhosts || [];
        } catch(e) { console.warn('Preserved ticket sync failed:', e.message); }
      }
      LS.set('msp_tickets',state.tickets);
      render();
      const ghostMsg = droppedGhosts.length ? ` · cleaned ${droppedGhosts.length} ghost${droppedGhosts.length!==1?'s':''}` : '';
      showToast(`✓ Loaded ${items.length} open tickets${ghostMsg}`,'ok');
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
      const ticket = findTicketById(ticketId);
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

    if (action==='ticket-save-changes') {
      const ticketId = el.dataset.ticketId;
      const ticket = findTicketById(ticketId);
      const pending = state.pendingTicketEdits[ticketId];
      if (!ticket || !pending || !Object.keys(pending).length) return;
      const origLabel = el.textContent;
      el.disabled = true;
      el.textContent = 'Saving...';
      try {
        const summary = await patchTicketFields(ticket, pending);
        delete state.pendingTicketEdits[ticketId];
        state.currentTicket = ticket;
        renderTicketDetail(ticket);
        renderTicketList();
        showToast(`✓ Saved — ${summary.join(' · ')}`, 'ok');
      } catch(err) {
        showToast(`Save failed: ${err.message}`, 'err');
        el.disabled = false;
        el.textContent = origLabel;
      }
    }

    if (action==='ticket-discard-changes') {
      const ticketId = el.dataset.ticketId;
      const ticket = findTicketById(ticketId);
      if (!ticket) return;
      delete state.pendingTicketEdits[ticketId];
      // Re-render to reset the dropdowns to ticket's actual values
      renderTicketDetail(ticket);
    }

    // ─── INCIDENT (ALERT GROUPING) HANDLERS ────────────────────
    if (action==='toggle-alert-select') {
      state.alertSelectMode = !state.alertSelectMode;
      if (!state.alertSelectMode) state.alertSelected.clear();
      renderAlertList();
    }

    if (action==='alert-select') {
      const uid = el.dataset.uid;
      if (!uid) return;
      if (el.checked) state.alertSelected.add(uid);
      else state.alertSelected.delete(uid);
      // Re-render to update the "Group N" button visibility
      renderAlertList();
    }

    if (action==='create-manual-incident') {
      if (state.alertSelected.size < 2) {
        showToast('Pick at least 2 alerts to group', 'info');
        return;
      }
      const uids = [...state.alertSelected];
      const defaultTitle = `Manual incident — ${uids.length} alerts`;
      const title = prompt('Incident title:', defaultTitle);
      if (title === null) return; // cancelled
      try {
        createManualIncident(uids, title.trim() || defaultTitle);
        state.alertSelected.clear();
        state.alertSelectMode = false;
        renderAlertList();
        showToast(`✓ Grouped ${uids.length} alerts into incident`, 'ok');
      } catch(err) {
        showToast(`Group failed: ${err.message}`, 'err');
      }
    }

    if (action==='bulk-resolve') {
      const uids = [...state.alertSelected];
      if (!uids.length) return;
      if (!confirm(`Resolve ${uids.length} alert${uids.length!==1?'s':''} in Datto? This cannot be undone.`)) return;
      let ok = 0, fail = 0;
      for (const uid of uids) {
        try { await resolveAlert(uid); ok++; }
        catch(e) { console.warn('Bulk resolve failed for', uid, e.message); fail++; }
      }
      // Drop resolved alerts from local state
      const resolvedSet = new Set(uids);
      state.alerts = state.alerts.filter(a => !resolvedSet.has(a.alertUid));
      LS.set('msp_alerts', state.alerts);
      state.alertSelected.clear();
      state.alertSelectMode = false;
      renderAlertList();
      if (fail === 0) showToast(`✓ Resolved ${ok} alert${ok!==1?'s':''}`, 'ok');
      else if (ok === 0) showToast(`Failed to resolve ${fail} alert${fail!==1?'s':''}`, 'err');
      else showToast(`✓ Resolved ${ok}, ${fail} failed (see console)`, 'info');
    }

    if (action==='bulk-create-tickets') {
      const uids = [...state.alertSelected];
      if (!uids.length) return;
      if (!confirm(`Walk through creating ${uids.length} ticket${uids.length!==1?'s':''}? You'll review each one before submission.`)) return;
      // Walk through each alert, creating ticket sequentially
      let created = 0, skipped = 0, failed = 0;
      for (const uid of uids) {
        const alert = state.alerts.find(a => a.alertUid === uid);
        if (!alert) { skipped++; continue; }
        if (alert.ticketNumber) {
          // Already has a ticket; skip silently
          skipped++;
          continue;
        }
        try {
          if (!confirm(`Create ticket for: ${alert.hostname} — ${(alert.alertMessage || '').substring(0, 80)}?\n\nClick Cancel to skip this one.`)) {
            skipped++;
            continue;
          }
          await createTicketForAlert(alert);
          created++;
        } catch(e) {
          console.warn('Bulk ticket creation failed for', uid, e.message);
          failed++;
        }
      }
      state.alertSelected.clear();
      state.alertSelectMode = false;
      renderAlertList();
      const parts = [];
      if (created) parts.push(`${created} created`);
      if (skipped) parts.push(`${skipped} skipped`);
      if (failed) parts.push(`${failed} failed`);
      showToast('✓ ' + parts.join(' · '), failed ? 'info' : 'ok');
    }

    if (action==='bulk-save-kb') {
      const uids = [...state.alertSelected];
      if (uids.length < 2) {
        showToast('Pick at least 2 alerts to consolidate into a KB entry', 'info');
        return;
      }
      const alerts = uids.map(u => state.alerts.find(a => a.alertUid === u)).filter(Boolean);
      if (!alerts.length) return;
      const origLabel = el.textContent;
      el.disabled = true; el.textContent = '✨ Drafting...';
      try {
        // Build a context blob from all selected alerts
        const alertsBlob = alerts.map((a, i) => `
ALERT ${i+1}:
  Device: ${a.hostname}
  Client: ${a.siteName}
  Priority: ${a.priority}
  Monitor: ${a.monitorType}
  Message: ${a.alertMessage || ''}
  Timestamp: ${new Date(a.timestampMs).toISOString()}
`).join('\n');
        const system = buildKbDraftSystemPrompt();
        const userMsg = `${alerts.length} RELATED ALERTS (consolidated into one KB entry):

These alerts represent a recurring pattern. Build a single KB entry covering the common issue and remediation, not separate entries per alert. Strip client-specific identifiers as usual — the goal is a generalizable pattern.

${alertsBlob}`;
        const raw = await callAI(system, [{ role: 'user', content: userMsg }]);
        const cleaned = (raw || '').replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(cleaned);
        const draft = {
          title: String(parsed.title || '').substring(0, 100).trim(),
          symptoms: String(parsed.symptoms || '').trim(),
          diagnosis: String(parsed.diagnosis || '').trim(),
          fix: String(parsed.fix || '').trim(),
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean) : [],
        };
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
        state.alertSelected.clear();
        state.alertSelectMode = false;
        renderAlertList();
      } catch(err) {
        showToast(`Bulk KB draft failed: ${err.message}`, 'err');
      } finally {
        el.disabled = false; el.textContent = origLabel;
      }
    }

    if (action==='bulk-snooze') {
      const uids = [...state.alertSelected];
      if (!uids.length) return;
      uids.forEach(u => state.snoozedIds.add(u));
      LS.set('msp_snoozed', [...state.snoozedIds]);
      const n = uids.length;
      state.alertSelected.clear();
      state.alertSelectMode = false;
      renderAlertList();
      render();
      showToast(`⏸ Snoozed ${n} alert${n!==1?'s':''}`, 'info');
    }

    if (action==='incident-toggle') {
      const id = el.dataset.incidentId;
      toggleIncidentExpand(id);
      renderAlertList();
    }

    if (action==='incident-eject') {
      const uid = el.dataset.uid;
      ejectAlertFromIncident(uid);
      renderAlertList();
      showToast('Removed from incident', 'ok');
    }

    if (action==='incident-ungroup') {
      const id = el.dataset.incidentId;
      const inc = state.incidents[id];
      if (!inc) return;
      if (!confirm(`Ungroup "${inc.title}"? The ${inc.alertUids.length} alerts will become individual again.`)) return;
      ungroupIncident(id);
      renderAlertList();
      showToast('✓ Ungrouped', 'ok');
    }

    if (action==='ai-cluster-alerts') {
      const origLabel = el.textContent;
      el.disabled = true;
      el.textContent = '✨ Analyzing...';
      try {
        const { proposals, totalCandidates } = await runAiIncidentClustering();
        showAiClusterReviewModal(proposals, totalCandidates);
      } catch(err) {
        showToast(`AI cluster failed: ${err.message}`, 'err');
      } finally {
        el.disabled = false;
        el.textContent = origLabel;
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
        const directlyLinked = state.alerts.filter(a => a.ticketNumber === ticket.ticketNumber);
        // Also include any alerts that are siblings in the same incident as a directly-linked alert
        const siblingUids = new Set();
        directlyLinked.forEach(a => {
          const inc = getAlertIncident(a.alertUid);
          if (inc) inc.alertUids.forEach(u => siblingUids.add(u));
        });
        const linkedAlerts = state.alerts.filter(a =>
          a.ticketNumber === ticket.ticketNumber || siblingUids.has(a.alertUid)
        );
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
      return findTicketById(tid);
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
      inv.steps.push({ id: newStepId(), text: '', verification: '', done: false, notes: '', minutes: 0 });
      setInvestigation(ticket.id, inv);
      renderTicketDetail(ticket);
    }

    if (action==='timer-pause') {
      pauseTicketTimer();
      // Card re-renders inside pauseTicketTimer
    }

    if (action==='timer-resume') {
      const tid = el.dataset.ticketId;
      const ticket = findTicketById(tid);
      if (!ticket) return;
      startTicketTimer(ticket.id);
      renderTicketDetail(ticket);
    }

    if (action==='inv-step-add-verification') {
      const stepEl = el.closest('.inv-step'); if (!stepEl) return;
      const ticket = findTicketById(stepEl.dataset.ticketId);
      if (!ticket) return;
      const inv = getInvestigation(ticket.id); if (!inv) return;
      const step = inv.steps.find(s => s.id === stepEl.dataset.stepId); if (!step) return;
      step.verification = step.verification || ' '; // any non-empty triggers the input rendering
      setInvestigation(ticket.id, inv);
      renderTicketDetail(ticket);
      // Focus the new input
      setTimeout(() => {
        const input = document.querySelector(`[data-step-id="${stepEl.dataset.stepId}"] .inv-step-verify-input`);
        input?.focus();
        input?.select();
      }, 50);
    }

    // ─── TEMPLATE HANDLERS ────────────────────────────────────────
    if (action==='save-as-template') {
      const ticketId = el.dataset.ticketId;
      const ticket = findTicketById(ticketId);
      const inv = ticket ? getInvestigation(ticket.id) : null;
      if (!ticket || !inv?.steps?.length) {
        showToast('Need an investigation with steps to save as template', 'info');
        return;
      }
      showSaveTemplateModal(ticket, inv);
    }

    if (action==='open-template-picker') {
      const ticketId = el.dataset.ticketId;
      const ticket = findTicketById(ticketId);
      if (!ticket) return;
      showTemplatePickerModal(ticket);
    }

    if (action==='apply-template') {
      const tplId = el.dataset.templateId;
      const ticketId = el.dataset.ticketId;
      const tpl = state.templates[tplId];
      const ticket = findTicketById(ticketId);
      if (!tpl || !ticket) return;
      const existingInv = getInvestigation(ticket.id);
      if (existingInv?.steps?.length) {
        if (!confirm(`Replace the current investigation plan with template "${tpl.name}"? Step notes and progress will be lost.`)) return;
      }
      applyTemplateToTicket(tpl, ticket);
      // Close any open modal
      const modal = document.querySelector('.tpl-picker-row')?.closest('div[style*="position:fixed"]');
      if (modal && modal._closeFn) modal._closeFn();
      else if (modal) document.body.removeChild(modal);
      renderTicketDetail(ticket);
      showToast(`✓ Applied template — ${tpl.name}`, 'ok');
    }

    if (action==='edit-template') {
      const tplId = el.dataset.templateId;
      const tpl = state.templates[tplId];
      if (!tpl) return;
      // Close picker modal if open, then open editor
      const pickerModal = el.closest('.tpl-editor-modal') || document.querySelector('div[style*="z-index:9999"]');
      const picker = pickerModal?._closeFn;
      if (typeof picker === 'function') picker();
      // Try to grab a ticket context from the modal we just closed (for back-navigation)
      const ticket = state.currentTicket || null;
      showTemplateEditorModal(tpl, ticket);
    }

    if (action==='delete-template') {
      const tplId = el.dataset.templateId;
      const tpl = state.templates[tplId];
      if (!tpl) return;
      if (!confirm(`Delete template "${tpl.name}"? This cannot be undone.`)) return;
      deleteTemplate(tplId);
      const row = el.closest('.tpl-picker-row');
      if (row) row.remove();
      showToast('✓ Template deleted', 'ok');
    }

    if (action==='reports-range') {
      const days = parseInt(el.dataset.days);
      if (!days || state.reportsRange === days) return;
      state.reportsRange = days;
      renderReportsView();
    }

    if (action==='reports-generate-report') {
      openReportModal();
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
    if (action==='compliance-generate-report') {
      openReportModal();
    }
    if (action==='compliance-warranty-toggle') {
      state.complianceShowWarranty = !state.complianceShowWarranty;
      const btn = document.getElementById('complianceWarrantyBtn');
      if (btn) btn.textContent = `🔖 Warranty ${state.complianceShowWarranty ? 'ON' : 'OFF'}`;
      if (state.complianceCache) {
        const search = document.getElementById('complianceSearch');
        renderComplianceBody(state.complianceCache.devices, search?.value.toLowerCase().trim() || '', state.complianceShowWarranty);
      }
    }
    if (action==='compliance-refresh') {
      renderComplianceView(true);
    }
    if (action==='compliance-drill') {
      const siteName = el.dataset.site;
      if (!siteName || !state.complianceCache) return;
      openDrillPanel(
        `🛡 ${siteName} — Device Compliance`,
        renderComplianceDrill(siteName, state.complianceCache.devices)
      );
    }
    if (action==='stat-drill') {
      const stat = el.dataset.stat;
      const visible    = getVisibleAlerts();
      const crit       = visible.filter(a => a.priority === 'Critical');
      const high       = visible.filter(a => a.priority === 'High');
      const noTicket   = visible.filter(a => !a.ticketNumber);
      const mismatch   = visible.filter(a => a.ticketNumber && state.tickets[a.ticketNumber]?.isDone);
      const openTickets = getOpenTickets();
      if (stat === 'open-alerts')  openDrillPanel(`Open Alerts (${visible.length})`,    drillAlertRows(visible));
      if (stat === 'critical')     openDrillPanel(`Critical Alerts (${crit.length})`,   drillAlertRows(crit));
      if (stat === 'high')         openDrillPanel(`High Alerts (${high.length})`,       drillAlertRows(high));
      if (stat === 'open-tickets') openDrillPanel(`Open Tickets (${openTickets.length})`, drillTicketRows(openTickets));
      if (stat === 'mismatch')     openDrillPanel(`Mismatches (${mismatch.length})`,    drillMismatchRows(mismatch));
      if (stat === 'no-ticket')    openDrillPanel(`Alerts Without a Ticket (${noTicket.length})`, drillAlertRows(noTicket));
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
      const ticket = findTicketById(tid);
      if (!ticket) {
        showToast('Ticket not in cache. Try Tickets → Refresh.', 'info');
        return;
      }
      state.currentTicket = ticket;
      setView('tickets');
      renderTicketDetail(ticket);
      renderTicketList();
    }

    if (action==='critical-prompt-jump') {
      const uid = el.dataset.alertUid;
      const alert = state.alerts.find(a => a.alertUid === uid);
      if (!alert) return;
      state.currentAlert = alert;
      setView('alerts');
      renderAlertDetail(alert);
    }

    if (action==='critical-prompt-snooze') {
      const uid = el.dataset.alertUid;
      snoozeCriticalPrompt(uid, 1);
      renderCriticalPromptBanner();
      showToast('Snoozed for 1 hour', 'info');
    }

    if (action==='critical-prompt-dismiss') {
      const uid = el.dataset.alertUid;
      dismissCriticalPrompt(uid);
      renderCriticalPromptBanner();
      showToast('Dismissed — won\'t prompt again', 'info');
    }

    if (action==='remove-crit-excluded') {
      const name = el.dataset.client;
      const current = state.settings.autoCreatePromptExcluded || [];
      saveSettings({ autoCreatePromptExcluded: current.filter(s => s !== name) });
      document.getElementById('criticalPromptBlock')?.remove();
      injectCriticalPromptSettings();
      renderCriticalPromptBanner();
    }

    if (action==='open-in-datto') {
      const deviceUid = el.dataset.deviceUid;
      await openDattoDeviceForAlert(deviceUid, el);
    }

    if (action==='device-refresh') {
      const deviceUid = el.dataset.deviceUid;
      if (!deviceUid) return;
      clearDeviceCacheEntry(deviceUid);
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
      const ticket = findTicketById(tid); if (!ticket) return;
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
      // Stop the timer — work is wrapping up
      stopTicketTimer();
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
        // Check for template drift — if this investigation was based on a template and steps were modified, prompt to update
        const drift = detectTemplateDrift(inv);
        if (drift) {
          // Defer the modal slightly so the toast can show first
          setTimeout(() => showTemplateDriftModal(drift, inv, ticket), 600);
        }
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
      const ticket = findTicketById(stepEl.dataset.ticketId);
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
    const ticket = findTicketById(ticketId);
    if (!ticket) return;
    // Compare against the live ticket value — normalize blanks to null
    const currentValueRaw = ticket[field];
    const currentValueStr = currentValueRaw == null ? '' : String(currentValueRaw);
    const newValueStr = sel.value;
    if (!state.pendingTicketEdits[ticketId]) state.pendingTicketEdits[ticketId] = {};
    if (newValueStr === currentValueStr) {
      // User reverted to the original — clear from pending
      delete state.pendingTicketEdits[ticketId][field];
      if (!Object.keys(state.pendingTicketEdits[ticketId]).length) {
        delete state.pendingTicketEdits[ticketId];
      }
      sel.classList.remove('ticket-field-dirty');
    } else {
      state.pendingTicketEdits[ticketId][field] = newValueStr;
      sel.classList.add('ticket-field-dirty');
    }
    updateTicketSaveBar(ticketId);
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
    if (invField === 'inv-step-text' || invField === 'inv-step-notes' || invField === 'inv-step-mins' || invField === 'inv-step-verification') {
      const stepEl = e.target.closest('.inv-step'); if (!stepEl) return;
      const ticket = findTicketById(stepEl.dataset.ticketId);
      if (!ticket) return;
      const inv = getInvestigation(ticket.id); if (!inv) return;
      const step = inv.steps.find(s => s.id === stepEl.dataset.stepId); if (!step) return;
      if (invField === 'inv-step-text')         step.text         = e.target.value;
      if (invField === 'inv-step-notes')        step.notes        = e.target.value.slice(0, INV_STEP_NOTES_MAX);
      if (invField === 'inv-step-mins')         step.minutes      = parseInt(e.target.value) || 0;
      if (invField === 'inv-step-verification') step.verification = e.target.value;
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
    resetDattoToken();
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

// ─── INLINE-INJECTED STYLES (self-contained, no external CSS dependency) ──

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

// ─── ALERT SYNC VERIFY BUTTON ─────────────────────────────────────
function injectVerifyButton() {
  if (document.getElementById('alertVerifyBtn')) return;
  const alertList = document.getElementById('alertList');
  if (!alertList) return;
  const btn = document.createElement('button');
  btn.id = 'alertVerifyBtn';
  btn.className = 'verify-datto-btn';
  btn.title = 'Re-fetch from Datto and report any drift between Companion and Datto';
  btn.innerHTML = '🔍 Verify with Datto';
  btn.addEventListener('click', verifyAlertSync);
  // Insert before the alert list
  alertList.parentNode.insertBefore(btn, alertList);
}

function injectVerifyAutotaskButton() {
  if (document.getElementById('ticketVerifyBtn')) return;
  const ticketList = document.getElementById('ticketList');
  if (!ticketList) return;
  const btn = document.createElement('button');
  btn.id = 'ticketVerifyBtn';
  btn.className = 'verify-datto-btn';
  btn.title = 'Re-check every cached ticket against Autotask and drop ghosts that no longer exist';
  btn.innerHTML = '🔍 Verify with Autotask';
  btn.addEventListener('click', verifyTicketSync);
  ticketList.parentNode.insertBefore(btn, ticketList);
}

async function verifyTicketSync() {
  const btn = document.getElementById('ticketVerifyBtn');
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '🔍 Checking...';
  try {
    // Fetch fresh active tickets — anything in our cache NOT returned here AND not actually in AT is a ghost
    const freshActive = await fetchAtTicketQueue();
    const freshNumbers = new Set(freshActive.map(t => t.ticketNumber));
    // Tickets we have cached but didn't see in fresh fetch — could be ghosts OR could be done/closed tickets
    // that fell out of the active query window. Verify each one directly against AT.
    const suspect = Object.values(state.tickets).filter(t => !freshNumbers.has(t.ticketNumber));
    const ghosts = [];
    for (const t of suspect) {
      try {
        const data = await atFetch(`/Tickets/${t.id}`);
        if (!data?.item && !data?.id) ghosts.push(t);
      } catch(e) {
        if (/404|not found|null/i.test(e.message)) ghosts.push(t);
      }
    }
    if (!ghosts.length) {
      showToast(`✓ In sync — all ${Object.keys(state.tickets).length} cached tickets exist in Autotask`, 'ok');
      return;
    }
    showVerifyTicketResultModal({ ghosts, totalCached: Object.keys(state.tickets).length });
  } catch(e) {
    showToast(`Verify failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function showVerifyTicketResultModal({ ghosts, totalCached }) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  const ghostList = ghosts.map(t => `
    <div class="verify-row">
      <div>
        <span class="verify-uid">${esc(t.ticketNumber || '')}</span>
        <span>${esc(t.title || '(no title)')}</span>
      </div>
      <button data-tn="${esc(t.ticketNumber)}" class="verify-resolve-btn">Drop</button>
    </div>
  `).join('');
  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:680px;margin:auto">
    <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px">🔍 Autotask Sync Verification</div>
    <div style="font-size:12px;color:var(--textdim);margin-bottom:14px">Companion has ${totalCached} cached tickets. ${ghosts.length} no longer exist in Autotask (deleted or merged).</div>
    <div style="font-family:var(--cond);font-size:12px;font-weight:700;letter-spacing:0.07em;color:#e07b00;margin-bottom:6px">${ghosts.length} GHOST${ghosts.length!==1?'S':''} — IN COMPANION, NOT IN AUTOTASK</div>
    <div style="font-size:11px;color:var(--textdim);margin-bottom:8px">Click "Drop" to remove individually, or "Drop All" below. Linked alerts will be unlinked.</div>
    ${ghostList}
    <div style="display:flex;gap:8px;margin-top:16px">
      <button id="verifyTicketDropAllBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">Drop All ${ghosts.length} Ghost${ghosts.length!==1?'s':''}</button>
      <button id="verifyTicketCloseBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Close</button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  document.getElementById('verifyTicketCloseBtn').addEventListener('click', () => document.body.removeChild(modal));

  const dropOne = (tn) => {
    delete state.tickets[tn];
    state.alerts.forEach(a => { if (a.ticketNumber === tn) a.ticketNumber = null; });
    LS.set('msp_tickets', state.tickets);
    LS.set('msp_alerts', state.alerts);
  };

  modal.querySelectorAll('.verify-resolve-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tn = btn.dataset.tn;
      dropOne(tn);
      btn.closest('.verify-row').remove();
      showToast(`✓ Dropped ${tn} from Companion`, 'ok');
    });
  });

  document.getElementById('verifyTicketDropAllBtn').addEventListener('click', () => {
    ghosts.forEach(t => dropOne(t.ticketNumber));
    try { renderTicketList?.(); } catch {}
    try { render?.(); } catch {}
    document.body.removeChild(modal);
    showToast(`✓ Dropped ${ghosts.length} ghost ticket${ghosts.length!==1?'s':''}`, 'ok');
  });
}

async function verifyAlertSync() {
  const btn = document.getElementById('alertVerifyBtn');
  if (!btn) return;
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '🔍 Checking...';
  try {
    const fresh = await fetchAlerts();
    const cachedUids = new Set(state.alerts.map(a => a.alertUid));
    const freshUids = new Set(fresh.map(a => a.alertUid));
    const ghosts = state.alerts.filter(a => !freshUids.has(a.alertUid));
    const newOnes = fresh.filter(a => !cachedUids.has(a.alertUid));
    if (!ghosts.length && !newOnes.length) {
      showToast(`✓ In sync — Companion matches Datto (${fresh.length} alerts)`, 'ok');
      return;
    }
    showVerifyResultModal({ ghosts, newOnes, freshTotal: fresh.length, fresh });
  } catch(e) {
    showToast(`Verify failed: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

function showVerifyResultModal({ ghosts, newOnes, freshTotal, fresh }) {
  const modal = document.createElement('div');
  modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:9999;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto';
  const ghostList = ghosts.length ? ghosts.map(a => `
    <div class="verify-row">
      <div>
        <span class="verify-uid">${esc(a.alertUid?.substring(0, 8) || '')}</span>
        <span>${esc(a.hostname)} — ${esc((a.alertMessage || '').substring(0, 60))}</span>
      </div>
      <button data-uid="${esc(a.alertUid)}" class="verify-resolve-btn">Drop</button>
    </div>
  `).join('') : '';
  const newList = newOnes.length ? newOnes.map(a => `
    <div class="verify-row" style="border-color:rgba(42,157,92,0.3)">
      <div>
        <span class="verify-uid">${esc(a.alertUid?.substring(0, 8) || '')}</span>
        <span>${esc(a.hostname)} — ${esc((a.alertMessage || '').substring(0, 60))}</span>
      </div>
    </div>
  `).join('') : '';
  modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:680px;margin:auto">
    <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px">🔍 Sync Verification Result</div>
    <div style="font-size:12px;color:var(--textdim);margin-bottom:14px">Datto returned ${freshTotal} alerts. Companion has ${state.alerts.length}.</div>
    ${ghosts.length ? `
      <div style="font-family:var(--cond);font-size:12px;font-weight:700;letter-spacing:0.07em;color:#e07b00;margin-bottom:6px">${ghosts.length} GHOST${ghosts.length!==1?'S':''} — IN COMPANION, NOT IN DATTO</div>
      <div style="font-size:11px;color:var(--textdim);margin-bottom:8px">These alerts no longer exist in Datto. They were probably resolved through Datto directly. Click "Drop" to remove from Companion, or "Drop All" below.</div>
      ${ghostList}
    ` : '<div style="color:#2a9d5c;font-size:13px;margin-bottom:10px">✓ No ghosts</div>'}
    ${newOnes.length ? `
      <div style="font-family:var(--cond);font-size:12px;font-weight:700;letter-spacing:0.07em;color:#2a9d5c;margin:12px 0 6px">${newOnes.length} NEW — IN DATTO, NOT IN COMPANION</div>
      <div style="font-size:11px;color:var(--textdim);margin-bottom:8px">Refresh All will pull these in normally.</div>
      ${newList}
    ` : ''}
    <div style="display:flex;gap:8px;margin-top:16px">
      ${ghosts.length ? `<button id="verifyDropAllBtn" style="flex:2;cursor:pointer;background:var(--accent);border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">Drop All ${ghosts.length} Ghost${ghosts.length!==1?'s':''}</button>` : ''}
      <button id="verifyCloseBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Close</button>
    </div>
  </div>`;
  document.body.appendChild(modal);

  document.getElementById('verifyCloseBtn').addEventListener('click', () => document.body.removeChild(modal));

  // Per-row drop
  modal.querySelectorAll('.verify-resolve-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const uid = btn.dataset.uid;
      state.alerts = state.alerts.filter(a => a.alertUid !== uid);
      LS.set('msp_alerts', state.alerts);
      btn.closest('.verify-row').remove();
      showToast('✓ Dropped from Companion', 'ok');
    });
  });

  // Drop all
  const dropAllBtn = document.getElementById('verifyDropAllBtn');
  if (dropAllBtn) {
    dropAllBtn.addEventListener('click', () => {
      const ghostUids = new Set(ghosts.map(a => a.alertUid));
      state.alerts = state.alerts.filter(a => !ghostUids.has(a.alertUid));
      LS.set('msp_alerts', state.alerts);
      // Refresh views
      try { renderAlertList?.(); } catch {}
      try { render?.(); } catch {}
      document.body.removeChild(modal);
      showToast(`✓ Dropped ${ghosts.length} ghost${ghosts.length!==1?'s':''} from Companion`, 'ok');
    });
  }
}

function injectAlertGroupingToggle() {
  if (document.getElementById('alertGroupToggleBlock')) return;
  const container = document.getElementById('settingsExtras');
  if (!container) return;

  const groupOn = state.settings.groupAlerts === true;

  const block = document.createElement('div');
  block.id = 'alertGroupToggleBlock';
  block.style.cssText = 'margin:14px 0;padding:12px;border:1px solid var(--border);border-radius:6px;width:100%;flex:1 1 100%;box-sizing:border-box;background:rgba(224,123,0,0.04)';
  block.innerHTML = `
    <div style="font-family:var(--cond);font-size:11px;font-weight:700;letter-spacing:0.09em;color:var(--textdim);margin-bottom:10px">⚡ ALERT GROUPING</div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;font-size:13px">
      <input type="checkbox" id="set-groupAlerts" ${groupOn?'checked':''} style="cursor:pointer" />
      <span>Group related alerts as incidents</span>
    </label>
    <div style="font-size:11px;color:var(--textdim);margin-top:4px;line-height:1.5">When enabled, alerts at the same site with the same monitor type firing within 5 minutes are clustered into incidents. You can also manually group alerts or use AI detection. Off by default.</div>
  `;
  container.appendChild(block);

  document.getElementById('set-groupAlerts')?.addEventListener('change', e => {
    const on = !!e.target.checked;
    saveSettings({ groupAlerts: on });
    if (on) {
      // Run clustering immediately if turning on
      pruneEmptyIncidents();
      runRuleBasedClustering();
      showToast('✓ Alert grouping ON — incidents clustered', 'ok');
    } else {
      // Don't delete incidents, just stop showing them — turning back on later will surface them again
      showToast('✓ Alert grouping OFF', 'ok');
    }
    renderAlertList();
  });
}

// ─── BACKUP / RESTORE ─────────────────────────────────────────────
// Keys that represent persistent user data — not transient caches that can rebuild from API
const BACKUP_KEYS = [
  'msp_settings',
  'msp_tickets',
  'msp_alerts',
  'msp_resolved',
  'msp_at_companies',
  'msp_at_picklist',
  'msp_at_priority_picklist',
  'msp_at_ticket_picklists',
  'msp_notes',
  'msp_ai',
  'msp_chats',
  'msp_ticket_chats',
  'msp_kb_context_cache',
  'msp_history_context_cache',
  'msp_investigations',
  'msp_templates',
  'msp_kb',
  'msp_psa_excluded',
  'msp_excluded',
  'msp_hidden_clients',
  'msp_incidents',
  'msp_critical_snoozes',
  'msp_snoozed',
  'msp_last_handoff',
  'msp_view',
  'msp_lightmode',
];

function exportBackup() {
  const data = { schemaVersion: 1, exportedAt: new Date().toISOString(), keys: {} };
  BACKUP_KEYS.forEach(key => {
    const v = localStorage.getItem(key);
    if (v != null) data.keys[key] = v;
  });
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const today = new Date().toISOString().substring(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `msp-companion-backup-${today}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  // Stamp a "last backup" marker so we know when this happened
  localStorage.setItem('msp_last_backup', new Date().toISOString());
  return Object.keys(data.keys).length;
}

function importBackup(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); }
  catch(e) { throw new Error('File is not valid JSON'); }
  if (!data || typeof data !== 'object' || !data.keys) {
    throw new Error('File does not look like a Companion backup');
  }
  if (data.schemaVersion && data.schemaVersion > 1) {
    throw new Error(`Backup is from a newer version of Companion (schema ${data.schemaVersion}). Update Companion before restoring.`);
  }
  const keys = data.keys || {};
  const restoredKeys = [];
  Object.entries(keys).forEach(([key, value]) => {
    if (!BACKUP_KEYS.includes(key)) return; // ignore unexpected keys defensively
    if (typeof value !== 'string') return;
    localStorage.setItem(key, value);
    restoredKeys.push(key);
  });
  return { restoredKeys, exportedAt: data.exportedAt };
}

function showRestoreConfirmModal(file) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px';
    modal.innerHTML = `<div style="background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:24px;width:100%;max-width:520px">
      <div style="font-family:var(--cond);font-size:16px;font-weight:700;letter-spacing:0.08em;margin-bottom:6px;color:#e07b00">⚠ Restore from Backup</div>
      <div style="font-size:13px;color:var(--text);margin-bottom:14px;line-height:1.5">Restoring will <strong>replace</strong> your current Companion data — settings, templates, investigations, KB entries, exclusions — with what's in <code style="background:rgba(0,0,0,0.15);padding:2px 6px;border-radius:3px">${esc(file.name)}</code>.</div>
      <div style="font-size:12px;color:var(--textdim);margin-bottom:16px;padding:10px;background:rgba(224,123,0,0.08);border-left:3px solid #e07b00;border-radius:3px">After restore, the page will reload. Anything in your current Companion that isn't in the backup will be lost. Make a fresh backup first if you have new work since this file was created.</div>
      <div style="display:flex;gap:8px">
        <button id="restoreConfirmBtn" style="flex:2;cursor:pointer;background:#e07b00;border:none;color:#fff;padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:700;letter-spacing:0.07em">⚠ Replace All Data & Restore</button>
        <button id="restoreCancelBtn" style="flex:1;cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:10px;border-radius:4px;font-family:var(--cond);font-size:13px;font-weight:600">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(modal);
    document.getElementById('restoreCancelBtn').addEventListener('click', () => {
      document.body.removeChild(modal); resolve(false);
    });
    document.getElementById('restoreConfirmBtn').addEventListener('click', () => {
      document.body.removeChild(modal); resolve(true);
    });
  });
}

function injectCriticalPromptSettings() {
  if (document.getElementById('criticalPromptBlock')) return;
  const container = document.getElementById('settingsExtras');
  if (!container) return;

  const enabled = state.settings.autoCreatePromptCritical === true;
  const threshold = parseInt(state.settings.autoCreatePromptThresholdMin) || 15;
  const excluded = state.settings.autoCreatePromptExcluded || [];

  const block = document.createElement('div');
  block.id = 'criticalPromptBlock';
  block.style.cssText = 'margin:14px 0;padding:12px;border:1px solid var(--border);border-radius:6px;width:100%;flex:1 1 100%;box-sizing:border-box;background:rgba(200,16,46,0.04)';
  block.innerHTML = `
    <div style="font-family:var(--cond);font-size:11px;font-weight:700;letter-spacing:0.09em;color:var(--textdim);margin-bottom:10px">⚠ CRITICAL ALERT PROMPTS</div>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;font-size:13px">
      <input type="checkbox" id="set-autoCreatePromptCritical" ${enabled?'checked':''} style="cursor:pointer" />
      <span>Prompt to create ticket for unticketed Critical alerts</span>
    </label>
    <div style="font-size:11px;color:var(--textdim);margin:4px 0 10px;line-height:1.5">When ON: Companion shows a banner suggesting ticket creation for any Critical alert that's been open without a ticket past the threshold below. You stay in control — no automatic ticket submission.</div>

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">
      <label style="font-size:12px;color:var(--textmid)">Prompt after</label>
      <input type="number" id="set-autoCreatePromptThresholdMin" min="1" max="240" value="${threshold}" style="width:60px;padding:5px 8px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;font-size:13px" />
      <label style="font-size:12px;color:var(--textmid)">minutes without a ticket</label>
    </div>

    <div style="font-family:var(--cond);font-size:10px;font-weight:700;letter-spacing:0.08em;color:var(--textdim);margin-bottom:6px">EXCLUDED CLIENTS (never prompt)</div>
    <div id="critPromptExcludedList" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
      ${excluded.length ? excluded.map(s => `<span class="excluded-chip" data-client="${esc(s)}">${esc(s)} <button data-action="remove-crit-excluded" data-client="${esc(s)}">×</button></span>`).join('') : '<span style="color:var(--textdim);font-size:11px">None</span>'}
    </div>
    <div style="display:flex;gap:6px">
      <input type="text" id="critExcludeInput" placeholder="Datto site name to exclude..." style="flex:1;padding:6px 8px;background:var(--bg);border:1px solid var(--border);color:var(--text);border-radius:3px;font-size:12px" />
      <button id="critExcludeAddBtn" style="cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:6px 12px;border-radius:3px;font-family:var(--cond);font-size:11px;font-weight:600;letter-spacing:0.07em">+ Add</button>
    </div>
    <div id="critPromptStatus" style="font-family:var(--cond);font-size:11px;min-height:14px;margin-top:6px;color:var(--textdim)"></div>
  `;
  container.appendChild(block);

  const statusEl = document.getElementById('critPromptStatus');
  const flash = (msg, color) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = color || 'var(--textdim)';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
  };

  document.getElementById('set-autoCreatePromptCritical')?.addEventListener('change', e => {
    saveSettings({ autoCreatePromptCritical: !!e.target.checked });
    flash(e.target.checked ? '✓ Critical prompts ON' : '✓ Critical prompts OFF');
    if (e.target.checked) startCriticalScanner();
    renderCriticalPromptBanner();
  });
  document.getElementById('set-autoCreatePromptThresholdMin')?.addEventListener('change', e => {
    const v = parseInt(e.target.value);
    if (!v || v < 1 || v > 240) { e.target.value = state.settings.autoCreatePromptThresholdMin || 15; return; }
    saveSettings({ autoCreatePromptThresholdMin: v });
    flash(`✓ Threshold set to ${v} minutes`);
    renderCriticalPromptBanner();
  });
  document.getElementById('critExcludeAddBtn')?.addEventListener('click', () => {
    const input = document.getElementById('critExcludeInput');
    const name = (input?.value || '').trim();
    if (!name) return;
    const current = state.settings.autoCreatePromptExcluded || [];
    if (current.includes(name)) { flash('Already excluded', '#e07b00'); return; }
    saveSettings({ autoCreatePromptExcluded: [...current, name] });
    if (input) input.value = '';
    // Re-inject to refresh chip list
    document.getElementById('criticalPromptBlock')?.remove();
    injectCriticalPromptSettings();
    flash(`✓ Excluded ${name}`);
    renderCriticalPromptBanner();
  });
}

function injectBackupRestore() {
  if (document.getElementById('backupRestoreBlock')) return;
  const container = document.getElementById('settingsExtras');
  if (!container) return;

  const lastBackupISO = localStorage.getItem('msp_last_backup');
  const lastBackupDisplay = lastBackupISO ? new Date(lastBackupISO).toLocaleString() : 'never';
  const daysSince = lastBackupISO
    ? Math.floor((Date.now() - new Date(lastBackupISO).getTime()) / 86400000)
    : null;
  const stale = daysSince === null || daysSince > 7;

  const block = document.createElement('div');
  block.id = 'backupRestoreBlock';
  block.style.cssText = 'margin:14px 0;padding:12px;border:1px solid var(--border);border-radius:6px;width:100%;flex:1 1 100%;box-sizing:border-box;background:rgba(42,157,92,0.04)';
  block.innerHTML = `
    <div style="font-family:var(--cond);font-size:11px;font-weight:700;letter-spacing:0.09em;color:var(--textdim);margin-bottom:10px">💾 BACKUP & RESTORE</div>
    <div style="font-size:11px;color:var(--textdim);margin-bottom:10px;line-height:1.5">
      Companion stores your settings, templates, investigations, and KB entries in your browser's local storage. Clearing browser data wipes this. <strong>Back up regularly.</strong>
    </div>
    <div style="font-size:11px;color:${stale?'#e07b00':'var(--textmid)'};margin-bottom:10px">
      Last backup: <strong>${lastBackupDisplay}</strong>${daysSince !== null && daysSince > 0 ? ` (${daysSince} day${daysSince!==1?'s':''} ago)` : ''}
      ${stale ? ' — recommend a fresh backup' : ''}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button id="exportBackupBtn" style="cursor:pointer;background:rgba(42,157,92,0.18);border:1px solid rgba(42,157,92,0.5);color:#2a9d5c;padding:8px 14px;border-radius:4px;font-family:var(--cond);font-size:12px;font-weight:700;letter-spacing:0.07em">⬇ Download Backup</button>
      <button id="importBackupBtn" style="cursor:pointer;background:transparent;border:1px solid var(--border);color:var(--textmid);padding:8px 14px;border-radius:4px;font-family:var(--cond);font-size:12px;font-weight:600;letter-spacing:0.07em">⬆ Restore from File</button>
      <input type="file" id="importBackupFile" accept=".json,application/json" style="display:none" />
    </div>
    <div id="backupStatus" style="font-family:var(--cond);font-size:11px;min-height:14px;margin-top:8px;color:var(--textdim)"></div>
  `;
  container.appendChild(block);

  const statusEl = document.getElementById('backupStatus');
  const flash = (msg, color) => {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = color || 'var(--textdim)';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
  };

  document.getElementById('exportBackupBtn')?.addEventListener('click', () => {
    try {
      const count = exportBackup();
      flash(`✓ Backup downloaded — ${count} keys saved`, '#2a9d5c');
      // Refresh the "last backup" display
      setTimeout(() => {
        const block = document.getElementById('backupRestoreBlock');
        if (block) { block.remove(); injectBackupRestore(); }
      }, 1500);
    } catch(err) {
      flash(`Export failed: ${err.message}`, '#c8102e');
    }
  });

  document.getElementById('importBackupBtn')?.addEventListener('click', () => {
    document.getElementById('importBackupFile')?.click();
  });

  document.getElementById('importBackupFile')?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // reset so same file can be picked again
    try {
      const text = await file.text();
      // Quick pre-validate before showing the confirm
      const data = JSON.parse(text);
      if (!data?.keys) { flash('Not a Companion backup file', '#c8102e'); return; }
      const confirmed = await showRestoreConfirmModal(file);
      if (!confirmed) return;
      const result = importBackup(text);
      flash(`✓ Restored ${result.restoredKeys.length} keys — reloading...`, '#2a9d5c');
      setTimeout(() => location.reload(), 1200);
    } catch(err) {
      flash(`Restore failed: ${err.message}`, '#c8102e');
    }
  });
}

function injectAiContextToggles() {
  if (document.getElementById('aiCtxToggleBlock')) return;
  const container = document.getElementById('settingsExtras');
  if (!container) return;

  const kbDefault = state.settings.includeKbContext !== false;
  const histDefault = state.settings.includeTicketHistory !== false;

  const block = document.createElement('div');
  block.id = 'aiCtxToggleBlock';
  block.style.cssText = 'margin:14px 0;padding:12px;border:1px solid var(--border);border-radius:6px;width:100%;flex:1 1 100%;box-sizing:border-box;background:rgba(0,180,216,0.04)';
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
  container.appendChild(block);

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
  injectAppStyles();
  // Init API modules with settings accessor
  initDatto(() => state.settings);
  initAt(() => state.settings);
  initAI(() => state.settings);
  registerSW();
  loadSettings();
  injectAiContextToggles();
  injectAlertGroupingToggle();
  injectCriticalPromptSettings();
  injectBackupRestore();
  injectHandoffButton();
  injectClientsViewAndNav();
  injectComplianceViewAndNav();
  injectVerifyButton();
  injectVerifyAutotaskButton();
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
  startCriticalScanner();

  if (state.settings.apiKey && state.settings.secretKey) {
    await refreshAll();
  } else {
    setView('settings');
    showToast('Welcome to MSP Companion — configure your credentials in Settings','info');
  }
}

// Stop timer cleanly when user closes tab or navigates away
// Save any in-progress timer cleanly when user closes tab or navigates away
window.addEventListener('beforeunload', () => stopTicketTimer());

boot();
