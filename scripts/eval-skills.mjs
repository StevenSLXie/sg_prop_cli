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
        "Clarifying Questions",
        "Ask at most 1-3 focused questions",
        "Do not require every input dimension",
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
    },
    {
      name: "incomplete input eval case",
      file: "evals/buyer-shortlist/incomplete-input-clarify.md",
      required: ["Ask a small number of clarifying questions", "Do not ask for every possible dimension", "budget", "location"]
    },
    {
      name: "project deep dive skill",
      file: "skills/sg-property-project-deep-dive/SKILL.md",
      required: [
        /^---[\s\S]*name: sg-property-project-deep-dive[\s\S]*description:/m,
        "find_private_residential_sale_comparables",
        "Unit mix and bedroom count",
        "Every external project metadata or listing claim must include source name + URL",
        "Ask at most 1-3 focused questions",
        "layout_turnover_rate",
        "project_turnover_rate",
        "area-band proxy, not verified bedroom count",
        "Do not present turnover as precise if the denominator is estimated.",
        "Price Trend And Peer Comparison",
        "Active Listing Check",
        "Required Report Structure",
        "not valuation advice"
      ]
    },
    {
      name: "project deep dive report template",
      file: "skills/sg-property-project-deep-dive/references/report-template.md",
      required: [
        "Executive Answer",
        "Project Snapshot",
        "Target Layout Supply And Liquidity",
        "Price Evidence",
        "Peer Comparison",
        "Active Listings",
        "Sources And Caveats"
      ]
    },
    {
      name: "project deep dive source map",
      file: "skills/sg-property-project-deep-dive/references/source-map.md",
      required: [
        "Transaction Evidence",
        "Project Metadata",
        "Active Listings",
        "PropertyGuru",
        "99.co",
        "EdgeProp",
        "SRX",
        "Capture checklist",
        "URL"
      ]
    },
    {
      name: "project turnover methodology",
      file: "skills/sg-property-project-deep-dive/references/turnover-methodology.md",
      required: [
        "layout_turnover_rate",
        "project_turnover_rate",
        "denominator",
        "Do not report layout turnover as exact"
      ]
    },
    {
      name: "D'LEEDON project deep dive eval case",
      file: "evals/project-deep-dive/dleedon-3bed.md",
      required: [
        "D'LEEDON",
        "3-bedder",
        "liquidity",
        "past-year price trend",
        "comparable nearby projects",
        "current asking prices"
      ]
    },
    {
      name: "D'LEEDON passing sample report",
      file: "evals/project-deep-dive/sample-reports/dleedon-pass.md",
      required: [
        "Recommendation",
        "Transaction window",
        "Sample size",
        "URA rows do not include bedroom count",
        "project turnover proxy",
        "Peer Comparison",
        "Active listing check not completed",
        "not valuation advice"
      ]
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

  if (caseName === "project-deep-dive") {
    mustMatch(failures, text, /\b(recommendation|shortlist|watch|pass)\b/i, "missing recommendation");
    mustMatch(failures, text, /\b(liquidity|turnover)\b/i, "missing liquidity or turnover analysis");
    mustMatch(failures, text, /\b(layout_turnover_rate|project_turnover_rate|turnover proxy|project turnover proxy|layout turnover)\b/i, "missing turnover method or proxy");
    mustMatch(failures, text, /\bdenominator\b|\btotal units\b|\bunit count\b|\bunit-mix\b|\bunit mix\b/i, "missing turnover denominator discussion");
    mustMatch(failures, text, /\b\d+(\.\d+)?\s*%\b|turnover cannot be calculated|cannot calculate.*turnover|cannot compute.*turnover/i, "missing numeric turnover or explicit cannot-calculate statement");
    mustMatch(failures, text, /\b(latest|last|past|prior)\s+12\s+months\b|\b12-month\b/i, "missing 12-month trend framing");
    mustMatch(failures, text, /\bmedian\b.*\bpsf\b|\bpsf\b.*\bmedian\b/i, "missing median PSF evidence");
    mustMatch(failures, text, /\b(peer|comparable|comparison)\b/i, "missing peer comparison");
    mustMatch(failures, text, /\b(active listing|asking price|listing check)\b/i, "missing active listing check");
    mustMatch(failures, text, /https?:\/\/\S+/i, "missing at least one external source URL");
    mustMatch(failures, text, /source|https?:\/\/|needs verification/i, "missing source or needs-verification discipline");
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
