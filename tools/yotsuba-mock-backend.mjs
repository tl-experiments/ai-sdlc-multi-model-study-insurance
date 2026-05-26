#!/usr/bin/env node
/**
 * Tiny mock backend for the Yotsuba Claims demo UI.
 *
 * The frontend code each pass authored expects a NestJS backend at
 * http://localhost:3000 with /auth/* and /api/claims/* /api/reserves/*
 * /api/audit endpoints. The real backend doesn't compile (100-300 TS
 * errors per pass), so this is a hand-written stand-in that serves
 * realistic canned Yotsuba data — enough for the UI to render every
 * page with populated tables, gradient badges, and JFSA reserve tiers.
 *
 * Usage:
 *   node tools/yotsuba-mock-backend.mjs        # listens on :3000
 *   PORT=3001 node tools/yotsuba-mock-backend.mjs
 */
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.PORT || 3000);
const NOW = new Date();
const iso = (offsetMs = 0) => new Date(NOW.getTime() + offsetMs).toISOString();
const yen = (n) => n;   // Decimal strings would also work; numbers are fine for display

// ─── Canned data ─────────────────────────────────────────────────────
const USER = {
  id: "u_adjuster_takahashi",
  username: "takahashi.k",
  email: "takahashi@yotsuba.example.jp",
  display_name: "Takahashi Kenji",
  role: "adjuster",
  reports_to_id: null,
  is_claims_director: false,
  created_at: iso(-365 * 24 * 3600_000),
};

const DIRECTOR = { ...USER, id: "u_director_sato", username: "sato.h", display_name: "Sato Hiroko", role: "manager", is_claims_director: true };
const AGENT    = { ...USER, id: "u_agent_yamada",   username: "yamada.r", display_name: "Yamada Ryo",     role: "agent" };
const AUDITOR  = { ...USER, id: "u_auditor_tanaka", username: "tanaka.m", display_name: "Tanaka Mari",   role: "auditor" };

const PREFECTURES = ["Tokyo", "Osaka", "Kanagawa", "Aichi", "Hokkaido", "Kyoto", "Fukuoka"];
const INCIDENT_TYPES = ["auto_collision", "auto_property_damage", "fire_residential", "fire_commercial", "marine_cargo", "liability_premises", "personal_accident"];
const STATUSES = ["intake", "under_investigation", "awaiting_reserve_approval", "settlement_offered", "closed_paid"];
const SEVERITIES = ["simple", "complex", "catastrophic"];

const claims = Array.from({ length: 14 }, (_, i) => {
  const id = `clm_${String(i + 1).padStart(4, "0")}`;
  const incidentType = INCIDENT_TYPES[i % INCIDENT_TYPES.length];
  const severity = SEVERITIES[i % SEVERITIES.length];
  const status = STATUSES[i % STATUSES.length];
  return {
    id,
    policy_number: `POL-${2024}-${String(40000 + i).padStart(6, "0")}`,
    loss_date: iso(-(i + 1) * 4 * 24 * 3600_000),
    loss_location_prefecture: PREFECTURES[i % PREFECTURES.length],
    loss_location_postal_code: `1${i}${i}-${i}${i}${i}${i}`,
    loss_location_detail: `${PREFECTURES[i % PREFECTURES.length]}-shi, ${i + 1}-${i + 2}-${i + 3}`,
    reported_by_channel: ["agent", "mobile", "broker", "email"][i % 4],
    reporter_name: `Reporter ${["Kobayashi", "Watanabe", "Nakamura", "Ito", "Suzuki"][i % 5]}`,
    reporter_relation_to_insured: ["self", "spouse", "guardian", "agent"][i % 4],
    incident_type: incidentType,
    initial_description: "Vehicle collision at intersection during rush hour, third party involved, minor injuries reported.",
    injury_reported: i % 3 === 0,
    third_party_involved: i % 2 === 0,
    police_report_number: i % 3 === 0 ? `PR-${10000 + i}` : null,
    severity_initial: severity,
    status,
    appi_consent_version: "v2.1",
    appi_consent_at: iso(-(i + 1) * 5 * 24 * 3600_000),
    assigned_adjuster_id: i % 4 === 0 ? null : USER.id,
    assigned_adjuster: i % 4 === 0 ? null : USER,
    created_at: iso(-(i + 1) * 4 * 24 * 3600_000 + 3600_000),
    updated_at: iso(-i * 2 * 3600_000),
    reserve_total_yen: yen(500_000 + i * 250_000),
    notes_count: 2 + (i % 6),
    evidence_count: 1 + (i % 4),
  };
});

const notesFor = (claimId) => [
  { id: `note_${claimId}_1`, claim_id: claimId, author_id: USER.id, author: USER, body: "Initial intake completed. Coverage confirmed under policy. Verifying loss-date eligibility against bind date.", created_at: iso(-3 * 24 * 3600_000) },
  { id: `note_${claimId}_2`, claim_id: claimId, author_id: USER.id, author: USER, body: "Spoke with reporter. They confirmed photographs and police report will be uploaded by end of week.", created_at: iso(-2 * 24 * 3600_000) },
  { id: `note_${claimId}_3`, claim_id: claimId, author_id: DIRECTOR.id, author: DIRECTOR, body: "Severity escalated from simple to complex due to multi-party liability question. Reassign to senior adjuster team.", created_at: iso(-1 * 24 * 3600_000) },
];

const reservesFor = (claimId) => [
  { id: `res_${claimId}_1`, claim_id: claimId, category: "loss_paid",   proposed_yen: yen(3_500_000), prior_yen: null,           justification: "Initial estimate based on vehicle repair quote + 2 days car rental + medical excess.", proposed_by_id: USER.id, proposed_by: USER, proposed_at: iso(-2 * 24 * 3600_000), approval_status: "approved", approved_by_id: DIRECTOR.id, approved_at: iso(-1 * 24 * 3600_000) },
  { id: `res_${claimId}_2`, claim_id: claimId, category: "loss_unpaid", proposed_yen: yen(12_000_000), prior_yen: yen(3_500_000), justification: "Revised after third-party medical report received — long-term physiotherapy + lost wages estimate. Exceeds adjuster ceiling, routing to director.", proposed_by_id: USER.id, proposed_by: USER, proposed_at: iso(-12 * 3600_000), approval_status: "pending", approved_by_id: null, approved_at: null },
];

const pendingReserves = claims.slice(0, 6).flatMap((c, i) => [{
  id: `pres_${c.id}`,
  claim_id: c.id,
  claim: { id: c.id, policy_number: c.policy_number, incident_type: c.incident_type },
  category: ["loss_paid", "loss_unpaid", "alae", "ulae"][i % 4],
  proposed_yen: yen([800_000, 4_500_000, 12_000_000, 18_500_000, 35_000_000, 6_200_000][i]),
  prior_yen:    yen([null,    1_500_000,  3_500_000,  10_000_000, 25_000_000,  null     ][i]),
  justification: [
    "Property repair quote received; rounded up to cover tax + minor scope creep.",
    "Bodily injury claim — physical therapy + lost wages added per medical report.",
    "Third-party demand letter received; revising upward to anchor settlement negotiation.",
    "Total-loss declared; reserve covers ACV minus salvage + Total-loss processing fee.",
    "Catastrophic — multi-claim event from typhoon damage. Director approval required (>¥10M).",
    "Settlement reached; closing out residual ALAE for outside counsel fees.",
  ][i],
  proposed_by: USER,
  proposed_at: iso(-(i + 1) * 12 * 3600_000),
  approval_status: "pending",
  threshold_tier: ([null, 4_500_000, 12_000_000, 18_500_000, 35_000_000, 6_200_000][i] > 10_000_000) ? "director" : "manager",
}]);

const auditEvents = Array.from({ length: 36 }, (_, i) => {
  const actor = [USER, DIRECTOR, AGENT, AUDITOR][i % 4];
  const claim = claims[i % claims.length];
  const actions = ["claim.created", "claim.note_added", "claim.status_changed", "reserve.proposed", "reserve.approved", "evidence.uploaded", "claim.assigned", "claim.appi_consent_recorded"];
  return {
    id: `aud_${String(36 - i).padStart(5, "0")}`,
    actor_id: actor.id, actor_role: actor.role, actor: actor,
    action: actions[i % actions.length],
    claim_id: claim.id, claim: { id: claim.id, policy_number: claim.policy_number },
    target_id: claim.id,
    payload_hash: `sha256:${Math.random().toString(36).slice(2, 12)}`,
    request_id: `req_${Math.random().toString(36).slice(2, 12)}`,
    correlation_id: `cor_${claim.id}`,
    ts: iso(-i * 3 * 3600_000),
  };
});

// ─── Router ──────────────────────────────────────────────────────────
const routes = [
  { method: "POST",   match: /^\/auth\/login$/,                      handler: () => ({ access_token: "fake.jwt.token", user: USER }) },
  { method: "GET",    match: /^\/auth\/me$/,                         handler: () => USER },
  { method: "POST",   match: /^\/auth\/logout$/,                     handler: () => ({ ok: true }) },

  { method: "GET",    match: /^\/api\/claims\/?$/,                   handler: () => ({ data: claims, total: claims.length }) },
  { method: "GET",    match: /^\/api\/claims\/([^/]+)$/,             handler: (_b, [id]) => {
      const c = claims.find((x) => x.id === id) ?? claims[0];
      return { ...c, notes: notesFor(c.id), reserves: reservesFor(c.id), witness_statements: [], evidence: [] };
  } },
  { method: "GET",    match: /^\/api\/claims\/([^/]+)\/notes$/,      handler: (_b, [id]) => notesFor(id) },
  { method: "POST",   match: /^\/api\/claims\/([^/]+)\/notes$/,      handler: (body, [id]) => ({ id: `note_new_${Date.now()}`, claim_id: id, author: USER, body: body.body, created_at: iso() }) },
  { method: "GET",    match: /^\/api\/claims\/([^/]+)\/reserves$/,   handler: (_b, [id]) => reservesFor(id) },
  { method: "POST",   match: /^\/api\/claims\/([^/]+)\/reserves$/,   handler: (body, [id]) => ({ id: `res_new_${Date.now()}`, claim_id: id, ...body, approval_status: "pending", proposed_at: iso() }) },
  { method: "PATCH",  match: /^\/api\/claims\/([^/]+)\/status$/,     handler: (body, [id]) => ({ ok: true, id, status: body.status, updated_at: iso() }) },

  { method: "GET",    match: /^\/api\/reserves\/?$/,                 handler: () => ({ data: pendingReserves }) },
  { method: "GET",    match: /^\/api\/reserves\/pending\/?$/,        handler: () => pendingReserves },
  { method: "POST",   match: /^\/api\/reserves\/([^/]+)\/approve$/,  handler: (_b, [id]) => ({ id, approval_status: "approved", approved_by: DIRECTOR, approved_at: iso() }) },
  { method: "POST",   match: /^\/api\/reserves\/([^/]+)\/reject$/,   handler: (body, [id]) => ({ id, approval_status: "rejected", reason: body.reason, approved_at: iso() }) },
  { method: "POST",   match: /^\/api\/reserves\/([^/]+)\/director-approve$/, handler: (_b, [id]) => ({ id, approval_status: "approved", director_approved_by: DIRECTOR, director_approved_at: iso() }) },

  { method: "GET",    match: /^\/api\/audit\/?$/,                    handler: () => ({ data: auditEvents, total: auditEvents.length }) },
  { method: "GET",    match: /^\/api\/audit\/events\/?$/,            handler: () => ({ data: auditEvents, total: auditEvents.length }) },

  { method: "GET",    match: /^\/health$/,                           handler: () => ({ status: "ok", time: iso() }) },
];

// ─── Server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  let path = url.pathname;
  // The frontend may prefix with /api after a vite proxy rewrite; accept both.
  // (Our routes already include the /api or /auth prefix where appropriate.)

  let body = {};
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); } catch {}
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.match.exec(path);
    if (!m) continue;
    try {
      const result = r.handler(body, m.slice(1));
      const payload = await result;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload, null, 2));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found", path, method: req.method }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\nYotsuba mock backend → http://localhost:${PORT}`);
  console.log(`  ${routes.length} routes mounted`);
  console.log(`  GET /api/claims, /api/reserves/pending, /api/audit  · POST /auth/login\n`);
});
