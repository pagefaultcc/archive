# Archive

Dockerized user, role, session, and audit foundation for an archive-management product. This milestone provides login, full user lifecycle management (create, edit username, reset password, suspend/reactivate, soft-delete/restore, active session inspection/revocation), custom RBAC role and permission administration, and an append-only audit log; archive upload, extraction, and indexing are intentionally out of scope.

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
