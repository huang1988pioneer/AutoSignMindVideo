# MindVideo Auto Sign

This signs in to MindVideo once per day using the same API as the website.

## Windows desktop app (Avalonia)

The repository includes a Windows-first Avalonia desktop app modeled after
[Musicful Flow](https://github.com/huang1988pioneer/AutoSignMusicful)
(`MusicfulFlow`). It has three views:

1. **簽到總覽** — trigger `mindvideo-daily-checkin.yml`, refresh the latest
   GitHub Actions run, and list each account’s status / streak.
2. **帳號設定** — local aliases for the enabled `MINDVIDEO_TOKEN*` secrets.
   Enabled accounts are defined once in `accounts.json`; the catalog is the
   source of truth for the active Secret slot numbers.
3. **更新登入狀態** — capture a Bearer token in the browser, paste a token,
   save it locally, push it to a GitHub Secret, and run a direct status check
   or check-in against the MindVideo API.

```powershell
dotnet run --project .\src\MindVideoAutoSign\MindVideoAutoSign.csproj
```

For the GitHub Actions dashboard and secret updates, install the GitHub CLI
and authenticate once:

```powershell
gh auth login
```

Local tokens are stored only at
`%LOCALAPPDATA%\MindVideo Auto Sign\accounts.json`. Aliases are stored under
`%APPDATA%\MindVideoFlow\account-aliases.json`. Neither is written back into
this repository.

Browser capture uses `scripts/capture-token-gui.mjs` (auto-detects the token
after you log in; no terminal Enter step).

## Setup

1. Copy `.env.example` to `.env`.
2. Paste your MindVideo token into `MINDVIDEO_TOKEN1`.
   For more enabled accounts, use the numbers listed in `accounts.json`.
3. Run:

```sh
npm run checkin
```

## API Used

- `GET https://api-app.mindvideo.ai/api/checkin/records`
- `POST https://api-app.mindvideo.ai/api/checkin`
- `GET https://api-app.mindvideo.ai/api/user/credits/stats` (logging / verification)

Required headers:

- `Authorization: Bearer <token>`
- `i-lang: zh-TW`
- `i-version: 1.0.8`

## Reliability notes

The check-in script is deliberately strict about rewards:

- Missing / unknown `can_checkin_today` is **not** treated as "already checked in". The script attempts check-in so accounts do not silently skip rewards.
- After `POST /api/checkin`, it re-reads records (with short polling) and requires the day status to settle to "already checked in".
- If the account was eligible for a daily reward but `total_credits` does not increase, the run fails for that account so Actions shows red instead of a false success.
- Transient errors (`429`, `5xx`, network/timeouts) are retried with backoff.
- GitHub Actions matrix jobs are generated from `accounts.json`, then each enabled account waits a shared-seed cumulative delay so the next enabled account begins 5–15 seconds after the previous one.

## Multi-account Browser Strategy

If browser automation is needed for token capture or recovery, use one separate
Playwright browser process for each account. Run accounts sequentially instead
of in parallel.

Account isolation is more important than browser reuse. To reduce account lock
risk, avoid large concurrent login or check-in bursts.

The local token capture helper implements this strategy:

```sh
npm install
npm run capture:tokens -- --accounts 1,2,3
```

For a range of accounts:

```sh
npm run capture:tokens -- --start 1 --end 11
```

The helper opens and closes a fresh Playwright browser for each account. Log in
manually in the opened browser window, then press Enter in the terminal to
capture that account's token. Captured tokens are written to `.env.captured`,
which is ignored by git.

To write captured tokens directly to GitHub Actions secrets, make sure `gh` is
authenticated and run:

```sh
npm run capture:tokens -- --start 1 --end 11 --update-secrets
```

## Daily macOS Schedule

After `.env` is filled and a manual run works:

```sh
chmod +x run-checkin.command install-macos-launch-agent.sh
./install-macos-launch-agent.sh
```

The included schedule runs every day at 09:05.

## GitHub Actions

The workflow in `.github/workflows/mindvideo-daily-checkin.yml` validates
`accounts.json` and runs one isolated GitHub Actions matrix job per enabled
account (currently 33) on each schedule (Asia/Taipei windows):

- enabled `MINDVIDEO_TOKEN*` slots every day at **05:09–06:09**.
- enabled `MINDVIDEO_TOKEN*` slots every day at **13:09–14:09**.
- enabled `MINDVIDEO_TOKEN*` slots every day at **21:09–22:09**.

Slots `12` and `13` have been reassigned to `fengwithfeng1127` and
`tushenbyfengbro`. Slots `14`–`33` are retained as empty placeholders
(`account-14` through `account-33`). Missing Secrets are reported as skipped,
so these slots do not run until their corresponding tokens are added.

The scheduled starts are 9 minutes after the matching
[AutoSignLitVideo](https://github.com/huang1988pioneer/AutoSignLitVideo) windows
to avoid scheduling all related workflows on the hour. GitHub Actions uses UTC
cron values `9 21 * * *`, `9 5 * * *`, and `9 13 * * *` for these Taipei times.

Within each window, all enabled jobs start, then execute in catalog order with
a **random 5–15 second gap** between consecutive accounts (shared seed per run
so the delay chain is consistent across matrix jobs).

Each job reads only its own token secret. Empty or missing token secrets are
reported as skipped, so you can add accounts gradually.

### Daily summary job

After all matrix check-in jobs finish, a `daily-summary` job (same style as
[AutoSignLitVideo](https://github.com/huang1988pioneer/AutoSignLitVideo)):

1. Downloads every account's `checkin-result-*.json` artifact
2. Builds one combined markdown/JSON report with:
   - Headline (`✅ All configured accounts OK` / `⚠️ N need attention`)
   - Metric table (new check-in / already done / failed / skipped / credits gained)
   - Per-account table (status badge, reward tier, total credits, streak, note)
   - Skipped account list (for example, `#14, #15, …`)
3. Writes the report into the workflow **Job Summary** (visible on the run page)
4. Uploads `mindvideo-checkin-report` artifact (`checkin-daily-summary.md` + `.json` + `checkin-streaks.json`)
5. Records each account’s continuous check-in days (`streak` / API `current_day`) in every result row and a dedicated streak ledger
6. Fails the summary job if any account status is `failed`

Locally you can rebuild a summary from a folder of result JSON files:

```sh
npm run summary -- path/to/collected-results
```

Add repository secrets before enabling the matching accounts:

```text
MINDVIDEO_TOKEN<number from accounts.json>
```

If token refresh persistence is needed, also add:

```text
GH_SECRETS_TOKEN
```

You can also run it manually from the repository's Actions tab.

Validate the catalog, schedule, and pure helper modules locally:

```sh
npm run check:accounts
npm run check:schedule
npm test
```
