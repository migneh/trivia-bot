'use strict';
/**
 * events/messageCreate.js
 *
 * Handles all incoming text messages to route prefix commands.
 *
 * ─── Prefix format ────────────────────────────────────────────────────────────
 *
 *   config.prefix = "!trivia"
 *
 *   Valid:   "!trivia start"
 *            "!trivia leaderboard week"
 *            "!trivia profile @user"
 *            "!TRIVIA START"  (case-insensitive prefix match)
 *
 *   Invalid: "!triviastart"   (no space after prefix)
 *            "trivia start"   (no ! prefix)
 *
 * ─── Subcommand routing ───────────────────────────────────────────────────────
 *
 *   The subcommand (first word after prefix) is extracted and passed
 *   to commands/prefix/router.js which contains all command logic.
 *
 *   Unknown subcommands: silently ignored — no error, no response.
 *   This matches the spec: "Unknown subcommand (e.g. !trivia xyz): ignore silently."
 *
 * ─── Guards ───────────────────────────────────────────────────────────────────
 *
 *   - Ignore bots (including self)
 *   - Ignore DMs (guild commands only)
 *   - Ignore messages that don't start with the configured prefix
 *   - Ignore messages where prefix is not followed by a space or end-of-string
 *     (prevents "!triviastart" from matching "!trivia")
 *
 * ─── Case sensitivity ─────────────────────────────────────────────────────────
 *
 *   Prefix matching is case-insensitive ("!TRIVIA start" works).
 *   Subcommand matching is done in router.js (also case-insensitive).
 *
 * ─── Why no command cooldown here? ───────────────────────────────────────────
 *
 *   Permission checks are done inside each command handler.
 *   Rate limiting is Discord's responsibility at the API level.
 *   Adding a cooldown map here would be premature optimisation.
 */

const { Events } = require('discord.js');
const config = require('../config.json');
const { handlePrefixCommand } = require('../commands/prefix/router');

// ─── Pre-process prefix for efficient matching ─────────────────────────────────
// Lowercase once at load time — not on every message.
const PREFIX       = config.prefix.toLowerCase();        // "!trivia"
const PREFIX_LEN   = PREFIX.length;


// ═══════════════════════════════════════════════════════════════════════════════
// EVENT HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  name: Events.MessageCreate,
  once: false,

  /**
   * @param {import('discord.js').Message} message
   */
  async execute(message) {

    // ── Guard: ignore bots (including self) ────────────────────────────────────
    if (message.author.bot) return;

    // ── Guard: ignore DMs ──────────────────────────────────────────────────────
    if (!message.guild) return;

    // ── Guard: must start with prefix (case-insensitive) ──────────────────────
    const content = message.content.trim();
    if (!content.toLowerCase().startsWith(PREFIX)) return;

    // ── Guard: prefix must be followed by space or end-of-string ──────────────
    // Prevents "!triviastart" from matching the "!trivia" prefix.
    const charAfterPrefix = content[PREFIX_LEN];
    if (charAfterPrefix !== undefined && charAfterPrefix !== ' ') return;

    // ── Extract subcommand and arguments ──────────────────────────────────────
    // content:      "!trivia leaderboard week"
    // rest:         "leaderboard week"
    // subcommand:   "leaderboard"
    // args:         ["week"]
    const rest = content.slice(PREFIX_LEN).trim();

    if (!rest) {
      // Bare "!trivia" with nothing after it — show help
      await handlePrefixCommand(message, 'help', []);
      return;
    }

    const parts      = rest.split(/\s+/);
    const subcommand = parts[0];          // first word = subcommand
    const args       = parts.slice(1);   // remaining words = arguments

    // ── Route to prefix command handler ───────────────────────────────────────
    await handlePrefixCommand(message, subcommand, args);
  },
};
