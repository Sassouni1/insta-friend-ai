// GHL Marketplace App webhook receiver.
//
// GHL sends every subscribed event (e.g. ContactCreate) to ONE global URL
// configured in your marketplace app. There is no per-sub-account secret —
// auth is via Ed25519 signature in the X-GHL-Signature header, verified
// against GHL's published public key. Same key for every tenant.
//
// Flow per ContactCreate:
//   1. Verify signature.
//   2. Look up tenant by locationId (the sub-account).
//   3. Use that tenant's OAuth token to check if contact already has any
//      appointment in any calendar. If yes → skip.
//   4. Dedupe against scheduled_calls in the last 24h.
//   5. Schedule a delayed dial; pass tenant.name (sub-account) + contact name
//      to the bridge so Sam greets them properly.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { GhlClient, getFreshGhlToken } from "../_shared/ghl.ts";
import { fireCall, scheduleBackground } from "../_shared/dialer.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DEFAULT_DELAY_SECONDS = 120;

// GHL's published Ed25519 public key for X-GHL-Signature.
const GHL_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return der;
}

let cachedKey: CryptoKey | null = null;
async function getGhlPublicKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const der = pemToDer(GHL_PUBLIC_KEY_PEM);
  cachedKey = await crypto.subtle.importKey(
    "spki",
    der,
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return cachedKey;
}

async function verifyGhlSignature(rawBody: string, signatureB64: string): Promise<boolean> {
  try {
    const key = await getGhlPublicKey();
    const sig = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
    const data = new TextEncoder().encode(rawBody);
    return await crypto.subtle.verify("Ed25519", key, sig, data);
  } catch (err) {
    console.error("[ghl-webhook] sig verify error", err);
    return false;
  }
}

function pickPhone(body: any): string | null {
  const candidates = [
    body?.phone,
    body?.contact?.phone,
    body?.data?.phone,
    body?.full_phone,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return null;
}

function pickName(body: any): string | null {
  const c = body?.contact || body?.data || body || {};
  if (body?.name) return String(body.name);
  if (c.name) return String(c.name);
  const first = c.firstName || c.first_name || body?.firstName || body?.first_name || "";
  const last = c.lastName || c.last_name || body?.lastName || body?.last_name || "";
  const full = `${first} ${last}`.trim();
  return full || null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const rawBody = await req.text();
  const signature =
    req.headers.get("x-ghl-signature") ||
    req.headers.get("X-GHL-Signature") ||
    "";

  // Allow ?debug=1 in dev to bypass signature (logs only) — remove or lock down later.
  const url = new URL(req.url);
  const debugBypass = url.searchParams.get("debug") === "1";

  if (!debugBypass) {
    if (!signature) {
      console.warn("[ghl-webhook] missing X-GHL-Signature");
      return jsonResponse({ error: "missing signature" }, 401);
    }
    const ok = await verifyGhlSignature(rawBody, signature);
    if (!ok) {
      console.warn("[ghl-webhook] invalid signature");
      return jsonResponse({ error: "invalid signature" }, 401);
    }
  }

  let body: any;
  try { body = JSON.parse(rawBody); } catch { return jsonResponse({ error: "invalid json" }, 400); }

  const eventType: string = body?.type || "";
  // Only act on ContactCreate. Acknowledge everything else.
  if (eventType !== "ContactCreate") {
    return jsonResponse({ ok: true, ignored: eventType || "no-type" });
  }

  const locationId: string | undefined =
    body?.locationId || body?.location_id || body?.contact?.locationId || body?.data?.locationId;
  if (!locationId) {
    console.warn("[ghl-webhook] no locationId in payload");
    return jsonResponse({ ok: true, ignored: "no locationId" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tenant } = await supabase
    .from("tenants")
    .select("id, name, active")
    .eq("ghl_location_id", locationId)
    .maybeSingle();

  if (!tenant) {
    console.log(`[ghl-webhook] no tenant for location ${locationId}`);
    return jsonResponse({ ok: true, ignored: "tenant not found", locationId });
  }
  if (!tenant.active) {
    return jsonResponse({ ok: true, ignored: "tenant inactive" });
  }

  // Phone: try payload, fall back to fetching the contact via API.
  let phone = pickPhone(body);
  let name = pickName(body);
  let email: string | null = body?.email || body?.contact?.email || body?.data?.email || null;
  const contactId: string | null = body?.id || body?.contact?.id || body?.data?.id || null;

  let ghlClient: GhlClient | null = null;
  async function ensureGhl(): Promise<GhlClient | null> {
    if (ghlClient) return ghlClient;
    try {
      const { token, locationId: locId } = await getFreshGhlToken(supabase, tenant.id);
      ghlClient = new GhlClient(token, locId);
      return ghlClient;
    } catch (err: any) {
      console.error(`[ghl-webhook] token fetch failed for ${tenant.id}:`, err.message);
      return null;
    }
  }

  if (!phone && contactId) {
    const c = await ensureGhl();
    if (c) {
      try {
        const contact = await c.getContact(contactId);
        phone = phone || contact?.phone || null;
        name = name || [contact?.firstName, contact?.lastName].filter(Boolean).join(" ") || null;
        email = email || contact?.email || null;
      } catch (err: any) {
        console.warn(`[ghl-webhook] contact fetch failed for ${contactId}:`, err.message);
      }
    }
  }

  if (!phone) {
    return jsonResponse({ ok: true, ignored: "no phone on contact", contactId });
  }

  // Already-booked check: if contact has any appointment, skip the dial.
  if (contactId) {
    const c = await ensureGhl();
    if (c) {
      try {
        const appts = await c.getContactAppointments(contactId);
        if (appts && appts.length > 0) {
          console.log(`[ghl-webhook] skipping ${phone} — already has ${appts.length} appointment(s)`);
          return jsonResponse({ ok: true, skipped: "already booked", count: appts.length });
        }
      } catch (err: any) {
        // Don't block the dial on a check failure — log and continue.
        console.warn(`[ghl-webhook] appt check failed for ${contactId}:`, err.message);
      }
    }
  }

  // Dedupe: same tenant + phone in the last 24h
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: existing } = await supabase
    .from("scheduled_calls")
    .select("id, status, created_at")
    .eq("tenant_id", tenant.id)
    .eq("lead_phone", phone)
    .gte("created_at", since)
    .limit(1)
    .maybeSingle();

  if (existing) {
    console.log(`[ghl-webhook] dedupe: ${phone} already scheduled (${existing.id}, ${existing.status})`);
    return jsonResponse({ ok: true, deduped: existing.id });
  }

  const fireAt = new Date(Date.now() + DEFAULT_DELAY_SECONDS * 1000).toISOString();

  const { data: row, error: insErr } = await supabase
    .from("scheduled_calls")
    .insert({
      tenant_id: tenant.id,
      lead_phone: phone,
      lead_name: name,
      lead_email: email,
      ghl_contact_id: contactId,
      fire_at: fireAt,
    })
    .select("id, fire_at")
    .single();

  if (insErr || !row) {
    console.error("[ghl-webhook] insert failed", insErr);
    return jsonResponse({ ok: false, error: "scheduling failed" }, 200); // 200 so GHL doesn't 5xx-retry storm
  }

  console.log(`[ghl-webhook] scheduled ${row.id} (${tenant.name} → ${name || phone}) firing in ${DEFAULT_DELAY_SECONDS}s`);

  scheduleBackground(async () => {
    await new Promise((r) => setTimeout(r, DEFAULT_DELAY_SECONDS * 1000));
    await fireCall(row.id, "ghl-webhook");
  });

  return jsonResponse({
    ok: true,
    scheduled_id: row.id,
    fire_at: row.fire_at,
    tenant: tenant.name,
  });
});
