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
      name: "client report skill",
      file: "skills/sg-property-client-report/SKILL.md",
      required: [
        /^---[\s\S]*name: sg-property-client-report[\s\S]*description:/m,
        "Buyer brief / shortlist",
        "Project deep dive",
        "Project comparison",
        "find_private_residential_sale_comparables",
        'output_mode: "summary"',
        "project_summaries",
        "Every external project metadata or listing claim must include source name + URL",
        "Ask at most 1-3 focused questions",
        "Do not require every dimension before starting",
        "area-band proxy, not verified bedroom count",
        "layout_turnover_rate",
        "project_turnover_rate",
        "Location and living fit",
        "Unit mix, layout, and stack/site considerations",
        "Active listings and negotiation frame",
        "Who this is suitable for and who should avoid it",
        "not valuation advice"
      ]
    },
    {
      name: "client report template",
      file: "skills/sg-property-client-report/references/report-template.md",
      required: [
        "Executive Answer",
        "Client Brief And Assumptions",
        "Market Map Or Project Snapshot",
        "Location And Living Fit",
        "Unit Mix, Layout, And Stack/Site Considerations",
        "Liquidity And Turnover",
        "Price Evidence",
        "Peer Comparison",
        "Active Listings And Negotiation Frame",
        "Recommendation",
        "Sources And Caveats"
      ]
    },
    {
      name: "client report source map",
      file: "skills/sg-property-client-report/references/source-map.md",
      required: [
        "Transaction Evidence",
        "Project Metadata",
        "Active Listings",
        "Stacked Homes",
        "PropertyGuru",
        "99.co",
        "EdgeProp",
        "SRX",
        "Capture checklist",
        "URL"
      ]
    },
    {
      name: "client report turnover methodology",
      file: "skills/sg-property-client-report/references/turnover-methodology.md",
      required: [
        "layout_turnover_rate",
        "project_turnover_rate",
        "denominator",
        "Do not report layout turnover as exact"
      ]
    },
    {
      name: "client report research patterns",
      file: "skills/sg-property-client-report/references/research-patterns.md",
      required: [
        "Stacked-Style Depth Cues",
        "project facts and full rundown",
        "site plan and stack analysis",
        "pricing analysis against nearby alternatives",
        "who should like it and who should avoid it",
        "First-Principles Client Questions"
      ]
    },
    {
      name: "D18 buyer brief eval case",
      file: "evals/client-report/d18-buyer-brief.md",
      required: [
        "1.6-2.2m",
        "900-1200 sqft",
        "84-111 sqm",
        "output_mode: \"summary\"",
        "project_summaries",
        "watch-outs",
        "recommendation"
      ]
    },
    {
      name: "D'LEEDON client report eval case",
      file: "evals/client-report/dleedon-3bed.md",
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
      name: "D'LEEDON passing sample client report",
      file: "evals/client-report/sample-reports/dleedon-pass.md",
      required: [
        "Recommendation",
        "Transaction window",
        "Sample size",
        "URA rows do not include bedroom count",
        "project turnover proxy",
        "Peer Comparison",
        "Active listing check not completed",
        "Who should avoid",
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

  if (caseName === "client-report") {
    mustMatch(failures, text, /\b(recommendation|shortlist|watch|pass)\b/i, "missing recommendation");
    mustMatch(failures, text, /\b(client brief|assumptions|buyer|investor|self-stay)\b/i, "missing client brief or assumptions");
    mustMatch(failures, text, /\b(location|MRT|commute|school|amenit|living fit)\b/i, "missing location/living-fit discussion");
    mustMatch(failures, text, /\b(unit mix|layout|floor[- ]?plan|stack|site)\b/i, "missing unit/layout/stack/site discussion");
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
    mustMatch(failures, text, /\b(who this suits|who should avoid|suitable for|avoid it|watch-outs|caution)\b/i, "missing suitability/watch-out framing");
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
