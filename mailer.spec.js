const {parse_address, brevo_request} = require('./mailer');

describe('parse_address', function () {
    test('splits a name and an address', function () {
        expect(parse_address('Sequence <no-reply@example.com>')).toEqual({name: 'Sequence', email: 'no-reply@example.com'});
        expect(parse_address('"Sequence Game" <a@example.com>')).toEqual({name: 'Sequence Game', email: 'a@example.com'});
    });

    test('takes a bare address as it is', function () {
        expect(parse_address(' a@example.com ')).toEqual({email: 'a@example.com'});
        expect(parse_address('<a@example.com>')).toEqual({email: 'a@example.com'});
    });
});

describe('brevo_request', function () {
    test("posts the email to Brevo's API with the key", function () {
        const mail = {from: 'Sequence <s@example.com>', to: 'p@example.com', subject: 'Hi', text: 'text', html: '<p>html</p>'};
        const [url, init] = brevo_request(mail, 'key-123');
        expect(url).toBe('https://api.brevo.com/v3/smtp/email');
        expect(init.method).toBe('POST');
        expect(init.headers['api-key']).toBe('key-123');
        expect(JSON.parse(init.body)).toEqual({
            sender: {name: 'Sequence', email: 's@example.com'},
            to: [{email: 'p@example.com'}],
            subject: 'Hi',
            textContent: 'text',
            htmlContent: '<p>html</p>',
        });
        expect(init.signal).toBeInstanceOf(AbortSignal);
    });
});
