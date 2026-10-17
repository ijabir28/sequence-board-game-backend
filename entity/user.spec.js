const {normalize_handle, validate_name, hash_password, verify_password} = require('./user');

describe('normalize_handle', function () {
    test('trims and lower-cases, so handles are case-insensitive', function () {
        expect(normalize_handle('  Jabir_01 ')).toBe('jabir_01');
        expect(normalize_handle(undefined)).toBe('');
    });
});

describe('validate_name', function () {
    test('trims a display name of at most 10 characters', function () {
        expect(validate_name('  Jabir  ')).toEqual({name: 'Jabir'});
        expect(validate_name(' ' + 'x'.repeat(10) + ' ')).toEqual({name: 'x'.repeat(10)});
    });

    test('explains what is wrong with an empty, long or missing name', function () {
        for (const name of ['   ', 'x'.repeat(11), 42, undefined]) {
            expect(validate_name(name).error).toMatch(/up to 10 characters/);
        }
    });
});

describe('password hashing', function () {
    test('verifies the right password and rejects others', async function () {
        const hash = await hash_password('correct horse');
        expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
        expect(hash).not.toContain('correct horse');
        expect(await verify_password('correct horse', hash)).toBe(true);
        expect(await verify_password('Correct horse', hash)).toBe(false);
        expect(await verify_password(undefined, hash)).toBe(false);
    });

    test('salts every hash', async function () {
        expect(await hash_password('same')).not.toBe(await hash_password('same'));
    });

    test('checks old hashes with the cost they were made with', async function () {
        const cheap = await hash_password('pw', {N: 1024, r: 8, p: 1});
        expect(await verify_password('pw', cheap)).toBe(true);
    });

    test('rejects malformed stored hashes', async function () {
        expect(await verify_password('pw', 'plain-text')).toBe(false);
        expect(await verify_password('pw', null)).toBe(false);
    });
});
