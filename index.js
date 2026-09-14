require("dotenv").config();

const crypto = require("crypto");
const Database = require("better-sqlite3");
const { App } = require("@slack/bolt");
const { WebClient } = require("@slack/web-api");

const CONFIG = {
  targetChannelId: process.env.FROG_CHANNEL_ID || "C0BDJ5T357X",
  redirectUri: process.env.SLACK_REDIRECT_URI || undefined,
  userScopes: (process.env.SLACK_USER_SCOPES || "users.profile:write").split(",").map(s => s.trim()).filter(Boolean),
  requestDelayMs: Math.max(250, Number(process.env.FROG_REQUEST_DELAY_MS || 900)),
  frogStatusText: process.env.FROG_STATUS_TEXT || "Frogified 🐸",
  frogStatusEmoji: process.env.FROG_STATUS_EMOJI || ":frog:",
  devStatusText: process.env.DEV_STATUS_TEXT || "Frogger Dev :)",
  devStatusEmoji: process.env.DEV_STATUS_EMOJI || ":frog:",
  // TMG + Legin: the founding Frogger developers.
  devUserIds: new Set((process.env.DEV_USER_IDS || "U0BT24U900H,U0AMEEP1540").split(",").map(s => s.trim()).filter(Boolean)),
  databasePath: process.env.FROG_DB_PATH || "frogger.sqlite3"
};

const REQUIRED_ENV = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_STATE_SECRET"];
const missing = REQUIRED_ENV.filter(name => !process.env[name]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const db = new Database(CONFIG.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS installations (
    team_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS frog_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    action TEXT NOT NULL,
    success INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_frog_events_team_target
    ON frog_events(team_id, target_id);
  CREATE INDEX IF NOT EXISTS idx_frog_events_team_created
    ON frog_events(team_id, created_at);
`);

function now() {
  return new Date().toISOString();
}

function encryptToken(token) {
  const keySource = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keySource) return token;
  const key = crypto.createHash("sha256").update(keySource).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptToken(value) {
  if (!value.startsWith("enc:")) return value;
  const keySource = process.env.TOKEN_ENCRYPTION_KEY;
  if (!keySource) throw new Error("TOKEN_ENCRYPTION_KEY is required to decrypt stored tokens");
  const [, iv64, tag64, data64] = value.split(":");
  const key = crypto.createHash("sha256").update(keySource).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv64, "base64url"));
  decipher.setAuthTag(Buffer.from(tag64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data64, "base64url")), decipher.final()]).toString("utf8");
}

const installationStore = {
  storeInstallation: async installation => {
    const teamId = installation.team?.id;
    const userId = installation.user?.id;
    const token = installation.user?.token;
    if (!teamId || !userId || !token) throw new Error("OAuth installation did not contain team, user, and user token");

    const timestamp = now();
    db.prepare(`
      INSERT INTO installations (team_id, user_id, token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_id, user_id) DO UPDATE SET token=excluded.token, updated_at=excluded.updated_at
    `).run(teamId, userId, encryptToken(token), timestamp, timestamp);
  },

  fetchInstallation: async query => {
    const teamId = query.teamId;
    const userId = query.userId;
    if (!teamId || !userId) throw new Error("Workspace and user are required to fetch an installation");
    const row = db.prepare("SELECT token FROM installations WHERE team_id = ? AND user_id = ?").get(teamId, userId);
    if (!row) throw new Error("No OAuth installation found for this workspace/user");
    return { user: { token: decryptToken(row.token) }, team: { id: teamId } };
  },

  deleteInstallation: async query => {
    if (!query.teamId || !query.userId) return;
    db.prepare("DELETE FROM installations WHERE team_id = ? AND user_id = ?").run(query.teamId, query.userId);
  }
};

function recordEvent(teamId, actorId, targetId, action, success = true, error = null) {
  db.prepare(`
    INSERT INTO frog_events (team_id, actor_id, target_id, action, success, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(teamId, actorId, targetId, action, success ? 1 : 0, error, now());
}

function extractUserId(text = "") {
  const match = text.match(/<@([A-Z0-9]+)(?:\|[^>]*)?>/i);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function setUserStatus(userToken, userId, text, emoji, expiration = 0) {
  const client = new WebClient(userToken);
  await client.users.profile.set({
    user: userId,
    profile: {
      status_text: text,
      status_emoji: emoji,
      status_expiration: expiration
    }
  });
}

async function inviteToChannel(botToken, userId) {
  const client = new WebClient(botToken);
  try {
    await client.conversations.invite({ channel: CONFIG.targetChannelId, users: userId });
  } catch (error) {
    const message = error?.data?.error || error.message || "unknown error";
    if (!["already_in_channel", "is_archived"].includes(message)) throw error;
  }
}

async function frogify({ teamId, actorId, targetId, say }) {
  try {
    const row = db.prepare("SELECT token FROM installations WHERE team_id = ? AND user_id = ?").get(teamId, targetId);
    if (!row) {
      recordEvent(teamId, actorId, targetId, "frogify", false, "missing_user_authorization");
      await say(`I can't frogify <@${targetId}> yet. They need to authorize the app first so Frogger can update their status.`);
      return false;
    }

    await setUserStatus(decryptToken(row.token), targetId, CONFIG.frogStatusText, CONFIG.frogStatusEmoji);
    await inviteToChannel(process.env.SLACK_BOT_TOKEN, targetId);
    recordEvent(teamId, actorId, targetId, "frogify");
    await say(`🐸 <@${targetId}> has been frogified.`);
    return true;
  } catch (error) {
    const message = error?.data?.error || error.message || "unknown error";
    recordEvent(teamId, actorId, targetId, "frogify", false, message);
    await say(`🐸 Frogification failed for <@${targetId}>: \`${message}\``);
    return false;
  }
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: process.env.SLACK_APP_TOKEN ? true : false,
  appToken: process.env.SLACK_APP_TOKEN,
  clientId: process.env.SLACK_CLIENT_ID,
  clientSecret: process.env.SLACK_CLIENT_SECRET,
  stateSecret: process.env.SLACK_STATE_SECRET,
  installationStore,
  installerOptions: {
    userScopes: CONFIG.userScopes,
    metadata: "frogger"
  }
});

app.command("/frogify", async ({ command, ack, say }) => {
  await ack();
  const targetId = extractUserId(command.text);
  if (!targetId) {
    await say("Usage: `/frogify @user`");
    return;
  }
  await frogify({ teamId: command.team_id, actorId: command.user_id, targetId, say });
});

app.command("/frogify-all", async ({ command, ack, say, client }) => {
  await ack();
  await say("🐸 Frogification sweep starting... humanity has chosen this path.");

  let cursor;
  let total = 0;
  let success = 0;
  do {
    const response = await client.users.list({ limit: 200, cursor });
    for (const member of response.members || []) {
      if (member.deleted || member.is_bot || member.id === command.user_id) continue;
      total++;
      if (await frogify({ teamId: command.team_id, actorId: command.user_id, targetId: member.id, say })) success++;
      await sleep(CONFIG.requestDelayMs);
    }
    cursor = response.response_metadata?.next_cursor || undefined;
  } while (cursor);

  await say(`🐸 Sweep complete: ${success}/${total} users frogified.`);
});

app.command("/frog-status", async ({ command, ack, say }) => {
  await ack();
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful,
           MAX(created_at) AS last_event
    FROM frog_events WHERE team_id = ? AND target_id = ?
  `).get(command.team_id, command.user_id);

  await say(`🐸 Your Frogger stats: ${row.successful || 0}/${row.total || 0} successful frogifications. Last activity: ${row.last_event || "never"}.`);
});

app.command("/frog-stats", async ({ command, ack, say }) => {
  await ack();
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successful,
           COUNT(DISTINCT target_id) AS unique_targets
    FROM frog_events WHERE team_id = ?
  `).get(command.team_id);
  await say(`🐸 Frogger stats\n• Attempts: ${row.total || 0}\n• Successful: ${row.successful || 0}\n• Unique frogs: ${row.unique_targets || 0}`);
});

app.command("/frog-help", async ({ ack, say }) => {
  await ack();
  await say(`🐸 *Frogger commands*\n• \`/frogify @user\` - frogify one user\n• \`/frogify-all\` - sweep the workspace\n• \`/frog-status\` - view your Frogger history\n• \`/frog-stats\` - workspace Frogger stats\n• \`/frog-help\` - show this help`);
});

app.event("app_home_opened", async ({ event, client }) => {
  try {
    await client.views.publish({
      user_id: event.user,
      view: {
        type: "home",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "🐸 Frogger" } },
          { type: "section", text: { type: "mrkdwn", text: "Welcome to Frogger. Your Slack workspace has been judged sufficiently amphibious." } },
          { type: "divider" },
          { type: "section", text: { type: "mrkdwn", text: "Use `/frog-help` for commands." } }
        ]
      }
    });
  } catch (error) {
    console.error("App Home error:", error.message);
  }
});

async function applyDeveloperStatus() {
  if (!CONFIG.devUserIds.size) return;
  for (const userId of CONFIG.devUserIds) {
    const rows = db.prepare("SELECT team_id, token FROM installations WHERE user_id = ? ORDER BY updated_at DESC").all(userId);
    for (const row of rows) {
      try {
        await setUserStatus(decryptToken(row.token), userId, CONFIG.devStatusText, CONFIG.devStatusEmoji);
        console.log(`Developer status applied to ${userId} in ${row.team_id}`);
      } catch (error) {
        console.warn(`Could not set developer status for ${userId}: ${error.message}`);
      }
    }
  }
}

app.error(async error => {
  console.error("Slack app error:", error);
});

async function shutdown(signal) {
  console.log(`${signal} received. Shutting Frogger down cleanly.`);
  try { await app.stop(); } catch (error) { console.error("Shutdown error:", error.message); }
  try { db.close(); } catch (_) {}
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

(async () => {
  try {
    if (process.env.SLACK_APP_TOKEN) {
      await app.start();
      await applyDeveloperStatus();
      console.log("🐸 Frogger is running in Socket Mode.");
    } else {
      const port = Number(process.env.PORT || 3000);
      await app.start(port);
      await applyDeveloperStatus();
      console.log(`🐸 Frogger is running on port ${port}.`);
    }
  } catch (error) {
    console.error("Failed to start Frogger:", error);
    db.close();
    process.exit(1);
  }
})();
