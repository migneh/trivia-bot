'use strict';
/**
 * utils/dashboardQueue.js
 *
 * Per-guild serial edit queue for the live session dashboard message.
 *
 * ─── Problem this solves ──────────────────────────────────────────────────────
 *
 *   Discord rate-limits message edits per channel.
 *   If multiple dashboard updates are triggered in rapid succession
 *   (e.g. many players voting at the same time), firing them all
 *   concurrently causes 429 errors and edit races where an older
 *   state overwrites a newer one.
 *
 *   This queue ensures:
 *     1. Only one dashboard edit is in-flight at a time per guild.
 *     2. Edits are processed in the order they were enqueued.
 *     3. A failed edit does not block subsequent edits.
 *     4. Guilds are completely isolated — guild A's queue never
 *        affects guild B's queue.
 *
 * ─── Implementation ───────────────────────────────────────────────────────────
 *
 *   Each guild has its own Promise chain stored in the queues Map.
 *   Enqueueing appends a .then() to the chain.
 *   When a session ends, clearQueue() removes the guild's chain
 *   so the Promise can be garbage collected.
 *
 * ─── Dropped edits ────────────────────────────────────────────────────────────
 *
 *   If multiple edits are enqueued before the first one completes,
 *   they all run in sequence. This is intentional for correctness.
 *   If you want to DROP intermediate edits (only keep the latest),
 *   see the debounce variant below — currently not used but documented.
 *
 * ─── Error handling ───────────────────────────────────────────────────────────
 *
 *   Each edit function is wrapped in a catch().
 *   Errors are logged but do NOT propagate — they resolve the chain
 *   so the next edit can proceed normally.
 *
 *   Known ignorable errors:
 *     10008 — Unknown Message (dashboard was deleted)
 *     50013 — Missing Permissions (bot lost channel access)
 *
 *   These are swallowed silently. Other errors are logged to console.
 */

// ─── Known Discord API error codes that are safe to ignore ────────────────────
const IGNORABLE_ERROR_CODES = new Set([
  10008, // Unknown Message (message deleted)
  50013, // Missing Permissions
  50001, // Missing Access
]);

/**
 * Map from guildId → current tail of the Promise chain for that guild.
 * @type {Map<string, Promise<void>>}
 */
const queues = new Map();

/**
 * Map from guildId → count of edits currently queued (including in-flight).
 * Used for diagnostics and to skip redundant edits.
 * @type {Map<string, number>}
 */
const pendingCounts = new Map();


// ═══════════════════════════════════════════════════════════════════════════════
// CORE QUEUE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Enqueue a dashboard edit for a guild.
 *
 * The editFn is guaranteed to run after all previously enqueued edits
 * for the same guild have completed (or failed).
 *
 * @param {string}   guildId
 * @param {Function} editFn  - async function () => void
 *   Should perform the actual message.edit() call.
 *   Must not throw — errors are handled internally.
 *
 * @returns {Promise<void>} resolves when THIS edit completes (or fails).
 */
function enqueueDashboardEdit(guildId, editFn) {
  // Get the current tail of the chain (or a resolved Promise if queue is empty)
  const prev = queues.get(guildId) ?? Promise.resolve();

  // Increment pending count
  pendingCounts.set(guildId, (pendingCounts.get(guildId) ?? 0) + 1);

  // Append this edit to the chain
  const next = prev
    .then(() => editFn())
    .catch(err => handleEditError(guildId, err))
    .finally(() => {
      // Decrement pending count
      const remaining = (pendingCounts.get(guildId) ?? 1) - 1;
      if (remaining <= 0) {
        pendingCounts.delete(guildId);
        // If the queue is now empty, we can clean up the chain reference
        // (only if it's still the same promise chain we're closing)
        if (queues.get(guildId) === next) {
          queues.delete(guildId);
        }
      } else {
        pendingCounts.set(guildId, remaining);
      }
    });

  // Update the tail pointer
  queues.set(guildId, next);

  return next;
}

/**
 * Clear the queue for a guild.
 * Called when a session ends to release the Promise chain
 * and allow garbage collection.
 *
 * Any in-flight edit will still complete — we just stop tracking
 * the chain and reset the pending count.
 * New edits enqueued after clearQueue() start a fresh chain.
 *
 * @param {string} guildId
 */
function clearQueue(guildId) {
  queues.delete(guildId);
  pendingCounts.delete(guildId);
}

/**
 * Check whether any edits are currently queued or in-flight for a guild.
 *
 * @param {string} guildId
 * @returns {boolean}
 */
function hasPendingEdits(guildId) {
  return (pendingCounts.get(guildId) ?? 0) > 0;
}

/**
 * Get the number of pending edits for a guild.
 * Includes the currently in-flight edit (if any).
 *
 * @param {string} guildId
 * @returns {number}
 */
function getPendingCount(guildId) {
  return pendingCounts.get(guildId) ?? 0;
}


// ═══════════════════════════════════════════════════════════════════════════════
// ERROR HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Handle an error from an edit function.
 * Ignorable Discord errors are swallowed silently.
 * Unexpected errors are logged to console.
 *
 * @param {string} guildId
 * @param {Error}  err
 */
function handleEditError(guildId, err) {
  // Discord.js wraps API errors with a `code` property
  const code = err?.code;

  if (IGNORABLE_ERROR_CODES.has(code)) {
    // Safe to ignore — message deleted, permissions lost, etc.
    return;
  }

  // Unexpected error — log for debugging
  console.error(
    `[DashboardQueue][${guildId}] Dashboard edit failed` +
    (code ? ` (Discord error ${code})` : '') +
    `: ${err?.message ?? String(err)}`
  );
}


// ═══════════════════════════════════════════════════════════════════════════════
// DEBOUNCE VARIANT (documented — not used by default)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Debounced dashboard edit for high-frequency scenarios.
 *
 * If multiple edits are requested within `debounceMs`, only the LAST
 * one fires — intermediate edits are dropped.
 *
 * This trades accuracy (every state is reflected) for rate-limit safety
 * (fewer API calls). Use this instead of enqueueDashboardEdit() if you
 * expect 10+ votes per second per guild.
 *
 * Currently NOT used in gameEngine.js — the serial queue is preferred
 * because dashboard updates only happen once per question reveal.
 *
 * @type {Map<string, ReturnType<typeof setTimeout>>}
 */
const debounceTimers = new Map();

/**
 * Enqueue a debounced dashboard edit.
 * Only the last call within debounceMs will actually fire.
 *
 * @param {string}   guildId
 * @param {Function} editFn     - async function () => void
 * @param {number}   debounceMs - default 300ms
 */
function enqueueDashboardEditDebounced(guildId, editFn, debounceMs = 300) {
  // Cancel any pending debounced edit for this guild
  if (debounceTimers.has(guildId)) {
    clearTimeout(debounceTimers.get(guildId));
  }

  const timer = setTimeout(() => {
    debounceTimers.delete(guildId);
    enqueueDashboardEdit(guildId, editFn);
  }, debounceMs);

  debounceTimers.set(guildId, timer);
}

/**
 * Cancel any pending debounced edit for a guild.
 * Call this from clearQueue() if using the debounce variant.
 *
 * @param {string} guildId
 */
function cancelDebounced(guildId) {
  if (debounceTimers.has(guildId)) {
    clearTimeout(debounceTimers.get(guildId));
    debounceTimers.delete(guildId);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Primary API — used by gameEngine.js
  enqueueDashboardEdit,
  clearQueue,

  // Diagnostics
  hasPendingEdits,
  getPendingCount,

  // Debounce variant (optional — not used by default)
  enqueueDashboardEditDebounced,
  cancelDebounced,
};
