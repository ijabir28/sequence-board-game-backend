-- The bot named Nadia becomes Samia, with handles to match (see 0019_bot_names.sql). As there, a handle somebody
-- already has is skipped for the next candidate.
DO $$
DECLARE
    handles TEXT[] := ARRAY['samia_k', 'samiakhan', 'samia_k11', 'samia_kk'];
    chosen TEXT;
BEGIN
    SELECT candidate INTO chosen
    FROM unnest(handles) WITH ORDINALITY AS options (candidate, position)
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE users.handle = options.candidate)
    ORDER BY position
    LIMIT 1;
    IF chosen IS NULL THEN
        chosen := handles[1] || floor(random() * 9000 + 1000)::INTEGER;
    END IF;
    UPDATE users SET handle = chosen, name = 'Samia', updated_at = now()
    WHERE email = 'bot-grace@bots.invalid' AND is_bot;
END;
$$;
