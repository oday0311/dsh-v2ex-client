# V2EX DSH Client

Read-only V2EX browsing and intelligent discovery for DeepSeek Harness (DSH). The plugin offers an authenticated sidebar and the same bounded capabilities through Agent Tools. [中文说明](./README_ZH.md)

## Requirements and installation

- Node.js 22 or newer
- DSH `>=0.2.1-rc.5 <0.3.0`
- A V2EX Personal Access Token (PAT)

Install the package in the DSH workspace and enable `v2ex-dsh-client` in the plugin bundle. For a local checkout:

```bash
pnpm install
pnpm build
pnpm pack
```

Install the resulting package through the package workflow used by your DSH installation. The Host entry is `v2ex-dsh-client`, the browser entry is `v2ex-dsh-client/client`, and the included `dsh.plugin.json` and `cordis.patch.yml` contain bundle metadata.

## Sign in

Create a PAT in V2EX account settings, open the V2EX sidebar in DSH, and paste it into the form. The Host validates it before saving it in the DSH credential service. It is never put in plugin settings, content storage, browser storage, model prompts, Agent Tool results, or logs. Token replacement validates the new credential before switching accounts. Logout can optionally remove local profile and recommendation data.

## Read-only guarantee

Every request this plugin sends to V2EX uses `GET` and is restricted to official V2EX HTTPS origins. It reads token status, member identity, latest/hot/node topics, the public section tabs (`/?tab=tech`, `/?tab=jobs`, ...), the public node catalog, topic details, and replies. It cannot create or change topics or replies, thank, favorite, ignore, block, boost, delete, or otherwise mutate V2EX data.

The sidebar uses same-origin Host routes to change local settings and state. Those local `POST`, `PUT`, and `DELETE` operations never become V2EX writes. All model-facing tools are read-only.

## Browsing and AI

Latest, Hot, section tabs (Tech, Creative, Play, Apple, Jobs, Deals, City, Q&A, Hot, All, R2, VXNA), and Nodes support topic and paginated reply reading. Section tabs link into the nodes that appear in them, and the Nodes view lists the common node catalog so any node can be opened directly. Content is validated, size-limited, cached, and marked when stale. AI summaries are explicit actions and disclose topic and reply-page coverage. Without AI services, normal browsing still works.

V2EX text is untrusted input. Only bounded normalized data goes to the current DSH model, model tools are disabled, and structured output is validated. AI output can be incomplete or wrong; the source discussion remains authoritative.

## Interest learning and privacy

History learning is off by default and starts only after explicit authorization in Interest. The plugin selects bounded user-authored plain text while excluding system, assistant, tool, attachment, credential-shaped, and internal metadata content. Raw history is not stored; only an editable structured profile is persisted.

Users can inspect and edit labels, preferred nodes, and exclusions; pause automatic learning; manually relearn; revoke authorization; or clear the profile. Revocation prevents future history reads. Interests, settings, recommendations, read state, and feedback are isolated by verified V2EX account.

## Refresh, rate limits, and reminders

Background refresh runs only while the DSH Host is running. Defaults are every 30 minutes, the latest feed, and up to two pages of preferred nodes. Local filtering precedes bounded AI ranking. Interactive reads have priority; background work pauses near V2EX's reported rate limit.

Settings control refresh interval, followed nodes, per-source pages, AI candidate budget, notification threshold, and quiet hours with an IANA timezone. Quiet hours suppress delivery but may still refresh recommendations.

Reminders go only to a suitable active top-level DSH Agent. They may remain pending if no Agent is available or it is busy, and are retried while the Host is active. They are not operating-system notifications and are not guaranteed after DSH exits.

## Configuration

Normal operation has no token setting or environment variable. Authentication uses only the sidebar and DSH credential service. Runtime options are in Settings and Interest. `V2EX_TEST_TOKEN` is reserved for the optional maintainer smoke verifier; runtime and the deterministic release gate never use it.

## Troubleshooting

- **Sign-in rejected:** create a new PAT, check its expiration, and paste it without surrounding whitespace.
- **Offline or stale:** the last validated cache is shown because V2EX is unreachable. Retry when connectivity returns.
- **Rate limited:** wait for the reported reset; background work reserves capacity for interactive reads.
- **AI unavailable:** configure a current DSH model. Browsing remains available.
- **History learning unavailable:** install the DSH history-query service, then explicitly authorize learning.
- **No reminder:** check quiet hours, threshold, unread items, and whether an active top-level Agent can accept delivery.
- **Wrong account data:** log out with personal-data clearing, then sign in to the intended account.

Public errors use stable codes together with bounded static messages and retryability metadata. They never include raw upstream or model-provider diagnostics.

## Development and release verification

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm verify:package
pnpm verify:release
```

`verify:release` is deterministic and never contacts V2EX. The optional live smoke test requires an explicit opt-in and a PAT supplied through the process environment:

```bash
V2EX_TEST_TOKEN='<set outside shared shell history>' pnpm verify:live-api
```

The live verifier performs only token, member, latest-page, selected-topic, and selected-topic-reply GET reads. It has bounded timeouts and responses and emits only stable JSON fields or error codes. Never commit a PAT or pass one as a command-line argument.

## License

MIT. See [LICENSE](./LICENSE).
