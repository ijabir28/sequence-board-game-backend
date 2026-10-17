// Serving the built frontend (FRONTEND_DIST). Needs no database: none of these requests touch a session.
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

describe('built frontend', function () {
    let dist;
    let app;

    beforeAll(function () {
        dist = fs.mkdtempSync(path.join(os.tmpdir(), 'frontend-dist-'));
        fs.writeFileSync(path.join(dist, 'index.html'), '<div id="root">react</div>');
        fs.mkdirSync(path.join(dist, 'assets'));
        fs.writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
        process.env.FRONTEND_DIST = dist;
        jest.isolateModules(function () {
            app = require('./app');
        });
    });

    afterAll(function () {
        delete process.env.FRONTEND_DIST;
        fs.rmSync(dist, {recursive: true, force: true});
    });

    test('serves its index.html at / instead of the legacy page', async function () {
        const response = await request(app).get('/').set('Accept', 'text/html');
        expect(response.status).toBe(200);
        expect(response.text).toContain('react');
    });

    test('serves its assets', async function () {
        const response = await request(app).get('/assets/app.js');
        expect(response.status).toBe(200);
        expect(response.text).toBe('console.log(1)');
    });

    test('answers frontend routes with index.html', async function () {
        const response = await request(app).get('/table/abc/game').set('Accept', 'text/html');
        expect(response.status).toBe(200);
        expect(response.text).toContain('react');
    });

    test('still serves the backend images', async function () {
        const image = fs.readdirSync(path.join(__dirname, 'public', 'images', 'card_deck'))[0];
        const response = await request(app).get(`/images/card_deck/${image}`);
        expect(response.headers['content-type']).toMatch(/^image\//);
        expect(response.status).toBe(200);
    });

    test('does not answer non-page requests with index.html', async function () {
        const response = await request(app).get('/nothing-here.json').set('Accept', 'application/json');
        expect(response.status).toBe(404);
    });
});
