# Contora API

The backend of Contora, a multi-tenant document management system. It is a NestJS application that serves a REST API under `/api/v1` and stores its data in MongoDB. Uploaded files are kept on local disk, addressed by their SHA-256 hash.

The Angular web client lives in a separate repository.

## Features

- Tenants, users, roles and invitations, with JWT access tokens and rotating refresh cookies
- Content types with typed, validated fields
- Records with immutable versions, compare and restore, and check-out
- Nested folders, trash, tags, comments with mentions and live notifications
- Full-text search with Arabic-aware matching, saved searches and CSV export
- Per-folder and per-record access grants, and expiring public share links
- An append-only audit log and an activity report for admins
- An optional AI assistant and metadata extraction from uploaded files (Azure OpenAI)
- Generated OpenAPI 3.1 document at `/api/v1/openapi.json` and a readable reference at `/api/v1/reference`

## Requirements

- Node.js 22+
- pnpm 11
- MongoDB (local, Docker or Atlas)

## Getting started

```bash
pnpm install
cp .env.example .env   # then set MONGODB_URI and JWT_SECRET
pnpm seed              # optional: loads a demo tenant
pnpm start:dev         # http://localhost:3000/api/v1
```

The seed creates the tenant **Acme Corp** with the users `alice@acme.demo` (admin) and `bob@acme.demo` (member), both with the password `Demo1234!`. It refuses to run when `NODE_ENV=production`.

## Configuration

All settings are read from environment variables and validated at start-up; a missing or invalid value stops the process with a message naming it. See [.env.example](.env.example) for the full list.

| Variable | Default | Description |
| --- | --- | --- |
| `MONGODB_URI` | required | Connection string, including the database name |
| `JWT_SECRET` | required | At least 32 random characters |
| `PORT` | `3000` | HTTP port |
| `FRONTEND_URL` | `http://localhost:4300` | Allowed CORS origin and base URL for invitation links |
| `COOKIE_SECURE` | `false` | Set to `true` behind HTTPS (required in production) |
| `STORAGE_DIR` | `./storage` | Where uploaded files are written |
| `MAX_UPLOAD_MB` | `100` | Upload size limit |
| `TRUST_PROXY` | `0` | Number of trusted reverse-proxy hops |
| `AI_PROVIDER` | unset | Set to `azure` with the `AZURE_OPENAI_*` and `AI_MODEL` variables to enable AI features |

## Scripts

| Command | Description |
| --- | --- |
| `pnpm start:dev` | Start in watch mode |
| `pnpm build` / `pnpm start:prod` | Build and run the compiled app |
| `pnpm test` | Unit tests |
| `pnpm test:e2e` | API tests against an in-memory MongoDB |
| `pnpm lint` / `pnpm typecheck` | oxlint and the TypeScript compiler |
| `pnpm seed` | Load the demo data |

The first e2e run downloads a MongoDB binary for `mongodb-memory-server`.

## Docker

```bash
docker build -t contora-api .
docker run -p 3000:3000 --env-file .env -v contora-storage:/app/storage contora-api
```

Health checks: `GET /api/v1/health` (liveness) and `GET /api/v1/health/ready` (database and storage).

## License

[MIT](LICENSE)
