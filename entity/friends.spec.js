const {parse_search, parse_handle, reinvite_wait, wait_text, REINVITE_COOLDOWN_SECONDS} = require('./friends');

describe('friends', function () {
    test('a search needs two letters, trimmed, and is cut at 50', function () {
        expect(parse_search(' a ').error).toMatch(/at least 2/);
        expect(parse_search(undefined).error).toBeDefined();
        expect(parse_search('  an ')).toEqual({query: 'an'});
        expect(parse_search('x'.repeat(80)).query).toHaveLength(50);
    });

    test('a handle is lower case, without spaces or a leading @', function () {
        expect(parse_handle(' @Ann ')).toBe('ann');
        expect(parse_handle(42)).toBe('');
    });

    test('each dismissal makes the next invitation wait longer, until there are no more', function () {
        const at = new Date('2026-10-25T10:00:00Z');
        const second = 1000;
        expect(reinvite_wait({})).toEqual({allowed: true});
        expect(REINVITE_COOLDOWN_SECONDS).toEqual([10, 30, 60, 180, 300]);
        REINVITE_COOLDOWN_SECONDS.forEach(function (seconds, i) {
            const wait = reinvite_wait({dismissals: i + 1, last_dismissed_at: at, now: at.getTime() + second});
            expect(wait).toEqual({allowed: false, retry_at: new Date(at.getTime() + seconds * second)});
            expect(reinvite_wait({dismissals: i + 1, last_dismissed_at: at, now: at.getTime() + seconds * second})).toEqual({allowed: true});
        });
        expect(reinvite_wait({dismissals: 6, last_dismissed_at: at, now: at.getTime() + 999 * 60 * second})).toEqual({allowed: false, limit_reached: true});
    });

    test('a wait reads in seconds under a minute, then minutes and hours, rounded up', function () {
        const now = 0;
        expect(wait_text(new Date(1), now)).toBe('1 second');
        expect(wait_text(new Date(9001), now)).toBe('10 seconds');
        expect(wait_text(new Date(59000), now)).toBe('59 seconds');
        expect(wait_text(new Date(59001), now)).toBe('1 minute');
        expect(wait_text(new Date(150000), now)).toBe('3 minutes');
        expect(wait_text(new Date(14 * 60000 + 1), now)).toBe('15 minutes');
        expect(wait_text(new Date(60 * 60000), now)).toBe('1 hour');
        expect(wait_text(new Date(80 * 60000), now)).toBe('1 hour 20 minutes');
    });
});
