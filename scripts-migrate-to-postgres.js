require('dotenv').config();
const fs = require('fs'); const path = require('path'); const { Client } = require('pg');
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required.'); process.exit(1); }
const file = path.join(__dirname, 'data-db.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
(async()=>{ const client=new Client({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='true'?{rejectUnauthorized:false}:undefined}); await client.connect(); await client.query('CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY CHECK(id=1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())'); await client.query('INSERT INTO app_state(id,data) VALUES(1,$1::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,updated_at=now()',[JSON.stringify(data)]); await client.end(); console.log('Database migrated to PostgreSQL successfully.'); })().catch(e=>{console.error(e);process.exit(1)});
