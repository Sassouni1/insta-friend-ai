// Diagnostic: pulls the full Telnyx call record + recent events for a call_control_id
// so we can see EXACTLY why a call ended (carrier SIP cause, hangup source, etc).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const apiKey = Deno.env.get("TELNYX_API_KEY")!;
  const url = new URL(req.url);
  const ccid = url.searchParams.get("ccid");
  if (!ccid) return jsonResponse({ error: "ccid required" }, 400);

  // Get the call record
  const callRes = await fetch(`https://api.telnyx.com/v2/calls/${encodeURIComponent(ccid)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const callJson = await callRes.json().catch(() => ({}));

  const legId = url.searchParams.get("leg_id");
  // Get call events by leg_id (uuid form, not v3:... ccid)
  const eventsRes = await fetch(
    `https://api.telnyx.com/v2/call_events?filter[call_leg_id]=${encodeURIComponent(legId || callJson?.data?.call_leg_id || "")}&page[size]=50`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  const eventsJson = await eventsRes.json().catch(() => ({}));

  return jsonResponse({
    call: { status: callRes.status, body: callJson },
    events: { status: eventsRes.status, body: eventsJson },
  });
});
