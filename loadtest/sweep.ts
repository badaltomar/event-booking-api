import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { connectDb, connectQueues, sleep, waitForDrain } from './lib.js';

const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'run' },
    mode: { type: 'string', default: 'sustained' },
    levels: { type: 'string', default: '50,100,200,400,800,1600' },
    duration: { type: 'string', default: '20s' },
    // Address of the API as seen from the k6 container.
    'base-url': { type: 'string', default: 'http://api:3000' },
    // Address of the same API as seen from this machine.
    'api-url': { type: 'string', default: 'http://localhost:3000' },
    network: { type: 'string', default: 'cactrotest_default' },
  },
});

const levels = values.levels!.split(',').map(Number);
const mode = values.mode as 'sustained' | 'spike';
const resultsDir = path.resolve('loadtest/results');
await mkdir(resultsDir, { recursive: true });

const db = connectDb();
const queues = connectQueues();
const apiUrl = values['api-url']!;
const { organizerToken } = JSON.parse(await readFile('loadtest/tokens.json', 'utf8')) as { organizerToken: string };
const MAX_CAPACITY = 1_000_000;

interface RunSummary {
  vus: number;
  requests: number;
  rps: number;
  created: number;
  soldOut: number;
  dropped: number;
  serverErrors: number;
  shed: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function runK6(vus: number, eventId: string, duration = values.duration!, runMode = mode): Promise<void> {
  const args = [
    'run', '--rm',
    '--mount', `type=bind,source=${path.resolve('loadtest')},target=/loadtest`,
    ...(values.network ? ['--network', values.network] : []),
    '-e', `BASE_URL=${values['base-url']}`,
    '-e', `EVENT_ID=${eventId}`,
    '-e', `VUS=${vus}`,
    '-e', `MODE=${runMode}`,
    '-e', `DURATION=${duration}`,
    'grafana/k6:latest', 'run', '--quiet', '/loadtest/booking.js',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'ignore', 'inherit'] });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`k6 exited with ${code}`))));
  });
}

async function waitUntilHealthy(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) return;
    } catch {
      /* still recovering */
    }
    await sleep(1_000);
  }
  throw new Error('API did not become healthy again');
}

async function createEvent(capacity: number): Promise<string> {
  const res = await fetch(`${apiUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${organizerToken}` },
    body: JSON.stringify({
      title: 'Load test event',
      venue: 'Arena',
      startsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      capacity,
      priceCents: 1000,
    }),
  });
  if (res.status !== 201) throw new Error(`Could not create the test event: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

async function fetchEvent(eventId: string): Promise<{ availableTickets: number }> {
  const res = await fetch(`${apiUrl}/events/${eventId}`, { headers: { authorization: `Bearer ${organizerToken}` } });
  return (await res.json()) as { availableTickets: number };
}

// A short throwaway run warms connection pools, JIT and the database cache so the first level is fair.
{
  await waitUntilHealthy();
  const warmupEvent = await createEvent(MAX_CAPACITY);
  process.stdout.write('warming up... ');
  await runK6(50, warmupEvent, '8s', 'sustained');
  console.log('done');
  await db.query('DELETE FROM bookings WHERE event_id = $1', [warmupEvent]);
  await db.query('DELETE FROM events WHERE id = $1', [warmupEvent]);
  await queues?.clear();
  await sleep(3_000);
}

const rows: Array<RunSummary & { consistent: boolean; drainSeconds: number | null }> = [];

for (const vus of levels) {
  await waitUntilHealthy();
  const capacity = mode === 'spike' ? Math.floor(vus / 2) : MAX_CAPACITY;
  const eventId = await createEvent(capacity);

  process.stdout.write(`running ${vus} users (${mode})... `);
  await runK6(vus, eventId);
  const summary = JSON.parse(await readFile(path.join(resultsDir, 'last-run.json'), 'utf8')) as RunSummary;

  const { availableTickets } = await fetchEvent(eventId);
  const { rows: check } = await db.query<{ booked: string }>(
    'SELECT COALESCE(SUM(quantity), 0) AS booked FROM bookings WHERE event_id = $1',
    [eventId],
  );
  const booked = Number(check[0]!.booked);
  // Tickets taken off the shelf must equal tickets recorded, and can never exceed capacity.
  // A client that timed out may still have been served, so k6 can see fewer bookings than exist.
  const consistent = capacity - availableTickets === booked && availableTickets >= 0 && booked >= summary.created;

  const drainSeconds = queues ? await waitForDrain(queues) : null;
  console.log(`done (${summary.rps.toFixed(0)} req/s, p95 ${summary.p95.toFixed(0)} ms)`);

  rows.push({ ...summary, vus, consistent, drainSeconds });
  await db.query('DELETE FROM bookings WHERE event_id = $1', [eventId]);
  await db.query('DELETE FROM events WHERE id = $1', [eventId]);
  await queues?.clear();
  await sleep(3_000);
}

const fmt = (n: number) => n.toFixed(0);
const table = [
  '| Users | Requests | Req/s | Booked | Sold out | Dropped | 5xx | Shed (429/503) | p50 ms | p95 ms | p99 ms | Data consistent | Email backlog cleared |',
  '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|---:|',
  ...rows.map(
    (r) =>
      `| ${r.vus} | ${r.requests} | ${fmt(r.rps)} | ${r.created} | ${r.soldOut} | ${r.dropped} | ${r.serverErrors} | ${r.shed} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${r.consistent ? 'yes' : 'NO'} | ${r.drainSeconds === null ? 'n/a' : `${r.drainSeconds.toFixed(1)} s`} |`,
  ),
].join('\n');

const failureRate = (r: RunSummary) => (r.dropped + r.serverErrors) / Math.max(r.requests, 1);
const slow = rows.find((r) => r.p95 > 1000);
const failing = rows.find((r) => failureRate(r) > 0.01);

await writeFile(path.join(resultsDir, `${values.label}-${mode}.md`), `${table}\n`);
await writeFile(path.join(resultsDir, `${values.label}-${mode}.json`), JSON.stringify(rows, null, 2));

console.log(`\n${table}\n`);
console.log(`p95 above 1s first at: ${slow ? `${slow.vus} users` : 'not reached'}`);
console.log(`more than 1% dropped or failed first at: ${failing ? `${failing.vus} users` : 'not reached'}`);

await queues?.close();
await db.end();
