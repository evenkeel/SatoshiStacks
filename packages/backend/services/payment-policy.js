'use strict';
function withdrawalFeeBudget(amountSats, policy) {
  const cap = policy.withdrawalFeeLimitSats ?? 500;
  const base = policy.withdrawalFeeBaseSats ?? cap;
  const ppm = policy.withdrawalFeeRatePpm ?? 0;
  if (![amountSats,cap,base,ppm].every(Number.isSafeInteger) || amountSats <= 0 || cap < 0 || base < 0 || ppm < 0) throw new Error('Invalid withdrawal fee policy');
  const fee = BigInt(base) + (BigInt(amountSats) * BigInt(ppm) + 999999n) / 1000000n;
  return Number(fee < BigInt(cap) ? fee : BigInt(cap));
}
module.exports = {withdrawalFeeBudget};
