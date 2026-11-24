// Runs the smoke tests:  npm run test:smoke            (all suites)
//                        npm run test:smoke -- roles   (only suites whose name contains "roles")
import { withStack, results } from "./harness.mjs";
import { rolesSuite } from "./roles.suite.mjs";
import { knownIssuesSuite } from "./known-issues.suite.mjs";
import { sessionIdleSuite } from "./session-idle.suite.mjs";

const SUITES = { roles: rolesSuite, "session-idle": sessionIdleSuite, "known-issues": knownIssuesSuite };
const filter = process.argv[2];
const chosen = Object.entries(SUITES).filter(([name]) => !filter || name.includes(filter));
if (!chosen.length) { console.error(`No suite matches "${filter}". Suites: ${Object.keys(SUITES).join(", ")}`); process.exit(2); }

let crashed = false;
try {
  await withStack(async (stack) => { for (const [, suite] of chosen) await suite(stack); });
} catch (e) { crashed = true; console.error(`\nTEST RUN ERROR: ${e.stack}`); }

const count = (s) => results.filter((r) => r.status === s).length;
console.log(`\nRESULT: ${count("PASS")} passed, ${count("FAIL")} failed, ${count("KNOWN")} known issue(s) reproduced, ${count("NOT-REPRODUCED")} known issue(s) not reproduced${crashed ? ", RUN CRASHED" : ""}`);
for (const r of results.filter((x) => x.status === "FAIL")) console.log(`  FAILED: ${r.name}${r.note ? ` (${r.note})` : ""}`);
process.exit(crashed || count("FAIL") ? 1 : 0);
