// api/chat.js — Vercel serverless function
// Lets the user chat with Claude about the live dashboard data.
const { buildDashboardData } = require('./data');

const GOALS = `
Revenue Growth goals:
- Pipeline Coverage Ratio: maintain 3x open pipeline coverage against quota.
- New Pipeline Created (MoM): drive consistent net-new pipeline each month.
- Closed Won Revenue (YTD): grow booked revenue vs annual target with YoY improvement.
- Average Deal Size: grow average contract value; watch for drift to smaller deals.

Efficiency goals:
- Lead-to-Account Conversion: book meetings, build reliable top-of-funnel.
- Account-to-Opportunity Rate: turn meetings into real opportunities; reduce pipeline inflation.
- Opportunity Stage Velocity: move deals Qualify->Negotiate; remove bottlenecks.
- Win Rate: improve % of opportunities that close won.`;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

    // Vercel parses JSON bodies automatically; fall back just in case.
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const message = (body.message || '').toString().slice(0, 2000);
    const history = Array.isArray(body.history) ? body.history.slice(-10) : [];
    if (!message) return res.status(400).json({ error: 'message required' });

    const data = await buildDashboardData(body.owner || null);

    const system =
`You are a revenue analyst assistant embedded in this org's sales dashboard.
Answer questions about the business using ONLY the metrics and goals below.
Be concise, specific, and lead with numbers. If the data can't answer a question,
say so plainly rather than guessing. Use short markdown (bold, bullets) when helpful.

COMPANY GOALS:${GOALS}

CURRENT METRICS (JSON):
${JSON.stringify(data)}`;

    const messages = [
      ...history
        .filter(m => m && m.role && m.content)
        .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) })),
      { role: 'user', content: message },
    ];

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
        system,
        messages,
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error('Anthropic API error ' + r.status + ': ' + errText.slice(0, 300));
    }

    const json = await r.json();
    const reply = json?.content?.[0]?.text || 'No reply returned.';
    res.status(200).json({ reply });
  } catch (err) {
    console.error('chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
