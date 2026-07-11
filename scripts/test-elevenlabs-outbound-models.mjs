#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DEFAULT_AGENT_ID = "agent_9201kr7jkn3xfz2sr11sngjnqxwh";
const TOOL_NAME = "ghl_calendar_tool";
const DEFAULT_MODELS = ["gemini-2.5-flash", "gpt-4.1-mini", "claude-haiku-4-5"];
const apiKey = process.env.ELEVENLABS_API_KEY_CUSTOM || process.env.ELEVENLABS_API_KEY;
const productionAgentId = process.env.ELEVENLABS_OUTBOUND_AGENT_ID || DEFAULT_AGENT_ID;
const models = process.argv.filter((arg) => arg.startsWith("--model=")).map((arg) => arg.split("=")[1]);
const modelsToTest = models.length > 0 ? models : DEFAULT_MODELS;

if (!apiKey) throw new Error("Set ELEVENLABS_API_KEY_CUSTOM. The script never prints the key.");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.join(scriptDir, "..");
const bridgeSource = await readFile(path.join(repoDir, "supabase/functions/telnyx-bridge/index.ts"), "utf8");

function extractPrompt(source) {
  const marker = "const SAM_OUTBOUND_PROMPT = `";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("Outbound prompt was not found");
  const bodyStart = start + marker.length;
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) { escaped = false; continue; }
    if (character === "\\") { escaped = true; continue; }
    if (character === "`") return source.slice(bodyStart, index).replaceAll("${CALENDAR_TOOL_NAME}", TOOL_NAME);
  }
  throw new Error("Outbound prompt template is not terminated");
}

async function api(pathname, options = {}) {
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
  if (!response.ok) throw new Error(`${options.method || "GET"} ${pathname} failed (${response.status}): ${text.slice(0, 500)}`);
  return data;
}

function analyzeConversation(model, response) {
  const fullTranscript = response.simulated_conversation || [];
  const endIndex = fullTranscript.findIndex((turn) => turn.role === "user" && turn.message === "==! END_CALL!==");
  const transcript = endIndex >= 0 ? fullTranscript.slice(0, endIndex) : fullTranscript;
  const agentTurns = transcript.filter((turn) => turn.role === "agent" && turn.message).map((turn) => turn.message);
  const alerts = [];
  let previous = "";
  for (const [index, message] of agentTurns.entries()) {
    const normalized = message.toLowerCase().replace(/[^a-z0-9@]+/g, " ").trim();
    const sentences = message.split(/[.!?]+/).map((value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).filter((value) => value.length >= 18);
    if (new Set(sentences).size !== sentences.length) alerts.push({ turn: index + 1, kind: "duplicate_within_response", message });
    if (normalized.length >= 18 && normalized === previous) alerts.push({ turn: index + 1, kind: "duplicate_across_responses", message });
    if (/\b(the user|the caller) (confirmed|said|provided|asked)|\bi should (now|next)|\bmy next (step|task)|\bi need to (ask|call|confirm|use)\b|\bcall ended\b/i.test(message)) {
      alerts.push({ turn: index + 1, kind: "internal_narration", message });
    }
    previous = normalized;
  }
  const toolCalls = transcript.flatMap((turn) => turn.tool_calls || []).filter((call) => call.tool_name === TOOL_NAME);
  const parsedToolCalls = toolCalls.map((call) => {
    let parameters = call.params_as_json;
    try { parameters = JSON.parse(parameters); } catch {}
    return parameters;
  });
  const actions = parsedToolCalls.map((call) => call?.action).filter(Boolean);
  return {
    model,
    pass: alerts.length === 0,
    agent_turns: agentTurns.length,
    alerts,
    calendar_actions: actions,
    transcript,
    post_end_turns_ignored: endIndex >= 0 ? fullTranscript.length - endIndex : 0,
    provider_analysis: response.analysis,
  };
}

const prompt = extractPrompt(bridgeSource);
const [productionAgent, toolList] = await Promise.all([
  api(`/v1/convai/agents/${productionAgentId}`),
  api("/v1/convai/tools"),
]);
const calendarTool = toolList?.tools?.find((tool) => tool?.tool_config?.name === TOOL_NAME);
if (!calendarTool?.id) throw new Error(`${TOOL_NAME} was not found`);

const results = [];
for (const model of modelsToTest) {
  let temporaryAgentId;
  try {
    const conversationConfig = structuredClone(productionAgent.conversation_config || {});
    conversationConfig.agent ||= {};
    conversationConfig.agent.prompt ||= {};
    conversationConfig.agent.prompt.prompt = prompt;
    conversationConfig.agent.prompt.llm = model;
    conversationConfig.agent.prompt.reasoning_effort = null;
    conversationConfig.agent.prompt.thinking_budget = 0;
    conversationConfig.agent.prompt.enable_reasoning_summary = false;
    conversationConfig.agent.prompt.temperature = 0;
    conversationConfig.agent.prompt.tool_ids = [calendarTool.id];
    delete conversationConfig.agent.prompt.tools;
    conversationConfig.agent.first_message = "Hey, is this {{first_name}}?";

    const created = await api("/v1/convai/agents/create", {
      method: "POST",
      body: JSON.stringify({
        name: `TEMP Vlix outbound model test ${model} ${Date.now()}`,
        conversation_config: conversationConfig,
        tags: ["temporary-test", "vlix-outbound-ab"],
      }),
    });
    temporaryAgentId = created.agent_id;

    const mockResult = JSON.stringify({
      ok: true,
      slots: [
        { slot_iso: "2026-07-15T12:00:00-04:00", display: "Wednesday at noon" },
        { slot_iso: "2026-07-16T10:00:00-04:00", display: "Thursday at 10 AM" },
      ],
      booking_confirmed: true,
      appointment_id: "simulated-appointment-do-not-use",
      confirmation: "Simulated booking only",
    });
    const simulation = await api(`/v1/convai/agents/${temporaryAgentId}/simulate-conversation`, {
      method: "POST",
      body: JSON.stringify({
        simulation_specification: {
          simulated_user_config: {
            first_message: "Yeah, this is Chris.",
            language: "en",
            prompt: {
              llm: "gpt-4.1-mini",
              temperature: 0,
              prompt: "You are Chris on a phone call. Answer in one short sentence. Say hair loss has been a problem for ten years. When Sam guesses remedies, clearly say you have not tried any of them. Then say you want to book. Prefer mornings. Choose the first real slot offered. Confirm that the current phone is correct. Confirm chris@invasiondigitalmedia.com when read back. Do not volunteer extra facts. End once the agent says the appointment is booked.",
            },
          },
          dynamic_variables: {
            first_name: "Chris",
            caller_name: "Chris Sassouni",
            caller_phone: "+17276374672",
            caller_email: "chris@invasiondigitalmedia.com",
            company_name: "Infinite Hair",
            tenant_id: "721ca656-4c25-4ced-bd2e-4f03e8b3bacc",
            tenant_timezone: "America/New_York",
            conversation_id: "00000000-0000-0000-0000-000000000000",
            system__conversation_id: "simulated-elevenlabs-conversation",
          },
          tool_mock_config: {
            [calendarTool.id]: { default_return_value: mockResult, default_is_error: false },
            [TOOL_NAME]: { default_return_value: mockResult, default_is_error: false },
          },
        },
        extra_evaluation_criteria: [
          {
            id: "no_internal_narration",
            name: "No internal narration",
            conversation_goal_prompt: "The booking agent never spoke internal reasoning, planning notes, or a summary of what the user said as if narrating its thought process.",
          },
          {
            id: "no_repetition",
            name: "No repeated lines",
            conversation_goal_prompt: "The booking agent did not repeat the same sentence or clause in adjacent turns.",
          },
          {
            id: "correct_no_remedies_response",
            name: "Understands no prior remedies",
            conversation_goal_prompt: "When the user said they had not tried remedies, the booking agent acknowledged that answer without falsely claiming the user had tried them.",
          },
        ],
        new_turns_limit: 24,
      }),
    });
    results.push(analyzeConversation(model, simulation));
  } catch (error) {
    results.push({ model, pass: false, error: error.message });
  } finally {
    if (temporaryAgentId) {
      try { await api(`/v1/convai/agents/${temporaryAgentId}`, { method: "DELETE" }); } catch (error) {
        results.push({ model, cleanup_error: error.message, temporary_agent_id: temporaryAgentId });
      }
    }
  }
}

const timestamp = new Date().toISOString().replaceAll(":", "-");
const artifactDir = path.join(repoDir, "artifacts");
await mkdir(artifactDir, { recursive: true });
const artifactPath = path.join(artifactDir, `elevenlabs-outbound-ab-${timestamp}.json`);
await writeFile(artifactPath, `${JSON.stringify({ created_at: new Date().toISOString(), production_agent_id: productionAgentId, results }, null, 2)}\n`);
console.log(JSON.stringify({
  artifact: artifactPath,
  results: results.map((result) => ({
    model: result.model,
    pass: result.pass,
    agent_turns: result.agent_turns,
    alert_count: result.alerts?.length,
    calendar_actions: result.calendar_actions,
    error: result.error,
  })),
}, null, 2));
