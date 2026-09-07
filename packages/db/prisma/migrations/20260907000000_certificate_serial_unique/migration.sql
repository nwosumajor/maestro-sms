-- A certificate serial is the id the document is VERIFIED by. Two documents
-- sharing one verifies neither, and the column had no constraint — so a
-- collision would not have errored, it would have minted a silent duplicate.
-- With both generators now drawing an 8-hex-character CSPRNG suffix this is a
-- backstop rather than a live risk, which is exactly when to add it: a
-- collision is a 409 the desk retries (P2002 -> 409 in the global filter),
-- never two cards that verify as the same card.
CREATE UNIQUE INDEX "issued_certificate_serial_key" ON "issued_certificate"("serial");
