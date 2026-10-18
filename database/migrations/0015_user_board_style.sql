-- How the player's board cells look (the frontend's board styles in src/decks/decks.ts: dark tiles or card faces), so
-- it follows them to every device like their card deck (0014). NULL until they choose one; only the id's shape is
-- checked here (entity/user.js).
ALTER TABLE users ADD COLUMN board_style TEXT CHECK (board_style ~ '^[a-z0-9-]{1,32}$');
