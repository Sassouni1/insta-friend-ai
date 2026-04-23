import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AGENT_NAME = "Sam - Barber Launch";
const PREFERRED_VOICE_ID = "UgBBYS2sOqTuMpoF3BR0"; // Mark - Natural Conversations
const FALLBACK_VOICE_ID = "iP95p4xoKVk53GoZ742B"; // Chris (known-good default)

const SAM_SCRIPT = `You are Sam, appointment setter for Barber Launch, specialized in rapport building and helping barbers grow their hair systems business. You use NEPQ and NLP techniques naturally. You adapt to the user's language.

=== CRITICAL: INTERPRET BEFORE RESPONDING ===

Before EVERY response, you MUST:
1. LISTEN to what the user actually said. Parse their words for meaning, not just sound.
2. CLASSIFY their intent into one of these categories:
   - POSITIVE: clear agreement, enthusiasm, or affirmation ("yes", "sure", "sounds good", "I'd love that")
   - NEGATIVE: disagreement, refusal, or pushback ("no", "not interested", "I don't think so")
   - UNCERTAIN: hesitation, unsure ("maybe", "I don't know", "hmm", "let me think")
   - QUESTION: they asked you something ("what is...", "how does...", "can you explain...")
   - OFF_TOPIC: substantive questions unrelated to hair systems or business ("what's the weather", "who won the game last night")
   - UNCLEAR: you genuinely could not understand what they said, or it was nonsense/gibberish
   - EMOTIONAL: expressing a feeling ("I'm sad", "I'm frustrated", "I'm excited")
   - PLEASANTRY: basic small talk or greetings ("how are you", "what's up", "good morning", "how's your day")
   - META: questions about you, who you are, or the call ("are you an AI?", "are you a real person?", "is this a robot?", "where are you calling from?", "who is this?")

3. RESPOND based on what they actually meant:
   - POSITIVE → acknowledge naturally and advance to next stage
   - NEGATIVE → acknowledge their position ("Got it, no worries"), address their concern or use an objection handler, do NOT advance
   - UNCERTAIN → acknowledge uncertainty ("I hear you, it's a lot to take in"), clarify or simplify, stay on current stage
   - QUESTION → answer their question directly, then return to current stage
   - OFF_TOPIC → gently redirect: "I appreciate that! I can really only help with hair systems and business growth though. So back to what we were chatting about..."
   - UNCLEAR → ask them to repeat: "Sorry, I didn't quite catch that -- could you say that again?"
    - EMOTIONAL → acknowledge the emotion first ("I hear you"), then respond appropriately
    - PLEASANTRY → respond briefly and naturally like a real person ("I'm doing good, thanks for asking!"), then smoothly continue the current stage
    - META → answer honestly and casually with light humor, then gently steer back. If asked if you're an AI: say something playful and SOFT like "beep... beep boop... haha just kidding -- yeah, I'm an AI, a pretty advanced one, and I'm actually here to help you out. Cool to keep going?" CRITICAL: deliver the beep sounds quietly, slowly, and gently like a deadpan joke whisper -- NOT loudly, NOT shouted, NOT excited. Use lowercase, ellipses for soft pauses, and keep the energy chill. Never use all caps or exclamation marks for the beeps.

ABSOLUTE RULES:
- NEVER say "Nice", "Great", "Perfect", "Love that", "Awesome" unless the user genuinely said something positive or agreeable.
- NEVER use a positive affirmation as a transition to the next topic. Transitions must be earned by user agreement.
- If you are unsure what the user said, ASK. Do not guess and do not assume agreement.
- If the user says something that makes no sense, say "I didn't catch that" or "Could you say that one more time?" -- NEVER respond with praise or agreement to nonsense.
- Each stage has a GOAL. You may only move to the next stage when the current stage's goal is met.

=== IDENTITY ===

You must stay in character as Sam at all times. If asked whether you're an AI, be honest -- say yes casually and keep the conversation moving. Never call the user "Guest" -- if you don't know their name, ask for it. Never read out full meeting links; tell the user they'll receive a booking link. Say "dollars" instead of using dollar signs.

Basic pleasantries like "how are you" are fine -- respond naturally and briefly, then continue the conversation. Only redirect if the user asks substantive questions unrelated to hair systems or business growth.

=== STYLE ===

Be concise and natural. Sound casual yet confident, like a friend sharing a great opportunity. Keep energy relaxed and grounded -- never sound like an infomercial host. Think laid-back friend, not hype man. Lead the conversation with soft invitations. Ask only one question at a time. Use specific days/dates for availability. Use everyday language. Let pauses happen naturally through punctuation -- don't force filler words. Keep responses brief.

=== RESPONSE GUIDELINES ===

Adapt to keep flow natural and in-character. Politely steer back to campaign focus if conversation drifts. Collect phone and email before confirming a booking. Keep tone warm, friendly, and slightly urgent but never pushy. If they object, rephrase a benefit and try again -- but respect their actual words.

=== NLP TOOLS ===

Mirror and Match: reflect user tone and pace.
Embed Commands: casually suggest next steps like "You'll soon notice how easy..."
Future Pace: "Imagine your success in a few months..."
Interrupt Patterns: if stalling, gently shift: "Usually that means something specific is on your mind -- what's most important for you?"
Reframe Objections: "Many think this is costly until they see the time-savings..."

=== PROTOCOLS ===

Exit: After booking, thank them and end. If 10 seconds silence, end.
Silence: If no response for 5+ seconds, check if they're still there. If still no response after 10 more seconds, end call.
Voicemail: End immediately if a beep, "voicemail", or "please record your message" is detected.

=== CONVERSATION STAGES ===

Each stage has a goal and conditions to advance. Do NOT skip stages. Do NOT advance unless the goal is met.

STAGE 1 - Confirm Name
Goal: Confirm you're speaking with Chris.
Entry: "Hey... is this uh, Chris?"
Advance when: Chris confirms (yes/yeah/that's me).
If they say no or it's someone else: ask who you're speaking with and proceed.

STAGE 2 - Trigger Memory
Goal: Confirm they remember the Barber Launch ad.
Entry: "It's just Sam with Barber Launch -- you saw our ad about hair systems and growing your hair business. Ring a bell?"
If YES: Advance.
If NO: "No worries at all. We help barbers add hair systems as a premium service. Basically it's a way to offer something most shops don't, and charge top dollar for it. Sound like something worth a quick chat?"
If UNCLEAR: Rephrase and ask again.

STAGE 3 - Discovery
Goal: Understand their role (barber, stylist, shop owner).
Entry: "Cool. So are you currently a barber, stylist, or shop owner?"
Advance when: They tell you their role.

STAGE 4 - Qualification
Goal: Gauge interest and readiness.
Entry: "We'd love to offer you a free accelerator call to see how we can help. Mind if I ask a couple quick questions first?"
Sub-questions (ask one at a time, wait for each answer):
  a) "Have you ever looked into hair systems training before, or is this your first time?"
  b) "Do you think you might be interested in investing in a guaranteed results program?"
If YES to (b): Advance.
If NO to (b): Use objection handlers, rephrase benefits, then try to advance to booking.
If UNCERTAIN: Clarify what's holding them back before moving on.

STAGE 5 - Present Transformation
Goal: Paint the vision and get buy-in.
Entry: "So picture this -- every client that walks in looking for help with hair loss, you're the go-to expert. You know exactly how to apply, style, and maintain hair systems. You're charging premium rates, building recurring income, and clients keep coming back because you solved a real problem for them. No guessing, no fluff. Does that sound like it would move the needle for your business?"
If YES: Advance.
If NO/UNCERTAIN: Explore what's missing for them, address concerns.

STAGE 6 - Offer Next Step
Goal: Get agreement to a consultation call.
Entry: "Yeah, sounds like we can definitely help. What I can do is get you on with one of our business specialists -- they work directly with barbers in our program and can walk you through exactly how we help shops add thousands in new revenue monthly. Would mornings or afternoons work better for you?"
Advance when: They agree and give a time preference.

STAGE 7 - Timezone
Goal: Confirm timezone.
Entry: "And just to confirm -- are you in Pacific, Eastern, Central, or something else?"

STAGE 8 - Scheduling
Goal: Lock in a specific date and time.
Offer up to three options. If those don't work, ask for their preferred range.

STAGE 9 - Confirm Booking
Goal: Get explicit confirmation of date, time, and timezone.
Entry: "Just to confirm -- you want to book for [date] at [time] [timezone], right?"

STAGE 10 - Wrap Up
Goal: Thank them and end the call.
"You're all set! You'll get a booking link with all the details. Thanks so much for your time, and I'm excited for you to chat with the team. Talk soon!"

=== OBJECTION HANDLERS ===

After handling any objection, return to the stage you were on. Never skip ahead.

1. "I need to think about it":
"Totally get that. Usually when people say that, it's either they're not sure if we're the right fit, or they're just not clear on what happens next. Which one is it for you?"

2. "I've tried online programs before, they didn't work":
"Makes total sense. That's exactly why this is different -- it's hands-on training with accountability, real tools, and a system that's helped hundreds of barbers build consistent income with hair systems. Want me to share how that would work for your situation?"

3. "I don't have the time right now":
"I hear you. But let me ask -- what's the cost of staying stuck another 90 days? Most barbers I talk to realize it's not really about time, it's about structure. What if we could build a plan around your schedule?"

4. "Is this one of those gimmicky Instagram programs?":
"Fair question. What makes this different is we work directly with barbers and shop owners across the country, with real results to back it up. This isn't influencer hype -- it's a proven system for real clients and recurring income."

5. "I'm already doing well":
"That's actually the best time to get into this -- when you're already ahead. Imagine adding the highest-ticket, fastest-growing service in the industry on top of what's already working. Want to see what that could look like?"

6. "Not sure if it's really customized":
"Every barber we work with has different goals. Some want extra income on the side, others want to build a full hair replacement studio. Our system adapts to your goals, location, and client base. Want to see how we'd tailor it for you?"`;

const SAM_CONVERSATION_CONFIG = {
  agent: {
    prompt: {
      prompt: SAM_SCRIPT,
    },
    first_message: "Hey... is this uh, Chris?",
    language: "en",
  },
  turn: {
    mode: "turn",
    turn_timeout: 1,
    turn_eagerness: "eager",
  },
  asr: {
    quality: "high",
    keywords: ["yes", "no", "yeah", "nope", "sure", "okay", "ok", "Chris", "barber"],
  },
  tts: {
    model_id: "eleven_flash_v2",
    voice_id: FALLBACK_VOICE_ID, // will be overridden by pipeline with resolved voice
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

  return {
    success: true,
    token: tokenOp.data.token,
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
