-- Pausa del cronómetro: guarda el tiempo restante (ms) al salir; se reanuda al volver.
ALTER TABLE "Attempt" ADD COLUMN "remainingMs" INTEGER;
