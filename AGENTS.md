# AGENTS.md — Archive Architecture, Core Invariants & Engineering Guide

This document is the authoritative technical reference for any AI assistant or engineer working on this repository. It documents the architecture, database design, background workers, failure modes encountered, critical fixes implemented, and engineering rules that must not be broken.

Read [PRODUCT.md](PRODUCT.md) for the research purpose, users, workflows, current capability boundaries, and open product decisions. Follow [DESIGN.md](DESIGN.md) for UI work; this document owns technical guidance.

---

## 1. System Architecture & Topology

```
┌────────────────────────────────────────────────────────┐
│                        Caddy                           │
│           (Reverse Proxy / Gateway :8443)              │
└───────────────┬────────────────────────┬───────────────┘
                │                        │
       /api/*   │                        │  /*
                ▼                        ▼
┌─────────────────────────┐    ┌─────────────────────────┐
│     Go 1.25 API         │    │  Next.js 16 (Turbopack) │
│   (:8080 internal)      │    │    (:3000 internal)     │
└───────────┬─────────────┘    └─────────────────────────┘
            │
            ├─► PostgreSQL 17 (Pool: 8 connections, migrations via Goose)
            ├─► 7-Zip standalone binary (`/usr/local/bin/7zz`)
            ├─► Storage Volume (`/var/lib/archive/uploads`)
            └─► Python 3 Telethon Engine (`/app/scraper/tg_engine.py`)
```

- **Backend:** Go 1.25 (`backend/`), standard library HTTP router + `jackc/pgx/v5`, strict PHC Argon2id passwords (`m=65536, t=3, p=2`), origin validation, sliding session cookies.
- **Frontend:** Next.js 16 App Router + Turbopack + React 19 + Tailwind CSS + Radix UI / shadcn/ui.
- **Database:** PostgreSQL 17 with migrations `001_initial.sql` through `015_archive_credentials.sql` (prod history additionally has versions 12–14 applied from an untracked experiment — see §2.E).
- **Archive Extractor / Indexer:** In-memory streaming ZIP reader (`archive/zip`) for uncompressed/pass-free archives; external `7zz` pipeline for RAR, 7z, and encrypted archives.
- **Telegram MTProto Scraper:** Python 3 + Telethon UserBot (`backend/scraper/tg_engine.py`) communicating with Telegram Datacenters over MTProto 2.0 with parallel segmented downloads.

---

## 2. Hard-Fought Bugs & Critical Invariants ("The Big Lessons")

### A. Stealer Logs & PostgreSQL Non-UTF8 Abortions
- **The Problem:** Stealer logs (RedLine, Vidar, Raccoon, Lumma, Meta, etc.) collected from Windows machines contain raw binary files, Windows-1251 Cyrillic text, Latin-1 text, and embedded null bytes (`\x00`).
- **The Failure Mode:** When Go passes raw string bytes containing invalid UTF-8 sequences (such as `0xbe`) or null bytes to PostgreSQL, Postgres immediately aborts the entire transaction with:
  ```
  ERROR: invalid byte sequence for encoding "UTF8": 0xbe (SQLSTATE 22021)
  ```
  When this happens, the batch insertion of thousands of cookie domains fails completely, leaving the archive with 0 cookies in the database.
- **The Invariant:**
  - **ALWAYS** sanitize strings using `strings.ToValidUTF8(s, "")` and strip `\x00` null bytes before executing any SQL query, `COPY` command, or `tx.Exec` in `backend/internal/store/archives.go` and `backend/internal/archiveidx/cookies.go`.
  - **Zero-Width & BOM Stripping:** In `NormalizeRootDomain`, always trim byte order marks and invisible characters: `strings.Trim(host, "\ufeff\u200b\u200c\u200d\u200e\u200f \t\r\n.")`. Otherwise, domains like `\ufeffchatgpt.com` fragment into separate bogus entries.

### B. High-Volume Table Locking & Mutex Scope (Millions of Rows)
- **The Problem:** The `archive_cookie_domains` table holds millions of rows (6.5M+ rows in production). An aggregation query like `SELECT domain, count(*)... GROUP BY domain` takes 10–25 seconds.
- **The Failure Mode:** Holding an in-memory lock (`s.cookieCache.mu.Lock()`) across database queries causes every concurrent HTTP request (such as checking domain details or searching) to block and time out.
- **The Invariant:**
  - **NEVER hold a mutex across network calls or database queries.** Fetch rows outside the lock, and only acquire the lock when assigning the in-memory cache pointer.
  - **Independent Mutexes:** Per-domain log queries (`domainLogs`) use their own `logsMu sync.RWMutex`, isolated from the table-wide summary cache (`mu`).
  - **Composite Indexes:** Lookups for specific domains MUST use composite index `archive_cookie_domains_domain_sort_idx` on `(domain, cookie_count DESC, id DESC)`. This reduces query execution time from 20 seconds to 24 milliseconds.
  - **Cold Startup:** Global domain cache aggregation runs in a background goroutine on server start (`go st.ensureCookieDomainsLoaded(...)`), never blocking the HTTP listener.

### C. Telegram MTProto Downloader (`tg_engine.py`)

#### 1. Cross-DC Authorization Handshake
- Telegram document files are distributed across DC 1 through DC 5. A user's session may be on DC 4 while the file is hosted on DC 1.
- `MTProtoSender.connect()` generates a local transport key, so `sender.auth_key` is not empty. Checking `if not sender.auth_key:` is a fatal mistake—it evaluates to `False` and skips authorization export/import.
- **Rule:** If `dc_id != client.session.dc_id`, you **MUST** explicitly export and import auth:
  ```python
  if is_cross_dc:
      auth = await client(ExportAuthorizationRequest(dc_id))
      client._init_request.query = ImportAuthorizationRequest(id=auth.id, bytes=auth.bytes)
      await sender1.send(InvokeWithLayerRequest(LAYER, client._init_request))
  ```
  Skipping this causes every `GetFileRequest` on the target DC to throw `ConnectionNotInitedError`.

#### 2. MTProto 4 KiB Chunk Boundary Sizing
- Telegram's MTProto protocol enforces that `limit` in `GetFileRequest` must be a multiple of 4,096 bytes (4 KiB) and at most 524,288 bytes (512 KiB).
- **Rule:** NEVER calculate `limit = file_size - offset` for the last chunk. If the remainder is not an exact multiple of 4096, Telegram rejects it with `LimitInvalidError: An invalid limit was provided`.
- **Fix:** Always pass `limit = chunk_size` (524288). Telegram automatically truncates at EOF and returns the exact remaining bytes.

#### 3. Worker Retries, Timeouts & Failover
- Bare `except Exception: await queue.put(part); await asyncio.sleep(0.5)` creates an infinite hanging loop.
- **Rule:**
  - Add per-chunk timeout: `asyncio.wait_for(client._call(sender, GetFileRequest(...)), timeout=40.0)`.
  - Max retries per chunk: 3. Max consecutive errors across workers: 12.
  - If parallel download fails, log to `sys.stderr`, remove partial files, and immediately fall back to Telethon's built-in single-threaded `client.download_media()`.
  - Auto-refresh expired file references (`FileReferenceExpiredError`) by re-fetching the message from the channel entity.
  - Pre-check disk space using `os.statvfs` before beginning multi-gigabyte downloads.
  - On unrecoverable error, write JSON `{"status": "error", "message": "..."}` to stdout AND exit with status 1 so the parent process catches it.

### D. Vault Deduplication: Same-Name vs. Same-Content
- **The Problem:** In Telegram channels, different archives are frequently posted with identical filenames (e.g. `Logs.zip`, `ArtHouse Cloud Logs v3.zip`, `Daily_Dump.zip`).
- **The Schema:** The `archives` table has **NO unique constraint on `filename`**. Multiple archives with the same filename can coexist.
- **The Invariant:**
  - Pre-download duplicate detection must check `(lower(filename), size_bytes)`.
    - Same filename + same size = Already in Vault (`alreadyArchived = true`).
    - Same filename + different size = **NEW Archive** (`alreadyArchived = false`).
  - Storage files on disk are keyed by SHA-256 (`/var/lib/archive/uploads/<sha256>.ext`), ensuring distinct content never overwrites on disk.
  - Post-download duplicate detection uses SHA-256 hash comparison (`GetArchiveBySHA256`).

### E. Prod Goose Version History & Migration Numbering
- **The Problem:** Production `goose_db_version` contains versions **12, 13, 14** applied by an earlier untracked experiment (it left behind an `archive_cookie_domain_summary` table nothing references). Goose tracks only `version_id` — **no content checksums**.
- **The Invariant:**
  - New migration files MUST use version numbers **≥ 015** with no collision against prod-applied ids, or goose silently skips them in prod while applying them on fresh installs (divergent schemas).
  - After creating or renaming a migration, re-run the HTTP integration suite against a **fresh** test database (`TEST_DATABASE_URL` + `go test -p 1 ./internal/httpx/ ./internal/bootstrap/`) before deploying.
  - Both test packages share one `TEST_DATABASE_URL`; their reset helpers drop **all** migration tables explicitly. Keep that list complete when adding tables.

---

## 3. Directory Layout & Roles

```
.
├── backend/
│   ├── cmd/api/main.go             # Server entry point, bootstrap, cleanup loops
│   ├── internal/
│   │   ├── archiveidx/             # Archive indexing, 7zz extraction, cookie & credential parsers
│   │   ├── auth/                   # Argon2id hasher, rate limiter
│   │   ├── bootstrap/              # Database initialization & advisory locking
│   │   ├── config/                 # Env loading & validation
│   │   ├── httpx/                  # Handlers, router, session middleware, queue worker
│   │   └── store/                  # PostgreSQL database queries, caches, audit logs
│   ├── migrations/                 # Goose SQL migrations (001–015; 013–014 exist only in prod history)
│   ├── scraper/
│   │   └── tg_engine.py            # Telethon MTProto UserBot CLI engine
│   ├── 7zz                         # Standalone Linux x86_64 7-Zip executable
│   └── Dockerfile                  # Multi-stage Golang + Alpine + Python build
├── frontend/
│   ├── app/                        # Next.js 16 App Router pages
│   │   ├── (app)/                  # Authenticated app shell
│   │   │   ├── archives/           # Vault archive explorer, downloads, delete
│   │   │   ├── channels/           # Telegram channel scraper & download queue
│   │   │   ├── cookies/            # Cookie explorer, domain search, Netscape zip export
│   │   │   ├── search/             # Global cross-archive regex/exact file search
│   │   │   └── users/              # User management & RBAC role assignments
│   │   └── login/                  # Argon2id authenticated login
│   ├── components/                 # React UI components, shadcn/ui primitives
│   ├── lib/api.ts                  # Type-safe API client with session cookie handling
│   └── tests/                      # Vitest unit & behavior test suites
├── compose.yaml                    # Production & dev Docker compose topology
├── Caddyfile                       # Caddy reverse proxy & TLS configuration
└── README.md                       # High-level product overview & setup guide
```

---

## 4. Key Workflows & Commands

### Running Locally
```bash
# 1. Environment template
cp .env.example .env
# Edit credentials in .env

# 2. Run with Docker Compose
docker compose up -d --build
```

### Running Tests
```bash
# Backend unit tests
cd backend && go test ./...

# Frontend unit tests & build check
cd frontend && npm run build && npm test
```

### Deploying (CI → GHCR → VPS auto-pull)
Push to `main` triggers a lightweight change-detection job in `.github/workflows/docker.yml`. `backend/**` selects API tests (including PostgreSQL integration) and its image; `frontend/**` selects frontend build/tests and its image. Changes under `.github/**`, `deploy/**`, or to `compose.yaml`, `Caddyfile`, and `.env.example` conservatively select both. Root guidance/Markdown and other files outside those inputs select neither; content inside an image context remains a build input even when it is Markdown. Manual dispatch or an unavailable baseline rebuilds both. Detection compares the full push range with NUL-delimited filenames, not just the last commit.

Each selected image is published only after its own tests pass, using `:latest` and `:sha-<sha>` tags in `ghcr.io/pagefaultcc/archive-{api,frontend}`. An unchanged image keeps its existing tags; do not assume every commit has a SHA tag for both images. Branch runs queue (`queue: max`), rather than canceling a different component's pending publication. See README's CI section for the change matrix.

The VPS (`deploy@85.9.208.82`, deploy dir NOT a git repo) runs `archive-autodeploy.timer` (every 5 min): `docker compose pull` → `up -d` only when the image/config changed → prune images older than 7 days. Migrations run automatically on api startup under the bootstrap advisory lock. Registry auth is a classic PAT with `read:packages` only (ghcr.io does not accept fine-grained PATs) stored in `/home/deploy/.docker/config.json` (0600). Deployment-file changes must still be synchronized separately: pulling images does not fetch Compose/Caddy/systemd files. Fallback without registry: rsync `backend/` + `frontend/` into `/home/deploy/archive`, then `docker compose build api frontend && docker compose up -d` — layer order already caches Python deps and go modules; the Dockerfile `BUILD_ID` ARG is unused.

---

## 5. Security & Operation Rules

1. **Never Commit Secrets:** `.env` is ignored by `.gitignore`. Never hardcode passwords, API hashes, or Telegram session strings in code or git commits.
2. **Advisory Locking on Bootstrap:** Multi-instance database migrations run under a single PostgreSQL advisory lock (`SELECT pg_advisory_lock(918273645)`) so parallel containers never race on migrations.
3. **Session Cookies:** `archive_session` cookie is `HttpOnly`, `SameSite=Lax`, with secure origin matching (`PUBLIC_ORIGIN`).
4. **Temporary File Lifecycles:**
   - Channel downloads use `tg-download-*` temp files, renamed to SHA-256 storage path upon index completion.
   - On error, `_ = os.Remove(tmpPath)` is guaranteed in all defer and error branches.
   - Cookie download zips in `/tmp/archive-downloads` are automatically purged after 5 minutes by a background timer.

---

## 6. High-Throughput Parallel Architecture & Multi-Threading

### A. Concurrent Telegram Download Queue
- **Old Behavior:** `serverQueueWorker` processed one item at a time sequentially.
- **New Behavior:** `maxConcurrent = 3` parallel download workers run concurrently via goroutines, each managing an isolated MTProto download subprocess.
- **API Contract:** `GET /api/channels/queue` surfaces `activeList` (all currently downloading streams) and `totalSpeedMbps` (combined throughput).

### B. Multi-Threaded In-Memory Cookie Extraction
- **In-Memory ZIP Worker Pool:** `extractZipCandidateCookies` uses a multi-worker goroutine pool (`runtime.NumCPU() * 2`, minimum 4 workers) to decompress, signature-check, and parse candidate cookie files in parallel across all CPU cores.
- **7-Zip Multi-Threading:** `run7zExec` automatically prepends `-mmt=on` to utilize all hardware threads for technical listings, verifications, and extractions.

### C. Database & Docker Resource Tuning
- **PostgreSQL:** Tuned with `shared_buffers=2048MB`, `work_mem=128MB`, `maintenance_work_mem=1024MB`, `max_parallel_workers=16`, `max_parallel_workers_per_gather=4`, `max_connections=100`, and `synchronous_commit=off` for high-throughput batch insertions.
- **Connection Pool:** `pgxpool` size expanded to `MaxConns = 25` and `MinConns = 5` to handle concurrent queue downloads, cookie insertions, and API requests without pool starvation.
- **Full CPU Trust:** Docker containers run without CPU quotas (`GOMAXPROCS=0`), utilizing 100% of host CPU threads.

### D. Smooth Background Operations & Complete Queue Cancellation
- **Instant Archive Deletion:**
  - Previously, `DELETE /api/archives/{id}` took 10–15 seconds synchronously while Postgres deleted 600k+ cascading cookie rows.
  - Now, `MarkArchiveDeleting` immediately updates `status = 'deleting'` in 1 ms (omitted by `ListArchives`), and returns HTTP 204 immediately.
  - The heavy cascade delete (`archive_cookie_domains`, `archive_entries`, file on disk, and audit logging) runs asynchronously in a background goroutine. The UI updates optimistically with zero lag.
- **Complete Queue Cancellation (`clearQueue`):**
  - `channelHandlers` maintains `activeCancels map[string]context.CancelFunc`.
  - Calling `DELETE /api/channels/queue` cancels all running command contexts to immediately SIGKILL active Python downloader subprocesses.
  - Automatically cleans up any orphaned `tg-download-*` files and temporary download exports on disk, and invalidates the in-memory cookie cache.

### E. Bottom Clear-Glass Island Dock UI Navigation
- **Replaced Left Sidebar:** Traditional rigid left-side navigation removed in favor of full-width content viewing and a floating bottom dynamic dock (`BottomIslandDock`).
- **Liquid Glassmorphism:** Styled with `backdrop-blur-2xl`, `bg-[#0c0d0e]/80`, fine translucent border `border-white/[0.14]`, and multi-layer specular inner/outer shadows (`shadow-[0_16px_50px_rgba(0,0,0,0.65),inset_0_1px_1.5px_rgba(255,255,255,0.22)]`).
- **Apple Island Animated Hover & Tooltips:**
  - Tactile spring scaling on icon hover (`hover:scale-115 active:scale-95 ease-[cubic-bezier(0.34,1.56,0.64,1)]`).
  - Animated floating glass pill tooltip above the hovered icon with smooth fade-in and slide-up.
  - Active route indicator with neon green ambient dot underneath.
  - Compact circular user avatar with upward glass dropdown menu.

### F. Cookie Validator & User Account Settings
- **OpenAI Validator (`/validator`):**
  - **Target Verification:** Specifically validates against `auth.openai.com` session tokens (`__Secure-next-auth.session-token`, `session-token`, `oai-did`).
  - **Automatic Instant Verification:** Any queued or custom-inserted cookies are verified **automatically upon insertion** via background goroutine without requiring manual clicks.
  - **Domain Gating:** The "Check" and "Send All to Validator" buttons in the Cookies explorer are **strictly gated** to supported domains (`openai.com`). Unsupported domains (Google, Discord, etc.) do NOT show validation buttons.
  - **Mode Separation:** Clean top-level switcher separates Cookie Validator from Password Validator (marked as *Work in progress*).
  - **Anti-Slop UI Principle:** No buzzwords, verbose text, redundant status tags ("Vault Online", "Auto-Verification Active", etc.). Metrics are clean and plain: "Total", "Not Checked", "Valid", "Not Valid".
- **User Account Settings (`UserMenu`):**
  - Clicking the user profile avatar opens an instant upward dropdown menu with a dedicated "User Settings" option.
  - Opens a clear-glass dialog allowing the user to view account details, change passwords (`POST /api/auth/change-password` with Argon2id re-hashing and constant-time old password verification), and view active session badges.

### G. Route Transition Physics & Instant-Interaction Invariants
- **Apple-Style Tab Route Transitions:**
  - Switching between main tabs (`/archives`, `/search`, `/cookies`, `/validator`, `/channels`, `/settings`) triggers `.apple-tab-enter` (200ms `cubic-bezier(0.16, 1, 0.3, 1)` fade + 6px upward slide).
- **ZERO Animation Rule for Tactical Interactions:**
  - **NEVER animate log selection:** Clicking through individual log files in Cookies, Search, or Validator updates the code viewer **instantly** (`transition-none`) with zero layout shift or delay.
  - **NEVER animate profile logout menu:** The profile avatar dropdown menu uses `transition-none` so clicking the user avatar and selecting logout is instant with zero sluggishness.
- **Non-Blocking Search & Cookies:**
  - **Blank Search Fast-Path:** Blank queries use a `reltuples` estimate and primary key index scan (`ORDER BY e.id DESC`), avoiding the large disk sort. Unavailable/nonpositive estimates fall back to `count(*) WHERE is_dir = false`; never expose PostgreSQL's unknown-statistics sentinel (`-1`) as a result count.
  - **Abortable Requests:** `GlobalSearchVault` and `CookiesVault` use `AbortController` to abort in-flight queries immediately when navigating away.
  - `ListCookieDomains` limit is capped at 500 (UI renders 300) to keep JSON payloads small (~30 KB) and parse in <2ms.
  - In `ensureCookieDomainsLoaded`, a single-flight `atomic.Bool` (`loading`) prevents multiple concurrent 7.1M-row table scans on cold restarts.

### H. View-Based Virtual Scrolling (Every-UUID Style for 1.25M+ Websites)
- **The Challenge:** The vault contains 1,259,000+ unique root domains. Transferring or mounting all domains into the DOM crashes the browser main thread.
- **Paginated Streaming API:** `GET /api/cookies?limit=150&offset=0&q=` returns paginated domain chunks with `totalDomains` and `filteredCount`. In-memory filtering across all 1.25M domains in Go executes in ~10 ms.
- **View-Based Virtual Windowing (`CookiesVault`):**
  - Fixed row height (`ROW_HEIGHT = 52px`), buffer overscan (`OVERSCAN = 6`).
  - Only visible rows (`~18` DOM nodes) are mounted in the DOM at any millisecond based on `scrollTop` and `containerHeight`.
  - Top and bottom spacers (`paddingTop`, `paddingBottom`) preserve accurate native scrollbar height.
  - Infinite scroll dynamically streams next chunks as the user approaches the bottom of the list.
  - Maintains 120 FPS silky smooth scrolling with zero DOM lag or memory bloat.

### I. Credential Index & URL-Based Password Search
- **What:** Every archive is additionally mined for stealer-log password files (`passwords.txt`, `Password.txt`, per-domain files under `Passwords/` folders). Parsed `url/login/password` rows land in `archive_credentials` (migration `015`; prod goose history already had versions 12–14 applied from an untracked earlier experiment, so this file was renumbered to skip them) keyed by normalized root `domain` (reuses `NormalizeRootDomain`), so searching `.auth.openai.com` resolves to `openai.com`.
- **Extraction:** `archiveidx/credentials.go` mirrors the cookie pipeline: in-memory ZIP worker pool fast path for plain zips, `7zz` include-filter pass (`-ir!*password*`, binary/SQLite exclusions) for 7z/rar/encrypted. Supported line shapes: `url\tlogin\tpass` (RedLine/Vidar/Lumma/Meta), `url\tlogin:pass`, `login\tpass\turl`, `url|login|pass`, and colon-only forms (`site.com:login:pass`, `https://site/path:login:pass`, bare `login:pass` attributed via per-domain file names). Rows without any resolvable URL are dropped.
- **API:** `GET /api/passwords?q=&limit=&offset=` (case-insensitive substring over `domain`/`url`, trigram GIN indexes, `ORDER BY id DESC`, exact `totalCount` for filtered queries, `reltuples` estimate for the empty-query fast path). Extraction runs at every `indexArchiveCookies` call site (upload, unlock, reindex, channel import), so reindexing backfills credentials for existing archives.
- **UI:** `/search` has a Files/Passwords tab switcher (`search-tabs.tsx`); the Passwords tab renders the URL → user:pass table with masked passwords (global reveal toggle), per-row copy, source archive/file attribution, and Load-more pagination (200/page).

## 7. Frontend Design System & UI Stack
- **Design language:** the visual contract (color tiers, alpha ladder, shape, motion, component recipes, Do/Don't) lives in the repo-root **`DESIGN.md`** — follow it for every UI change. This section covers the tooling stack only.
- **Framework:** Next.js 16 App Router + React 19 + Turbopack; dark-only theme.
- **Styling:** Tailwind CSS **v4** with CSS-first config — there is NO `tailwind.config`; all theme tokens live in `app/globals.css` (`@theme inline` maps CSS variables to Tailwind utilities).
- **Components:** shadcn/ui, `new-york` style, neutral base color, CSS variables on (`components.json`); primitives live in `components/ui`, add new ones with `npx shadcn@latest add <name>`. Radix primitives via `@radix-ui/react-*` + the consolidated `radix-ui` package.
- **Icons:** lucide-react exclusively — never introduce a second icon set.
- **Toasts:** sonner (`components/ui/sonner.tsx`, theme-aware via `next-themes`). Use `toast.success` / `toast.error`, never `alert`.
- **Forms:** react-hook-form + `@hookform/resolvers` + zod for client validation.
- **Class merging:** always `cn()` from `lib/utils.ts` (clsx + tailwind-merge) for conditional classes.
- **Color system:** "Linear DesignMD" full-dark palette defined in `globals.css` — background `#08090a`, card `#0f1011`, text `#f7f8f8`/`#ffffff`, muted `#8a8f98`, border `rgba(255,255,255,0.05)`, destructive `#f91880`. Existing views also use literal values in classNames (e.g. `bg-[#0f1011]`, `border-[rgba(255,255,255,0.05)]`, `text-[#d0d6e0]`) — when extending a view, match the literals already used in that view.
- **Motion:** Kinetics tokens and `.apple-tab-enter` remain in `globals.css`; custom primitives include `Icon3D`/`SpringCounter` in `kinetics-ui.tsx` and `MotionSurface` in `motion-surface.tsx`. `MotionSurface` reuses `border-beam` for a brief monochrome reveal/hover/focus sweep and breathing feedback during actual work across login and main-view headers. It stops when hidden, offscreen, or reduced motion is requested. `.motion-sheen` is opt-in for primary actions; upload progress reuses shimmer. See `DESIGN.md` §7 for timings and scope, and §6.G here for the unchanged ZERO-animation rule on data interactions.
- **Typography:** Inter via `next/font` for UI; mono stack is `"Berkeley Mono", var(--font-mono-code) [JetBrains Mono via next/font], Monaco, ...` — new mono text uses the existing `font-mono` utility, never a new family.
- **UI tests:** Vitest + `@testing-library/react` + jsdom (`frontend/tests/`, `vitest.config.ts`).
