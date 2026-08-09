<h1 align="center">YOUTUBE MUSIC RECAP</h1>

<p align="center"><strong>Get back the YouTube Music Recap playlists you lost.</strong></p>

Every December, YouTube Music hands you a Recap. Then the year turns, and it's gone — the playlist, the rankings, the whole thing. There's no archive and no way to ask for last year's.

Your listening history still exists, though. This rebuilds any Recap from it: a year, a half, a season, or any range of dates you name. 2023. Summer 2022. The first half of 2025.

It runs on your machine, needs no account, and installs nothing.

## What it looks like

```
# 2025 Recap — top 100

14208 YouTube Music listens across 5310 tracks, 2025-01-01 to 2025-12-31.
Excludes 2117 skips — tracks abandoned within 60s.

These 100 tracks alone account for 103 hours of listening.

| # | Track                          | Artist            | Plays | Minutes |
| 1 | Harbour Lights *(2 versions)*  | The Paper Kites   |    48 |     154 |
| 2 | Midnight Static                | Rosewater         |    41 |     139 |
| 3 | Held                           | Marisa Lange      |    35 |      97 |
| 4 | Cortina                        | Bruno Vilares     |    29 |     104 |
```

Every track keeps its video ID, so the list turns straight into a real playlist.

## What makes the numbers right

**Skips don't count as plays.** A track you abandoned after eight seconds isn't a track you listened to.

**Every version of a song counts as that song.** The studio take, the live take and the reissue are one entry, credited to whichever version you actually played — not three rivals splitting the votes.

**Artists are the real ones.** Where YouTube says `Release`, or nothing at all, you get the name the label credited. A small band never loses its songs to a famous act with the same name.

**Nothing is invented.** Your top track is the one you played most. No weighting, no taste model, no opinion about what you *really* liked.

**Any language.** Portuguese, German, Japanese — the ranking doesn't care.

## Get your recap

**1. Export your history.** At [Google Takeout](https://takeout.google.com): *Deselect all* → **YouTube and YouTube Music** → under *All YouTube data included* keep only **history** → under *Multiple formats* set history to **JSON**. Export, then unzip what arrives. You want `watch-history.json`.

**2. Run it.**

```bash
node recap.ts watch-history.json 2025
```

**3. Open `out/`.** Your recap is there as a readable list, as data, and as a playlist link.

That's it. No install, no sign-up, no build step. Needs Node 22.18 or newer.

### Any period you like

```bash
node recap.ts watch-history.json 2023                      # a year
node recap.ts watch-history.json h1-2025                   # a half
node recap.ts watch-history.json q3-2024                   # a quarter
node recap.ts watch-history.json summer-2023               # a season
node recap.ts watch-history.json 2023-06-01..2023-08-31    # any range
```

Add a number to change the length: `node recap.ts watch-history.json 2025 50`.

Google caps each export, so a history reaching further back means several of them. List them together and they merge, duplicates and all:

```bash
node recap.ts watch-history-2024.json,watch-history-2026.json 2025
```

## Turn it into a playlist

Open `out/2025.playlist.html` and follow the link while signed in to YouTube. It builds the playlist for you, ready to save.

No API key, no OAuth, no Google Cloud project, no quota. Fifty tracks.

Music is licensed country by country, and YouTube hides whatever isn't licensed where you are — a playlist can arrive quietly missing a dozen songs. Set `RECAP_REGION` in `.env` to the country you watch from and those are swapped out for the next tracks down, so you get fifty that play.

The list this makes is a temporary one, which YouTube will play but won't let you keep. For a permanent playlist in your own account:

```bash
node export.ts 2025
node export.ts 2025 --title="My 2025" --public
```

It's created private, named after the period, and it's yours — no length limit and nothing to save by hand. This one needs sign-in rather than just a key, so add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.env` (see the sample) and approve it in the browser once.

Google allows 10,000 quota units a day and each track costs 50, so **a hundred tracks is half your daily allowance** and two full attempts will exhaust it. If a run stops partway, don't start again — finish the one you have:

```bash
node export.ts 2025 --into=PLxxxxxxxxxxxx
```

That adds only what's missing, at the right position, so it costs the tracks left rather than all of them. The playlist id is in its URL, and the command is printed for you when quota runs out. The allowance resets at midnight US Pacific, not your midnight.

Tracks not licensed where you are still go in, so they appear by themselves if that ever changes; YouTube hides them meanwhile. Add `--playable-only` if you'd rather have a playlist that runs straight through.

## Better artists, and listening time

Optional, and worth it. With a free YouTube API key, every track gets the artist its label credited and the recap can tell you hours listened rather than only play counts.

```bash
cp .env.sample .env      # then paste your key in
node enrich.ts
node recap.ts watch-history.json 2025
```

Getting the key takes about a minute — create a project at [console.cloud.google.com](https://console.cloud.google.com), enable **YouTube Data API v3**, then make an **API key** at `https://console.cloud.google.com/apis/credentials?project=<project-id>`. It's a plain API key, so there's no consent screen and no app review. A whole history costs a rounding error against the free daily allowance.

## Browse your recaps

They're plain files, so anything works. To flip through them in a browser:

```bash
npx serve ./out/ -l 4900
```

## Your history stays yours

It never leaves your machine. There's no account, no server, no telemetry — the only thing that goes out is a track title or video ID when you ask for artists, and only then.

Your history, your recaps and everything derived from them are kept out of git already, so you can fork this and publish it without publishing yourself.

## Good to know

**Exports are often shorter than you expect.** Google caps them, and old history gets deleted. Every recap tells you how much of its period it actually covers, so a year built from five months says so instead of pretending.

**Only YouTube Music counts.** Music videos watched on youtube.com proper are left out, which is what Recap did too.

**Some tracks exist only on YouTube.** Mashups, meme edits and your own uploads aren't in any music catalogue. They're kept, with whatever name YouTube gave them.
