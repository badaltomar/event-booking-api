import type { Email } from '../lib/mailer.js';

type Template = Omit<Email, 'to' | 'toName'>;

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const dateFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' });

export const formatDate = (value: Date | string) => `${dateFormat.format(new Date(value))} UTC`;
export const formatMoney = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export interface BookingConfirmationData {
  customerName: string;
  bookingId: string;
  quantity: number;
  totalCents: number;
  eventTitle: string;
  venue: string;
  startsAt: Date | string;
}

export function bookingConfirmation(data: BookingConfirmationData): Template {
  const when = formatDate(data.startsAt);
  const total = data.totalCents === 0 ? 'Free' : formatMoney(data.totalCents);
  return {
    subject: `Booking confirmed: ${data.eventTitle}`,
    text: [
      `Hi ${data.customerName},`,
      '',
      `Your booking for ${data.eventTitle} is confirmed.`,
      '',
      `Booking reference: ${data.bookingId}`,
      `Tickets: ${data.quantity}`,
      `Total: ${total}`,
      `When: ${when}`,
      `Where: ${data.venue}`,
    ].join('\n'),
    html: `
      <p>Hi ${escapeHtml(data.customerName)},</p>
      <p>Your booking for <strong>${escapeHtml(data.eventTitle)}</strong> is confirmed.</p>
      <table cellpadding="4">
        <tr><td>Booking reference</td><td>${escapeHtml(data.bookingId)}</td></tr>
        <tr><td>Tickets</td><td>${data.quantity}</td></tr>
        <tr><td>Total</td><td>${escapeHtml(total)}</td></tr>
        <tr><td>When</td><td>${escapeHtml(when)}</td></tr>
        <tr><td>Where</td><td>${escapeHtml(data.venue)}</td></tr>
      </table>`,
  };
}

export interface FieldChange {
  from: string | null;
  to: string | null;
}

export type EventChanges = Partial<Record<'title' | 'description' | 'venue' | 'startsAt' | 'endsAt', FieldChange>>;

const FIELD_LABELS: Record<keyof EventChanges, string> = {
  title: 'Title',
  description: 'Description',
  venue: 'Venue',
  startsAt: 'Start time',
  endsAt: 'End time',
};

const DATE_FIELDS = new Set<keyof EventChanges>(['startsAt', 'endsAt']);

function describeChange(field: keyof EventChanges, change: FieldChange): string {
  const label = FIELD_LABELS[field];
  if (field === 'description') return `${label} was updated`;
  const render = (value: string | null) =>
    value === null ? 'not set' : DATE_FIELDS.has(field) ? formatDate(value) : value;
  return `${label}: ${render(change.from)} changed to ${render(change.to)}`;
}

export interface EventUpdateData {
  customerName: string;
  eventTitle: string;
  changes: EventChanges;
}

export function eventUpdated(data: EventUpdateData): Template {
  const descriptions = (Object.entries(data.changes) as [keyof EventChanges, FieldChange][]).map(([field, change]) =>
    describeChange(field, change),
  );
  return {
    subject: `Event updated: ${data.eventTitle}`,
    text: [
      `Hi ${data.customerName},`,
      '',
      `${data.eventTitle} has been updated by the organizer. What changed:`,
      '',
      ...descriptions.map((d) => `- ${d}`),
      '',
      'Your booking is still valid.',
    ].join('\n'),
    html: `
      <p>Hi ${escapeHtml(data.customerName)},</p>
      <p><strong>${escapeHtml(data.eventTitle)}</strong> has been updated by the organizer. What changed:</p>
      <ul>${descriptions.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>
      <p>Your booking is still valid.</p>`,
  };
}
