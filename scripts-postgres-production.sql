-- Final No.8 production PostgreSQL schema.
-- app_state is the canonical application snapshot. Normalized tables are a
-- transactional projection with database constraints/indexes.
CREATE TABLE IF NOT EXISTS app_state (id integer PRIMARY KEY CHECK (id=1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (id text PRIMARY KEY,name text NOT NULL,user_code text NOT NULL,password_hash text NOT NULL,active boolean NOT NULL DEFAULT true,session_version integer NOT NULL DEFAULT 0,recovery_code_hash text,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_code_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS users_user_code_lower_idx ON users (lower(user_code));
CREATE TABLE IF NOT EXISTS lotteries (id text PRIMARY KEY,name text NOT NULL,slug text NOT NULL UNIQUE,draw_time text,is_main boolean NOT NULL DEFAULT false,starred boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE lotteries ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS purchases (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE SET NULL,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,number text NOT NULL CHECK(number ~ '^[0-9]{2}$'),buyer_name text NOT NULL,tickets integer NOT NULL CHECK(tickets>0 AND tickets<=100000),amount numeric NOT NULL DEFAULT 0 CHECK(amount>=0 AND amount<=10000000),request_id text,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS request_id text;
CREATE UNIQUE INDEX IF NOT EXISTS purchases_user_request_idx ON purchases(user_id,request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchases_user_lottery_idx ON purchases(user_id,lottery_id);
CREATE INDEX IF NOT EXISTS purchases_lottery_number_idx ON purchases(lottery_id,number);
CREATE TABLE IF NOT EXISTS results (id text PRIMARY KEY,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,date date NOT NULL,result_text text NOT NULL,updated_at timestamptz,deleted_at timestamptz);
CREATE UNIQUE INDEX IF NOT EXISTS results_lottery_date_active_idx ON results(lottery_id,date) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS watched_numbers (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE CASCADE,lottery_id text REFERENCES lotteries(id) ON DELETE CASCADE,number text NOT NULL CHECK(number ~ '^[0-9]{2}$'),created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX IF NOT EXISTS watched_unique_idx ON watched_numbers(user_id,lottery_id,number);
CREATE TABLE IF NOT EXISTS notifications (id text PRIMARY KEY,user_id text REFERENCES users(id) ON DELETE CASCADE,lottery_id text,result_date date,number text,title text,message text,created_at timestamptz NOT NULL DEFAULT now(),read_at timestamptz,type text);
CREATE TABLE IF NOT EXISTS audit_log (id text PRIMARY KEY,action text,detail text,ip text,timestamp timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS daily_visits (visit_date date PRIMARY KEY,visits integer NOT NULL DEFAULT 0,unique_sessions integer NOT NULL DEFAULT 0,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS visitor_daily (visit_date date NOT NULL,visitor_id text NOT NULL,PRIMARY KEY(visit_date,visitor_id));
