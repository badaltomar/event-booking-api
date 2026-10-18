import { z } from 'zod';
import { pageInfo } from '../../lib/schemas.js';

export const MAX_TICKETS_PER_BOOKING = 10;

export const createBookingBody = z.object({
  quantity: z.number().int().min(1).max(MAX_TICKETS_PER_BOOKING),
});

export const bookingResponse = z.object({
  id: z.uuid(),
  eventId: z.uuid(),
  customerId: z.uuid(),
  quantity: z.number().int(),
  totalCents: z.number().int(),
  createdAt: z.string(),
});

export const bookingWithEventResponse = bookingResponse.extend({
  event: z.object({
    title: z.string(),
    venue: z.string(),
    startsAt: z.string(),
  }),
});

export const bookingListResponse = z.object({ data: z.array(bookingWithEventResponse), page: pageInfo });
