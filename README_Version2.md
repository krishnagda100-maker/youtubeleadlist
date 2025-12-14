```markdown
# YouTube Lead Scraper (YouTube Data API) for Apify

This Apify actor discovers YouTube channels and filters them using the YouTube Data API v3. It is designed for finding coaches/creators that match specific signals such as average views, recent activity, and keyword matching — safely and reliably via the official API.

IMPORTANT: This actor requires a valid YouTube Data API v3 key (input.apiKey). Using the API is the recommended, TOS-compliant approach.

## What this actor does
- Discovers channels from seed channels and/or search queries.
- Uses `channels.list` to get channel snippet, statistics, and uploads playlist.
- Fetches recent videos from the uploads playlist and uses `videos.list` to get view counts and durations.
- Computes average views over a recent sample and applies the following filters (configurable):
  - minSubscribers
  - avgViewsMin / avgViewsMax
  - require at least one video posted within N days (30/60/90/180 or disabled)
  - no shorts allowed (configurable)
  - include and exclude keyword lists
  - optional country filter
- Outputs matching channel records to the default dataset and saves full output in the `OUTPUT` key-value store.

## Why use the Data API?
- Reliable, stable, and complies with YouTube's API Terms of Service.
- Accurate subscriber counts, view counts, video durations, and publish dates.
- Requires an API key and respects quota limits.

## Files
- main.js — actor code (requires input.apiKey)
- package.json — dependencies
- README.md — this file

## Example input (Apify run input)
```json
{
  "apiKey": "YOUR_YOUTUBE_DATA_API_KEY",
  "minSubscribers": 10000,
  "avgViewsMin": 5000,
  "avgViewsMax": 20000,
  "recentVideoWithinDays": 30,
  "sampleSize": 12,
  "allowShorts": false,
  "includeKeywords": ["coach", "coaching", "life coach", "business coach", "trading coach", "real estate coach"],
  "excludeKeywords": ["entrepreneur", "marketing", "guru", "agency", "funnel", "growth", "7-figure"],
  "country": "",
  "maxChannels": 200,
  "seedChannels": [
    "UCxxxxxxxxxxxxxxxxxxxxxx",
    "https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx"
  ],
  "searchQueries": [
    "trading coach youtube",
    "real estate coaching youtube",
    "programming coach youtube"
  ],
  "sleepMs": 200,
  "verbose": true
}
```

## Recommended workflow & safety
1. Create a Google Cloud project and enable the YouTube Data API v3.
2. Create an API key (restrict it by HTTP referrer or IP if possible).
3. Start with conservative defaults (sampleSize 6–12, sleepMs 200–500, maxChannels 100).
4. Monitor quota usage in Google Cloud Console. videos.list and playlistItems.list are the main consumers.
5. If you need to scale to thousands of channels, consider batching, caching, and request pacing; monitor quota and add exponential backoff handling.

## Notes & suggestions
- If subscriber counts are hidden for some channels (hiddenSubscriberCount), the actor currently skips channels when minSubscribers > 0. You can change that behavior in main.js to treat hidden counts more permissively.
- Avg views is computed over the most recent `sampleSize` videos. You can change `sampleSize` in input.
- Shorts detection uses video duration < 60s heuristic. If you want to allow some shorts, set `allowShorts: true`.
- Keyword lists: includeKeywords acts as a whitelist (if provided, at least one must match). excludeKeywords acts as a blacklist.
- For better "coaching" detection, expand includeKeywords with common coaching phrases, links to coaching landing pages, or check for Calendly/booking links (requires scraping About page; not implemented here).

## Next steps I can do for you
- Add channel About-page scraping fallback to detect coaching links (Calendly, website) for stronger coaching-signal detection.
- Add optional fallback Playwright scraping when API data is insufficient.
- Add parallelization with careful quota management, and resumable runs with caching to avoid re-querying channels.

## Running locally (for testing)
1. Install dependencies:
   npm install

2. Run:
   node main.js
   (Provide input via Apify.run or modify main.js to set a local `input` variable for testing.)

## Final notes
This actor is intended to be safe and API-first. It avoids scraping YouTube's front-end HTML to reduce fragility and policy risk. Monitor your API quota and adjust `sampleSize`, `maxChannels`, and `sleepMs` accordingly.

If you want, I can now:
- Add the About-page scraping fallback to detect coaching offers (Calendly, website links).
- Add more sophisticated heuristics (median views, outlier trimming).
- Tune the keyword lists for you if you provide a few example channels you consider "good leads."

```