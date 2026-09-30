import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
const repository=new URL(import.meta.url.includes('/dist/')?'../../':'../',import.meta.url);
const {replicateEncryptedBackups,parseReplicationArguments,rcloneOperation}=await import(new URL('scripts/replicate-encrypted-backups.mjs',repository).href);
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const directory=await mkdtemp(join(tmpdir(),'zoko-offsite-test-'));
  const options={root:join(directory,'source'),receipts:join(directory,'receipts'),config:join(directory,'rclone.conf'),destination:'testremote:approved-prefix',rclone:'test-rclone'};
  const remote=join(directory,'remote');
  await mkdir(options.root);await mkdir(remote);await writeFile(options.config,'[testremote]\ntype = local\n',{mode:0o600});
  // A subprocess double exercises error and persistence paths. Real age/rclone
  // rehearsal is separately recorded and never labeled independent off-site storage.
  const cipher=Buffer.from('age-encryption.org/v1\nprotected test ciphertext');
  const name='zoko-20260930T070023Z.dump.age';
  const metadata={encryptedBackup:join(options.root,name),completedAt:'2026-09-30T07:00:25Z',encryptedSha256:hash(cipher),encryptedBytes:cipher.length,plaintextBytes:123,plaintextSha256:'a'.repeat(64),secret:'MUST_NOT_UPLOAD'};
  await writeFile(join(options.root,name),cipher);await writeFile(join(options.root,`${name}.json`),JSON.stringify(metadata));
  const commands:string[][]=[];
  const execute=(failReadback=false)=>(executable:string,args:string[],childOptions:object)=>{
    assert.equal(executable,'test-rclone');commands.push(args);
    const command=args.find(a=>a==='copyto'||a==='cat')!;
    const position=args.indexOf(command),target=args[position+(command==='cat'?1:2)]!;
    const path=join(remote,target.replace('testremote:','').replaceAll('/','_'));
    const program=command==='cat'
      ? `const fs=require('fs');if(!fs.existsSync(${JSON.stringify(path)})){process.exit(4);} ${failReadback?'process.stdout.write("wrong");':`process.stdout.write(fs.readFileSync(${JSON.stringify(path)}));`}`
      : `require('fs').copyFileSync(${JSON.stringify(args[position+1])},${JSON.stringify(path)});`;
    return spawn(process.execPath,['-e',program],childOptions);
  };
  const target=join(remote,`${options.destination}/${metadata.encryptedSha256}/${name}`.replace('testremote:','').replaceAll('/','_'));
  return {options,directory,remote,name,cipher,metadata,commands,execute,target,cleanup:()=>rm(directory,{recursive:true,force:true})};
}

test('offsite replication validates destination scope and refuses secret-bearing options',()=>{
  const args=['--root','a','--config','b','--receipts','c','--destination','store:bucket/zoko'];
  assert.equal(parseReplicationArguments(args).destination,'store:bucket/zoko');
  for(const invalid of ['/local',':local:/etc','https://host','store:bucket/../other','store:bucket/./other','store:']) assert.throws(()=>parseReplicationArguments([...args.slice(0,-1),invalid]));
  assert.throws(()=>parseReplicationArguments([...args,'--identity','private']));
  assert.throws(()=>parseReplicationArguments([...args,'--token','private']));
});

test('offsite upload requires full readback and repeats without replacing receipts or uploading sidecar secrets',async()=>{
  const f=await fixture();
  try {
    const original=await readFile(join(f.options.root,`${f.name}.json`));
    const first=await replicateEncryptedBackups(f.options,f.execute());
    assert.equal(first.verified,1);assert.equal(first.pending,0);assert.equal(first.independentStorageAttested,false);
    const names=await readdir(f.options.receipts);assert.equal(names.length,1);
    const receiptPath=join(f.options.receipts,names[0]!);const prior=await readFile(receiptPath);
    const uploads=f.commands.filter(c=>c.includes('copyto')).length;
    await replicateEncryptedBackups(f.options,f.execute());
    assert.equal(f.commands.filter(c=>c.includes('copyto')).length,uploads);
    assert.deepEqual(await readFile(receiptPath),prior);assert.deepEqual(await readFile(join(f.options.root,`${f.name}.json`)),original);
    const sidecar=JSON.parse(await readFile(`${f.target}.json`,'utf8'));
    assert.equal(sidecar.secret,undefined);assert.equal(sidecar.encryptedBackup,undefined);assert.equal(sidecar.plaintextSha256,f.metadata.plaintextSha256);
    assert.deepEqual(await readFile(f.target),f.cipher);
  } finally {await f.cleanup();}
});

test('tampered local ciphertext and disguised private identities are never uploaded',async()=>{
  const f=await fixture();
  try {
    const path=join(f.options.root,f.name);
    await writeFile(path,Buffer.alloc(f.cipher.length));
    await assert.rejects(replicateEncryptedBackups(f.options,f.execute()),/binary age/);
    const altered=Buffer.from(f.cipher);altered[altered.length-1]^=1;await writeFile(path,altered);
    await assert.rejects(replicateEncryptedBackups(f.options,f.execute()),/checksum/);
    assert.equal(f.commands.length,0);assert.deepEqual(await readdir(f.remote),[]);
  } finally {await f.cleanup();}
});

test('corrupted existing remote bytes cause a terminal failure without overwrite',async()=>{
  const f=await fixture();
  try {
    await writeFile(f.target,Buffer.alloc(f.cipher.length));
    await assert.rejects(replicateEncryptedBackups(f.options,f.execute()),/Remote.*checksum/);
    assert.equal(f.commands.some(c=>c.includes('copyto')),false);
    assert.deepEqual(await readFile(f.target),Buffer.alloc(f.cipher.length));
    assert.deepEqual(await readdir(f.options.receipts),[]);
  } finally {await f.cleanup();}
});

test('failed post-upload readback preserves source and records no success; retry recovers original object',async()=>{
  const f=await fixture();
  try {
    await assert.rejects(replicateEncryptedBackups(f.options,f.execute(true)),/checksum/);
    assert.deepEqual(await readFile(join(f.options.root,f.name)),f.cipher);
    assert.deepEqual(await readdir(f.options.receipts),[]);
    const result=await replicateEncryptedBackups(f.options,f.execute());assert.equal(result.verified,1);
    assert.equal(f.commands.filter(c=>c.includes('copyto')&&c.includes(f.options.root)).length,0);
    assert.equal(f.commands.filter(c=>c.includes('copyto')&&c.some(a=>a.endsWith(`/${f.name}`))).length,1);
  } finally {await f.cleanup();}
});

test('existing process lock is preserved; missing sidecars and inconsistent receipts fail closed',async()=>{
  const f=await fixture();
  try {
    await mkdir(f.options.receipts);const lock=join(f.options.receipts,'replication.lock');await writeFile(lock,'original lock');
    await assert.rejects(replicateEncryptedBackups(f.options,f.execute()),/EEXIST/);
    assert.equal(await readFile(lock,'utf8'),'original lock');await rm(lock);
    await rm(join(f.options.root,`${f.name}.json`));
    await assert.rejects(replicateEncryptedBackups(f.options,f.execute()),/No immutable/);
    await writeFile(join(f.options.root,`${f.name}.json`),JSON.stringify({...f.metadata,encryptedBackup:'/outside'}));
    await assert.rejects(replicateEncryptedBackups(f.options,f.execute()),/contained/);
    assert.equal(f.commands.length,0);
  } finally {await f.cleanup();}
});

test('backend failures suppress diagnostics, distinguish missing from permission errors, and enforce deadline',async(t)=>{
  const f=await fixture();
  try {
    const child=(code:number,output='',stall=false)=>(_executable:string,_args:string[],opts:object)=>spawn(process.execPath,['-e',stall?'setInterval(()=>{},1000)':`process.stderr.write('SECRET');process.stdout.write(${JSON.stringify(output)});process.exit(${code});`],opts);
    for(const code of [1,2,5,7]) await assert.rejects(rcloneOperation(f.options,['cat','target'],{bytes:4,sha256:'a'.repeat(64)},child(code)),error=>error instanceof Error&&!error.message.includes('SECRET'));
    assert.equal((await rcloneOperation(f.options,['cat','target'],{bytes:4,sha256:'a'.repeat(64)},child(4))).missing,true);
    await assert.rejects(rcloneOperation(f.options,['cat','target'],{bytes:4,sha256:'a'.repeat(64)},child(4,'partial')),/bound/);
    t.mock.timers.enable({apis:['setTimeout']});
    const waiting=assert.rejects(rcloneOperation(f.options,['cat','target'],{bytes:4,sha256:'a'.repeat(64)},child(0,'',true)),/deadline/);
    t.mock.timers.tick(60001);await waiting;t.mock.timers.reset();
  } finally {await f.cleanup();}
});
