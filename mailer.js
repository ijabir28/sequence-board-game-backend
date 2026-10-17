// Sends account emails over SMTP (nodemailer), set by SMTP_URL, e.g. `smtps://user:password@smtp.example.com:465`.
// Any SMTP service works; docs/deploy.md lists free ones. Without SMTP_URL, emails are printed to the log instead,
// which is enough for local development (copy the link from the terminal). Under Jest they go to `outbox`.
const nodemailer = require('nodemailer');
const {real_email} = require('./entity/user');

const DEFAULT_FROM = 'Sequence <no-reply@sequence.invalid>';

// Emails "sent" while testing, newest last.
const outbox = [];

const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

if (!transport && process.env.NODE_ENV === 'production') {
    console.warn('SMTP_URL is not set: account emails (verification, password reset) are only written to this log.');
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

module.exports = {send_mail, send_in_background, outbox};
