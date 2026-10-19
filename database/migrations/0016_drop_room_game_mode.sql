-- Training tables are retired: table rules come from the custom settings, and learning moved to the frontend's
-- interactive training (/how-to-play/training). Rooms no longer have a game mode (0006), so no table gives hints.
ALTER TABLE rooms DROP COLUMN game_mode;
