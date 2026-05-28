#!/usr/bin/env python3
"""
refresh.py — Re-pulls Salesforce data via Composio and rewrites data.js.
Run this script whenever you want to update the dashboard with fresh data.

Requirements:
    pip install composio-core composio-openai python-dotenv

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
    from composio_openai import ComposioToolSet, App
except ImportError:
    print("ERROR: composio-openai not installed. Run: pip install composio-openai")
    sys.exit(1)

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
FISCAL_YEAR = date.today().year
FY_START = f"{FISCAL_YEAR}-01-01T00:00:00Z"
FY_END   = f"{FISCAL_YEAR}-12-31T23:59:59Z"

PRESALE_STAGES = {"Qualify", "Explore", "Active", "Propose", "Negotiate", "Demo Platform Configuration"}
MEETING_KEYWORDS = ["meeting", "call", "demo", "intro", "discovery", "catch-up", "check-in", "connect", "sync"]

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

# 1. Pre-sale account IDs (accounts with open pipeline)
stage_list = "', '".join(PRESALE_STAGES)
presale_rows = soql(
    f"SELECT AccountId FROM Opportunity "
    f"WHERE StageName IN ('{stage_list}') AND AccountId != null LIMIT 2000"
)
presale_acct_ids = {r["AccountId"] for r in presale_rows if r.get("AccountId")}
print(f"  Pre-sale accounts: {len(presale_acct_ids)}")

# 2. Opportunities this fiscal year
opps = soql(
    f"SELECT Id, Name, StageName, Amount, CloseDate, CreatedDate, AccountId, Account.Name "
    f"FROM Opportunity "
    f"WHERE CreatedDate >= {FY_START} "
    f"ORDER BY CreatedDate ASC LIMIT 2000"
)
print(f"  Opportunities (FY{FISCAL_YEAR}): {len(opps)}")

# 3. Events this fiscal year
events = soql(
    f"SELECT Id, Subject, ActivityDate, AccountId, Account.Name, OwnerId "
    f"FROM Event "
    f"WHERE ActivityDate >= {FISCAL_YEAR}-01-01 AND ActivityDate <= {FISCAL_YEAR}-12-31 LIMIT 2000"
)
print(f"  Events: {len(events)}")

# ---------------------------------------------------------------------------
# Compute metrics
# ---------------------------------------------------------------------------
# Meetings per month — events linked to pre-sale accounts
meetings_by_month: dict[str, int] = defaultdict(int)
for e in events:
    if e.get("AccountId") in presale_acct_ids:
        d = e.get("ActivityDate", "")
        if d:
            meetings_by_month[d[:7]] += 1

# Pipeline by stage (open opps with amount)
pipeline_by_stage: dict[str, dict] = {}
for s in PRESALE_STAGES:
    pipeline_by_stage[s] = {"stage": s, "value": 0.0, "count": 0}

for o in opps:
    stage = o.get("StageName", "")
    if stage in PRESALE_STAGES:
        pipeline_by_stage[stage]["count"] += 1
        pipeline_by_stage[stage]["value"] += o.get("Amount") or 0.0

# Remove stages with no opps
pipeline_by_stage = {k: v for k, v in pipeline_by_stage.items() if v["count"] > 0}

# Pipeline growth — new opps per month
growth_by_month: dict[str, dict] = defaultdict(lambda: {"count": 0, "value": 0.0})
for o in opps:
    month = (o.get("CreatedDate") or "")[:7]
    if month:
        growth_by_month[month]["count"] += 1
        growth_by_month[month]["value"] += o.get("Amount") or 0.0

# Summaries
total_pipeline = sum(v["value"] for v in pipeline_by_stage.values())
total_open_opps = sum(v["count"] for v in pipeline_by_stage.values())
ytd_meetings = sum(meetings_by_month.values())
months_with_meetings = len([v for v in meetings_by_month.values() if v > 0])
avg_monthly = round(ytd_meetings / months_with_meetings, 1) if months_with_meetings else 0

# ---------------------------------------------------------------------------
# Build data.js
# ---------------------------------------------------------------------------
STAGE_ORDER = ["Qualify", "Explore", "Active", "Propose", "Negotiate", "Demo Platform Configuration"]

months_sorted = sorted(meetings_by_month.keys())

def month_label(ym: str) -> str:
    """'2026-03' -> 'Mar 2026'"""
    dt = datetime.strptime(ym, "%Y-%m")
    return dt.strftime("%b %Y")

meetings_list = [
    {"month": month_label(m), "meetings": meetings_by_month[m]}
    for m in months_sorted
]

pipeline_list = []
for s in STAGE_ORDER:
    if s in pipeline_by_stage:
        d = pipeline_by_stage[s]
        label = "Demo Config" if s == "Demo Platform Configuration" else s
        pipeline_list.append({"stage": label, "value": int(d["value"]), "count": d["count"]})

growth_list = [
    {"month": month_label(m), "count": growth_by_month[m]["count"], "value": int(growth_by_month[m]["value"])}
    for m in sorted(growth_by_month.keys())
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
        "presaleAccounts": len(presale_acct_ids),
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
print(f"  YTD meetings (pre-sale): {ytd_meetings}")
print(f"\nTo publish: git add data.js && git commit -m 'refresh: {date.today()}' && git push")
