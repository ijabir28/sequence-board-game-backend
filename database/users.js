const {pool} = require('./pool');

// Better Auth (auth.js) creates and changes accounts; the game only reads them.
const PUBLIC_COLUMNS = 'id, handle, name, email, email_verified, image, created_at';

async function get_user({handle}) {
    if (typeof handle !== 'string') {
        return undefined;
    }
    const {rows} = await pool.query(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE handle = $1`, [handle]);
    return rows[0];
}

module.exports = {get_user};
