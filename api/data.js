// api/data.js — Vercel serverless function
// Queries Salesforce via Composio and returns dashboard JSON

const https = require('https');

const PIPELINE_STAGES = ['Qualify', 'Explore', 'Propose', 'Negotiate', 'Nurture'];
const FISCAL_YEAR = new Date().getFullYear();

// ── Composio SOQL helper ─────────────────────────────────────────────────────

async function soql(query) {
  const body = JSON.stringify({
    entity_id: 'josh@nedhelps.com',
    arguments: { query },
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'backend.composio.dev',
      path: '/api/v3/tools/execute/SALESFORCE_RUN_SOQL_QUERY',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.COMPOSIO_API_KEY,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.successful) return reject(new Error(json.error || 'Composio error'));
          const records = json?.data?.response_data?.records || [];
          resolve(records);
        } catch (e) {
          reject(new Error('Failed to parse Composio response: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function monthLabel(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function monthSortKey(label) {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const [mon, yr] = label.split(' ');
  return parseInt(yr) * 100 + months.indexOf(mon);
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');

  try {
    const stagesCsv = PIPELINE_STAGES.map(s => `'${s}'`).join(',');
    const today = new Date().toISOString().slice(0, 10);
    const currentMonth = today.slice(0, 7);

    // 1. Open pipeline opps
    const opps = await soql(
      `SELECT Id, StageName, Amount, CreatedDate, AccountId FROM Opportunity WHERE StageName IN (${stagesCsv}) AND AccountId != null LIMIT 2000`
    );

    // 2. Events this FY (past months only)
    const events = await soql(
    `SELECT Id, ActivityDate, AccountId FROM Event WHERE ActivityDate >= ${FISCAL_YEAR}-01-01 AND ActivityDate <= ${today} AND AccountId IN (SELECT AccountId FROM Opportunity WHERE StageName IN (${stagesCsv}) AND AccountId != null AND IsClosed = false) LIMIT 2000`
);

    // 3. Closed won + lost this FY
    const closedOpps = await soql(
      `SELECT Id, StageName, Amount, CloseDate FROM Opportunity WHERE StageName IN ('Closed Won', 'Closed Lost') AND CloseDate >= ${FISCAL_YEAR}-01-01 LIMIT 2000`
    );

    // ── Pipeline by stage ──
    const stageTotals = {};
    PIPELINE_STAGES.forEach(s => stageTotals[s] = { value: 0, count: 0 });
    opps.forEach(o => {
      const s = o.StageName;
      if (stageTotals[s]) {
        stageTotals[s].value += o.Amount || 0;
        stageTotals[s].count += 1;
      }
    });
    const pipelineByStage = PIPELINE_STAGES
      .filter(s => stageTotals[s].count > 0)
      .map(s => ({ stage: s, value: stageTotals[s].value, count: stageTotals[s].count }));

    const totalPipelineValue = pipelineByStage.reduce((a, s) => a + s.value, 0);
    const totalOpenOpps = pipelineByStage.reduce((a, s) => a + s.count, 0);

    // ── Pipeline growth (new opps this FY by month, excl. Feb) ──
    const monthlyNew = {};
    opps.forEach(o => {
      const created = (o.CreatedDate || '').slice(0, 7);
      if (!created.startsWith(String(FISCAL_YEAR))) return;
      if (created === `${FISCAL_YEAR}-02`) return;
      const label = monthLabel(created + '-01');
      if (!monthlyNew[label]) monthlyNew[label] = { count: 0, value: 0 };
      monthlyNew[label].count += 1;
      monthlyNew[label].value += o.Amount || 0;
    });
    const pipelineGrowth = Object.keys(monthlyNew)
      .sort((a, b) => monthSortKey(a) - monthSortKey(b))
      .map(m => ({ month: m, count: monthlyNew[m].count, value: monthlyNew[m].value }));

    // ── Meetings per month ──
    const meetingsByMonth = {};
    events.forEach(e => {
      const d = e.ActivityDate || '';
      if (!d.startsWith(String(FISCAL_YEAR))) return;
      if (d.slice(0, 7) > currentMonth) return;
      const label = monthLabel(d);
      meetingsByMonth[label] = (meetingsByMonth[label] || 0) + 1;
    });
    const meetingsPerMonth = Object.keys(meetingsByMonth)
      .sort((a, b) => monthSortKey(a) - monthSortKey(b))
      .map(m => ({ month: m, meetings: meetingsByMonth[m] }));

    const ytdMeetings = meetingsPerMonth.reduce((a, m) => a + m.meetings, 0);
    const avgMonthlyMeetings = meetingsPerMonth.length
      ? Math.round((ytdMeetings / meetingsPerMonth.length) * 10) / 10
      : 0;

    // ── Win rate ──
    const closedWon = closedOpps.filter(o => o.StageName === 'Closed Won');
    const winRate = closedOpps.length
      ? Math.round((closedWon.length / closedOpps.length) * 100)
      : null;
    const closedWonValue = closedWon.reduce((a, o) => a + (o.Amount || 0), 0);

    res.status(200).json({
      generated: today,
      fiscalYear: FISCAL_YEAR,
      meetingsPerMonth,
      pipelineByStage,
      pipelineGrowth,
      summary: {
        totalOpenPipelineValue: totalPipelineValue,
        totalOpenOpportunities: totalOpenOpps,
        ytdMeetings,
        avgMonthlyMeetings,
        winRate,
        closedWonValue,
        closedWonCount: closedWon.length,
      },
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
