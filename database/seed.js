// Development accounts: `npm run db:seed` (docker compose runs it on every backend start).
// Applies migrations first, and only creates accounts that don't exist yet, so it is safe to re-run.
// These passwords are below the sign-up minimum on purpose (they predate it and the docs use them),
// which is also why this script must never run against a production database.
const {pool, transaction, with_direct_pool} = require('./pool');
const {migrate} = require('./migrate');
const {hash_password} = require('../entity/user');

// Their emails are verified already, on the `.test` domain, which is reserved for testing (RFC 2606).
const DEVELOPMENT_USERS = [
    {handle: 'jabir', name: 'Jabir ibne kamal', email: 'jabir@sequence.test', password: '1'},
    {handle: 'sakib', name: 'Sakib ibne kamal', email: 'sakib@sequence.test', password: '123'},
];

async function seed() {
    if (process.env.NODE_ENV === 'production') {
        throw new Error('Refusing to create development accounts with NODE_ENV=production.');
    }
    await with_direct_pool(function (direct) {
        return migrate({pool: direct});
    });
    for (const user of DEVELOPMENT_USERS) {
        // Written directly rather than through Better Auth, whose sign-up would refuse these short passwords.
        const created = await transaction(async function (client) {
            const {rows} = await client.query(
                `INSERT INTO users (handle, name, email, email_verified) VALUES ($1, $2, $3, true)
                 ON CONFLICT (handle) DO NOTHING RETURNING id`,
                [user.handle, user.name, user.email]
            );
            if (rows.length === 0) return false;
            await client.query(
                `INSERT INTO auth_accounts (user_id, account_id, provider_id, password) VALUES ($1, $2, 'credential', $3)`,
                [rows[0].id, String(rows[0].id), await hash_password(user.password)]
            );
            return true;
        });
        console.log(created ? `Created account ${user.handle}` : `Account ${user.handle} already exists`);
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
