jest.mock('../database/friends', () => ({friend_handles: jest.fn()}));
jest.mock('../socket', () => ({send_to: jest.fn()}));

const db_friends = require('../database/friends');
const socket_server = require('../socket');
const online = require('./online');
const friend_status = require('./friend_status');

describe('friend_status', function () {
    beforeEach(function () {
        jest.useFakeTimers();
        online.reset();
        friend_status.reset();
        socket_server.send_to.mockClear();
        db_friends.friend_handles.mockReset().mockResolvedValue(['ben', 'cat']);
    });

    afterEach(function () {
        jest.useRealTimers();
    });

    test('tells the friends who have the app open, once a burst of changes settles', async function () {
        online.arrive({handle: 'ben', connection: 'b'});
        friend_status.changed('ann');
        friend_status.changed('ann');
        jest.advanceTimersByTime(friend_status.SETTLE_MS - 1);
        expect(db_friends.friend_handles).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        await Promise.resolve();
        expect(db_friends.friend_handles).toHaveBeenCalledTimes(1);
        expect(db_friends.friend_handles).toHaveBeenCalledWith({handle: 'ann'});
        expect(socket_server.send_to.mock.calls).toEqual([[{handle: 'ben', event: 'friends_updated', data: {}}]]);
    });

    test('a later change is told again', async function () {
        friend_status.changed('ann');
        jest.advanceTimersByTime(friend_status.SETTLE_MS);
        friend_status.changed('ann');
        jest.advanceTimersByTime(friend_status.SETTLE_MS);
        await Promise.resolve();
        expect(db_friends.friend_handles).toHaveBeenCalledTimes(2);
    });
});
