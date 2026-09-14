# TMGs Frogger 🐸

A Slackbot for turning an ordinary workspace into a slightly more amphibious place.

## Features

- `/frogify @user` to frogify one user
- `/frogify-all` with paginated workspace member scanning
- persistent frogification history and workspace stats
- `/frog-status` and `/frog-stats`
- `/frog-help`
- App Home welcome screen
- workspace-aware OAuth installation storage
- optional encrypted OAuth token storage
- duplicate-safe channel invites
- configurable frog and developer statuses
- automatic `Frogger Dev :)` status for configured developers after authorization
- rate-limit-friendly request delays
- environment validation
- graceful shutdown and error logging

## Developer status

Set `DEV_USER_IDS` to the Slack user IDs of the developers, for example:

```env
DEV_USER_IDS=U123456,U789012
DEV_STATUS_TEXT=Frogger Dev :)
DEV_STATUS_EMOJI=:frog:
```

The developers must authorize the app with the required user scope (`users.profile:write`) before Frogger can update their status.

## Security

Use `TOKEN_ENCRYPTION_KEY` in production. If it is set, OAuth user tokens are encrypted before being stored in SQLite. Never commit `.env` or real tokens.

## Run

```bash
npm install
npm start
```

Configure the Slack app credentials in `.env` first. Socket Mode is enabled automatically when `SLACK_APP_TOKEN` is present; otherwise Frogger listens on `PORT`.

The bot token must have the bot scopes required by the commands, and the user OAuth flow must request `users.profile:write` for status changes.

## TMG standard

**BETTER. FASTER. SMARTER.**

**I AM BETTER.™**

The frogs have become an enterprise system.
