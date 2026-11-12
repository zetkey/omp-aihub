# omp-aihub

Provider plugin for [omp](https://github.com/can1357/oh-my-pi) (and upstream pi) for the
metranet AI hub gateway (`aihub.metranet.co.id`, a [new-api](https://github.com/QuantumNous/new-api) instance).

omp's generic OpenAI-model-list discovery reads `/v1/models`, which carries no pricing or
context metadata — every model shows as free with guessed context windows. This plugin fills
the gap from the gateway's own public catalog:

| Data | Source |
|------|--------|
| Model roster + per-model API wire | `GET /v1/models` (auth) |
| Prices (input/output/cache read/write), context window, max output, modalities, capabilities | `GET /api/pricing` (public) |
| Account credit, key quota, per-model spend window | `/v1/dashboard/billing/*`, `/api/usage/token/`, `/api/log/token` |

Pricing math (verified against the gateway's own billing records and official vendor cards):
`USD/M = model_ratio × $2`, output `× completion_ratio`, cache read `× cache_ratio`, cache
write `× create_cache_ratio`, all `× group_ratio` (cheapest enabled group, 0.9 on aihub).
Models with `billing_mode: tiered_expr` are priced from their `billing_expr` (their
`model_ratio` field is junk): length-split exprs (`len <= N ? tierA : tierB`) map to omp's
`cost.longContext` (e.g. qwen3.7-plus ≤256k vs >256k), time-discount exprs keep the peak
branch × group ratio (e.g. deepseek off-peak ×0.5).

Models missing `context_length` fall back to the bundled catalog reference of the same id
(other provider's row), then generic defaults.

## Learned pricing

The gateway publishes rate cards for only ~111 of 162 roster ids. For the rest (and to
correct group-ratio drift), the plugin learns the **actual** billed ratios from your own
consume logs (`/api/log/token` → `other.model_ratio/completion_ratio/cache_ratio/group_ratio`)
whenever it refreshes or you run `/aihub-usage`, and persists them to
`~/.omp/agent/aihub-pricing-learned.json` (override: `AIHUB_LEARNED_PATH`). Learned ratios
outrank catalog estimates; expr-mode models keep their `billing_expr` price scaled by the
learned group ratio. Flow for an unpriced model: use it once → run `/aihub-usage` (or wait
for the next auto-refresh) → price appears.

## Verified context (`/aihub-probe`)

A model's served context is a property of the gateway channel, not the vendor catalog —
the same model id can carry different windows elsewhere, and borrowed catalog references
can overshoot what aihub actually accepts. `/aihub-probe <model-id> …` (or
`/aihub-probe all --max=N`) sends input-heavy requests down a size ladder and records the
largest window the channel verifiably serves into the same learned store; verified values
outrank catalog fields and borrowed references. Billing notes: a probe bills its input
tokens (one 256k-window probe ≈ 130k input tokens at that model's input rate), HTTP 4xx
counts as a definitive rejection, timeouts are retried once and otherwise skipped as
inconclusive (never recorded).

## Install

```sh
# from a git URL
omp plugin install github:YOU/omp-aihub

# or link a local checkout
omp plugin link /path/to/omp-aihub
```

## Provide the API key

Either works:

- `/login` → pick **metranet AI hub (aihub)** and paste your `sk-…` key (stored credential wins), or
- `export AIHUB_API_KEY=sk-…` (env fallback)

`AIHUB_BASE_URL` overrides the gateway URL (other new-api deployments work unchanged).

## Auto-update

Model/pricing/context refresh automatically through omp's model cache (24 h TTL).
Force an immediate refresh with `/aihub-refresh`. `/aihub-usage` prints account credit,
key quota, and the last-window per-model spend breakdown.

## Notes

- Registers under provider id `aihub`.
- Models route by the gateway's `supported_endpoint_types`: `anthropic` → `/v1/messages`,
  `openai-response` → `/v1/responses`, `gemini` → GenerateContent, else Chat Completions.
  Image-generation models land in the `image` kind for `generate_image`.
- Estimated prices use the public catalog group ratio; exact per-request billing can differ
  if your key's group differs — the `/aihub-usage` command always shows gateway-exact quota.
- pi support: same file loads via `pi.extensions`; dynamic refresh uses pi's
  `refreshModels` and login returns `OAuthCredentials`. pi does not render the omp
  `usage` surface, so account credit shows via `/aihub-usage` there.
