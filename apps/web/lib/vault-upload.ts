// =============================================================================
// Putting a file into the Document Vault, from anywhere
// =============================================================================
// The Documents page owned this pair privately. The LEAVE form needs the same
// two steps — the API only accepts an attachment the CALLER uploaded, so a
// supporting document has to reach the Vault before the request can point at
// it — and a second copy of a base64 reader and a size cap is how the two would
// drift apart on the limit they enforce.
// =============================================================================

/** Read a File as a bare base64 string (strip the `data:` URL prefix). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^;]+;base64,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * ONE limit, in one place. The server enforces its own; this is what stops a
 * user waiting for a base64 encode of a file that was always going to be
 * refused.
 */
export const MAX_VAULT_BYTES = 10 * 1024 * 1024;
