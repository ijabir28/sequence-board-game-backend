// Avatar uploads: which images are accepted. No I/O, so it is easy to test.

// Plenty for a 256×256 picture, which is what the frontend sends.
const AVATAR_MAX_BYTES = 256 * 1024;

// Each accepted type and the bytes its files start with. The type is read from the bytes, never trusted from the
// request, and SVG (which can carry scripts) is not accepted at all.
const SIGNATURES = [
    {content_type: 'image/png', matches: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a},
    {content_type: 'image/jpeg', matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff},
    {content_type: 'image/webp', matches: (b) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'},
];

const ACCEPTED_TYPES = SIGNATURES.map((signature) => signature.content_type);

/** {content_type} of an acceptable avatar, or {error: CODE, message}. */
function check_avatar(data) {
    if (!Buffer.isBuffer(data) || data.length === 0) {
        return {error: 'INVALID_IMAGE', message: 'Choose a PNG, JPEG or WebP picture.'};
    }
    if (data.length > AVATAR_MAX_BYTES) {
        return {error: 'IMAGE_TOO_LARGE', message: `Pictures can be at most ${AVATAR_MAX_BYTES / 1024} KB.`};
    }
    const signature = SIGNATURES.find((s) => s.matches(data));
    if (!signature) {
        return {error: 'INVALID_IMAGE', message: 'Choose a PNG, JPEG or WebP picture.'};
    }
    return {content_type: signature.content_type};
}

/** The URL users.image holds for a user's avatar. The version changes with every upload, so it can be cached forever. */
function avatar_url(user_id, updated_at) {
    return `/user/avatar/${user_id}?v=${updated_at.getTime().toString(36)}`;
}

module.exports = {AVATAR_MAX_BYTES, ACCEPTED_TYPES, check_avatar, avatar_url};
