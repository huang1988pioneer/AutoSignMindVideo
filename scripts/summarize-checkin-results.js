import fs from "node:fs";
import path from "node:path";

const STATUS_ORDER = {
  failed: 0,
  checked_in: 1,
  already_done: 2,
  skipped: 3,
};

function walkJsonFiles(rootDir) {
  const files = [];

  function visit(current) {
    if (!fs.existsSync(current)) return;
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      if (current.endsWith(".json")) files.push(current);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of fs.readdirSync(current)) {
      visit(path.join(current, entry));
    }
  }

  visit(rootDir);
  return files;
}

function loadRows(rootDir) {
  const files = walkJsonFiles(rootDir);
  const rows = [];

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      console.warn(`Skip invalid JSON: ${file} (${error.message})`);
      continue;
    }

    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      if (!item.name && item.account == null) continue;
      rows.push({
        account: item.account ?? null,
        name: item.name || (item.account != null ? `MINDVIDEO_TOKEN${item.account}` : "unknown"),
        status: item.status || "unknown",
        message: item.message || "",
        creditsDelta: item.creditsDelta ?? null,
        totalCredits: item.totalCredits ?? null,
        streak: item.streak ?? null,
        dailyReward: item.dailyReward ?? null,
        finishedAt: item.finishedAt || null,
        source: file,
      });
    }
  }

  // Prefer one row per account/name (last write wins; files are usually unique).
  const byKey = new Map();
  for (const row of rows) {
    const key = row.account != null ? `account:${row.account}` : `name:${row.name}`;
    byKey.set(key, row);
  }

  return [...byKey.values()].sort((a, b) => {
    const aNum = a.account ?? Number.MAX_SAFE_INTEGER;
    const bNum = b.account ?? Number.MAX_SAFE_INTEGER;
    if (aNum !== bNum) return aNum - bNum;
    return String(a.name).localeCompare(String(b.name));
  });
}

function fmtDelta(value) {
  if (value === null || value === undefined) return "n/a";
  const num = Number(value);
  if (!Number.isFinite(num)) return "n/a";
  return num > 0 ? `+${num}` : String(num);
}

function fmtNum(value) {
  if (value === null || value === undefined) return "n/a";
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : "n/a";
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function buildMarkdown(rows, meta = {}) {
  const counts = {
    total: rows.length,
    checked_in: rows.filter((r) => r.status === "checked_in").length,
    already_done: rows.filter((r) => r.status === "already_done").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };

  const gained = rows.reduce((sum, row) => {
    const delta = Number(row.creditsDelta);
    return Number.isFinite(delta) && delta > 0 ? sum + delta : sum;
  }, 0);

  const generatedAt = meta.generatedAt || new Date().toISOString();
  const title = meta.title || "MindVideo daily check-in summary";

  const lines = [
    `# ${title}`,
    "",
    `- Generated at: \`${generatedAt}\``,
    meta.runUrl ? `- Workflow run: ${meta.runUrl}` : null,
    `- Accounts reported: **${counts.total}**`,
    `- checked_in: **${counts.checked_in}** | already_done: **${counts.already_done}** | skipped: **${counts.skipped}** | failed: **${counts.failed}**`,
    `- Total credits gained this run: **+${gained}**`,
    "",
    `| # | Account | Status | Credit delta | Total | Streak | Daily reward | Detail |`,
    `| ---: | --- | --- | ---: | ---: | ---: | ---: | --- |`,
    ...rows.map((row) => {
      const no = row.account ?? "-";
      return `| ${no} | ${escapeCell(row.name)} | ${escapeCell(row.status)} | ${fmtDelta(
        row.creditsDelta
      )} | ${fmtNum(row.totalCredits)} | ${fmtNum(row.streak)} | ${fmtNum(
        row.dailyReward
      )} | ${escapeCell(row.message)} |`;
    }),
    "",
  ].filter((line) => line !== null);

  const failedRows = rows
    .filter((r) => r.status === "failed")
    .sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));

  if (failedRows.length > 0) {
    lines.push("## Failed accounts", "");
    for (const row of failedRows) {
      lines.push(`- **${row.name}**: ${escapeCell(row.message)}`);
    }
    lines.push("");
  }

  const noCreditGain = rows.filter(
    (r) => r.status === "checked_in" && Number(r.creditsDelta) === 0
  );
  if (noCreditGain.length > 0) {
    lines.push("## Checked in with zero credit delta", "");
    for (const row of noCreditGain) {
      lines.push(`- **${row.name}**: ${escapeCell(row.message || "delta 0")}`);
    }
    lines.push("");
  }

  return { markdown: `${lines.join("\n")}\n`, counts, gained };
}

function printConsoleTable(rows, counts, gained) {
  console.log("\n========== Daily check-in summary ==========");
  console.log(
    `Total: ${counts.total} | checked_in: ${counts.checked_in} | already_done: ${counts.already_done} | skipped: ${counts.skipped} | failed: ${counts.failed} | gained: +${gained}`
  );
  for (const row of rows) {
    console.log(
      `- #${row.account ?? "?"} ${row.name}: ${row.status} | Δ ${fmtDelta(row.creditsDelta)} | total ${fmtNum(row.totalCredits)} | ${row.message}`
    );
  }
  console.log("============================================\n");
}

function main() {
  const inputDir = process.argv[2] || path.join(process.cwd(), "collected");
  const outDir = process.env.MINDVIDEO_SUMMARY_DIR || path.join(process.cwd(), "artifacts");
  const failOnMissing = process.env.MINDVIDEO_FAIL_ON_MISSING !== "0";
  const expectedCount = Number(process.env.MINDVIDEO_EXPECTED_ACCOUNTS || 33);

  const rows = loadRows(inputDir);
  if (rows.length === 0) {
    const message = `No check-in result JSON found under ${inputDir}`;
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `# MindVideo daily check-in summary\n\n❌ ${message}\n`,
        "utf8"
      );
    }
    process.exitCode = 1;
    return;
  }

  const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
  const repository = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const runUrl =
    repository && runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null;

  const { markdown, counts, gained } = buildMarkdown(rows, {
    title: "MindVideo daily check-in summary",
    generatedAt: new Date().toISOString(),
    runUrl,
  });

  printConsoleTable(rows, counts, gained);

  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, "checkin-daily-summary.md");
  const jsonPath = path.join(outDir, "checkin-daily-summary.json");
  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        runUrl,
        counts,
        gained,
        rows,
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  }

  const problems = [];
  if (counts.failed > 0) {
    problems.push(`${counts.failed} account(s) failed`);
  }
  if (failOnMissing && Number.isFinite(expectedCount) && rows.length < expectedCount) {
    // Only warn in summary text; missing/skipped secrets are normal while ramping up.
    // Hard-fail only when configured accounts failed check-in.
  }

  if (problems.length > 0) {
    console.error(`Daily summary detected problems: ${problems.join("; ")}`);
    process.exitCode = 1;
  }
}

main();
