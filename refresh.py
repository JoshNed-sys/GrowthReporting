#!/usr/bin/env python3
"""
refresh.py — Re-pulls Salesforce data via Composio and rewrites data.js.
Run this script whenever you want to update the dashboard with fresh data.

Requirements:
    pip install composio-openai

Setup:
    1. Set COMPOSIO_API_KEY in your environment or a .env file.
    2. Run: composio add salesforce   (only needed once to connect your account)
    3. Then: python refresh.py

The script overwrites data.js in the same directory. Commit & push to GitHub
Pages to publish the update.
"""

import json
import os
import sys
from datetime import date, datetime
from collections import defaultdict

try:
    from composio_openai import ComposioToolSet
except ImportError:
    print("ERROR: composio-openai not installed. Run: pip install composio-openai")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
FISCAL_YEAR = date.today().year
PIPELINE_STAGES = {'Qualify', 'Explore', 'Propose', 'Negotiate', 'Nurture'}
STAGE_ORDER = ["Qualify", "Explore", "Propose", "Negotiate", "Nurture"]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Composio client
# ---------------------------------------------------------------------------
toolset = ComposioToolSet()

def soql(query: str) -> list[dict]:
    """Run a SOQL query via Composio and return records list."""
    result = toolset.execute_action(
        action="SALESFORCE_RUN_SOQL_QUERY",
        params={"query": query},
    )
    if result.get("error"):
        raise RuntimeError(f"SOQL error: {result['error']}\nQuery: {query}")
    return result.get("data", {}).get("records", [])

# ---------------------------------------------------------------------------
# Pull data
# ---------------------------------------------------------------------------
print("Pulling Salesforce data...")

# 1. Opportunities in pipeline stages (all time)
opps = soql(
    "SELECT Id, StageName, Amount, CreatedDate, AccountId "
    "FROM Opportunity "
    "WHERE StageName IN ('Qualify','Explore','Propose','Negotiate','Nurture') "
    "AND AccountId != null LIMIT 2000"
)
print(f"  Open pipeline opps: {len(opps)}")

# 2. Account IDs with active pipeline (for meeting filter)
pipeline_acct_ids = {o["AccountId"] for o in opps if o.get("AccountId")}

# 3. All opps (for growth chart — new pipeline created this FY)
all_opps = soql(
    f"SELECT Id, StageName, Amount, CreatedDate, AccountId "
    f"FROM Opportunity "
    f"WHERE CreatedDate >= {FISCAL_YEAR}-01-01T00:00:00Z AND AccountId != null LIMIT 2000"
)
print(f"  All opps FY{FISCAL_YEAR}: {len(all_opps)}")

# 4. Events this fiscal year (on pipeline accounts)
events = soql(
    f"SELECT Id, ActivityDate, AccountId "
    f"FROM Event "
    f"WHERE ActivityDate >= {FISCAL_YEAR}-01-01 AND ActivityDate <= {FISCAL_YEAR}-12-31 "
    f"AND AccountId != null LIMIT 2000"
)
print(f"  Events: {len(events)}")

# ---------------------------------------------------------------------------
# Compute metrics
# ---------------------------------------------------------------------------
pipeline_by_stage: dict[str, dict] = defaultdict(lambda: {"value": 0.0, "count": 0})
growth_by_month:   dict[str, dict] = defaultdict(lambda: {"count": 0, "value": 0.0})
meetings_by_month: dict[str, int]  = defaultdict(int)

for o in opps:
    stage = o.get("StageName", "")
    pipeline_by_stage[stage]["count"] += 1
    pipeline_by_stage[stage]["value"] += o.get("Amount") or 0.0

for o in all_opps:
    if o.get("StageName") not in PIPELINE_STAGES:
        continue
    month = (o.get("CreatedDate") or "")[:7]
    if month:
        growth_by_month[month]["count"] += 1
        growth_by_month[month]["value"] += o.get("Amount") or 0.0

for e in events:
    if e.get("AccountId") not in pipeline_acct_ids:
        continue
    d = e.get("ActivityDate", "")
    if d:
        meetings_by_month[d[:7]] += 1
    current_month = date.today().strftime("%Y-%m")
meetings_by_month = {k: v for k, v in meetings_by_month.items() if k <= current_month}

# Summaries
total_pipeline  = sum(v["value"] for v in pipeline_by_stage.values())
total_open_opps = sum(v["count"] for v in pipeline_by_stage.values())
ytd_meetings    = sum(meetings_by_month.values())
months_with_meetings = len([v for v in meetings_by_month.values() if v > 0])
avg_monthly = round(ytd_meetings / months_with_meetings, 1) if months_with_meetings else 0

# ---------------------------------------------------------------------------
# Build data.js
# ---------------------------------------------------------------------------
def month_label(ym: str) -> str:
    return datetime.strptime(ym, "%Y-%m").strftime("%b %Y")

meetings_list = [
    {"month": month_label(m), "meetings": meetings_by_month[m]}
    for m in sorted(meetings_by_month)
]

pipeline_list = []
for s in STAGE_ORDER:
    if s in pipeline_by_stage:
        d = pipeline_by_stage[s]
        pipeline_list.append({"stage": s, "value": int(d["value"]), "count": d["count"]})

growth_list = [
    {"month": month_label(m), "count": growth_by_month[m]["count"], "value": int(growth_by_month[m]["value"])}
    for m in sorted(growth_by_month)
]

output = {
    "generated": date.today().isoformat(),
    "fiscalYear": FISCAL_YEAR,
    "meetingsPerMonth": meetings_list,
    "pipelineByStage": pipeline_list,
    "pipelineGrowth": growth_list,
    "summary": {
        "totalOpenPipelineValue": int(total_pipeline),
        "totalOpenOpportunities": total_open_opps,
        "pipelineAccounts": len(pipeline_acct_ids),
        "ytdMeetings": ytd_meetings,
        "avgMonthlyMeetings": avg_monthly,
    },
}

js_content = (
    "// Auto-generated by refresh.py — do not edit manually\n"
    f"// Last updated: {date.today().isoformat()}\n"
    "window.DASHBOARD_DATA = " + json.dumps(output, indent=2) + ";\n"
)

out_path = os.path.join(SCRIPT_DIR, "data.js")
with open(out_path, "w") as f:
    f.write(js_content)

print(f"\nDone! data.js updated.")
print(f"  Pipeline: ${total_pipeline:,.0f} across {total_open_opps} open deals")
print(f"  YTD meetings: {ytd_meetings}")
print(f"\nTo publish: git add data.js && git commit -m 'refresh: {date.today()}' && git push")
