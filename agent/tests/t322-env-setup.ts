/**
 * T-322 helper: must be imported BEFORE agent/orchestrator-team.ts so its
 * module-level credential guard is satisfied. Bun/ESM hoists imports, so we use
 * a separate module to ensure
 * these env vars are set before the orchestrator module evaluates.
 */
if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  process.env.ANTHROPIC_API_KEY = "test-key-not-used";
}
if (!process.env.TELEGRAM_BOT_TOKEN) process.env.TELEGRAM_BOT_TOKEN = "111:test";
process.env.HEALTH_ENABLED ??= "false";
process.env.SELF_DIAG_ENABLED ??= "false";
process.env.BACKUP_ENABLED ??= "false";
process.env.DIGEST_ENABLED ??= "false";
process.env.DB_MAINT_ENABLED ??= "false";
