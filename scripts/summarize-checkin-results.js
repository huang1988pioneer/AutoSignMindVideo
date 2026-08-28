import fs from "node:fs";
import path from "node:path";
import { getSecretName, isAccountEnabled, loadAccountConfig } from "./account-config.mjs";

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

function accountNumberFromName(name) {
  const match = String(name || "").match(/MINDVIDEO_TOKEN(\d+)/i);
  return match ? Number(match[1]) : null;
}

function loadRows(rootDir, config) {
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
      const explicitAccount = item.account == null ? null : Number(item.account);
      const inferredAccount = accountNumberFromName(item.name);
      const account = Number.isInteger(explicitAccount)
        ? explicitAccount
        : inferredAccount;
      if (account != null && Number.isFinite(account) && !isAccountEnabled(config, account)) {
        continue;
      }
      rows.push({
        account: account != null && Number.isFinite(account) ? account : null,
        name: item.name || (account != null ? `MINDVIDEO_TOKEN${account}` : "unknown"),
        label: item.label || null,
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
  if (value === null || value === undefined) return "—";
  const num = Number(value);
  if (!Number.isFinite(num)) return "—";
  return num > 0 ? `+${num}` : String(num);
}

function fmtNum(value) {
  if (value === null || value === undefined) return "—";
  const num = Number(value);
  return Number.isFinite(num) ? String(num) : "—";
}

function escapeCell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function shortLabel(row) {
  const num = row.account;
  const label = row.label || String(row.name || "").replace(/^MINDVIDEO_TOKEN\d+$/i, "").trim() || null;

  if (num != null && label) return `checkin-${num}-${label}`;
  if (num != null) return `checkin-${num}`;
  if (label) return label;
  return String(row.name || "").replace(/^MINDVIDEO_TOKEN/i, "token").trim();
}

function compactMessage(message, max = 120) {
  const text = String(message || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "—";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function statusBadge(status) {
  switch (status) {
    case "checked_in":
      return "✅ checked_in";
    case "already_done":
      return "☑️ already_done";
    case "failed":
      return "❌ failed";
    case "skipped":
      return "⏭️ skipped";
    default:
      return `❔ ${status || "unknown"}`;
  }
}

function noteForRow(row) {
  if (row.status === "checked_in") {
    const delta = Number(row.creditsDelta);
    if (Number.isFinite(delta) && delta > 0) return `new today (+${delta})`;
    return "new today";
  }
  if (row.status === "already_done") return "claimed earlier";
  if (row.status === "skipped") return compactMessage(row.message || "token not configured", 80);
  if (row.status === "failed") return compactMessage(row.message || "failed", 80);
  return compactMessage(row.message, 80);
}

function rewardForRow(row) {
  // Prefer actual credits gained this run; fall back to daily reward tier.
  const delta = Number(row.creditsDelta);
  if (Number.isFinite(delta) && delta > 0) return `+${delta}`;
  const daily = Number(row.dailyReward);
  if (Number.isFinite(daily) && daily > 0) return `+${daily}`;
  return "—";
}

function buildMarkdown(rows, meta = {}) {
  const counts = {
    total: rows.length,
    checked_in: rows.filter((r) => r.status === "checked_in").length,
    already_done: rows.filter((r) => r.status === "already_done").length,
    skipped: rows.filter((r) => r.status === "skipped").length,
    failed: rows.filter((r) => r.status === "failed").length,
  };

  const configured = counts.checked_in + counts.already_done + counts.failed;
  const ok = counts.checked_in + counts.already_done;

  const gained = rows.reduce((sum, row) => {
    const delta = Number(row.creditsDelta);
    return Number.isFinite(delta) && delta > 0 ? sum + delta : sum;
  }, 0);

  const generatedAt = meta.generatedAt || new Date().toISOString();
  const title = meta.title || "MindVideo daily check-in";
  const secretHint = meta.secretHint || "the enabled MINDVIDEO_TOKEN secrets";

  const accountNums = rows
    .map((r) => r.account)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  const accountMin = accountNums[0] ?? 1;
  const accountMax = accountNums[accountNums.length - 1] ?? counts.total;

  const headline =
    counts.failed === 0 && configured > 0
      ? "✅ All configured accounts OK"
      : counts.failed > 0
        ? `⚠️ ${counts.failed} account(s) need attention`
        : "⚠️ No configured accounts";

  const streakRows = rows.filter(
    (r) => r.status !== "skipped" && Number.isFinite(Number(r.streak))
  );
  const streakValues = streakRows.map((r) => Number(r.streak));
  const maxStreak = streakValues.length ? Math.max(...streakValues) : null;
  const avgStreak =
    streakValues.length > 0
      ? Math.round((streakValues.reduce((a, b) => a + b, 0) / streakValues.length) * 10) / 10
      : null;
  const maxStreakAccounts = streakRows
    .filter((r) => Number(r.streak) === maxStreak)
    .map((r) => shortLabel(r));

  const lines = [
    `## ${title}`,
    "",
    `**${headline}**`,
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| Configured (ran) | ${configured} |`,
    `| New check-in | ${counts.checked_in} |`,
    `| Already done | ${counts.already_done} |`,
    `| OK total | ${ok} |`,
    `| Failed | ${counts.failed} |`,
    `| Skipped (no secret) | ${counts.skipped} |`,
    `| Credits gained this run | +${gained} |`,
    `| Accounts with streak | ${streakRows.length} |`,
    maxStreak !== null ? `| Max continuous days | ${maxStreak} |` : null,
    avgStreak !== null ? `| Avg continuous days | ${avgStreak} |` : null,
    "",
    meta.runUrl ? `- Workflow run: ${meta.runUrl}` : null,
    maxStreak !== null && maxStreakAccounts.length
      ? `- Longest streak: **${maxStreak} day(s)** — ${maxStreakAccounts.join(", ")}`
      : null,
    `<sub>${meta.expectedCount ?? counts.total} enabled account(s) · slots ${accountMin}–${accountMax} · ${generatedAt}</sub>`,
    "",
  ].filter((line) => line !== null);

  const failedRows = rows
    .filter((r) => r.status === "failed")
    .sort((a, b) => (a.account ?? 9999) - (b.account ?? 9999));

  if (failedRows.length > 0) {
    lines.push("### ⚠️ Needs attention", "");
    lines.push("| # | Account | Error |");
    lines.push("| ---: | --- | --- |");
    for (const row of failedRows) {
      const no = row.account ?? "—";
      lines.push(
        `| ${no} | ${escapeCell(shortLabel(row))} | ${escapeCell(
          compactMessage(row.message || "failed", 160)
        )} |`
      );
    }
    lines.push("");
  }

  const activeRows = rows.filter((r) => r.status !== "skipped");
  if (activeRows.length > 0) {
    lines.push("### Account results", "");
    lines.push("| # | Account | Status | Reward | Total | Streak | Note |");
    lines.push("| ---: | --- | --- | ---: | ---: | ---: | --- |");

    for (const row of activeRows) {
      const no = row.account ?? "—";
      lines.push(
        `| ${no} | ${escapeCell(shortLabel(row))} | ${statusBadge(
          row.status
        )} | ${rewardForRow(row)} | ${fmtNum(row.totalCredits)} | ${fmtNum(
          row.streak
        )} | ${escapeCell(noteForRow(row))} |`
      );
    }
    lines.push("");
  }

  // Dedicated continuous-check-in ledger (every configured account).
  if (activeRows.length > 0) {
    lines.push("### 連續簽到天數", "");
    lines.push("| # | Account | Continuous days | Status |");
    lines.push("| ---: | --- | ---: | --- |");
    const byStreak = [...activeRows].sort((a, b) => {
      const sa = Number.isFinite(Number(a.streak)) ? Number(a.streak) : -1;
      const sb = Number.isFinite(Number(b.streak)) ? Number(b.streak) : -1;
      if (sb !== sa) return sb - sa;
      return (a.account ?? 9999) - (b.account ?? 9999);
    });
    for (const row of byStreak) {
      const no = row.account ?? "—";
      lines.push(
        `| ${no} | ${escapeCell(shortLabel(row))} | ${fmtNum(row.streak)} | ${statusBadge(
          row.status
        )} |`
      );
    }
    lines.push("");
  }

  const skippedRows = rows
    .filter((r) => r.status === "skipped")
    .sort((a, b) => (a.account ?? 9999) - (b.account ?? 9999));

  if (skippedRows.length > 0) {
    const ids = skippedRows.map((r) => r.account ?? shortLabel(r)).join(", ");
    lines.push("### Skipped", "");
    lines.push(`No secret / token: **#${ids}**`, "");
  }

  if (configured === 0) {
    lines.push(
      "### Next step",
      "",
      `Add the enabled GitHub Secrets ${secretHint} (or local \`.env\`) before the next run.`,
      ""
    );
  }

  const zeroGain = rows.filter(
    (r) => r.status === "checked_in" && Number(r.creditsDelta) === 0
  );
  if (zeroGain.length > 0) {
    lines.push("### Checked in with zero credit delta", "");
    for (const row of zeroGain) {
      lines.push(`- **${escapeCell(shortLabel(row))}**: ${escapeCell(row.message || "delta 0")}`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "<sub>Status: `checked_in` = claimed this run · `already_done` = already claimed today · `failed` = token/API issue · `skipped` = secret not configured</sub>",
    ""
  );

  return { markdown: `${lines.join("\n")}\n`, counts, gained, configured, ok };
}

function printConsoleTable(rows, counts, gained) {
  const configured = counts.checked_in + counts.already_done + counts.failed;
  console.log("\n========== Daily check-in summary ==========");
  console.log(
    `Configured: ${configured} | checked_in: ${counts.checked_in} | already_done: ${counts.already_done} | skipped: ${counts.skipped} | failed: ${counts.failed} | gained: +${gained}`
  );
  for (const row of rows) {
    console.log(
      `- #${row.account ?? "?"} ${shortLabel(row)}: ${row.status} | Δ ${fmtDelta(
        row.creditsDelta
      )} | total ${fmtNum(row.totalCredits)} | streak ${fmtNum(row.streak)} | ${noteForRow(row)}`
    );
  }
  console.log("============================================\n");
}

function main() {
  const inputDir = process.argv[2] || path.join(process.cwd(), "collected");
  const outDir = process.env.MINDVIDEO_SUMMARY_DIR || path.join(process.cwd(), "artifacts");
  const failOnMissing = process.env.MINDVIDEO_FAIL_ON_MISSING !== "0";
  const config = loadAccountConfig();
  const configuredExpected = process.env.MINDVIDEO_EXPECTED_ACCOUNTS?.trim();
  const expectedCount = configuredExpected ? Number(configuredExpected) : config.accounts.length;

  const rows = loadRows(inputDir, config);
  if (rows.length === 0) {
    const message = `No check-in result JSON found under ${inputDir}`;
    console.error(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## MindVideo daily check-in\n\n❌ ${message}\n`,
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

  const generatedAt = new Date().toISOString();
  const { markdown, counts, gained } = buildMarkdown(rows, {
    title: "MindVideo daily check-in",
    generatedAt,
    runUrl,
    expectedCount,
    secretHint: config.accounts.map((account) => `\`${getSecretName(account.number)}\``).join(", "),
  });

  printConsoleTable(rows, counts, gained);

  // Always print markdown block for log searchability (matches LitMedia style).
  console.log("----- GITHUB SUMMARY (markdown) -----");
  console.log(markdown);
  console.log("----- END GITHUB SUMMARY -----");

  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, "checkin-daily-summary.md");
  const jsonPath = path.join(outDir, "checkin-daily-summary.json");
  const streaksPath = path.join(outDir, "checkin-streaks.json");

  const streakLedger = {
    generatedAt,
    runUrl,
    title: "MindVideo continuous check-in days",
    accounts: rows
      .map((row) => ({
        account: row.account ?? null,
        name: row.name,
        label: row.label,
        status: row.status,
        streak: row.streak ?? null,
        totalCredits: row.totalCredits ?? null,
        finishedAt: row.finishedAt || null,
      }))
      .sort((a, b) => {
        const an = a.account ?? Number.MAX_SAFE_INTEGER;
        const bn = b.account ?? Number.MAX_SAFE_INTEGER;
        return an - bn;
      }),
  };

  const streakNums = streakLedger.accounts
    .map((a) => Number(a.streak))
    .filter((n) => Number.isFinite(n));
  streakLedger.summary = {
    recorded: streakNums.length,
    max: streakNums.length ? Math.max(...streakNums) : null,
    min: streakNums.length ? Math.min(...streakNums) : null,
    average:
      streakNums.length > 0
        ? Math.round((streakNums.reduce((s, n) => s + n, 0) / streakNums.length) * 10) / 10
        : null,
  };

  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        generatedAt,
        runUrl,
        counts,
        gained,
        rows,
        streakSummary: streakLedger.summary,
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  fs.writeFileSync(streaksPath, `${JSON.stringify(streakLedger, null, 2)}\n`, "utf8");

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${streaksPath}`);
  if (streakLedger.summary.recorded > 0) {
    console.log(
      `Streak ledger: ${streakLedger.summary.recorded} account(s) · max ${streakLedger.summary.max} · avg ${streakLedger.summary.average}`
    );
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown, "utf8");
  }

  const problems = [];
  if (counts.failed > 0) {
    problems.push(`${counts.failed} account(s) failed`);
  }
  if (failOnMissing && Number.isFinite(expectedCount) && rows.length < expectedCount) {
    problems.push(`${expectedCount - rows.length} account result(s) missing`);
  }

  if (problems.length > 0) {
    console.error(`Daily summary detected problems: ${problems.join("; ")}`);
    process.exitCode = 1;
  }
}

main();
