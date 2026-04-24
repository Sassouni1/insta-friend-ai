import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { telnyxDial } from "../_shared/telnyx.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BRIDGE_WS_URL = `wss://${new URL(SUPABASE_URL).host.replace(".supabase.co", ".functions.supabase.co")}/telnyx-bridge`;

const BodySchema = z.object({
  tenant_id: z.string().uuid(),
  to_number: z.string().min(8),
  from_number: z.string().min(8),
  connection_id: z.string().min(1),
  caller_name: z.string().optional(),
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  // Admin auth
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data: claims, error: claimsErr } = await userClient.auth.getClaims(token);
  if (claimsErr || !claims?.claims?.sub) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", claims.claims.sub)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) return jsonResponse({ error: "forbidden" }, 403);

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return jsonResponse({ error: parsed.error.flatten().fieldErrors }, 400);
  }
  const { tenant_id, to_number, from_number, connection_id, caller_name } = parsed.data;

  // Pre-create conversation row so we have an id for the stream URL
  const { data: convRow, error: convErr } = await admin
    .from("conversations")
    .insert({
      tenant_id,
      caller_phone: to_number,
      direction: "outbound",
    })
    .select("id")
    .single();

  if (convErr || !convRow) {
    return jsonResponse({ error: "failed to create conversation" }, 500);
  }

  const streamUrl =
    `${BRIDGE_WS_URL}?conv=${convRow.id}&tenant=${tenant_id}&caller=${encodeURIComponent(to_number)}` +
    (caller_name ? `&name=${encodeURIComponent(caller_name)}` : "");

  const dialRes = await telnyxDial({
    to: to_number,
    from: from_number,
    connection_id,
    stream_url: streamUrl,
    stream_track: "both_tracks",
    stream_codec: "PCMU",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU",
  });

  if (!dialRes.ok) {
    const txt = await dialRes.text();
    console.error(`[telnyx-outbound] dial failed [${dialRes.status}]: ${txt}`);
    return jsonResponse({ error: `dial failed: ${txt}` }, 502);
  }

  const dialData = await dialRes.json();
  const callControlId = dialData?.data?.call_control_id;
  if (callControlId) {
    await admin
      .from("conversations")
      .update({ telnyx_call_control_id: callControlId })
      .eq("id", convRow.id);
  }

  return jsonResponse({ ok: true, conversation_id: convRow.id, call_control_id: callControlId });
});
