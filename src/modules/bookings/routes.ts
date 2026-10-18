import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { errors, idParams, paginationQuery } from '../../lib/schemas.js';
import { bookingListResponse, bookingResponse, bookingWithEventResponse, createBookingBody } from './schemas.js';
import type { BookingService } from './service.js';

export function bookingRoutes(service: BookingService) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const security = [{ bearerAuth: [] }];
    const customerOnly = [app.authenticate, app.requireRole('customer')];

    r.post(
      '/events/:id/bookings',
      {
        schema: {
          tags: ['Bookings'],
          summary: 'Book tickets for an event (customers only)',
          security,
          params: idParams,
          body: createBookingBody,
          response: { 201: bookingResponse, ...errors(400, 401, 403, 404, 409) },
        },
        onRequest: customerOnly,
      },
      async (request, reply) => {
        const booking = await service.create(request.params.id, request.user.sub, request.body.quantity);
        return reply.status(201).send(booking);
      },
    );

    r.get(
      '/bookings',
      {
        schema: {
          tags: ['Bookings'],
          summary: 'List your bookings',
          security,
          querystring: paginationQuery,
          response: { 200: bookingListResponse, ...errors(400, 401, 403) },
        },
        onRequest: customerOnly,
      },
      async (request) => service.listForCustomer(request.user.sub, request.query),
    );

    r.get(
      '/bookings/:id',
      {
        schema: {
          tags: ['Bookings'],
          summary: 'Get one of your bookings',
          security,
          params: idParams,
          response: { 200: bookingWithEventResponse, ...errors(400, 401, 403, 404) },
        },
        onRequest: customerOnly,
      },
      async (request) => service.getForCustomer(request.params.id, request.user.sub),
    );
  };
}
