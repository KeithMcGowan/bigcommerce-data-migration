/**
 * Shared BigCommerce API client factory.
 * Encapsulates rate limiting (1 call/sec) and automatic retry on 429/5xx.
 *
 * Usage:
 *   const { createApiClient } = require('../lib/api.js');
 *   const { apiFetch, BASE_URL } = createApiClient({ storeHash, authToken });
 */

const MIN_CALL_INTERVAL_MS = 1_000;
const RETRY_DELAY_MS       = 60_000;
const MAX_RETRIES          = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates a configured BigCommerce API client for a single store.
 * Each client maintains its own rate-limit state so multiple scripts
 * running in the same process don't interfere with each other.
 *
 * @param {{ storeHash: string, authToken: string }} config
 * @returns {{ apiFetch: Function, BASE_URL: string }}
 */
function createApiClient({ storeHash, authToken }) {
  const BASE_URL = `https://api.bigcommerce.com/stores/${storeHash}/v3`;

  const HEADERS = {
    'X-Auth-Token': authToken,
    'Content-Type': 'application/json',
    Accept:         'application/json',
  };

  let lastCallTime = 0;

  /**
   * Central fetch wrapper that enforces:
   *   1. A minimum 1-second gap between API calls (rate limiting).
   *   2. Automatic retry after RETRY_DELAY_MS on HTTP 429 or any 5xx response.
   *
   * @param {string} url
   * @param {RequestInit} [options]
   * @param {number} [attempt]
   */
  async function apiFetch(url, options = {}, attempt = 0) {
    const wait = MIN_CALL_INTERVAL_MS - (Date.now() - lastCallTime);
    if (wait > 0) await sleep(wait);
    lastCallTime = Date.now();

    const res = await fetch(url, { ...options, headers: HEADERS });

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      console.warn(
        `  → HTTP ${res.status}. Waiting ${RETRY_DELAY_MS / 1_000}s before retry...`
      );
      await sleep(RETRY_DELAY_MS);
      return apiFetch(url, options, attempt + 1);
    }

    return res;
  }

  return { apiFetch, BASE_URL };
}

module.exports = { createApiClient };
