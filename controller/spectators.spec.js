const spectators = require('./spectators');

describe('spectators', function () {
    let changes;

    beforeEach(function () {
        spectators.reset();
        changes = [];
        spectators.on_change(function (room_id, count) {
            changes.push([room_id, count]);
        });
    });

    test('counts the sockets watching a table, and says when the count changes', function () {
        spectators.watch({room_id: 'otter-1', connection: 'a'});
        spectators.watch({room_id: 'otter-1', connection: 'b'});
        expect(spectators.count('otter-1')).toBe(2);

        spectators.unwatch({room_id: 'otter-1', connection: 'a'});
        spectators.unwatch({room_id: 'otter-1', connection: 'b'});
        expect(spectators.count('otter-1')).toBe(0);
        expect(changes).toEqual([['otter-1', 1], ['otter-1', 2], ['otter-1', 1], ['otter-1', 0]]);
    });

    test('watching twice from one socket counts once, and leaving a table not watched changes nothing', function () {
        spectators.watch({room_id: 'otter-1', connection: 'a'});
        spectators.watch({room_id: 'otter-1', connection: 'a'});
        spectators.unwatch({room_id: 'otter-2', connection: 'a'});
        spectators.unwatch({room_id: 'otter-1', connection: 'b'});
        expect(spectators.count('otter-1')).toBe(1);
        expect(changes).toEqual([['otter-1', 1]]);
    });

    test('a closed socket stops watching every table it watched', function () {
        spectators.watch({room_id: 'otter-1', connection: 'a'});
        spectators.watch({room_id: 'otter-2', connection: 'a'});
        spectators.watch({room_id: 'otter-2', connection: 'b'});
        spectators.drop('a');
        expect([spectators.count('otter-1'), spectators.count('otter-2')]).toEqual([0, 1]);
    });

    test('refuses room ids that are not codes, and more tables than one socket needs', function () {
        expect(spectators.watch({room_id: 42, connection: 'a'})).toBe(false);
        expect(spectators.watch({room_id: '', connection: 'a'})).toBe(false);
        expect(spectators.watch({room_id: 'x'.repeat(81), connection: 'a'})).toBe(false);
        for (let i = 0; i < spectators.MAX_WATCHED_PER_CONNECTION; i++) {
            expect(spectators.watch({room_id: `table-${i}`, connection: 'a'})).toBe(true);
        }
        expect(spectators.watch({room_id: 'one-too-many', connection: 'a'})).toBe(false);
        expect(spectators.count('one-too-many')).toBe(0);
    });
});
