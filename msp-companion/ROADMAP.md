# MSP Companion — Roadmap

Last updated: MSPCompanion3 session (file split + bug sweep).

---

## ✅ Recently Shipped

### Core workflow
- Datto RMM + Autotask PSA integration via Vercel proxy
- Dashboard with resolution pipeline (Needs Attention → Ticket → In Progress → Resolved)
- Alert list with severity sorting, client filters, ticket-linkage badges
- Locked-mode alert detail when a ticket exists (jump to ticket)
- Ticket list grouped by resource, default to active statuses, "show waiting/hold" toggle

### Ticket detail
- Inline status / priority / queue / resource / **work type** editing with batch save
- Accept and Complete buttons with resolution guard
- Datto Device panel (online/offline, storage, AV/patch)
- Activity feed of recent AT notes
- Ticket metadata panel (issue type, sub-issue, source, due/SLA, contract)
- Open in Datto / Open in Autotask deep-links
- `findTicketById` helper with fallback to currentTicket

### AI features
- Alert quick triage with KB context + client ticket history auto-injection
- Ticket investigation flow (analyze → editable checklist → step notes → draft resolution)
- Tech context input
- Mid-investigation chat with full plan + step notes context (template-aware)
- AI-formatted Save to KB (Symptom / Diagnosis / Fix)
- AI incident clustering for related alerts
- ⭐ **Investigation Templates** — auto-suggestion, verification criteria per step, drift detection, AI chat awareness
- ⭐ **Auto-create tickets for Critical** — configurable threshold + excluded clients + snooze/dismiss banner
- ⭐ **Shift handoff report** — AI summary modal with persistent saved handoff for next tech
- ⭐ **Time-on-ticket tracking** — auto-timer with explicit pause/resume button + 4h session cap
- ⭐ **Templates button in post-analysis view** — can now apply/overwrite template after investigation runs

### Knowledge base, Reports, Clients
- KB save from alerts and tickets with AI-formatted entries
- Reports view: alert trend, MTTR with trend arrows, tech workload, top clients, aging tickets
- ⭐ **Reports trend visuals** — sparklines + delta badges on all top stat cards
- ⭐ **Tracked Labor widget** in Reports + per-tech labor breakdown
- Client Health Dashboard with drill-down slide-in panel
- ⭐ **Client trend sparklines** — 30-day open-ticket trend per client with delta badge
- Per-client hide toggle

### Reliability
- Verify with Datto button (alert cache vs API drift detection)
- **Verify with Autotask button** (ticket cache vs API drift detection)
- Ghost ticket auto-cleanup (syncTicketStatuses drops tickets AT no longer returns)
- **Refresh All on dashboard now pulls full ticket list** (was only syncing alert-linked)
- Smart alert grouping (rule-based auto + AI on-demand + manual)
- Auto-resolve linked alerts on ticket complete (extends to incident siblings)
- Resource role auto-fill on assignment
- ⭐ **Backup & Restore** — download/upload all Companion data as JSON (Settings → Preferences)
- Audit pass — added msp_excluded, msp_snoozed to backup keys (were silently lost on restore)
- ⭐ **Alert count consistency fix** — client grid now uses same filter as dashboard badge; auto-resolved Information alerts stripped from state immediately
- ⭐ **AT Notes 404 fix** — corrected endpoint from child-collection pattern to `/TicketNotes/query`; activity feed now populates
- ⭐ **Handoff site exclusion** — excluded clients now filtered from Shift Handoff report

### Architecture
- ⭐ **File split refactor (Phases 1–4)** — extracted `styles.js`, `utils.js`, `api/datto.js`, `api/autotask.js`, `api/anthropic.js`, `ai/prompts.js` from monolithic app.js. app.js reduced from ~9,600 to ~7,000 lines. Phase 5 (view modules) deferred — render functions are too state-coupled to split cleanly without a shared-state architecture change.

### Polish
- Cleanup pass — debug noise removed, sections renamed
- Favicon + apple-touch-icon + mobile-web-app-capable meta (deprecation warning fixed)
- Timer badge starts before render (immediate visibility on Apply Template)
- ⭐ **Settings layout overflow fixed** — injected setting panels (AI Context, Alert Grouping, Critical Prompts, Backup) now render as proper grid cards via dedicated `settingsExtras` slot; Save Preferences button no longer overflows

---

## 🎯 Next Session Queue (in order)

### 1. Bulk actions on alerts (UNFINISHED — partially built)
**Current state:** the ☐ Selecting toggle already activates checkboxes on alert rows, and the "+ Group N" button works for creating manual incidents from the selected set. But there's no other action you can take with the selection.

**What to add:**
- **Bulk resolve** — resolve all selected alerts in Datto in one go
- **Bulk create-ticket-each** — open the create-ticket flow for each selected alert sequentially
- **Bulk save-to-KB** — open the AI-formatted Save to KB modal pre-loaded with all selected alerts as context
- **Bulk snooze** — snooze all selected for N hours
- These join the existing "+ Group N" button when selecting mode is active. Buttons appear/disappear based on whether selection is empty or not.

### 2. Create a Template (from scratch, no ticket required)
Right now templates can only be born from a worked investigation — you have to live through a problem before you can capture its pattern. But experienced techs already KNOW many patterns from runbooks, vendor docs, or muscle memory. They should be able to author templates directly.

**What to add:**
- New button on the Templates list (template picker modal): **+ Create Template**
- Modal with: name, description, public/private toggle, tag editor (with auto-suggestions), and a step editor
- Step editor: add/edit/remove/reorder steps; each step has text + optional verification criteria
- Optional: **AI-assist scaffolding** — a "Generate from description" button. Tech types "Windows Server graceful reboot procedure" → AI generates a starter checklist the tech can edit before saving
- Same data shape as templates born from investigations, so they slot into the existing auto-suggest, apply, and drift-detection systems with no extra work

### 3. Software Compliance Management (Datto RMM integration)
Datto RMM tracks devices as Compliant / Non-Compliant / Unmanaged based on software policies. Companion can surface this and drive remediation through the same patterns we use for alerts and tickets.

**Phase A — Read & visualize (low risk, definitely doable):**
- New nav item or tab under Clients: **Compliance**
- Per-client compliance overview — donut chart matching Datto's, with counts (compliant / non-compliant / unmanaged)
- Drill into a client → see the actual non-compliant devices and *what's missing on each*
- Surfaces same data Datto already has but in Companion's contextual flow alongside alerts, tickets, and history
- Reuses existing drill-down panel pattern (built for Client Health Dashboard)

**Phase B — AI-assisted remediation (validate API access first):**
- AI Investigation pattern applied to compliance gaps — Claude reads the gap and suggests existing Datto components that would close it
- Bulk-trigger Datto jobs against selected non-compliant devices via API (`/account/jobs` endpoint)
- Async job execution polling — show progress, mark devices remediated when verified
- AI-formatted KB entry from the remediation pattern (so the next tech with the same gap finds the answer)

**⚠ Pre-build verification needed:** Datto API access for component/job execution may be gated to higher subscription tiers. Confirm via API test before committing to Phase B.

**Architectural fit:** identifies + targets + triggers + verifies. Datto executes. Same separation we maintain everywhere else (Companion never replicates Datto's job execution, scripting, or component authoring).

### 4. Ticket merge
When two tickets are about the same issue (often: alert→ticket creation races against tech manual creation).
- Select two tickets, click Merge
- Combined notes, resolution, time entries
- One ticket survives; other becomes "merged into T-XXX" reference
- Linked alerts re-point to the surviving ticket

### 5. Ticket lookup + completed investigation visibility
Solves the "I have no way to pull up that old ticket" gap.
- **Search box at top of Tickets list** — by ticket number or partial title
  - If ticket is in cache, jump straight to it
  - If not, hit AT API directly to fetch that single ticket → load into state → open
- **Investigation card renders for any ticket with stored investigation**
  - Same edit capabilities as live investigations
  - "Save as Template" stays available — enables retroactive templating

### 6. "What changed since I last looked" pill
- Track last-viewed timestamp per view
- On return, highlight new alerts/tickets that arrived since
- Subtle "new since 2pm" pills

### 7. KB tagging upgrade + Push to Autotask KB
- Tag autocomplete from existing tags
- Click-to-filter by tag, tag cloud on KB view
- **Push Companion KB entries up to Autotask KB**
  - Sync direction: Companion → AT (one-way, opt-in per entry)
  - Maps Companion KB schema → AT KB schema
  - Avoids duplicates by tracking which Companion entries have been pushed

### 8. Dashboard stat-card drill-downs
The big stat cards on the dashboard (Open Alerts, Critical, High, Open Tickets, Mismatches, No Ticket) should be clickable.
- Click "11 Open Tickets" → see those 11 tickets in a slide-in panel
- Click "1 Critical" → see the 1 critical alert
- Reuses the drill-down panel pattern from Client Health Dashboard

---

## 📦 Deferred / Lower Priority

- **Mobile layout pass** — PWA bones there, narrow-width breaks in places
- **Desktop notifications** for new Criticals
- **On-call awareness** — Companion knows who's on call, routes Criticals
- **Saved searches / filter presets**
- **Auto-backup reminder** — banner if last backup > 7 days
- **Storage volumes section** — only renders for online/active devices; offline devices (like IGNITE22) show nothing by design — no action needed unless behavior changes

---

## 🔌 Engineering Projects (weeks not days)

- **Slack integration** — Critical alerts to channel, threaded replies → ticket notes
- **Weekly client reports** — auto-generated PDF per client
- **Client portal (read-only)** — per-client login showing their tickets/resolutions
- **Smart routing** — ML/AI learns "alerts like this usually go to Travis"
- **Multi-MSP / multi-tenant** — only if Companion becomes a product

---

## 🚫 Off the table (intentional non-goals)

- Datto feature replication (remote, scripts, patches, **component authoring**) — Datto does these well
- AT feature replication (timesheets, invoicing, contracts) — AT does these well
- Non-MSP ticketing — stay focused on the Datto+AT shape
- AI-driven actions without human-in-the-loop — Companion suggests, humans decide

---

## 🛠 Architecture / Tech Debt

- **File splitting** — Phases 1–4 complete. `api/`, `ai/`, `utils`, and `styles` all extracted. View modules (Phase 5) deferred — render functions are too tightly coupled to `state` to split without a shared-state architecture refactor. Revisit when/if the event wiring section gets the same treatment.
- **Nested project folder** — `C:\Tools\msp-companion\msp-companion\` is redundant nesting. Vercel Root Directory setting compensates but worth cleaning up.
- **localStorage growth** — Investigations grow indefinitely. ~3 MB/year at current rate. Cleanup routine for tickets completed > 1 year ago.
- **Pagination on long lists** — Tickets/clients/aging render everything. Fine today; needed at 1000+.
- **Schema migrations** — Add a "schema version" + migration runner before any breaking change. Backup file already includes `schemaVersion: 1`.
- **EVENT WIRING section is over 1000 lines** — candidate for per-feature split in a future session.
- **Test coverage** — none today. Cost likely exceeds value for a solo internal tool.

---

## 📋 External commitments

- ~~**Plaid compliance attestations**~~ ✅ — All 12 items complete.
