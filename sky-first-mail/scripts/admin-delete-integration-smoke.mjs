import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import assert from 'node:assert/strict';
class D1Statement {
 constructor(db,sql,args=[]){this.db=db;this.sql=sql;this.args=args}
 bind(...args){return new D1Statement(this.db,this.sql,args)}
 all(){const stmt=this.db.prepare(this.sql);const results=stmt.all(...this.args).map(r=>({...r}));return {success:true,results,meta:{changes:this.db.prepare('select changes() as n').get().n||0}}}
 first(){const stmt=this.db.prepare(this.sql);const r=stmt.get(...this.args);return r?{...r}:null}
 run(){const stmt=this.db.prepare(this.sql);const info=stmt.run(...this.args);return {success:true,meta:{changes:Number(info.changes),last_row_id:Number(info.lastInsertRowid||0)}}}
}
class D1 {
 constructor(){this.db=new DatabaseSync(':memory:');this.db.exec('PRAGMA foreign_keys=ON')}
 prepare(sql){return new D1Statement(this.db,sql)}
 exec(sql){this.db.exec(sql);return {success:true}}
 async batch(stmts){this.db.exec('BEGIN');const out=[];try{for(const x of stmts)out.push(x.run());this.db.exec('COMMIT');return out}catch(e){this.db.exec('ROLLBACK');throw e}}
}
const DB=new D1();
const env={DB,SETUP_SECRET:'this-is-a-very-long-secret-for-integration-testing',MAIL_STORAGE:{delete:async()=>{}},ASSETS:{fetch:async()=>new Response('no asset',{status:404})}};
async function req(path,method='GET',body=null,headers={}){
 const h={...headers};if(body!==null)h['content-type']='application/json';
 const r=await worker.fetch(new Request('https://local.test'+path,{method,headers:h,body:body===null?undefined:JSON.stringify(body)}),env,{});
 let d={};try{d=await r.json()}catch{}
 return {status:r.status,headers:r.headers,data:d};
}
let r=await req('/api/bootstrap/status');assert.equal(r.data.setupCompleted,false);
r=await req('/api/bootstrap','POST',{displayName:'Root User',email:'root@skyfirst.io.vn',password:'Password123!abc'},{'x-setup-secret':env.SETUP_SECRET});
assert.equal(r.status,200,JSON.stringify(r.data));
const cookie=r.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie,'session cookie missing');
r=await req('/api/admin/users','POST',{displayName:'Target User',email:'target@skyfirst.io.vn',password:'Password123!abc',role:'user'},{cookie});
assert.equal(r.status,200,JSON.stringify(r.data));const targetId=r.data.id;assert.ok(targetId);
const mb=DB.prepare('SELECT id FROM mailboxes WHERE user_id=?').bind(targetId).first();assert.ok(mb);
// Populate every dependent table including the legacy NO ACTION FK that is suspected of blocking DELETE.
DB.prepare("INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)").bind(targetId,'target-token','2099-01-01').run();
DB.prepare("INSERT INTO login_history(user_id) VALUES(?)").bind(targetId).run();
DB.prepare("INSERT INTO aliases(mailbox_id,address) VALUES(?,?)").bind(mb.id,'alias.target@skyfirst.io.vn').run();
DB.prepare("INSERT INTO contacts(owner_user_id,email) VALUES(?,?)").bind(targetId,'person@example.com').run();
DB.prepare("INSERT INTO signatures(user_id,mailbox_id,name) VALUES(?,?,?)").bind(targetId,mb.id,'signature').run();
DB.prepare("INSERT INTO labels(user_id,name) VALUES(?,?)").bind(targetId,'label').run();
DB.prepare("INSERT INTO mail_rules(user_id,mailbox_id,name) VALUES(?,?,?)").bind(targetId,mb.id,'rule').run();
DB.prepare("INSERT INTO notifications(user_id,title) VALUES(?,?)").bind(targetId,'notice').run();
DB.prepare("INSERT INTO compose_drafts(user_id,mailbox_id,to_json,cc_json,storage_key) VALUES(?,?, '[]','[]','draft-key')").bind(targetId,mb.id).run();
DB.prepare("INSERT INTO mail_templates(user_id,name) VALUES(?,?)").bind(targetId,'template').run();
DB.prepare("INSERT INTO send_operations(id,user_id,request_hash,storage_key) VALUES(?,?,?,?)").bind('send-target',targetId,'hash','send-key').run();
DB.prepare("INSERT INTO inbound_receipts(mailbox_id,digest) VALUES(?,?)").bind(mb.id,'digest').run();
DB.prepare("INSERT INTO messages(mailbox_id,direction,sender,recipients_json,storage_key) VALUES(?,'inbound','someone@example.com','[]','msg-key')").bind(mb.id).run();
const msgId=DB.prepare('SELECT id FROM messages WHERE mailbox_id=?').bind(mb.id).first().id;
DB.prepare("INSERT INTO attachments(message_id,filename,storage_key) VALUES(?,?,?)").bind(msgId,'attachment.txt','att-key').run();
DB.prepare("INSERT INTO delivery_events(message_id,provider,event_type) VALUES(?,?,?)").bind(msgId,'resend','accepted').run();
DB.prepare("INSERT INTO audit_logs(user_id,action) VALUES(?,?)").bind(targetId,'test-row').run();
// Simulate production-only schema FKs (not present in shipped migrations) that do not cascade.
DB.exec('CREATE TABLE IF NOT EXISTS production_extension (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), note TEXT)');
DB.prepare('INSERT INTO production_extension(user_id,note) VALUES(?,?)').bind(targetId,'blocks old user delete').run();
DB.exec('CREATE TABLE IF NOT EXISTS production_mailbox_extension (id INTEGER PRIMARY KEY, mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id), note TEXT)');
DB.prepare('INSERT INTO production_mailbox_extension(mailbox_id,note) VALUES(?,?)').bind(mb.id,'blocks mailbox delete').run();
DB.exec('CREATE TABLE IF NOT EXISTS production_message_extension (id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES messages(id), note TEXT)');
DB.prepare('INSERT INTO production_message_extension(message_id,note) VALUES(?,?)').bind(msgId,'blocks message delete').run();
r=await req(`/api/admin/users/${targetId}`,'DELETE',{confirm:true},{cookie});
console.log('delete response',r.status,r.data);
assert.equal(r.status,200,JSON.stringify(r.data));assert.equal(r.data.deleted,true);
assert.equal(DB.prepare('SELECT id FROM users WHERE id=?').bind(targetId).first(),null);
assert.equal(DB.prepare('SELECT id FROM production_extension WHERE user_id=?').bind(targetId).first(),null);
assert.equal(DB.prepare('SELECT id FROM production_mailbox_extension WHERE mailbox_id=?').bind(mb.id).first(),null);
assert.equal(DB.prepare('SELECT id FROM production_message_extension WHERE message_id=?').bind(msgId).first(),null);
assert.equal(DB.prepare('SELECT id,user_id FROM audit_logs WHERE action=?').bind('test-row').first()?.user_id,null,'audit should be preserved and detached');
assert.equal(DB.prepare('SELECT id FROM users WHERE role=?').bind('super_admin').first()?.id,1);
console.log('PASS integration: Worker API + SQLite; creates/deletes account with production-only NO ACTION FKs referencing users, mailboxes and messages; preserves/detaches audit rows and keeps Super Admin.');
