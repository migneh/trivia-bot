'use strict';
/**
 * scheduler/manager.js
 *
 * Schedule loader, cron manager, and conflict resolver.
 * All times are UTC — no timezone conversion ever happens here.
 *
 * ─── Three schedule modes ─────────────────────────────────────────────────────
 *
 *   daily     — fires every day at a fixed UTC hour:minute
 *   weekly    — fires on specific weekdays at a fixed UTC hour:minute
 *   countdown — fires once, X minutes after triggerCountdown() is called
 *
 * ─── File format (./schedules/{guildId}.json) ────────────────────────────────
 *
 *   {
 *     "mode":          "daily" | "weekly" | "countdown" | "none",
 *     "utcTime":       "HH:MM",          // used by daily and weekly
 *     "weekdays":      [0,1,2,3,4,5,6],  // 0=Sun, used by weekly
 *     "questionCount": 10,
 *     "timeLimitSec":  10,
 *     "categories":    ["gaming", "sports"]  // empty = all enabled
 *   }
 *
 * ─── Autonomous operation ─────────────────────────────────────────────────────
 *
 *   Scheduled sessions start without any admin present.
 *   Defaults used when wizard hasn't been configured:
 *     questionCount  → 10
 *     timeLimitSec   → 10
 *     categories     → all categories from config.json
 *
 * ─── Conflict resolution ──────────────────────────────────────────────────────
 *
 *   If a scheduled session is about to start while a manual session
 *   is running, the bot posts a warning (schedulingWarningSeconds before),
 *   waits, then ends the manual session and starts the scheduled one.
 *
 * ─── Pre-session reminder ─────────────────────────────────────────────────────
 *
 *   A second cron job fires preSessionReminderMinutes before each scheduled
 *   session and posts an Arabic reminder in the session channel.
 *
 * ─── Per-guild isolation ──────────────────────────────────────────────────────
 *
 *   Each guild has its own cron jobs (main + reminder).
 *   activeCronJobs Map stores both per guild.
 *   Guild A's jobs never affect guild B.
 */

const cron    = require('node-cron');
const fs      = require('node:fs');
const path    = require('node:path');
const { EmbedBuilder } = require('discord.js');

const config  = require('../config.json');
const sm      = require('../utils/sessionManager');
const qb      = require('../utils/questionBank');
const { validateQuestionImages, applyImageValidation } = require('../utils/imageValidator');
const { startSession, endSession, logToOwner }         = require('../utils/gameEngine');
const queries = require('../database/queries');

// ─── Constants ────────────────────────────────────────────────────────────────

const SCHEDULES_DIR = path.resolve(config.schedulesPath ?? './schedules');
const WARNING_SEC   = config.schedulingWarningSeconds  ?? 30;
const REMINDER_MIN  = config.preSessionReminderMinutes ?? 5;

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {import('discord.js').Client|null} */
let client = null;

/**
 * @typedef {{ main: cron.ScheduledTask, reminder: cron.ScheduledTask|null }} GuildJobs
 * @type {Map<string, GuildJobs>}
 */
const activeCronJobs = new Map();

/** @type {Map<string, ReturnType<typeof setTimeout>>} guildId → countdown timer */
const countdownTimers = new Map();


// ═══════════════════════════════════════════════════════════════════════════════
// INITIALISATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Initialise the scheduler with the Discord client.
 * Must be called once from the 'ready' event handler.
 * Loads all per-guild schedule files and registers cron jobs.
 *
 * @param {import('discord.js').Client} discordClient
 */
function init(discordClient) {
  client = discordClient;
  fs.mkdirSync(SCHEDULES_DIR, { recursive: true });
  loadAllSchedules();
  console.log('[Scheduler] Initialised (UTC).');
}


// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULE FILE I/O
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Load all per-guild schedule files from the schedules directory.
 * Registers a cron job for each guild with a non-'none' mode.
 */
function loadAllSchedules() {
  if (!fs.existsSync(SCHEDULES_DIR)) return;

  const files = fs.readdirSync(SCHEDULES_DIR).filter(f => f.endsWith('.json'));
  let loaded  = 0;

  for (const file of files) {
    const guildId = file.replace('.json', '');
    try {
      const schedule = readScheduleFile(guildId);
      if (schedule && schedule.mode !== 'none') {
        registerCronJobs(guildId, schedule);
        loaded++;
      }
    } catch (err) {
      console.error(`[Scheduler] Failed to load schedule for guild ${guildId}:`, err.message);
    }
  }

  console.log(`[Scheduler] Loaded ${loaded} active schedule(s) from ${files.length} file(s).`);
}

/**
 * Read and parse a guild's schedule file.
 * Returns null if the file doesn't exist or fails to parse.
 *
 * @param {string} guildId
 * @returns {object|null}
 */
function readScheduleFile(guildId) {
  const filePath = path.join(SCHEDULES_DIR, `${guildId}.json`);
  if (!fs.existsSync(filePath)) return null;

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[Scheduler] Failed to parse schedule file for guild ${guildId}:`, err.message);
    return null;
  }
}

/**
 * Write a guild's schedule data to its JSON file.
 * Creates the schedules directory if it doesn't exist.
 *
 * @param {string} guildId
 * @param {object} data
 */
function writeScheduleFile(guildId, data) {
  fs.mkdirSync(SCHEDULES_DIR, { recursive: true });
  const filePath = path.join(SCHEDULES_DIR, `${guildId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Read the current schedule for a guild (public API).
 * Returns null if no schedule file exists.
 *
 * @param {string} guildId
 * @returns {object|null}
 */
function getSchedule(guildId) {
  return readScheduleFile(guildId);
}


// ═══════════════════════════════════════════════════════════════════════════════
// CRON EXPRESSION BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Build a cron expression from a UTC time string and optional weekdays.
 *
 * @param {string}   utcTime  - "HH:MM" format
 * @param {number[]} [weekdays] - array of 0–6 (0=Sun), used for weekly mode
 * @returns {string} cron expression
 * @throws {Error} if utcTime is invalid
 */
function buildCronExpression(utcTime, weekdays) {
  if (!utcTime || typeof utcTime !== 'string') {
    throw new Error(`Invalid utcTime: ${JSON.stringify(utcTime)}`);
  }

  const parts = utcTime.split(':');
  if (parts.length !== 2) {
    throw new Error(`utcTime must be "HH:MM", got: "${utcTime}"`);
  }

  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10);

  if (isNaN(h) || h < 0 || h > 23) throw new Error(`Invalid hour in utcTime: "${utcTime}"`);
  if (isNaN(m) || m < 0 || m > 59) throw new Error(`Invalid minute in utcTime: "${utcTime}"`);

  if (Array.isArray(weekdays) && weekdays.length > 0) {
    // Weekly mode: specific days of the week
    const days = weekdays
      .map(d => Math.max(0, Math.min(6, Math.floor(d))))
      .sort((a, b) => a - b)
      .join(',');
    return `${m} ${h} * * ${days}`;
  }

  // Daily mode: every day
  return `${m} ${h} * * *`;
}

/**
 * Build a cron expression for the reminder job.
 * The reminder fires REMINDER_MIN minutes before the main session.
 *
 * @param {string}   utcTime
 * @param {number[]} [weekdays]
 * @returns {string} cron expression for the reminder
 */
function buildReminderCronExpression(utcTime, weekdays) {
  const parts = utcTime.split(':');
  let h = parseInt(parts[0], 10);
  let m = parseInt(parts[1], 10);

  // Subtract reminder minutes
  m -= REMINDER_MIN;
  if (m < 0) {
    m += 60;
    h -= 1;
    if (h < 0) h += 24;
  }

  const reminderTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  // Reuse the same weekdays for weekly mode
  return buildCronExpression(reminderTime, weekdays);
}


// ═══════════════════════════════════════════════════════════════════════════════
// CRON JOB REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Register cron jobs for a guild.
 * Cancels any existing jobs for this guild before creating new ones.
 * Does nothing if schedule.mode is 'none' or 'countdown'.
 *
 * @param {string} guildId
 * @param {object} schedule - parsed schedule object
 */
function registerCronJobs(guildId, schedule) {
  // Cancel existing jobs first
  cancelCronJobs(guildId);

  if (!schedule || schedule.mode === 'none' || schedule.mode === 'countdown') {
    return;
  }

  // ── Build main cron expression ────────────────────────────────────────────
  let mainExpr;
  try {
    mainExpr = buildCronExpression(
      schedule.utcTime,
      schedule.mode === 'weekly' ? schedule.weekdays : undefined
    );
  } catch (err) {
    console.error(`[Scheduler][${guildId}] Invalid schedule config:`, err.message);
    return;
  }

  if (!cron.validate(mainExpr)) {
    console.error(`[Scheduler][${guildId}] Invalid cron expression: "${mainExpr}"`);
    return;
  }

  // ── Register main job ─────────────────────────────────────────────────────
  const mainJob = cron.schedule(
    mainExpr,
    async () => {
      await triggerScheduledSession(guildId);
    },
    { timezone: 'UTC', scheduled: true }
  );

  // ── Build and register reminder job ──────────────────────────────────────
  let reminderJob = null;
  try {
    const reminderExpr = buildReminderCronExpression(
      schedule.utcTime,
      schedule.mode === 'weekly' ? schedule.weekdays : undefined
    );

    if (cron.validate(reminderExpr)) {
      reminderJob = cron.schedule(
        reminderExpr,
        async () => {
          await postSessionReminder(guildId, schedule);
        },
        { timezone: 'UTC', scheduled: true }
      );
    }
  } catch {
    // Reminder job failure is non-fatal — main job still runs
  }

  activeCronJobs.set(guildId, { main: mainJob, reminder: reminderJob });

  console.log(
    `[Scheduler][${guildId}] Registered ${schedule.mode} job: "${mainExpr}" UTC` +
    (reminderJob ? ` + reminder` : '')
  );
}

/**
 * Cancel and remove all cron jobs for a guild.
 *
 * @param {string} guildId
 */
function cancelCronJobs(guildId) {
  const jobs = activeCronJobs.get(guildId);
  if (!jobs) return;

  try { jobs.main?.stop();     } catch {}
  try { jobs.reminder?.stop(); } catch {}

  activeCronJobs.delete(guildId);
}

/**
 * Cancel a countdown timer for a guild (if one is pending).
 *
 * @param {string} guildId
 */
function cancelCountdown(guildId) {
  const timer = countdownTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    countdownTimers.delete(guildId);
    console.log(`[Scheduler][${guildId}] Countdown cancelled.`);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// PRE-SESSION REMINDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Post an Arabic reminder in the session channel before a scheduled session.
 *
 * @param {string} guildId
 * @param {object} schedule
 */
async function postSessionReminder(guildId, schedule) {
  const settings = queries.getGuildSettings(guildId);
  if (!settings?.session_channel) return;

  const channel = await fetchChannel(settings.session_channel);
  if (!channel) return;

  const questionCount = schedule.questionCount ?? 10;
  const timeLimitSec  = schedule.timeLimitSec  ?? 10;

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('⏰ تذكير — جلسة مسابقة قادمة!')
        .setDescription(
          `ستبدأ جلسة المسابقة المجدولة خلال **${REMINDER_MIN} دقائق**.\n\n` +
          `📋 **عدد الأسئلة:** ${questionCount}\n` +
          `⏱️ **وقت كل سؤال:** ${timeLimitSec} ثانية\n\n` +
          `استعدوا! 🎮`
        )
        .setColor(config.colors.warning)
        .setTimestamp(),
    ],
  }).catch(() => {});
}


// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULED SESSION TRIGGER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Trigger a scheduled session for a guild.
 * Called by cron jobs (daily/weekly) and countdown timers.
 *
 * Steps:
 *  1. Load guild settings and verify session channel.
 *  2. Resolve session parameters (from schedule or defaults).
 *  3. Handle conflict if a manual session is running.
 *  4. Select and validate questions.
 *  5. Create session and start it.
 *
 * @param {string} guildId
 */
async function triggerScheduledSession(guildId) {
  if (!client) {
    console.error(`[Scheduler][${guildId}] triggerScheduledSession called before init().`);
    return;
  }

  // ── 1. Guild settings ───────────────────────────────────────────────────────
  const settings = queries.getGuildSettings(guildId);
  if (!settings?.session_channel) {
    console.log(`[Scheduler][${guildId}] No session channel configured — skipping.`);
    return;
  }

  // ── 2. Verify channel exists and is accessible ──────────────────────────────
  const channel = await fetchChannel(settings.session_channel);
  if (!channel) {
    console.log(`[Scheduler][${guildId}] Session channel ${settings.session_channel} not found or inaccessible — skipping instance.`);
    // Do not disable schedule — channel may be temporarily unavailable
    return;
  }

  // ── 3. Resolve session parameters ───────────────────────────────────────────
  const schedule     = readScheduleFile(guildId) ?? {};
  const questionCount = schedule.questionCount ?? 10;
  const timeLimitSec  = schedule.timeLimitSec  ?? 10;

  // Categories: use schedule override → guild enabled categories → all categories
  let categories = schedule.categories?.length > 0
    ? schedule.categories.filter(c => config.categories.some(x => x.id === c))
    : [];

  if (categories.length === 0) {
    const enabledCats = JSON.parse(settings.enabled_categories ?? '[]');
    categories = enabledCats.length > 0
      ? enabledCats
      : config.categories.map(c => c.id);
  }

  // ── 4. Conflict resolution ───────────────────────────────────────────────────
  if (sm.hasSession(guildId)) {
    const activeSession = sm.getSession(guildId);

    // Post warning
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ تنبيه — جلسة مجدولة قادمة')
          .setDescription(
            `ستبدأ الجلسة المجدولة خلال **${WARNING_SEC} ثانية**.\n` +
            `سيتم إنهاء الجلسة الحالية تلقائياً وحفظ نتائجها.`
          )
          .setColor(config.colors.warning)
          .setTimestamp(),
      ],
    }).catch(() => {});

    // Wait the warning period
    await sleep(WARNING_SEC * 1000);

    // End the manual session (re-check it still exists after the wait)
    const stillActive = sm.getSession(guildId);
    if (stillActive && !stillActive.isEnding) {
      await endSession(client, stillActive, 'scheduled_override');
      // Small buffer to let endSession complete before starting new one
      await sleep(1000);
    }
  }

  // ── 5. Question selection ────────────────────────────────────────────────────
  let questions = qb.selectQuestions(categories, questionCount);

  if (questions.length === 0) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('⚠️ تعذّر بدء الجلسة المجدولة')
          .setDescription('لا توجد أسئلة متاحة في الفئات المحددة للجلسة المجدولة.')
          .setColor(config.colors.error),
      ],
    }).catch(() => {});
    await logToOwner(client, `⚠️ [${guildId}] Scheduled session skipped — no eligible questions.`);
    return;
  }

  // Trim to available if fewer questions than requested
  const actualCount = Math.min(questions.length, questionCount);
  if (actualCount < questionCount) {
    console.warn(
      `[Scheduler][${guildId}] Only ${actualCount}/${questionCount} questions available.`
    );
  }
  questions = questions.slice(0, actualCount);

  // ── 6. Image validation ──────────────────────────────────────────────────────
  const invalidImageIds = await validateQuestionImages(questions);
  questions = applyImageValidation(questions, invalidImageIds);

  // ── 7. Create session ────────────────────────────────────────────────────────
  const created = sm.createSession(guildId, {
    hostId:        client.user.id,  // bot is the host for scheduled sessions
    channelId:     settings.session_channel,
    categories,
    questionCount: questions.length,
    timeLimitSec,
    questions,
  });

  if (!created) {
    // Another session started in the tiny window between conflict check and create
    await channel.send({
      content: '⚠️ تعذّر بدء الجلسة المجدولة — هناك جلسة نشطة بالفعل.',
    }).catch(() => {});
    return;
  }

  // ── 8. Announce and start ────────────────────────────────────────────────────
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('📅 جلسة مسابقة مجدولة تبدأ الآن!')
        .setDescription(
          `**عدد الأسئلة:** ${questions.length}\n` +
          `**وقت كل سؤال:** ${timeLimitSec} ثانية\n` +
          `**الفئات:** ${categories.map(id => config.categories.find(c => c.id === id)?.nameAr ?? id).join('، ')}\n\n` +
          `استعدوا! 🎮`
        )
        .setColor(config.colors.success)
        .setTimestamp(),
    ],
  }).catch(() => {});

  const session = sm.getSession(guildId);
  if (!session) return; // safety check

  console.log(`[Scheduler][${guildId}] Starting scheduled session (${questions.length} questions).`);
  await startSession(client, session, channel);
}


// ═══════════════════════════════════════════════════════════════════════════════
// COUNTDOWN MODE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Start a countdown-mode session.
 * Fires once after `minutes` minutes, then removes itself.
 *
 * @param {string} guildId
 * @param {number} minutes - delay before session starts
 * @param {object} [overrides] - optional { questionCount, timeLimitSec, categories }
 */
function triggerCountdown(guildId, minutes, overrides = {}) {
  // Cancel any existing countdown for this guild
  cancelCountdown(guildId);

  const delayMs = Math.max(1, minutes) * 60 * 1000;

  console.log(`[Scheduler][${guildId}] Countdown set: ${minutes} minute(s).`);

  const timer = setTimeout(async () => {
    countdownTimers.delete(guildId);

    // Apply any overrides to the schedule for this one-shot trigger
    const schedule = readScheduleFile(guildId) ?? {};
    const merged   = {
      ...schedule,
      mode: 'countdown',
      ...overrides,
    };
    writeScheduleFile(guildId, merged);

    await triggerScheduledSession(guildId);
  }, delayMs);

  countdownTimers.set(guildId, timer);
}


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API — APPLY SCHEDULE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Save a schedule for a guild and activate it immediately.
 *
 * This is the single entry point called by trivia-setup.js and
 * trivia-schedule.js when the wizard saves.
 *
 * @param {string} guildId
 * @param {object} scheduleData - the full schedule object to save
 */
function applySchedule(guildId, scheduleData) {
  writeScheduleFile(guildId, scheduleData);

  if (scheduleData.mode === 'none') {
    cancelCronJobs(guildId);
    cancelCountdown(guildId);
    console.log(`[Scheduler][${guildId}] Schedule disabled.`);
    return;
  }

  if (scheduleData.mode === 'countdown') {
    // Countdown is triggered manually via triggerCountdown()
    // applySchedule just saves the config for it
    console.log(`[Scheduler][${guildId}] Countdown config saved.`);
    return;
  }

  // daily or weekly — register cron jobs
  registerCronJobs(guildId, scheduleData);
}

/**
 * Remove all scheduling for a guild.
 * Called when a guild removes the bot (guildDelete event).
 *
 * @param {string} guildId
 */
function removeSchedule(guildId) {
  cancelCronJobs(guildId);
  cancelCountdown(guildId);
}


// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch a text channel by ID. Returns null on any error.
 *
 * @param {string} channelId
 * @returns {Promise<import('discord.js').TextChannel|null>}
 */
async function fetchChannel(channelId) {
  if (!client || !channelId) return null;
  try {
    const ch = await client.channels.fetch(channelId);
    return ch?.isTextBased() ? ch : null;
  } catch {
    return null;
  }
}

/**
 * Async sleep.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get a summary of all active cron jobs.
 * Used for admin commands or debugging.
 *
 * @returns {{ guildId: string, hasMain: boolean, hasReminder: boolean }[]}
 */
function getActiveJobs() {
  return [...activeCronJobs.entries()].map(([guildId, jobs]) => ({
    guildId,
    hasMain:     !!jobs.main,
    hasReminder: !!jobs.reminder,
  }));
}

/**
 * Get all pending countdown timers.
 *
 * @returns {string[]} list of guildIds with pending countdowns
 */
function getPendingCountdowns() {
  return [...countdownTimers.keys()];
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Lifecycle
  init,

  // Schedule management
  applySchedule,
  removeSchedule,
  getSchedule,

  // Manual triggers
  triggerCountdown,
  triggerScheduledSession,

  // Diagnostics
  getActiveJobs,
  getPendingCountdowns,
};
