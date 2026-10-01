import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { ZokoClient } from './client.js';
const MoneySchema=z.string().regex(/^(0|[1-9][0-9]{0,29})$/);

const CredentialSchema=z.object({format:z.literal('zoko-agent-credentials/1'),baseUrl:z.string(),apiKey:z.string().regex(/^zoko_[A-Za-z0-9_-]{43}$/),enrollment:z.object({name:z.string().trim().min(1).max(120),dailyLimitNanos:MoneySchema,maxPriceNanos:MoneySchema}).strict()}).strict();
export type AgentCredentials=z.infer<typeof CredentialSchema>;

function windowsSecurity(path:string, protect:boolean):void {
  const prefix=`$ErrorActionPreference='Stop'; $p='${path.replaceAll("'","''")}'; $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');`;
  const action=protect?`$a=New-Object System.Security.AccessControl.FileSecurity; $a.SetAccessRuleProtection($true,$false); foreach($sid in @($u,$system)){$a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))}; [System.IO.File]::SetAccessControl($p,$a);`:'';
  const verify=`$a=[System.IO.File]::GetAccessControl($p); if(!$a.AreAccessRulesProtected){throw 'Inherited permissions'}; foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($u.Value,$system.Value)){throw 'Unexpected reader'}}`;
  try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(prefix+action+verify,'utf16le').toString('base64')],{stdio:'pipe',windowsHide:true,timeout:10000});}
  catch{throw Error('Credentials require verified owner-only Windows ACLs; no authenticated request was dispatched');}
}

export async function readAgentCredentials(path:string):Promise<AgentCredentials> {
  const info=await lstat(path);
  if(!info.isFile() || info.isSymbolicLink() || info.size>4096 || (process.platform!=='win32'&&(info.mode&0o077)!==0)) throw Error('Credentials must be a protected bounded regular file');
  if(process.platform==='win32')windowsSecurity(resolve(path),false);
  let value:AgentCredentials;
  const file=await open(path,'r');
  try{const opened=await file.stat();if(opened.dev!==info.dev||opened.ino!==info.ino||opened.size>4096)throw Error('Credentials file changed');value=CredentialSchema.parse(JSON.parse(await file.readFile('utf8')));}catch{throw Error('Invalid protected credentials file; preserve the original without displaying its contents');}finally{await file.close();}
  new ZokoClient({baseUrl:value.baseUrl,apiKey:value.apiKey});
  return value;
}
export async function prepareEnrollment(path:string,baseUrl:string,input:AgentCredentials['enrollment']):Promise<AgentCredentials> {
  const normalized=new ZokoClient({baseUrl}).baseUrl;
  input=CredentialSchema.shape.enrollment.parse(input);
  const target=resolve(path);
  try {
    const saved=await readAgentCredentials(target);
    if(saved.baseUrl!==normalized || JSON.stringify(saved.enrollment)!==JSON.stringify(input)) throw Error('Enrollment differs from the original protected file; preserve its key and input');
    return saved;
  } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const saved=CredentialSchema.parse({format:'zoko-agent-credentials/1',baseUrl:normalized,apiKey:`zoko_${randomBytes(32).toString('base64url')}`,enrollment:input});
  const file=await open(target,'wx',0o600);
  try {
   if(process.platform==='win32')windowsSecurity(target,true);
   await file.writeFile(JSON.stringify(saved,null,2)+'\n');await file.sync();
  } catch(error){await file.close();await unlink(target);throw error;}
  finally {await file.close();}
  return saved;
}
