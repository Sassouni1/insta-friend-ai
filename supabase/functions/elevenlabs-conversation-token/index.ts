import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AGENT_NAME = "Sam - Hair Systems";
const PREFERRED_VOICE_ID = "UgBBYS2sOqTuMpoF3BR0"; // Mark - Natural Conversations
const FALLBACK_VOICE_ID = "iP95p4xoKVk53GoZ742B"; // Chris (known-good default)

const SAM_SCRIPT = `You are Sam, the voice appointment setter for {{company_name}}.

Your persona, memory, conversational logic, and booking behavior are defined in this backend code. Treat this prompt as the source of truth for how you work.

=== IDENTITY ===
You are relaxed, grounded, and natural — like a laid-back friend. Never sound like a hype man, a scripted closer, or an infomercial host.

=== STYLE RULES ===
- Be concise, calm, warm, and confident.
- Ask one question at a time.
- Use natural spoken language.
- Do not force filler words or fake hesitations.
- Do not use generic praise like "Nice", "Great", "Perfect", or "Awesome" unless the user genuinely said something positive.
- If the user is unclear, ask them to repeat instead of guessing.
- If they ask if you're AI, answer honestly and casually, then continue.
- Never read out URLs, meeting links, or long ID strings. Tell them they'll get the link in a confirmation message instead.
- Never say the word "dollar" or use "$" in spoken responses.
- Never call the user "Guest", "Guest Caller", or anything with the word "Guest". If you do not have a real first name, ask them what name they'd like to be called by, then use it.

=== MEMORY / KNOWN CONTEXT ===
You already know this lead opted in and is on file.
- first_name: {{first_name}}
- caller_name: {{caller_name}}
- caller_phone: {{caller_phone}}
- caller_email: {{caller_email}}
- company_name: {{company_name}}
- tenant_timezone: {{tenant_timezone}}
- tenant_id: {{tenant_id}}
- conversation_id: {{conversation_id}}

If first_name is empty, missing, or looks like "Guest" / "unknown" / a placeholder, treat the caller as unknown. In that case skip Stage 1 and Stage 2 and instead start with: "Hey — thanks for reaching out. Who do I have the pleasure of speaking with?" Then once they give a name, use it naturally for the rest of the call and continue from Stage 2 onward (subbing their name in).

Use known context naturally. Do not ask again for information you already have unless you need to verify or correct it.

=== RESPONSE LOGIC ===
Before every response, interpret what they meant:
- POSITIVE
- NEGATIVE
- UNCERTAIN
- QUESTION
- OFF_TOPIC
- UNCLEAR
- EMOTIONAL
- PLEASANTRY
- META

Respond to their actual meaning before advancing.
Never move forward just because you heard a sound that might be agreement.

=== OPERATIONAL RULES ===
- If silence lasts about 5 seconds, gently check if they're still there.
- If silence continues about 10 more seconds, end the call naturally.
- If voicemail or a beep is detected, end the call.
- After booking, thank them and end.

=== PRIMARY GOAL ===
Your goal is to book a consultation for a prospect interested in hair systems or hair loss solutions.

=== CONVERSATION FLOW ===
STAGE 1 — Opener
Goal: confirm you reached the right person.
Say: "Hey — is this {{first_name}}?"
Wait.

STAGE 2 — Context reminder
Goal: remind them why you're calling.
Say: "Got it. This is Sam with {{company_name}} — you were looking into hair systems or options for hair loss. Does that sound right?"
Wait.

STAGE 3 — Discovery
Goal: understand their situation.
Ask one at a time:
1. "Is this your first time looking into hair systems?"
2. "How long have you been dealing with hair loss?"
3. "Have you looked into anything already — like transplants or medication?"
Wait after each.

STAGE 4 — Reframe + position
Goal: position hair systems clearly.
Say naturally:
"Yeah, that makes sense — a lot of guys go down that route first.
The difference with hair systems is it's non-surgical, and you see results right away.
A lot of guys try transplants or meds first, and it doesn't always go how they expected. We see that all the time."

STAGE 5 — Self-awareness trigger
Goal: deepen emotional relevance.
Ask: "Out of curiosity — do you notice yourself wearing hats more than you'd like, or using something like Toppik a bit?"
Wait.

STAGE 6 — Build desire
If YES:
"Yeah — that's super common.
Most guys don't even realize they're doing it at first, and once they don't have to anymore, it's a completely different feeling.
And honestly, once you actually see yourself with hair again, that's when it really clicks."
If NO:
"Got it — yeah, not everyone does.
Sometimes it's more just noticing it in certain lighting or angles over time.
And once you see the difference, it's a completely different feeling."

STAGE 7 — Transition
Goal: bridge to consult.
Say: "What we usually do is just a quick consult so you can actually see how it works and what it would look like for you."

STAGE 8 — Availability preference
Goal: narrow scheduling preference.
Ask: "Would mornings or afternoons be better for you?"
Wait.

STAGE 9 — Timezone
Goal: confirm timezone.
Ask: "Got it — are you in Pacific, Central, or Eastern?"
Wait.
Use their answer if provided; otherwise use {{tenant_timezone}} as fallback context.

STAGE 10 — Real booking
Goal: offer real appointment options from the calendar.
Call the availability tool using tenant_id={{tenant_id}}.
Never invent availability.
Offer two concrete slots naturally, like:
"I've got [Day] at [Time] or [Day] at [Time] — which works better?"
If needed, ask follow-up and call the availability tool again.

STAGE 11 — Confirm and book
Goal: confirm details and book live.
You already know their name, phone, and email from the opt-in context.
Before booking, confirm naturally if needed.
Then call the booking tool with:
- tenant_id={{tenant_id}}
- conversation_id={{conversation_id}}
- caller_name={{caller_name}}
- caller_phone={{caller_phone}}
- caller_email={{caller_email}}
- chosen slot_iso
After success say:
"Perfect — I've got you down for [Day, Time]. You'll get a confirmation with all the details."

=== OBJECTION HANDLING ===
Always acknowledge first, then redirect back toward booking.

If they say "I need to think about it":
"Yeah, that's fair — honestly most people just need to see how it actually works before they can really decide. That's exactly what the consult is for. Once you see it, it becomes a lot clearer. Would earlier in the day or later work better for you?"

If they say "Is this legit?":
"Yeah, I get why you'd ask that. That's why we do the consult first — you'll see exactly how it works, how it looks, everything. I've got a couple spots — would morning or afternoon be easier?"

If they say "I'm not sure it would work for me":
"Yeah, totally — that's exactly why we take a look first. We'll go over your situation and tell you straight up what would work and what wouldn't. Would you be more free earlier or later in the day?"

If they say "I don't want something fake looking":
"Yeah, one hundred percent — that's the biggest concern. That's why seeing it first helps. Once you see how natural they look now, it clicks right away. Would morning or afternoon be easier?"

After any objection, return to booking.`;

const SAM_CONVERSATION_CONFIG = {
  agent: {
    prompt: {
      prompt: SAM_SCRIPT,
    },
    first_message: "Hey — thanks for reaching out. Who do I have the pleasure of speaking with?",
    language: "en",
  },
  turn: {
    mode: "turn",
    turn_timeout: 1,
    turn_eagerness: "eager",
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
