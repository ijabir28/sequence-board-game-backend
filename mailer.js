// Sends account emails, the first way that is configured:
// - BREVO_API_KEY: Brevo's email API over HTTPS. Use this on hosts that block outgoing SMTP, such as Render's free
//   web services (ports 25, 465 and 587 time out there).
// - SMTP_URL: any SMTP server (nodemailer), e.g. `smtps://user:password@smtp.example.com:465`.
// - Neither: emails are printed to the log, which is enough for local development (copy the link from the terminal).
// docs/deploy.md#email has the free options. Under Jest emails go to `outbox`.
const nodemailer = require('nodemailer');
const {real_email} = require('./entity/user');

const DEFAULT_FROM = 'Sequence <no-reply@sequence.invalid>';
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
// A stuck mail service must not keep a request's background work around forever.
const SEND_TIMEOUT_MS = 15 * 1000;

// Emails "sent" while testing, newest last.
const outbox = [];

const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

if (!process.env.BREVO_API_KEY && !transport && process.env.NODE_ENV === 'production') {
    console.warn('Neither BREVO_API_KEY nor SMTP_URL is set: account emails (verification, password reset) are only ' +
        'written to this log.');
}

/** `Sequence <no-reply@example.com>` → {name: 'Sequence', email: 'no-reply@example.com'}; a bare address has no name. */
function parse_address(address) {
    const match = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(address);
    if (!match) return {email: address.trim()};
    const name = match[1].replace(/^"(.*)"$/, '$1');
    return name ? {name, email: match[2]} : {email: match[2]};
}

/** The fetch() arguments that send `mail` through Brevo's transactional email API. */
function brevo_request(mail, api_key) {
    return [BREVO_URL, {
        method: 'POST',
        headers: {'api-key': api_key, 'content-type': 'application/json', accept: 'application/json'},
        body: JSON.stringify({
            sender: parse_address(mail.from),
            to: [{email: mail.to}],
            subject: mail.subject,
            textContent: mail.text,
            htmlContent: mail.html,
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    }];
}

async function send_with_brevo(mail) {
    const response = await fetch(...brevo_request(mail, process.env.BREVO_API_KEY));
    if (!response.ok) {
        throw new Error(`Brevo answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
}

/** Sends {subject, text, html} to `to`. Never sends to the placeholder of an account without an email. */
async function send_mail({to, subject, text, html}) {
    if (real_email(to) === null) {
        return;
    }
    const mail = {from: process.env.MAIL_FROM || DEFAULT_FROM, to, subject, text, html};
    if (process.env.NODE_ENV === 'test') {
        outbox.push(mail);
        return;
    }
    if (process.env.BREVO_API_KEY) {
        await send_with_brevo(mail);
        return;
    }
    if (!transport) {
        console.log(`\n[mail] To ${to}: ${subject}\n${text}\n`);
        return;
    }
    await transport.sendMail(mail);
}

/**
 * Sends without making the request wait for the mail server, and without letting a failure reach the player: a
 * slow or failing send would otherwise reveal whether an address has an account.
 */
function send_in_background(mail) {
    send_mail(mail).catch(function (error) {
        console.error(`Could not email ${mail.to} (${mail.subject}):`, error.message);
    });
}

module.exports = {send_mail, send_in_background, outbox, parse_address, brevo_request};
