
# Fix Sam's Handling of Basic Pleasantries

## The Problem

"How are you today?" is being classified as OFF_TOPIC, triggering the robotic redirect: "I can really only help with hair systems..." Two places in the script cause this:

1. The intent classification system has no category for small talk / pleasantries
2. The IDENTITY section explicitly says to redirect anything "unrelated to hair systems"

## The Fix

One file changed: `supabase/functions/elevenlabs-conversation-token/index.ts`

### 1. Add a PLEASANTRY intent category (around line 24)

Add between EMOTIONAL and the existing categories:

```
- PLEASANTRY: basic small talk or greetings ("how are you", "what's up", "good morning", "how's your day")
```

And in the response rules (around line 33), add:

```
- PLEASANTRY → respond briefly and naturally like a real person ("I'm doing good, thanks for asking!"), then smoothly continue the current stage
```

### 2. Soften the IDENTITY section (line 48)

Change:
```
When a user asks about topics unrelated to hair systems or growing their hair business, politely let them know you can only help with those topics.
```
To:
```
Basic pleasantries like "how are you" are fine -- respond naturally and briefly, then continue the conversation. Only redirect if the user asks substantive questions unrelated to hair systems or business growth.
```

### 3. Narrow the OFF_TOPIC examples (line 23)

Change:
```
- OFF_TOPIC: unrelated to hair systems or business ("what's the weather", random chatter)
```
To:
```
- OFF_TOPIC: substantive questions unrelated to hair systems or business ("what's the weather", "who won the game last night")
```

Remove "random chatter" so greetings don't get swept in.

## Technical Details

| Location | Line(s) | Change |
|----------|---------|--------|
| Intent categories | ~24 | Add PLEASANTRY category |
| Response rules | ~33 | Add PLEASANTRY response rule |
| OFF_TOPIC definition | ~23 | Remove "random chatter", narrow to substantive off-topic |
| IDENTITY section | ~48 | Allow pleasantries, only redirect substantive off-topic |

Single file, single deploy. Sam will respond to "how are you" like a normal human and then get back to business.
