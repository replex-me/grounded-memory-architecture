import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, digest } from './store.mjs';
import { exportArchive, importArchive } from './archive.mjs';
const at='2026-01-01T00:00:00Z';
function empty(file=':memory:') {
  const s=new MemoryStore(new DatabaseSync(file),{owned:true});s.install();return s;
}
function fixture() {
  const s=empty(), text='조건이 있는 경험 😀', context={scope:'test',condition:'입력 존재',valid_from:null,valid_until:null};
  const input={id:'s',revision:1,text,sha256:createHash('sha256').update(text).digest('hex'),source:'urn:synthetic',origin_group:'event',observed_at:at,recorded_at:at,state:'available'};
  const m={id:'m',revision:1,text:'입력이 있을 때 유효하다',kind:'belief',context,state:'current',review_required:true,review:null};
  const l={id:'l',revision:1,source:'s',target:'m',type:'supports',context,state:'current',basis:[{input_id:'s',sha256:input.sha256,start:0,end:Array.from(text).length,quote:text}],review:{actor:'tester',reason:'조건과 근거 대조'}};
  const write=(id,operations,ids,expect_units={})=>s.apply({request_id:id,actor:'tester',recorded_at:at,reason:'합성 검토',expect:s.guard(ids),expect_units,operations});
  write('initial',[{op:'put',type:'input',record:input},{op:'put',type:'memory',record:m},{op:'put',type:'link',record:l}],['s','m','l']);
  write('unit',[{op:'unit',input_id:'s',key:'whole',start:0,end:Array.from(text).length,outcome:'integrated',targets:['m'],reason:'전체 구간 의미 확인'}],['s','m'],{[JSON.stringify(['s','whole'])]:null});
  write('review',[{op:'review',id:'m',token:s.inspect('m').review_token,reason:'원문과 조건 검토'}],['m']);
  write('use',[{op:'use',id:'m',task_id:'task'}],['m']);
  return s;
}
const reseal=a=>{const {integrity,...p}=a;return {...p,integrity:digest(p)};};
test('journal round trip preserves current meaning, exact source, review, evidence, units, usage and receipts after restart',()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'gma-exchange-')), file=path.join(folder,'restored.sqlite');
  const a=fixture();let b=empty(file);
  try {
    const archive=exportArchive(a);assert.deepEqual(exportArchive(a),archive);
    const result=importArchive(b,archive);assert.equal(result.requests,4);
    b.close();b=empty(file);
    assert.deepEqual(b.inspect('m'),a.inspect('m'));assert.deepEqual(b.source('s'),a.source('s'));
    assert.deepEqual(b.inspect('s').units,a.inspect('s').units);
    assert.deepEqual(b.receipt('use'),a.receipt('use'));
    assert.deepEqual(exportArchive(b),archive);
  } finally {a.close();b.close();fs.rmSync(folder,{recursive:true,force:true});}
});
test('damaged envelope and request hash are rejected before writes',()=>{
  const a=fixture(),b=empty();try{
    const archive=exportArchive(a),bad=structuredClone(archive);bad.requests[0].change.reason='tampered';
    assert.throws(()=>importArchive(b,bad),/integrity/);
    assert.throws(()=>importArchive(b,reseal(bad)),/request hash/);
    assert.equal(b.stats().changes,0);
  } finally {a.close();b.close();}
});
test('invalid later change rolls back earlier replay and final state mismatch also rolls back',()=>{
  const a=fixture(),b=empty();try{
    const bad=exportArchive(a);bad.requests[3].change.expect.m='0'.repeat(64);bad.requests[3].hash=digest(bad.requests[3].change);
    assert.throws(()=>importArchive(b,reseal(bad)),/Concurrent/);
    assert.equal(b.stats().changes,0);assert.equal(b.raw('m'),null);
    const mismatch=exportArchive(a);mismatch.state_digest='wrong';
    assert.throws(()=>importArchive(b,reseal(mismatch)),/state mismatch/);
    assert.equal(b.stats().changes,0);
  } finally {a.close();b.close();}
});
test('nonempty destinations, duplicate requests and incompatible profiles are rejected',()=>{
  const a=fixture(),b=empty();try{
    const archive=exportArchive(a);assert.throws(()=>importArchive(a,archive),/empty/);
    const duplicate=structuredClone(archive);duplicate.requests.push(duplicate.requests[0]);
    assert.throws(()=>importArchive(b,reseal(duplicate)),/Duplicate/);
    assert.throws(()=>importArchive(b,reseal({...archive,profile:'another/1'})),/profile/);
  } finally {a.close();b.close();}
});
test('replay preserves unrelated host tables and participates in parent rollback',()=>{
  const a=fixture(),b=empty();try{
    b.db.exec("CREATE TABLE host(value TEXT);INSERT INTO host VALUES('keep');PRAGMA user_version=41;BEGIN");
    importArchive(b,exportArchive(a));assert.equal(b.db.isTransaction,true);assert.ok(b.raw('m'));
    b.db.exec('ROLLBACK');assert.equal(b.raw('m'),null);assert.equal(b.stats().changes,0);
    assert.equal(b.db.prepare('SELECT value FROM host').get().value,'keep');
    assert.equal(b.db.prepare('PRAGMA user_version').get().user_version,41);
  } finally {a.close();b.close();}
});
