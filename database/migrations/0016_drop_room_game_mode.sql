-- Training tables were retired a release earlier: since then no server reads or writes rooms.game_mode (0006), so it
-- can go without breaking a server still serving during the switch-over.
ALTER TABLE rooms DROP COLUMN game_mode;
