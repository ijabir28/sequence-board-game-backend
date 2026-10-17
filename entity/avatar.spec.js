const {AVATAR_MAX_BYTES, check_avatar, avatar_url} = require('./avatar');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

describe('check_avatar', function () {
    test('reads the type from the bytes', function () {
        expect(check_avatar(PNG)).toEqual({content_type: 'image/png'});
        expect(check_avatar(JPEG)).toEqual({content_type: 'image/jpeg'});
        expect(check_avatar(WEBP)).toEqual({content_type: 'image/webp'});
    });

    test('refuses anything else, including SVG and HTML', function () {
        for (const data of [Buffer.from('<svg onload="alert(1)"/>'), Buffer.from('<html>'), Buffer.from('GIF89a......'), Buffer.alloc(0), 'text']) {
            expect(check_avatar(data).error).toBe('INVALID_IMAGE');
        }
    });

    test('refuses pictures over the size limit', function () {
        const big = Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]);
        expect(check_avatar(big).error).toBe('IMAGE_TOO_LARGE');
    });
});

test('avatar_url changes with every upload', function () {
    expect(avatar_url('7', new Date(1000))).toBe('/user/avatar/7?v=rs');
    expect(avatar_url('7', new Date(2000))).not.toBe(avatar_url('7', new Date(1000)));
});
