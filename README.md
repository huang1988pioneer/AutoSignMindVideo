# MindVideo Auto Sign

This signs in to MindVideo once per day using the same API as the website.

## Setup

1. Copy `.env.example` to `.env`.
2. Paste your MindVideo token into `MINDVIDEO_TOKEN1`.
   For more accounts, add `MINDVIDEO_TOKEN2`, `MINDVIDEO_TOKEN3`, and so on.
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
- GitHub Actions matrix jobs are staggered and limited with `max-parallel` to reduce burst rate-limits across many accounts.

## Multi-account Browser Strategy

If browser automation is needed for token capture or recovery, use one separate
Playwright browser process for each account. Run accounts sequentially instead
of in parallel.

Account isolation is more important than browser reuse. To reduce account lock
risk, avoid large concurrent login or check-in bursts.

The local token capture helper implements this strategy:

```sh
npm install
npm run capture:tokens -- --accounts 12,13,14
```

For a range of accounts:

```sh
npm run capture:tokens -- --start 12 --end 20
```

The helper opens and closes a fresh Playwright browser for each account. Log in
manually in the opened browser window, then press Enter in the terminal to
capture that account's token. Captured tokens are written to `.env.captured`,
which is ignored by git.

To write captured tokens directly to GitHub Actions secrets, make sure `gh` is
authenticated and run:

```sh
npm run capture:tokens -- --start 12 --end 20 --update-secrets
```

## Daily macOS Schedule

After `.env` is filled and a manual run works:

```sh
chmod +x run-checkin.command install-macos-launch-agent.sh
./install-macos-launch-agent.sh
```

The included schedule runs every day at 09:05.

## GitHub Actions

The workflow in `.github/workflows/mindvideo-daily-checkin.yml` runs 33 isolated
GitHub Actions matrix jobs on each schedule:

- `MINDVIDEO_TOKEN1` through `MINDVIDEO_TOKEN33` every day at 05:08 Asia/Taipei.
- `MINDVIDEO_TOKEN1` through `MINDVIDEO_TOKEN33` every day at 11:08 Asia/Taipei.
- `MINDVIDEO_TOKEN1` through `MINDVIDEO_TOKEN33` every day at 17:08 Asia/Taipei.
- `MINDVIDEO_TOKEN1` through `MINDVIDEO_TOKEN33` every day at 23:08 Asia/Taipei.

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
   - Skipped account list (`#21, 22, …`)
3. Writes the report into the workflow **Job Summary** (visible on the run page)
4. Uploads `mindvideo-checkin-report` artifact (`checkin-daily-summary.md` + `.json`)
5. Fails the summary job if any account status is `failed`

Locally you can rebuild a summary from a folder of result JSON files:

```sh
npm run summary -- path/to/collected-results
```

Add repository secrets before enabling the matching accounts:

```text
MINDVIDEO_TOKEN1
MINDVIDEO_TOKEN2
...
MINDVIDEO_TOKEN33
```

If token refresh persistence is needed, also add:

```text
GH_SECRETS_TOKEN
```

You can also run it manually from the repository's Actions tab.
