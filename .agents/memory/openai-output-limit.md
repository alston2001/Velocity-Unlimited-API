---
name: OpenAI completion output limits
description: The configured Luna model may reject small completion limits before returning content.
---

For AI coaching and structured diary sentiment calls, use a generous completion budget and constrain output in the prompt; the model can return a 400 when a small max token limit prevents completion.

**Why:** A valid measured-set coaching request previously failed at the provider with an output-limit error when capped too tightly, forcing an unnecessary deterministic fallback.

**How to apply:** Keep prompts concise and ask for short output, but do not use a low completion cap for the configured Luna integration.