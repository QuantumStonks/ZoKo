import { readConfig } from './config.js';
import { createDb } from './db.js';
import { migrate } from './migration.js';
import { Market } from './market.js';
import { Payments } from './payments/index.js';
import { buildServer } from './server.js';
import { closeProviderConnections } from './provider-network.js';

const config=readConfig(),db=createDb(config.databaseUrl);
let stopping=false,working=false;
try {
  await migrate(db);
  const market=new Market(db,config),payments=new Payments(db,config.payments);
  await market.seed();
  const app=await buildServer(config,db,payments);
  // A node outage keeps readiness false; the control plane remains available for diagnosis.
  try { await payments.preflight(); } catch { app.log.error('eCash preflight failed; paid operations remain unavailable'); }
  await market.recoverStale();
  const tick=async()=>{
    if(working||stopping)return;working=true;
    try{await market.recoverStale();await payments.sync();}
    catch{app.log.error('Background reconciliation failed; will retry without replacing pending payouts');}
    finally{working=false;}
  };
  const timer=setInterval(()=>void tick(),5000);timer.unref();
  const shutdown=async()=>{
    if(stopping)return;stopping=true;clearInterval(timer);
    app.log.info('Draining requests before shutdown');
    await app.close();
    const until=Date.now()+65000;
    while(working&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));
    await closeProviderConnections();
    await db.end();
  };
  process.once('SIGTERM',()=>void shutdown());process.once('SIGINT',()=>void shutdown());
  await app.listen({host:config.host,port:config.port});
  void tick();
} catch(error) {
  // Avoid printing connection URLs or config values in startup failures.
  console.error(`Zoko startup failed (${error instanceof Error?error.name:'unknown'}). Run npm run doctor to check configuration and dependencies.`);
  await db.end();process.exitCode=1;
}
