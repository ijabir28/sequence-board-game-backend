const {Pool} = require('pg');

// Matches the `db` service in docker-compose.yml, published on localhost, so `npm start` works
// against `docker compose up db` without any configuration.
const DEFAULT_DATABASE_URL = 'postgres://sequence:sequence@localhost:5432/sequence';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
});

// An idle client losing its connection (for example the database restarting) must not crash the server;
// the pool discards it and the next query opens a new connection.
pool.on('error', function (error) {
    console.error('Idle database client error:', error.message);
});

async function ping() {
    await pool.query('SELECT 1');
}

// Runs action(client) inside BEGIN … COMMIT on one connection, rolling back if it throws.
async function transaction(action) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await action(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(function () {});
        throw error;
    } finally {
        client.release();
    }
}

// Migrations hold a session-level advisory lock, which a transaction-mode pooler such as Neon's `-pooler` host doesn't
// keep, so they connect directly when DATABASE_URL_UNPOOLED is set (`neon env pull` writes it next to DATABASE_URL).
// Without it they share the app's pool. A pool opened here is closed again afterwards.
async function with_direct_pool(action) {
    if (!process.env.DATABASE_URL_UNPOOLED) {
        return action(pool);
    }
    const direct = new Pool({connectionString: process.env.DATABASE_URL_UNPOOLED});
    try {
        return await action(direct);
    } finally {
        await direct.end();
    }
}

module.exports = {pool, ping, transaction, with_direct_pool};
