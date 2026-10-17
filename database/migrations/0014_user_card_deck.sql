-- The design the player chose for the cards in their hand (the frontend's src/decks/decks.ts), so it follows them to
-- every device. NULL until they choose one. The frontend owns the list of decks, so only the shape of the id is
-- checked here (entity/user.js); an id it no longer knows falls back to its default deck.
ALTER TABLE users ADD COLUMN card_deck TEXT CHECK (card_deck ~ '^[a-z0-9-]{1,32}$');
