# MSP Companion — Roadmap

Last updated: end of work session, prior to next planned session.

---

## ✅ Recently Shipped

### Core workflow
- Datto RMM + Autotask PSA integration via Vercel proxy
- Dashboard with resolution pipeline (Needs Attention → Ticket → In Progress → Resolved)
- Alert list with severity sorting, client filters, ticket-linkage badges
- Locked-mode alert detail when a ticket exists (jump to ticket)
- Ticket list grouped by resource, default to active statuses, "show waiting/hold" toggle

### Ticket detail
- Inline status / priority / queue / resource editing with batch save
- Accept and Complete buttons with resolution guard
- Datto Device panel (online/offline, storage, AV/patch)
- Activity feed of recent AT notes
- Ticket metadata panel (issue type, sub-issue, source, work type, due/SLA, contract)
- Open in Datto / Open in Autotask deep-links

### AI features
- Alert quick triage with KB context + client ticket history auto-injection
- Ticket investigation flow (analyze → editable checklist → step notes → draft resolution)
- Tech context input
- Mid-investigation chat with full plan + step notes context
- AI-formatted Save to KB (Symptom / Diagnosis / Fix)
- AI incident clustering for related alerts

### Knowledge base, Reports, Clients
- KB save from alerts and tickets with AI-formatted entries
- Reports view: alert trend, MTTR with trend arrows, tech workload, top clients, aging tickets
- Client Health Dashboard with drill-down slide-in panel
- Per-client hide toggle

### Reliability
- Verify with Datto button (cache vs API drift detection)
- Smart alert grouping (rule-based auto + AI on-demand + manual)
- Auto-resolve linked alerts on ticket complete (extends to incident siblings)
- Resource role auto-fill on assignment
- Cleanup pass — debug noise removed, sections renamed for clarity

---

## 🎯 Next Session Queue (in order)

### 1. ⭐ Investigation Templates (PRIORITY)
Save a successful investigation plan as a reusable template.
- Save current investigation as template (button on the investigation card)
- Library view of saved templates
- Apply template to a new ticket with one click — populates plan steps
- Tag templates (by monitor type, client, etc.) for findability
- Templates are MSP-wide knowledge accumulation — every fixed problem becomes a starting point for the next one

### 2. Auto-create tickets for Critical (manual, not automatic)
- Setting in Preferences (default OFF)
- Configurable threshold (default 15min after Critical alert appears with no ticket)
- Excluded clients list
- When a Critical alert hits the age threshold, a "Create ticket" prompt surfaces — not automatic submission

### 3. Shift handoff report
End-of-shift AI summary for the next tech.
- "What's new, what's open, what to watch"
- Pulls from today's alerts, ticket activity, open criticals, aging tickets
- One button → modal → copy or save
- Lower urgency for Synobis (small team) but valuable if Companion ever ships to others

### 4. Time-on-ticket tracking
- Auto-timer starts when investigation card opens
- Stops on Draft Resolution click
- Logs labor time per ticket
- Reports view: actual labor vs AT-logged (surfaces under-billed hours)

### 5. Trends in Client Health Dashboard
- Sparklines on each client row showing 30-day open ticket and alert counts
- Spot trending-worse clients without clicking through
- Builds on existing client list

### 6. "What changed since I last looked" pill
- Track last-viewed timestamp per view
- On return, highlight new alerts/tickets that arrived since
- Subtle "new since 2pm" pills
- Helps re-entry after lunch / next morning

### 7. KB tagging upgrade + Push to Autotask KB
- Tag autocomplete from existing tags
- Click-to-filter by tag, tag cloud on KB view
- **NEW: Push Companion KB entries up to Autotask KB**
  - Sync direction: Companion → AT (one-way, opt-in per entry)
  - Maps Companion KB schema → AT KB schema
  - Avoids duplicates by tracking which Companion entries have been pushed
  - Useful when AT KB is the team's "source of truth" — Companion drafts, AT publishes

### 8. Ticket merge
When two tickets are about the same issue (often: alert→ticket creation races against tech manual creation).
- Select two tickets, click Merge
- Combined notes, resolution, time entries
- One ticket survives; other becomes "merged into T-XXX" reference
- Linked alerts re-point to the surviving ticket

### 9. Bulk actions on alerts
Multi-select already exists for incident grouping. Extend to:
- Bulk resolve
- Bulk create-ticket-each
- Bulk save-to-KB
- Bulk snooze

---

## 📦 Deferred / Lower Priority

- **Mobile layout pass** — PWA bones there, narrow-width breaks in places
- **Desktop notifications** for new Criticals
- **On-call awareness** — Companion knows who's on call, routes Criticals
- **Saved searches / filter presets**

---

## 🔌 Engineering Projects (weeks not days)

- **Slack integration** — Critical alerts to channel, threaded replies → ticket notes
- **Weekly client reports** — auto-generated PDF per client
- **Client portal (read-only)** — per-client login showing their tickets/resolutions
- **Smart routing** — ML/AI learns "alerts like this usually go to Travis"
- **Multi-MSP / multi-tenant** — only if Companion becomes a product

---

## 🚫 Off the table (intentional non-goals)

- Datto feature replication (remote, scripts, patches) — Datto does these well
- AT feature replication (timesheets, invoicing, contracts) — AT does these well
- Non-MSP ticketing — stay focused on the Datto+AT shape
- AI-driven actions without human-in-the-loop — Companion suggests, humans decide

---

## 🛠 Architecture / Tech Debt

- **File splitting** — At ~6,700 lines, app.js is approaching upper limit. Consider splitting into `api.js`, `ai.js`, `views.js`, `app.js` (orchestrator) once it crosses ~8,000.
- **Pagination on long lists** — Tickets/clients/aging render everything. Fine today; needed at 1000+.
- **Schema migrations** — localStorage schema has grown organically. Add a "schema version" + migration runner before any breaking change.
- **EVENT WIRING section is 949 lines** — could split per-feature. Punt until it actively hurts.
- **Test coverage** — none today. For a solo internal tool, cost likely exceeds value. Revisit if Companion grows beyond Synobis.

---

## 📋 External commitments

- **Plaid compliance attestations** — 12 items, due 10/28/2026. Privacy policy attestation done. Not in Companion scope.

