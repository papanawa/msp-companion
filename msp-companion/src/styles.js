// MSP Companion — Injected app styles
// Self-contained CSS — no external dependency. Imported by app.js and called once at boot.

export function injectAppStyles() {
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
    select.ticket-field-select.ticket-field-dirty {
      border-color: #c8a000;
      background: rgba(200,160,0,0.06);
      box-shadow: 0 0 0 1px rgba(200,160,0,0.25);
    }
    .ticket-save-bar {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .ticket-save-summary {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.07em;
      color: #c8a000;
    }
    .ticket-save-actions {
      display: flex;
      gap: 8px;
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
    /* Verify-with-Datto button + modal */
    .verify-datto-btn {
      display: block;
      width: calc(100% - 20px);
      margin: 8px 10px;
      cursor: pointer;
      background: rgba(0,180,216,0.06);
      border: 1px dashed rgba(0,180,216,0.4);
      color: var(--accent);
      padding: 6px 10px;
      border-radius: 4px;
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      transition: background 0.15s, border-color 0.15s;
    }
    .verify-datto-btn:hover:not(:disabled) {
      background: rgba(0,180,216,0.12);
      border-style: solid;
    }
    .verify-datto-btn:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    .verify-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 4px;
      margin-bottom: 4px;
      font-size: 12px;
      color: var(--text);
    }
    .verify-uid {
      font-family: var(--mono, monospace);
      font-size: 11px;
      color: var(--accent);
      margin-right: 8px;
    }
    .verify-resolve-btn {
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textmid);
      padding: 4px 10px;
      border-radius: 3px;
      font-family: var(--cond);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.07em;
    }
    .verify-resolve-btn:hover {
      border-color: #c8102e;
      color: #c8102e;
    }
    /* Alert list toolbar (multi-select + AI cluster button) */
    .alert-list-toolbar {
      display: flex;
      gap: 6px;
      padding: 6px 10px 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .alert-list-toolbar .abtn {
      font-size: 11px;
      padding: 5px 10px;
    }
    /* Incidents */
    .incident-block {
      border: 1px solid rgba(224,123,0,0.35);
      border-radius: 5px;
      margin: 6px 10px;
      background: rgba(224,123,0,0.04);
      overflow: hidden;
    }
    .incident-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .incident-header:hover {
      background: rgba(224,123,0,0.08);
    }
    .incident-arrow {
      font-size: 11px;
      color: var(--textdim);
      width: 12px;
      flex-shrink: 0;
    }
    .incident-meta {
      flex: 1;
      min-width: 0;
    }
    .incident-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 4px;
    }
    .incident-sub {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      font-size: 11px;
    }
    .incident-count {
      color: var(--textmid);
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-weight: 700;
      letter-spacing: 0.05em;
    }
    .incident-source {
      color: var(--textdim);
      font-family: var(--cond);
      font-size: 10px;
      letter-spacing: 0.07em;
    }
    .incident-ungroup-btn {
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textdim);
      padding: 3px 9px;
      border-radius: 3px;
      font-family: var(--cond);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.07em;
      flex-shrink: 0;
    }
    .incident-ungroup-btn:hover {
      border-color: #c8102e;
      color: #c8102e;
    }
    .list-row-child {
      margin-left: 22px;
      margin-right: 6px;
      border-color: rgba(224,123,0,0.2);
      background: rgba(0,0,0,0.04);
    }
    .incident-child-indicator {
      color: var(--textdim);
      font-size: 11px;
      margin-right: 4px;
    }
    .incident-eject-btn {
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textdim);
      width: 22px;
      height: 22px;
      border-radius: 3px;
      padding: 0;
      font-size: 14px;
      line-height: 1;
      margin-left: 4px;
    }
    .incident-eject-btn:hover {
      border-color: #c8102e;
      color: #c8102e;
    }
    .alert-select-cb {
      width: 16px;
      height: 16px;
      cursor: pointer;
      flex-shrink: 0;
      margin-right: 6px;
    }
    /* AI cluster review modal */
    .ai-cluster-proposal {
      padding: 10px 12px;
      margin-bottom: 8px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: rgba(0,0,0,0.05);
    }
    .ai-cluster-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .ai-cluster-checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      flex: 1;
      min-width: 0;
    }
    .ai-cluster-checkbox input { cursor: pointer; flex-shrink: 0; }
    .ai-cluster-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
    }
    .ai-cluster-count {
      font-family: var(--cond);
      font-size: 11px;
      color: var(--accent);
      font-weight: 700;
      letter-spacing: 0.07em;
    }
    .ai-cluster-reasoning {
      font-size: 11px;
      color: var(--textdim);
      font-style: italic;
      margin-bottom: 8px;
      line-height: 1.4;
    }
    .ai-cluster-alerts {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ai-cluster-alert {
      display: flex;
      gap: 8px;
      align-items: center;
      font-size: 11px;
      padding: 4px 6px;
      border-radius: 3px;
      background: rgba(0,0,0,0.04);
    }
    .ai-cluster-host {
      font-family: var(--mono, monospace);
      font-weight: 600;
      color: var(--accent);
      flex-shrink: 0;
    }
    .ai-cluster-msg {
      color: var(--textmid);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    /* Templates */
    .tpl-suggestions {
      background: rgba(147,51,234,0.06);
      border: 1px solid rgba(147,51,234,0.25);
      border-radius: 5px;
      padding: 10px 12px;
      margin: 8px 0 12px;
    }
    .tpl-suggestions-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.07em;
      color: var(--accent);
      margin-bottom: 8px;
    }
    .tpl-suggestion-row {
      padding: 8px 10px;
      margin-bottom: 4px;
      border: 1px solid var(--border);
      border-radius: 4px;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
      background: var(--bg);
    }
    .tpl-suggestion-row:last-child { margin-bottom: 0; }
    .tpl-suggestion-row:hover {
      border-color: var(--accent);
      background: rgba(0,180,216,0.04);
    }
    .tpl-suggestion-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 3px;
    }
    .tpl-suggestion-meta {
      font-size: 11px;
      color: var(--textdim);
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .inv-template-badge {
      display: inline-block;
      font-family: var(--cond);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.07em;
      color: var(--accent);
      background: rgba(0,180,216,0.08);
      border: 1px solid rgba(0,180,216,0.3);
      padding: 3px 9px;
      border-radius: 3px;
      margin-bottom: 10px;
    }
    .inv-step-verify {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 4px;
      font-size: 11px;
    }
    .inv-step-verify-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: #2a9d5c;
      flex-shrink: 0;
      padding: 2px 6px;
      background: rgba(42,157,92,0.1);
      border: 1px solid rgba(42,157,92,0.3);
      border-radius: 3px;
    }
    .inv-step-verify-input {
      flex: 1;
      background: transparent;
      border: 1px solid transparent;
      color: var(--textmid);
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-family: inherit;
      font-style: italic;
      min-width: 0;
    }
    .inv-step-verify-input:hover:not(:focus) { border-color: var(--border); }
    .inv-step-verify-input:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--bg);
      font-style: normal;
    }
    .inv-step-verify-empty { margin-top: 4px; }
    .inv-step-add-verify {
      cursor: pointer;
      background: transparent;
      border: 1px dashed var(--border);
      color: var(--textdim);
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 10px;
      font-family: var(--cond);
      letter-spacing: 0.05em;
    }
    .inv-step-add-verify:hover {
      border-color: rgba(42,157,92,0.5);
      border-style: solid;
      color: #2a9d5c;
    }
    /* Template modals */
    .tpl-modal-label {
      display: block;
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: var(--textdim);
      margin: 10px 0 4px;
    }
    .tpl-modal-input {
      width: 100%;
      padding: 8px 10px;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 4px;
      font-size: 13px;
      font-family: inherit;
      box-sizing: border-box;
    }
    .tpl-modal-input:focus {
      outline: none;
      border-color: var(--accent);
    }
    /* Template editor step rows */
    .tpl-ed-step {
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 8px 10px;
      margin-bottom: 6px;
      background: var(--bg);
    }
    .tpl-ed-step-head {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .tpl-ed-step-num {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 13px;
      font-weight: 700;
      color: var(--textdim);
      min-width: 18px;
      text-align: center;
    }
    .tpl-ed-step-text {
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
    .tpl-ed-step-text:hover:not(:focus) { border-color: var(--border); }
    .tpl-ed-step-text:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--bg);
    }
    .tpl-ed-step-verify {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-top: 5px;
      padding-left: 24px;
    }
    .tpl-ed-step-verify-input {
      flex: 1;
      background: transparent;
      border: 1px solid transparent;
      color: var(--textmid);
      padding: 3px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-family: inherit;
      font-style: italic;
      min-width: 0;
    }
    .tpl-ed-step-verify-input:hover:not(:focus) { border-color: var(--border); }
    .tpl-ed-step-verify-input:focus {
      outline: none;
      border-color: var(--accent);
      background: var(--bg);
      font-style: normal;
    }
    /* Template picker rows */
    .tpl-picker-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      margin-bottom: 6px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--bg);
    }
    .tpl-picker-row:hover {
      border-color: var(--accent);
    }
    .tpl-picker-main { flex: 1; min-width: 0; }
    .tpl-picker-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tpl-picker-desc {
      font-size: 12px;
      color: var(--textmid);
      margin-bottom: 5px;
      line-height: 1.4;
    }
    .tpl-picker-meta {
      font-size: 11px;
      color: var(--textdim);
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .tpl-picker-author { color: var(--textdim); }
    .tpl-private-pill, .tpl-mine-pill {
      font-family: var(--cond);
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.07em;
      padding: 1px 6px;
      border-radius: 3px;
    }
    .tpl-private-pill {
      background: rgba(200,160,0,0.12);
      color: #c8a000;
      border: 1px solid rgba(200,160,0,0.4);
    }
    .tpl-mine-pill {
      background: rgba(0,180,216,0.12);
      color: var(--accent);
      border: 1px solid rgba(0,180,216,0.4);
    }
    .tpl-picker-actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }
    .tpl-delete-btn {
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--textdim);
      width: 28px;
      height: 28px;
      border-radius: 3px;
      font-size: 14px;
      line-height: 1;
      padding: 0;
    }
    .tpl-delete-btn:hover {
      border-color: #c8102e;
      color: #c8102e;
    }
    /* Drift modal */
    .tpl-drift-section {
      margin: 10px 0;
      padding: 8px 12px;
      background: rgba(0,0,0,0.05);
      border-radius: 4px;
    }
    .tpl-drift-label {
      font-family: var(--cond);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .tpl-drift-section ul {
      margin: 0;
      padding-left: 20px;
      font-size: 12px;
      color: var(--text);
    }
    .tpl-drift-section li { margin: 3px 0; line-height: 1.4; }
    /* Critical alert prompt banner */
    .critical-prompt-container {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 800;
      max-width: 460px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      pointer-events: none;
    }
    .critical-prompt-banner {
      pointer-events: auto;
      background: linear-gradient(135deg, rgba(200,16,46,0.16), rgba(200,16,46,0.08));
      border: 1px solid rgba(200,16,46,0.5);
      border-left: 4px solid #c8102e;
      border-radius: 5px;
      padding: 10px 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
      backdrop-filter: blur(8px);
      animation: critical-slide 0.25s ease-out;
    }
    @keyframes critical-slide {
      from { opacity: 0; transform: translateX(20px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    .critical-prompt-msg { font-size: 13px; color: var(--text); line-height: 1.5; margin-bottom: 8px; }
    .critical-prompt-icon { color: #c8102e; font-size: 14px; margin-right: 6px; }
    .critical-prompt-detail {
      font-size: 11px;
      color: var(--textmid);
      margin-top: 4px;
      padding-left: 24px;
    }
    .critical-prompt-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .critical-prompt-actions .abtn { font-size: 11px; padding: 5px 10px; }
    .critical-prompt-more {
      pointer-events: auto;
      font-family: var(--cond);
      font-size: 11px;
      color: var(--textdim);
      padding: 6px 12px;
      text-align: center;
      background: rgba(0,0,0,0.4);
      border-radius: 4px;
    }
    /* Excluded clients chip */
    .excluded-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      padding: 3px 4px 3px 8px;
      background: rgba(0,0,0,0.15);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--textmid);
    }
    .excluded-chip button {
      background: transparent;
      border: none;
      color: var(--textdim);
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      padding: 0 4px;
    }
    .excluded-chip button:hover { color: #c8102e; }
    /* Investigation time tracker badge */
    button.inv-time-badge,
    .inv-time-badge {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.07em;
      padding: 3px 8px;
      border-radius: 3px;
      color: var(--textmid);
      background: rgba(0,180,216,0.08);
      border: 1px solid rgba(0,180,216,0.3);
      text-transform: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: default;
    }
    button.inv-time-badge {
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    .inv-time-badge.inv-time-active {
      color: #2a9d5c;
      background: rgba(42,157,92,0.1);
      border-color: rgba(42,157,92,0.4);
      animation: time-pulse 2s ease-in-out infinite;
    }
    button.inv-time-badge.inv-time-active:hover {
      background: rgba(42,157,92,0.18);
      border-color: rgba(42,157,92,0.6);
    }
    .inv-time-badge.inv-time-paused {
      color: #c8a000;
      background: rgba(200,160,0,0.1);
      border-color: rgba(200,160,0,0.4);
      animation: none;
    }
    button.inv-time-badge.inv-time-paused:hover {
      background: rgba(200,160,0,0.18);
      border-color: rgba(200,160,0,0.6);
    }
    .inv-time-action {
      font-size: 9px;
      letter-spacing: 0.08em;
      opacity: 0.75;
      padding-left: 4px;
      border-left: 1px solid currentColor;
    }
    @keyframes time-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(42,157,92,0.3); }
      50%      { box-shadow: 0 0 0 4px rgba(42,157,92,0); }
    }
    /* Handoff modal */
    .handoff-saved {
      background: rgba(0,180,216,0.04);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 4px;
      padding: 12px 14px;
      margin-bottom: 16px;
    }
    .handoff-saved-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: var(--accent);
      margin-bottom: 8px;
    }
    .handoff-content {
      font-size: 13px;
      color: var(--text);
      line-height: 1.6;
      max-height: 360px;
      overflow-y: auto;
      padding-right: 8px;
    }
    .handoff-section {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.06em;
      margin: 10px 0 4px;
      color: var(--text);
    }
    .handoff-generate-block {
      background: rgba(0,0,0,0.05);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 14px;
    }
    .handoff-generate-label {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.09em;
      color: var(--textdim);
      margin-bottom: 10px;
    }
    /* Client trend sparklines */
    .client-trend {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-right: 6px;
    }
    .client-trend-loading,
    .client-trend-empty {
      font-size: 10px;
      color: var(--textdim);
      font-style: italic;
    }
    .client-trend-delta {
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      padding: 1px 5px;
      border-radius: 2px;
    }
    .client-trend-up {
      color: #c8102e;
      background: rgba(200,16,46,0.1);
      border: 1px solid rgba(200,16,46,0.3);
    }
    .client-trend-down {
      color: #2a9d5c;
      background: rgba(42,157,92,0.1);
      border: 1px solid rgba(42,157,92,0.3);
    }
    .client-trend-flat {
      color: var(--textdim);
      background: rgba(0,0,0,0.05);
      border: 1px solid var(--border);
    }
    /* Reports stat trend visuals */
    .reports-stat-spark {
      margin: 4px 0 6px;
      opacity: 0.85;
    }
    .reports-stat-window {
      color: var(--textdim);
    }
    .rpt-trend {
      display: inline-block;
      font-family: var(--cond, 'Bebas Neue', sans-serif);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      padding: 1px 6px;
      border-radius: 2px;
      margin-right: 4px;
    }
    .rpt-trend-good {
      color: #2a9d5c;
      background: rgba(42,157,92,0.1);
      border: 1px solid rgba(42,157,92,0.3);
    }
    .rpt-trend-bad {
      color: #c8102e;
      background: rgba(200,16,46,0.1);
      border: 1px solid rgba(200,16,46,0.3);
    }
    .rpt-trend-flat {
      color: var(--textdim);
      background: rgba(0,0,0,0.05);
      border: 1px solid var(--border);
    }
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

    /* ─── KB UPGRADES ──────────────────────────────────────────────── */
    .kb-tag-cloud {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      padding: 8px 0 12px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 10px;
    }
    .kb-tag {
      background: none;
      border: 1px solid var(--border);
      border-radius: 3px;
      color: var(--textdim);
      cursor: pointer;
      font-family: var(--cond);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      padding: 2px 7px;
      transition: border-color 0.12s, color 0.12s, background 0.12s;
    }
    .kb-tag:hover {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(0,180,216,0.06);
    }
    .kb-tag-active {
      border-color: var(--accent);
      color: var(--accent);
      background: rgba(0,180,216,0.1);
    }
    .kb-card-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 4px;
    }
    .kb-card-actions { flex-shrink: 0; }
    .kb-push-btn { font-size: 11px !important; padding: 3px 8px !important; }
    .kb-at-badge {
      font-family: var(--cond);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.06em;
      color: #2a9d5c;
      border: 1px solid #2a9d5c55;
      border-radius: 3px;
      padding: 2px 7px;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);
}
