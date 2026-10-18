#!/usr/bin/env node
// Walks through the main flows against any running instance, pausing between steps so each one can be explained.
//   npm run demo -- --url https://your-service.onrender.com --email you@gmail.com
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3000' },
    email: { type: 'string' },
    pause: { type: 'boolean', default: true },
  },
});

if (!values.email || !values.email.includes('@')) {
  console.error('Pass the inbox that should receive the emails: --email you@example.com');
  process.exit(1);
}

const base = values.url.replace(/\/$/, '');
const run = Date.now().toString(36);
const [local, domain] = values.email.split('@');
const prompt = createInterface({ input: process.stdin, output: process.stdout });

const bold = (text) => `\u001b[1m${text}\u001b[0m`;
const dim = (text) => `\u001b[2m${text}\u001b[0m`;

async function step(title) {
  console.log(`\n${bold(`> ${title}`)}`);
}

async function pause(message) {
  if (values.pause) await prompt.question(dim(`  ${message} (press Enter) `));
}

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  console.log(`  ${method} ${path} -> ${bold(res.status)}`);
  console.log(
    JSON.stringify(json, null, 2)
      .split('\n')
      .map((line) => `  ${dim(line)}`)
      .join('\n'),
  );
  return { status: res.status, json };
}

await step('Check the service is up');
await call('GET', '/health/ready');
await pause('Next: create an organizer and a customer');

await step('Register an organizer and a customer');
const organizer = await call('POST', '/auth/register', {
  body: { name: 'Olive Organizer', email: `${local}+organizer-${run}@${domain}`, password: 'password123', role: 'organizer' },
});
const customer = await call('POST', '/auth/register', {
  body: { name: 'Carl Customer', email: `${local}+customer-${run}@${domain}`, password: 'password123', role: 'customer' },
});
const organizerToken = organizer.json.token;
const customerToken = customer.json.token;
await pause('Next: show that roles are enforced');

await step('A customer cannot create an event (expect 403)');
await call('POST', '/events', {
  token: customerToken,
  body: { title: 'Sneaky event', venue: 'Nowhere', startsAt: '2030-01-01T10:00:00Z', capacity: 10 },
});

await step('The organizer creates an event');
const event = await call('POST', '/events', {
  token: organizerToken,
  body: {
    title: 'Node.js Meetup',
    description: 'Talks and pizza',
    venue: 'Hall A',
    startsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString(),
    capacity: 50,
    priceCents: 1500,
  },
});
const eventId = event.json.id;

await step('An organizer cannot book tickets (expect 403)');
await call('POST', `/events/${eventId}/bookings`, { token: organizerToken, body: { quantity: 1 } });
await pause('Next: the customer books tickets, which queues a confirmation email');

await step('The customer books 2 tickets');
await call('POST', `/events/${eventId}/bookings`, {
  token: customerToken,
  body: { quantity: 2 },
  headers: { 'idempotency-key': `demo-${run}` },
});

await step('Retrying with the same Idempotency-Key does not book twice (expect 200)');
await call('POST', `/events/${eventId}/bookings`, {
  token: customerToken,
  body: { quantity: 2 },
  headers: { 'idempotency-key': `demo-${run}` },
});

await step('Availability dropped by 2, not 4');
await call('GET', `/events/${eventId}`, { token: customerToken });
await pause(`Check the inbox of ${values.email} for the booking confirmation. Next: update the event`);

await step('The organizer changes the venue, which notifies everyone who booked');
await call('PATCH', `/events/${eventId}`, { token: organizerToken, body: { venue: 'Hall B, second floor' } });
await pause(`Check the inbox of ${values.email} for the update email`);

await step('The organizer sees the attendee list');
await call('GET', `/events/${eventId}/bookings`, { token: organizerToken });

prompt.close();
