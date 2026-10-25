-- A player the host sent away may ask once to come back, which the host can let them do or decline (see
-- controller/room.js). Letting them back in deletes the row, as inviting them back does; a declined player can't ask
-- again, though the host may still let them in.
ALTER TABLE room_bans
    ADD COLUMN rejoin_requested_at TIMESTAMPTZ,
    ADD COLUMN rejoin_declined_at  TIMESTAMPTZ;
