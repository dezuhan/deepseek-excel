'use strict';
/**
 * Pricing, peak-hour and cost helpers for the DeepSeek Cost Meter.
 *
 * Source of truth: `shared/pricing.json`, which mirrors
 * https://api-docs.deepseek.com/quick_start/pricing
 *   - prices are USD per 1M tokens
 *   - peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday
 *   - off-peak rates are half of the peak rates
 */
const fs = require('fs');

function loadPricing(file) {
  const pricing = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!pricing.models || !pricing.peakWindowsUtc) throw new Error('shared/pricing.json is incomplete');
  return pricing;
}

function minutesOfClock(value) {
  const [hours, minutes] = String(value).split(':').map((part) => Number.parseInt(part, 10));
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0);
}

/** True when the given UTC instant falls inside a peak window on a peak weekday. */
function isPeakAt(pricing, date) {
  const weekday = date.getUTCDay();
  if (!pricing.peakWeekdaysUtc.includes(weekday)) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return pricing.peakWindowsUtc.some(
    (window) => minutes >= minutesOfClock(window.start) && minutes < minutesOfClock(window.end),
  );
}

/**
 * Current peak status plus the next transition, computed by walking forward minute by minute
 * (at most 8 days) so it stays correct across weekends and window boundaries.
 */
function peakStatus(pricing, now = new Date()) {
  const isPeak = isPeakAt(pricing, now);
  const cursor = new Date(now.getTime());
  cursor.setUTCSeconds(0, 0);
  let nextChange = null;
  for (let minute = 1; minute <= 60 * 24 * 8; minute += 1) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    if (isPeakAt(pricing, cursor) !== isPeak) {
      nextChange = new Date(cursor.getTime());
      break;
    }
  }
  return {
    isPeak,
    multiplier: isPeak ? 1 : pricing.offPeakMultiplier,
    peakWindowsUtc: pricing.peakWindowsUtc,
    peakWeekdaysUtc: pricing.peakWeekdaysUtc,
    nextChangeIso: nextChange ? nextChange.toISOString() : null,
    nextChangeInMinutes: nextChange ? Math.round((nextChange.getTime() - now.getTime()) / 60000) : null,
    checkedAtIso: now.toISOString(),
  };
}

/** Per-1M-token prices for the model at the current peak state. */
function priceFor(pricing, modelId, isPeak) {
  const model = pricing.models[modelId];
  if (!model) return null;
  const multiplier = isPeak ? 1 : pricing.offPeakMultiplier;
  return {
    model: modelId,
    label: model.label || modelId,
    currency: pricing.currency,
    unit: pricing.unit,
    inputCacheHit: model.inputCacheHit * multiplier,
    inputCacheMiss: model.inputCacheMiss * multiplier,
    output: model.output * multiplier,
    peak: isPeak,
    peakMultiplier: multiplier,
  };
}

/**
 * Cost of one request in USD.
 * Accepts DeepSeek usage objects (`prompt_tokens`, `completion_tokens`,
 * `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`).
 */
function estimateCost(pricing, modelId, usage, isPeak) {
  const model = pricing.models[modelId];
  if (!model || !usage) return null;
  const promptTokens = Number(usage.prompt_tokens ?? usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completion_tokens ?? usage.completionTokens ?? 0);
  const cacheHitRaw = usage.prompt_cache_hit_tokens ?? usage.promptCacheHitTokens;
  const cacheMissRaw = usage.prompt_cache_miss_tokens ?? usage.promptCacheMissTokens;
  const cacheHit = Number.isFinite(Number(cacheHitRaw)) ? Number(cacheHitRaw) : 0;
  const cacheMiss = Number.isFinite(Number(cacheMissRaw)) ? Number(cacheMissRaw) : Math.max(promptTokens - cacheHit, 0);
  const multiplier = isPeak ? 1 : pricing.offPeakMultiplier;

  const inputCacheHit = (cacheHit / 1e6) * model.inputCacheHit * multiplier;
  const inputCacheMiss = (cacheMiss / 1e6) * model.inputCacheMiss * multiplier;
  const output = (completionTokens / 1e6) * model.output * multiplier;
  const total = inputCacheHit + inputCacheMiss + output;

  return {
    model: modelId,
    currency: pricing.currency,
    peak: isPeak,
    promptTokens,
    completionTokens,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    inputCost: inputCacheHit + inputCacheMiss,
    outputCost: output,
    totalCost: total,
  };
}

/** Merge several per-request usage records into one session total. */
function sumUsage(records) {
  const total = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    currency: null,
    byModel: {},
  };
  for (const record of records || []) {
    if (!record) continue;
    total.requests += 1;
    total.promptTokens += Number(record.promptTokens || 0);
    total.completionTokens += Number(record.completionTokens || 0);
    total.cacheHitTokens += Number(record.cacheHitTokens || 0);
    total.cacheMissTokens += Number(record.cacheMissTokens || 0);
    total.inputCost += Number(record.inputCost || 0);
    total.outputCost += Number(record.outputCost || 0);
    total.totalCost += Number(record.totalCost || 0);
    total.currency = record.currency || total.currency;
    const key = record.model || 'unknown';
    const bucket = total.byModel[key] || { requests: 0, promptTokens: 0, completionTokens: 0, totalCost: 0 };
    bucket.requests += 1;
    bucket.promptTokens += Number(record.promptTokens || 0);
    bucket.completionTokens += Number(record.completionTokens || 0);
    bucket.totalCost += Number(record.totalCost || 0);
    total.byModel[key] = bucket;
  }
  return total;
}

module.exports = { loadPricing, isPeakAt, peakStatus, priceFor, estimateCost, sumUsage, minutesOfClock };
