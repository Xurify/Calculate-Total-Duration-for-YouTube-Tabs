const TYPE_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** Same TypeID format as Mandala's newId: the kind, then a UUIDv7 in lowercase Crockford base32. */
export function newTypeId(kind: string, now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let time = now;
  for (let index = 5; index >= 0; index--) {
    bytes[index] = time % 256;
    time = Math.floor(time / 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let suffix = "";
  for (let index = 0; index < 26; index++) {
    suffix = TYPE_ID_ALPHABET[Number(value & 31n)] + suffix;
    value >>= 5n;
  }
  return `${kind}_${suffix}`;
}
