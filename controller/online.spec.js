const online = require('./online');

describe('online', function () {
    beforeEach(function () {
        online.reset();
    });

    test('a player is online while any of their sockets is connected', function () {
        expect(online.is_online('ann')).toBe(false);
        online.arrive({handle: 'ann', connection: 'a'});
        online.arrive({handle: 'ann', connection: 'b'});
        online.depart({handle: 'ann', connection: 'a'});
        expect(online.is_online('ann')).toBe(true);
        online.depart({handle: 'ann', connection: 'b'});
        expect(online.is_online('ann')).toBe(false);
    });

    test('a socket that was never counted changes nothing', function () {
        online.depart({handle: 'ben', connection: 'x'});
        expect(online.is_online('ben')).toBe(false);
    });
});
