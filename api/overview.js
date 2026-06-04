// api/overview.js — Vercel serverless function
// Pulls the same dashboard metrics and asks Claude for an executive overview.
const { buildDashboardData } = require('./data');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Cache for 1 hour — LLM calls cost money, no need to regenerate every load.
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');

  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY not set');
    }

    const owner = req.query && req.query.owner ? req.query.owner : null;
    const data = await buildDashboardData(owner);

    const prompt =
`You are a sharp revenue analyst writing an executive summary for the founder of this org.
Using ONLY the metrics below, produce a scannable, highly actionable brief.

Format your response EXACTLY like this, using markdown:

**Bottom line:** <one punchy sentence on overall health, citing ARR and growth vs last year>

## What's working
- <bullet with a specific number>
- <bullet with a specific number>
- <bullet with a specific number>

## What's at risk
- <bullet naming the risk + the number behind it>
- <bullet naming the risk + the number behind it>

## Do this next
1. <imperative action starting with a verb> — <expected impact, tied to a metric>
2. <imperative action starting with a verb> — <expected impact, tied to a metric>
3. <imperative action starting with a verb> — <expected impact, tied to a metric>

Rules: lead every bullet with the concrete figure. Keep each bullet to one line.
Make recommendations specific and immediately doable, not generic advice.
Total under 220 words. Do not add any text outside this structure.

METRICS (JSON):
${JSON.stringify(data, null, 2)}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error('Anthropic API error ' + r.status + ': ' + errText.slice(0, 300));
    }

    const json = await r.json();
    const summary = json?.content?.[0]?.text || 'No summary returned.';

    res.status(200).json({ summary, generated: data.generated });
  } catch (err) {
    console.error('overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
