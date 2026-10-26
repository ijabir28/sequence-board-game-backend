const {MatchQueue, parse_config, BOT_AFTER_MS, STALE_AFTER_MS} = require('./matchmaking');

function player(handle) {
    return {user_id: handle.length, handle, name: handle.toUpperCase()};
}

const TWO_FAST = {teams: 2, timer: 'fast', turn_seconds: 15};
const THREE_FAST = {teams: 3, timer: 'fast', turn_seconds: 15};
const TWO_SLOW = {teams: 2, timer: 'slow', turn_seconds: 90};

function handles(match) {
    return match.entries.map(function (entry) {
        return entry.player.handle;
    });
}

describe('parse_config', function () {
    test('reads the teams and the timer', function () {
        expect(parse_config({teams: 2, timer: 'fast'})).toEqual(TWO_FAST);
        expect(parse_config({teams: '3', timer: 'medium'})).toEqual({teams: 3, timer: 'medium', turn_seconds: 45});
        expect(parse_config({teams: 2, timer: 'slow'})).toEqual(TWO_SLOW);
    });

    test('refuses anything else', function () {
        for (const body of [{teams: 4, timer: 'fast'}, {teams: 1, timer: 'fast'}, {teams: 2, timer: 'forever'}, {teams: 2}, {}, undefined]) {
            expect(function () {
                parse_config(body);
            }).toThrow(expect.objectContaining({code: 'INVALID_MATCH_SETTINGS'}));
        }
    });
});

describe('MatchQueue', function () {
    test('matches players who asked for the same table, oldest first', function () {
        const queue = new MatchQueue();
        queue.join(player('ann'), TWO_FAST, 0);
        queue.join(player('ben'), TWO_SLOW, 1);
        expect(queue.take_matches(2)).toEqual([]);
        queue.join(player('cat'), TWO_FAST, 3);
        queue.join(player('dan'), TWO_FAST, 4);
        const matches = queue.take_matches(5);
        expect(matches.map(handles)).toEqual([['ann', 'cat']]);
        expect(matches[0]).toEqual(expect.objectContaining({config: TWO_FAST, bots: 0}));
        // Matched players are out of the queue; the others still wait.
        expect(queue.entry('ann')).toBeUndefined();
        expect(queue.entry('dan')).toEqual(expect.objectContaining({joined_at: 4}));
        expect(queue.entry('ben')).toBeDefined();
    });

    test('needs three players for three teams', function () {
        const queue = new MatchQueue();
        queue.join(player('ann'), THREE_FAST, 0);
        queue.join(player('ben'), THREE_FAST, 0);
        expect(queue.take_matches(1)).toEqual([]);
        queue.join(player('cat'), THREE_FAST, 2);
        expect(queue.take_matches(3).map(handles)).toEqual([['ann', 'ben', 'cat']]);
    });

    test('fills the table with bots once the oldest player has waited two minutes', function () {
        const queue = new MatchQueue();
        queue.join(player('ann'), THREE_FAST, 0);
        queue.join(player('ben'), THREE_FAST, 60000);
        // Both keep checking in.
        queue.seen('ann', BOT_AFTER_MS - 1000);
        queue.seen('ben', BOT_AFTER_MS - 1000);
        expect(queue.take_matches(BOT_AFTER_MS - 1)).toEqual([]);
        const [match] = queue.take_matches(BOT_AFTER_MS);
        expect(handles(match)).toEqual(['ann', 'ben']);
        expect(match.bots).toBe(1);

        queue.join(player('cat'), TWO_SLOW, 0);
        queue.seen('cat', BOT_AFTER_MS);
        expect(queue.take_matches(BOT_AFTER_MS).map(function (m) {
            return [handles(m), m.bots];
        })).toEqual([[['cat'], 1]]);
    });

    test('drops players who stopped checking in', function () {
        const queue = new MatchQueue();
        queue.join(player('ann'), TWO_FAST, 0);
        queue.join(player('ben'), TWO_FAST, STALE_AFTER_MS);
        // ann's page closed: ben is matched with nobody yet.
        expect(queue.take_matches(STALE_AFTER_MS + 1)).toEqual([]);
        expect(queue.entry('ann')).toBeUndefined();
        expect(queue.waiting_with(queue.entry('ben'))).toBe(1);
    });

    test('keeps one entry per player, moving them when they ask for another table', function () {
        const queue = new MatchQueue();
        const first = queue.join(player('ann'), TWO_FAST, 0);
        expect(queue.join(player('ann'), TWO_FAST, 10)).toBe(first);
        expect(first).toEqual(expect.objectContaining({joined_at: 0, seen_at: 10}));
        queue.join(player('ann'), TWO_SLOW, 20);
        expect(queue.entry('ann').config).toEqual(TWO_SLOW);
        queue.join(player('ben'), TWO_FAST, 30);
        expect(queue.take_matches(31)).toEqual([]);
        expect(queue.leave('ann')).toBe(true);
        expect(queue.leave('ann')).toBe(false);
    });

    test('puts players back at the front when their table could not be made', function () {
        const queue = new MatchQueue();
        queue.join(player('ann'), TWO_FAST, 0);
        queue.join(player('ben'), TWO_FAST, 1);
        const [match] = queue.take_matches(2);
        queue.join(player('cat'), TWO_FAST, 3);
        queue.restore(match.entries);
        expect(queue.take_matches(4).map(handles)).toEqual([['ann', 'ben']]);
        expect(queue.entry('cat')).toBeDefined();
    });
});
