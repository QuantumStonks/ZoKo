import {createHash} from 'node:crypto';
import {open, readFile, stat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const MAX_BYTES = 50_000_000;
const TIMEOUT_MS = 60_000;
const help = `Verify an existing off-host age-encrypted backup without writing plaintext.
Usage: node scripts/verify-encrypted-backup.mjs --receipt FILE --file FILE --identity FILE [--age EXECUTABLE] [--out NEW_FILE]
The receipt must contain encrypted/plaintext SHA256 hashes and byte counts.
Verification is repeatable and read-only. --out creates an exclusive new receipt.
No identity contents, database bytes or decryptor diagnostics are printed.
`;

export function parseArguments(args) {
  const options = {age: 'age'};
  const seen = new Set();
  for (let i=0;i<args.length;i++) {
    const arg=args[i];
    if (arg==='--help') return {help:true};
    if (!['--receipt','--file','--identity','--age','--out'].includes(arg)||seen.has(arg)) throw Error('Invalid verification arguments. Use --help.');
    const value=args[++i];
    if (!value||value.startsWith('--')||value.includes('\0')) throw Error('Missing verification argument. Use --help.');
    seen.add(arg); options[arg.slice(2)]=value;
  }
  if (!options.receipt||!options.file||!options.identity) throw Error('Receipt, ciphertext and identity paths are required.');
  return options;
}

export function validateMetadata(value) {
  if (!value||typeof value!=='object'||Array.isArray(value)) throw Error('Invalid backup metadata.');
  const result={};
  for (const key of ['encryptedSha256','plaintextSha256']) {
    if (typeof value[key]!=='string'||!/^[a-f0-9]{64}$/.test(value[key])) throw Error('Invalid backup hash metadata.');
    result[key]=value[key];
  }
  for (const key of ['encryptedBytes','plaintextBytes']) {
    if (!Number.isSafeInteger(value[key])||value[key]<=0||value[key]>MAX_BYTES) throw Error('Backup size exceeds the supported verification bounds.');
    result[key]=value[key];
  }
  return result;
}

export async function verifyEncryptedBackup(options, spawnProcess=spawn) {
  const receiptInfo=await stat(options.receipt);
  if (!receiptInfo.isFile()||receiptInfo.size>65536) throw Error('Invalid or oversized metadata receipt.');
  const metadata=validateMetadata(JSON.parse((await readFile(options.receipt,'utf8')).replace(/^\uFEFF/,'')));
  const file=resolve(options.file), identity=resolve(options.identity);
  const identityInfo=await stat(identity);
  if (!identityInfo.isFile()||identityInfo.size<=0||identityInfo.size>65536) throw Error('Invalid recovery identity file.');
  // Keep one descriptor open for hashing and decryption, including on repeat checks.
  // The decryptor receives this stream on stdin, avoiding a path replacement race.
  const ciphertext=await open(file,'r');
  try {
    const info=await ciphertext.stat();
    if (!info.isFile()||info.size!==metadata.encryptedBytes) throw Error('Ciphertext size does not match its receipt.');
    const hash=createHash('sha256');
    let encryptedBytes=0;
    for await (const chunk of ciphertext.createReadStream({autoClose:false,start:0})) {
      encryptedBytes+=chunk.length;
      if (encryptedBytes>metadata.encryptedBytes) throw Error('Ciphertext exceeds the declared size.');
      hash.update(chunk);
    }
    if (encryptedBytes!==metadata.encryptedBytes||hash.digest('hex')!==metadata.encryptedSha256) throw Error('Ciphertext checksum mismatch; original file preserved.');
    const plaintextHash=createHash('sha256');
    let bytes=0;
    await new Promise((accept,reject)=>{
      let finished=false;
      const input=ciphertext.createReadStream({autoClose:false,start:0});
      const child=spawnProcess(options.age??'age',['--decrypt','--identity',identity],{stdio:['pipe','pipe','pipe'],shell:false,windowsHide:true});
      const finish=(error)=>{
        if (finished) return;
        finished=true; clearTimeout(timer); input.unpipe(child.stdin); input.destroy();
        if (error) {child.stdin.destroy(); child.kill(); reject(error);} else accept();
      };
      const timer=setTimeout(()=>finish(Error('Backup decryption exceeded its time limit.')),TIMEOUT_MS);
      input.on('error',()=>finish(Error('Ciphertext read failed.')));
      child.on('error',()=>finish(Error('Backup decryptor could not start.')));
      child.stdin.on('error',()=>finish(Error('Backup decryptor input failed.')));
      child.stdout.on('error',()=>finish(Error('Backup decryptor output failed.')));
      child.stderr.on('error',()=>finish(Error('Backup decryptor diagnostics stream failed.')));
      // Drain diagnostics without retaining or exposing potentially sensitive text.
      child.stderr.resume();
      child.stdout.on('data',chunk=>{
        bytes+=chunk.length;
        if (bytes>metadata.plaintextBytes) finish(Error('Decrypted backup exceeds the declared size.'));
        else plaintextHash.update(chunk);
      });
      child.on('close',(code,signal)=>{
        if (code!==0||signal) finish(Error('Backup decryption failed; identity and diagnostics withheld.'));
        else finish();
      });
      input.pipe(child.stdin);
    });
    if (bytes!==metadata.plaintextBytes||plaintextHash.digest('hex')!==metadata.plaintextSha256) throw Error('Decrypted backup checksum or size mismatch.');
    return {checkedAt:new Date().toISOString(),...metadata,ciphertextVerified:true,decryptionVerified:true,plaintextWrittenToDisk:false,identityExported:false};
  } finally {await ciphertext.close();}
}

export async function main(args) {
  let options;
  try {options=parseArguments(args);} catch(error) {process.stderr.write(error.message+'\n'); return 2;}
  if (options.help) {process.stdout.write(help); return 0;}
  try {
    const result=await verifyEncryptedBackup(options);
    if (options.out) {
      let output;
      try {output=await open(options.out,'wx',0o600);} catch(error) {
        if (error.code==='EEXIST') throw Error('Backup verification receipt already exists; original preserved.');
        throw error;
      }
      try {await output.writeFile(JSON.stringify(result,null,2)+'\n');} finally {await output.close();}
    }
    process.stdout.write(JSON.stringify(result)+'\n'); return 0;
  } catch(error) {
    // Do not expose raw filesystem, spawn, JSON or decryptor errors to stdout.
    const safe=/^(Invalid|Backup|Ciphertext|Decrypted|Receipt|Missing)/.test(error.message) ? error.message : 'Encrypted backup verification failed; no plaintext or identity was exported.';
    process.stderr.write(safe+'\n'); return 1;
  }
}

if (process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) process.exitCode=await main(process.argv.slice(2));
