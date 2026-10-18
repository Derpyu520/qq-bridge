export function discordId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error('Discord IDs must be quoted strings; a JSON number can lose digits.');
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Discord ID must be a string.');
  const id = String(value).trim();
  if (!/^\d{1,20}$/.test(id) || BigInt(id) <= 0n || BigInt(id) > 18446744073709551615n) {
    throw new Error('Invalid Discord ID. Copy the ID with Discord Developer Mode enabled.');
  }
  return BigInt(id).toString();
}
