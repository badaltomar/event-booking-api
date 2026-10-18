import http from 'k6/http';
import { sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL;
const EVENT_ID = __ENV.EVENT_ID;
const VUS = Number(__ENV.VUS);
const MODE = __ENV.MODE || 'sustained';
const DURATION = __ENV.DURATION || '20s';

const tokens = new SharedArray('tokens', () => JSON.parse(open('./tokens.json')).customers);

const created = new Counter('bookings_created');
const soldOut = new Counter('bookings_rejected_sold_out');
const dropped = new Counter('requests_dropped');
const serverErrors = new Counter('responses_5xx');
const shed = new Counter('responses_503_429');

const scenarios = {
  // Every user fires one booking at the same instant, like a ticket sale opening.
  spike: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '60s' },
  // Every user keeps booking back to back, which holds concurrency at a fixed level.
  sustained: { executor: 'constant-vus', vus: VUS, duration: DURATION },
};

export const options = {
  scenarios: { load: scenarios[MODE] },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: true,
};

export default function () {
  const token = tokens[(__VU - 1) % tokens.length];
  const res = http.post(`${BASE_URL}/events/${EVENT_ID}/bookings`, '{"quantity":1}', {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    timeout: '10s',
    tags: { name: 'POST /events/:id/bookings' },
  });

  if (res.status === 201) created.add(1);
  else if (res.status === 409) soldOut.add(1);
  else if (res.status === 503 || res.status === 429) {
    shed.add(1);
    // A well behaved client waits for the Retry-After the server asked for.
    sleep(1);
  }
  else if (res.status >= 500) serverErrors.add(1);
  else if (res.status === 0) dropped.add(1);
}

export function handleSummary(data) {
  const count = (name) => (data.metrics[name] ? data.metrics[name].values.count : 0);
  const trend = (p) => data.metrics.http_req_duration.values[p];
  const summary = {
    vus: VUS,
    mode: MODE,
    requests: count('http_reqs'),
    rps: data.metrics.http_reqs.values.rate,
    created: count('bookings_created'),
    soldOut: count('bookings_rejected_sold_out'),
    dropped: count('requests_dropped'),
    serverErrors: count('responses_5xx'),
    shed: count('responses_503_429'),
    p50: trend('med'),
    p95: trend('p(95)'),
    p99: trend('p(99)'),
    max: trend('max'),
  };
  return { [`/loadtest/results/last-run.json`]: JSON.stringify(summary) };
}
