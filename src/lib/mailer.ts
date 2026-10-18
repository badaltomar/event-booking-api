import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../config/env.js';

export interface Email {
  to: string;
  toName?: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

class BrevoMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: { email: string; name: string },
  ) {}

  async send(email: Email): Promise<void> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: this.from,
        to: [{ email: email.to, name: email.toName }],
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`Brevo responded ${res.status}: ${await res.text()}`);
    }
  }
}

class NodemailerMailer implements Mailer {
  constructor(
    private readonly transport: Transporter,
    private readonly from: string,
  ) {}

  async send(email: Email): Promise<void> {
    await this.transport.sendMail({
      from: this.from,
      to: email.toName ? { name: email.toName, address: email.to } : email.to,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
  }
}

export function createMailer(env: Env): Mailer {
  const from = { email: env.MAIL_FROM_EMAIL, name: env.MAIL_FROM_NAME };
  const fromHeader = `"${from.name}" <${from.email}>`;
  switch (env.MAIL_DRIVER) {
    case 'brevo':
      return new BrevoMailer(env.BREVO_API_KEY!, from);
    case 'smtp':
      return new NodemailerMailer(
        nodemailer.createTransport({
          host: env.SMTP_HOST,
          port: env.SMTP_PORT,
          secure: env.SMTP_PORT === 465,
          auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
        }),
        fromHeader,
      );
    case 'json':
      // Builds the full message but delivers nothing. Used by tests and load runs.
      return new NodemailerMailer(nodemailer.createTransport({ jsonTransport: true }), fromHeader);
  }
}
