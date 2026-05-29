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
from datetime import date
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

stages_csv = "'" + "','".join(PIPELINE_STAGES) + "'"

# 1. Open pipeline opps (all time)
raw_opps = soql(
    f"SELECT Id, StageName, Amount, CreatedDate, AccountId "
    f"FROM Opportunity "
    f"WHERE StageName IN ({stages_csv}) "
    f"AND AccountId != null LIMIT 2000"
)
print(f"  Open pipeline opps: {len(raw_opps)}")

# 2. Events this FY
raw_events = soql(
    f"SELECT Id, ActivityDate, AccountId "
    f"FROM Event "
    f"WHERE ActivityDate >= {FISCAL_YEAR}-01-01 AND ActivityDate <= {FISCAL_YEAR}-12-31 "
    f"AND AccountId != null LIMIT 2000"
)
print(f"  Events: {len(raw_events)}")

# ---------------------------------------------------------------------------
# Shape data
# ---------------------------------------------------------------------------

# --- Pipeline by stage ---
stage_totals = defaultdict(lambda: {"value": 0, "count": 0})
for r in raw_opps:
    s = r.get("StageName", "")
    stage_totals[s]["value"] += r.get("Amount") or 0
    stage_totals[s]["count"] += 1

stage_order = ["Qualify", "Explore", "Propose", "Negotiate", "Nurture"]
pipeline_by_stage = [
    {"stage": s, "value": stage_totals[s]["value"], "count": stage_totals[s]["count"]}
    for s in stage_order if s in stage_totals
]

total_pipeline_value = sum(s["value"] for s in pipeline_by_stage)
total_open_opps = sum(s["count"] for s in pipeline_by_stage)

# --- Pipeline growth (new opps added each month this FY, excluding Feb) ---
monthly_new = defaultdict(lambda: {"count": 0, "value": 0})
for r in raw_opps:
    created = (r.get("CreatedDate") or "")[:7]  # YYYY-MM
    if not created.startswith(str(FISCAL_YEAR)):
        continue
    if created == f"{FISCAL_YEAR}-02":
        continue  # exclude Feb (new seller ramp distortion)
    label = date(int(created[:4]), int(created[5:7]), 1).strftime("%b %Y")
    monthly_new[label]["count"] += 1
    monthly_new[label]["value"] += r.get("Amount") or 0

# Sort by calendar order
from calendar import month_abbr
def month_sort_key(label):
    parts = label.split()
    abbrs = list(month_abbr)
    return (int(parts[1]), abbrs.index(parts[0]))

pipeline_growth = [
    {"month": m, "count": monthly_new[m]["count"], "value": monthly_new[m]["value"]}
    for m in sorted(monthly_new.keys(), key=month_sort_key)
]

# --- Meetings per month (past months only, up to current month) ---
current_month = date.today().strftime("%Y-%m")
meetings_by_month = defaultdict(int)
for r in raw_events:
    d = r.get("ActivityDate") or ""
    if d[:7] > current_month:
        continue  # skip future months
    if not d.startswith(str(FISCAL_YEAR)):
        continue
    label = date(int(d[:4]), int(d[5:7]), 1).strftime("%b %Y")
    meetings_by_month[label] += 1

meetings_per_month = [
    {"month": m, "meetings": meetings_by_month[m]}
    for m in sorted(meetings_by_month.keys(), key=month_sort_key)
]

ytd_meetings = sum(m["meetings"] for m in meetings_per_month)
avg_monthly = round(ytd_meetings / len(meetings_per_month), 1) if meetings_per_month else 0

# ---------------------------------------------------------------------------
# Build data.js
# ---------------------------------------------------------------------------
output = {
    "generated": date.today().isoformat(),
    "fiscalYear": FISCAL_YEAR,
    "meetingsPerMonth": meetings_per_month,
    "pipelineByStage": pipeline_by_stage,
    "pipelineGrowth": pipeline_growth,
    "summary": {
        "totalOpenPipelineValue": total_pipeline_value,
        "totalOpenOpportunities": total_open_opps,
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
print(f"  Open pipeline value: ${total_pipeline_value:,.0f}")
print(f"  Open opportunities: {total_open_opps}")
print(f"  YTD meetings: {ytd_meetings}")
print(f"\nTo publish: git add data.js && git commit -m 'refresh: {date.today()}' && git push")
