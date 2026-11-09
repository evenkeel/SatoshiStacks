'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {withdrawalFeeBudget}=require('./payment-policy');
test('amount-aware routing fees round upward and obey an absolute ceiling',()=>{
  const policy={withdrawalFeeBaseSats:50,withdrawalFeeRatePpm:2000,withdrawalFeeLimitSats:500};
  assert.equal(withdrawalFeeBudget(1,policy),51);
  assert.equal(withdrawalFeeBudget(10000,policy),70);
  assert.equal(withdrawalFeeBudget(1000000,policy),500);
  assert.equal(withdrawalFeeBudget(Number.MAX_SAFE_INTEGER,policy),500);
});
test('an explicitly configured legacy ceiling is respected, including zero-fee payments',()=>{
  assert.equal(withdrawalFeeBudget(10000,{withdrawalFeeLimitSats:50}),50);
  assert.equal(withdrawalFeeBudget(10000,{withdrawalFeeLimitSats:0}),0);
});
test('invalid fee policies fail before sending funds',()=>{
  for(const policy of [{withdrawalFeeLimitSats:-1},{withdrawalFeeRatePpm:NaN},{withdrawalFeeBaseSats:1.5}]) assert.throws(()=>withdrawalFeeBudget(10000,policy),/Invalid/);
});
