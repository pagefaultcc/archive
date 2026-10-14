# AGENTS.md — Archive Architecture, Core Invariants & Engineering Guide

This document is the authoritative technical reference for any AI assistant or engineer working on this repository. It documents the architecture, database design, background workers, failure modes encountered, critical fixes implemented, and engineering rules that must not be broken.

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
- **Database:** PostgreSQL 17 with migrations `001_initial.sql` through `009_telegram_blacklist.sql`.
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

---

## 3. Directory Layout & Roles

```
.
├── backend/
│   ├── cmd/api/main.go             # Server entry point, bootstrap, cleanup loops
│   ├── internal/
│   │   ├── archiveidx/             # Archive indexing, 7zz extraction, cookie parser
│   │   ├── auth/                   # Argon2id hasher, rate limiter
│   │   ├── bootstrap/              # Database initialization & advisory locking
│   │   ├── config/                 # Env loading & validation
│   │   ├── httpx/                  # Handlers, router, session middleware, queue worker
│   │   └── store/                  # PostgreSQL database queries, caches, audit logs
│   ├── migrations/                 # Goose SQL migrations (001-009)
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
│   │   │   ├── settings/           # System settings, Telegram bot credentials, storage stats
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

### Docker Build Caching Tip
When updating backend code without changing system dependencies, bust only the Go build cache layer rather than re-downloading Python packages:
```bash
docker build --target production --build-arg BUILD_ID=$(date +%s) -t archive-api ./backend
```

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
