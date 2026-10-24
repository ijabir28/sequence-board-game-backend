const online = require('./online');

describe('online', function () {
    beforeEach(function () {
        online.reset();
    });

    test('a player is online while any of their sockets is connected', function () {
        expect(online.is_online('ann')).toBe(false);
        // Only the first socket in and the last one out change anything, and say so.
        expect(online.arrive({handle: 'ann', connection: 'a'})).toBe(true);
        expect(online.arrive({handle: 'ann', connection: 'b'})).toBe(false);
        expect(online.depart({handle: 'ann', connection: 'a'})).toBe(false);
        expect(online.is_online('ann')).toBe(true);
        expect(online.depart({handle: 'ann', connection: 'b'})).toBe(true);
        expect(online.is_online('ann')).toBe(false);
    });

    test('a socket that was never counted changes nothing', function () {
        expect(online.depart({handle: 'ben', connection: 'x'})).toBe(false);
        expect(online.is_online('ben')).toBe(false);
    });
});
