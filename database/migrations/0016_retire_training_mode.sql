-- Training tables are retired: table rules now come from the custom settings, and learning moved to the frontend's
-- interactive training (/how-to-play/training). Every room still in `training` mode plays as a standard one, so no
-- table gives hints any more. The column and its check stay, so older rows and the API keep their shape.
UPDATE rooms SET game_mode = 'standard' WHERE game_mode = 'training';
