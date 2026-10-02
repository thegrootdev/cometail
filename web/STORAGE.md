# Token identity storage

The Next.js Node server accepts `POST /api/metadata`. Plain launch, Sell your tail,
and Open-vault resume all use the same upload component and object-storage adapter.
The browser crops an image to 512 × 512 and asks the wallet to sign a free message
binding the image hash, token fields, site origin and timestamp. The server verifies
Ed25519 authorization, rejects stale requests, decodes the image and re-encodes it
as a single square WebP without source metadata. Image and JSON filenames are
content hashes. Transactions use the returned JSON URI through the existing builders.
A rejected upload cannot start a vault or launch transaction.

## Production: Cloudflare R2

Enable R2 on the operator's Cloudflare account, create a Standard bucket and connect
`media.cometail.fun` as its public custom domain. Create bucket-scoped object read/write
credentials. Set these on the **Next.js server**, never in public client variables:

```
COMETAIL_STORAGE_PROVIDER=r2
COMETAIL_APP_ORIGIN=https://cometail.fun
COMETAIL_MEDIA_ORIGIN=https://media.cometail.fun
R2_ACCOUNT_ID=<account ID>
R2_BUCKET=<bucket name>
R2_ACCESS_KEY_ID=<bucket-scoped access key>
R2_SECRET_ACCESS_KEY=<bucket-scoped secret>
```

The public origin must use HTTPS and produce metadata URLs shorter than 200 bytes.
Keep uploaded objects durable: on-chain token metadata points at these URLs. Do not
apply expiring lifecycle rules. Allow public GET requests to the custom media domain;
use immutable cache headers. CORS is not needed for server-to-R2 uploads. If clients
need to fetch metadata across origins, allow GET from the app origin on the media
bucket. No credentials or signed upload URLs are returned to a browser.

The upload route has a 6 MB body limit, accepts PNG/JPEG/WebP up to 5 MB, and rejects
animated, oversized or malformed images. Decoding is bounded at 16 megapixels.
Authorization expires after five minutes. A per-wallet process-local limiter allows
12 attempts/hour; it is supplemental and resets on restart. Before public traffic,
apply an edge request rate limit to `/api/metadata`, with a shared budget across
instances, and monitor R2 storage/request usage. Wallet signatures prove wallet
control, not scarcity of wallets. The lead should review the upload endpoint before
production enablement.

Missing configuration fails with a designed 503 state, before a chain transaction.
R2 outages also fail closed. This adapter has no browser-side key and no fallback
from production to ephemeral local storage.

## Local development

Run `next dev -p 3100` with `COMETAIL_STORAGE_PROVIDER=local`,
`COMETAIL_APP_ORIGIN=http://localhost:3100`, and
`COMETAIL_MEDIA_ORIGIN=http://localhost:3100`. Local objects go to `.local/media/`
and are served by `/api/media/[key]`. Both writes and reads are refused in production.
No cloud account is needed to exercise crop, authorization and metadata creation.
