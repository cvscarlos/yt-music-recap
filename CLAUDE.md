# yt-music-recap

Read `DECISIONS.md` before proposing a change. It records what has already been tried, measured and rejected — weighted ranking, keyword-based version matching, title-based artist lookup, a database, every dependency considered. Most suggestions this project attracts are in there with the evidence against them.

`README.md` is a product page for people deciding whether to use this. Keep implementation detail out of it.

The tool runs twice for a full result: `recap.ts` ranks and writes `out/`, `enrich.ts` reads `out/` and asks YouTube about the tracks that charted, then `recap.ts` runs again to apply what it learned. `export.ts` creates the playlist. See the header of `recap.ts`.

`npm run check` runs the type check and all three self-tests, and is wired to pre-commit and pre-push.
