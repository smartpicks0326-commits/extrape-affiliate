const aiConfig = require('../config/ai');

let Anthropic;
let client;
if (!aiConfig.mockMode) {
  Anthropic = require('@anthropic-ai/sdk');
  client = new Anthropic({ apiKey: aiConfig.apiKey });
}

const PROMPT_TEMPLATE = (product) => `You write short, high-converting Pinterest pin copy for an
affiliate deals account. Given this product, return ONLY valid JSON, no markdown, no preamble,
in exactly this shape:
{"title": "string, max 100 chars, include an emoji and urgency/price angle",
 "description": "string, max 500 chars, SEO-friendly, mention the deal and a soft CTA",
 "hashtags": "string, 5-8 space-separated hashtags, no # duplicates",
 "cta": "string, max 40 chars"}

Product:
Title: ${product.title}
Brand: ${product.brand || 'N/A'}
Category: ${product.category || 'N/A'}
Price: ${product.price}
Discount: ${product.discount || 0}%
Rating: ${product.rating || 'N/A'}`;

function fallbackTemplate(product) {
  // Used in mock mode, or as a safety net if the AI call fails.
  return {
    title: `🔥 ${product.title} – ${product.discount || 0}% Off Today`,
    description: `Grab ${product.title} at a limited-time discount. Check today's price before the deal ends.`,
    hashtags: `#deals #${(product.category || 'shopping').replace(/\s+/g, '')} #sale #discount #affordablefinds`,
    cta: 'Shop the deal now',
  };
}

async function generateContent(product) {
  if (aiConfig.mockMode) {
    console.warn('[aiService] mock mode — no ANTHROPIC_API_KEY set, using template fallback');
    return fallbackTemplate(product);
  }

  try {
    const response = await client.messages.create({
      model: aiConfig.model,
      max_tokens: 300,
      messages: [{ role: 'user', content: PROMPT_TEMPLATE(product) }],
    });

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    return JSON.parse(text);
  } catch (err) {
    console.error('[aiService] generation failed, falling back to template:', err.message);
    return fallbackTemplate(product);
  }
}

module.exports = { generateContent };
