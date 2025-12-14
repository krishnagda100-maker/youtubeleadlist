// Apify actor main.js (YouTube Data API version)
// Description: Discover YouTube channels (coaching-focused) and filter them using the YouTube Data API v3.
// Saves results to the default dataset and OUTPUT key-value store.
//
// Required input (see README.md for full input example):
// - apiKey: YouTube Data API v3 key (required)
//
// Optional inputs (defaults shown):
// - minSubscribers: 1000
// - avgViewsMin: 0
// - avgViewsMax: null
// - recentVideoWithinDays: 30 (set to 0 to disable recent-video requirement)
// - sampleSize: 12 (number of recent videos to use when computing avgViews)
// - allowShorts: false
// - includeKeywords: [] (if non-empty, require at least one include keyword match in channel or recent video title/description)
// - excludeKeywords: ["entrepreneur", "marketing", "guru", "growth", "7-figure", "funnel", "agency"]
// - country: "" (optional)
// - maxChannels: 200
// - seedChannels: [] (channel IDs or full URLs or custom names — will be normalized when possible)
// - searchQueries: [] (text queries to find channels via search.list type=channel)
// - headless: true (not used here, left for parity)
// - sleepMs: 200 (delay between API calls to be gentle on quota)
// - verbose: true
//
// Notes:
// - This actor uses only the YouTube Data API v3. It does NOT scrape YouTube pages.
// - Provide a valid API key in input; without it the actor will abort safely.
// - The actor uses playlistItems.list and videos.list in batches to compute avg views and other metrics.
// - Shorts detection: videos with duration < 60s are considered shorts.
// - Safety: rate-limited by sleepMs and small default sampleSize. Adjust for larger runs and monitor quota.

const Apify = require('apify');

const { log, sleep } = Apify.utils;

Apify.main(async () => {
    const input = (await Apify.getInput()) || {};
    const {
        apiKey,
        minSubscribers = 1000,
        avgViewsMin = 0,
        avgViewsMax = null,
        recentVideoWithinDays = 30,
        sampleSize = 12,
        allowShorts = false,
        includeKeywords = [],
        excludeKeywords = ['entrepreneur', 'marketing', 'guru', 'growth', '7-figure', 'funnel', 'agency'],
        country = '',
        maxChannels = 200,
        seedChannels = [],
        searchQueries = [],
        sleepMs = 200,
        verbose = true,
    } = input;

    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
        log.error('You must provide a valid YouTube Data API key in the input as "apiKey".');
        throw new Error('Missing YouTube Data API key (input.apiKey)');
    }

    // Lightweight fetch wrapper (supports Node 18+ global fetch or node-fetch)
    const fetchLib = (global.fetch) ? global.fetch.bind(global) : require('node-fetch');

    function logv(...args) {
        if (verbose) log.info(...args);
    }

    // Helper: normalize channel identifier into a channelId if possible
    // Accepts: full channel URL (https://www.youtube.com/channel/UC...), custom handle/vanity (c/ or user/),
    // or raw channel ID (UC...).
    function normalizeChannelIdOrUrl(item) {
        if (!item) return null;
        const s = item.trim();
        // If it's a channel id (starts with UC)
        if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return s;
        // URL patterns
        try {
            const url = new URL(s);
            const parts = url.pathname.split('/').filter(Boolean);
            // /channel/<id>
            if (parts[0] === 'channel' && parts[1]) return parts[1];
            // /user/<name> or /c/<name> or /@handle
            // For user/c/custom names, we will return the original URL to try search discovery
            return s;
        } catch (e) {
            // not a URL; maybe a custom name -> return as-is
            return s;
        }
    }

    // Parse ISO 8601 duration like PT1H2M30S -> seconds
    function isoDurationToSeconds(iso) {
        if (!iso || typeof iso !== 'string') return 0;
        const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
        if (!m) return 0;
        const hours = parseInt(m[1] || '0', 10);
        const minutes = parseInt(m[2] || '0', 10);
        const seconds = parseInt(m[3] || '0', 10);
        return hours * 3600 + minutes * 60 + seconds;
    }

    // Utility: call YouTube Data API endpoints and return JSON, with basic retry/backoff
    async function youtubeApiRequest(path, params = {}, maxRetries = 3) {
        const base = 'https://www.googleapis.com/youtube/v3';
        params.key = apiKey;
        const qs = new URLSearchParams(params);
        const url = `${base}/${path}?${qs.toString()}`;

        let attempt = 0;
        while (attempt <= maxRetries) {
            try {
                const res = await fetchLib(url, {
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': 'apify-youtube-lead-scraper/1.0 (+apify)',
                    },
                    timeout: 30000,
                });
                if (!res.ok) {
                    const text = await res.text();
                    const msg = `YouTube API error ${res.status}: ${text}`;
                    // For 403/429, backoff and retry a few times
                    if (res.status === 403 || res.status === 429) {
                        attempt++;
                        const wait = 1000 * Math.pow(2, attempt);
                        log.warning(msg + ` — retrying after ${wait}ms (attempt ${attempt})`);
                        await sleep(wait);
                        continue;
                    }
                    throw new Error(msg);
                }
                const json = await res.json();
                return json;
            } catch (err) {
                attempt++;
                if (attempt > maxRetries) {
                    throw err;
                }
                const wait = 1000 * Math.pow(2, attempt);
                log.warning(`youtubeApiRequest failed, attempt ${attempt}. Waiting ${wait}ms. Error: ${err.message}`);
                await sleep(wait);
            }
        }
    }

    // Search for channels by query using search.list&type=channel
    async function discoverChannelsBySearch(query, maxResults = 50) {
        const out = [];
        try {
            const resp = await youtubeApiRequest('search', {
                part: 'snippet',
                q: query,
                type: 'channel',
                maxResults: Math.min(maxResults, 50),
            });
            if (resp && resp.items) {
                for (const it of resp.items) {
                    const channelId = it.snippet?.channelId || (it?.id?.channelId);
                    if (channelId) out.push(channelId);
                }
            }
            await sleep(sleepMs);
        } catch (e) {
            log.warning('discoverChannelsBySearch failed', { query, error: e.message });
        }
        return out;
    }

    // Get channel details for a list of channelIds (comma-separated up to 50)
    async function getChannelsDetails(channelIds = []) {
        if (!channelIds.length) return [];
        const resp = await youtubeApiRequest('channels', {
            part: 'snippet,statistics,contentDetails',
            id: channelIds.join(','),
            maxResults: channelIds.length,
        });
        await sleep(sleepMs);
        return resp.items || [];
    }

    // Get recent video IDs from an uploads playlist (playlistId) up to 'limit'
    async function getPlaylistVideoIds(playlistId, limit = 50) {
        const ids = [];
        let pageToken = null;
        try {
            do {
                const resp = await youtubeApiRequest('playlistItems', {
                    part: 'contentDetails,snippet',
                    playlistId,
                    maxResults: Math.min(50, limit - ids.length),
                    pageToken: pageToken || undefined,
                });
                const items = resp.items || [];
                for (const it of items) {
                    if (it.contentDetails && it.contentDetails.videoId) ids.push(it.contentDetails.videoId);
                    if (ids.length >= limit) break;
                }
                pageToken = resp.nextPageToken;
                await sleep(sleepMs);
            } while (pageToken && ids.length < limit);
        } catch (e) {
            log.warning('getPlaylistVideoIds error', { playlistId, error: e.message });
        }
        return ids;
    }

    // Get video details (statistics, contentDetails, snippet) for up to 50 ids per call
    async function getVideosDetails(videoIds = []) {
        const all = [];
        const chunkSize = 50;
        for (let i = 0; i < videoIds.length; i += chunkSize) {
            const chunk = videoIds.slice(i, i + chunkSize);
            try {
                const resp = await youtubeApiRequest('videos', {
                    part: 'snippet,statistics,contentDetails',
                    id: chunk.join(','),
                    maxResults: chunk.length,
                });
                if (resp && resp.items) all.push(...resp.items);
            } catch (e) {
                log.warning('getVideosDetails chunk failed', { error: e.message, chunkLength: chunk.length });
            }
            await sleep(sleepMs);
        }
        return all;
    }

    // Helper: check keyword lists against text fields
    function textMatchesKeywords(text = '', keywords = []) {
        if (!keywords || !keywords.length) return false;
        const t = (text || '').toLowerCase();
        for (const kw of keywords) {
            if (!kw) continue;
            if (t.includes(kw.toLowerCase())) return true;
        }
        return false;
    }

    // Collect candidate channel IDs from seedChannels and searchQueries
    const candidateChannelIds = new Set();

    // From seed channels
    for (const s of seedChannels || []) {
        const normalized = normalizeChannelIdOrUrl(s);
        if (!normalized) continue;
        if (/^UC[A-Za-z0-9_-]{20,}$/.test(normalized)) {
            candidateChannelIds.add(normalized);
        } else {
            // If it's a URL or custom name, try to resolve via search (channel title or custom name)
            // Use search.list with query = the seed string
            try {
                const found = await discoverChannelsBySearch(normalized, 5);
                for (const fid of found) candidateChannelIds.add(fid);
            } catch (e) { /* ignore */ }
        }
    }

    // From search queries
    for (const q of searchQueries || []) {
        const ids = await discoverChannelsBySearch(q, 50);
        for (const id of ids) candidateChannelIds.add(id);
    }

    logv('Initial candidate channel count:', candidateChannelIds.size);

    const results = [];
    const processed = new Set();
    const channelIdsArray = Array.from(candidateChannelIds).slice(0, Math.max(maxChannels, 0));

    // If we have fewer candidates than maxChannels, we will try to expand later using related channels from channels' topicDetails or related playlists.
    for (let idx = 0; idx < channelIdsArray.length && results.length < maxChannels; idx++) {
        const channelId = channelIdsArray[idx];
        if (processed.has(channelId)) continue;
        processed.add(channelId);

        try {
            const channelDetailsArr = await getChannelsDetails([channelId]);
            if (!channelDetailsArr || !channelDetailsArr.length) {
                log.warning('No channel details returned', { channelId });
                continue;
            }
            const ch = channelDetailsArr[0];
            const snippet = ch.snippet || {};
            const statistics = ch.statistics || {};
            const contentDetails = ch.contentDetails || {};
            const topicDetails = ch.topicDetails || {};

            const channelTitle = snippet.title || '';
            const channelDescription = snippet.description || '';
            const channelCountry = snippet.country || '';
            const subscriberCount = statistics.hiddenSubscriberCount ? null : (statistics.subscriberCount ? parseInt(statistics.subscriberCount, 10) : null);
            const uploadsPlaylistId = contentDetails.relatedPlaylists ? contentDetails.relatedPlaylists.uploads : null;
            const channelUrl = `https://www.youtube.com/channel/${channelId}`;

            // Country filter if specified
            if (country && channelCountry) {
                if (!channelCountry.toLowerCase().includes(country.toLowerCase())) {
                    logv('Skipping due to country mismatch', { channelTitle, channelCountry });
                    continue;
                }
            } else if (country && !channelCountry) {
                // If user requested a country but channel has no country metadata, skip (safer)
                logv('Skipping because country requested but not found on channel', { channelTitle });
                continue;
            }

            // Subscriber filter (if subscriberCount null because hidden, we treat conservatively: skip if minSubscribers > 0)
            if (subscriberCount !== null) {
                if (subscriberCount < minSubscribers) {
                    logv('Skipping due to subscriber count below min', { channelTitle, subscriberCount });
                    continue;
                }
            } else {
                if (minSubscribers > 0) {
                    logv('Skipping because subscriber count is hidden and minSubscribers > 0', { channelTitle });
                    continue;
                }
            }

            // If no uploads playlist id, skip
            if (!uploadsPlaylistId) {
                logv('No uploads playlist; skipping channel', { channelTitle });
                continue;
            }

            // Get recent video IDs from uploads playlist (we'll fetch sampleSize most recent)
            const videoIds = await getPlaylistVideoIds(uploadsPlaylistId, sampleSize);
            if (!videoIds || !videoIds.length) {
                logv('No recent videos found; skipping', { channelTitle });
                continue;
            }

            // Get video details
            const videos = await getVideosDetails(videoIds);
            if (!videos || !videos.length) {
                logv('No video details; skipping', { channelTitle });
                continue;
            }

            // Sort videos by publishedAt descending
            videos.sort((a, b) => new Date(b.snippet.publishedAt) - new Date(a.snippet.publishedAt));
            const sampleVideos = videos.slice(0, sampleSize);

            // Compute average views (use viewCount; if missing treat as 0)
            const viewCounts = sampleVideos.map(v => {
                const vc = v.statistics && v.statistics.viewCount ? parseInt(v.statistics.viewCount, 10) : 0;
                return isNaN(vc) ? 0 : vc;
            });
            const avgViews = viewCounts.length ? Math.round(viewCounts.reduce((a, b) => a + b, 0) / viewCounts.length) : 0;

            // Recent video within timeframe check
            let hasRecentWithin = true;
            if (recentVideoWithinDays && recentVideoWithinDays > 0) {
                const thresholdDate = new Date(Date.now() - recentVideoWithinDays * 24 * 3600 * 1000);
                hasRecentWithin = sampleVideos.some(v => new Date(v.snippet.publishedAt) >= thresholdDate);
            }

            if (!hasRecentWithin) {
                logv('Skipping due to no recent video within timeframe', { channelTitle });
                continue;
            }

            // Shorts detection: consider a video short if duration < 60s or url suggests /shorts/
            const shortFlags = sampleVideos.map(v => {
                const dur = v.contentDetails && v.contentDetails.duration ? isoDurationToSeconds(v.contentDetails.duration) : 0;
                const title = v.snippet && v.snippet.title ? v.snippet.title.toLowerCase() : '';
                // Basic heuristics: duration < 60s or "short" in title or content is in shorts format
                return (dur > 0 && dur < 60) || title.includes('short') || false;
            });
            const shortCount = shortFlags.filter(Boolean).length;
            const shortsRatio = sampleVideos.length ? (shortCount / sampleVideos.length) : 0;

            if (!allowShorts && shortsRatio > 0) {
                logv('Skipping due to shorts present in recent videos', { channelTitle, shortsRatio });
                continue;
            }

            // Keyword include/exclude checks across channel title/description and sample video titles/descriptions
            const combinedTextParts = [
                channelTitle,
                channelDescription,
                ...sampleVideos.map(v => (v.snippet && (v.snippet.title + ' ' + (v.snippet.description || ''))) || '')
            ];
            const combinedText = combinedTextParts.join(' ').toLowerCase();

            // Exclude on negative keywords
            let excluded = false;
            if (excludeKeywords && excludeKeywords.length) {
                for (const kw of excludeKeywords) {
                    if (!kw) continue;
                    if (combinedText.includes(kw.toLowerCase())) {
                        excluded = true;
                        break;
                    }
                }
                if (excluded) {
                    logv('Excluded by negative keyword', { channelTitle });
                    continue;
                }
            }

            // Include on positive keywords if provided; if none provided, allow all that pass other filters
            let includedByKeyword = true;
            if (includeKeywords && includeKeywords.length) {
                includedByKeyword = false;
                for (const kw of includeKeywords) {
                    if (!kw) continue;
                    if (combinedText.includes(kw.toLowerCase())) {
                        includedByKeyword = true;
                        break;
                    }
                }
                if (!includedByKeyword) {
                    logv('Skipping because includeKeywords supplied but none matched', { channelTitle });
                    continue;
                }
            }

            // avgViews filter
            if (avgViews < avgViewsMin) {
                logv('Skipping due to avgViews below min', { channelTitle, avgViews, avgViewsMin });
                continue;
            }
            if (avgViewsMax !== null && typeof avgViewsMax === 'number' && avgViews > avgViewsMax) {
                logv('Skipping due to avgViews above max', { channelTitle, avgViews, avgViewsMax });
                continue;
            }

            // Passed filters — assemble output record
            const record = {
                channelId,
                channelName: channelTitle,
                channelUrl,
                subscriberCount: subscriberCount,
                avgViews,
                sampleSize: sampleVideos.length,
                shortsRatio,
                recentVideoWithinDays,
                includeKeywords,
                excludeKeywords,
                country: channelCountry || '',
                description: channelDescription,
                lastScrapedAt: new Date().toISOString(),
                sampleVideos: sampleVideos.map(v => ({
                    videoId: v.id,
                    title: v.snippet && v.snippet.title,
                    publishedAt: v.snippet && v.snippet.publishedAt,
                    viewCount: v.statistics && v.statistics.viewCount ? parseInt(v.statistics.viewCount, 10) : 0,
                    durationSeconds: v.contentDetails && v.contentDetails.duration ? isoDurationToSeconds(v.contentDetails.duration) : 0,
                    url: `https://www.youtube.com/watch?v=${v.id}`,
                })),
            };

            results.push(record);
            await Apify.pushData(record);
            logv('Saved channel', { channelTitle, channelId, avgViews, subscriberCount });

            // Optionally, expand discovery: use topicDetails or related playlists to find more channels
            // topicDetails.topicCategories may point to related areas; not used here for simplicity

        } catch (err) {
            log.warning('Error processing channel', { channelId, error: err.message });
        }

        // Be polite with API usage
        await sleep(sleepMs);
    }

    // Save summary OUTPUT
    const output = {
        info: {
            collected: results.length,
            timestamp: new Date().toISOString(),
            filters: {
                minSubscribers,
                avgViewsMin,
                avgViewsMax,
                recentVideoWithinDays,
                sampleSize,
                allowShorts,
                includeKeywords,
                excludeKeywords,
                country,
            },
            maxChannels,
            seedChannels: seedChannels.length,
            searchQueries: searchQueries.length,
        },
        results,
    };

    await Apify.setValue('OUTPUT', output, { contentType: 'application/json' });
    log.info('Finished run', { collected: results.length });
});