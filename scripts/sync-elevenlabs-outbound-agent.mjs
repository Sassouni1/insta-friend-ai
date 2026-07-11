#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_AGENT_ID = "agent_9201kr7jkn3xfz2sr11sngjnqxwh";
const CALENDAR_TOOL_NAME = "ghl_calendar_tool";
const OPT_OUT_TOOL_NAME = "opt_out";
const CONFIG_VERSION = "sam-outbound-2026-07-11-call-safeguards-v1";
const FUNCTIONS_BASE = process.env.SUPABASE_FUNCTIONS_BASE || "https://prjzhyzgfphiajhguzzu.supabase.co/functions/v1";
const APPLY = process.argv.includes("--apply");
const requestedModel = process.argv.find((arg) => arg.startsWith("--model="))?.split("=")[1];
const apiKey = process.env.ELEVENLABS_API_KEY_CUSTOM || process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_OUTBOUND_AGENT_ID || DEFAULT_AGENT_ID;

if (!apiKey) {
  throw new Error("Set ELEVENLABS_API_KEY_CUSTOM. The script never prints the key.");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bridgeSource = await readFile(path.join(scriptDir, "../supabase/functions/telnyx-bridge/index.ts"), "utf8");

function extractTemplateLiteral(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Could not find ${marker}`);
  const bodyStart = start + marker.length;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "`") {
      return source.slice(bodyStart, index)
        .replaceAll("${CALENDAR_TOOL_NAME}", CALENDAR_TOOL_NAME)
        .replaceAll("${OPT_OUT_TOOL_NAME}", OPT_OUT_TOOL_NAME);
    }
  }
  throw new Error("Outbound prompt template is not terminated");
}

async function elevenLabs(pathname, options = {}) {
  const response = await fetch(`https://api.elevenlabs.io${pathname}`, {
    ...options,
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname} failed (${response.status}): ${text.slice(0, 300)}`);
  return data;
}

const prompt = extractTemplateLiteral(bridgeSource, "const SAM_OUTBOUND_PROMPT =\n  `");
const [agent, toolList] = await Promise.all([
  elevenLabs(`/v1/convai/agents/${agentId}`),
  elevenLabs("/v1/convai/tools"),
]);
const calendarTool = toolList?.tools?.find((tool) => tool?.tool_config?.name === CALENDAR_TOOL_NAME);
if (!calendarTool?.id) throw new Error(`${CALENDAR_TOOL_NAME} does not exist; refusing to update the booking agent`);

function buildOptOutToolConfig() {
  return {
    type: "webhook",
    name: OPT_OUT_TOOL_NAME,
    description: "Suppress this phone number from future calls when the caller explicitly says not to call again or asks to be removed. Do not use for ordinary objections, hesitation, or a simple not interested response.",
    response_timeout_secs: 20,
    interruption_mode: "disable_during_tool",
    pre_tool_speech: "off",
    tool_error_handling_mode: "passthrough",
    assignments: [],
    dynamic_variables: {
      dynamic_variable_placeholders: {
        tenant_id: "721ca656-4c25-4ced-bd2e-4f03e8b3bacc",
        conversation_id: "00000000-0000-0000-0000-000000000000",
        caller_phone: "+15555550100",
      },
    },
    execution_mode: "immediate",
    api_schema: {
      request_headers: { "Content-Type": "application/json" },
      url: `${FUNCTIONS_BASE}/ghl-opt-out-tool`,
      method: "POST",
      path_params_schema: {},
      query_params_schema: null,
      request_body_schema: {
        type: "object",
        required: ["tenant_id", "conversation_id", "caller_phone"],
        description: "Record and enforce a caller's explicit request not to be called again.",
        properties: {
          tenant_id: { type: "string", dynamic_variable: "tenant_id" },
          conversation_id: { type: "string", dynamic_variable: "conversation_id" },
          elevenlabs_conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
          caller_phone: { type: "string", dynamic_variable: "caller_phone" },
          reason: {
            type: "string",
            description: "A short factual summary of the caller's explicit opt-out request.",
          },
        },
      },
      response_body_schema: null,
      response_filter: null,
      content_type: "application/json",
      auth_resolved_params: [],
      auth_connection: null,
    },
  };
}

let optOutTool = toolList?.tools?.find((tool) => tool?.tool_config?.name === OPT_OUT_TOOL_NAME);
if (!optOutTool?.id && APPLY) {
  const created = await elevenLabs("/v1/convai/tools", {
    method: "POST",
    body: JSON.stringify({ tool_config: buildOptOutToolConfig() }),
  });
  optOutTool = created?.id ? created : created?.tool;
}
if (!optOutTool?.id && APPLY) {
  throw new Error(`${OPT_OUT_TOOL_NAME} was not created; refusing to update the agent`);
}
if (optOutTool?.id && APPLY) {
  await elevenLabs(`/v1/convai/tools/${optOutTool.id}`, {
    method: "PATCH",
    body: JSON.stringify({ tool_config: buildOptOutToolConfig() }),
  });
}

const conversationConfig = structuredClone(agent.conversation_config || {});
conversationConfig.agent ||= {};
conversationConfig.agent.prompt ||= {};
conversationConfig.agent.prompt.prompt = prompt;
conversationConfig.agent.prompt.tool_ids = [
  calendarTool.id,
  ...(optOutTool?.id ? [optOutTool.id] : []),
];
delete conversationConfig.agent.prompt.tools;
const existingBuiltInTools = Object.fromEntries(
  Object.entries(conversationConfig.agent.prompt.built_in_tools || {})
    .filter(([, config]) => config != null),
);
conversationConfig.agent.prompt.built_in_tools = {
  ...existingBuiltInTools,
  end_call: {
    type: "system",
    name: "end_call",
    description: "End only when the caller explicitly asks to end, after opt_out returns opted_out=true, or after the call's task has clearly completed. Never use this to escape a question, booking attempt, tool error, silence, or uncertainty.",
    response_timeout_secs: 20,
    params: { system_tool_type: "end_call" },
  },
  voicemail_detection: {
    type: "system",
    name: "voicemail_detection",
    description: "Use immediately when an automated voicemail greeting, mailbox prompt, or voicemail beep is detected. Do not deliver the sales script to voicemail.",
    response_timeout_secs: 20,
    params: { system_tool_type: "voicemail_detection" },
  },
};
conversationConfig.agent.prompt.reasoning_effort = null;
conversationConfig.agent.prompt.thinking_budget = 0;
conversationConfig.agent.prompt.enable_reasoning_summary = false;
conversationConfig.agent.prompt.temperature = 0;
conversationConfig.agent.first_message = "Hey, is this {{first_name}}?";
conversationConfig.agent.language = "en";
if (requestedModel) conversationConfig.agent.prompt.llm = requestedModel;
conversationConfig.turn = {
  ...(conversationConfig.turn || {}),
  mode: "turn",
  turn_timeout: 4,
  turn_eagerness: "normal",
};
conversationConfig.asr = {
  ...(conversationConfig.asr || {}),
  quality: "high",
  keywords: ["yes", "yeah", "no", "hair system", "hair loss", "transplant", "medication", "morning", "mornings", "afternoon", "afternoons", "appointment"],
};
conversationConfig.conversation = {
  ...(conversationConfig.conversation || {}),
  max_duration_seconds: 480,
  client_events: ["audio", "interruption", "agent_response", "user_transcript", "agent_response_correction", "client_tool_call", "agent_tool_response", "vad_score", "ping"],
};
conversationConfig.tts = {
  ...(conversationConfig.tts || {}),
  model_id: "eleven_flash_v2",
  voice_id: "rYW2LlWtM70M5vc3HBtm",
  agent_output_audio_format: "pcm_16000",
  stability: 0.43,
  similarity_boost: 0.64,
  speed: 0.94,
};

const configHash = createHash("sha256").update(JSON.stringify(conversationConfig)).digest("hex");
console.log(JSON.stringify({
  mode: APPLY ? "apply" : "dry-run",
  agent_id: agentId,
  agent_name: agent.name,
  config_version: CONFIG_VERSION,
  config_sha256: configHash,
  calendar_tool_id: calendarTool.id,
  opt_out_tool_id: optOutTool?.id || null,
  llm: conversationConfig.agent.prompt.llm,
  max_duration_seconds: conversationConfig.conversation.max_duration_seconds,
  built_in_tools: Object.keys(conversationConfig.agent.prompt.built_in_tools || {}),
  prompt_characters: prompt.length,
}, null, 2));

if (APPLY) {
  await elevenLabs(`/v1/convai/agents/${agentId}`, {
    method: "PATCH",
    body: JSON.stringify({ name: agent.name, conversation_config: conversationConfig }),
  });
  const verified = await elevenLabs(`/v1/convai/agents/${agentId}`);
  const verifiedHash = createHash("sha256").update(JSON.stringify(verified.conversation_config || {})).digest("hex");
  if (verified.conversation_config?.agent?.prompt?.prompt !== prompt) {
    throw new Error("ElevenLabs accepted the request but the saved prompt did not match");
  }
  const verifiedPrompt = verified.conversation_config?.agent?.prompt || {};
  const verifiedPrivacy = verified.platform_settings?.privacy || {};
  const verifiedBuiltInTools = Object.entries(verifiedPrompt.built_in_tools || {})
    .filter(([, config]) => config != null)
    .map(([name]) => name);
  if (verified.conversation_config?.conversation?.max_duration_seconds !== 480) {
    throw new Error("ElevenLabs did not save the eight-minute duration cap");
  }
  if (!verifiedPrompt?.built_in_tools?.voicemail_detection) {
    throw new Error("ElevenLabs did not save voicemail detection");
  }
  if (!verifiedPrompt?.built_in_tools?.end_call) {
    throw new Error("ElevenLabs did not save end_call");
  }
  if (optOutTool?.id && !verifiedPrompt?.tool_ids?.includes(optOutTool.id)) {
    throw new Error("ElevenLabs did not link the opt-out tool");
  }
  if (verifiedPrivacy.record_voice !== true || verifiedPrivacy.delete_audio === true || verifiedPrivacy.delete_transcript_and_pii === true) {
    throw new Error("Call recording/transcript retention is not enabled");
  }
  console.log(JSON.stringify({
    applied: true,
    verified_prompt: true,
    verified_recording: true,
    verified_max_duration_seconds: 480,
    verified_tool_ids: verifiedPrompt.tool_ids,
    verified_built_in_tools: verifiedBuiltInTools,
    returned_config_sha256: verifiedHash,
  }, null, 2));
}
