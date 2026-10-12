import {DatabaseSync} from 'node:sqlite';
export function database(filename=':memory:'){
 const sql=new DatabaseSync(filename);sql.exec('PRAGMA foreign_keys=ON');
 const wrap=(text,params=[])=>({bind(...values){return wrap(text,values)},async first(){return sql.prepare(text).get(...params)||null},async all(){return {results:sql.prepare(text).all(...params)}},async run(){const r=sql.prepare(text).run(...params);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}});
 return {exec:async text=>sql.exec(text),prepare:text=>wrap(text),async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}},sql};
}
