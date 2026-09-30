import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
const repository=new URL(import.meta.url.includes('/dist/')?'../../':'../',import.meta.url);
const {verifyEncryptedBackup,validateMetadata,parseArguments}=await import(new URL('scripts/verify-encrypted-backup.mjs',repository).href);
const hash=(input:Buffer)=>createHash('sha256').update(input).digest('hex');

async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'zoko-backup-verification-'));
  const cipher=Buffer.from('protected encrypted fixture');
  const plain=Buffer.from('database bytes must never be written to disk');
  const metadata={encryptedSha256:hash(cipher),plaintextSha256:hash(plain),encryptedBytes:cipher.length,plaintextBytes:plain.length};
  const options={receipt:join(directory,'receipt.json'),file:join(directory,'backup.age'),identity:join(directory,'identity.txt'),age:'test-decryptor'};
  await Promise.all([writeFile(options.receipt,JSON.stringify(metadata)),writeFile(options.file,cipher),writeFile(options.identity,'local test identity')]);
  const decrypt=(output=plain,status=0,diagnostics='')=>(executable:string,args:string[],childOptions:object)=>{
    assert.equal(executable,'test-decryptor');
    assert.deepEqual(args,['--decrypt','--identity',options.identity]);
    const program=`process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write(${JSON.stringify(diagnostics)});process.stdout.write(Buffer.from('${output.toString('hex')}','hex'));process.exit(${status});});`;
    return spawn(process.execPath,['-e',program],childOptions);
  };
  return {directory,cipher,plain,metadata,options,decrypt,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

test('backup verification rejects invalid hashes, unsafe sizes and secret-bearing unknown options',()=>{
  const metadata={encryptedSha256:'a'.repeat(64),plaintextSha256:'b'.repeat(64),encryptedBytes:50,plaintextBytes:40};
  assert.deepEqual(validateMetadata(metadata),metadata);
  for(const size of [0,-1,50_000_001,Infinity,1.5]) assert.throws(()=>validateMetadata({...metadata,plaintextBytes:size}));
  assert.throws(()=>validateMetadata({...metadata,encryptedSha256:'invalid'}));
  assert.throws(()=>parseArguments(['--token','secret']));
  assert.throws(()=>parseArguments(['--receipt','a','--receipt','b']));
});

test('repeat verification preserves original ciphertext, identity and receipt and writes no plaintext',async()=>{
  const f=await fixture();
  try {
    const originals=await Promise.all([readFile(f.options.file),readFile(f.options.identity),readFile(f.options.receipt)]);
    for(let i=0;i<2;i++) {
      const result=await verifyEncryptedBackup(f.options,f.decrypt());
      assert.equal(result.decryptionVerified,true); assert.equal(result.plaintextWrittenToDisk,false);
    }
    assert.deepEqual(await Promise.all([readFile(f.options.file),readFile(f.options.identity),readFile(f.options.receipt)]),originals);
    assert.deepEqual((await readdir(f.directory)).sort(),['backup.age','identity.txt','receipt.json']);
  } finally {await f.cleanup();}
});

test('tampered or truncated ciphertext never reaches the decryptor and remains intact',async()=>{
  const f=await fixture();
  try {
    const noSpawn=()=>{throw Error('Decryptor must not run');};
    for(const altered of [Buffer.alloc(f.cipher.length,0),f.cipher.subarray(1)]) {
      await writeFile(f.options.file,altered);
      await assert.rejects(verifyEncryptedBackup(f.options,noSpawn),/Ciphertext/);
      assert.deepEqual(await readFile(f.options.file),altered);
    }
  } finally {await f.cleanup();}
});

test('wrong decryptor output, oversize output and failure diagnostics are rejected without disclosure',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(verifyEncryptedBackup(f.options,f.decrypt(Buffer.alloc(f.plain.length))),/checksum/);
    await assert.rejects(verifyEncryptedBackup(f.options,f.decrypt(Buffer.alloc(f.plain.length+1))),/declared size/);
    await assert.rejects(verifyEncryptedBackup(f.options,f.decrypt(Buffer.alloc(0),1,'private identity secret')),error=>{
      assert.equal(String(error).includes('private identity secret'),false); return true;
    });
    assert.deepEqual(await readFile(f.options.file),f.cipher);
  } finally {await f.cleanup();}
});

test('missing decryptor fails closed without writing plaintext or modifying backup',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(verifyEncryptedBackup({...f.options,age:join(f.directory,'does-not-exist')}),/could not start|input failed/);
    assert.deepEqual(await readFile(f.options.file),f.cipher);
    assert.equal((await readdir(f.directory)).length,3);
  } finally {await f.cleanup();}
});

test('a stalled decryptor is terminated at the verification deadline',async(t)=>{
  const f=await fixture();
  t.mock.timers.enable({apis:['setTimeout']});
  let started!:()=>void;
  const startedPromise=new Promise<void>(resolve=>{started=resolve;});
  try {
    const stalled=(_executable:string,_args:string[],childOptions:object)=>{
      const child=spawn(process.execPath,['-e','process.stdin.resume();setInterval(()=>{},1000);'],childOptions);
      started(); return child;
    };
    const rejected=assert.rejects(verifyEncryptedBackup(f.options,stalled),/time limit/);
    await startedPromise;
    t.mock.timers.tick(60_000);
    await rejected;
    assert.deepEqual(await readFile(f.options.file),f.cipher);
  } finally {t.mock.timers.reset();await f.cleanup();}
});
