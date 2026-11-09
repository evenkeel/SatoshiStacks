'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./app.js'),'utf8');
const merge=source.slice(source.indexOf('function mergeHandHistories('),source.indexOf('async function loadHandHistories('));
function state(records,index){const context={handHistories:records,histViewIdx:index};vm.createContext(context);vm.runInContext(merge,context);return context;}
test('restored histories merge by permanent ID while keeping the selected hand',()=>{
 const c=state([{handId:'b',startedAt:2,history:'live'}],0);
 c.mergeHandHistories([{handId:'a',startedAt:1},{handId:'b',startedAt:2,history:'saved'}]);
 assert.equal(c.handHistories.length,2);assert.equal(c.histViewIdx,1);assert.equal(c.handHistories[1].history,'saved');
});
test('an observer update cannot replace a player personal export with a public-only copy',()=>{
 const c=state([{handId:'a',startedAt:1,personal:true,history:'Dealt to Alice [Ah Ad]'}],0);
 c.mergeHandHistories([{handId:'a',startedAt:1,personal:false,history:'public'}]);
 assert.match(c.handHistories[0].history,/Ah Ad/);
});
