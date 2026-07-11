#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_AGENT_ID = "agent_9201kr7jkn3xfz2sr11sngjnqxwh";
const TOOL_NAME = "ghl_calendar_tool";
const CONFIG_VERSION = "sam-outbound-2026-07-10-rollback-v1";
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
      return source.slice(bodyStart, index).replaceAll("${CALENDAR_TOOL_NAME}", TOOL_NAME);
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

const prompt = extractTemplateLiteral(bridgeSource, "const SAM_OUTBOUND_PROMPT = `");
const [agent, toolList] = await Promise.all([
  elevenLabs(`/v1/convai/agents/${agentId}`),
  elevenLabs("/v1/convai/tools"),
]);
const calendarTool = toolList?.tools?.find((tool) => tool?.tool_config?.name === TOOL_NAME);
if (!calendarTool?.id) throw new Error(`${TOOL_NAME} does not exist; refusing to update the booking agent`);

const conversationConfig = structuredClone(agent.conversation_config || {});
conversationConfig.agent ||= {};
conversationConfig.agent.prompt ||= {};
conversationConfig.agent.prompt.prompt = prompt;
conversationConfig.agent.prompt.tool_ids = [calendarTool.id];
// PATCH uses merge semantics for this legacy field, so an explicit empty list
// is required to clear the old inline tool while retaining tool_ids.
conversationConfig.agent.prompt.tools = [];
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
  llm: conversationConfig.agent.prompt.llm,
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
  console.log(JSON.stringify({ applied: true, verified_prompt: true, returned_config_sha256: verifiedHash }, null, 2));
}
