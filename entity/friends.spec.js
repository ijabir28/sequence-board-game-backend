const {parse_search, parse_handle} = require('./friends');

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
});
