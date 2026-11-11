const text = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : '';
const personalIdentity = (value: string) => {
  if (!/^\d{17}[\dX]$/.test(value)) return false;
  const year = Number(value.slice(6, 10)), month = Number(value.slice(10, 12)), day = Number(value.slice(12, 14));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1800 || year > new Date().getUTCFullYear() || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return false;
  const sum = [7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2].reduce((total, weight, i) => total + Number(value[i]) * weight, 0);
  return '10X98765432'[sum % 11] === value[17];
};

/** Validate characters and checksum; never send a person's identity number to an enterprise provider. */
export function normalizeCreditCode(value: unknown): string {
  const result = text(value);
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(result) || personalIdentity(result)) return '';
  const alphabet = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const sum = [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28].reduce((total, weight, i) => total + alphabet.indexOf(result[i]) * weight, 0);
  return alphabet[(31 - sum % 31) % 31] === result[17] ? result : '';
}
