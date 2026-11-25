#!/usr/bin/env python3
"""Aggregate structured TP-Link Battery Alert compatibility reports."""

import json
import os
import re
import unicodedata
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

REPO = os.environ["GITHUB_REPOSITORY"]
TOKEN = os.environ["GITHUB_TOKEN"]
OWNER = REPO.split("/", 1)[0]
CURRENT_ISSUE = int(os.environ.get("ISSUE_NUMBER", "0") or "0")
ISSUE_ACTION = os.environ.get("ISSUE_ACTION", "")
API_ROOT = "https://api.github.com"
REPORT_MARKER = re.compile(r"<!--\s*tplink-battery-report:v2\s*(.*?)-->", re.DOTALL | re.IGNORECASE)
SUMMARY_MARKER = "<!-- tplink-compatibility-summary -->"
LABELS = {
    "compatibility-report": ("1D76DB", "Structured compatibility report"),
    "needs-review": ("D93F0B", "Conflicting evidence; manual review needed"),
    "exclude-from-count": ("BFD4F2", "Exclude this report from automatic counts"),
    "community/likely-supported": ("0E8A16", "One reporter confirmed battery read"),
    "community/supported": ("006B2E", "At least two reporters confirmed battery read"),
    "community/likely-unsupported": ("FBCA04", "One reporter confirmed protocol mismatch"),
    "community/unsupported": ("B60205", "At least two reporters confirmed protocol mismatch"),
    "community/disputed": ("5319E7", "Conflicting community evidence"),
}

def api(method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(API_ROOT + path, data=data, method=method, headers={
        "Authorization": "Bearer " + TOKEN, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "TPLink-Battery-Alert-aggregator",
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            body = response.read()
            return json.loads(body.decode("utf-8")) if body else None
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"GitHub API {method} {path}: HTTP {error.code}: {error.read().decode('utf-8','replace')}") from error

def norm(value):
    return unicodedata.normalize("NFKC", str(value or "")).strip().casefold()

def parse_report(issue):
    match = REPORT_MARKER.search(issue.get("body") or "")
    if not match:
        return None
    fields = {}
    for line in match.group(1).splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            fields[key.strip().lower()] = value.strip()
    result = fields.get("result", "")
    if result not in {"LIVE_SUCCESS", "PROTOCOL_MISMATCH"}:
        return None
    model = fields.get("model", "").strip()
    hardware = fields.get("hardware", "").strip() or "לא דווחה"
    firmware = fields.get("firmware", "").strip() or "לא דווחה"
    if not model or norm(model).startswith(("לא זוהה", "לא דווח", "unknown")):
        return None
    if result == "PROTOCOL_MISMATCH" and fields.get("preconditions_confirmed", "").lower() != "true":
        return None
    author = ((issue.get("user") or {}).get("login") or "").strip()
    if not author or author.casefold().endswith("[bot]"):
        return None
    return {
        "number": issue["number"], "url": issue.get("html_url", ""),
        "author": norm(author), "outcome": "positive" if result == "LIVE_SUCCESS" else "negative",
        "model": model, "hardware": hardware, "firmware": firmware,
        "notification": fields.get("notification_result", "NOT_APPLICABLE"),
        "key": (norm(model), norm(hardware), norm(firmware)),
    }

def get_all_issues():
    all_rows = []
    for page in range(1, 101):
        batch = api("GET", f"/repos/{REPO}/issues?state=all&per_page=100&page={page}")
        if not batch:
            break
        all_rows.extend(row for row in batch if "pull_request" not in row)
        if len(batch) < 100:
            break
    return all_rows

def aggregate(group):
    per_user = defaultdict(set)
    for row in group:
        per_user[row["author"]].add(row["outcome"])
    conflicts = {user for user, values in per_user.items() if len(values) > 1}
    positive = {user for user, values in per_user.items() if values == {"positive"}} - conflicts
    negative = {user for user, values in per_user.items() if values == {"negative"}} - conflicts
    if conflicts or (positive and negative):
        status = "disputed"
    elif len(positive) >= 2:
        status = "supported"
    elif len(positive) == 1:
        status = "likely-supported"
    elif len(negative) >= 2:
        status = "unsupported"
    elif len(negative) == 1:
        status = "likely-unsupported"
    else:
        status = "disputed"
    return status, positive, negative, conflicts

def md(value):
    return str(value or "").replace("|", r"\|").replace("\n", " ").replace("\r", " ")

def ensure_labels():
    names = {row["name"] for row in api("GET", f"/repos/{REPO}/labels?per_page=100")}
    for name, (color, description) in LABELS.items():
        if name not in names:
            try:
                api("POST", f"/repos/{REPO}/labels", {"name": name, "color": color, "description": description})
            except RuntimeError as error:
                if "HTTP 422" not in str(error):
                    raise

def set_labels(issue, status):
    old = [label["name"] for label in issue.get("labels", [])]
    new = [name for name in old if not name.startswith("community/") and
           name not in {"compatibility-report", "needs-review"}]
    new.extend(["compatibility-report", "community/" + status])
    if status == "disputed":
        new.append("needs-review")
    new = list(dict.fromkeys(new))
    if set(old) != set(new):
        api("PUT", f"/repos/{REPO}/issues/{issue['number']}/labels", {"labels": new})

def upsert_comment(number, body):
    comments = api("GET", f"/repos/{REPO}/issues/{number}/comments?per_page=100")
    existing = next((c for c in comments if SUMMARY_MARKER in (c.get("body") or "")), None)
    if existing:
        if existing.get("body") != body:
            api("PATCH", f"/repos/{REPO}/issues/comments/{existing['id']}", {"body": body})
    else:
        api("POST", f"/repos/{REPO}/issues/{number}/comments", {"body": body})

def notify_owner(issue):
    if ISSUE_ACTION not in {"opened", "reopened"}:
        return
    assignees = {norm(a.get("login")) for a in issue.get("assignees", [])}
    reporter = norm((issue.get("user") or {}).get("login"))
    if norm(OWNER) in assignees or reporter == norm(OWNER):
        return
    try:
        api("POST", f"/repos/{REPO}/issues/{issue['number']}/assignees", {"assignees": [OWNER]})
    except RuntimeError as error:
        print(f"Owner assignment for issue #{issue['number']} failed: {error}")

def main():
    ensure_labels()
    issues = get_all_issues()
    issue_map = {row["number"]: row for row in issues}
    reports = []
    for issue in issues:
        parsed = parse_report(issue)
        if parsed and "exclude-from-count" not in {label["name"] for label in issue.get("labels", [])}:
            parsed["issue"] = issue
            reports.append(parsed)
    groups = defaultdict(list)
    for row in reports:
        groups[row["key"]].append(row)

    hebrew = {
        "likely-supported": "כנראה נתמך", "supported": "נתמך",
        "likely-unsupported": "כנראה לא נתמך", "unsupported": "לא נתמך",
        "disputed": "במחלוקת – דרושה בדיקה",
    }
    notif_labels = {
        "RECEIVED": "התקבלה", "NOT_REACHED": "הסוללה לא הגיעה לסף",
        "NOT_RECEIVED": "לא התקבלה",
    }
    result_rows = []
    for group in groups.values():
        status, positives, negatives, conflicts = aggregate(group)
        example = group[0]
        issue_numbers = sorted({row["number"] for row in group})
        notification_users = defaultdict(set)
        for row in group:
            if row["outcome"] == "positive" and row["notification"] in notif_labels:
                notification_users[row["notification"]].add(row["author"])
        notification_counts = {key: len(notification_users[key]) for key in notif_labels}
        summary_row = {
            "model": example["model"], "hardware_version": example["hardware"],
            "firmware_version": example["firmware"], "status": status,
            "status_he": hebrew[status], "positive_reporters": len(positives),
            "negative_reporters": len(negatives), "self_conflicting_reporters": len(conflicts),
            "report_count": len(group), "issue_numbers": issue_numbers,
            "notification_reporters": notification_counts,
        }
        result_rows.append(summary_row)
        issue_links = ", ".join(
            f"[#{number}]({issue_map[number].get('html_url', '')})" for number in issue_numbers
        )
        notification_text = "; ".join(
            f"{notif_labels[key]}: {count}" for key, count in notification_counts.items() if count
        ) or "אין עדיין דיווחי התראה"
        comment = (
            SUMMARY_MARKER + "\n"
            + f"**סטטוס קהילתי: {hebrew[status]}**\n\n"
            + f"- דיווחי הצלחה ממשתמשים שונים: {len(positives)}\n"
            + f"- דיווחי אי-התאמה ממשתמשים שונים: {len(negatives)}\n"
            + f"- משתמשים עם דיווחים סותרים משל עצמם: {len(conflicts)}\n"
            + f"- תוצאות התראות בנפרד מתאימות הנתב: {notification_text}\n"
            + f"- דיווחים קשורים: {issue_links}\n\n"
            + "הספירה היא לפי חשבונות GitHub שונים ולפי דגם + חומרה + קושחה. "
              "סתירה מסומנת במחלוקת ואינה מוכרעת לפי רוב. התראת Android שלא הופיעה "
              "אינה נחשבת לכישלון תאימות של הנתב."
        )
        for row in group:
            set_labels(row["issue"], status)
            upsert_comment(row["number"], comment)

    result_rows.sort(key=lambda row: (norm(row["model"]), norm(row["hardware_version"]), norm(row["firmware_version"])))
    updated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    data = {
        "schema_version": 2, "updated_at": updated,
        "aggregation_rule": "unique GitHub accounts per exact model + hardware + firmware; conflicting results become disputed",
        "routers": result_rows,
    }
    Path("data").mkdir(parents=True, exist_ok=True)
    Path("data/community_compatibility.json").write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# TP-Link Battery Alert – Community compatibility reports", "",
        f"_Automatically updated: {updated}_", "",
        "Community observations are separate from independently verified technical evidence.",
        "The key is exact model + hardware revision + firmware. Repeated reports from one account count once.",
        "Conflicting positive and negative results, including self-contradictions, are disputed and never decided by majority.",
        "Android battery notification delivery is a separate dimension and cannot change router protocol support.", "",
        "| Model | Hardware | Firmware | Status | Success users | Mismatch users | Notification results | Reports |",
        "| --- | --- | --- | --- | ---: | ---: | --- | --- |",
    ]
    if not result_rows:
        lines.append("| _No reports yet_ | — | — | Not checked | 0 | 0 | — | — |")
    for row in result_rows:
        counts = row["notification_reporters"]
        notif = f"Received: {counts['RECEIVED']}; not reached: {counts['NOT_REACHED']}; missing: {counts['NOT_RECEIVED']}"
        links = ", ".join(f"[#{number}](https://github.com/{REPO}/issues/{number})" for number in row["issue_numbers"])
        lines.append(
            f"| {md(row['model'])} | {md(row['hardware_version'])} | {md(row['firmware_version'])} | "
            f"**{row['status_he']}** | {row['positive_reporters']} | {row['negative_reporters']} | {md(notif)} | {links} |"
        )
    lines.extend([
        "", "## Status definitions", "",
        "- Likely supported / likely unsupported: one distinct GitHub account.",
        "- Supported / unsupported: at least two distinct GitHub accounts with the same result.",
        "- Disputed: conflicting outcomes, including contradictory reports by the same account. No majority override.",
        "- Only confirmed protocol mismatch reports count as negative; password and network errors do not.",
        "- Android notification delivery is counted separately.",
        "- Add the exclude-from-count label to exclude a report from automatic aggregation.",
        "", f"Raw reports: [GitHub Issues](https://github.com/{REPO}/issues?q=is%3Aissue+label%3Acompatibility-report).",
    ])
    Path("COMMUNITY_COMPATIBILITY.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    current = issue_map.get(CURRENT_ISSUE)
    if current:
        notify_owner(current)
    print(f"Processed {len(reports)} reports across {len(result_rows)} router/version groups.")

if __name__ == "__main__":
    main()
