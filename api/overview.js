const { buildDashboardData } = require('./data');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600'); // cache 1hr — LLM calls cost money
  try {
    const data = await buildDashboardData(req.query?.owner || null);
    const prompt = `You are a revenue analyst for this org. Using the metrics below,
write a concise executive overview: overall health, what's working, what's at risk,
and 2-3 specific recommendations. Reference real numbers. Metrics:\n\n${JSON.stringify(data)}`;

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
    const json = await r.json();
    res.status(200).json({ summary: json.content[0].text, generated: data.generated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
