import { z } from 'zod';
import { pageInfo, paginationQuery } from '../../lib/schemas.js';

const isoDate = z.iso.datetime({ offset: true });
const inFuture = (value: string) => new Date(value).getTime() > Date.now();

const title = z.string().trim().min(3).max(120);
const description = z.string().trim().max(5000);
const venue = z.string().trim().min(2).max(200);
const capacity = z.number().int().min(1).max(1_000_000);

export const createEventBody = z
  .object({
    title,
    description: description.default(''),
    venue,
    startsAt: isoDate.refine(inFuture, 'startsAt must be in the future'),
    endsAt: isoDate.optional(),
    capacity,
    priceCents: z.number().int().min(0).max(10_000_000).default(0),
  })
  .refine((v) => !v.endsAt || new Date(v.endsAt) > new Date(v.startsAt), {
    path: ['endsAt'],
    message: 'endsAt must be after startsAt',
  });
export type CreateEventInput = z.infer<typeof createEventBody>;

export const updateEventBody = z
  .object({
    title: title.optional(),
    description: description.optional(),
    venue: venue.optional(),
    startsAt: isoDate.refine(inFuture, 'startsAt must be in the future').optional(),
    endsAt: isoDate.nullable().optional(),
    capacity: capacity.optional(),
  })
  .refine((v) => Object.values(v).some((field) => field !== undefined), {
    message: 'Provide at least one field to update',
  });
export type UpdateEventInput = z.infer<typeof updateEventBody>;

export const listEventsQuery = paginationQuery.extend({
  q: z.string().trim().min(1).max(100).optional(),
  from: isoDate.optional(),
});
export type ListEventsQuery = z.infer<typeof listEventsQuery>;

export const eventResponse = z.object({
  id: z.uuid(),
  organizerId: z.uuid(),
  title: z.string(),
  description: z.string(),
  venue: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  capacity: z.number().int(),
  availableTickets: z.number().int(),
  priceCents: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const eventListResponse = z.object({ data: z.array(eventResponse), page: pageInfo });

export const attendeeResponse = z.object({
  bookingId: z.uuid(),
  customerId: z.uuid(),
  customerName: z.string(),
  customerEmail: z.string(),
  quantity: z.number().int(),
  totalCents: z.number().int(),
  bookedAt: z.string(),
});

export const attendeeListResponse = z.object({ data: z.array(attendeeResponse), page: pageInfo });
