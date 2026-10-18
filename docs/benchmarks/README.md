# Benchmarks

How many people can book at the same time, where the first version breaks, and what changed.

## Setup

| | |
|---|---|
| Machine | Laptop, Intel i5-1235U (low power), Windows 11, Docker Desktop |
| API | One container capped at **1 CPU and 512 MB**, workers running inside it (`PROCESS_ROLE=all`) |
| Database | PostgreSQL 17 in Docker. Redis 7 in Docker |
| Load generator | [k6](https://k6.io) in Docker, on the same machine |
| Email | The `json` driver builds each email but delivers nothing, so the load runs never touch a real mailbox |
| Versions | `v1-baseline` is the first working implementation. `main` is the optimized one |

Two scenarios:

- **Sustained**: N users each book one ticket, wait for the answer, and immediately book again, for 15 seconds. This holds concurrency at N and shows where latency and errors start.
- **Spike**: N users all send one booking at the same instant, for an event with N / 2 tickets. This is a ticket sale opening. Half of the users must be told "sold out".

A request counts as **dropped** when it gets no answer within 10 seconds. After every run the script checks that tickets taken off the shelf equal bookings stored. Every row below says `yes`, so no run ever oversold.

## Read this before the numbers

This is a thermally limited laptop running the load generator, the API, Postgres and Redis together, so the same test can vary a lot from run to run. For the side-by-side runs I alternated the two versions twice (`v1, v2, v1, v2`) so both saw similar conditions, and the raw output is in [side-by-side-runs.txt](side-by-side-runs.txt). The summary uses the range across all runs. Treat the ratios as the result, not the absolute numbers.

## Result 1: bookings per second and latency (sustained)

Same 1 CPU container, same machine. Each cell is the **best run** out of four to six runs per version, which is the run least disturbed by the laptop slowing down.

| Concurrent users | v1 requests/s | v1 p95 latency | v2 requests/s | v2 p95 latency |
|---:|---:|---:|---:|---:|
| 200 | 472 | 0.5 s | 1,217 | 0.24 s |
| 400 | 432 | 1.0 s | 1,149 | 0.45 s |
| 800 | 401 | 2.2 s | 1,192 | 0.71 s |
| 1,600 | 375 | 4.5 s | 1,206 | 1.7 s |
| 3,200 | 406 | 8.1 s | 1,109 | 7.9 s |

What it says:

- **v1 tops out at about 430 bookings per second** and cannot do more however many users arrive. Past 400 users every extra user only adds waiting time: p95 is 1 s at 400 users and 4.5 s at 1,600.
- **v2 reaches about 1,100 to 1,200 bookings per second** on the same CPU, roughly **2.5 to 3 times more**.
- v2 keeps p95 under 1 s up to 800 users. v1 is at 1 s from 400 users.
- At 3,200 users both versions are saturated and start dropping some requests, but v2 finishes about three times as many bookings in the same time.
- The worst runs are much lower for both versions when the laptop throttles: v1 fell to about 140 requests/s and v2 to about 400 to 500. At 3,200 users v2 was ahead in both back to back pairs, about 1,000 to 1,100 requests/s against 260 to 410.

## Result 2: everyone at the same instant (spike, N users, N / 2 tickets)

Here the load generator and the API share one laptop, and this scenario is the noisiest one, so read it as a rough picture.

| Users at the same instant | v1 dropped | v2 dropped |
|---:|---:|---:|
| 3,000 | 0 | 0 |
| 5,000 | 0 to 2,422 | 0 to 96 |
| 8,000 | 5,381 to 7,068 | 1,634 to 5,413 |

- Up to 5,000 users neither version loses many requests, but both are slow. p95 is 3.8 to 4.1 s at 3,000 users and 6.6 to 7.1 s at 5,000 users for both.
- At 8,000 users both lose requests that get no answer in 10 seconds. The optimized version loses fewer, in most runs about half as many, because it finishes bookings faster.
- No run ever oversold a ticket.

In v2 the server also refuses work it cannot finish soon: past 2,000 requests in flight it answers `503` with `Retry-After: 1` straight away. A fast "try again" is better for the user than a request that hangs for ten seconds and then dies.

## Result 3: updating an event that many customers booked

The organizer sends one `PATCH` that changes the venue. The time is how long that API call takes to answer.

| Customers who booked | v1 | v2 |
|---:|---:|---:|
| 100 | 183 ms | 28 ms |
| 1,000 | 619 ms | 14 ms |
| 5,000 | 3.0 s | 13 ms |
| 20,000 | **14.7 s** | **21 ms** |
| 20 events updated at once, 500 customers each | 1.2 s | 39 ms |

v1 queued one email job per customer inside the request, so the call took as long as the customer list. v2 queues one job and a worker expands it into one email job per customer, a page at a time. The emails still take time to go out (22 s for 20,000 customers), but the organizer's call no longer waits for them.

## Second machine (the run shown in the demo video)

The same tests on a different laptop, with the same 1 CPU container limit. Every row's data check said `yes`.

Sustained, 15 seconds per level:

| Concurrent users | v1 requests/s | v1 p95 | v2 requests/s | v2 p95 |
|---:|---:|---:|---:|---:|
| 200 | 465 | 0.60 s | 1,302 | 0.25 s |
| 800 | 513 | 1.7 s | 1,431 | 0.64 s |
| 3,200 | 460 | 6.9 s | 1,473 | 4.0 s |

At 3,200 users v1 dropped nothing but answered very slowly. v2 dropped 407 requests and answered 7,125 with a quick `503` retry message, while still finishing about 16,600 bookings against about 9,600 for v1.

Everyone at the same instant, with half as many tickets as users:

| Users | v1 dropped | v2 dropped |
|---:|---:|---:|
| 3,000 | 0 | 0 |
| 5,000 | 0 | 96 |
| 8,000 | 5,381 | 2,645 |

Taken together with the first machine, the optimized version handles about 2.5 to 3 times more bookings per second, with the same shape of result on both laptops.

## What changed, and why it helped

| Change | Problem it fixed |
|---|---|
| Tickets are stored as up to 16 counter rows per event instead of one | With one row, every buyer waited in line for the same database row lock. Measured directly in Postgres, one hot row topped out near 1,500 bookings per second, while spreading the counter reached 3,000 to 4,000 |
| Booking is one SQL statement (take tickets and record the booking together) | v1 used a five statement transaction that held the lock across every network round trip |
| Authentication trusts the signed token instead of reading the user from the database on every request | Removed one query from every request |
| Email jobs are queued in groups of up to 500 every 20 ms | Fewer round trips to Redis per booking. API only throughput rose from about 960 to about 1,260 requests per second in a controlled test |
| Event updates use a fan-out job | The update request no longer scales with the number of customers |
| Indexes on the columns the read endpoints and the fan-out filter by | The fan-out and "my bookings" no longer scan the whole bookings table |
| Connection and statement timeouts, plus a cap on requests in flight | A saturated service answers quickly with a 503 instead of letting requests pile up until they time out |

## What the next limit is

On this setup the API container sits at 100 percent of its one CPU while Postgres uses three cores, so a single instance is CPU bound at around 1,100 to 1,200 bookings per second. The API is stateless, so the next step is running more instances behind a load balancer, then watching Postgres CPU. I did not benchmark multiple instances.

## Reproduce it

```bash
docker compose up -d postgres redis
npm run loadtest:seed -- --customers 20000

# optimized version (main)
docker compose --profile app up -d --build api
npm run loadtest:sweep -- --label v2 --mode sustained --levels 200,400,800,1600,3200
npm run loadtest:sweep -- --label v2 --mode spike --levels 1000,3000,5000
npm run loadtest:updates -- --label v2 --bookers 100,1000,5000,20000

# first version (branch baseline has the same load test tools)
git switch baseline
docker compose down -v && docker compose up -d postgres redis
DB_POOL_MAX=10 docker compose --profile app up -d --build api
npm run loadtest:seed -- --customers 20000
npm run loadtest:sweep -- --label v1 --mode sustained --levels 200,400,800,1600,3200
```

Tables are written to `loadtest/results/`.
