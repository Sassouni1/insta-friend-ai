import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AGENT_NAME = "Sam - Hair Systems";
const PREFERRED_VOICE_ID = "UgBBYS2sOqTuMpoF3BR0"; // Mark - Natural Conversations
const FALLBACK_VOICE_ID = "iP95p4xoKVk53GoZ742B"; // Chris (known-good default)

const SAM_CONVERSATION_CONFIG = {
  agent: {
    prompt: {
      prompt: "You are Sam. For phone calls, follow the runtime instructions supplied by the backend bridge.",
    },
    first_message: "",
    language: "en",
  },
  turn: {
    mode: "turn",
    turn_timeout: -1,
    turn_eagerness: "normal",
  },
  asr: {
    quality: "high",
    keywords: ["yes", "no", "yeah", "hair", "hair system", "transplant", "medication", "Pacific", "Central", "Eastern"],
  },
  tts: {
    model_id: "eleven_flash_v2",
    voice_id: FALLBACK_VOICE_ID,
    stability: 0.72,
    similarity_boost: 0.75,
    speed: 0.95,
  },
};

// Diagnostic helper: wraps ElevenLabs API calls with structured error info
interface OpResult {
  ok: boolean;
  status: number;
  data?: any;
  error_text?: string;
  stage: string;
  permission_hint?: string;
}

async function elevenLabsOp(
  stage: string,
  url: string,
  options: RequestInit,
  permissionScope: string
): Promise<OpResult> {
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok) {
      const hint = (res.status === 401 || res.status === 403)
        ? `Missing permission: ${permissionScope}`
        : res.status === 404
          ? `Not found (${permissionScope})`
          : undefined;
      console.error(`[${stage}] FAILED ${res.status}: ${text.slice(0, 200)}`);
      return { ok: false, status: res.status, error_text: text.slice(0, 300), stage, permission_hint: hint };
    }
    console.log(`[${stage}] OK ${res.status}`);
    return { ok: true, status: res.status, data, stage };
  } catch (err: any) {
    console.error(`[${stage}] EXCEPTION: ${err.message}`);
    return { ok: false, status: 0, error_text: err.message, stage, permission_hint: "network_error" };
  }
}

function resolveApiKey(): { key: string; source: string } {
  const custom = Deno.env.get("ELEVENLABS_API_KEY_CUSTOM")?.trim();
  const connector = Deno.env.get("ELEVENLABS_API_KEY")?.trim();
  if (custom) return { key: custom, source: "custom" };
  if (connector) return { key: connector, source: "connector" };
  throw new Error("No ElevenLabs API key configured");
}

async function runPipeline(apiKey: string, keySource: string) {
  const headers: Record<string, string> = {
    "xi-api-key": apiKey,
    "Content-Type": "application/json",
  };

  const diagnostics: OpResult[] = [];

  // Step 1: Check preferred voice access, fallback to default if not found
  let resolvedVoiceId = PREFERRED_VOICE_ID;
  const voiceCheck = await elevenLabsOp(
    "voice_access_check",
    `https://api.elevenlabs.io/v1/voices/${PREFERRED_VOICE_ID}`,
    { headers },
    "voice_access"
  );
  diagnostics.push(voiceCheck);
  if (!voiceCheck.ok) {
    console.warn(`Preferred voice ${PREFERRED_VOICE_ID} not accessible (${voiceCheck.status}). Falling back to ${FALLBACK_VOICE_ID}`);
    resolvedVoiceId = FALLBACK_VOICE_ID;
    // Verify fallback voice
    const fallbackCheck = await elevenLabsOp(
      "fallback_voice_check",
      `https://api.elevenlabs.io/v1/voices/${FALLBACK_VOICE_ID}`,
      { headers },
      "voice_access"
    );
    diagnostics.push(fallbackCheck);
    if (!fallbackCheck.ok) {
      return { success: false, diagnostics, key_source: keySource, error: `Neither preferred nor fallback voice accessible` };
    }
  }
  console.log(`Using voice: ${resolvedVoiceId}`);

  // Apply resolved voice to config
  const configToUse = {
    ...SAM_CONVERSATION_CONFIG,
    tts: { ...SAM_CONVERSATION_CONFIG.tts, voice_id: resolvedVoiceId },
  };

  // Step 2: Find existing agent (reuse, never delete)
  let agentId: string | null = Deno.env.get("ELEVENLABS_AGENT_ID")?.trim() || null;

  if (!agentId) {
    const listOp = await elevenLabsOp(
      "list_agents",
      "https://api.elevenlabs.io/v1/convai/agents",
      { headers },
      "convai_read"
    );
    diagnostics.push(listOp);

    if (listOp.ok) {
      const agents = listOp.data?.agents || [];
      const existing = agents.find((a: any) => a.name === AGENT_NAME);
      if (existing) {
        agentId = existing.agent_id;
        console.log(`Reusing existing agent: ${agentId}`);
      }
    } else if (listOp.status !== 401) {
      // Non-permission failure on list — bail
      return { success: false, diagnostics, key_source: keySource, error: `List agents failed: ${listOp.error_text}` };
    }
    // If 401 on list, we'll try to create directly
  }

  // Step 3: Create if not found
  if (!agentId) {
    const createOp = await elevenLabsOp(
      "create_agent",
      "https://api.elevenlabs.io/v1/convai/agents/create",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: AGENT_NAME,
          conversation_config: configToUse,
        }),
      },
      "convai_write"
    );
    diagnostics.push(createOp);
    if (!createOp.ok) {
      return { success: false, diagnostics, key_source: keySource, error: `Create agent failed: ${createOp.error_text}` };
    }
    agentId = createOp.data.agent_id;
    console.log(`Created agent: ${agentId}`);
  }

  // Step 4: Patch agent config (non-fatal)
  const patchOp = await elevenLabsOp(
    "patch_agent",
    `https://api.elevenlabs.io/v1/convai/agents/${agentId}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        name: AGENT_NAME,
        conversation_config: configToUse,
      }),
    },
    "convai_write"
  );
  diagnostics.push(patchOp);
  if (!patchOp.ok) {
    console.warn(`Patch failed (non-fatal): ${patchOp.error_text}`);
  }

  // Step 5: Get conversation token (WebRTC)
  const tokenOp = await elevenLabsOp(
    "get_conversation_token",
    `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${agentId}`,
    { headers },
    "convai_conversation"
  );
  diagnostics.push(tokenOp);
  if (!tokenOp.ok) {
    return { success: false, diagnostics, key_source: keySource, error: `Conversation token failed: ${tokenOp.error_text}` };
  }

  // Step 6: Get signed URL (WebSocket) for more compatible browser fallback / default web transport
  const signedUrlOp = await elevenLabsOp(
    "get_signed_url",
    `https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
    { headers },
    "convai_conversation"
  );
  diagnostics.push(signedUrlOp);

  return {
    success: true,
    token: tokenOp.data.token,
    signed_url: signedUrlOp.ok ? signedUrlOp.data.signed_url : null,
    agent_id: agentId,
    key_source: keySource,
    diagnostics,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { key: primaryKey, source: primarySource } = resolveApiKey();
    console.log(`Using key source: ${primarySource}`);

    let result = await runPipeline(primaryKey, primarySource);

    // Fallback: if primary key failed with permission error, try the other key
    if (!result.success && result.diagnostics?.some((d: OpResult) => d.status === 401 || d.status === 403)) {
      const fallbackKey = primarySource === "custom"
        ? Deno.env.get("ELEVENLABS_API_KEY")?.trim()
        : Deno.env.get("ELEVENLABS_API_KEY_CUSTOM")?.trim();

      if (fallbackKey) {
        const fallbackSource = primarySource === "custom" ? "connector" : "custom";
        console.log(`Primary key (${primarySource}) hit permission error. Trying fallback (${fallbackSource})...`);
        result = await runPipeline(fallbackKey, fallbackSource);
      }
    }

    if (!result.success) {
      return new Response(
        JSON.stringify({
          error: result.error,
          key_source: result.key_source,
          diagnostics: result.diagnostics,
        }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(
      JSON.stringify({
        token: result.token,
        signed_url: result.signed_url,
        agent_id: result.agent_id,
        key_source: result.key_source,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: unknown) {
    console.error("Top-level error:", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
