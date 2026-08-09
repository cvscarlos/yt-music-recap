# Decisions

Things that were tried, measured, and settled — kept so they aren't argued a second time. The code shows what it does; this says what it deliberately doesn't, and why.

Measurements come from one real 40,000-record export covering two years. They're evidence, not laws: remeasure before overturning one.

## Ranking is play count and nothing else

Weighted scoring — recency, listening days, repeat intensity — was implemented and measured against real history, then removed.

- Unique listening days were **identical to play count for 99.6%** of tracks (people rarely replay a song within one day), so a "listening days" tie-breaker moved **zero** positions.
- Back-to-back repeats were **1.0%** of listens, so every repetition-based signal was flat.

Recency weighting is wrong for a *historical* recap by definition: a song played 60 times in January should outrank one played 40 times in November.

## A track abandoned within 60 seconds is a skip, not a play

Takeout records no playback duration, so the gap until the next listen stands in for one. On a real year this removed ~2,500 phantom plays. It's an estimate — `--min-seconds=0` counts every event.

Deduplicate **before** measuring those gaps: duplicate records from overlapping exports share a timestamp, so a zero-second gap would disguise a genuine listen as a skip.

## Versions of a song are counted together, by brackets and not by keywords

The studio take, the live take and a reissue are one song. Version qualifiers live in brackets — `(Live In Texas)`, `(Ao Vivo)`, `(Bass Boosted)` — and **97% of live markers in a real library were bracketed**, so removing brackets separates a song from a version of it without knowing the word for "live" in any language.

A keyword list (`ao vivo|live|acustico`) was drafted and rejected: it works on the library you built it from and fails on everyone else's.

The album is deliberately **excluded** from the song key. Including it was tried first, and it puts each version under its own key — which is what merging is supposed to undo.

The most-played version represents the song, so a playlist gets the take you actually listen to. That also fails safely: a wrong merge still yields a video you played a lot.

## Artists come from YouTube's credits, never from a title search

Deezer and iTunes search by title. On 22 real lookups they were **wrong 7 times out of 10**, always in the same direction: preferring a famous artist over the smaller band that recorded it, and crediting a cover to the original songwriter.

YouTube states artist, album and duration for the exact video ID in auto-generated descriptions. That is exact, needs no human confirmation, and is what makes unattended runs safe on someone else's history.

The catalogues remain a fallback for uploads with no credits, and only when both independently agree.

Parsing anchors on the **℗ symbol and the `·` separator**, not on "Provided to YouTube by" — that prose is translated per account language.

## Fold text by Unicode category, never `[a-z0-9]`

A Latin-only filter reduces any Japanese, Cyrillic, Greek or Arabic value to an empty string. Empty strings compare equal, so unrelated titles look identical and **two different artists look like two sources agreeing** — silently writing a wrong artist through the very check meant to prevent it. This bug was introduced twice, in two different functions.

Tests asserting two values are *equal* cannot catch it, because an empty key satisfies them. Assert that **different** inputs stay different.

## A `watch_videos` link can play a recap but never save one

`https://www.youtube.com/watch_videos?video_ids=…` builds a temporary `TLGG…` playlist with no auth, no quota and no Google project. It caps at 50 videos.

That list belongs to nobody, so YouTube offers **no way to keep it** — its playlist page has share and download and nothing else. Two rounds of "click here to save it" guidance were wrong before this was established.

Keeping a playlist means creating one you own, which means acting as the account holder, which means OAuth (`export.ts`). An API key authorises reading public data and nothing more.

## Region must be stated, never inferred

Music is licensed per country and YouTube hides what isn't licensed where you are, without saying so. In one real recap **26 of 100 tracks** were unavailable.

Availability follows the **viewer's location, not the Google account's country**. This was confirmed on an account registered in one country while listening from another: the prediction for the listening location matched the number of tracks YouTube actually hid, and the prediction for the account's country did not.

Guessing the region from system locale returns the *language's* country (US for an English macOS abroad), so `RECAP_REGION` is explicit. `availability.json` records which region it was built for, so changing it invalidates the file rather than reusing stale answers.

## No database

The whole history is a few tens of thousands of records that parse in under a second, and nothing queries them in a way a scan doesn't already answer. The case a database would have served — merging overlapping exports — is handled by listing them comma-separated and reusing the existing duplicate check.

Revisit if ad-hoc queries across years, or a UI with filters, ever appear.

## No runtime dependencies

Considered and declined, each for a specific reason:

| Package | Why not |
| --- | --- |
| `leven` | `editDistance` is 12 lines with tests. A dependency to delete 12 lines is a bad trade. |
| `date-fns` | Wouldn't shrink `parsePeriod` — halves, quarters and seasons are custom logic regardless. |
| `commander` | `util.parseArgs` is stdlib since Node 18.3. |
| `zod` | One JSON shape, read defensively. |
| `googleapis` | Megabytes of generated client for a handful of `fetch` calls. |
| `better-sqlite3` | `node:sqlite` is stdlib, and there's no database. |
| `dotenv` | `process.loadEnvFile()` is stdlib. |
| `husky` | Git runs hooks from `core.hooksPath`; scored 60 with `shellAccess`. |

`typescript` and `@types/node` are dev-only. TypeScript 7 needs `"types": ["node"]` stated explicitly or it reports every import as an unknown name.

## Enrichment reads the recaps, not the history

`enrich.ts` looks up only tracks that already charted, which bounds the work to a few hundred videos instead of ten thousand.

The known cost: a song split across two videos that **both** fall below the cut-off stays split, and their combined plays never lift it into the list. Passing the history instead would fix it, at roughly one request per fifty videos.

## Playlist covers cannot be set, and are left alone

Tested against a real playlist, both ways:

- `thumbnails.set` takes a `videoId`; there is no playlist equivalent.
- `playlists.update` accepts `snippet.thumbnails` with a 200 and ignores it — the thumbnail afterwards is unchanged.

`snippet.thumbnails` on a playlist is output-only. Nothing here sets a cover, so what YouTube shows is its own default, derived from the first video; YouTube Music renders playlist art separately. There is no API lever for either, so none is attempted.

## One OAuth scope, broader than wanted

`export.ts` requests `https://www.googleapis.com/auth/youtube` and nothing else. It is used for `playlists.insert` and `playlistItems.insert`; reading metadata uses an API key and needs no scope.

Google classifies it as *sensitive*, and it permits more than creating playlists — deleting videos, for one. There is no narrower option: `playlists.insert` accepts only this, `youtube.force-ssl` (wider), or `youtubepartner`. `youtube.readonly` cannot write and `youtube.upload` covers uploads alone.

The consent screen does not enforce its scope list while the app is in Testing — the scope comes from the authorization request — so playlists are created before that list is filled in. Keep the app in Testing for personal use: publishing with a sensitive scope triggers verification, and the only cost of Testing is a refresh token that expires weekly.

## Known limits, accepted

- Personal uploads to the YouTube Music library are invisible to every official API and cannot be added to a playlist. An unofficial client (`youtubei.js`) is the only route, and carries cookie upkeep and breakage — deliberately not taken.
- OAuth refresh tokens expire every 7 days while the consent screen is in Testing. `export.ts` re-prompts automatically.
- `"Watched "` is stripped from titles in English exports only. Tracks resolved through `enrich.ts` are unaffected — their titles come from the credits.
