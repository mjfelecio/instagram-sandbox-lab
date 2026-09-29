# Instagram provider contract (for BloxClips-backend #254)

Research date: 2026-09-29
API version: v25.0 (documented; v26.0 released 2026-07-29 also exists)
Lab: `experiments/instagram-sandbox-lab` (mirrors `tiktok-sandbox-lab`)

Status labels: **DOCUMENTED** = verified in current official Meta docs/Postman on
research date. **LIVE VERIFIED** = observed against a real Meta app/test account.
**NOT LIVE VERIFIED** = pending operator run. In this session no Meta credentials were
available, so everything below is DOCUMENTED, nothing is LIVE VERIFIED.

Official sources consulted:
- https://developers.facebook.com/documentation/instagram-platform/overview
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started
- https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media
- https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights
- https://developers.facebook.com/documentation/instagram-platform/insights
- https://developers.facebook.com/blog/post/2025/03/24/user-and-media-insights-on-instagram-api-with-instagram-login/
- https://developers.facebook.com/blog/post/2025/12/03/instragram-api-updates/
- https://www.postman.com/meta/instagram/overview (workspace index; collection details via docs above)

## OAuth

| Item | Value | Status |
| --- | --- | --- |
| OAuth authorize endpoint | `https://www.instagram.com/oauth/authorize` | DOCUMENTED |
| Token endpoint (code exchange) | `POST https://api.instagram.com/oauth/access_token` (form `client_id,client_secret,grant_type=authorization_code,redirect_uri,code`) | DOCUMENTED |
| API authorization (normal Graph reads) | `Authorization: Bearer <token>` header; tokens never in normal Graph URLs (query-string tokens only for long-lived exchange/refresh where Meta requires them) | DOCUMENTED |
| Grant type (code) | `authorization_code` | DOCUMENTED |
| Required parameters (authorize) | `client_id` (Instagram App ID), `redirect_uri` (exact dashboard match), `response_type=code`, `scope` (comma or space separated) | DOCUMENTED |
| Optional parameters | `state` (CSRF, optional at provider but required by lab), `force_reauth`, `enable_fb_login` | DOCUMENTED |
| Redirect URI rules | Must exactly match one of `Business login settings > OAuth redirect URIs` (watch trailing slash) | DOCUMENTED |
| State behavior | Provider echoes `state`; lab generates 192-bit random, session-bound, single-use, 10-min TTL, replay-detectable | DOCUMENTED (provider echo) / lab-enforced |
| PKCE support/requirement | Not in Business Login docs; not implemented (no `code_challenge`) | DOCUMENTED (absent) |
| Provider error envelope (Graph) | `{ error: { message, type, code, error_subcode?, is_transient?, fbtrace_id? } }`; HTTP 200 with this envelope is failure | DOCUMENTED |
| Token exchange errors | `{ error_type, code, error_message }` (e.g. reused code) or Graph envelope; canceled auth redirects `error=access_denied&error_reason=user_denied&error_description=...` | DOCUMENTED |
| Authorization code lifetime | Single-use, 1 hour | DOCUMENTED |
| Development mode | Standard Access: only app-role users; Business app type required | DOCUMENTED |
| App roles / test users | Add professional test account under App Roles or generate token via API setup | DOCUMENTED |
| Professional test account | Business or Creator account required for media/Insights | DOCUMENTED |
| Production / App Review | Advanced Access requires App Review + Business Verification for non-role users | DOCUMENTED |

## Permissions

| Item | Value | Status |
| --- | --- | --- |
| Required scopes (read path) | `instagram_business_basic`, `instagram_business_manage_insights` | DOCUMENTED |
| `instagram_business_basic` covers | `/me` identity, `/{IG_ID}/media` enumeration, basic media fields | DOCUMENTED |
| `instagram_business_manage_insights` covers | Media Insights (+ user Insights); introduced Mar 2025; Advanced needed for external users | DOCUMENTED |
| Insights permission name check | Yes: `instagram_business_manage_insights` exists and is required under Instagram Login (not a different representation) | DOCUMENTED |
| Unneeded (not requested) | `instagram_business_content_publish`, `instagram_business_manage_comments`, `instagram_business_manage_messages`, messaging/ads/tagging | DOCUMENTED (least privilege) |
| Old scope names | `business_basic` etc. deprecated 2025-01-27; use `instagram_business_*` | DOCUMENTED |

## Account eligibility

| Item | Value | Status |
| --- | --- | --- |
| Professional account requirement | Business or Creator (`Media_Creator`) only | DOCUMENTED |
| Personal/consumer | Unsupported for owned media/Insights (error, not data) | DOCUMENTED |
| Facebook Page requirement | No (Instagram Login); Yes only for Facebook-Login path | DOCUMENTED |

## Identity

| Item | Value | Status |
| --- | --- | --- |
| ProviderSubjectId | `user_id` (stable numeric string; equals webhook `id`) | DOCUMENTED |
| Username field/scope | `username` via `/me` under `instagram_business_basic`; display metadata, not identity | DOCUMENTED |
| App-scoped `id` | Returned as `id` on `/me`; distinct from `user_id`; not identity | DOCUMENTED |
| Account type field | `account_type` (`Business` / `Media_Creator`) | DOCUMENTED |
| Profile fields | `name`, `profile_picture_url`, `followers_count`, `follows_count`, `media_count` under basic | DOCUMENTED |
| OAuth identity vs scraper identity | Explicitly distinct; no assumption that official ID equals public scraper ID | Lab policy |
| Public media ID vs official media ID | Official Graph media ID (long numeric string) is distinct from URL shortcode; shortcode is a URL token, not the ID | DOCUMENTED |

## Token lifecycle

| Item | Value | Status |
| --- | --- | --- |
| Initial token type | Short-lived Instagram User token | DOCUMENTED |
| Initial lifetime | 1 hour (dashboard-generated tokens are long-lived 60d) | DOCUMENTED |
| Long-lived exchange | `GET graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret&access_token` (server-side) | DOCUMENTED |
| Long-lived lifetime | 60 days (`expires_in` ~5184000) | DOCUMENTED |
| Refresh/extension | `GET graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token` | DOCUMENTED |
| When refresh allowed | Existing long-lived ≥24h old, still valid, has `instagram_business_basic`; <60d since refresh | DOCUMENTED |
| Rotation | Access value rotates (new string); no separate refresh-token string | DOCUMENTED |
| Revocation behavior | No official revoke endpoint found; user removes via Instagram Settings > Apps and Websites; lab Clear is local-only | DOCUMENTED (absent) |
| Expired/revoked | 60d without refresh expires; revoked/invalid yields code 190 class errors; reconnect required | DOCUMENTED |

## Owned media

| Item | Value | Status |
| --- | --- | --- |
| Owned-media endpoint | `GET /<IG_ID>/media?limit&after` then `GET /<MEDIA_ID>?fields=...` per item | DOCUMENTED |
| Pagination | Continuation requires `paging.next`; `paging.cursors.after` supplies the cursor for it; `limit` up to 25 in lab | DOCUMENTED |
| Fields shown (default request) | `id`, `media_type`, `permalink`, `shortcode`, `timestamp`, `caption`, `username`, `like_count`, `comments_count`, `thumbnail_url`/`media_url` (Instagram-Login set; `Authorization: Bearer`) | DOCUMENTED |
| Facebook-Login-only fields | `media_product_type`, `owner`, `saved_count`, `shares_count`, `caption` @ handling — excluded from default; isolated probe `POST /api/instagram/media/probe` | DOCUMENTED |
| Personal media | Not returned (professional-only API) | DOCUMENTED |

## Reel URL → official media ID

| Item | Value | Status |
| --- | --- | --- |
| Canonical Reel URL → official media ID | No direct lookup; match `permalink`/`shortcode` against owned media via bounded page walk (max 10 pages, explicit count) | DOCUMENTED (fields) + lab method |
| Owned media returns `permalink` | Yes | DOCUMENTED |
| `shortcode` available directly | Yes (`shortcode` field on media) | DOCUMENTED |
| Matching canonical permalink | Supported practical method used by lab | Lab method |
| Pagination required | Yes when beyond first page | DOCUMENTED |
| Reel vs post URLs | `/reel/<code>/` vs `/p/<code>/`; same resolution logic | DOCUMENTED |
| Official ID vs public identifier | Distinct (numeric Graph ID vs shortcode) | DOCUMENTED |

## Wrong-owner behavior

| Item | Value | Status |
| --- | --- | --- |
| Wrong-owner behavior | Provider error (e.g. code 100) or omission; lab reports `Ownership not proven by the connected account`, never deleted/private/fraud | DOCUMENTED (error shape) + lab policy |

## Insights

| Item | Value | Status |
| --- | --- | --- |
| Insights endpoint | `GET /<MEDIA_ID>/insights?metric=...` (period auto `lifetime` for media) | DOCUMENTED |
| Views metric | `views` (organic plays on Instagram; current name; `plays` legacy) | DOCUMENTED |
| Reach metric | `reach` (unique accounts; estimated) | DOCUMENTED |
| Likes | `likes` (Insights) + `like_count` (basic field) | DOCUMENTED |
| Comments | `comments` (Insights) + `comments_count` (basic) | DOCUMENTED |
| Shares | `shares` | DOCUMENTED |
| Saves | `saved` (Insights metric name; basic `saved_count` is FB-Login-only) | DOCUMENTED |
| Total interactions | `total_interactions` (likes+saves+comments+shares minus unlikes/unsaves/deleted; in development) | DOCUMENTED |
| Supported media types | `views/reach/likes/comments/shares/saved/total_interactions` for `FEED` (posts) + `REELS`; subset for `STORY` (`reach,views,shares,saved,total_interactions` + story-only `navigation,replies,link_clicks,follows,profile_visits` etc.); albums have no Insights for children | DOCUMENTED |
| Basic vs Insights | `like_count`/`comments_count` are basic fields; all above are Insights metrics; shown separately | DOCUMENTED |
| Deprecated/replaced | `impressions` deprecated for media created after 2024-07-02; `plays` replaced by `views`; `total_*` ads-inclusive variants FB-Login-only | DOCUMENTED |
| Null behavior | Missing/unavailable returns empty dataset or omitted metric (lab shows null, never zero) | DOCUMENTED |
| Freshness | Up to 48h delay; stories 24h expiry; `<5 viewers` → code 10; retained ~2y | DOCUMENTED |
| API version tested | v25.0 | DOCUMENTED |

## Rate limits, review, sandbox

| Item | Value | Status |
| --- | --- | --- |
| Rate-limit behavior | Instagram Business Use Case: `Calls_24h = 4800 × Impressions`; Business Discovery/Hashtag use Platform limits; webhooks recommended | DOCUMENTED |
| App review requirement | Advanced Access (App Review + Business Verification) for non-role users; `manage_insights` needs Advanced externally | DOCUMENTED |
| Known sandbox/dev-mode restrictions | Standard Access role-only; some features need Advanced; story expiry; delay; code-10 small audiences; EU/JP `replies` quirks | DOCUMENTED |

## Live verification (pending)

All rows above: LIVE VERIFIED = pending. To verify, operator must:
1. Fill `.env.local` (`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, scopes, version).
2. `npm install && npm run dev`, register printed callback URI.
3. Connect Instagram, fetch account/media/resolve/Insights, paste baseline, compare, export.
4. Record real `user_id`, metric values, timestamps, and any deviations from DOCUMENTED.

Do not mark any row LIVE VERIFIED until observed against a real Meta app/test account.
Live validation in this session: `NOT RUN — requires configured Meta test credentials`.
