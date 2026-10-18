import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  bearer,
  createEvent,
  createTestContext,
  registerUser,
  waitFor,
  type TestContext,
} from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.reset();
});

describe('authentication', () => {
  it('registers, logs in and returns the profile', async () => {
    const { app } = ctx;
    const register = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { name: 'Ada', email: 'Ada@Example.com', password: 'password123', role: 'customer' },
    });
    expect(register.statusCode).toBe(201);
    expect(register.json().user.email).toBe('ada@example.com');

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ada@example.com', password: 'password123' },
    });
    expect(login.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(login.json().token) });
    expect(me.json()).toMatchObject({ name: 'Ada', role: 'customer' });
  });

  it('rejects duplicate emails and wrong passwords', async () => {
    const { app } = ctx;
    const payload = { name: 'Ada', email: 'ada@example.com', password: 'password123', role: 'customer' };
    await app.inject({ method: 'POST', url: '/auth/register', payload });

    const duplicate = await app.inject({ method: 'POST', url: '/auth/register', payload });
    expect(duplicate.statusCode).toBe(409);

    const wrong = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ada@example.com', password: 'not-the-password' },
    });
    expect(wrong.statusCode).toBe(401);
  });
});

describe('role based access', () => {
  it('blocks requests without a token', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/events' });
    expect(res.statusCode).toBe(401);
  });

  it('lets only organizers create events', async () => {
    const customer = await registerUser(ctx.app, 'customer');
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/events',
      headers: bearer(customer.token),
      payload: { title: 'Nope', venue: 'Nowhere', startsAt: '2099-01-01T00:00:00Z', capacity: 10 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets only customers book tickets', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const event = await createEvent(ctx.app, organizer.token);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/bookings`,
      headers: bearer(organizer.token),
      payload: { quantity: 1 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('stops an organizer from editing someone else\'s event', async () => {
    const owner = await registerUser(ctx.app, 'organizer');
    const other = await registerUser(ctx.app, 'organizer');
    const event = await createEvent(ctx.app, owner.token);
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/events/${event.id}`,
      headers: bearer(other.token),
      payload: { title: 'Hijacked' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('keeps bookings private to the customer who made them', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const alice = await registerUser(ctx.app, 'customer');
    const bob = await registerUser(ctx.app, 'customer');
    const event = await createEvent(ctx.app, organizer.token);
    const booking = await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/bookings`,
      headers: bearer(alice.token),
      payload: { quantity: 1 },
    });
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/bookings/${booking.json().id}`,
      headers: bearer(bob.token),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('booking tickets', () => {
  it('never sells more tickets than the capacity under concurrent demand', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const event = await createEvent(ctx.app, organizer.token, { capacity: 5 });
    const customers = await Promise.all(Array.from({ length: 20 }, () => registerUser(ctx.app, 'customer')));

    const responses = await Promise.all(
      customers.map((c) =>
        ctx.app.inject({
          method: 'POST',
          url: `/events/${event.id}/bookings`,
          headers: bearer(c.token),
          payload: { quantity: 1 },
        }),
      ),
    );

    const statuses = responses.map((r) => r.statusCode);
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 409)).toHaveLength(15);

    const { rows } = await ctx.db.query(
      'SELECT (SELECT SUM(remaining) FROM event_inventory) AS remaining, (SELECT count(*) FROM bookings) AS booked',
    );
    expect(rows[0]).toMatchObject({ remaining: '0', booked: '5' });
  });

  it('keeps selling correctly when tickets are spread over several inventory shards', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const event = await createEvent(ctx.app, organizer.token, { capacity: 1000 });
    const customers = await Promise.all(Array.from({ length: 120 }, () => registerUser(ctx.app, 'customer')));

    const responses = await Promise.all(
      customers.map((c) =>
        ctx.app.inject({
          method: 'POST',
          url: `/events/${event.id}/bookings`,
          headers: bearer(c.token),
          payload: { quantity: 10 },
        }),
      ),
    );

    const booked = responses.filter((r) => r.statusCode === 201).length;
    expect(booked).toBe(100);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(20);

    const shown = await ctx.app.inject({ method: 'GET', url: `/events/${event.id}`, headers: bearer(organizer.token) });
    expect(shown.json().availableTickets).toBe(0);
  });

  it('combines tickets from several shards when no single shard can cover the order', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const customer = await registerUser(ctx.app, 'customer');
    const event = await createEvent(ctx.app, organizer.token, { capacity: 200 });
    await ctx.db.query('UPDATE event_inventory SET remaining = 3 WHERE event_id = $1', [event.id]);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/bookings`,
      headers: bearer(customer.token),
      payload: { quantity: 5 },
    });
    expect(res.statusCode).toBe(201);

    const { rows } = await ctx.db.query('SELECT SUM(remaining) AS remaining FROM event_inventory WHERE event_id = $1', [event.id]);
    expect(rows[0].remaining).toBe('1');
  });

  it('returns the original booking when a request is retried with the same idempotency key', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const customer = await registerUser(ctx.app, 'customer');
    const event = await createEvent(ctx.app, organizer.token, { capacity: 10 });
    const request = {
      method: 'POST' as const,
      url: `/events/${event.id}/bookings`,
      headers: { ...bearer(customer.token), 'idempotency-key': 'retry-safe-0001' },
      payload: { quantity: 2 },
    };

    const first = await ctx.app.inject(request);
    const retry = await ctx.app.inject(request);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().id).toBe(first.json().id);

    const shown = await ctx.app.inject({ method: 'GET', url: `/events/${event.id}`, headers: bearer(organizer.token) });
    expect(shown.json().availableTickets).toBe(8);
  });

  it('rejects a booking larger than the remaining tickets', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const customer = await registerUser(ctx.app, 'customer');
    const event = await createEvent(ctx.app, organizer.token, { capacity: 3 });
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/bookings`,
      headers: bearer(customer.token),
      payload: { quantity: 4 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('INSUFFICIENT_TICKETS');
  });

  it('emails a confirmation in the background', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const customer = await registerUser(ctx.app, 'customer', 'Grace Hopper');
    const event = await createEvent(ctx.app, organizer.token, { title: 'Compiler Night' });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/bookings`,
      headers: bearer(customer.token),
      payload: { quantity: 2 },
    });
    expect(res.statusCode).toBe(201);

    await waitFor(() => ctx.mailer.sent.length === 1);
    const [email] = ctx.mailer.sent;
    expect(email).toMatchObject({ to: customer.email, subject: 'Booking confirmed: Compiler Night' });
    expect(email!.text).toContain('Tickets: 2');
    expect(email!.text).toContain('Total: $50.00');
  });
});

describe('event updates', () => {
  it('notifies every customer who booked, and nobody else', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const alice = await registerUser(ctx.app, 'customer');
    const bob = await registerUser(ctx.app, 'customer');
    const bystander = await registerUser(ctx.app, 'customer');
    const event = await createEvent(ctx.app, organizer.token, { title: 'Jazz Night', venue: 'Blue Room' });

    for (const customer of [alice, bob, alice]) {
      await ctx.app.inject({
        method: 'POST',
        url: `/events/${event.id}/bookings`,
        headers: bearer(customer.token),
        payload: { quantity: 1 },
      });
    }
    await waitFor(() => ctx.mailer.sent.length === 3);
    ctx.mailer.sent.length = 0;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/events/${event.id}`,
      headers: bearer(organizer.token),
      payload: { venue: 'Grand Hall' },
    });
    expect(res.statusCode).toBe(200);

    await waitFor(() => ctx.mailer.sent.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const recipients = ctx.mailer.sent.map((e) => e.to).sort();
    expect(recipients).toEqual([alice.email, bob.email].sort());
    expect(recipients).not.toContain(bystander.email);
    expect(ctx.mailer.sent[0]!.text).toContain('Venue: Blue Room changed to Grand Hall');
  });

  it('does not notify when only the capacity changes', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const customer = await registerUser(ctx.app, 'customer');
    const event = await createEvent(ctx.app, organizer.token, { capacity: 10 });
    await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/bookings`,
      headers: bearer(customer.token),
      payload: { quantity: 2 },
    });
    await waitFor(() => ctx.mailer.sent.length === 1);
    ctx.mailer.sent.length = 0;

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/events/${event.id}`,
      headers: bearer(organizer.token),
      payload: { capacity: 20 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ capacity: 20, availableTickets: 18 });

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ctx.mailer.sent).toHaveLength(0);
  });

  it('refuses to shrink capacity below the tickets already sold', async () => {
    const organizer = await registerUser(ctx.app, 'organizer');
    const customer = await registerUser(ctx.app, 'customer');
    const event = await createEvent(ctx.app, organizer.token, { capacity: 10 });
    await ctx.app.inject({
      method: 'POST',
      url: `/events/${event.id}/bookings`,
      headers: bearer(customer.token),
      payload: { quantity: 6 },
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/events/${event.id}`,
      headers: bearer(organizer.token),
      payload: { capacity: 5 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CAPACITY_BELOW_BOOKED');
  });
});
