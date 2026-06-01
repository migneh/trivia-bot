'use strict';
/**
 * utils/imageValidator.js
 *
 * Parallel image URL validation for questions that have imageUrl set.
 * Called once at session start — before the first question is posted.
 *
 * ─── Behaviour ───────────────────────────────────────────────────────────────
 *
 *   1. Collect all questions with a non-null imageUrl.
 *   2. Fire HEAD requests in parallel using Promise.all().
 *   3. Each request has an individual timeout (imageValidationTimeoutMs).
 *   4. The entire parallel batch has a hard total cap (imageValidationTotalCapMs).
 *      Any request still pending after the cap is treated as failed.
 *   5. A question's image is considered INVALID if:
 *        - The URL is malformed (not parseable by new URL())
 *        - The HEAD request times out (individual timeout)
 *        - The total cap expires before this request resolves
 *        - The HTTP response is non-2xx
 *        - The Content-Type header does not start with "image/"
 *   6. Invalid images: question is kept but imageUrl is nulled out.
 *      The question itself is NOT skipped — only the image is dropped.
 *   7. Players are never notified of image failures.
 *   8. Session startup is not halted — validation completes fully before
 *      the first question is posted, but failures are handled silently.
 *
 * ─── Return value ─────────────────────────────────────────────────────────────
 *
 *   Returns a Set<string> of question IDs whose imageUrl failed validation.
 *   Callers should null out imageUrl for those IDs before using the questions.
 *
 * ─── Why HEAD and not GET? ────────────────────────────────────────────────────
 *
 *   HEAD requests fetch only headers — no body download.
 *   This is the lightest possible check: reachable + correct content-type.
 */

const config = require('../config.json');

const INDIVIDUAL_TIMEOUT_MS = config.imageValidationTimeoutMs ?? 2000;
const TOTAL_CAP_MS          = config.imageValidationTotalCapMs ?? 5000;


// ═══════════════════════════════════════════════════════════════════════════════
// SINGLE URL VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate a single image URL.
 *
 * Returns true  → URL is reachable and serves an image.
 * Returns false → URL is invalid, unreachable, timed out, or wrong content-type.
 *
 * Never throws — all errors are caught and return false.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function validateSingleImage(url) {
  // ── URL format check ─────────────────────────────────────────────────────────
  if (!url || typeof url !== 'string' || url.trim() === '') return false;

  let parsedUrl;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    return false; // malformed URL
  }

  // Only allow http and https
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return false;
  }

  // ── HEAD request with individual timeout ──────────────────────────────────────
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), INDIVIDUAL_TIMEOUT_MS);

  try {
    const response = await fetch(parsedUrl.toString(), {
      method:  'HEAD',
      signal:  controller.signal,
      headers: {
        // Some servers reject requests without a User-Agent
        'User-Agent': 'DiscordBot (TriviaBot/1.0)',
      },
      redirect: 'follow',
    });

    // Must be a 2xx response
    if (!response.ok) return false;

    // Must be an image content-type
    const contentType = response.headers.get('content-type') ?? '';
    return contentType.startsWith('image/');

  } catch {
    // AbortError (timeout), network error, DNS failure, etc.
    return false;
  } finally {
    clearTimeout(timer);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// BATCH VALIDATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate the imageUrl of every question that has one, in parallel.
 *
 * Returns a Set of question IDs whose images are INVALID.
 * Questions with no imageUrl are not included in the Set
 * (they are implicitly valid — there is nothing to validate).
 *
 * The entire batch is raced against TOTAL_CAP_MS.
 * If the cap fires first, ALL still-pending requests are treated as failed.
 * This guarantees session startup never hangs waiting for slow image servers.
 *
 * @param {object[]} questions - question objects (may or may not have imageUrl)
 * @returns {Promise<Set<string>>} Set of question IDs with invalid images
 */
async function validateQuestionImages(questions) {
  // Filter to only questions that actually have an imageUrl
  const withImages = questions.filter(
    q => q.imageUrl && typeof q.imageUrl === 'string' && q.imageUrl.trim() !== ''
  );

  // Nothing to validate
  if (withImages.length === 0) return new Set();

  // ── Build validation promises ─────────────────────────────────────────────────
  // Each promise resolves to { id, valid } regardless of success or failure.
  const validationPromises = withImages.map(async q => {
    const valid = await validateSingleImage(q.imageUrl);
    return { id: q.id, valid };
  });

  // ── Total cap sentinel ────────────────────────────────────────────────────────
  // Resolves with the string 'CAP_HIT' after TOTAL_CAP_MS.
  // If this wins the race, all still-running validations are abandoned.
  let capTimer;
  const capPromise = new Promise(resolve => {
    capTimer = setTimeout(() => resolve('CAP_HIT'), TOTAL_CAP_MS);
  });

  // ── Race the batch against the cap ────────────────────────────────────────────
  const batchPromise = Promise.all(validationPromises);
  const result       = await Promise.race([batchPromise, capPromise]);

  clearTimeout(capTimer);

  // ── Cap fired — all images in this batch are treated as invalid ───────────────
  if (result === 'CAP_HIT') {
    console.warn(
      `[ImageValidator] Total cap (${TOTAL_CAP_MS}ms) exceeded — ` +
      `${withImages.length} image(s) treated as invalid.`
    );
    return new Set(withImages.map(q => q.id));
  }

  // ── Normal path — build the invalid set from results ─────────────────────────
  const invalidIds = new Set();
  for (const { id, valid } of result) {
    if (!valid) {
      invalidIds.add(id);
    }
  }

  // Log summary (only if there were failures)
  if (invalidIds.size > 0) {
    console.warn(
      `[ImageValidator] ${invalidIds.size}/${withImages.length} image(s) failed validation: ` +
      [...invalidIds].join(', ')
    );
  } else {
    console.log(
      `[ImageValidator] All ${withImages.length} image(s) validated successfully.`
    );
  }

  return invalidIds;
}


// ═══════════════════════════════════════════════════════════════════════════════
// APPLY VALIDATION RESULTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply image validation results to a list of questions.
 * Questions with invalid images have their imageUrl set to null.
 * Questions with valid images (or no imageUrl) are returned unchanged.
 *
 * This is a pure function — it does not mutate the input array.
 * Returns a new array of question objects.
 *
 * Typical usage in trivia-start.js:
 *
 *   const invalidIds = await validateQuestionImages(questions);
 *   const readyQuestions = applyImageValidation(questions, invalidIds);
 *
 * @param {object[]} questions
 * @param {Set<string>} invalidIds
 * @returns {object[]} new array with imageUrl nulled for invalid questions
 */
function applyImageValidation(questions, invalidIds) {
  if (invalidIds.size === 0) return questions;

  return questions.map(q => {
    if (invalidIds.has(q.id)) {
      return { ...q, imageUrl: null };
    }
    return q;
  });
}


// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  validateQuestionImages,
  applyImageValidation,
  validateSingleImage,   // exported for testing or one-off checks
};
