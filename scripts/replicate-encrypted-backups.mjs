import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {open, lstat, readFile, readdir, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {validateMetadata} from './verify-encrypted-backup.mjs';

const namePattern=/^zoko-\d{8}T\d{6}Z\.dump\.age$/;
const help=`Replicate only validated age ciphertext and sanitized metadata using rclone.
Usage: node scripts/replicate-encrypted-backups.mjs --root DIRECTORY --config FILE --destination REMOTE:PREFIX --receipts DIRECTORY [--rclone EXECUTABLE]
No private identity, plaintext, database connection or delete operation is used.
Uploads are immutable and content-addressed; successful receipts require full remote readback.
Requires trusted rclone configuration and an independently hosted, owner-approved destination.
`;

export function parseReplicationArguments(args) {
  const options={rclone:'rclone'}, seen=new Set();
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--help') return {help:true};
    if(!['--root','--config','--destination','--receipts','--rclone'].includes(args[i])||seen.has(args[i])) throw Error('Invalid replication arguments. Use --help.');
    const key=args[i].slice(2),value=args[++i];
    if(!value||value.startsWith('--')||value.includes('\0')) throw Error('Missing replication argument.');
    seen.add(`--${key}`);options[key]=value;
  }
  if(!options.root||!options.config||!options.destination||!options.receipts) throw Error('Root, config, destination and receipts are required.');
  if(!/^[a-zA-Z][a-zA-Z0-9_-]{1,63}:[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(options.destination)||options.destination.split('/').some(p=>p==='..'||p==='.')||options.destination.endsWith('/')) throw Error('Destination must be a named rclone remote and bounded prefix.');
  return options;
}

function processEnvironment() {
  // Prevent inherited debug/RC/metrics/backend overrides from exposing credentials
  // or changing the explicitly selected destination. Never pass secrets on argv.
  return Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^RCLONE_/i.test(key)));
}

export async function rcloneOperation(options, args, expected, spawnProcess=spawn) {
  const result=await new Promise((accept,reject)=>{
    const child=spawnProcess(options.rclone??'rclone',[
      '--config',resolve(options.config),'--log-level','ERROR','--stats','0',
      '--retries','1','--low-level-retries','2','--contimeout','10s','--timeout','30s',
      ...args,
    ],{stdio:['ignore','pipe','pipe'],shell:false,windowsHide:true,env:processEnvironment()});
    let bytes=0,finished=false;
    const statChunks=[];
    const hash=createHash('sha256');
    const finish=(error,result)=>{
      if(finished) return;
      finished=true;clearTimeout(timer);
      if(error) {child.kill();reject(error);} else accept(result);
    };
    const timer=setTimeout(()=>finish(Error('Encrypted replication operation exceeded its deadline.')),60_000);
    child.on('error',()=>finish(Error('Encrypted replication executable could not start.')));
    child.stdout.on('error',()=>finish(Error('Encrypted replication readback failed.')));
    child.stderr.on('error',()=>finish(Error('Encrypted replication diagnostics failed.')));
    child.stderr.resume(); // Suppress credential-bearing backend diagnostics.
    child.stdout.on('data',chunk=>{
      bytes+=chunk.length;
      if(bytes>(expected?.statOutput?65536:(expected?.bytes??65536))) finish(Error('Encrypted replication readback exceeds its bound.'));
      else if(expected?.statOutput) statChunks.push(chunk);
      else hash.update(chunk);
    });
    child.on('close',(code,signal)=>{
      if(expected&&(code===3||code===4)&&bytes===0&&!signal) return finish(null,{missing:true});
      if(code!==0||signal) return finish(Error('Encrypted replication failed; retry after checking the protected configuration.'));
      if(expected?.statOutput) {
        try {
          const stat=JSON.parse(Buffer.concat(statChunks).toString('utf8'));
          if(stat===null) return finish(null,{missing:true});
          if(stat&&typeof stat==='object'&&!Array.isArray(stat)&&stat.IsDir===false&&Number.isSafeInteger(stat.Size)&&stat.Size>=0) return finish(null,{missing:false});
        } catch {}
        return finish(Error('Invalid remote encrypted object stat; no upload attempted.'));
      }
      if(expected&&bytes===0&&args[0]==='cat') return finish(null,{emptyReadback:true});
      if(expected&&(bytes!==expected.bytes||hash.digest('hex')!==expected.sha256)) return finish(Error('Remote encrypted backup checksum mismatch; no replacement attempted.'));
      finish(null,{missing:false});
    });
  });
  if(result.emptyReadback) {
    // Object-store cat can exit successfully with no matches. Confirm absence
    // independently: a real zero-byte object must remain a checksum failure.
    const stat=await rcloneOperation(options,['lsjson',args[1],'--stat','--files-only'],{statOutput:true},spawnProcess);
    if(stat.missing) return {missing:true};
    throw Error('Remote encrypted backup checksum mismatch; no replacement attempted.');
  }
  return result;
}

async function boundedJson(path) {
  const info=await lstat(path);
  if(!info.isFile()||info.isSymbolicLink()||info.size>65536) throw Error('Invalid replication metadata or receipt.');
  return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
}

export async function replicateEncryptedBackups(options, spawnProcess=spawn) {
  const root=resolve(options.root),receipts=resolve(options.receipts);
  const rootInfo=await lstat(root),configInfo=await lstat(options.config);
  if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink()||!configInfo.isFile()||configInfo.isSymbolicLink()||configInfo.size>65536) throw Error('Invalid backup root or protected rclone configuration.');
  if(process.platform!=='win32'&&(configInfo.mode&0o077)!==0) throw Error('Rclone configuration must not be accessible by group or others.');
  await mkdir(receipts,{recursive:true,mode:0o700});
  const receiptInfo=await lstat(receipts);
  if(!receiptInfo.isDirectory()||receiptInfo.isSymbolicLink()) throw Error('Invalid replication receipt directory.');
  // Exclusive lock deliberately survives process crashes. A human/maintainer must
  // check for a live owner before removing a stale lock; never compete with it.
  const lock=await open(join(receipts,'replication.lock'),'wx',0o600);
  let stage;
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
    const entries=(await readdir(root)).filter(name=>namePattern.test(name)).sort();
    if(entries.length>800) throw Error('Backup backlog exceeds the supported retention bound.');
    const destinationId=createHash('sha256').update(options.destination).digest('hex').slice(0,16);
    const jobs=[];
    for(const name of entries) {
      let raw;
      try {raw=await boundedJson(join(root,`${name}.json`));}
      catch(error) {if(error.code==='ENOENT') continue;throw error;}
      const metadata=validateMetadata(raw);
      if(raw.encryptedBackup!==join(root,name)||typeof raw.completedAt!=='string'||!Number.isFinite(Date.parse(raw.completedAt))) throw Error('Snapshot metadata does not match its contained ciphertext.');
      const receipt=join(receipts,`${name}.${metadata.encryptedSha256}.${destinationId}.json`);
      let prior;
      try {prior=await boundedJson(receipt);} catch(error) {if(error.code!=='ENOENT') throw error;}
      const object=`${options.destination}/${metadata.encryptedSha256}/${name}`;
      if(prior&&(prior.object!==object||prior.encryptedSha256!==metadata.encryptedSha256||prior.remoteReadbackVerified!==true)) throw Error('Existing replication receipt is inconsistent; original preserved.');
      jobs.push({name,metadata,completedAt:raw.completedAt,receipt,object,prior});
    }
    if(!jobs.length) throw Error('No immutable encrypted snapshot metadata found.');
    // Recheck the newest known snapshot every wakeup, then drain oldest unverified
    // backlog. Receipts for older snapshots are retained, never used as remote proofs.
    const latest=jobs.at(-1), selected=[latest,...jobs.filter(j=>j!==latest&&!j.prior)].slice(0,24);
    stage=await mkdtemp(join(receipts,'.replicate-'));
    const results=[];
    for(const job of selected) {
      const source=join(root,job.name),staged=join(stage,job.name);
      const info=await lstat(source);
      if(!info.isFile()||info.isSymbolicLink()||info.size!==job.metadata.encryptedBytes) throw Error('Invalid encrypted snapshot; source preserved.');
      const input=await open(source,'r'),output=await open(staged,'wx',0o600);
      try {
        const opened=await input.stat();
        if(opened.size!==info.size||opened.ino!==info.ino||opened.dev!==info.dev) throw Error('Encrypted snapshot changed while opening.');
        const header=Buffer.alloc(22);await input.read(header,0,header.length,0);
        if(header.toString()!=='age-encryption.org/v1\n') throw Error('Snapshot is not a binary age encrypted file.');
        const hash=createHash('sha256');let bytes=0;
        for await(const chunk of input.createReadStream({autoClose:false,start:0})) {
          bytes+=chunk.length;
          if(bytes>job.metadata.encryptedBytes) throw Error('Encrypted snapshot exceeds declared size.');
          hash.update(chunk);
          let offset=0;
          while(offset<chunk.length) {
            const written=await output.write(chunk,offset,chunk.length-offset);
            if(written.bytesWritten<=0) throw Error('Encrypted staging write failed.');
            offset+=written.bytesWritten;
          }
        }
        if(bytes!==job.metadata.encryptedBytes||hash.digest('hex')!==job.metadata.encryptedSha256) throw Error('Local encrypted snapshot checksum mismatch; nothing uploaded.');
        await output.sync();
      } finally {await input.close();await output.close();}
      const expected={bytes:job.metadata.encryptedBytes,sha256:job.metadata.encryptedSha256};
      const remote=await rcloneOperation(options,['cat',job.object],expected,spawnProcess);
      if(remote.missing) {
        await rcloneOperation(options,['copyto',staged,job.object,'--immutable','--checksum'],null,spawnProcess);
        const readback=await rcloneOperation(options,['cat',job.object],expected,spawnProcess);
        if(readback.missing) throw Error('Uploaded encrypted backup is unavailable on readback.');
      }
      // Upload only constructed recovery metadata, never arbitrary sidecar fields.
      const sidecar=Buffer.from(JSON.stringify({format:'zoko-encrypted-snapshot/1',completedAt:job.completedAt,...job.metadata})+'\n');
      const sidePath=`${staged}.json`;await writeFile(sidePath,sidecar,{flag:'wx',mode:0o600});
      const metaExpected={bytes:sidecar.length,sha256:createHash('sha256').update(sidecar).digest('hex')};
      const metaRemote=await rcloneOperation(options,['cat',`${job.object}.json`],metaExpected,spawnProcess);
      if(metaRemote.missing) {
        await rcloneOperation(options,['copyto',sidePath,`${job.object}.json`,'--immutable','--checksum'],null,spawnProcess);
        if((await rcloneOperation(options,['cat',`${job.object}.json`],metaExpected,spawnProcess)).missing) throw Error('Uploaded recovery metadata is unavailable on readback.');
      }
      const result={format:'zoko-offsite-replication/1',verifiedAt:new Date().toISOString(),object:job.object,...job.metadata,remoteReadbackVerified:true,privateIdentityUsed:false,plaintextUploaded:false};
      if(!job.prior) await writeFile(job.receipt,JSON.stringify(result)+'\n',{flag:'wx',mode:0o600});
      results.push(result);
      await rm(staged);await rm(sidePath);
    }
    return {verified:results.length,pending:jobs.filter(j=>!j.prior&&!selected.includes(j)).length,latest:results[0],independentStorageAttested:false};
  } finally {
    if(stage) await rm(stage,{recursive:true,force:true});
    await lock.close();await rm(join(receipts,'replication.lock'));
  }
}

if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  try {
    const options=parseReplicationArguments(process.argv.slice(2));
    process.stdout.write(options.help?help:JSON.stringify(await replicateEncryptedBackups(options))+'\n');
  } catch {
    // Never echo configuration contents, backend diagnostics, paths or payloads.
    process.stderr.write('Encrypted replication failed. Check snapshot metadata, destination access, receipt lock and trusted executable; originals are preserved.\n');process.exitCode=1;
  }
}
