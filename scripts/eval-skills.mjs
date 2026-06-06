import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const args = parseArgs(process.argv.slice(2));

if (args.report) {
  runReportGate(args.report, args.case ?? "generic");
} else {
  runStaticGate();
}

function runStaticGate() {
  const checks = [
    {
      name: "buyer shortlist skill",
      file: "skills/sg-property-buyer-shortlist/SKILL.md",
      required: [
        /^---[\s\S]*name: sg-property-buyer-shortlist[\s\S]*description:/m,
        "Use external sources",
        "Bedroom count is not in URA private sale transaction rows.",
        "source name and URL",
        "find_private_residential_sale_comparables",
        'output_mode: "summary"',
        "project_summaries",
        "Required Report Structure",
        "Minimum Quality Bar",
        "not valuation advice"
      ]
    },
    {
      name: "buyer shortlist report template",
      file: "skills/sg-property-buyer-shortlist/references/report-template.md",
      required: ["Brief Answer", "Shortlist", "Recommended Next Steps", "Watch-Outs", "Evidence"]
    },
    {
      name: "buyer shortlist source policy",
      file: "skills/sg-property-buyer-shortlist/references/source-policy.md",
      required: ["Transaction Evidence", "External Metadata", "Claim Discipline", "source name + URL"]
    },
    {
      name: "D18 eval case",
      file: "evals/buyer-shortlist/d18-1600k-2200k-900-1200sqft.md",
      required: ["900-1200 sqft", "84-111 sqm", "district: \"18\"", "output_mode: \"summary\"", "project_summaries"]
    },
    {
      name: "D9 eval case",
      file: "evals/buyer-shortlist/d9-3m-freehold-3bed.md",
      required: ["3 bedded freehold", "max budget", "bedroom count is not in URA rows", "sample size"]
    },
    {
      name: "buyer shortlist checklist",
      file: "evals/buyer-shortlist/checklist.md",
      required: ["Query Planning", "Evidence", "Report Quality", "Automatic Minimum Gate", "--report"]
    }
  ];

  const failures = [];
  for (const check of checks) {
    const path = join(ROOT, check.file);
    if (!existsSync(path)) {
      failures.push(`${check.name}: missing ${check.file}`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    for (const item of check.required) {
      if (item instanceof RegExp) {
        if (!item.test(text)) failures.push(`${check.name}: missing pattern ${item}`);
        continue;
      }
      if (!text.includes(item)) failures.push(`${check.name}: missing "${item}"`);
    }
  }
  finish(failures, { mode: "static", checks: checks.length });
}

function runReportGate(reportPath, caseName) {
  const path = join(ROOT, reportPath);
  if (!existsSync(path)) finish([`report missing: ${reportPath}`], { mode: "report", case: caseName });
  const text = readFileSync(path, "utf8");
  const failures = [];
  const lower = text.toLowerCase();

  mustMatch(failures, text, /\bsample size\b|\bsample_size\b|\b\d+\s+(matching\s+)?transactions?\b/i, "missing sample size or transaction count");
  mustMatch(failures, text, /\b(transaction|evidence|data)\s+window\b|\b20\d{2}\b.*\b20\d{2}\b|\b(last|past)\s+\d+\s+(months|years)\b/i, "missing transaction window");
  mustMatch(failures, text, /\bshortlist\b|^\s*\|.*project.*\|/im, "missing shortlist table or shortlist section");
  mustNotMatch(failures, text, /^\s*\{\s*"ok"\s*:/m, "raw JSON dump detected");
  mustMatch(failures, text, /not valuation advice|decision support|not.*valuation/i, "missing valuation caveat");

  if (caseName === "d18" || /sqft|sq ft|square feet/i.test(text)) {
    mustMatch(failures, text, /\b84\s*-\s*111\s*sqm\b|\b83\.?6?\s*-\s*111\.?5?\s*sqm\b|\b900\s*-\s*1200\s*sqft\b.*\bsqm\b/i, "missing sqft-to-sqm conversion");
  }

  if (caseName === "d9" || /bedder|bedroom|3-bed/i.test(lower)) {
    mustMatch(failures, text, /bed(room|der).*not.*URA|URA.*not.*bed(room|der)|layout.*verify|needs verification/i, "missing bedroom/layout caveat");
  }

  const metadataTerms = /(TOP|tenure|freehold|leasehold|MRT|school|developer|bedroom|bedder|layout|floor\s*plan)/i;
  if (metadataTerms.test(text)) {
    const hasUrl = /https?:\/\/\S+/i.test(text);
    const hasNeedsVerification = /needs verification|verify|unverified|not verified/i.test(text);
    if (!hasUrl && !hasNeedsVerification) {
      failures.push("metadata claims need source URL or needs-verification caveat");
    }
  }

  finish(failures, { mode: "report", case: caseName });
}

function mustMatch(failures, text, pattern, message) {
  if (!pattern.test(text)) failures.push(message);
}

function mustNotMatch(failures, text, pattern, message) {
  if (pattern.test(text)) failures.push(message);
}

function finish(failures, meta) {
  if (failures.length > 0) {
    console.error("Skill eval gate failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, ...meta }, null, 2));
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--report") parsed.report = argv[++i];
    else if (arg === "--case") parsed.case = argv[++i];
  }
  return parsed;
}
