# Archive — Product Brief

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product Purpose

Archive is a researcher-facing archive for infostealer logs. It ingests log archives, parses their contents, and categorizes indexed artifacts so researchers can find relevant material without manually unpacking and inspecting every source file.

The core job is to turn heterogeneous log collections into searchable, source-attributed research data. Success means a researcher can locate an artifact, understand which archive and file it came from, inspect its contents, and retrieve the relevant material for further analysis.

## Users

The primary user is a researcher investigating infostealer-log datasets. They work with collections of archives containing mixed files, cookie exports, and password records in inconsistent formats.

Administrators manage access to the same research environment through users, roles, permissions, sessions, and audit records. These are supporting capabilities, not the product's primary purpose.

## Core Workflows

1. **Ingest:** upload supported archives, provide an archive password when necessary, or import archive attachments through configured Telegram channels.
2. **Index and categorize:** enumerate archive members and extract supported cookie and password records. Retain the source archive and member path; normalize website domains for lookup.
3. **Investigate:** browse archive contents, search files across the collection, explore cookie records by website, or search password records by URL/domain or login email domain (`@example.com`). Inspect the source rather than relying on an aggregate count alone.
4. **Retrieve:** preview files and download relevant files, archives, or supported exports for further research.
5. **Maintain:** reindex existing collections when parsers improve, manage queued imports, remove unwanted archives, and administer access.

## Categorization and Terminology

- **Archive:** an ingested ZIP, RAR, or 7z container with its own identity, indexing state, and source metadata. Matching filenames do not necessarily mean matching content.
- **Archive entry:** a file or directory inside an archive, identified by its member path.
- **Artifact:** indexed material extracted from a source file, such as a domain-specific cookie record or a URL/login/password record.
- **Website/domain:** a normalized root domain used to group or find supported artifacts. Preserve the original URL and source attribution where available.
- **Archive password:** a password used to unlock a container; it is distinct from password records found inside that container.
- **Validation:** a separate, service-specific check. It is not the same as parsing, indexing, categorization, or establishing the accuracy of a source log.

Current categorization is based on archive/source paths, artifact type, and website/domain. Do not describe it as automatic malware-family attribution, threat scoring, host identification, or campaign clustering; those are not established capabilities.

## Current Capabilities and Constraints

- Supports ZIP, RAR, and 7z archive workflows, including supported password-protected archives and multipart RAR handling. Extraction depends on the archive format and available tooling.
- Provides archive browsing, file previews, downloads, and cross-archive file-name/path search. The Files search is not arbitrary full-text search inside every archived document.
- Extracts supported text-based cookie and password formats. Password search queries indexed URL/domain records; prefix a query with `@` to match the exact login email domain, case-insensitively (for example, `@example.com` excludes `@sub.example.com`). It does not search only for files named `passwords.txt`. Email-domain search works on already indexed logins without reindexing archives.
- Keeps source archive/file attribution alongside extracted records. Password values are masked by default in the search UI and can be revealed or copied explicitly.
- Supports reindexing to backfill existing archives after indexing changes. A parser improvement does not imply that all previously ingested data has already been reprocessed.
- Provides configured Telegram-channel imports and a concurrent download queue. This is an ingestion source, not an infostealer deployed on endpoints.
- Includes a limited OpenAI cookie/session validator. The Password Validator mode is marked work in progress; do not present it as implemented or imply general support for every service.
- Requires authentication and applies the repository's permissions to supported operations. User, role, session, and audit management are part of the existing application.
- Must remain usable with large collections and long source names. Use bounded previews, pagination or virtualized lists, cancellable requests, and non-blocking background work where already supported.
- Input files may be malformed, encrypted, binary, inconsistently encoded, or only partially supported. Parsed output is not a guarantee that every possible record has been recognized.

## Product Principles

1. **Traceability before summaries:** results must lead back to the source archive and file. Distinguish original source content from parsed or normalized representations.
2. **Explicit coverage and state:** make loading, indexing, password-required, failure, empty, and unfinished states understandable. Do not present unsupported or unprocessed material as a successful negative result.
3. **Research over decoration:** prioritize finding, inspecting, and comparing evidence. Do not add speculative dashboards, threat scores, or product claims to fill a page.
4. **Scale without blocking investigation:** preserve responsive browsing and stable data selection while ingestion, extraction, and indexing run.
5. **Separate concerns:** ingestion, parsing, categorization, search, and validation are different operations. A successful step does not establish that the others succeeded.

## Product Identity and Guidance

The product name is **Archive**. Use plain research-oriented language and concrete action labels rather than marketing copy or claims of automatic intelligence.

- [DESIGN.md](DESIGN.md) owns the visual language, motion, component conventions, and asset references.
- [AGENTS.md](AGENTS.md) owns engineering instructions, architecture, technical invariants, and verification workflows.
- [README.md](README.md) owns setup and operating instructions.

Keep those responsibilities separate; do not duplicate implementation details or visual recipes here.

## Evidence on Hand

The implemented archive/indexing workflows live in `backend/internal/archiveidx/`, `backend/internal/store/`, and `backend/internal/httpx/`. The authenticated research views live in `frontend/app/(app)/` and their components in `frontend/components/`.

Repository tests and runnable workflows provide implementation evidence. No customer testimonials, formal accuracy benchmarks, certifications, or guaranteed dataset coverage have been supplied; agents must not invent them.

## Open Product Decisions

The following are not established requirements and must not be silently assumed:

- A classification taxonomy beyond source, artifact type, and website/domain.
- Case management, annotations, collaboration, or tenant isolation.
- Retention schedules, automated redaction, and a formal compliance target.
- Public access, commercial packaging, pricing, or a public marketing site.

Existing behavior is the baseline. Record a confirmed product decision before expanding scope in these areas.
