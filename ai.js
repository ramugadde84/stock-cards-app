/**
 * AI earnings analysis
 * ---------------------
 * Feeds the Benzinga data (earnings numbers + bull/bear cases) to an LLM and
 * asks for a structured read: bullish / bearish / mixed, with the reasoning
 * and the caveats spelled out.
 *
 * WHY THIS IS FRAMED THE WAY IT IS
 * --------------------------------
 * An LLM can genuinely help here — it's good at weighing a beat against
 * guidance language and summarising which factors actually matter. What it
 * CANNOT do is predict the price reaction, and a tool that implies otherwise
 * is worse than useless. So the prompt below deliberately:
 *   - asks for analysis of what the numbers say, not a price forecast,
 *   - requires the model to list what would undercut its own read, and
 *   - requires an explicit "unknowns" field, so gaps in the data are
 *     surfaced rather than papered over with confident-sounding prose.
 *
 * Remember what we saw with RadNet: a clear EPS beat plus raised guidance
 * still only moved the stock -0.53%. Beat/miss and market reaction are
 * different questions, and the output keeps them separate.
 *
 * CONFIGURATION
 * -------------
 *   ANTHROPIC_API_KEY   required to enable this feature
 *   AI_MODEL            optional, defaults to claude-sonnet-5
 *
 *   set ANTHROPIC_API_KEY=sk-ant-xxxx
 *   npm start
 *
 * Like the Benzinga key, this is billable — never hardcode or commit it.
 */

const { httpFetch } = require('./httpClient');

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-5';


function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Builds the prompt. Everything the model sees is passed in explicitly —
 * no hidden state — so the output is reproducible and auditable.
 */
/** Strips HTML tags from wire copy and caps length for the prompt. */
function cleanBody(html, maxChars = 6000) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);
}

function buildPrompt(ticker, data) {
  const e = data.earnings;
  const bb = data.bullsBears;
  const releases = data.newsReleases || [];

  const lines = [];
  lines.push(`Ticker: ${ticker}`);

  // The press release is the FASTEST and most complete source — it lands on
  // Benzinga's wire the moment the company publishes, ahead of aggregators,
  // and it contains guidance language that structured EPS fields never do.
  // Put it first so the model weighs it accordingly.
  if (releases.length) {
    lines.push('', '=== EARNINGS PRESS RELEASE (Benzinga wire — primary source) ===');
    releases.slice(0, 2).forEach((r, i) => {
      lines.push('', `[Release ${i + 1}] ${r.title || ''}`);
      if (r.created) lines.push(`Published: ${r.created}`);
      const body = cleanBody(r.body) || cleanBody(r.teaser);
      if (body) lines.push('', body);
    });
  }

  if (e) {
    lines.push('', 'REPORTED EARNINGS:');
    lines.push(`- Date: ${e.date || 'n/a'}${e.time ? ' ' + e.time : ''}`);
    lines.push(`- Period: ${e.period || 'n/a'}`);
    lines.push(`- EPS actual: ${e.epsActual ?? 'not yet reported'}`);
    lines.push(`- EPS estimate: ${e.epsEstimate ?? 'n/a'}`);
    lines.push(`- EPS surprise %: ${e.epsSurprisePercent ?? 'n/a'}`);
    lines.push(`- Revenue actual: ${e.revenueActual ?? 'not yet reported'}`);
    lines.push(`- Revenue estimate: ${e.revenueEstimate ?? 'n/a'}`);
  } else {
    lines.push('', 'REPORTED EARNINGS: none available.');
  }

  if (bb && (bb.bullCase || bb.bearCase)) {
    lines.push('', 'ANALYST BULL CASE (Benzinga):', bb.bullCase || 'n/a');
    lines.push('', 'ANALYST BEAR CASE (Benzinga):', bb.bearCase || 'n/a');
  } else {
    lines.push('', 'ANALYST BULL/BEAR CASES: none available.');
  }

  return `You are analysing an equity earnings report for a retail investor's personal dashboard.

${lines.join('\n')}

Assess what THIS DATA says about the company's reported results. Judge the fundamentals — do not predict the share price, and do not give buy/sell/hold advice.

If a press release is included above, read it carefully and EXTRACT the actual figures — revenue, EPS, margins, and especially any FORWARD GUIDANCE. Populate the "extracted" field with what you find. Only report numbers that literally appear in the text; leave a field null rather than inferring or estimating it. A fabricated figure is far worse than a missing one.

Weigh the following, in roughly this order of importance:
1. Forward guidance — raised, lowered, or reaffirmed? This routinely moves the stock more than the quarter just reported.
2. Did EPS and revenue beat or miss consensus, and by how much?
3. Margin direction and any one-off or non-recurring items.
4. What do the bull and bear cases identify as the real drivers?

Important: a beat does not reliably mean the stock rises. Expectations already priced in, guidance, and one-off items routinely matter more. If the data does not let you judge something important, say so in "unknowns" rather than guessing.

Respond with ONLY a JSON object, no markdown fences, in exactly this shape:
{
  "verdict": "Bullish" | "Bearish" | "Mixed" | "Insufficient data",
  "confidence": "high" | "medium" | "low",
  "summary": "two or three sentences on what the results actually show",
  "extracted": {
    "revenue": "as stated, e.g. '$622.7M, +25% YoY', or null",
    "eps": "as stated, or null",
    "epsVsEstimate": "beat/miss and by how much if stated, or null",
    "guidance": "what guidance was given and whether raised/lowered/reaffirmed, or null",
    "margins": "margin commentary if stated, or null"
  },
  "bullPoints": ["strongest supporting points, quoting figures where given"],
  "bearPoints": ["strongest opposing points, quoting figures where given"],
  "unknowns": ["what's missing that would change or firm up this read"]
}`;
}

/**
 * Calls the model and returns parsed analysis.
 * Throws with a readable message on failure.
 */
async function analyzeEarnings(ticker, data) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');

  const body = {
    model: process.env.AI_MODEL || DEFAULT_MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: buildPrompt(ticker, data) }],
  };

  const options = {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
  const response = await httpFetch(API_URL, options);
  const text = await response.text();

  if (!response.ok) {
    let detail = '';
    try {
      detail = JSON.parse(text)?.error?.message || '';
    } catch (e) {
      detail = text.slice(0, 200);
    }
    if (response.status === 401) throw new Error(`Auth failed (401) — ANTHROPIC_API_KEY rejected. ${detail}`);
    if (response.status === 429) throw new Error(`Rate limited (429). ${detail}`);
    throw new Error(`AI request failed (HTTP ${response.status}). ${detail}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    throw new Error('AI response was not valid JSON.');
  }

  const content = payload?.content?.[0]?.text || '';
  if (!content) throw new Error('AI returned an empty response.');

  return parseAnalysis(content);
}

/**
 * Parses the model's JSON. Models occasionally wrap JSON in markdown fences
 * despite instructions, so strip those before parsing rather than failing.
 */
function parseAnalysis(raw) {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');

  // Fall back to the outermost braces if there's stray prose around it.
  if (!s.startsWith('{')) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) s = s.slice(start, end + 1);
  }

  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch (e) {
    // Never fabricate a verdict from unparseable output — surface the text.
    return {
      verdict: 'Insufficient data',
      confidence: 'low',
      summary: raw.slice(0, 600),
      bullPoints: [],
      bearPoints: [],
      unknowns: ['The model did not return valid JSON; raw text shown above.'],
    };
  }

  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const str = (v) => (typeof v === 'string' && v.trim() && v !== 'null' ? v.trim() : null);

  const ex = parsed.extracted && typeof parsed.extracted === 'object' ? parsed.extracted : {};

  return {
    verdict: typeof parsed.verdict === 'string' ? parsed.verdict : 'Insufficient data',
    confidence: typeof parsed.confidence === 'string' ? parsed.confidence : 'low',
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    // Figures read out of the press release. Each is either a string the
    // model found in the text, or null — never a guess.
    extracted: {
      revenue: str(ex.revenue),
      eps: str(ex.eps),
      epsVsEstimate: str(ex.epsVsEstimate),
      guidance: str(ex.guidance),
      margins: str(ex.margins),
    },
    bullPoints: arr(parsed.bullPoints),
    bearPoints: arr(parsed.bearPoints),
    unknowns: arr(parsed.unknowns),
  };
}

module.exports = { analyzeEarnings, isConfigured };
