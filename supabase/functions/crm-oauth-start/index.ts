import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GHL_CLIENT_ID = Deno.env.get("GHL_CLIENT_ID")!;

// Scopes needed: list locations, generate per-location tokens, manage contacts/calendars.
const SCOPES = [
  "locations.readonly",
  "oauth.write",
  "oauth.readonly",
  "contacts.readonly",
  "contacts.write",
  "calendars.readonly",
  "calendars/events.readonly",
  "calendars/events.write",
].join(" ");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.replace("Bearer ", "");
  if (!jwt) return jsonResponse({ error: "unauthorized" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData } = await supabase.auth.getUser(jwt);
  const user = userData?.user;
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  // Admin check
  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!roleRow) return jsonResponse({ error: "forbidden" }, 403);

  const body = await req.json().catch(() => ({}));
  const redirectUri: string = body.redirect_uri;
  if (!redirectUri) return jsonResponse({ error: "redirect_uri required" }, 400);

  const state = crypto.randomUUID();
  await supabase.from("oauth_states").insert({ state, user_id: user.id });

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri,
    client_id: GHL_CLIENT_ID,
    scope: SCOPES,
    state,
  });

  const authUrl = `https://marketplace.gohighlevel.com/oauth/chooselocation?${params.toString()}`;
  return jsonResponse({ url: authUrl });
});
