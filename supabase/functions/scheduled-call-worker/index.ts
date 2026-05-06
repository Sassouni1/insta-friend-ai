import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { fireCall, scheduleBackground } from "../_shared/dialer.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WORKER_SECRET = Deno.env.get("SCHEDULED_CALL_WORKER_SECRET")?.trim() || "";
const MAX_BATCH = 5;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  if (WORKER_SECRET) {
    const provided = req.headers.get("x-worker-secret") || new URL(req.url).searchParams.get("secret") || "";
    if (provided !== WORKER_SECRET) return jsonResponse({ error: "unauthorized" }, 401);
  }

  const supabase: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date().toISOString();

  const { data: dueRows, error } = await supabase
    .from("scheduled_calls")
    .select("id, fire_at, lead_phone, status")
    .eq("status", "pending")
    .lte("fire_at", now)
    .order("fire_at", { ascending: true })
    .limit(MAX_BATCH);

  if (error) {
    console.error("[scheduled-call-worker] due query failed", error);
    return jsonResponse({ error: "due query failed", details: error.message }, 500);
  }

  const ids = (dueRows || []).map((row: any) => row.id);
  if (!ids.length) return jsonResponse({ ok: true, processed: 0, ids: [] });

  scheduleBackground(async () => {
    await Promise.all(ids.map((id: string) => fireCall(id, "scheduled-call-worker")));
  });

  return jsonResponse({ ok: true, processed: ids.length, ids });
});
