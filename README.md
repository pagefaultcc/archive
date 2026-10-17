# Archive

Researcher-facing archive for infostealer logs. Archive ingests ZIP, RAR, and 7z collections, indexes their files, parses supported cookie and password records, and organizes extracted artifacts by source and website/domain. Researchers can browse, search, inspect, and export relevant material; administrators manage users, roles, sessions, and audit records. See [PRODUCT.md](PRODUCT.md) for the product purpose, workflows, and capability boundaries.

## Run

Copy `.env.example` to `.env`, replace every credential placeholder, and keep `PUBLIC_ORIGIN` aligned with the externally visible `APP_PORT`. Then run:

```sh
docker compose up --build -d
```

Open `http://localhost:3000/login`. Only the frontend is published, bound to loopback. The API and PostgreSQL remain on the private Compose network.

Authenticated routes require the API and PostgreSQL. Running `npm run dev` or `npm start` inside `frontend/` alone serves the login UI, but sign-in and protected pages remain unavailable until the backend is running at `INTERNAL_API_URL` (development default: `http://127.0.0.1:8080`). The supported full-stack workflow is Compose.

## Test


```sh
docker compose --profile test run --build --rm api-test
docker compose --profile test run --build --rm frontend-test
```

Backend integration tests use a separate tmpfs-backed PostgreSQL service and reset their schema before execution. Test images copy source and dependencies, so the commands behave consistently on Windows and CI.

## Production

Replace the bootstrap and database credentials before first startup, use an HTTPS `PUBLIC_ORIGIN`, and terminate TLS at the externally visible frontend origin. The first successful startup creates the immutable root identity; later restarts preserve its username and password hash. Changing Argon2 memory parameters or the API's 512 MiB limit requires reevaluating the process-wide two-derivation concurrency cap.

## CI and automatic image deployment

Every push to `main` runs a lightweight change detector. Tests and production-image publishing run only for the affected components:

| Changed input | Tests and image publishing |
|---|---|
| Root guidance/Markdown, `docs/**`, or other files outside the build/deployment inputs below | Neither image |
| `backend/**` | Backend unit/PostgreSQL integration tests, then API image |
| `frontend/**` | Frontend build/Vitest, then frontend image |
| `.github/**`, `deploy/**`, `compose.yaml`, `Caddyfile`, `.env.example` | Both components |
| Manual workflow dispatch or unavailable comparison baseline | Both components |

Files inside either image context are treated conservatively as build inputs, including Markdown that could be bundled or rendered by the application. Change detection covers the complete push range, including deletions and renames. Runs queue instead of canceling a prior run whose changes affect a different image.

Selected images are published to `ghcr.io/pagefaultcc/archive-api` and `ghcr.io/pagefaultcc/archive-frontend` with `latest` and `sha-<commit>` tags. Unchanged images retain their previous tags; a documentation-only commit does not create new image tags.

The configured VPS timer checks GHCR every five minutes. It pulls both image references but only recreates containers whose image or local Compose configuration changed. Documentation-only changes leave the running application unchanged. Compose, Caddy, and systemd configuration are not delivered through image pulls and must be synchronized separately when edited.
