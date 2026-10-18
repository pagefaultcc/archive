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

## Contributing and reviewing

Use one short-lived branch per feature/fix and open a PR into `main`; do not push directly to `main`. Keep PRs focused, bring in current `main` before merging, and use separate Git worktrees when local agents work simultaneously. `AGENTS.md` contains the same rules for coding agents.

Every PR runs `.github/workflows/review.yml`: **Backend review** enforces `gofmt`/`go vet` and includes PostgreSQL integration tests, **Frontend review** builds Next.js and runs Vitest, and **Review gate** fails unless both pass. A separate **Lint review** job reports ESLint findings (currently non-blocking until the existing react-hooks findings are fixed, then it joins the gate). These checks do not publish images. A different person reviews the PR; after approval and passing checks, squash merge and delete the branch. Production image publishing remains main-only, including manual image-workflow dispatch.

### Enable protected merges (repository admin)

The desired policy is checked in as `.github/main-protection.json`, but GitHub does not apply that file automatically. After the first PR has registered `Review gate`, an administrator with suitable repository permissions can apply it:

```sh
gh api --method PUT repos/pagefaultcc/archive/branches/main/protection \
  --input .github/main-protection.json
```

This requires an up-to-date branch, `Review gate` from GitHub Actions, one other person's approval after the last push, dismissal of stale approvals, linear history, and no force-push or branch deletion; administrators are included. The repository is public, so protected branches are available on the free plan. Repository policy changes can replace existing rules: inspect the current protection before applying this file.

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

## Releases

Production images publish on every `main` merge with `latest` and `sha-<commit>` tags; roll back by pinning `image:` to `:sha-<commit>` in Compose. Each publish job also runs a report-only Trivy scan of the pushed image and surfaces HIGH/CRITICAL, unfixed findings in the job summary.

To mark a release, run the **release** workflow from the Actions tab (or `gh workflow run release.yml -f version=v1.2.3`) while on `main`: it validates the unused `vX.Y.Z` tag, tags the current `main` commit, and creates a GitHub release with auto-generated notes from merged PRs.

## Private PR previews

Previews run on a **separate dedicated Linux amd64 VPS**, never the production host. Each enabled same-repository, non-draft PR gets an isolated API, frontend, PostgreSQL instance, upload storage, network, random disposable credentials, and synthetic example data. Builds use trusted host-installed definitions and local images; they do not wait for GHCR publication or the production timer. A preview still needs a source build and health checks. Each push replaces its disposable data; closing the PR removes its resources. Dependabot dependency-update PRs skip previews — GitHub does not pass Actions secrets to Dependabot-triggered runs — while still receiving full review checks.

The gateway binds only to the preview host's loopback interface. Reviewers connect through SSH; there is no public preview endpoint or production-data connection. Hostnames such as `pr-42.localhost` separate browser sessions between previews, which different ports alone cannot do. Runtime networks have no normal external egress; do not use previews for real Telegram imports or account/service validation.

The configured preview host details live with the operators (not in this public repository): `archive-preview@<preview-host>` with a separate administrator identity, kept apart from production. Its rootless service account has an aggregate 6 GiB memory, 3.5 CPU, and 4096-task ceiling. The initial reviewer identity is the administrator's existing SSH key, distinct from the Actions deployment key. Additional reviewers need their own public key installed with the same restricted review role.

### Prepare and install the preview host

1. Provision a dedicated host and a non-root service user, conventionally `archive-preview`. Install Python 3.12+, Docker Engine/Compose and [rootless Docker](https://docs.docker.com/engine/security/rootless/) for that user. Rootless resource limits require cgroup v2/systemd delegation; enable the user's Docker service and lingering. Do not add the user to the privileged system Docker group or copy production credentials to this machine.
2. Create a dedicated deployment SSH key and provide each reviewer with a separate SSH identity. The deployment key cannot open tunnels; reviewer keys may open loopback-only tunnels and read disposable preview login credentials, not execute arbitrary shell commands.
3. Copy the **reviewed** `deploy/preview/` directory to the preview host. Install it as root using the actual dedicated host name and public-key files:

   ```sh
   sudo python3 deploy/preview/install.py \
     --user archive-preview \
     --dedicated-host "$(hostname)" \
     --deploy-key-file /absolute/path/deployment.pub \
     --review-key-file /absolute/path/reviewer.pub
   ```

   See `python3 deploy/preview/install.py --help` for prerequisites and restrictions. `--review-key-file` is repeatable: supply every reviewer key to retain, because installation replaces the controller's authorized-key list. Trusted code is installed under `/opt/archive-preview`, configuration under `/etc/archive-preview/config.json`, and private state under the service user's directory. Install only on the dedicated preview host. Validate SSH configuration before reloading it; use a second SSH session to confirm reviewer forwarding and deployment-key restrictions.
4. Verify the preview server's SSH host-key fingerprint through its administrator/console. Prepare an OpenSSH `known_hosts` entry containing the verified public key. Never auto-trust a key obtained during deployment.

Rootless Docker and a dedicated host reduce risk; they are not a guarantee against malicious-code/container escapes. PR source executes only in build/runtime containers, with no host Docker socket, GitHub token, SSH keys, production files, or controller configuration mounted. Use only trusted collaborators' same-repository PRs. Uploaded archives and temporary data are bounded disposable storage, not a copy of the research vault.

### Configure GitHub Actions

Once host installation and SSH verification are complete, set these repository settings:

| Kind | Name | Value |
|---|---|---|
| Variable | `ARCHIVE_PREVIEW_SSH_TARGET` | `archive-preview@your-preview-host` |
| Variable | `ARCHIVE_PREVIEW_SSH_PORT` | Optional SSH port; defaults to `22` |
| Secret | `ARCHIVE_PREVIEW_SSH_KEY` | Dedicated deployment private key, never a personal or production key |
| Secret | `ARCHIVE_PREVIEW_KNOWN_HOSTS` | Administrator-verified OpenSSH host-key entry |
| Variable | `ARCHIVE_PREVIEW_ENABLED` | Set to `true` **last**, after installation and access checks |

Use `gh variable set NAME -R pagefaultcc/archive` and `gh secret set NAME -R pagefaultcc/archive` from an authorized account; supply secrets through stdin/a file, never command-line values or commits. Do not enable previews until the separate host exists. A missing/false enable variable means previews are **not deployed**; a skipped job is not proof of a working preview.

`.github/workflows/preview.yml` deploys the exact PR-head commit, checks live PR state/SHA before operations, and serializes events per PR. Forks receive no preview credentials. A separate write-token job updates a sticky PR comment with the private URL, commit, and access commands—never login passwords. Preview failure does not substitute for, or disable, the required review checks.

### Review a preview

For PR 42, use your **reviewer** SSH identity and keep this tunnel running:

```sh
ssh -N -L 127.0.0.1:20042:127.0.0.1:20042 archive-preview@your-preview-host
```

Open `http://pr-42.localhost:20042`; modern browsers resolve `*.localhost` to loopback. If your browser/system does not, map that exact hostname to `127.0.0.1` locally. Retrieve the disposable login in another terminal:

```sh
ssh archive-preview@your-preview-host credentials 42
```

Use the identity/SSH port provisioned by the operator. Never use the Actions deployment key as a reviewer key, forward a preview port on `0.0.0.0`, post credentials in a PR, or upload real research data.

### Status and teardown

Review identities can request `ssh archive-preview@your-preview-host status 42`. Closing a PR triggers teardown when previews are enabled. An operator can remove an orphan on the preview host:

```sh
sudo -u archive-preview python3 /opt/archive-preview/controller.py destroy 42
```

Cleanup is scoped to that PR; it does not run a global Docker prune. Supported PR numbers are 1–40000, mapped to loopback ports 20001–60000. Keep the enable variable active until open previews are removed, or perform operator teardown before disabling/decommissioning the host.

