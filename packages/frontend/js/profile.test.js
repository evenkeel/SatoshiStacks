'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {metadata}=require('./profile');
test('profile edits preserve unedited metadata and external NIP-05 identifiers',()=>{
  const old={lud16:'sats@example.com',banner:'https://example.com/banner',nip05:'alice@example.com',custom:{hello:'world'}};
  const result=metadata(old,{name:' Alice ',about:' Bio ',picture:'',website:''},null);
  assert.equal(result.name,'Alice');assert.equal(result.display_name,'Alice');assert.equal(result.about,'Bio');
  assert.equal(result.lud16,old.lud16);assert.equal(result.nip05,old.nip05);assert.deepEqual(result.custom,old.custom);assert.equal(result.banner,old.banner);
});
test('optional local claim is included in the signed profile',()=>{
  const fields={name:'',about:'',picture:'',website:''};
  assert.equal(metadata({},fields,'alice').nip05,'alice@satoshistacks.com');
  assert.equal(Object.hasOwn(metadata({},fields,null),'nip05'),false);
});
test('receiving address changes are signed and advertise the purchased alias',()=>{
  const fields={name:'Alice',about:'',picture:'',website:'',lightningAddress:' Alice@Wallet.Example '};
  const profile=metadata({},fields,'alice');
  assert.equal(profile.satoshistacks_lightning_address,'alice@wallet.example');
  assert.equal(profile.lud16,'alice@satoshistacks.com');
  const disabled=metadata(profile,{...fields,lightningAddress:''},'alice');
  assert.equal(Object.hasOwn(disabled,'satoshistacks_lightning_address'),false);
  assert.equal(disabled.lud16,'alice@wallet.example');
});
