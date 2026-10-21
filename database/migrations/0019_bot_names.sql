-- Bots pass for players at Quick Match tables (see controller/matchmaking.js).

-- Bots get everyday names and handles, so a match against one looks like any other. A handle somebody already has is
-- skipped for the next candidate.
DO $$
DECLARE
    bot RECORD;
    chosen TEXT;
BEGIN
    FOR bot IN
        SELECT * FROM (VALUES
            ('bot-ada', 'Maya', ARRAY['maya_r', 'mayarahman', 'maya_r07', 'maya_rr']),
            ('bot-alan', 'Rafi', ARRAY['rafi_h', 'rafihasan', 'rafi_h21', 'rafi_hh']),
            ('bot-grace', 'Nadia', ARRAY['nadia_k', 'nadiakhan', 'nadia_k11', 'nadia_kk']),
            ('bot-hedy', 'Tanvir', ARRAY['tanvir_a', 'tanvirahmed', 'tanvir_a9', 'tanvir_aa'])
        ) AS bots (old_handle, name, handles)
    LOOP
        SELECT candidate INTO chosen
        FROM unnest(bot.handles) WITH ORDINALITY AS options (candidate, position)
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.handle = options.candidate)
        ORDER BY position
        LIMIT 1;
        IF chosen IS NULL THEN
            chosen := bot.handles[1] || floor(random() * 9000 + 1000)::INTEGER;
        END IF;
        UPDATE users SET handle = chosen, name = bot.name, updated_at = now() WHERE handle = bot.old_handle AND is_bot;
    END LOOP;
END;
$$;
