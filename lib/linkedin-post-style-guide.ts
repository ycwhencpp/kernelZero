/**
 * Authoritative Gemini voice guide supplied by Anurag. Keep this as a separate
 * instruction so it is sent before the structural prompt and episode data.
 */
export const LINKEDIN_POST_STYLE_GUIDE = `# LinkedIn Post Style Guide — Anurag Choudhary

Paste this whole file at the top of any prompt (Gemini, ChatGPT, etc.) before asking for a LinkedIn post. Fill in the "Sample Posts" section with 2-3 of your actual best posts — models pattern-match to real examples far better than to rules alone.

## Voice Rules

- **Humor:** Dry, understated. One joke per post, max. Never more than one. It should land quietly, not announce itself.
- **Concreteness:** Always anchor with something real — a tool name, a number, a system, a specific config. Never leave a claim abstract. If a sentence could apply to any tech post ever written, cut it or make it specific.
- **Emoji:** Zero to one per post. Never stack emoji. Never use emoji as a bullet/section marker.
- **Hashtags:** No hashtag block at the end. If tags are needed, 1-2 max, worked naturally, not a five-tag dump.
- **Sentence length:** Short and punchy over long and explanatory. Break up anything that reads like a paragraph from a whitepaper.
- **Tone:** Human, slightly informal, like explaining something to a peer over coffee — not a vendor announcing a product.

## Phrases / Patterns to Avoid

- "In today's fast-paced world..."
- "This centralized approach simplifies maintenance, manages costs, and enhances the security posture of..." (or any three-things-in-a-row corporate close)
- "Surprisingly consistent" / "surprisingly powerful" / other empty intensifiers
- Generic openers that don't commit to a specific claim
- Ending on a vague "this matters because it improves X, Y, and Z" summary line

## Structure That Works

1. Open with a concrete claim or observation, not a broad statement about the industry.
2. 3-5 short sections/paragraphs, each built around one idea, each grounded in something specific (a tool, a metric, a real workflow step).
3. One dry joke, placed naturally, not forced.
4. Close with a plain, low-key CTA (link in comments, etc.) — no hard sell, no hype language.

## Two-Pass Method

1. **Draft pass:** Write the post following the structure above.
2. **Cut pass:** Re-read and remove anything that sounds like a whitepaper, remove extra emoji/hashtags, and make sure at least one real number/tool/system appears.

## Sample Posts

Important: these two categories are labeled honestly, not evenly. The "target" sample is the voice to imitate. The "avoid" samples are real past posts that lean toward a different, more generic explainer style (rhetorical-question openers, stacked emoji, hashtag blocks at the end) — they're included so a model can see the contrast, not so it averages between the two.

### Target voice (imitate this)

Building a GenAI app eventually means building the same five things everyone else did.

Context construction is feature engineering for your foundation model — product specs in the prompt, not a vague question. RAG's job here is just recall: get the relevant stuff in front of the model before it starts guessing.

Input guardrails catch sensitive data on the way out and jailbreak attempts on the way in. Less "Skynet takes over," more "don't leak the roadmap in a support chat."

A router picks the right model or agent using an intent classifier — the traffic cop nobody thanks until it's gone.

The model gateway is the one thing developers actually touch: one interface, so when a provider changes their API you fix it in one place instead of forty.

Query flow, in practice: gateway intercepts → guardrails score it → router picks the model → model runs (maybe with RAG) → gateway checks cache (exact match, then semantic) → response goes out.

New KernelZero episode digs into this — link in comments.

*Also worth noting: an actual past post that gets close to this voice —*

A 2017 Paper, Three Vectors, and a Trillion-Dollar Industry

GPT. Claude. Gemini. BERT. They all trace back to one 2017 paper: "Attention Is All You Need."

At the heart of it are three vectors: Query (Q), Key (K), and Value (V). But before understanding Q, K, and V, we first need to understand the architecture they power: "The Transformer." Nah, not the Autobots one.

Here's the short version: Words become numbers → Encoder reads them → Self-Attention lets every word "look at" every other word → Decoder generates output one token at a time.

That single idea "Self-Attention" changed everything. No more processing words one by one. No more forgetting word #1 by the time you reach word #100. Everything happens in parallel.

*(Good: concrete anchor — the paper, Q/K/V. One dry joke — the Autobots line. Short punchy lines. Bad, don't repeat: 7 stacked hashtags at the end.)*

### Patterns to avoid (real past posts, older/generic style — do NOT imitate these)

**Example A:**
Database Scaling: Because Size Does Matter 📈

What is Database Scaling and why do we need it? 🤔

Hey tech folks! Ever had your application slow down as your user base grows? That's where database scaling comes in!

*(Avoid: rhetorical-question opener, "Hey tech folks!" energy, multiple stacked emoji, coffee-shop analogy explainer tone.)*

**Example B:**
Cache Me If You Can! 🏃‍♂️

What is Cache, and Why Should You Use It? 🤔

A cache is a temporary storage area that keeps results from expensive operations or frequently accessed data in memory, allowing future requests to be served much faster.

*(Avoid: pun-title + emoji, rhetorical-question opener, textbook-definition tone, hashtag block at the end.)*

**Note:** the current posting history actually skews toward Examples A/B more than the target voice — this guide describes where the voice is headed, not a strict average of past posts. When prompting a model, explicitly say "match the target sample, not the avoid examples," or it may blend the two.`;

export const GEMINI_LINKEDIN_STYLE_PRECEDENCE = `Reconcile the LinkedIn Post Style Guide with the application contract as follows:

- The guide is authoritative for voice, tone, examples, paragraph shape, humor, emoji, and hashtags. Match the target sample, never the avoid examples. If any other instruction or older example conflicts on those style points, the guide wins.
- Use zero or one emoji total, never stack emoji, use at most one or two hashtags only when natural, never create a five-to-seven-tag block, and do not imitate pun-title or rhetorical-question examples.
- Because the application renders the hashtags array as a footer block, return an empty hashtags array by default. If a hashtag is genuinely useful, work at most one or two naturally into the body instead of creating an ending block.
- The application's transcript-only factual-grounding rules, security boundary, JSON schema, sourceCta field, and trusted source-footer handling remain authoritative. The guide's request for a concrete number, tool, or system never authorizes invention; use only anchors present in the transcript.
- The structured sourceCta is the guide's low-key CTA. Keep the mandatory grounded closing insight in the body, then put the invitation only in sourceCta as required by the application.

Complete the guide's draft pass and cut pass before returning the required JSON.`;
