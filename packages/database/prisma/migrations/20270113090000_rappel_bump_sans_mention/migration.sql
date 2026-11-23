-- Rappel de bump : un membre peut couper la mention qui le vise quand le
-- rappel sonne après son bump (`/rappel-bump`). Choix propre au serveur.

ALTER TABLE "member_profiles" ADD COLUMN IF NOT EXISTS "bumpPingOptOut" BOOLEAN NOT NULL DEFAULT false;
