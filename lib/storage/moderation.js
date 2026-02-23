/**
 * Moderation storage operations (mute/block)
 * @module storage/moderation
 */

/**
 * Add a muted URL or keyword
 * @param {object} collections - MongoDB collections
 * @param {object} data - Mute data
 * @param {string} [data.url] - Actor URL to mute (mutually exclusive with keyword)
 * @param {string} [data.keyword] - Keyword to mute (mutually exclusive with url)
 * @returns {Promise<object>} Created mute entry
 */
export async function addMuted(collections, { url, keyword }) {
  const { ap_muted } = collections;

  if (!url && !keyword) {
    throw new Error("Either url or keyword must be provided");
  }

  if (url && keyword) {
    throw new Error("Cannot mute both url and keyword in same entry");
  }

  // Only include the field that's set — avoids null values that conflict
  // with sparse unique indexes
  const entry = { mutedAt: new Date().toISOString() };
  if (url) entry.url = url;
  if (keyword) entry.keyword = keyword;

  // Upsert to avoid duplicates
  const filter = url ? { url } : { keyword };
  await ap_muted.updateOne(filter, { $setOnInsert: entry }, { upsert: true });

  return await ap_muted.findOne(filter);
}

/**
 * Remove a muted URL or keyword
 * @param {object} collections - MongoDB collections
 * @param {object} data - Mute identifier
 * @param {string} [data.url] - Actor URL to unmute
 * @param {string} [data.keyword] - Keyword to unmute
 * @returns {Promise<object>} Delete result
 */
export async function removeMuted(collections, { url, keyword }) {
  const { ap_muted } = collections;

  const filter = {};
  if (url) {
    filter.url = url;
  } else if (keyword) {
    filter.keyword = keyword;
  } else {
    throw new Error("Either url or keyword must be provided");
  }

  return await ap_muted.deleteOne(filter);
}

/**
 * Get all muted URLs
 * @param {object} collections - MongoDB collections
 * @returns {Promise<string[]>} Array of muted URLs
 */
export async function getMutedUrls(collections) {
  const { ap_muted } = collections;
  const entries = await ap_muted.find({ url: { $ne: null } }).toArray();
  return entries.map((entry) => entry.url);
}

/**
 * Get all muted keywords
 * @param {object} collections - MongoDB collections
 * @returns {Promise<string[]>} Array of muted keywords
 */
export async function getMutedKeywords(collections) {
  const { ap_muted } = collections;
  const entries = await ap_muted.find({ keyword: { $ne: null } }).toArray();
  return entries.map((entry) => entry.keyword);
}

/**
 * Check if a URL is muted
 * @param {object} collections - MongoDB collections
 * @param {string} url - URL to check
 * @returns {Promise<boolean>} True if muted
 */
export async function isUrlMuted(collections, url) {
  const { ap_muted } = collections;
  const entry = await ap_muted.findOne({ url });
  return !!entry;
}

/**
 * Check if content contains muted keywords
 * @param {object} collections - MongoDB collections
 * @param {string} content - Content text to check
 * @returns {Promise<boolean>} True if contains muted keyword
 */
export async function containsMutedKeyword(collections, content) {
  const keywords = await getMutedKeywords(collections);
  const lowerContent = content.toLowerCase();

  return keywords.some((keyword) => lowerContent.includes(keyword.toLowerCase()));
}

/**
 * Add a blocked actor URL
 * @param {object} collections - MongoDB collections
 * @param {string} url - Actor URL to block
 * @returns {Promise<object>} Created block entry
 */
export async function addBlocked(collections, url) {
  const { ap_blocked } = collections;

  const entry = {
    url,
    blockedAt: new Date().toISOString(),
  };

  // Upsert to avoid duplicates
  await ap_blocked.updateOne({ url }, { $setOnInsert: entry }, { upsert: true });

  return await ap_blocked.findOne({ url });
}

/**
 * Remove a blocked actor URL
 * @param {object} collections - MongoDB collections
 * @param {string} url - Actor URL to unblock
 * @returns {Promise<object>} Delete result
 */
export async function removeBlocked(collections, url) {
  const { ap_blocked } = collections;
  return await ap_blocked.deleteOne({ url });
}

/**
 * Get all blocked URLs
 * @param {object} collections - MongoDB collections
 * @returns {Promise<string[]>} Array of blocked URLs
 */
export async function getBlockedUrls(collections) {
  const { ap_blocked } = collections;
  const entries = await ap_blocked.find({}).toArray();
  return entries.map((entry) => entry.url);
}

/**
 * Check if a URL is blocked
 * @param {object} collections - MongoDB collections
 * @param {string} url - URL to check
 * @returns {Promise<boolean>} True if blocked
 */
export async function isUrlBlocked(collections, url) {
  const { ap_blocked } = collections;
  const entry = await ap_blocked.findOne({ url });
  return !!entry;
}

/**
 * Get list of all muted entries (URLs and keywords)
 * @param {object} collections - MongoDB collections
 * @returns {Promise<object[]>} Array of mute entries
 */
export async function getAllMuted(collections) {
  const { ap_muted } = collections;
  return await ap_muted.find({}).toArray();
}

/**
 * Get list of all blocked entries
 * @param {object} collections - MongoDB collections
 * @returns {Promise<object[]>} Array of block entries
 */
export async function getAllBlocked(collections) {
  const { ap_blocked } = collections;
  return await ap_blocked.find({}).toArray();
}

/**
 * Get moderation filter mode ("hide" or "warn").
 * "hide" removes filtered items from timeline entirely (default).
 * "warn" shows them behind a content-warning toggle.
 * Blocked actors are ALWAYS hidden regardless of mode.
 * @param {object} collections - MongoDB collections (needs ap_profile)
 * @returns {Promise<string>} "hide" or "warn"
 */
export async function getFilterMode(collections) {
  const { ap_profile } = collections;
  if (!ap_profile) return "hide";
  const profile = await ap_profile.findOne({});
  return profile?.moderationFilterMode || "hide";
}

/**
 * Set moderation filter mode.
 * @param {object} collections - MongoDB collections (needs ap_profile)
 * @param {string} mode - "hide" or "warn"
 */
export async function setFilterMode(collections, mode) {
  const { ap_profile } = collections;
  if (!ap_profile) return;
  const valid = mode === "warn" ? "warn" : "hide";
  await ap_profile.updateOne({}, { $set: { moderationFilterMode: valid } });
}
