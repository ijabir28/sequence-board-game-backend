// Development accounts: `npm run db:seed` (docker compose runs it on every backend start).
// Applies migrations first, and only creates accounts that don't exist yet, so it is safe to re-run.
// These passwords are below the sign-up minimum on purpose (they predate it and the docs use them),
// which is also why this script must never run against a production database.
const {pool, with_direct_pool} = require('./pool');
const {migrate} = require('./migrate');
const {hash_password} = require('../entity/user');

const DEVELOPMENT_USERS = [
    {handle: 'jabir', name: 'Jabir ibne kamal', password: '1'},
    {handle: 'sakib', name: 'Sakib ibne kamal', password: '123'},
];

async function seed() {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Refusing to create development accounts with NODE_ENV=production.');
    }
    await with_direct_pool(function (direct) {
        return migrate({pool: direct});
    });
    for (const user of DEVELOPMENT_USERS) {
        const {rowCount} = await pool.query(
            `INSERT INTO users (handle, name, password_hash) VALUES ($1, $2, $3)
             ON CONFLICT (handle) DO NOTHING`,
            [user.handle, user.name, await hash_password(user.password)]
        );
        console.log(rowCount === 1 ? `Created account ${user.handle}` : `Account ${user.handle} already exists`);
    }
}

seed()
    .catch(function (error) {
        console.error(error.message);
        process.exitCode = 1;
    })
    .finally(function () {
        return pool.end();
    });
