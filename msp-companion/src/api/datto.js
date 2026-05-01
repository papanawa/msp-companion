// MSP Companion — Datto RMM API module
// Handles OAuth auth, device/alert/site fetching, and alert normalization.
// Call init(getSettings) once at boot before using any other export.

let _getSettings;
let dattoToken = null;
let dattoTokenExpiry = 0;

const DEVICE_CACHE_TTL_MS = 5 * 60 * 1000;   // 5 minutes
const _deviceCache = {};

export function init(getSettings) { _getSettings = getSettings; }

/** Reset stored OAuth token (call after saving new Datto credentials). */
export function resetDattoToken() { dattoToken = null; dattoTokenExpiry = 0; }

/** Evict one entry from the device cache (used by the device-refresh action). */
export function clearDeviceCacheEntry(deviceUid) { delete _deviceCache[deviceUid]; }

// ─── AUTH ─────────────────────────────────────────────────────────
export async function dattoAuth() {
  if (dattoToken && Date.now() < dattoTokenExpiry) return dattoToken;
  const s = _getSettings();
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

// ─── CORE FETCH ───────────────────────────────────────────────────
export async function dattoFetch(path) {
  const token = await dattoAuth();
  const platformUrl = (_getSettings().platformUrl || 'https://concord-api.centrastage.net').replace(/\/$/, '');
  const res = await fetch(`/api/datto?path=${encodeURIComponent(path)}&method=GET`, {
    headers: { 'Authorization': `Bearer ${token}`, 'x-platform-url': platformUrl }
  });
  if (!res.ok) throw new Error(`Datto API error: HTTP ${res.status}`);
  return res.json();
}

// ─── DEVICE ───────────────────────────────────────────────────────
export async function fetchDattoDevice(deviceUid) {
  if (!deviceUid) return null;
  const cached = _deviceCache[deviceUid];
  if (cached && (Date.now() - cached.fetchedAt) < DEVICE_CACHE_TTL_MS) return cached.data;
  try {
    const [device, openAlerts] = await Promise.all([
      dattoFetch(`/device/${deviceUid}`),
      dattoFetch(`/device/${deviceUid}/alerts/open?max=50`).catch(() => ({ alerts: [] })),
    ]);
    const data = { device, openAlertCount: (openAlerts?.alerts || openAlerts?.items || []).length };
    _deviceCache[deviceUid] = { data, fetchedAt: Date.now() };
    return data;
  } catch(e) { console.warn('Device fetch failed:', e.message); return null; }
}

// ─── ALERT NORMALIZATION ──────────────────────────────────────────
export function normalizeAlert(raw) {
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

// ─── ALERTS / SITES ───────────────────────────────────────────────
export async function fetchAlerts() {
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

export async function fetchSites() {
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

export async function resolveAlert(alertUid) {
  const token = await dattoAuth();
  const platformUrl = (_getSettings().platformUrl || 'https://concord-api.centrastage.net').replace(/\/$/, '');
  const res = await fetch(`/api/datto?path=${encodeURIComponent('/alert/'+alertUid+'/resolve')}&method=POST`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'x-platform-url': platformUrl }
  });
  if (!res.ok && res.status !== 204) throw new Error(`Resolve failed: HTTP ${res.status}`);
}

export async function fetchAllDattoSites() {
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
