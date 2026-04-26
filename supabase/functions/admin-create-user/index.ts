// One-off admin tool: create a confirmed user + grant admin role.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const email = url.searchParams.get("email");
  const password = url.searchParams.get("password");
  const makeAdmin = url.searchParams.get("admin") === "1";
  if (!email || !password) return jsonResponse({ error: "email + password required" }, 400);

  const sb: any = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Check if user exists
  const { data: list } = await sb.auth.admin.listUsers();
  const existing = list?.users?.find((u: any) => u.email?.toLowerCase() === email.toLowerCase());

  let userId: string;
  if (existing) {
    const { data, error } = await sb.auth.admin.updateUserById(existing.id, {
      password,
      email_confirm: true,
    });
    if (error) return jsonResponse({ error: error.message }, 500);
    userId = data.user.id;
  } else {
    const { data, error } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) return jsonResponse({ error: error.message }, 500);
    userId = data.user.id;
  }

  if (makeAdmin) {
    await sb.from("user_roles").upsert({ user_id: userId, role: "admin" }, { onConflict: "user_id,role" });
  }

  return jsonResponse({ ok: true, user_id: userId, email, admin: makeAdmin, created: !existing });
});
