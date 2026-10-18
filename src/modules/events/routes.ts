import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { errors, idParams, paginationQuery } from '../../lib/schemas.js';
import {
  attendeeListResponse,
  createEventBody,
  eventListResponse,
  eventResponse,
  listEventsQuery,
  updateEventBody,
} from './schemas.js';
import type { EventService } from './service.js';

export function eventRoutes(service: EventService) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const security = [{ bearerAuth: [] }];
    const organizerOnly = [app.authenticate, app.requireRole('organizer')];

    r.get(
      '/events',
      {
        schema: {
          tags: ['Events'],
          summary: 'Browse upcoming events',
          security,
          querystring: listEventsQuery,
          response: { 200: eventListResponse, ...errors(400, 401) },
        },
        onRequest: [app.authenticate],
      },
      async (request) => service.list(request.query),
    );

    r.get(
      '/events/mine',
      {
        schema: {
          tags: ['Events'],
          summary: 'List events created by the authenticated organizer',
          security,
          querystring: paginationQuery,
          response: { 200: eventListResponse, ...errors(400, 401, 403) },
        },
        onRequest: organizerOnly,
      },
      async (request) => service.listByOrganizer(request.user.sub, request.query),
    );

    r.get(
      '/events/:id',
      {
        schema: {
          tags: ['Events'],
          summary: 'Get one event',
          security,
          params: idParams,
          response: { 200: eventResponse, ...errors(400, 401, 404) },
        },
        onRequest: [app.authenticate],
      },
      async (request) => service.getById(request.params.id),
    );

    r.post(
      '/events',
      {
        schema: {
          tags: ['Events'],
          summary: 'Create an event (organizers only)',
          security,
          body: createEventBody,
          response: { 201: eventResponse, ...errors(400, 401, 403) },
        },
        onRequest: organizerOnly,
      },
      async (request, reply) => reply.status(201).send(await service.create(request.user.sub, request.body)),
    );

    r.patch(
      '/events/:id',
      {
        schema: {
          tags: ['Events'],
          summary: 'Update your event and notify customers who booked it',
          security,
          params: idParams,
          body: updateEventBody,
          response: { 200: eventResponse, ...errors(400, 401, 403, 404, 409) },
        },
        onRequest: organizerOnly,
      },
      async (request) => service.update(request.params.id, request.user.sub, request.body),
    );

    r.get(
      '/events/:id/bookings',
      {
        schema: {
          tags: ['Events'],
          summary: 'List attendees of your event',
          security,
          params: idParams,
          querystring: paginationQuery,
          response: { 200: attendeeListResponse, ...errors(400, 401, 403, 404) },
        },
        onRequest: organizerOnly,
      },
      async (request) => service.listAttendees(request.params.id, request.user.sub, request.query),
    );
  };
}
