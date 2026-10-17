const emails = require('./emails');

describe('account emails', function () {
    test('carry the link as text and as a button, and say how long it works', function () {
        const mail = emails.verify_email({name: 'Jabir', url: 'https://example.test/v?token=a&b=c', hours: 24});
        expect(mail.subject).toBe('Confirm your email for Sequence');
        expect(mail.text).toContain('Hi Jabir,');
        expect(mail.text).toContain('Confirm email: https://example.test/v?token=a&b=c');
        expect(mail.text).toContain('24 hours');
        expect(mail.html).toContain('href="https://example.test/v?token=a&amp;b=c"');
    });

    test('escape what players typed, so a display name cannot inject HTML', function () {
        const mail = emails.password_changed({name: '<img src=x onerror=alert(1)>'});
        expect(mail.html).not.toContain('<img');
        expect(mail.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });

    test('tell the owner which handle already has their email', function () {
        const mail = emails.existing_account({name: 'Jabir', handle: 'jabir', sign_in_url: 'https://example.test/signin'});
        expect(mail.text).toContain('"jabir"');
        expect(mail.text).toContain('Sign in: https://example.test/signin');
    });

    test('give the reset link a lifetime in minutes', function () {
        expect(emails.reset_password({name: 'J', url: 'https://example.test/r', minutes: 60}).text).toContain('60 minutes');
    });
});
