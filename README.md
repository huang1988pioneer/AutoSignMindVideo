# MindVideo Auto Sign

This signs in to MindVideo once per day using the same API as the website.

## Setup

1. Copy `.env.example` to `.env`.
2. Paste your MindVideo token into `MINDVIDEO_TOKEN`.
   For more accounts, add `MINDVIDEO_TOKEN2`, `MINDVIDEO_TOKEN3`, and so on. GitHub Actions is preconfigured through `MINDVIDEO_TOKEN115`.
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

## Daily macOS Schedule

After `.env` is filled and a manual run works:

```sh
chmod +x run-checkin.command install-macos-launch-agent.sh
./install-macos-launch-agent.sh
```

The included schedule runs every day at 09:05.

## GitHub Actions

The workflow in `.github/workflows/mindvideo-checkin.yml` runs every day at 09:05 Asia/Taipei.

Add this repository secret before enabling it:

```text
MINDVIDEO_TOKEN
```

For more MindVideo accounts, add numbered repository secrets up to `MINDVIDEO_TOKEN115`:

```text
MINDVIDEO_TOKEN2
MINDVIDEO_TOKEN3
...
MINDVIDEO_TOKEN115
```

You can also run it manually from the repository's Actions tab.
