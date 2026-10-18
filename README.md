# Event Booking API

Backend for an event booking system. Organizers create and manage events. Customers browse events and book tickets. Access is controlled by role. Booking confirmations and event update notifications are sent as real emails by background workers.

- Live API: `https://event-booking-api-c0gv.onrender.com` (docs at `/docs`)
- Performance report: [docs/benchmarks](docs/benchmarks/README.md)

**Stack:** Node.js 24, TypeScript, Fastify, PostgreSQL, Redis with BullMQ, Zod, Brevo for email, Docker, Render.

## Contents

1. [Run it locally](#run-it-locally)
2. [API at a glance](#api-at-a-glance)
3. [Design decisions](#design-decisions)
4. [Performance](#performance)
5. [Deploy to Render](#deploy-to-render)
6. [Trade-offs and next steps](#trade-offs-and-next-steps)
7. [Project layout](#project-layout)

## Run it locally

You need Node 22 or newer and Docker.

```bash
cp .env.example .env              # then set JWT_SECRET to 32 or more random characters
docker compose up -d postgres redis
npm install
npm run dev                       # http://localhost:3000, interactive docs at /docs
```

Migrations run on startup. With `MAIL_DRIVER=json` (the default in `.env.example`) emails are built but not delivered, which is what you want while developing. To send real email set `MAIL_DRIVER=brevo`, `BREVO_API_KEY` and `MAIL_FROM_EMAIL` (a sender you verified in Brevo).

```bash
npm test                          # integration tests, needs the containers above
npm run typecheck
npm run demo -- --email you@gmail.com   # guided walkthrough that prints every request and response
```

## API at a glance

Every endpoint except register, login and health needs `Authorization: Bearer <token>`.

| Method and path | Who | What it does |
|---|---|---|
| `POST /auth/register` | anyone | Create an account with role `organizer` or `customer` |
| `POST /auth/login` | anyone | Get an access token |
| `GET /auth/me` | any user | The current user |
| `GET /events` | any user | Browse upcoming events. Filters: `q`, `from`. Paging: `limit`, `offset` |
| `GET /events/:id` | any user | One event, including tickets still available |
| `GET /events/mine` | organizer | Events you created |
| `POST /events` | organizer | Create an event |
| `PATCH /events/:id` | organizer who owns it | Edit an event. Notifies everyone who booked |
| `GET /events/:id/bookings` | organizer who owns it | Attendee list |
| `POST /events/:id/bookings` | customer | Book 1 to 10 tickets. Optional `Idempotency-Key` header |
| `GET /bookings` | customer | Your bookings |
| `GET /bookings/:id` | customer who owns it | One of your bookings |
| `GET /health`, `GET /health/ready` | anyone | Liveness, and readiness (checks Postgres and Redis) |

Errors always look like this:

```json
{ "error": { "code": "SOLD_OUT", "message": "This event is sold out" } }
```

Validation errors use `VALIDATION_ERROR` and list each field. Status codes: `400` bad input, `401` no or bad token, `403` wrong role or not your resource, `404` not found, `409` business rule (sold out, not enough tickets, and so on), `429` too many login attempts, `503` server busy.

## Design decisions

### Roles and authentication

- Two roles, `organizer` and `customer`, chosen at registration and stored on the user. In a real product organizer accounts would need approval. Here anyone can register as either, so the role checks are easy to test.
- Passwords are hashed with scrypt from Node's standard library. It is memory hard, needs no native build step, and each hash has its own salt. Login does the same amount of work whether or not the email exists, so response time does not reveal which emails are registered.
- Access tokens are signed JWTs (1 hour) that carry the user id and role. A request is authenticated by checking the signature, with no database lookup. The cost is that a changed role or deleted account is only noticed when the token expires, which is why the lifetime is short. The first version read the user from the database on every request. Removing that was one of the performance changes.
- Roles are enforced in an `onRequest` hook, so a wrong role gets `403` before the body is even parsed. Ownership is checked in the service: an organizer can only edit or list attendees of their own events, a customer can only read their own bookings.
- Register and login are limited per IP (20 per minute, backed by Redis) to slow down password guessing and to protect the CPU from expensive hashing.

### Data model

Four tables: `users`, `events`, `bookings` and `event_inventory`. Migrations are plain SQL files in `src/db/migrations`, applied in order on startup under a Postgres advisory lock so two instances starting together cannot collide.

- Money is stored as integer cents. Timestamps are `timestamptz` in UTC.
- Database constraints back up the application rules: capacity above zero, remaining tickets never negative, event end after start, quantity between 1 and 10.
- `events.version` goes up on every change. Notification jobs use it to stay unique and to avoid acting on an update that was rolled back.

### Never selling the same ticket twice

This is the core correctness problem, and also the main performance problem.

A booking has to check that tickets remain and take them, and two customers must never both get the last one. The first version did that with a transaction that locked the event row, read it, inserted the booking and updated the counter. It was correct, but every buyer for an event queued on that one row, and the lock stayed held across five network round trips.

The current version:

1. Splits an event's remaining tickets into several counter rows (`event_inventory`, one row per shard, at most 16, roughly one shard per 100 tickets).
2. Books in one SQL statement: pick a random shard that has enough tickets and is not locked by someone else (`FOR UPDATE SKIP LOCKED`), subtract the tickets, insert the booking. Buyers hitting different shards do not wait for each other.
3. If no free shard fits, which happens when another buyer holds the lock or the order spans shards, it falls back to a slower path that locks all shards in a fixed order and takes tickets across them. A cheap unlocked read first rejects obvious sold out requests so a rush after sellout does not serialize.

Postgres checks each counter row against `remaining >= 0` at the database level, so even a bug in the application cannot oversell. `GET /events/:id` reports the sum of the shards. The concurrency tests book 20 and 120 customers at once into small and large events and check the exact number of successes.

The cost of this design is more moving parts than one counter. I chose it because I measured that a single hot row capped bookings at about 1,500 per second in Postgres alone, and shards removed that cap. See the [benchmarks](docs/benchmarks/README.md).

### Safe retries with idempotency keys

Networks fail, and a customer who retries a booking should not pay twice. `POST /events/:id/bookings` accepts an optional `Idempotency-Key` header. A repeat of the same key by the same customer returns the original booking with `200` instead of creating another. Reusing a key for a different event or quantity returns `409`. A unique index makes this safe even when two retries arrive at the same moment.

### Background jobs

BullMQ on Redis, with these queues:

| Queue | Triggered by | Does |
|---|---|---|
| `booking-confirmation` | a successful booking | Sends the confirmation email to the customer |
| `event-update-fanout` | an event update that changes something customers can see | Expands into one job per customer who booked |
| `event-update` | the fan-out job | Sends the update email to one customer |

Key choices:

- **Real email.** Emails go through Brevo's HTTP API. The usual choice would be SMTP, but Render's free tier blocks SMTP ports, and an HTTPS API also gives clear error codes to retry on. SMTP is still available (`MAIL_DRIVER=smtp`), and a `json` driver exists for tests and load runs.
- **Retries.** Every job retries up to 5 times with exponential backoff. Failed jobs are kept for 7 days for inspection.
- **Fan-out instead of a loop.** Notifying 20,000 customers inside the `PATCH` request made it take 15 seconds. Now the request queues one job and returns in milliseconds. A worker reads the customers in pages of 1,000 (using an index on `event_id, customer_id`) and queues one email job each. A failed email retries on its own, and nobody gets a duplicate because of someone else's failure.
- **No duplicates from retries.** Job ids are built from the event, the version and the customer, so queuing the same notification twice is a no-op.
- **Only visible changes notify.** Title, description, venue and times notify customers. A capacity change is internal and sends nothing.
- **Update is atomic with its notification.** The fan-out job is queued inside the update transaction, before commit. If Redis is down the update fails and the organizer retries, rather than saving a change that nobody hears about. The worker checks that the new version is visible before it starts, so a rolled back update never emails anyone.
- **Booking confirmations are queued after commit, in small batches.** A batch is sent every 20 ms or when 500 are waiting, in a single Redis call, and retried on failure. This keeps the booking response fast. The limit: if the process crashes in that 20 ms window, or Redis stays down through all retries, the booking exists but its email is not sent. The error is logged. A stricter option is a transactional outbox, described under next steps.
- **Delivery is at least once.** In rare cases, for example a worker crash after sending but before acknowledging, a customer could get the same email twice.
- **Process roles.** `PROCESS_ROLE=all` runs the API and workers together, which is what the free deployment uses. `api` and `worker` run them separately so each can scale on its own.

### Validation, errors and docs

Request bodies, queries, params and headers are validated with Zod. The same schemas generate the OpenAPI document served at `/docs`, so the documentation cannot drift from the code. Response bodies are validated as well. Business errors are thrown as a small `AppError` type and one error handler turns everything into the same JSON shape.

### Protecting the service under load

- The database pool has a connection timeout, a statement timeout and an idle-in-transaction timeout.
- Above 2,000 requests in flight the API answers `503` with `Retry-After: 1` immediately. An exhausted pool does the same. Fast refusal beats a long wait followed by a timeout.
- Health checks bypass that limit so the platform does not restart a busy but healthy instance.
- Redis clients used by the API fail fast when Redis is down. The worker connection retries forever, which BullMQ requires.
- On shutdown the server stops accepting requests, flushes pending job batches, drains workers and closes connections.

### Testing

`tests/api.test.ts` runs against real Postgres and Redis (no mocks) and covers registration and login, every role rule, ownership checks, no overselling under concurrent demand, bookings that span inventory shards, idempotent retries, the confirmation email, update notifications to exactly the right customers, no notification for internal changes, and the capacity guard.

## Performance

The task asked how many users can book at the same time and where the first implementation breaks. The full method, tables and reproduction steps are in [docs/benchmarks](docs/benchmarks/README.md). The short version, on one 1 CPU container:

| | First version | Optimized |
|---|---|---|
| Bookings per second | about 430 | about 1,150 |
| p95 latency at 800 concurrent users | 2.2 s | 0.7 s |
| 8,000 users booking at the same instant | 5,400 to 7,100 dropped | 1,600 to 5,400 dropped, usually about half as many |
| `PATCH` on an event with 20,000 bookers | 14.7 s | 21 ms |

On a second laptop (the run shown in the demo video) the same sustained test gave 460 to 513 bookings per second for the first version and 1,300 to 1,470 for the optimized one. Both runs are in the benchmark report.

The first version is kept as the git tag `v1-baseline`. The branch `baseline` is that code plus the load test tools, so the breaking point can be reproduced.

The load test is a set of scripts under `loadtest/`:

```bash
npm run loadtest:seed -- --customers 20000
npm run loadtest:sweep -- --label demo --mode sustained --levels 200,800,3200
npm run loadtest:sweep -- --label demo --mode spike --levels 1000,5000
npm run loadtest:updates -- --label demo --bookers 1000,20000
```

Each run checks that tickets taken equal bookings stored, so a speed gain can never hide an overselling bug.

## Deploy to Render

`render.yaml` describes the whole stack: the web service (built from the `Dockerfile`), a Postgres database and a Redis compatible Key Value instance, all on the free plan. Redis is set to never evict keys, because BullMQ keeps its jobs there.

1. Create a free [Brevo](https://www.brevo.com) account, add and verify a sender email, and create an API key.
2. Push this repository to GitHub.
3. In Render choose **New, Blueprint**, pick the repository and apply it. Render asks for the two secrets marked `sync: false`: `BREVO_API_KEY` and `MAIL_FROM_EMAIL` (the verified sender).
4. When the deploy is live, open `https://<your-service>.onrender.com/health/ready`. It should answer `{"status":"ready"}`. Interactive docs are at `/docs`.

Things to know about the free tier:

- The service sleeps after 15 minutes without traffic and takes about a minute to wake. Hit `/health` before a demo.
- It gets 0.1 CPU, so a load test against it will show far lower numbers than the local benchmarks. Use small levels, for example `--levels 20,50,100,200`.
- The free Postgres database expires after 30 days. Production needs a paid plan.
- Outbound SMTP is blocked, which is why email uses Brevo's HTTPS API.

To load test the deployed service, point the scripts at it (`DATABASE_URL` is the database's external connection string, and `JWT_SECRET` is the value Render generated):

```bash
npm run loadtest:seed -- --customers 2000
npm run loadtest:sweep -- --label render --mode sustained --levels 20,50,100,200 \
  --base-url https://<your-service>.onrender.com --api-url https://<your-service>.onrender.com --network ""
```

## Trade-offs and next steps

- **Outbox for confirmations.** To remove the small window where a booking commits and its email job is lost, write an outbox row in the same statement as the booking and have a worker relay it. I measured that an extra write per booking cost throughput and left it out, but it is the right next step if a lost email is unacceptable.
- **Cancellations and refunds.** Not in scope. Cancelling would return tickets to any shard, and the notification pipeline already supports an extra event type.
- **Payments.** Bookings are confirmed immediately. A real flow would hold tickets for a few minutes while payment completes.
- **Search.** `GET /events` filters with a case insensitive `ILIKE`. A trigram index or a search engine would be needed for a large catalogue.
- **Horizontal scale.** The API is stateless, so more instances help, until Postgres CPU becomes the limit. I did not benchmark multiple instances.
- **Token revocation.** Stateless tokens cannot be revoked before they expire. A refresh token and a short access token would fix that.
- **Metrics.** Structured logs exist. Prometheus metrics and tracing would come next.

## Project layout

```
src/
  app.ts                  Fastify setup, error handling, load shedding
  server.ts               Process entry: migrations, workers, graceful shutdown
  config/env.ts           Validated environment variables
  db/                     Pool, migration runner, SQL migrations
  modules/                auth, events (with inventory), bookings, health
  plugins/auth.ts         JWT and role checks
  queue/                  BullMQ queues and job types
  workers/                Email workers and the fan-out worker
  emails/templates.ts     Email content
  lib/                    Mailer, password hashing, errors, batcher
tests/                    Integration tests
loadtest/                 k6 script and the seed, sweep and update benchmark tools
scripts/demo.mjs          Guided API walkthrough
docs/benchmarks/          Results and method
render.yaml, Dockerfile, docker-compose.yml
```
