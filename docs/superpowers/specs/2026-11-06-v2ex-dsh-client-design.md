# V2EX DSH Client Plugin Design

**Date:** 2026-11-06
**Status:** Approved for implementation planning

## 1. Goal

Build a read-only DeepSeek Harness (DSH) plugin for authenticated V2EX browsing and intelligent content discovery. The plugin must support ordinary topic browsing first, then add AI summaries, interest-aware filtering, periodic refresh, and in-session recommendations.

The plugin has two equal user surfaces:

- a DSH sidebar client for direct browsing and AI-assisted reading;
- model-facing Agent Tools for conversational discovery and summarization.

Both surfaces use one Host implementation so authentication, caching, rate limiting, normalization, intelligence, and error behavior remain consistent.

## 2. Product Boundaries

### 2.1 Included in v1

- Mandatory login with a V2EX Personal Access Token.
- Token validation and authenticated member display.
- Latest topics, hot topics, node discovery, node topics, topic detail, and paginated replies.
- Local keyword and node filtering over fetched content.
- Per-topic AI summaries, viewpoint/controversy summaries, and notable-reply extraction.
- Interest-aware recommendations in the sidebar and through Agent Tools.
- Optional learning from DSH conversation history after explicit user authorization.
- An inspectable and editable structured interest profile.
- Periodic refresh while the DSH Host is running.
- Sidebar unread indicators and DSH session-local recommendation reminders.
- Read-only offline fallback from the last successful cache.

### 2.2 Excluded from v1

- Creating topics or replies.
- Thanking, favoriting, ignoring, blocking, boosting, pinning, or deleting anything.
- Deleting V2EX notifications or any other V2EX write operation.
- Full-site historical search. The official API does not provide this capability.
- macOS, Windows, or browser system notifications.
- Cross-device interest-profile synchronization.
- A separately deployed AI service.
- Silent access to conversation history without user authorization.

## 3. External API Basis

Use the official V2EX API 2.0 endpoints under `https://www.v2ex.com/api/v2/` for token validation, member identity, latest topics, nodes, node topics, individual topics, and replies. Authentication uses an `Authorization: Bearer ...` header.

The authenticated API is documented at <https://www.v2ex.com/help/api>. Personal Access Token lifetime and display behavior are documented at <https://www.v2ex.com/help/personal-access-token>.

The legacy official public hot-topics endpoint may be used for the Hot view, but it must still be requested by the Host and the plugin UI remains inaccessible until login. All upstream responses are treated as untrusted and validated before caching or returning them.

The V2EX API exposes rate-limit state through response headers. The implementation must honor the observed headers rather than relying on a hard-coded allowance.

## 4. Architecture

### 4.1 Host services

#### `V2exApiClient`

Owns every upstream V2EX request. It adds the Bearer credential, applies timeouts, handles pagination, reads rate-limit headers, limits response size, validates response shapes, and maps upstream failures into stable plugin errors.

No caller may receive the raw request headers, raw credential, stack trace, or an unbounded upstream body.

#### `CredentialService`

Stores the Personal Access Token only in the DSH credentials service under a plugin-owned reference. Before saving it, the service validates the token and member identity with the official API.

The token must not appear in plugin configuration, persistent content caches, browser storage, logs, model prompts, Agent Tool results, test fixtures, snapshots, or source control.

#### `ContentService`

Provides normalized operations for:

- latest topics;
- hot topics;
- node metadata and node topics;
- topic detail;
- paginated replies.

It owns bounded caching, in-flight request deduplication, concurrency limits, and stale-data fallback. Because V2EX API 2.0 does not expose full-site search, smart discovery is limited to fetched latest pages and configured/learned nodes.

#### `InterestProfileService`

After explicit authorization, reads eligible DSH history through `sessionQuery` and asks the current DSH model to extract a structured profile. The stored profile contains only:

- interest labels and weights;
- preferred V2EX nodes;
- excluded topics or terms;
- explicit user feedback;
- update metadata.

By default, only user-authored message text is eligible. System instructions, assistant output, tool results, credentials, attachments, session identifiers, and internal metadata are excluded. Raw historical messages are not stored by this plugin.

The user can inspect, edit, pause, relearn, revoke authorization, and clear the profile. Revocation prevents all future history reads until authorization is granted again.

#### `IntelligenceService`

Uses the active DSH model for:

- quick topic summaries;
- viewpoint and controversy summaries;
- notable-reply extraction;
- candidate-topic relevance scoring;
- concise recommendation reasons;
- structured interest extraction.

It accepts normalized, length-bounded content and produces schema-validated structured output. V2EX content and historical text are always untrusted data, clearly delimited from instructions, and cannot add tools or change plugin policy.

Every topic summary records its generation time, topic identity, and reply-page coverage. Partial reply coverage must never be presented as a summary of the complete discussion.

#### `RefreshService`

Runs while the DSH Host is active. It periodically fetches the latest stream and configured or learned nodes, performs a cheap local prefilter, then spends AI calls only on bounded candidates. It stores ranked recommendations, suppresses duplicates, and updates unread state.

High-scoring new topics create a sidebar unread indicator and a session-local DSH reminder. Notifications contain only the topic title, node, and generated recommendation reason. They contain no conversation excerpts.

#### `StorageDomain`

Stores normalized caches, structured interest profile, refresh settings, AI results, read state, feedback, and recommendation deduplication keys. Credentials are never stored in this domain.

### 4.2 Sidebar Web Client

The Web Client never calls V2EX directly. It communicates with the Host through a same-origin plugin route and receives only normalized browser-safe DTOs.

The client provides:

- mandatory Token login and account status;
- Smart Recommendations, Latest, Hot, and Nodes views;
- topic body and paginated reply reading;
- AI result controls and source-coverage labels;
- interest authorization and profile management;
- refresh, budget, threshold, and quiet-hours settings;
- token replacement and logout.

### 4.3 Agent Tools

The initial model-facing tools are:

- `v2ex_latest`
- `v2ex_hot`
- `v2ex_node_topics`
- `v2ex_topic`
- `v2ex_summarize_topic`
- `v2ex_find_interesting`
- `v2ex_interest_profile`

All tools are read-only, validate parameters before network access, cap field lengths and total output size, and return stable structured results. No tool returns the credential or raw internal state.

### 4.4 Dependency and degradation policy

The Host depends on DSH credentials, storage, tools, session query, and LLM services. It must detect missing or incompatible optional services at startup.

- Missing AI or history-query services disable only the affected intelligent features.
- Valid authentication and ordinary V2EX browsing remain usable without AI.
- Missing credential or Host transport services are fatal to plugin functionality and must produce a bounded compatibility diagnostic instead of crashing the broader DSH plugin tree.

## 5. User Experience

### 5.1 Login

Before authentication, the sidebar shows only the Personal Access Token form and concise security information. The Host temporarily receives the entered token, validates it, then saves it to DSH credentials only after success.

Successful login displays the V2EX username, token scope/status, and expiration when available. The user can replace the token or log out. Logout clears the credential. The user chooses whether logout also clears the locally stored interest profile and recommendation data.

### 5.2 Main views

#### Smart Recommendations

Ranks candidates by the structured interest profile and shows a short reason, node, author, reply count, update time, and read state. Users can provide `interested` or `not interested` feedback, which adjusts the local profile and suppresses unsuitable repeats.

#### Latest

Shows official latest topics with paging plus local node and keyword filters.

#### Hot

Shows the official hot-topic feed through the same Host cache and error boundary.

#### Nodes

Lets users enter or select followed nodes, read node metadata, and page through node topics.

### 5.3 Topic reading and AI assistance

The detail view renders the topic body and paginated replies. The AI panel offers:

- Quick Summary;
- Viewpoints and Controversies;
- Notable Replies.

Each result visibly states when it was generated and which reply pages it covers. Regeneration is explicit and bounded by configured budgets.

### 5.4 Interest controls

The interest page supports:

- granting and revoking history-learning authorization;
- viewing and editing labels, weights, preferred nodes, and exclusions;
- manual relearning;
- pausing automatic learning;
- clearing the profile and recommendation history.

History access must be off until the user grants it. The authorization copy must explain what is read, what is stored, and how to revoke it.

### 5.5 Background settings

Settings include refresh interval, scanned nodes, per-source page limit, AI candidate budget, notification threshold, and quiet hours.

Defaults:

- refresh every 30 minutes while the Host is running;
- scan the latest feed and the first two pages of preferred nodes;
- apply local filtering before model calls;
- pause background work near the upstream rate limit;
- prioritize interactive browsing over background refresh.

## 6. Core Data Flows

### 6.1 Authentication

`Client input -> Host credential boundary -> V2EX token/member validation -> DSH credential storage -> browser-safe account status`

### 6.2 Browsing

`Client or Agent Tool -> ContentService -> fresh cache or V2EX -> validation/normalization -> cache update -> bounded result`

### 6.3 Intelligence

`Normalized candidates -> local prefilter -> bounded AI request -> schema validation -> result with provenance -> storage -> Client or Tool`

### 6.4 History learning

`Explicit authorization -> eligible user-message selection -> bounded extraction input -> schema-validated profile update -> editable structured profile`

### 6.5 Periodic recommendations

`Timer -> budget/rate-limit check -> candidate fetch -> dedupe -> local filter -> AI rank -> threshold/quiet-hours check -> stored recommendation and optional session reminder`

## 7. Rate Limits, Budgets, and Caching

- Read `X-Rate-Limit-Limit`, `X-Rate-Limit-Remaining`, and `X-Rate-Limit-Reset` when present.
- Deduplicate concurrent identical requests.
- Bound request concurrency and use retry with jitter only for retryable failures.
- Stop background refresh before exhaustion and reserve capacity for interactive requests.
- Use short TTLs for changing lists and longer TTLs for topic bodies and older reply pages.
- Preserve the last successful validated result when refresh fails.
- Mark stale/offline data clearly in both Client and Tool results.
- Apply a hard per-refresh cap to upstream requests, fetched pages, processed candidates, AI calls, input bytes, and output bytes.
- Never overwrite a valid cache entry with an invalid upstream response or invalid model output.

## 8. Security and Privacy

- Treat the supplied V2EX token as a secret even if it is described as a test token.
- Keep the token exclusively in the Host credential service.
- Redact authorization headers and token-like strings from diagnostics.
- Validate topic IDs, node names, page numbers, limits, and URLs before network access.
- Allow network requests only to configured official V2EX HTTPS origins.
- Cap response size and reject unexpected content types or invalid schemas.
- Treat V2EX content and conversation history as prompt-injection-capable untrusted data.
- Use fixed system instructions, explicit data delimiters, no model tools during classification/summarization, and strict output schemas.
- Do not expose raw history, session IDs, internal paths, cache keys, stack traces, or request headers to the model-facing surface.
- Make history learning opt-in, reversible, inspectable, and erasable.

## 9. Error Model

Stable public error codes include:

- `not_authenticated`
- `token_invalid`
- `token_expired`
- `rate_limited`
- `offline`
- `timeout`
- `not_found`
- `invalid_request`
- `invalid_response`
- `upstream`
- `ai_unavailable`
- `history_access_denied`
- `budget_exhausted`
- `incompatible_runtime`

Errors are translated into bounded user-facing messages with a useful recovery action. A failed refresh never deletes valid cached content. Token expiration pauses background work and returns the user to a reauthentication state without discarding their profile.

## 10. Testing Strategy

### 10.1 Unit tests

Cover input validation, secret redaction, token lifecycle, pagination, normalization, cache TTL and replacement rules, in-flight deduplication, rate-limit policy, interest weights, feedback, notification deduplication, error mapping, and AI schema validation.

### 10.2 Contract tests

Use checked-in, minimized, and secret-free response fixtures captured from the official API. Cover valid responses, empty pages, expired credentials, rate limiting, missing resources, malformed content, and compatible unknown fields. These tests never access the network.

### 10.3 Integration tests

Use fake DSH credential, storage, session-query, LLM, timer, and tools services to verify:

- login and logout;
- consent and revocation;
- profile learning and editing;
- browsing through Client and Agent Tools;
- shared summary provenance;
- periodic refresh budgets and deduplication;
- graceful AI/history degradation.

### 10.4 End-to-end tests

Playwright covers login, all four main views, topic/reply reading, AI controls, profile controls, settings, stale/offline states, and desktop/narrow layouts. Fixed fixtures and deterministic model responses keep screenshots and behavior stable.

### 10.5 Explicit live verification

A separate manual command may read a test Token from an environment variable and run a small read-only smoke test against the official API. It is excluded from default tests and CI. The command must not print the variable, authorization header, or full upstream error body.

## 11. Acceptance Criteria

- Unauthenticated users cannot enter the content views.
- A valid Personal Access Token logs in; invalid and expired tokens have clear recovery paths.
- Ordinary browsing remains functional when AI is unavailable.
- Client and Agent Tools use the same normalized content and intelligence services.
- Topic summaries disclose generation time and actual reply coverage.
- Authorized history learning creates an editable structured profile without storing raw history.
- Revoking authorization stops future history reads.
- Periodic refresh respects request/model budgets, upstream rate limits, notification thresholds, quiet hours, and duplicate suppression.
- Every V2EX operation issued by the plugin is read-only.
- Source, logs, fixtures, browser storage, model prompts, and Tool output contain no plaintext Personal Access Token.
- Desktop and narrow layouts have no overlapping content or inaccessible controls.

## 12. Implementation Direction

Use the existing local DSH forum and marketplace plugins as implementation references, especially their separation between Host services, browser-safe DTOs, same-origin Client routes, credentials, Storage Domain, and bounded Agent Tool results.

The implementation plan should sequence work so the authenticated read-only browsing core is independently usable and tested before adding history learning, AI summaries, personalized ranking, and periodic recommendations.
