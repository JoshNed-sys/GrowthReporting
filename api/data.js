// api/data.js — Vercel serverless function
// Queries Salesforce via Composio and returns dashboard JSON
const https = require('https');

const PIPELINE_STAGES = ['Qualify', 'Explore', 'Propose', 'Negotiate', 'Nurture'];
const FISCAL_YEAR = new Date().getFullYear();

// ── Revenue config (update manually each month until Stripe is connected) ────
// Last updated: 2026-06-01
const REVENUE = {
  monthlyGoal: 83000,
  annualGoal: 750000,
  // True ARR from active recurring subscriptions (e.g. Stripe/contracts).
  // Update manually. Leave null to fall back to MRR × 12 on the dashboard.
  currentARR: null,
  // Monthly revenue — update the current month each month
  monthly: [
    { month: 'Jan 2026', revenue: 20000 },
    { month: 'Feb 2026', revenue: 20000 },
    { month: 'Mar 2026', revenue: 20000 },
    { month: 'Apr 2026', revenue: 38250 },
    { month: 'May 2026', revenue: 33000 },
    { month: 'June 2026', revenue: 35800 },
  ],
  // Net new MRR added each month — update monthly
  monthlyNewMRR: [
    { month: 'Jan 2026', newMRR: 1420 },
    { month: 'Feb 2026', newMRR: 1420 },
    { month: 'Mar 2026', newMRR: 1420 },
    { month: 'Apr 2026', newMRR: 0 },
    { month: 'May 2026', newMRR: 3800 },
    { month: 'May 2026', newMRR: 2800 },
  ],
};

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

// ── QuickBooks auth + revenue ─────────────────────────────────────────────────
const MONTHLY_REVENUE_GOAL = 83000;
const ANNUAL_REVENUE_GOAL = 750000;
const QB_BASE = 'sandbox-quickbooks.api.intuit.com';

async function qbRequest(path, accessToken, realmId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: QB_BASE,
      path: `/v3/company/${realmId}${path}`,
      method: 'GET',
      headers: {
        'Authorization': 'Bearer ' + accessToken,
        'Accept': 'application/json',
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.fault || json.Fault) return reject(new Error('QB API error: ' + JSON.stringify(json.fault || json.Fault).slice(0, 200)));
          resolve(json);
        } catch (e) { reject(new Error('QB parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function qbRefreshToken() {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.QB_REFRESH_TOKEN,
  }).toString();
  const auth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth.platform.intuit.com',
      path: '/oauth2/v1/tokens/bearer',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + auth,
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (!data) return reject(new Error(`QB token empty response, status=${res.statusCode}, headers=${JSON.stringify(res.headers).slice(0,200)}`));
          const json = JSON.parse(data);
          if (json.error) return reject(new Error('QB auth error: ' + json.error + ' - ' + json.error_description));
          if (!json.access_token) return reject(new Error('QB: no access_token: ' + data.slice(0, 200)));
          resolve(json.access_token);
        } catch (e) {
          reject(new Error('QB token parse error [' + res.statusCode + ']: ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getQBRevenue(fiscalYear) {
  try {
    const accessToken = await qbRefreshToken();
    const realmId = process.env.QB_REALM_ID;
    if (!realmId) throw new Error('QB_REALM_ID not set');

    const startDate = `${fiscalYear}-01-01`;
    const endDate = new Date().toISOString().slice(0, 10);
    const report = await qbRequest(
      `/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}&summarize_column_by=Month&accounting_method=Cash`,
      accessToken,
      realmId
    );

    // Parse columns (skip label column, get month columns)
    const cols = report?.Columns?.Column || [];
    const monthCols = cols.slice(1).filter(c => c.ColTitle && c.ColTitle !== 'TOTAL');

    // Find Income/Total Income row
    const rows = report?.Rows?.Row || [];
    let incomeRow = null;
    for (const row of rows) {
      if (row.type === 'Section' && (row.Header?.ColData?.[0]?.value || '').toLowerCase().includes('income')) {
        incomeRow = row.Summary?.ColData || [];
        break;
      }
    }
    if (!incomeRow) return null;

    const monthlyRevenue = monthCols.map((col, i) => ({
      month: col.ColTitle,
      revenue: parseFloat(incomeRow[i + 1]?.value || '0') || 0,
    })).filter(m => m.revenue > 0);

    const ytdRevenue = monthlyRevenue.reduce((a, m) => a + m.revenue, 0);
    const currentMonthRevenue = monthlyRevenue.length ? monthlyRevenue[monthlyRevenue.length - 1].revenue : 0;

    return {
      monthlyRevenue,
      ytdRevenue,
      currentMonthRevenue,
      monthlyGoal: MONTHLY_REVENUE_GOAL,
      annualGoal: ANNUAL_REVENUE_GOAL,
      monthlyPct: Math.round((currentMonthRevenue / MONTHLY_REVENUE_GOAL) * 100),
      annualPct: Math.round((ytdRevenue / ANNUAL_REVENUE_GOAL) * 100),
      arr: REVENUE.currentARR != null ? REVENUE.currentARR : currentMonthRevenue * 12,
    };
  } catch (e) {
    console.error('QB revenue error:', e.message);
    return null;
  }
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

// ── Data builder (shared by /api/data and /api/overview) ─────────────────────
async function buildDashboardData(owner) {
    const stagesCsv = PIPELINE_STAGES.map(s => `'${s}'`).join(',');
    const today = new Date().toISOString().slice(0, 10);
    const currentMonth = today.slice(0, 7);

    // Owner filter (optional)
    const ownerFilter = owner ? ` AND Owner.Name = '${owner}'` : '';
    const eventOwnerFilter = owner ? ` AND Owner.Name = '${owner}'` : '';

    // 1. Open pipeline opps
    const opps = await soql(
      `SELECT Id, StageName, Amount, CreatedDate, AccountId FROM Opportunity WHERE StageName IN (${stagesCsv}) AND AccountId != null${ownerFilter} LIMIT 2000`
    );

    // 2. Accounts with open pipeline opps
    const openAccounts = await soql(
      `SELECT AccountId FROM Opportunity WHERE StageName IN (${stagesCsv}) AND AccountId != null${ownerFilter} LIMIT 2000`
    );
    const openAccountIdsCsv = openAccounts.length
      ? [...new Set(openAccounts.map(o => o.AccountId))].map(id => `'${id}'`).join(',')
      : "'NONE'";

    // 3. Events this FY on those accounts
    const events = await soql(
      `SELECT Id, ActivityDate, AccountId FROM Event WHERE ActivityDate >= ${FISCAL_YEAR}-01-01 AND ActivityDate <= ${today} AND AccountId IN (${openAccountIdsCsv})${eventOwnerFilter} LIMIT 2000`
    );

    // 4. Revenue from config (swap for Stripe later)
    const currentMonthRevenue = REVENUE.monthly.length ? REVENUE.monthly[REVENUE.monthly.length - 1].revenue : 0;
    const ytdRevenue = 124250; // Hardcoded YTD gross revenue — update manually each month
    const qbRevenuePromise = Promise.resolve({
      monthlyRevenue: REVENUE.monthly,
      ytdRevenue,
      currentMonthRevenue,
      monthlyGoal: REVENUE.monthlyGoal,
      annualGoal: REVENUE.annualGoal,
      monthlyPct: Math.round((currentMonthRevenue / REVENUE.monthlyGoal) * 100),
      annualPct: Math.round((ytdRevenue / REVENUE.annualGoal) * 100),
      // True ARR if provided, else annualize current MRR
      arr: REVENUE.currentARR != null ? REVENUE.currentARR : currentMonthRevenue * 12,
    });

    // 5. Closed opps this FY — use IsClosed/IsWon flags, not StageName.
    // Won deals live under multiple stage names (e.g. 'Active', 'Closed Won',
    // 'Demo Platform Configuration'), so IsWon is the reliable signal.
    // Cap at today so future-dated closes aren't counted.
    const closedOpps = await soql(
      `SELECT Id, StageName, IsWon, Amount, CloseDate FROM Opportunity WHERE IsClosed = true AND CloseDate >= ${FISCAL_YEAR}-01-01 AND CloseDate <= ${today}${ownerFilter} LIMIT 2000`
    );

    // 5b. Total opportunities this FY — win-rate denominator (all opps, not just closed)
    const allOppsThisYear = await soql(
      `SELECT COUNT(Id) cnt FROM Opportunity WHERE CloseDate >= ${FISCAL_YEAR}-01-01 AND CloseDate <= ${FISCAL_YEAR}-12-31${ownerFilter}`
    );
    const totalOppsThisYear = allOppsThisYear.length ? (allOppsThisYear[0].cnt || 0) : 0;

    // 5c. Active clients — distinct accounts with a won (active) opportunity
    const activeClientsResult = await soql(
      `SELECT COUNT_DISTINCT(AccountId) accts FROM Opportunity WHERE IsWon = true AND AccountId != null${ownerFilter}`
    );
    const activeClients = activeClientsResult.length ? (activeClientsResult[0].accts || 0) : 0;

    // ── KPI: Avg Days — Lead Created to First Meeting ────────────────────────
    // Fully self-contained. Fetches converted leads + their account events, computes in JS.
    const kpi_convertedLeadRecords = await soql(
      `SELECT Id, CreatedDate, ConvertedAccountId FROM Lead WHERE IsConverted = true AND ConvertedDate >= ${FISCAL_YEAR}-01-01 AND ConvertedDate <= ${today} LIMIT 2000`
    );
    const kpi_convertedAccountIds = kpi_convertedLeadRecords.map(l => l.ConvertedAccountId).filter(Boolean);
    const kpi_convertedAccountIdsCsv = kpi_convertedAccountIds.length
      ? kpi_convertedAccountIds.map(id => `'${id}'`).join(',')
      : "'NONE'";
    const kpi_accountEvents = await soql(
      `SELECT AccountId, ActivityDate FROM Event WHERE AccountId IN (${kpi_convertedAccountIdsCsv}) AND ActivityDate >= ${FISCAL_YEAR}-01-01 AND ActivityDate <= ${today} LIMIT 2000`
    );
    const kpi_firstMeetingByAccount = {};
    kpi_accountEvents.forEach(e => {
      if (!kpi_firstMeetingByAccount[e.AccountId] || e.ActivityDate < kpi_firstMeetingByAccount[e.AccountId]) {
        kpi_firstMeetingByAccount[e.AccountId] = e.ActivityDate;
      }
    });
    const kpi_leadCreatedByAccount = {};
    kpi_convertedLeadRecords.forEach(l => {
      if (l.ConvertedAccountId) kpi_leadCreatedByAccount[l.ConvertedAccountId] = l.CreatedDate;
    });
    const kpi_daysArr = kpi_convertedAccountIds
      .filter(id => kpi_firstMeetingByAccount[id] && kpi_leadCreatedByAccount[id])
      .map(id => Math.round((new Date(kpi_firstMeetingByAccount[id]) - new Date(kpi_leadCreatedByAccount[id])) / 86400000))
      .filter(d => d >= 0);
    const avgDaysLeadToMeeting = kpi_daysArr.length > 0
      ? Math.round(kpi_daysArr.reduce((a, b) => a + b, 0) / kpi_daysArr.length)
      : null;
    const avgDaysLeadToMeetingSampleSize = kpi_daysArr.length;

    // ── KPI: Lead Conversion Rate ─────────────────────────────────────────────
    // Converted leads this FY / total leads touched this FY.
    // NOTE: CreatedDate is a DateTime field — requires T00:00:00Z format, not plain date.
    // ConvertedDate is a Date field — plain date format works fine.
    const kpi_allLeads = await soql(
      `SELECT Id FROM Lead WHERE CreatedDate >= ${FISCAL_YEAR}-01-01T00:00:00Z AND CreatedDate <= ${today}T23:59:59Z LIMIT 2000`
    );
    const kpi_convertedLeads = await soql(
      `SELECT Id FROM Lead WHERE IsConverted = true AND ConvertedDate >= ${FISCAL_YEAR}-01-01 AND ConvertedDate <= ${today} LIMIT 2000`
    );
    const totalLeads = kpi_allLeads.length;
    const convertedLeads = kpi_convertedLeads.length;
    const leadConversionRate = totalLeads > 0
      ? Math.round((convertedLeads / totalLeads) * 100)
      : null;

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

    // ── QuickBooks revenue (await the parallel promise) ──
    const qbRevenue = await qbRevenuePromise;

    // ── Win rate ──
    const closedWon = closedOpps.filter(o => o.IsWon === true);
    // Win rate = won deals / all opportunities this year
    const winRate = totalOppsThisYear
      ? Math.round((closedWon.length / totalOppsThisYear) * 100)
      : null;
    // Opportunity Amount is annual contract value — divide by 12 for monthly revenue
    const closedWonValue = closedWon.reduce((a, o) => a + (o.Amount || 0), 0) / 12;

    return {
      generated: today,
      fiscalYear: FISCAL_YEAR,
      meetingsPerMonth,
      pipelineByStage,
      pipelineGrowth,
      monthlyNewMRR: REVENUE.monthlyNewMRR,
      revenue: qbRevenue,
      summary: {
        totalOpenPipelineValue: totalPipelineValue,
        totalOpenOpportunities: totalOpenOpps,
        ytdMeetings,
        avgMonthlyMeetings,
        winRate,
        closedWonValue,
        closedWonCount: closedWon.length,
        activeClients,
        avgDaysLeadToMeeting,
        avgDaysLeadToMeetingSampleSize,
        totalLeads,
        convertedLeads,
        leadConversionRate,
      },
    };
}

// ── HTTP handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300');
  try {
    const owner = req.query && req.query.owner ? req.query.owner : null;
    const data = await buildDashboardData(owner);
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};

// Export for reuse by /api/overview
module.exports.buildDashboardData = buildDashboardData;
