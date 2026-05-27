import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AGENT_NAME = "Sam - Hair Systems";
const PREFERRED_VOICE_ID = "oqnGPLczFm7QLPdseXmp";
const FALLBACK_VOICE_ID = "oqnGPLczFm7QLPdseXmp";
const CALENDAR_TOOL_NAME = "ghl_calendar_tool";

const SAM_SCRIPT = `You are Sam — a real dude who books consults for {{company_name}}. You're talking to someone who's been looking into hair systems or hair loss options.

You are NOT a bot, assistant, or AI. You're a guy on the phone. Period.

== THE GOLDEN RULES (break these and you sound like a robot) ==

1. REACT BEFORE YOU ASK. Every time the lead says something, respond to *what they said* in 3-10 human words BEFORE asking anything else.
   - They say "5 years" → "Five years, damn." THEN next question.
   - They say "I tried minoxidil" → "Yeah min works for some guys, kinda a forever thing though." THEN next question.
   - BANNED words: "Got it." "Okay." "Perfect." "Awesome." "Great." "Nice." "I understand." Robot tells.

2. MATCH THEIR ENERGY AND LENGTH. They answer in 3 words, you answer in 6 — not 30. Mirror them.

3. SHORT SENTENCES. Nothing over ~15 words. Break thoughts into beats.

4. GUESS, DON'T INTERROGATE. "Lemme guess, you've prob tried min, fibers, maybe looked at transplants?" beats "have you tried any solutions?" every time.

5. TRAIL OFF sometimes. Let them finish your sentence.
   - "Min works for some dudes, soon as you stop..." (they fill in "it falls back out")

6. NO MONOLOGUES. If you explain something, break it into 2-3 short beats with pauses.
   - BAD: "A hair system is a non-surgical solution where we custom-match a piece to your scalp using medical adhesive that lasts 4-6 weeks..."
   - GOOD: "So basically — it's a piece matched to your exact hair. Glues on, lasts a month-ish. Nobody can tell." (pause)

7. SOUND LIKE A PERSON, NOT CUSTOMER SUPPORT. Don't make every sentence polished. Use fragments, contractions, and slightly uneven rhythm.
   - GOOD: "Yeah, that tracks." "That's usually what pushes guys over." "Honestly, easier to see it."
   - BAD: "I completely understand your concern, and I'd be happy to explain how our process works."

8. VARY YOUR REACTIONS. Don't keep using the same acknowledgement pattern. Rotate naturally:
   - "Yeah, that makes sense."
   - "Mm, that's frustrating."
   - "Right, especially if it's been years."
   - "Yeah, I hear you."
   - "That's usually the point guys start lookin."
   Keep it casual, but don't overdo slang.

== KNOWN CONTEXT ==
- first_name: {{first_name}}
- caller_name: {{caller_name}}
- caller_phone: {{caller_phone}}
- caller_email: {{caller_email}}
- company_name: {{company_name}}
- tenant_timezone: {{tenant_timezone}}
- tenant_id: {{tenant_id}}
- conversation_id: {{conversation_id}}

If first_name is empty/missing/looks like "Guest" or a placeholder → treat them as unknown. After they give a name, use it naturally.

== OPENER ==

If you DON'T have a name yet:
First message was "Hey — who am I speaking with?". After they give their name:
"Cool [name] — Sam here from {{company_name}}. You hit our page about hair systems, right?"

If you DO have a name ({{first_name}} is real):
First message was "Hey is this {{first_name}}?". After they confirm:
"Yo {{first_name}} — Sam from {{company_name}}. You were lookin into hair systems, right? Caught ya at a good time?"

If they say "hello / can you hear me / you there" mid-call → "Yeah I'm here" and pick up. Never restart the opener. Never re-introduce yourself.

== DISCOVERY (3 questions, NOT 7) ==

Ease in. Reaction in between EACH one.

Q1: "So what's goin on with the hair — how long's it been a thing?"
→ React in 3-10 words. Then:

Q2: "And lemme guess, you've already messed with fibers, hats, maybe min?"
→ React. Then:

Q3: "What made today the day you actually started lookin into it — somethin specific?"
→ React.

That's it. Three questions. Don't drill further.

== POSITION (short, conversational, NOT a pitch) ==

After discovery, drop ONE casual line:
"Cool — the way ours works, it's non-surgical, matched to your hair, you see the result same day. Most guys we talk to already tried the other stuff and ended up here."

Then SHUT UP. Let them ask.

== CLOSE (assumptive — don't ask permission) ==

"Easiest move is a quick consult so you can actually see one and see what it'd look like on you. Mornings or afternoons better for ya?"

Once they give a preference → STOP discovery.

Ask: "And you in Pacific, Central, or Eastern?" (use {{tenant_timezone}} as fallback)

Then call the availability tool with tenant_id={{tenant_id}}, their preference, their timezone. Use ONLY real returned slots. Never invent times.

"Cool I got [Day] at [Time] or [Day] at [Time], which works better?"

Map "first one / second one / day name / morning one" to the returned slots.
If they want different times → call availability again with the new preference.

== BOOKING ==

If {{caller_email}} is missing/empty → "What's the best email for the confirm?"
Don't book without an email.

Then call booking tool with:
- tenant_id={{tenant_id}}
- conversation_id={{conversation_id}}
- caller_name={{caller_name}}
- caller_phone={{caller_phone}}
- caller_email
- slot_iso

After tool confirms success:
"Boom — got ya down for [Day, Time]. Confirmation's headed to your email."

== OBJECTIONS (SHORT + empathetic, never a pitch) ==

"How much?" → "Honest answer, depends on the system. That's literally what the consult's for — it's free, no pressure."

"Does it look real?" → "Yeah that's everyone's first question. Easier to show ya than tell ya — that's the whole point."

"I gotta think about it" → "Totally fair. Consult's free though, no pressure — worst case you just see it in person. Wanna grab a slot just in case?"

"Is this legit?" → "Yeah I get it. That's why we do the consult first — you see exactly how it works, no commitment."

"Can I shower/swim/workout?" → "Yeah, all of it. Guys forget they're even wearing it."

"Won't look natural on me" → "Yeah that's the #1 worry. Easier to just see one in person — that's why the consult exists."

After ANY objection → bounce back to "morning or afternoon?"

== HARD BANS ==
- No "uh", "um", ellipses — use dashes/commas for pauses
- No "Got it / Okay / Perfect / Awesome / Great / Nice / I understand"
- No re-introducing yourself
- No monologues over 2 sentences without a pause
- No back-to-back questions without a reaction in between
- Never say "dollar" or "$" out loud
- Never read URLs / meeting links / long IDs out loud
- Never call them "Guest"
- Never say you're an AI unless directly asked, then casually admit and continue

== SILENCE / META ==
- ~15s silence → "Hey, you still there?"
- ~20s more silence → end the call
- Voicemail/beep → end the call
- After booking → thank them briefly and end`;

const SAM_CONVERSATION_CONFIG = {
  agent: {
    prompt: {
      prompt: SAM_SCRIPT,
    },
    first_message: "Hey — who am I speakin with?",
    language: "en",
  },
  turn: {
    mode: "turn",
    turn_timeout: 4,
    turn_eagerness: "eager",
  },
  conversation: {
    client_events: [
      "audio",
      "interruption",
      "agent_response",
      "user_transcript",
      "agent_response_correction",
      "client_tool_call",
      "agent_tool_response",
    ],
  },
  asr: {
    quality: "high",
    keywords: ["yes", "no", "yeah", "hair", "hair system", "transplant", "medication", "Pacific", "Central", "Eastern"],
  },
  tts: {
    model_id: "eleven_flash_v2",
    voice_id: FALLBACK_VOICE_ID,
    stability: 0.48,
    similarity_boost: 0.74,
    style: 0.22,
    use_speaker_boost: true,
    speed: 0.92,
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

async function summarizeAgentConfig(apiKey: string, agentId: string) {
  const op = await elevenLabsOp(
    "inspect_agent",
    `https://api.elevenlabs.io/v1/convai/agents/${agentId}`,
    {
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
    },
    "convai_read",
  );

  if (!op.ok) {
    return { ok: false, status: op.status, error_text: op.error_text, permission_hint: op.permission_hint };
  }

  const cfg = op.data?.conversation_config || {};
  const agent = cfg.agent || {};
  const promptText = agent.prompt?.prompt || "";

  return {
    ok: true,
    agent_id: op.data?.agent_id || agentId,
    name: op.data?.name,
    first_message: agent.first_message,
    language: agent.language,
    prompt_length: typeof promptText === "string" ? promptText.length : null,
    prompt_starts_with: typeof promptText === "string" ? promptText.slice(0, 80) : null,
    turn: cfg.turn || null,
    tts: cfg.tts || null,
    asr: cfg.asr || null,
    conversation: cfg.conversation || null,
    vad: cfg.vad || null,
    platform_override_flags: op.data?.platform_settings?.overrides || null,
  };
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

function buildCalendarToolConfig() {
  return {
    type: "client",
    name: CALENDAR_TOOL_NAME,
    description:
      "Check real GoHighLevel calendar availability and book a consultation appointment. Use action=availability before offering times. Use action=book only after the caller chooses an exact slot_iso.",
    expects_response: true,
    response_timeout_secs: 20,
    disable_interruptions: true,
    force_pre_tool_speech: true,
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ["availability", "book"],
          description: "Use availability to fetch real open slots; use book to create the appointment.",
        },
        days_ahead: {
          type: "integer",
          description: "For availability only. Number of days ahead to search. Default is 7.",
        },
        preference: {
          type: "string",
          description: "For availability only. Caller scheduling preference, such as morning, afternoon, later, next week, Tuesday, or after 2.",
        },
        timezone: {
          type: "string",
          description: "For availability only. Timezone to use for speaking and filtering slots, such as America/New_York.",
        },
        slot_iso: {
          type: "string",
          description: "For booking only. Exact ISO datetime chosen from a prior availability response.",
        },
        caller_name: {
          type: "string",
          description: "Caller name. Use the known caller_name dynamic variable when available.",
        },
        caller_phone: {
          type: "string",
          description: "Caller phone number. Use the known caller_phone dynamic variable.",
        },
        caller_email: {
          type: "string",
          description: "For booking. Caller email. If missing, ask the caller: Real quick, what's the best email to put on file?",
        },
      },
    },
  };
}

async function ensureCalendarToolId(apiKey: string, diagnostics: OpResult[]): Promise<string | null> {
  const headers: Record<string, string> = {
    "xi-api-key": apiKey,
    "Content-Type": "application/json",
  };

  const listOp = await elevenLabsOp(
    "list_tools",
    "https://api.elevenlabs.io/v1/convai/tools",
    { headers },
    "convai_tools_read",
  );
  diagnostics.push(listOp);

  if (listOp.ok) {
    const existing = (listOp.data?.tools || []).find((tool: any) => tool?.tool_config?.name === CALENDAR_TOOL_NAME);
    if (existing?.id) return existing.id;
  } else {
    console.warn(`Tool list failed; will try create directly: ${listOp.error_text}`);
  }

  const createOp = await elevenLabsOp(
    "create_calendar_tool",
    "https://api.elevenlabs.io/v1/convai/tools",
    {
      method: "POST",
      headers,
      body: JSON.stringify({ tool_config: buildCalendarToolConfig() }),
    },
    "convai_tools_write",
  );
  diagnostics.push(createOp);
  if (!createOp.ok) {
    console.warn(`Calendar tool create failed: ${createOp.error_text}`);
    return null;
  }
  return createOp.data?.id || null;
}

type ElevenLabsKeySource = "connector" | "custom";

function resolveApiKey(preferredSource?: string | null): { key: string; source: ElevenLabsKeySource } {
  const custom = Deno.env.get("ELEVENLABS_API_KEY_CUSTOM")?.trim();
  const connector = Deno.env.get("ELEVENLABS_API_KEY")?.trim();

  if (preferredSource === "custom" && custom) return { key: custom, source: "custom" };
  if (preferredSource === "connector" && connector) return { key: connector, source: "connector" };

  if (connector) return { key: connector, source: "connector" };
  if (custom) return { key: custom, source: "custom" };
  throw new Error("No ElevenLabs API key configured");
}

async function runPipeline(
  apiKey: string,
  keySource: string,
  options: { patchAgentConfig?: boolean } = {},
) {
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

  const calendarToolId = await ensureCalendarToolId(apiKey, diagnostics);
  if (!calendarToolId) {
    console.warn("Calendar tool unavailable; agent can speak but may not be able to book");
  }

  // Apply resolved voice to config
  const configToUse = {
    ...SAM_CONVERSATION_CONFIG,
    agent: {
      ...SAM_CONVERSATION_CONFIG.agent,
      prompt: {
        ...SAM_CONVERSATION_CONFIG.agent.prompt,
        ...(calendarToolId ? { tool_ids: [calendarToolId] } : {}),
      },
    },
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

  // Step 3: Create if not found. Creation is a write, so keep it behind the same explicit patch gate.
  if (!agentId) {
    if (!options.patchAgentConfig) {
      return { success: false, diagnostics, key_source: keySource, error: `Agent "${AGENT_NAME}" not found and patch_agent_config was not enabled` };
    }

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

  // Step 4: Patch agent config only when explicitly requested.
  if (options.patchAgentConfig) {
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
  } else {
    console.log("Skipping agent config patch; patch_agent_config not enabled");
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
    const requestUrl = new URL(req.url);
    let requestBody: any = {};
    try {
      const rawBody = await req.text();
      requestBody = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      requestBody = {};
    }

    // Force patch by default so voice/config changes are always applied to the persisted agent.
    // The agent persists its TTS voice server-side; without patching, web browser sessions
    // keep using whatever voice was last written.
    const patchAgentConfig =
      requestBody?.patch_agent_config === false ||
      requestUrl.searchParams.get("patch_agent_config") === "false" ||
      requestUrl.searchParams.get("patch_agent_config") === "0"
        ? false
        : true;
    const inspectAgentConfig =
      requestBody?.inspect_agent_config === true ||
      requestUrl.searchParams.get("inspect_agent_config") === "true" ||
      requestUrl.searchParams.get("inspect_agent_config") === "1";
    const preferredKeySource =
      typeof requestBody?.key_source === "string"
        ? requestBody.key_source
        : requestUrl.searchParams.get("key_source");

    const { key: primaryKey, source: primarySource } = resolveApiKey(preferredKeySource);
    console.log(`Using key source: ${primarySource}`);
    console.log(`patch_agent_config=${patchAgentConfig}`);

    let result = await runPipeline(primaryKey, primarySource, { patchAgentConfig });

    // Fallback: if primary key failed with permission error, try the other key
    if (!result.success && result.diagnostics?.some((d: OpResult) => d.status === 401 || d.status === 403 || d.status === 404)) {
      const fallbackKey = primarySource === "custom"
        ? Deno.env.get("ELEVENLABS_API_KEY")?.trim()
        : Deno.env.get("ELEVENLABS_API_KEY_CUSTOM")?.trim();

      if (fallbackKey) {
        const fallbackSource = primarySource === "custom" ? "connector" : "custom";
        console.log(`Primary key (${primarySource}) hit permission error. Trying fallback (${fallbackSource})...`);
        result = await runPipeline(fallbackKey, fallbackSource, { patchAgentConfig });
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

    const inspectedAgentConfig = inspectAgentConfig
      ? await summarizeAgentConfig(primaryKey, result.agent_id)
      : undefined;

    return new Response(
      JSON.stringify({
        token: result.token,
        signed_url: result.signed_url,
        agent_id: result.agent_id,
        key_source: result.key_source,
        patched_agent_config: patchAgentConfig,
        inspected_agent_config: inspectedAgentConfig,
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
