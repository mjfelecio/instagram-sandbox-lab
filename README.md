# Instagram Sandbox Lab

A **temporary research tool** (disposable, not a BloxClips product feature) for testing
Meta's official **Instagram API with Instagram Login** against a sandbox Business app:

1. Connect a professional Instagram account via Business Login.
2. Inspect the connected account ID, scopes, and token expiry.
3. Enumerate that account's owned media and resolve a Reel/post URL to its official media ID.
4. Fetch exact official metrics + Media Insights (views/reach/likes/comments/shares/saves/total_interactions).
5. Compare official values against a manually supplied baseline (e.g. BloxClips public scraper) to investigate precision/freshness.

Mirrors [`tiktok-sandbox-lab`](../tiktok-sandbox-lab) workflow, safety model, and ergonomics
as closely as makes sense for Meta/Instagram. Tracking issue:
`BloxClips/Bloxclips-backend#254`.

## Location and stack

- Path: `experiments/instagram-sandbox-lab` (this directory; standalone).
- TypeScript throughout; Vite + React UI; single Node (Express) server hosts both API
  and (in dev) Vite middleware, bound to loopback only.
- One independent `package.json` and lockfile; no database, Redis, Docker, Next.js, or
  production auth. No changes to BloxClips repositories.

## What provider architecture was selected and why

**Selected: Instagram API with Instagram Login (Business Login for Instagram), host
`graph.instagram.com`. DOCUMENTED.**

Why:
- Official Meta docs state this setup serves Instagram professional accounts with an
  Instagram-only presence and uses Instagram credentials — no Facebook Page required.
- The alternative (Instagram API with Facebook Login, host `graph.facebook.com`) requires
  a linked Facebook Page and Facebook credentials. Older examples default to it, but current
  docs prove the Instagram Login path supports the full read path BloxClips needs:
  account identity (`/me`), owned media (`/<IG_ID>/media`), single media
  (`/<MEDIA_ID>`), and Media Insights (`/<MEDIA_ID>/insights`) including `views`,
  `reach`, `likes`, `comments`, `shares`, `saved`, `total_interactions`.
- Media Insights for Instagram Login requires the newer permission
  `instagram_business_manage_insights` (announced Mar 2025); Advanced Access required
  to request it from non-role users. This lab requests exactly
  `instagram_business_basic,instagram_business_manage_insights` (least privilege).
- `total_*` aggregated metrics (ads-inclusive) and some fields (`media_product_type`,
  `saved_count`, `shares_count`, `caption` with @) remain Facebook-Login-only per docs.
  The lab tolerates their absence and shows `Not returned / Unavailable / Unsupported`
  instead of zero. No fallback to Facebook Login is needed for BloxClips' organic
  metrics questions.

See [`docs/instagram-provider-contract.md`](docs/instagram-provider-contract.md) and
`## Research findings / provider contract` below for the full contract with
DOCUMENTED vs LIVE VERIFIED labels.

## Professional-account requirements

- Only **Instagram professional accounts** (Business or Creator / `Media_Creator`) can
  authorize. Personal/consumer accounts cannot access owned media or Insights; the API
  returns an error and the lab surfaces it verbatim.
- No Facebook Page link is required under Instagram Login.
- In development mode (Standard Access) the app serves only accounts with a Role on the
  Meta app (or claimed business). Other accounts require Advanced Access (App Review +
  Business Verification).

The UI explicitly states: **OAuth/provider identity (`user_id`) ≠ public scraper identity**.
Do not assume any official account ID equals BloxClips' current public scraper account ID.
Username/handle is display metadata, never identity.

## Exact Meta app/dashboard setup

1. Register as a Meta developer, create a **Business**-type app.
2. Add product **Instagram > API setup with Instagram login**.
3. Complete **3. Set up Instagram business login**: note the **Instagram App ID** and
   **Instagram App Secret** (Business login settings). These map to `INSTAGRAM_APP_ID`
   and `INSTAGRAM_APP_SECRET` (never commit values).
4. In **Business login settings > OAuth redirect URIs**, add the exact URI printed by
   `npm run dev`, e.g. `https://xxxx.ngrok-free.app/auth/instagram/callback`.
   Redirect URIs must match exactly (dashboard may add a trailing slash — verify).
5. Add your professional Instagram test account under **App Roles** (or generate a token
   via API setup for your own account).
6. Request only `instagram_business_basic` + `instagram_business_manage_insights` unless
   you prove the read path needs more. Do not add messaging/publishing/ads permissions.

## Exact env variables

Copy `.env.example` to `.env.local` (git-ignored):

```env
INSTAGRAM_APP_ID=                  # Instagram App ID (Business login settings)
INSTAGRAM_APP_SECRET=              # Instagram App Secret (server-side only)
INSTAGRAM_SCOPES=instagram_business_basic,instagram_business_manage_insights
INSTAGRAM_API_VERSION=v25.0        # validated 2026-09-29; v26.0 also exists
PORT=5180                          # TikTok lab uses 5179; both can run
# INSTAGRAM_PUBLIC_ORIGIN=         # optional fixed HTTPS origin (skips ngrok)
# NGROK_DOMAIN=                    # optional reserved domain
# NGROK_API_PORT=                  # optional, default first free 4040-4049
```

## Exact callback URL behavior

- Callback path is fixed: `/auth/instagram/callback`.
- Full redirect URI = `<public-origin>/auth/instagram/callback`.
- UI and callback share the same public origin so the `HttpOnly`, `SameSite=Lax`,
  `Secure` (HTTPS) session cookie works through the tunnel.
- If the public origin changes (ngrok restart), pending OAuth states are invalidated
  and the new URI is printed — register it before reconnecting.
- Authorization codes are single-use, valid 1 hour. `state` is cryptographically random,
  session-bound, single-use, 10-min TTL, with replay detection. New authorization
  invalidates the old pending state.

## How ngrok works

`npm run dev` validates config (no secrets printed), starts the loopback server
(`127.0.0.1:5180`), then the server owns a **dedicated ngrok child process**
(`--inspect=false`, scoped agent API port 4040-4049, scoped config merged with your
default config so your authtoken is honored without copying values).

- The lab discovers **its own tunnel by upstream port** — never "first tunnel".
- It never kills, repoints, or overwrites unrelated tunnels or global ngrok config.
- Startup prints **Application URL**, **exact redirect URI**, and remaining dashboard steps.
- A loopback self-check through the public URL confirms reachability.
- Only the lab's child processes are cleaned up on `Ctrl+C`.

If `INSTAGRAM_PUBLIC_ORIGIN` is set, ngrok is skipped and that origin is used directly.

## How to connect

```sh
npm install
npm run dev
# copy printed callback URL into Meta dashboard > Business login settings > OAuth redirect URIs
# open printed Application URL in browser
```

Click **Connect Instagram**, complete login/consent. Tokens stay server-side in memory.
The header shows connection status, configured vs granted scopes, token expiry
(short 1h vs long 60d), API version, callback URL, credential state, and last
auth/refresh failures. **Clear local session** drops server memory for this browser
only; it does **not** revoke at Instagram (remove via Instagram Settings > Apps and Websites).

## How to use Account / Media / Insights / Compare

- **Tab A: Account** — `GET /me?fields=user_id,username,name,account_type,...`.
  Shows stable `user_id` (providerSubjectId candidate), app-scoped `id` (not identity),
  username, account type, follower/follows/media counts, `observedAt`. Missing values
  show `Not returned`, never zero.
- **Tab B: Owned media** — `GET /<IG_ID>/media?limit=25&after=...` (cursor pagination)
  lists IDs; **Fetch details** resolves each via `GET /<MEDIA_ID>?fields=...`
  (thumbnail, official ID, media/product type, permalink, timestamp, basic counts).
  **Resolve Reel URL / permalink** accepts `.../reel/<shortcode>/`, `/p/<shortcode>/`,
  permalink, shortcode, or numeric media ID; ID inputs resolve directly, URL inputs walk
  owned media pages (bounded, max 10 pages, explicit count). Non-matches report
  `Ownership not proven by the connected account` — never translated to
  deleted/private/fraud. **Select** a media item for Insights/Compare.
- **Tab C: Media Insights** — `GET /<MEDIA_ID>/insights?metric=...` with explicit metric
  list (default `views,reach,likes,comments,shares,saved,total_interactions`).
  Every requested metric is shown; unavailable/unsupported shows explicitly. Basic media
  fields (`like_count`, `comments_count`) are shown separately from Insights metrics.
  Full integers only, unsafe precision flagged, missing never zero.
- **Tab D: Compare** — paste baseline JSON
  `{ "mediaId": "...", "source": "BloxClips public scraper", "observedAt": null,
  "views": 123456, "likes": 1200, "comments": 50, "shares": 30, "saves": 25 }`.
  Shows official vs baseline, signed diff, % vs nonzero baseline, both observation times
  and gap. Unknown baseline time stays unknown. Export sanitized JSON.
- **Observations** at `GET /api/observations`: per-request `startedAt`/`receivedAt`,
  sanitized endpoint (tokens redacted), requested fields/metrics, HTTP status, provider
  error, sanitized raw JSON, precision warnings. No tokens/secrets/codes/cookies/headers.

## Token lifecycle

- Code exchange (`POST api.instagram.com/oauth/access_token`) yields a **short-lived**
  user token (1 hour) + `user_id` + granted permissions.
- The lab immediately upgrades to a **long-lived** token (60 days) via
  `GET graph.instagram.com/access_token?grant_type=ig_exchange_token` (server-side,
  uses app secret). If upgrade fails, the short-lived token is kept and the failure is
  shown; reconnect is not forced.
- **Refresh/Extend token** calls `GET graph.instagram.com/refresh_access_token?
  grant_type=ig_refresh_token`. Allowed only when the long-lived token is ≥24h old,
  still valid, and has `instagram_business_basic`. Success rotates the token value and
  extends 60 days. Concurrent clicks piggyback on one in-flight request (no race).
  On ambiguous transient failure the previous token is preserved until provider evidence
  says invalid (code 190 → `authorization_expired`).
- Expired (60d without refresh) or user-revoked authorization cannot be refreshed;
  reconnect via **Connect Instagram**.
- Tokens live in server memory only; restart requires reconsent.

## Scope meanings

- `instagram_business_basic` — identity (`/me`), owned media enumeration, basic media
  fields (`like_count`, `comments_count`, `permalink`, `shortcode`, `timestamp`, etc.).
- `instagram_business_manage_insights` — Media Insights (+ user Insights). Required for
  `views`, `reach`, `likes`, `comments`, `shares`, `saved`, `total_interactions`.
- `instagram_business_content_publish`, `..._manage_comments`, `..._manage_messages` —
  publishing/moderation/messaging. **Not requested** by this lab; add only if official
  docs prove the read path needs them.
- Old `business_basic` etc. were deprecated 2025-01-27; use `instagram_business_*`.

## Security model

- Loopback-only app server; dedicated ngrok child owned by lab; never touches unrelated
  tunnels; ngrok inspection disabled.
- Same public origin for UI + OAuth callback.
- `HttpOnly`, `SameSite=Lax`, `Secure` (HTTPS) session cookie, `Path=/`, 7-day maxAge.
- OAuth `state`: 192-bit random, session-bound, one pending per session, 10-min TTL,
  single-use, replay-detectable; origin change invalidates pending states.
- Provider tokens never sent to browser; no code/token/cookie/secret in logs;
  no secrets in status or observation export; Graph URLs sanitized (`[REDACTED]`).
- State-changing routes require allowed `Origin` + `X-Requested-With: instagram-sandbox-lab`.
- Vite filesystem restricted to `client/` + `node_modules`; `.env*`, server sources,
  lockfiles, adjacent repos never served (explicit 404/403 guard).
- Memory-only sessions/tokens; restart destroys them.

## What conclusions can/cannot be drawn

- Can: exact current field/metric names, endpoint + permission + version for each metric,
  basic-vs-Insights distinction, full-integer precision, observation timestamps, whether
  a Reel resolves to owned media, whether Insights are unavailable/unsupported for a
  media type, provider error envelopes.
- Cannot: infer deletion/privacy/fraud from omission (`Ownership not proven` is the
  strongest claim); assume `plays == views` (lab uses current `views`); treat username
  as identity; equate official media ID with public scraper shortcode; treat `total_*`
  (ads-inclusive, Facebook-Login-only) as available here.
- Metrics can lag live counters up to 48h; story Insights expire after 24h; data retained
  ~2 years. Differences vs baseline may reflect delay, growth, or observation gap — not
  automatically rounding.

## Tests

```sh
npm run typecheck   # tsc --noEmit (client+server)
npm test            # vitest, offline mocked HTTP (91 tests)
npm run build       # vite build + tsc server build
npm start           # serve production build (loopback; no ngrok)
```

Offline coverage: OAuth start/callback/state/expiry/replay/denied/exchange errors,
token extend/refresh piggybacking/preservation/expiry categorization, account identity
(string IDs, scope gating), media pagination/IDs-as-strings/permalink parsing/resolve
walk/wrong-owner semantics/malformed data, Insights integers/zero-vs-missing/unsafe
precision/exact metric names/unsupported combos, comparison arithmetic/zero
denominator/unknown timestamps/ID mismatch/export sanitization, CSRF/origin isolation,
secret exclusion, client render smoke. Live provider validation is
`NOT RUN — requires configured Meta test credentials`.

## Cleanup

Stop with `Ctrl+C`, delete this directory. Nothing outside it is modified. Optionally
remove the redirect URI and test users in the Meta dashboard, and revoke the lab at
Instagram Settings > Apps and Websites.

## Research findings / provider contract

Validated 2026-09-29 against official Meta docs (developers.facebook.com +
Postman Meta workspace). API version tested in docs: **v25.0** (v26.0 released
2026-07-29 also exists). Every item DOCUMENTED; none LIVE VERIFIED (no credentials
in this session).

- **Selected integration: Instagram API with Instagram Login (Business Login), host
  `graph.instagram.com`. DOCUMENTED.** No Facebook Page required. Facebook-Login path
  (`graph.facebook.com`) not needed for organic read path.
- **API version: v25.0 default. DOCUMENTED.** v26.0 exists; pin explicitly via
  `INSTAGRAM_API_VERSION`.
- **Account types: Business + Creator (`Media_Creator`) only. DOCUMENTED.** Personal
  unsupported for media/Insights.
- **Facebook Page required?: No (Instagram Login). DOCUMENTED.**
- **Scopes: `instagram_business_basic` (identity/media/basic fields) +
  `instagram_business_manage_insights` (Insights). DOCUMENTED.** Least privilege;
  publishing/messaging/comment scopes not needed for reads.
- **OAuth authorize: `https://www.instagram.com/oauth/authorize?client_id&redirect_uri&
  response_type=code&scope&state` (+ optional `force_reauth`, `enable_fb_login`).
  DOCUMENTED.** No PKCE in Business Login docs; `state` is CSRF defense. Redirect URI
  must exactly match dashboard list.
- **Code exchange: `POST https://api.instagram.com/oauth/access_token` (form:
  `client_id,client_secret,grant_type=authorization_code,redirect_uri,code`).
  DOCUMENTED.** Code single-use, 1h. Success shape `{data:[{access_token,user_id,
  permissions}]}`. Errors `{error_type,code,error_message}` or Graph `{error:{...}}`.
  Canceled auth redirects with `error=access_denied&error_reason=user_denied`.
- **Provider subject: `user_id` (stable numeric string). DOCUMENTED.** Distinct from
  app-scoped `id` and from mutable `username`. Webhook `id` equals `user_id`.
- **Token lifetime/refresh: short 1h → long 60d (`ig_exchange_token`) → refresh
  (`ig_refresh_token`, ≥24h old, valid, basic permission). DOCUMENTED.** Expired 60d
  or revoked tokens cannot refresh. No separate refresh-token string; access value rotates.
- **Owned-media endpoint: `GET /<IG_ID>/media?limit&after` (+ `GET /<MEDIA_ID>?fields=`).
  DOCUMENTED.** Cursor pagination (`paging.cursors.after`). List returns IDs; details
  fetched per media with explicit fields.
- **Reel resolution: shortcode ≠ media ID; match `permalink`/`shortcode` against owned
  media via bounded walk. DOCUMENTED.** `permalink` + `shortcode` fields returned on
  media objects. No direct shortcode→ID lookup. Reel (`/reel/`) vs post (`/p/`) forms
  differ textually but resolve the same way.
- **Insights endpoint: `GET /<MEDIA_ID>/insights?metric=...`. DOCUMENTED.**
- **Views metric: `views` (current, organic plays on Instagram). DOCUMENTED.**
  `plays` is legacy — do not use. `impressions` deprecated for media created after
  2024-07-02. `view_count` field exists only for Business Discovery, not owned-media reads.
- **Other usable metrics: `reach`, `likes`, `comments`, `shares`, `saved`,
  `total_interactions` (+ `follows`, `profile_visits`, `profile_activity`,
  reel-specific `ig_reels_avg_watch_time`, etc.). DOCUMENTED.** Basic fields
  `like_count`/`comments_count` are separate from Insights. `total_*` ads-inclusive
  variants are Facebook-Login-only. Story metrics expire 24h, `<5 viewers` errors code 10.
- **Wrong-owner behavior: provider error or omission; lab reports `Ownership not proven`.
  DOCUMENTED.** `GET /<MEDIA_ID>` for non-owned media fails (e.g. code 100) or omits;
  never translated to deleted/private/fraud.
- **Rate limits: Instagram Business Use Case (`Calls_24h = 4800 × Impressions`).
  DOCUMENTED.** Messaging has separate per-second caps. Webhooks recommended.
- **Review/approval: Business app type; Standard (role users, dev) vs Advanced
  (App Review + Business Verification for non-role users). DOCUMENTED.**
  `instagram_business_manage_insights` needs Advanced for external users.

Full table with sources in `docs/instagram-provider-contract.md`. All claims above are
DOCUMENTED from official sources; LIVE VERIFIED is pending operator run with Meta test
credentials.
