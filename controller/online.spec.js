const online = require('./online');

describe('online', function () {
    let changes;

    beforeEach(function () {
        online.reset();
        changes = [];
        online.on_change((handle) => changes.push(`${handle} ${online.status(handle)}`));
    });

    afterEach(function () {
        jest.useRealTimers();
    });

    test('a player is online while any of their sockets is connected', function () {
        expect(online.status('ann')).toBe('offline');
        online.arrive({handle: 'ann', connection: 'a'});
        online.arrive({handle: 'ann', connection: 'b'});
        online.depart({handle: 'ann', connection: 'a'});
        expect(online.is_online('ann')).toBe(true);
        online.depart({handle: 'ann', connection: 'b'});
        expect(online.is_online('ann')).toBe(false);
        // Only the first socket in and the last one out change their status.
        expect(changes).toEqual(['ann online', 'ann offline']);
    });

    test('a socket that was never counted changes nothing', function () {
        online.depart({handle: 'ben', connection: 'x'});
        online.set_away({handle: 'ben', connection: 'x', away: true});
        expect(online.status('ben')).toBe('offline');
        expect(changes).toEqual([]);
    });

    test('away while every page is hidden, online while one is in view', function () {
        online.arrive({handle: 'ann', connection: 'a'});
        online.arrive({handle: 'ann', connection: 'b', away: true});
        expect(online.status('ann')).toBe('online');
        online.set_away({handle: 'ann', connection: 'a', away: true});
        expect([online.status('ann'), online.is_online('ann'), online.is_connected('ann')]).toEqual(['away', false, true]);
        online.set_away({handle: 'ann', connection: 'b', away: false});
        expect(changes).toEqual(['ann online', 'ann away', 'ann online']);
    });

    test('a hidden page that lets its socket go stays away for a while, then goes offline', function () {
        jest.useFakeTimers();
        online.arrive({handle: 'ann', connection: 'a'});
        online.set_away({handle: 'ann', connection: 'a', away: true});
        online.depart({handle: 'ann', connection: 'a'});
        expect([online.status('ann'), online.is_connected('ann')]).toEqual(['away', false]);
        jest.advanceTimersByTime(online.AWAY_MS - 1);
        expect(online.status('ann')).toBe('away');
        jest.advanceTimersByTime(1);
        expect(online.status('ann')).toBe('offline');
        expect(changes).toEqual(['ann online', 'ann away', 'ann offline']);
    });

    test('coming back while lingering away is online at once', function () {
        jest.useFakeTimers();
        online.arrive({handle: 'ann', connection: 'a', away: true});
        online.depart({handle: 'ann', connection: 'a'});
        online.arrive({handle: 'ann', connection: 'b'});
        jest.advanceTimersByTime(online.AWAY_MS);
        expect(online.status('ann')).toBe('online');
        expect(changes).toEqual(['ann away', 'ann online']);
    });

    test('a page in view that drops its socket is offline at once', function () {
        online.arrive({handle: 'ann', connection: 'a'});
        online.depart({handle: 'ann', connection: 'a'});
        expect(online.status('ann')).toBe('offline');
    });
});
