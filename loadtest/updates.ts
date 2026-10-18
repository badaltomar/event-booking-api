import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { connectDb, connectQueues, percentile, sleep, waitForDrain } from './lib.js';

const { values } = parseArgs({
  options: {
    label: { type: 'string', default: 'run' },
    bookers: { type: 'string', default: '100,1000,5000,20000' },
    concurrent: { type: 'string', default: '1' },
    'api-url': { type: 'string', default: 'http://localhost:3000' },
  },
});

const tokens = JSON.parse(await readFile('loadtest/tokens.json', 'utf8')) as {
  organizerId: string;
  organizerToken: string;
  customerIds: string[];
};

const db = connectDb();
const queues = connectQueues();
const bookerCounts = values.bookers!.split(',').map(Number);
const concurrency = Number(values.concurrent);

async function createEventWithBookers(bookers: number): Promise<string> {
  if (bookers > tokens.customerIds.length) {
    throw new Error(`Seed at least ${bookers} customers first (npm run loadtest:seed -- --customers ${bookers})`);
  }
  const res = await fetch(`${values['api-url']}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.organizerToken}` },
    body: JSON.stringify({
      title: 'Update test event',
      venue: 'Original venue',
      startsAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      capacity: bookers + 10,
      priceCents: 1000,
    }),
  });
  if (res.status !== 201) throw new Error(`Could not create the test event: ${res.status} ${await res.text()}`);
  const eventId = ((await res.json()) as { id: string }).id;
  // Bookings are written directly: the test is about the notification fan-out, not about booking speed.
  await db.query(
    `INSERT INTO bookings (event_id, customer_id, quantity, total_cents)
     SELECT $1, unnest($2::uuid[]), 1, 1000`,
    [eventId, tokens.customerIds.slice(0, bookers)],
  );
  return eventId;
}

async function patchVenue(eventId: string): Promise<{ ms: number; status: number }> {
  const started = performance.now();
  try {
    const res = await fetch(`${values['api-url']}/events/${eventId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.organizerToken}` },
      body: JSON.stringify({ venue: `Venue ${Date.now()}` }),
      signal: AbortSignal.timeout(120_000),
    });
    await res.arrayBuffer();
    return { ms: performance.now() - started, status: res.status };
  } catch {
    return { ms: performance.now() - started, status: 0 };
  }
}

const rows: string[] = [];
const header = [
  '| Customers per event | Events updated at once | Update API p50 ms | Update API max ms | Failed updates | Notifications delivered after |',
  '|---:|---:|---:|---:|---:|---:|',
];

for (const bookers of bookerCounts) {
  const eventIds = await Promise.all(Array.from({ length: concurrency }, () => createEventWithBookers(bookers)));
  await queues?.clear();

  const results = await Promise.all(eventIds.map(patchVenue));
  const drain = queues ? await waitForDrain(queues, 300_000) : null;

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const failed = results.filter((r) => r.status !== 200).length;
  rows.push(
    `| ${bookers} | ${concurrency} | ${percentile(latencies, 50).toFixed(0)} | ${latencies.at(-1)!.toFixed(0)} | ${failed} | ${
      drain === null ? 'n/a' : `${drain.toFixed(1)} s`
    } |`,
  );
  console.log(rows.at(-1));

  for (const id of eventIds) {
    await db.query('DELETE FROM bookings WHERE event_id = $1', [id]);
    await db.query('DELETE FROM events WHERE id = $1', [id]);
  }
  await queues?.clear();
  await sleep(2_000);
}

const table = [...header, ...rows].join('\n');
const resultsDir = path.resolve('loadtest/results');
await mkdir(resultsDir, { recursive: true });
await writeFile(path.join(resultsDir, `${values.label}-updates-x${concurrency}.md`), `${table}\n`);
console.log(`\n${table}`);

await queues?.close();
await db.end();
