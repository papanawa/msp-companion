// MSP Companion — Pure utility helpers
// No state, no side effects (except LS which writes to localStorage).
// Imported by app.js and any future modules that need these.

export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

export function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

// localStorage wrapper — graceful on quota errors / parse errors
export const LS = {
  get: (k, def=null) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ─── TIME / DURATION FORMATTERS ─────────────────────────────────
export function fmtMsAsDuration(ms) {
  if (!ms || ms < 1000) return '0m';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 60) return `${totalMin}m`;
  const hrs = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
}

export function fmtDuration(ms) {
  if (ms == null) return '—';
  const hrs = ms / 3600000;
  if (hrs < 24) return hrs.toFixed(1) + 'h';
  const days = hrs / 24;
  return days.toFixed(1) + 'd';
}

export function fmtRelativeTime(ts) {
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

export function fmtBytes(mb) {
  if (mb == null || isNaN(mb)) return '';
  if (mb > 1024*1024) return (mb/1024/1024).toFixed(1) + ' TB';
  if (mb > 1024)      return (mb/1024).toFixed(1) + ' GB';
  return Math.round(mb) + ' MB';
}

export function fmtSlaClock(dueDateStr) {
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

// Light markdown rendering for handoff reports — bolds section headers, preserves newlines
export function fmtHandoffContent(text) {
  return esc(text)
    .replace(/^(🚨|🔧|⚠|✅|📌)\s*([A-Z][A-Z\s]+)$/gm, '<div class="handoff-section">$1 $2</div>')
    .replace(/\n/g, '<br>');
}
