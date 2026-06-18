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

Required headers:

- `Authorization: Bearer <token>`
- `i-lang: zh-TW`
- `i-version: 1.0.8`

## Multi-account Browser Strategy

If browser automation is needed for token capture or recovery, use one shared
Playwright browser process with a separate browser context for each account.
Run accounts sequentially instead of in parallel.

Account isolation is more important than opening many Playwright browsers. To
reduce account lock risk, avoid large concurrent login or check-in bursts.

The local token capture helper implements this strategy:

```sh
npm install
npm run capture:tokens -- --accounts 12,13,14
```

For a range of accounts:

```sh
npm run capture:tokens -- --start 12 --end 20
```

The helper opens one shared Playwright browser and creates a fresh isolated
browser context for each account. Log in manually in the opened browser window,
then press Enter in the terminal to capture that account's token. Captured
tokens are written to `.env.captured`, which is ignored by git.

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

The workflow in `.github/workflows/mindvideo-checkin.yml` runs:

- `MINDVIDEO_TOKEN1` every day at 05:07 Asia/Taipei.
- `MINDVIDEO_TOKEN2` every day at 05:14 Asia/Taipei.

Add this repository secret before enabling it:

```text
MINDVIDEO_TOKEN1
```

For the second MindVideo account, add another repository secret:

```text
MINDVIDEO_TOKEN2
```

You can also run it manually from the repository's Actions tab.
