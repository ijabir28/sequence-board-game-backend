const EventEmitter = require('events');
const table_chat = require('./table_chat');

const ADA = {handle: 'ada', name: 'Ada'};
const BEN = {handle: 'ben', name: 'Ben'};

// Stands in for one socket and the Socket.IO server: records who joined which table and what went to each.
function fake_socket({account, rooms = ['otter-1']}) {
    const connection = new EventEmitter();
    connection.disconnected = false;
    connection.joined = new Set();
    connection.sent = [];
    connection.join = (name) => connection.joined.add(name);
    connection.leave = (name) => connection.joined.delete(name);
    const io = {
        emitted: [],
        to(name) {
            return {emit: (event, data) => io.emitted.push({to: name, event, data})};
        },
    };
    // Events this socket receives from the server, kept apart from the ones the test sends it.
    connection.emit = function (event, data) {
        connection.sent.push({event, data});
    };
    table_chat.bind({
        connection,
        io,
        account: () => account,
        room_exists: async (room_id) => rooms.includes(room_id),
    });
    const send = (event, data) =>
        new Promise((resolve) => {
            EventEmitter.prototype.emit.call(connection, event, data, resolve);
        });
    const open = async (room_id) => {
        EventEmitter.prototype.emit.call(connection, 'open_table_chat', {room_id});
        await new Promise((resolve) => setImmediate(resolve));
    };
    return {connection, io, send, open};
}

describe('table chat', function () {
    beforeEach(function () {
        table_chat.reset();
    });

    test('a message is cleaned, kept for the table and sent back as {message}', function () {
        const {message} = table_chat.post_message({room_id: 'otter-1', author: ADA, text: '  good\n\tluck  all ', now: 1000});
        expect(message).toEqual({id: expect.any(String), author: ADA, text: 'good luck all', at: new Date(1000).toISOString()});
        expect(table_chat.history('otter-1')).toEqual([message]);
        expect(table_chat.history('otter-2')).toEqual([]);
    });

    test('refuses the signed out, empty and long messages', function () {
        expect(table_chat.post_message({room_id: 'otter-1', author: undefined, text: 'hi'}).error).toBe('NOT_SIGNED_IN');
        expect(table_chat.post_message({room_id: 'otter-1', author: ADA, text: ' \n '}).error).toBe('EMPTY');
        expect(table_chat.post_message({room_id: 'otter-1', author: ADA, text: 42}).error).toBe('EMPTY');
        const long = 'x'.repeat(table_chat.MAX_TEXT_LENGTH + 1);
        expect(table_chat.post_message({room_id: 'otter-1', author: ADA, text: long})).toEqual({
            error: 'TOO_LONG',
            message: expect.any(String),
        });
        expect(table_chat.history('otter-1')).toEqual([]);
    });

    test('keeps only the last messages of a table', function () {
        for (let i = 0; i < table_chat.HISTORY_LENGTH + 5; i++) {
            table_chat.post_message({room_id: 'otter-1', author: {handle: `p${i}`, name: 'P'}, text: `m${i}`});
        }
        const kept = table_chat.history('otter-1');
        expect(kept).toHaveLength(table_chat.HISTORY_LENGTH);
        expect(kept[0].text).toBe('m5');
    });

    test('limits how fast one account sends, messages and reactions together', function () {
        for (let i = 0; i < table_chat.RATE_LIMIT - 1; i++) {
            expect(table_chat.post_message({room_id: 'otter-1', author: ADA, text: 'hi', now: 1000}).message).toBeDefined();
        }
        expect(table_chat.react({room_id: 'otter-1', author: ADA, reaction: 'clap', now: 1000}).reaction).toBeDefined();
        expect(table_chat.post_message({room_id: 'otter-1', author: ADA, text: 'hi', now: 1000}).error).toBe('TOO_FAST');
        expect(table_chat.react({room_id: 'otter-1', author: ADA, reaction: 'clap', now: 1000}).error).toBe('TOO_FAST');
        // Someone else isn't held up, and the account may go on once the window has passed.
        expect(table_chat.post_message({room_id: 'otter-1', author: BEN, text: 'hi', now: 1000}).message).toBeDefined();
        expect(table_chat.post_message({room_id: 'otter-1', author: ADA, text: 'hi', now: 1000 + table_chat.RATE_WINDOW_MS}).message).toBeDefined();
    });

    test('reactions must be one of the table\'s and are not kept', function () {
        expect(table_chat.react({room_id: 'otter-1', author: ADA, reaction: 'fire'}).reaction).toMatchObject({author: ADA, reaction: 'fire'});
        expect(table_chat.react({room_id: 'otter-1', author: ADA, reaction: '<script>'}).error).toBe('UNKNOWN_REACTION');
        expect(table_chat.history('otter-1')).toEqual([]);
    });

    describe('on a socket', function () {
        test('opening a table\'s chat joins its channel and sends the history', async function () {
            table_chat.post_message({room_id: 'otter-1', author: BEN, text: 'welcome'});
            const {connection, open} = fake_socket({account: undefined});
            await open('otter-1');
            expect(connection.joined).toEqual(new Set(['table:otter-1']));
            expect(connection.sent).toEqual([
                {event: 'table_chat_history', data: {room_id: 'otter-1', messages: [expect.objectContaining({text: 'welcome'})]}},
            ]);
        });

        test('a table that does not exist, or one too many, is not opened', async function () {
            const rooms = Array.from({length: table_chat.MAX_OPEN_PER_CONNECTION + 1}, (v, i) => `t-${i}`);
            const {connection, open} = fake_socket({account: ADA, rooms});
            await open('nowhere');
            for (const room of rooms) await open(room);
            expect(connection.joined.has('table:nowhere')).toBe(false);
            expect(connection.joined.size).toBe(table_chat.MAX_OPEN_PER_CONNECTION);
        });

        test('a message goes to everyone at the table, under the sender\'s own name', async function () {
            const {io, send, open} = fake_socket({account: ADA});
            await open('otter-1');
            await expect(send('send_table_chat', {room_id: 'otter-1', text: 'nice move'})).resolves.toEqual({ok: true});
            expect(io.emitted).toEqual([
                {to: 'table:otter-1', event: 'table_chat', data: {room_id: 'otter-1', message: expect.objectContaining({author: ADA, text: 'nice move'})}},
            ]);
        });

        test('there are no private messages: a recipient or a borrowed name in the payload is ignored', async function () {
            const {io, send, open} = fake_socket({account: ADA});
            await open('otter-1');
            await send('send_table_chat', {room_id: 'otter-1', text: 'psst', to: 'ben', recipient: 'ben', private: true, author: BEN});
            await send('send_table_reaction', {room_id: 'otter-1', reaction: 'wow', to: 'ben'});
            expect(io.emitted.map((e) => e.to)).toEqual(['table:otter-1', 'table:otter-1']);
            const [{data: chat}, {data: reaction}] = io.emitted;
            expect(Object.keys(chat.message).sort()).toEqual(['at', 'author', 'id', 'text']);
            expect(chat.message.author).toEqual(ADA);
            expect(Object.keys(reaction.reaction).sort()).toEqual(['at', 'author', 'id', 'reaction']);
        });

        test('a socket can\'t speak at a table it hasn\'t opened, nor signed out', async function () {
            const signed_in = fake_socket({account: ADA});
            await expect(signed_in.send('send_table_chat', {room_id: 'otter-1', text: 'hi'})).resolves.toMatchObject({error: 'NOT_AT_TABLE'});
            const signed_out = fake_socket({account: undefined});
            await signed_out.open('otter-1');
            await expect(signed_out.send('send_table_chat', {room_id: 'otter-1', text: 'hi'})).resolves.toMatchObject({error: 'NOT_SIGNED_IN'});
            await expect(signed_out.send('send_table_reaction', {room_id: 'otter-1', reaction: 'heart'})).resolves.toMatchObject({error: 'NOT_SIGNED_IN'});
            expect(signed_in.io.emitted).toEqual([]);
            expect(signed_out.io.emitted).toEqual([]);
        });

        test('closing the chat leaves the table\'s channel', async function () {
            const {connection, send, open} = fake_socket({account: ADA});
            await open('otter-1');
            connection.listeners('close_table_chat')[0]({room_id: 'otter-1'});
            expect(connection.joined.size).toBe(0);
            await expect(send('send_table_chat', {room_id: 'otter-1', text: 'hi'})).resolves.toMatchObject({error: 'NOT_AT_TABLE'});
        });
    });
});
