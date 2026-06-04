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
Evaluate the metrics against the company's stated business goals (below), and produce
a scannable, highly actionable brief that frames everything in terms of progress toward
those goals.

=== COMPANY BUSINESS GOALS (the lens to judge performance through) ===

Revenue Growth goals:
- Pipeline Coverage Ratio: maintain 3x open pipeline coverage against quota; catch shortfalls early.
- New Pipeline Created (MoM): drive consistent net-new pipeline each month as a leading indicator of future revenue.
- Closed Won Revenue (YTD): grow booked revenue against the annual target with YoY improvement; measure quarterly pacing.
- Average Deal Size: grow average contract value by moving upmarket; watch for drift toward smaller deals.

Efficiency goals:
- Lead-to-Account Conversion: convert prospects into qualified accounts by booking meetings; build reliable top-of-funnel.
- Account-to-Opportunity Rate: convert post-meeting accounts into real opportunities; reduce pipeline inflation from unqualified accounts.
- Opportunity Stage Velocity: move deals efficiently Qualify→Negotiate; find and remove stage bottlenecks; shorten cycle without losing quality.
- Win Rate: improve the % of open opportunities that close won via better qualification and rep execution; track win/loss patterns.

When a metric needed to judge a goal is missing from the data, say so briefly and note it as a measurement gap rather than inventing a number.

=== END GOALS ===

Using the metrics below, format your response EXACTLY like this, using markdown:

**Bottom line:** <one punchy sentence. State that ARR is pacing at ~$365K, up from $250K last year (+46% YoY), then give the honest overall read on goal progress.>

## On track
- <goal being met or progressing + the number proving it>
- <goal being met or progressing + the number proving it>

## Off track
- <goal that's behind + the number behind it>
- <goal that's behind + the number behind it>

## Do this next
1. <imperative action starting with a verb> — <expected metric impact>
2. <imperative action starting with a verb> — <expected metric impact>
3. <imperative action starting with a verb> — <expected metric impact>

Rules: lead every bullet with the concrete figure. One line per bullet.
Do NOT append goal names in parentheses, asterisks, or any trailing tags — write naturally.
Make recommendations specific and immediately doable, not generic advice.
Total under 230 words. Do not add any text outside this structure.

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
